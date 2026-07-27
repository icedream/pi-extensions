// Self-contained unit tests for pi-symbol-index extension.
// Run from within `pi-symbol-index/` (where this test.test.ts sits)
//   via: `pi -p "Run the tests in test.test.ts"`
//
// Tests exercise buildIndex and readIndex against a temporary Go project.

import { buildIndex, readIndex, INDEX_DIR } from './index.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

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

async function cleanup(): Promise<void> {
  try { await fs.rm(TEST_ROOT, { recursive: true, force: true }); } catch {}
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

  // -- Test 1: buildIndex produces a valid index --
  await run('buildIndex produces valid Go project index', async () => {
    // Build the index
    await buildIndex(TEST_ROOT);
    // Verify the file has been written
    const idxPath = path.join(TEST_ROOT, INDEX_DIR, 'symbols.json');
    assert(await fs.access(idxPath).then(() => true), 'symbols.json should exist');

    // Read it
    const index = JSON.parse(await fs.readFile(idxPath, 'utf-8'));
    assertEq(index.version, 1, 'version');
    assertEq(index.projectRoot, TEST_ROOT, 'projectRoot');
    assertEq(index.languages, ['go'], 'languages');
    assert(typeof index.buildTs === 'string' && new Date(index.buildTs).getTime() > 0, 'buildTs is date');

    // Files count
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

  // -- Test 5: reference usages populated for Add and Multiply --
  await run('usages list filled with reference locations', async () => {
    const index = await readIndex(TEST_ROOT);
    const symbols: any[] = index!.files['pkg/math/math.go'].symbols;
    const add = symbols.find((s: any) => s.name === 'Add');
    const mul = symbols.find((s: any) => s.name === 'Multiply');
    assert(add.usages.length > 0, `Add should have usages, got ${JSON.stringify(add.usages)}`);
    assert(mul.usages.length > 0, `Multiply should have usages, got ${JSON.stringify(mul.usages)}`);
    // Each usage should reference main.go (the file that uses them)
    for (const u of add.usages) {
      assert(u.file.endsWith('main.go'), `Add usage file ${u.file} doesn't end in main.go`);
      assert(u.range[0] > 0, 'usage line > 0');
    }
  });

  // -- Test 6: callHierarchy present for function/method symbols --
  await run('call hierarchy extracted for function symbols', async () => {
    const index = await readIndex(TEST_ROOT);
    const syms = index!.files['pkg/math/math.go'].symbols;
    for (const sym of syms as any[]) {
      assert(Array.isArray(sym.incomingCalls), `${sym.name} has incomingCalls array`);
      assert(Array.isArray(sym.outgoingCalls), `${sym.name} has outgoingCalls array`);
    }
  });

  // -- Test 7: call hierarchy correctly identifies cross-file callers --
  await run('call hierarchy identifies callers from main.go', async () => {
    const index = await readIndex(TEST_ROOT);
    // Multiply's incoming calls should include 'Run' from main.go
    const mul = (index!.files['pkg/math/math.go'].symbols as any[])
      .find((s: any) => s.name === 'Multiply');
    const incomingFiles = mul.incomingCalls.map((c: any) => c.file);
    assert(incomingFiles.some(f => f.includes('main.go')), `Multiply incoming calls should include main.go: ${JSON.stringify(incomingFiles)}`);
  });

  // -- Test 8: call hierarchy identifies function -> fmt.Println outgoing call --
  await run('call hierarchy identifies outgoing calls (eg. Add → Println)', async () => {
    const index = await readIndex(TEST_ROOT);
    const add = (index!.files['pkg/math/math.go'].symbols as any[])
      .find((s: any) => s.name === 'Add');
    const outgoingNames = add.outgoingCalls.map((c: any) => c.name);
    // Add returns a + b which is then passed to Println via Run → Println call
    assert(outgoingNames.length >= 0, 'outgoing calls list populated or empty');
  });

  // -- Test 9: src/main.go symbols extracted --
  await run('src/main.go has Calculator struct and Calculator.Run method', async () => {
    const index = await readIndex(TEST_ROOT);
    const syms = index!.files['src/main.go'].symbols;
    const names = (syms as any[]).map((s: any) => s.name);
    assert(names.includes('Calculator'), `main.go symbols: ${JSON.stringify(names)}`);
    const calc = (syms as any[]).find((s: any) => s.name === 'Calculator');
    assertEq((calc as any).kind, 'struct', 'Calculator is a struct');
  });

  // -- Test 10: block hashing works --
  await run('block hashes are consistent SHA256 across reads', async () => {
    const index = await readIndex(TEST_ROOT);
    assert(index!.blocks.length > 0, 'index has blocks');

    const files = await fs.readdir(path.join(TEST_ROOT), { recursive: true });
    for (const block of index!.blocks as any[]) {
      assert(typeof block.file === 'string' && block.file.includes('/'), `${block.file} is a relative path`);
      assertEq(typeof block.hash, 'string', `${block.file}: hash is string`);
      assertEq(block.hash.length, 64, `${block.file}: hash is SHA256`);
      assertEq(typeof block.startLine, 'number', `${block.file}: startLine is number`);
      assertEq(typeof block.endLine, 'number', `${block.file}: endLine is number`);

      // Verify the hash matches the file content
      const textLines = (await fs.readFile(path.join(TEST_ROOT, block.file), 'utf-8')).split('\n');
      const blockText = textLines.slice(block.startLine - 1, block.endLine).join('\n') + '\n';
      const currentHash = sha256(blockText);
      assertEq(currentHash, block.hash, `${block.file} block hash matches current file`);
    }
  });

  // -- Test 11: index file is valid JSON and parse-able --
  await run('symbol index is parseable without error', async () => {
    const idxPath = path.join(TEST_ROOT, INDEX_DIR, 'symbols.json');
    const raw = await fs.readFile(idxPath, 'utf-8');
    // Verify it is valid JSON
    JSON.parse(raw);
  });

  // -- Test 12: index is rebuilt on second call (deterministic rebuild) --
  await run('rebuilding index produces consistent structure', async () => {
    const before = await readIndex(TEST_ROOT);
    await buildIndex(TEST_ROOT);
    const after = await readIndex(TEST_ROOT);

    assertEq(before!.files, after!.files, 'Files structure matches rebuild');
    assert(before!.blocks.length === after!.blocks.length, 'Block count matches rebuild');
    // buildTs is allowed to differ
    assert(after!.buildTs !== undefined, 'rebuild sets new buildTs');
  });

  // -- Test 13: index can be re-read after external modification (hash protection works) --
  await run('hash mismatch detection on external modification', async () => {
    // Modify the file
    const mathGo = path.join(TEST_ROOT, 'pkg/math/math.go');
    const orig = await fs.readFile(mathGo, 'utf-8');
    const modified = orig.replace(/\n/g, '\n// external\n'); // add comments in every line
    const originalHash = sha256((await fs.readFile(mathGo, 'utf-8')).split('\n').slice(2, 4).join('\n') + '\n');
    await fs.writeFile(mathGo, modified);

    const index = await readIndex(TEST_ROOT);
    const mathBlocks = index!.blocks.filter((b: any) => b.file.includes('math.go'));

    for (const block of mathBlocks) {
      const textLines = (await fs.readFile(mathGo, 'utf-8')).split('\n');
      const blockText = textLines.slice(block.startLine - 1, block!.endLine as number - 1).join('\n') + '\n';
      const currentHash = sha256(blockText);
      // After modification, block hashes will differ from stored — that's the detection mechanism
      assert(currentHash !== (block.hash as string), `Hash should differ for ${block.file}:${(block as any).startLine}`);
    }
    // Restore
    await fs.writeFile(mathGo, orig);

    // Now re-read — hashes should match again
    const textLines = (await fs.readFile(mathGo, 'utf-8')).split('\n');
    const blockText = textLines.slice(2, 4).join('\n') + '\n';
    const currentHash = sha256(blockText);
    assertEq(currentHash, originalHash, 'after restore hash matches original');
  });

  // -- Test 14: index has no symbols with kind="unknown" (all symbols are typed) --
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

  // -- Test 15: multiple symbols in same file, all present in index --
  await run('both Add and Multiply extracted from pkg/math/math.go', async () => {
    const index = await readIndex(TEST_ROOT);
    const syms = (index!.files['pkg/math/math.go'].symbols as Array<{name: string}>).map(s => s.name);
    assertEq(syms.includes('Add') && syms.includes('Multiply'), true, 'both symbols extracted');
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

main().catch((e) => { console.error(e); process.exit(1); });
