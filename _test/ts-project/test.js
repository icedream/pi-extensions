// Test: run extractFromTsserver (via a manual LSP driver) on a TS project
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = __dirname;

const KIND_MAP = {
  12: "function", 6: "method", 11: "interface", 23: "struct",
  5: "class", 1: "file", 13: "variable", 7: "property",
};

function spawnServer(name) {
  const proc = spawn(name, ["--stdio"], { env: { ...process.env }, cwd: WORKSPACE });
  proc.stderr?.on("data", (d) => console.error(`[stderr] ${d.toString().trim()}`));
  const reader = new StreamMessageReader(proc.stdout);
  const writer = new StreamMessageWriter(proc.stdin);
  const conn = createMessageConnection(reader, writer);
  conn.onNotification("window/showMessage", () => {});
  conn.onNotification("window/logMessage", () => {});
  conn.onNotification("textDocument/publishDiagnostics", () => {});
  return conn;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const conn = spawnServer("typescript-language-server");
  if (!conn) throw new Error("Failed to start server");

  conn.listen();
  await conn.sendRequest("initialize", {
    processId: null,
    rootUri: `file://${WORKSPACE}`,
    capabilities: { textDocument: { documentSymbol: {}, references: {} }, workspace: { symbol: {} } },
  });
  conn.sendNotification("initialized", {});
  await sleep(500);

  // Open a file
  const filePath = path.join(WORKSPACE, "index.ts");
  const content = await readFile(filePath, "utf-8");
  const uri = `file://${filePath}`;

  conn.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "typescript", version: 1, text: content },
  });
  await sleep(300);

  const symbols = await conn.sendRequest("textDocument/documentSymbol", { textDocument: { uri } });
  console.log("=== Symbols ===");
  console.log(JSON.stringify(symbols, null, 2));

  // Check: is it an array?
  if (!Array.isArray(symbols)) {
    throw new Error("symbol extraction failed");
  }
  const funcs = symbols.filter(s => s.kind === 12 || s.containerName);
  const classes = symbols.filter(s => s.kind === 5);
  const interfaces = symbols.filter(s => s.kind === 11);
  console.log(`\n=== Summary ===`);
  console.log(`Total symbols: ${symbols.length}`);
  console.log(`Functions: ${funcs.length}`);
  console.log(`Classes: ${classes.length}`);
  console.log(`Interfaces: ${interfaces.length}`);

  // Try reference lookup for greet
  try {
    const references = await conn.sendRequest("textDocument/references", {
      textDocument: { uri },
      position: { line: 5, character: 11 },
      context: { includeDeclaration: false },
    });
    console.log(`\n=== References for 'greet' (position 6,11) ===`);
    console.log(JSON.stringify(references, null, 2));
  } catch (e) {
    console.error(`Reference lookup failed: ${e.message}`);
  }

  conn.dispose();
  console.log("\n=== PASSED: TypeScript symbol extraction works ===");
}

main().catch((e) => { console.error(e); process.exit(1); });
