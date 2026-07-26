// Pi Symbol Index Extension — Phase 2: gopls + TypeScript compiler API
//
// Uses vscode-jsonrpc (LSP JSON-RPC over LSP framing) to drive gopls,
// plus the TypeScript compiler API, to build a symbol index.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc/node";
import type { Location } from "vscode-languageserver-types/node";

// =========================================
// Types
// =========================================

interface IndexSymbol {
  name: string;
  kind: string;
  file: string;
  lineRange: [number, number];
  container?: string;
  usages: Array<{ file: string; range: [number, number] }>;
}

interface PiIndex {
  version: number;
  projectRoot: string;
  languages: string[];
  buildTs: string;
  files: Record<string, { status: "ok" | "partial" | "broken"; symbols: IndexSymbol[] }>;
  blocks: BlockIndex[];
}

const INDEX_DIR = ".pi-index";
const INDEX_FILE = "symbols.json";

const KIND_MAP: Record<number, string> = {
  12: "function", 6: "method", 11: "interface", 23: "struct", 5: "class",
  1: "file", 2: "module", 13: "variable", 14: "constant", 25: "enum",
  7: "property", 10: "event", 3: "namespace", 16: "package",
};

function getKindName(kind: number): string {
  return KIND_MAP[kind] ?? "unknown";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface BlockIndex {
  file: string;
  startLine: number;
  endLine: number;
  hash: string;
}

async function buildBlockIndex(workspaceFolder: string, symbols: IndexSymbol[], file: string): Promise<BlockIndex[]> {
  const fileSymbols = symbols.filter(s => s.file === file);
  const sorted = fileSymbols.sort((a, b) => a.lineRange[0] - b.lineRange[0]);
  if (sorted.length === 0) return [];

  const filePath = path.join(workspaceFolder, file);
  const textLines = (await fs.readFile(filePath, "utf-8")).split("\n");

  const blocks: BlockIndex[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const sym = sorted[i];
    const nextStart = i + 1 < sorted.length ? sorted[i + 1].lineRange[0] - 2 : textLines.length - 1; // -2 to include up to last line
    const endLine = Math.max(sym.lineRange[1], nextStart);
    const blockText = textLines.slice(sym.lineRange[0] - 1, endLine).join("\n") + "\n";
    const hash = sha256(blockText);
    blocks.push({ file, startLine: sym.lineRange[0], endLine, hash });
  }
  return blocks;
}

// =========================================
// Workspace folder resolution
// =========================================

let resolvedCwd: string = "";

async function getWorkspace(): Promise<string> {
  if (resolvedCwd) return resolvedCwd;
  return new Promise<string>((resolve) => {
    const check = async (ctx: { cwd: string }) => {
      resolvedCwd = ctx.cwd || "";
      resolve(resolvedCwd);
    };
    check({ cwd: "" });
  });
}

// =========================================
// Gopls extraction (LSP via vscode-jsonrpc)
// =========================================

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LspClient {
  proc: import("node:child_process").ChildProcess;
  connection: import("vscode-jsonrpc").MessageConnection;
}

async function buildLspClient(serverName: string, args: string[], workspaceFolder: string): Promise<LspClient> {
  const proc = spawn(serverName, args, {
    env: { ...process.env, GOFLAGS: "" },
    cwd: workspaceFolder,
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    console.error(`[${serverName} stderr] ${chunk.toString().trim()}`);
  });
  const reader = new StreamMessageReader(proc.stdout);
  const writer = new StreamMessageWriter(proc.stdin);
  const connection = createMessageConnection(reader, writer);
  connection.onNotification("window/showMessage", () => {});
  connection.onNotification("window/logMessage", () => {});
  connection.onNotification("textDocument/publishDiagnostics", () => {});
  return { proc, connection };
}

async function extractFromGopls(workspaceFolder: string, files: string[]): Promise<Record<string, { status: string; symbols: IndexSymbol[] }>> {
  const client = await buildLspClient("gopls", ["serve"], workspaceFolder);
  const result: Record<string, { status: string; symbols: IndexSymbol[] }> = {};
  const slice = files.slice(0, 100); // cap files for performance
  client.connection.listen();

  try {
    await client.connection.sendRequest("initialize", {
      processId: null,
      rootUri: `file://${workspaceFolder}`,
      capabilities: { textDocument: { documentSymbol: {}, references: {} }, workspace: { symbol: {} } },
    }) as any;
  } catch (e: any) {
    console.log(`[pi_symbol_index] gopls initialize: ${e.message}`);
  }

  client.connection.sendNotification("initialized", {});

  for (const file of slice) {
    const filePath = path.join(workspaceFolder, file);
    const fileUri = `file://${filePath}`;
    try {
      const text = await fs.readFile(filePath, "utf-8");
      client.connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri: fileUri, languageId: "go", version: 1, text },
      });
      await sleep(300);
      const symbols: any = await client.connection.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: fileUri },
      });

      const fileSymbols: IndexSymbol[] = [];
      if (Array.isArray(symbols)) {
        for (const s of symbols) {
          const loc = s.location || s;
          const range = loc.range || loc;
          if (range.start?.line != null) {
            fileSymbols.push({
              name: s.name, kind: getKindName(s.kind), file,
              lineRange: [range.start.line + 1, range.end.line + 1],
              container: s.containerName || undefined, usages: [],
            });
          }
        }
      }

      // Get references for functions/methods/interfaces/structs
      for (const sym of fileSymbols) {
        if (!["function", "method", "interface", "struct"].includes(sym.kind)) continue;
        try {
          const fullText = await fs.readFile(filePath, "utf-8");
          const lineContent = fullText.split("\n")[sym.lineRange[0] - 1] || "";
          const charIdx = lineContent.indexOf(sym.name);
          if (charIdx === -1) continue;
          const refs: Location[] = await client.connection.sendRequest("textDocument/references", {
            textDocument: { uri: fileUri },
            position: { line: sym.lineRange[0] - 1, character: charIdx },
            context: { includeDeclaration: false },
          }) as unknown as Location[];
          if (Array.isArray(refs)) {
            sym.usages = refs.filter((r) => r?.uri).map((r) => ({
              file: r!.uri.replace(/^file:\/\//, ""),
              range: [r!.range.start.line + 1, r!.range.end.line + 1],
            }));
          }
        } catch { /* skip */ }
      }

      result[file] = { status: "ok", symbols: fileSymbols };
    } catch (e: any) {
      console.error(`[pi_symbol_index] Failed to index ${file}: ${e.message}`);
      result[file] = { status: "broken", symbols: [] };
    }
  }

  return result;
}

// =========================================
// TypeScript extraction (compiler API)
// =========================================

async function extractFromTsProgram(workspaceFolder: string, files: string[]): Promise<Record<string, { status: string; symbols: IndexSymbol[] }>> {
  let ts: any;
  let requireTs = (path: string) => { try { return require(path); } catch { return null; } };
  // Try loading from workspace/node_modules first, so index.ts works in any workspace
  { const w = requireTs(path.join(workspaceFolder, "node_modules", "typescript")); if (w) ts = w.default || w; }
  if (!ts) { try { ts = await import("typescript"); } catch { try { ts = require("typescript"); } catch { throw new Error("TypeScript module not found — install typescript in the project."); } } }
  const fullPaths = files.map((f) => path.join(workspaceFolder, f));
  const program = ts!.createProgram(fullPaths, { noEmit: true });
  const result: Record<string, { status: string; symbols: IndexSymbol[] }> = {};

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(workspaceFolder)) continue;
    const relative = path.relative(workspaceFolder, sf.fileName);
    const symbols: IndexSymbol[] = [];
    const seen = new Set<string>();

    function nodeSymbolKind(node: any): number | undefined {
      if (ts!.isFunctionDeclaration(node)) return 12;
      if (ts!.isMethodDeclaration(node)) return 6;
      if (ts!.isClassDeclaration(node)) return 5;
      if (ts!.isInterfaceDeclaration(node)) return 11;
      if (ts!.isTypeAliasDeclaration(node)) return 11;
      if (ts!.isEnumDeclaration(node)) return 25;
      if (ts!.isVariableStatement(node) && node.declarations && node.declarations[0]) return 13;
      return undefined;
    }

    function walk(node: any, container?: string): void {
      try {
        const kind = nodeSymbolKind(node);
        let symText = "";
        try {
          const name = (node as any).name as any;
          symText = name?.text || name?.escapedText || "";
        } catch {}
        if (kind != null && symText) {
          const fullName = container ? `${container}.${symText}` : symText;
          if (!seen.has(fullName)) {
            seen.add(fullName);
            try {
              const sfRef = (node as any).getSourceFile && (node as any).getSourceFile() || sf;
              const start = sfRef.getLineAndCharacterOfPosition(node.getStart ? node.getStart(sfRef) : node.getStart());
              const end = sfRef.getLineAndCharacterOfPosition(node.getEnd());
              symbols.push({
                name: symText, kind: getKindName(kind), file: relative,
                lineRange: [start.line + 1, end.line + 1],
                container: container && container !== "<module>" ? container : undefined, usages: [],
              });
            } catch { /* skip nodes without sourcemapping */ }
          }
        }
        const next = (kind === 5 || kind === 11) ? symText : container || "<module>";
        ts!.forEachChild(node, (child: any) => walk(child, next));
      } catch { /* skip */ }
    }

    walk(sf);
    result[relative] = { status: "ok", symbols };
  }

  return result;
}

// =========================================
// File discovery
// =========================================

async function listGoFiles(workspaceFolder: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "vendor" || entry.name === ".git" || entry.name === "out" || entry.name === "dist" || entry.name === "_test") continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".go")) {
        files.push(path.relative(workspaceFolder, path.join(dir, entry.name)));
      }
    }
  }
  await walk(workspaceFolder);
  return files;
}

async function listTsFiles(workspaceFolder: string): Promise<string[]> {
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"];
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "vendor" || entry.name === ".git" || entry.name === "out" || entry.name === "dist" || entry.name === "_test") continue;
        await walk(path.join(dir, entry.name));
      } else if (exts.some((e) => entry.name.endsWith(e))) {
        files.push(path.relative(workspaceFolder, path.join(dir, entry.name)));
      }
    }
  }
  await walk(workspaceFolder);
  return files;
}

async function detectLanguage(workspaceFolder: string): Promise<{ name: string; files: string[] } | null> {
  try {
    await fs.access(path.join(workspaceFolder, "go.mod"));
    return { name: "go", files: await listGoFiles(workspaceFolder) };
  } catch {}
  try {
    await fs.access(path.join(workspaceFolder, "package.json"));
    return { name: "typescript", files: await listTsFiles(workspaceFolder) };
  } catch {}
  return null;
}

// =========================================
// Core index building
// =========================================

async function buildIndex(): Promise<void> {
  const workspaceFolder = await getWorkspace();
  if (!workspaceFolder) throw new Error("No workspace folder");

  const lang = await detectLanguage(workspaceFolder);
  if (!lang) throw new Error("No supported project detected (need go.mod or package.json)");

  console.log(`[pi_symbol_index] Indexing for ${lang.name} in ${workspaceFolder}`);
  const files = lang.files;
  console.log(`[pi_symbol_index] Found ${files.length} ${lang.name} files`);

  const result = lang.name === "go"
    ? await extractFromGopls(workspaceFolder, files)
    : await extractFromTsProgram(workspaceFolder, files);

  let totalSymbols = 0, totalFiles = 0;
  for (const [, data] of Object.entries(result)) {
    totalSymbols += data.symbols.length;
    totalFiles++;
  }
  console.log(`[pi_symbol_index] Indexed ${totalSymbols} symbols across ${totalFiles} files`);

  // Build blocks for each file based on symbol line ranges
  const allBlocks: BlockIndex[] = [];
  for (const file of files) {
    const symbols = result[file]?.symbols || [];
    const blocks = await buildBlockIndex(workspaceFolder, symbols, file);
    allBlocks.push(...blocks);
  }
  console.log(`[pi_symbol_index] Found ${allBlocks.length} editable blocks`);

  if (!await fs.access(INDEX_DIR).catch(() => false)) await fs.mkdir(INDEX_DIR, { recursive: true });
  const index: PiIndex = {
    version: 1, projectRoot: workspaceFolder, languages: [lang.name],
    buildTs: new Date().toISOString(), files: result, blocks: allBlocks,
  };
  const indexPath = path.join(workspaceFolder, INDEX_DIR, INDEX_FILE);
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  console.log(`[pi_symbol_index] Wrote ${INDEX_DIR}/${INDEX_FILE}`);
}

async function readIndex(): Promise<PiIndex | null> {
  const indexPath = path.join(INDEX_DIR, INDEX_FILE);
  try {
    const data = await fs.readFile(indexPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// =========================================
// Extension registration
// =========================================

export default async function (api: ExtensionAPI): Promise<void> {
  // Trigger workspace resolution during session_start
  api.on("session_start", async (_event: any, ctx: { cwd?: string }) => {
    if (ctx && ctx.cwd) {
      resolvedCwd = ctx.cwd;
    }
  });

  api.registerTool({
    name: "pi_symbol_build",
    label: "Build Symbol Index",
    description: "Scan the project and build the Pi Symbol Index. Replaces the index if it's stale.",
    parameters: Type.Object({}),
    execute: async () => {
      await buildIndex();
      return { content: [{ type: "text", text: "Index built." }] };
    },
  });

  api.registerTool({
    name: "pi_symbol_info",
    label: "Symbol Info",
    description: "Get info about a specific symbol (name, kind, line range, container, usages).",
    parameters: Type.Object({
      name: Type.String({ description: "The symbol name to look up." }),
    }),
    execute: async (id, params) => {
      if (!params || typeof params.name !== "string") throw new Error('Please provide a valid symbol name as string parameter: {"name": "SymbolName"}.');
      const index = await readIndex();
      if (!index) throw new Error("No symbol index found. Run pi_symbol_build first.");
      const results: IndexSymbol[] = [];
      for (const key of Object.keys(index.files)) {
        for (const s of index.files[key].symbols) {
          if (s.name === params.name && s.usages.length > 0) results.push({ ...s, usages: s.usages });
        }
      }
      if (results.length === 0) throw new Error(`No symbol found matching ${params.name}`);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  });

  api.registerTool({
    name: "pi_project_symbols",
    label: "Project Symbols",
    description: "List all indexed symbols across the entire project.",
    parameters: Type.Object({}),
    execute: async () => {
      const index = await readIndex();
      if (!index) throw new Error("No symbol index found. Run pi_symbol_build first.");
      const symbolMap: Record<string, IndexSymbol[]> = {};
      for (const key of Object.keys(index.files)) {
        symbolMap[key.replace(/^.*?\//, "")] = index.files[key].symbols;
      }
      return { content: [{ type: "text", text: JSON.stringify(symbolMap, null, 2) }] };
    },
  });

  api.registerTool({
    name: "pi_replace_block",
    label: "Replace Code Block",
    description: 'Replace a code block by hash. No "oldText" required — the extension finds the block by hash. If the hash check fails (file was modified externally), the operation is refused to prevent desync.',
    parameters: Type.Object({
      file: Type.String({ description: "Filename of the file to replace." }),
      hash: Type.String({ description: "SHA256 block hash to locate the block." }),
      newText: Type.String({ description: "The replacement text to insert." }),
    }),
    execute: async (_id, params) => {
      if (!params || !params.file || !params.hash || typeof params.newText !== "string") throw new Error('Invalid parameters. Provide file, hash, and newText as string fields.');
      const index = await readIndex();
      if (!index) throw new Error("No symbol index found. Run pi_symbol_build first.");
      const block = index.blocks.find(b => b.file === params.file && b.hash === params.hash);
      if (!block) throw new Error(`Block hash ${params.hash} not found or file ${params.file} doesn't exist.`);
      // Re-read the live file and verify the block still matches
      let liveText: string;
      try { liveText = await fs.readFile(path.join(workspaceFolder, params.file), "utf-8"); } catch (e) { throw new Error(`Failed to read ${params.file}: ${(e as any).message}`); }
      const liveLines = liveText.split("\n");
      const currentBlockText = liveLines.slice(block.startLine - 1, block.endLine).join("\n") + "\n";
      const currentHash = sha256(currentBlockText);
      if (currentHash !== params.hash) throw new Error(`Block hash mismatch (file changed externally). Expected ${params.hash}, got ${currentHash}.`);
      // Apply replacement using Pi's internal edit tool via a fake Pi call
      // For now, use the extension to perform the file write if we have it available.
      const newLines = params.newText.split("\n");
      const newFileContent = [...liveLines.slice(0, block.startLine - 1), ...newLines, ...liveLines.slice(block.endLine)].join("\n");
      await fs.writeFile(path.join(workspaceFolder, params.file), newFileContent);
      console.log(`[pi_replace_block] Replaced block ${params.hash} in ${params.file}`);
      return { content: [{ type: "text", text: `Block replaced at ${params.file}:${block.startLine}-${block.endLine}` }] };
    },
  });
}
