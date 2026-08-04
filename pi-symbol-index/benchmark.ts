import jiti from "jiti";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execAsync = promisify(exec);

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  async function walk(d: string) {
    try {
      const entries = await fs.readdir(d, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) await walk(path.join(d, e.name));
        else count++;
      }
    } catch {}
  }
  await walk(dir);
  return count;
}

async function getDirSize(dir: string): Promise<number> {
  let size = 0;
  async function walk(d: string) {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(d, e.name));
      else size += (await fs.stat(path.join(d, e.name))).size;
    }
  }
  await walk(dir);
  return size;
}

function formatSize(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${(b / (1024 * 1024)).toFixed(1)}MB`;
}

async function benchmarkFullBuild(name: string, dir: string, iterations: number = 5): Promise<void> {
  console.log(`\n=== ${name} ===`);
  const fileCount = await countFiles(dir);
  const size = await getDirSize(dir);
  console.log(`Files: ${fileCount}  Size: ${formatSize(size)}`);

  // Warmup
  await execAsync(`cd ${dir} && pi -p 'pi_symbol_build' 2>/dev/null`);

  // Full builds
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    await execAsync(`cd ${dir} && pi -p 'pi_symbol_build' 2>/dev/null`);
    times.push(Date.now() - start);
  }
  times.sort((a, b) => a - b);

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`\nFull build (ms):`);
  console.log(`  min:   ${times[0]}`);
  console.log(`  max:   ${times[times.length - 1]}`);
  console.log(`  avg:   ${avg.toFixed(0)}`);
  console.log(`  p95:   ${times[Math.floor(0.95 * times.length)]}`);
}

async function benchmarkIncremental(name: string, dir: string): Promise<void> {
  console.log(`\n=== ${name} (incremental) ===`);

  // Build initial index
  await execAsync(`cd ${dir} && pi -p 'pi_symbol_build' 2>/dev/null`);

  // Modify a file
  const testDir = os.tmpdir();
  const testFile = path.join(testDir, "benchmark_test.ts");
  await fs.writeFile(testFile, `// benchmark test\nexport const x = 1;\n`);

  // Measure time to detect change and rebuild
  const start = Date.now();
  await execAsync(`cd ${dir} && pi -p 'pi_symbol_info("x")' 2>/dev/null`);
  const elapsed = Date.now() - start;

  await fs.rm(testFile);

  console.log(`  Time to detect + rebuild: ${elapsed}ms`);
}

async function main() {
  const projects = [
    { name: "pi-extensions (mono)", dir: "/home/icedream/Documents/Source/Git/github.com/icedream/pi-extensions" },
    { name: "Go test project", dir: "/home/icedream/Documents/Source/Git/github.com/icedream/pi-extensions/_test/symbol-test" },
  ];

  for (const p of projects) {
    await benchmarkFullBuild(p.name, p.dir);
    await benchmarkIncremental(p.name, p.dir);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
