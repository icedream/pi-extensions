// Self-contained unit tests for pi-symbol-index extension.
// Run from within `pi-symbol-index/` (where this test.test.ts sits)
//   via: `pi -p "Run the tests in test.test.ts"`
//
// Tests exercise buildIndex and readIndex against a temporary Go project
// and a temporary TypeScript project.

import extensionDefault, { buildIndex, readIndex, INDEX_DIR } from './index.ts';
import { crc32, toBase36, symbolNameMatches, findIdentifierColumn, loadTypeScriptModule } from './index.ts';
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

// Registers the extension against a fake pi object: registerTool stores the tool
// definition by name, every other pi API call is a no-op.
function registerTools(): Record<string, any> {
  const tools: Record<string, any> = {};
  const noop = () => {};
  const pi = new Proxy({} as any, {
    get: (_target, prop) =>
      prop === 'registerTool' ? (def: any) => { tools[def.name] = def; } : noop,
  });
  extensionDefault(pi);
  return tools;
}

// Minimal ToolCallContext for the tools exercised here (only ui.setStatus/ui.notify are used).
const toolCtx = {
  hasUI: false,
  ui: { setStatus: () => {}, notify: () => {}, select: async () => undefined },
} as any;

// Calls a registered tool and reports whether it rejected, and with what.
async function callTool(name: string, params: unknown): Promise<{ error?: any; result?: any }> {
  const tools = registerTools();
  try {
    const result = await tools[name].execute('test-call', params, new AbortController().signal, async () => {}, toolCtx);
    return { result };
  } catch (error: any) {
    return { error }
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

  // -- Test 17: per-file mtime tracking --
  await run('per-file mtime tracking', testPerFileMtime);
  await run('symbol name lookup matches Go receiver names', testSymbolNameMatches);
  await run('identifier column skips longer words and receivers', testFindIdentifierColumn);
  await run('symbol_index_build rejects a directory with no language markers', testBuildRejectsNoLanguage);
  await run('stale index refresh rejects when language markers were removed', testRefreshRejectsWhenMarkersGone);
  await run('TypeScript compiler resolver prefers the indexed project copy', testTypeScriptResolver);

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

await main();

// Test 17: per-file mtime tracking
async function testPerFileMtime() {
  const testDir = path.join(os.tmpdir(), "sym_test_mtime");
  await fs.rm(testDir, { recursive: true, force: true });
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });

  await fs.writeFile(path.join(testDir, "go.mod"), "module test\n\ngo 1.21\n");
  await fs.writeFile(path.join(testDir, "src/main.go"), `package main

func Add(a, b int) int {
	return a + b
}
`);

  await buildIndex(testDir, __dirname);

  const index = await readIndex(testDir);
  assert(index, "index exists");
  assert(Object.keys(index.buildMtimes).length > 0, "buildMtimes populated");
}

// Test 18: Go methods are stored as "(*Recv).Name"; queries may use the bare name or "Recv.Name"
async function testSymbolNameMatches() {
  assert(symbolNameMatches('(*Calculator).Run', 'Run'), 'bare name matches method');
  assert(symbolNameMatches('(*Calculator).Run', 'Calculator.Run'), 'Recv.Name matches method');
  assert(symbolNameMatches('(*Calculator).Run', '(*Calculator).Run'), 'stored name matches itself');
  assert(symbolNameMatches('Run', 'Run'), 'plain function matches');
  assert(!symbolNameMatches('(*Calculator).Run', 'Calculator'), 'receiver alone does not match method');
  assert(!symbolNameMatches('(*Calculator).Run', 'Ru'), 'partial name does not match');
  assert(!symbolNameMatches('RunAll', 'Run'), 'longer name does not match');
  assert(!symbolNameMatches('(*Runner).Run', 'Calculator.Run'), 'other receiver does not match');
}

// Test 19: reference position must point at the identifier, not the start of the line
async function testFindIdentifierColumn() {
  assertEq(findIdentifierColumn('func (r *Runner) Run(x int) int {', 'Run'), 17, 'method name after receiver');
  assertEq(findIdentifierColumn('func Run() {', 'Run'), 5, 'plain function name');
  assertEq(findIdentifierColumn('func RunAll() {', 'Run'), -1, 'longer word is not a match');
  assertEq(findIdentifierColumn('func (r *Runner) Stop() {', 'Run'), -1, 'receiver prefix is not a match');
}

// Test 20: an explicit build of an unsupported directory must not report success
async function testBuildRejectsNoLanguage() {
  const emptyDir = path.join(os.tmpdir(), 'sym_test_nolang_build');
  await fs.rm(emptyDir, { recursive: true, force: true });
  await fs.mkdir(path.join(emptyDir, 'src'), { recursive: true });
  try {
    const { error, result } = await callTool('symbol_index_build', { target: emptyDir });
    assert(error !== undefined, `symbol_index_build should reject, got: ${JSON.stringify(result?.content)}`);
    assert(/No supported language detected/.test(error.message), `clear message, got: ${error.message}`);
    assert(error.message.includes(emptyDir), `message names the directory, got: ${error.message}`);
    assert(!(error instanceof TypeError), `Error, not ${error.constructor.name}: ${error.message}`);
  } finally {
    await fs.rm(emptyDir, { recursive: true, force: true });
  }
}

// Test 21: refreshing an index whose project markers vanished must not dereference a null language config
async function testRefreshRejectsWhenMarkersGone() {
  const dir = path.join(os.tmpdir(), 'sym_test_nolang_refresh');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'go.mod'), 'module nolang-test\n\ngo 1.21\n');
  await fs.writeFile(path.join(dir, 'src/main.go'), 'package main\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n');

  await buildIndex(dir, __dirname);
  assert(await readIndex(dir), 'index built while go.mod exists');

  // Make src/main.go newer than the index, then remove the only language marker.
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(path.join(dir, 'src/main.go'), future, future);
  await fs.rm(path.join(dir, 'go.mod'));

  // getWorkspace() resolves from process.cwd(), so run the tool from the temp project.
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const { error } = await callTool('symbol_index_symbols', {});
    assert(error !== undefined, 'symbol_index_symbols should reject when the markers are gone');
    assert(/No supported language detected/.test(error.message), `clear message, got: ${error.message}`);
    assert(!(error instanceof TypeError), `Error, not ${error.constructor.name}: ${error.message}`);
  } finally {
    process.chdir(prevCwd);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// The extension used to resolve the compiler with a bare directory specifier, which ESM rejects, so
// it always landed on its own typescript devDependency. A major bump there then changed indexing for
// every project. These cases pin the resolution order and the skip of a compiler without the legacy
// JS API.
async function testTypeScriptResolver() {
  const stamp = Date.now();
  const ownVersion = JSON.parse(
    await fs.readFile(path.join(__dirname, 'node_modules', 'typescript', 'package.json'), 'utf-8'),
  ).version as string;

  const writePkg = async (root: string, main: string) => {
    const pkgDir = path.join(root, 'node_modules', 'typescript');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'consumer' }));
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'typescript', version: '0.0.0-fake', main }),
    );
    return pkgDir;
  };

  // 1. A project copy that exposes createProgram wins over the extension's own.
  const localRoot = path.join(os.tmpdir(), `sym_test_tsres_local_${stamp}`);
  const localPkg = await writePkg(localRoot, 'index.js');
  await fs.writeFile(path.join(localPkg, 'index.js'), 'module.exports = { createProgram: () => "project-local" };');
  const local = await loadTypeScriptModule(localRoot);
  assertEq(typeof local?.createProgram, 'function', 'project copy loaded');
  assertEq(local.createProgram(), 'project-local', 'project copy beats the extension copy');

  // 2. A project copy without the legacy JS API (typescript 7 ships a version shim) is skipped.
  const shimRoot = path.join(os.tmpdir(), `sym_test_tsres_shim_${stamp}`);
  const shimPkg = await writePkg(shimRoot, 'shim.js');
  await fs.writeFile(path.join(shimPkg, 'shim.js'), 'module.exports = { version: "7.0.0" };');
  const afterShim = await loadTypeScriptModule(shimRoot);
  assertEq(
    typeof afterShim?.createProgram,
    'function',
    'fallback compiler has createProgram: the extension copy must expose the legacy JS API, typescript 7 does not',
  );
  assertEq(afterShim.version, ownVersion, 'shim skipped, extension copy used');

  // 3. No project copy at all: the extension's own dependency is used.
  const bareRoot = path.join(os.tmpdir(), `sym_test_tsres_bare_${stamp}`);
  await fs.mkdir(bareRoot, { recursive: true });
  await fs.writeFile(path.join(bareRoot, 'package.json'), JSON.stringify({ name: 'bare' }));
  const bare = await loadTypeScriptModule(bareRoot);
  assertEq(typeof bare?.createProgram, 'function', 'extension copy loaded for a project without one');
  assertEq(bare.version, ownVersion, 'extension copy version matches its package.json');

  for (const dir of [localRoot, shimRoot, bareRoot]) await fs.rm(dir, { recursive: true, force: true });
}


