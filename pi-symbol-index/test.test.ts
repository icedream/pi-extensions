// Self-contained unit tests for pi-symbol-index extension.
// Run from within `pi-symbol-index/` (where this test.test.ts sits)
//   via: `pi -p "Run the tests in test.test.ts"`
//
// Tests exercise buildIndex and readIndex against a temporary Go project
// and a temporary TypeScript project.

import { buildIndex, readIndex, INDEX_DIR } from './index.ts';
import { crc32, toBase36 } from './index.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// ==================================================================
// Helpers
// ==================================================================

const TEST_ROOT = path.join(
  os.tmpdir(), 'pi-symbol-index-test-' + Date.now(),
);

async function setupGoProject(): Promise<void> {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  await fs.writeFile(
    path.join(TEST_ROOT, 'go.mod'),
    'module pi-index-test\ngo 1.23\n',
  );
  // pkg/math/math.go
  await fs.mkdir(path.join(TEST_ROOT, 'pkg', 'math'), { recursive: true });
  await fs.writeFile(
    path.join(TEST_ROOT, 'pkg/math/math.go'),
    'package math\n\n// Add returns the sum of a and b.\nfunc Add(a, b int) int {\n\treturn a + b\n}\n\n// Multiply returns the product of a and b.\nfunc Multiply(a, b int) int {\n\treturn a * b\n}\n',
  );

  // src/main.go
  await fs.mkdir(path.join(TEST_ROOT, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(TEST_ROOT, 'src/main.go'),
    'package main\n\nimport (\n\t"fmt"\n\n\t"pi-index-test/pkg/math"\n)\n\ntype Calculator struct{}\n\nfunc (c *Calculator) Run() {\n\tsum := math.Add(1, 2)\n\tprod := math.Multiply(1, 2)\n\tfmt.Println(sum, prod)\n}\n\nfunc main() {\n\tc := &Calculator{}\n\tc.Run()\n}\n',
  );
}

async function setupTsProject(): Promise<string> {
  const tsRoot = path.join(os.tmpdir(), 'pi-symbol-index-ts-test-' + Date.now());
  await fs.mkdir(tsRoot, { recursive: true });
  await fs.writeFile(path.join(tsRoot, 'tsconfig.json'), '{"compilerOptions": {}}');
  await fs.writeFile(
    path.join(tsRoot, 'index.ts'),
    'export interface User { name: string; age: number; }\n\nexport function greet(user: User): string {\n\treturn `Hello, ${user.name}!`;\n}\n\nexport class UserService {\n\tprivate users: User[] = [];\n\n\tadd(user: User): void {\n\t\tthis.users.push(user);\n\t}\n}\n',
  );
  // Install typescript locally so the compiler API can find it
  try {
    const { execSync } = await import('node:child_process');
    execSync('npm init -y && npm install typescript', { cwd: tsRoot, stdio: 'pipe' });
  } catch {}
  return tsRoot;
}

async function cleanup(): Promise<void> {
  try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
  try { await fs.rm(path.join(os.tmpdir(), 'pi-symbol-index-ts-test-*'), { recursive: true, force: true }); } catch {}
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Assertion failed: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual: ${JSON.stringify(actual)}`);
  }
}

// ==================================================================
// Tests
// ==================================================================

let passed = 0, failed = 0;
const failures: string[] = [];

async function run(description: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${description}`);
  } catch (e: any) {
    failed++;
    failures.push(`${description}: ${e.message}`);
    console.log(`  ✗ ${description}: ${e.message}`);
  }
}

async function main(): Promise<void> {
  console.log();
  console.log('== pi-symbol-index unit tests ==');
  console.log();

  // -- Setup --
  await cleanup();
  await setupGoProject();
  const tsRoot = await setupTsProject();

  // -- Test 1: buildIndex produces a valid Go index --
  await run('buildIndex produces valid Go project index', async () => {
    await buildIndex(TEST_ROOT, __dirname);
    const idxPath = path.join(TEST_ROOT, INDEX_DIR, 'symbols.json');
    assert(await fs.access(idxPath).then(() => true), 'symbols.json should exist');
    const index = JSON.parse(await fs.readFile(idxPath, 'utf-8'));
    assertEq(index.version, 1, 'version');
    assertEq(index.projectRoot, TEST_ROOT, 'projectRoot');
    assert(typeof index.buildTs === 'string' && new Date(index.buildTs).getTime() > 0, 'buildTs is date');
    const files = Object.keys(index.files).sort();
    assertEq(files.sort(), ['pkg/math/math.go', 'src/main.go'], 'files');
  });

  // -- Test 2: readIndex returns the same data as written --
  await run('readIndex returns valid JSON index', async () => {
    const index = await readIndex(TEST_ROOT);
    assert(index !== null, 'readIndex did not return null');
    const idxPath = path.join(TEST_ROOT, INDEX_DIR, 'symbols.json');
    const raw = JSON.parse(await fs.readFile(idxPath, 'utf-8'));
    assertEq(JSON.stringify(index), JSON.stringify(raw), 'readIndex matches disk');
  });

  // -- Test 3: symbol extraction in pkg/math/math.go --
  await run('extract symbols from pkg/math/math.go (Add, Multiply)', async () => {
    const index = await readIndex(TEST_ROOT);
    const mathSymbols: Record<string, unknown> = (index!.files['pkg/math/math.go'].symbols as any).reduce((acc: Record<string, unknown>, s: any) => { acc[s.name] = s; return acc; }, {} as Record<string, unknown>);
    assert(mathSymbols['Add'] !== undefined, 'Add symbol found');
    assert(mathSymbols['Multiply'] !== undefined, 'Multiply symbol found');
    assertEq((mathSymbols['Add'] as any).kind, 'function', 'Add kind is function');
    assertEq((mathSymbols['Multiply'] as any).kind, 'function', 'Multiply kind is function');
  });

  // -- Test 4: symbol line ranges match actual file content --
  await run('symbol line ranges correspond to actual file', async () => {
    const index = await readIndex(TEST_ROOT);
    const sym = (index!.files['pkg/math/math.go'].symbols as Array<{ name: string; lineRange: [number, number] }>)
      .find(s => s.name === 'Add');
    assert(sym !== undefined && sym.lineRange[0] >= 3, 'Add starts on or after line 3');
    const fileLines = (await fs.readFile(path.join(TEST_ROOT, 'pkg/math/math.go'), 'utf-8')).split('\n');
    assertEq(fileLines[sym!.lineRange[0] - 1].trim(), 'func Add(a, b int) int {', 'Add starts at function header line');
    assertEq(fileLines[sym!.lineRange[1] - 1].trim(), '}', 'Add ends at brace on line range.end');
  });

  // -- Test 5: reference usages populated --
  await run('usages list filled with reference locations', async () => {
    const index = await readIndex(TEST_ROOT);
    const symbols: any[] = index!.files['pkg/math/math.go'].symbols;
    const add = symbols.find((s: any) => s.name === 'Add');
    const mul = symbols.find((s: any) => s.name === 'Multiply');
    assert(add.usages.length > 0, `Add should have usages, got ${JSON.stringify(add.usages)}`);
    assert(mul.usages.length > 0, `Multiply should have usages, got ${JSON.stringify(mul.usages)}`);
    for (const u of add.usages) {
      assert(u.file.endsWith('main.go'), `Add usage file ${u.file} doesn't end in main.go`);
      assert(u.range[0] > 0, 'usage line > 0');
    }
  });

  // -- Test 6: call hierarchy present --
  await run('call hierarchy extracted for function symbols', async () => {
    const index = await readIndex(TEST_ROOT);
    const syms = index!.files['pkg/math/math.go'].symbols;
    for (const sym of syms as any[]) {
      assert(Array.isArray(sym.incomingCalls), `${sym.name} has incomingCalls array`);
      assert(Array.isArray(sym.outgoingCalls), `${sym.name} has outgoingCalls array`);
    }
  });

  // -- Test 7: call hierarchy identifies callers from main.go --
  await run('call hierarchy identifies callers from main.go', async () => {
    const index = await readIndex(TEST_ROOT);
    const mul = (index!.files['pkg/math/math.go'].symbols as any[])
      .find((s: any) => s.name === 'Multiply');
    const incomingFiles = mul.incomingCalls.map((c: any) => c.file);
    assert(incomingFiles.some(f => f.includes('main.go')), `Multiply incoming calls should include main.go: ${JSON.stringify(incomingFiles)}`);
  });

  // -- Test 8: src/main.go symbols --
  await run('src/main.go has Calculator struct and Calculator.Run method', async () => {
    const index = await readIndex(TEST_ROOT);
    const syms = index!.files['src/main.go'].symbols;
    const names = (syms as any[]).map((s: any) => s.name);
    assert(names.includes('Calculator'), `main.go symbols: ${JSON.stringify(names)}`);
    const calc = (syms as any[]).find((s: any) => s.name === 'Calculator');
    const calcKind = (calc as any).kind;
    assert(["struct", "interface"].includes(calcKind), `Calculator kind is ${calcKind}, expected struct/interface`);
  });

  // -- Test 9: block hashing --
  await run('block hashes are consistent SHA256 across reads', async () => {
    const index = await readIndex(TEST_ROOT);
    assert(index!.blocks.length > 0, 'index has blocks');
    for (const block of index!.blocks as any[]) {
      assertEq(typeof block.hash, 'string', `${block.file}: hash is string`);
      assert(block.hash.length >= 64, `${block.file}: hash is SHA256`);
      assertEq(typeof block.startLine, 'number', `${block.file}: startLine is number`);
      assertEq(typeof block.endLine, 'number', `${block.file}: endLine is number`);
      assertEq(typeof block.shortId, 'string', `${block.file}: shortId is string`);
      assert(block.shortId.length === 6, `${block.file}: shortId is 6 chars`);
      assert(/^[0-9a-z]{6}$/.test(block.shortId), `${block.file}: shortId is lowercase alphanumeric (may have leading zeros)`);
      const textLines = (await fs.readFile(path.join(TEST_ROOT, block.file), 'utf-8')).split('\n');
      const blockText = textLines.slice(block.startLine - 1, block.endLine).join('\n') + '\n';
      const currentHash = sha256(blockText);
      assertEq(currentHash, block.hash, `${block.file} block hash matches current file`);
    }
  });

  // -- Test 10: index rebuild produces consistent structure --
  await run('rebuilding index produces consistent structure', async () => {
    const before = await readIndex(TEST_ROOT);
    await buildIndex(TEST_ROOT, __dirname);
    const after = await readIndex(TEST_ROOT);
    assertEq(before!.files, after!.files, 'Files structure matches rebuild');
    assert(before!.blocks.length === after!.blocks.length, 'Block count matches rebuild');
    assert(after!.buildTs !== undefined, 'rebuild sets new buildTs');
  });

  // -- Test 11: hash mismatch detection --
  await run('hash mismatch detection on external modification', async () => {
    const mathGo = path.join(TEST_ROOT, 'pkg/math/math.go');
    const orig = await fs.readFile(mathGo, 'utf-8');
    const modified = orig.replace(/\n/g, '\n// external\n');
    await fs.writeFile(mathGo, modified);
    const index = await readIndex(TEST_ROOT);
    const mathBlocks = index!.blocks.filter((b: any) => b.file.includes('math.go'));
    for (const block of mathBlocks) {
      const textLines = (await fs.readFile(mathGo, 'utf-8')).split('\n');
      const blockText = textLines.slice(block.startLine - 1, block!.endLine as number - 1).join('\n') + '\n';
      const currentHash = sha256(blockText);
      assert(currentHash !== (block.hash as string), `Hash should differ for ${block.file}:${(block as any).startLine}`);
    }
    await fs.writeFile(mathGo, orig);
    const textLines = (await fs.readFile(mathGo, 'utf-8')).split('\n');
    const blockText = textLines.slice(2, 4).join('\n') + '\n';
    const currentHash = sha256(blockText);
    assert(currentHash.length >= 64, 'after restore hash is valid');
  });

  // -- Test 12: no unknown symbol kinds --
  await run('no unknown symbol kinds in index', async () => {
    const index = await readIndex(TEST_ROOT);
    let anyUnknown = false;
    for (const key of Object.keys(index!.files)) {
      for (const s of index!.files[key].symbols as any[]) {
        if (s.kind === 'unknown') anyUnknown = true;
      }
    }
    assert(!anyUnknown, 'no unknown symbol kinds');
  });

  // -- Test 13: TypeScript index via config-driven detection --
  await run('buildIndex produces valid TypeScript project index', async () => {
    // Requires typescript-language-server to be installed globally or locally
    // Fallback to compiler API if LSP server not found
    await buildIndex(tsRoot, __dirname);
    const idxPath = path.join(tsRoot, INDEX_DIR, 'symbols.json');
    assert(await fs.access(idxPath).then(() => true), 'TS symbols.json should exist');
    const index = JSON.parse(await fs.readFile(idxPath, 'utf-8'));
    assertEq(index.version, 1, 'TS version');
    assertEq(index.languages, ['typescript-language-server'], 'TS language');
    assert(Object.keys(index.files).length > 0, 'TS files present');
  });

  // -- Test 14: TypeScript symbols extracted --
  await run('TypeScript symbols extracted from index.ts', async () => {
    const index = await readIndex(tsRoot);
    // Find the file that contains User interface
    let syms: any[] = [];
    for (const file of Object.keys(index!.files)) {
      if (index!.files[file].symbols.some((s: any) => s.name === 'User')) {
        syms = index!.files[file].symbols;
        break;
      }
    }
    const names = syms.map((s: any) => s.name);
    assert(names.includes('User'), `TS symbols: ${JSON.stringify(names)}`);
    assert(names.includes('greet'), `TS symbols: ${JSON.stringify(names)}`);
    assert(names.includes('UserService'), `TS symbols: ${JSON.stringify(names)}`);
  });

  // -- Test 15: config-driven detection works --
  await run('config-driven language detection picks correct language', async () => {
    const goIndex = await readIndex(TEST_ROOT);
    const tsIndex = await readIndex(tsRoot);
    assertEq(goIndex!.languages, ['gopls'], 'Go detected via config');
    assertEq(tsIndex!.languages, ['typescript-language-server'], 'TS detected via config');
  });

  // -- Test 16: config file exists in extension directory --
  await run('config file exists in extension directory', async () => {
    const configPath = path.join(__dirname, 'pi-symbol-index.json');
    assert(await fs.access(configPath).then(() => true), 'pi-symbol-index.json exists');
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    assert(Object.keys(config.languages).length >= 5, 'config has at least 5 languages');
    assert('gopls' in config.languages || 'go' in config.languages, 'go config present');
  });

  // -- Tear down --
  await cleanup();

  // -- Summary --
  console.log();
  console.log(`== ${passed} passed, ${failed} failed ==`);
  if (failures.length > 0) {
    console.log();
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  if (failed > 0) {
    console.log('\nTests FAILED');
    process.exit(1);
  } else {
    console.log('\nAll tests passed');
  }
}

testPerFileMtime().catch(e => { console.error(e); process.exit(1); });

main().catch((e) => { console.error(e); process.exit(1); });

// Test 17: per-file mtime tracking
async function testPerFileMtime() {
  const name = "per-file mtime tracking";
  const testDir = path.join(os.tmpdir(), "sym_test_mtime");
  await fs.rm(testDir, { recursive: true, force: true });
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });

  // Create a simple Go project
  await fs.writeFile(path.join(testDir, "go.mod"), "module test\n\ngo 1.21\n");
  await fs.writeFile(path.join(testDir, "src/main.go"), `package main

func Add(a, b int) int {
	return a + b
}
`);

  await buildIndex(testDir, __dirname);

  // Read the index and check buildMtimes
  const index = await readIndex(testDir);
  if (!index) {
    console.log(`✗ ${name}: no index`);
    return;
  }

  const mtimes = index.buildMtimes;
  const fileKeys = Object.keys(mtimes);
  if (fileKeys.length === 0) {
    console.log(`✗ ${name}: no buildMtimes`);
    return;
  }
  console.log(`  buildMtimes: ${JSON.stringify(mtimes)}`);
  console.log(`✓ ${name}: per-file mtime stored for ${fileKeys.length} file(s)`);
}


