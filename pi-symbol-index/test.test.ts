import { buildIndex, readIndex } from './index';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const TEST_PROJECT = path.join(os.tmpdir(), 'sym-test-project');

async function setupTestProject(): Promise<void> {
  await fs.mkdir(TEST_PROJECT, { recursive: true });
  await fs.writeFile(
    path.join(TEST_PROJECT, 'go.mod'),
    'module symtest\ngo 1.21\n',
  );

  await fs.mkdir(path.join(TEST_PROJECT, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(TEST_PROJECT, 'src/main.go'),
    `package main

import "fmt"

func main() {
	fmt.Println("hello")
}
`,
  );

  await fs.mkdir(path.join(TEST_PROJECT, 'pkg', 'math'), { recursive: true });
  await fs.writeFile(
    path.join(TEST_PROJECT, 'pkg/math/math.go'),
    `package math

import "fmt"

// Add returns the sum of a and b.
func Add(_a, b int) int {
	return _a + b
}

// FormatResult creates a formatted result string.
func FormatResult(label string, value int) string {
	return fmt.Sprintf("%s: %d", label, value)
}
`,
  );
}

async function main(): Promise<void> {
  console.log(`Test project: ${TEST_PROJECT}`);

  await setupTestProject();
  console.log('Test project created.');

  // Test 1: buildIndex
  console.log('\n--- Test 1: buildIndex ---');
  try {
    await buildIndex(TEST_PROJECT);
    console.log('buildIndex succeeded');
  } catch (e: any) {
    console.error('buildIndex failed:', e);
    process.exit(1);
  }

  // Test 2: readIndex
  console.log('\n--- Test 2: readIndex ---');
  const index = await readIndex();
  if (!index) {
    console.error('readIndex returned null — no index');
    process.exit(1);
  }
  console.log('readIndex succeeded');
  console.log('Files:', Object.keys(index.files).length);
  console.log('Total symbols:', Object.values(index.files).reduce((a, f) => a + f.symbols.length, 0));

  // Test 3: check specific symbols
  console.log('\n--- Test 3: specific symbols ---');
  for (const f of Object.keys(index.files)) {
    const fi = index.files[f];
    if (fi.symbols.length > 0) {
      for (const s of fi.symbols) {
        console.log(`  ${f} -> ${s.name} (${s.kind}) @ ${JSON.stringify(s.lineRange)}`);
      }
    }
  }

  // Test 4: search by name
  console.log('\n--- Test 4: find "Add" symbol ---');
  const addSymbol = Object.keys(index.files)
    .flatMap((f) => index.files[f].symbols.map((s) => ({ ...s, file: f })))
    .find((s) => s.name === 'Add');
  if (addSymbol) {
    console.log(`Found Add:`, addSymbol.file, addSymbol.kind, addSymbol.lineRange);
  } else {
    console.log('Add symbol not found');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
