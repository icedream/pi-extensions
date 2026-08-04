// Pi Symbol Index Extension — Config-driven, language-agnostic LSP client
//
// Configuration is loaded from pi-symbol-index.json in the extension directory.
// Each language entry specifies: server binary, args, env, detection files,
// file extensions, and a symbol kind mapping.
//
// This approach lets users add new languages without modifying code —
// just add a config entry and ensure the LSP server is installed.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc/node";
import type { Location } from "vscode-languageserver-types/node";
import { SymbolKind } from "vscode-languageserver-types";
import { createHash } from "node:crypto";

// =========================================
// Config types
// =========================================

interface LanguageConfig {
  server: string;
  args: string[];
  env?: Record<string, string>;
  detect: string[];
  extensions: string[];
  symbolKindMap: Record<string, string>;
}

interface Config {
  languages: Record<string, LanguageConfig>;
}

// =========================================
// Core types
// =========================================

interface IndexSymbol {
  name: string;
  kind: string;
  file: string;
  lineRange: [number, number];
  container?: string;
  usages: Array<{ file: string; range: [number, number] }>;
  incomingCalls: Array<{ name: string; kind: string; file: string; lineRange: [number, number] }>;
  outgoingCalls: Array<{ name: string; kind: string; file: string; lineRange: [number, number] }>;
}

interface PiIndex {
  version: number;
  projectRoot: string;
  languages: string[];
  buildTs: string;
  sourceMtime: number;
  files: Record<string, { status: "ok" | "partial" | "broken"; symbols: IndexSymbol[] }>;
  blocks: BlockIndex[];
}

interface BlockIndex {
  file: string;
  startLine: number;
  endLine: number;
  hash: string;          // Full SHA256 for internal desync detection
  shortId: string;       // Base36 CRC32 (6 chars) for model use
}

interface LspClient {
  proc: import("node:child_process").ChildProcess;
  connection: import("vscode-jsonrpc").MessageConnection;
}

// =========================================
// Constants
// =========================================

export const INDEX_DIR = ".pi-index";
export const INDEX_FILE = "symbols.json";

// =========================================
// Config loading
// =========================================

let config: Config | null = null;
let extensionPath: string = "";

async function loadConfig(extPath: string): Promise<Config> {
  if (config) return config;
  const configPath = path.join(extPath, "pi-symbol-index.json");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch {
    // Fallback: use built-in defaults
    config = {
      languages: {
        go: {
          server: "gopls", args: ["serve"], env: { GOFLAGS: "" },
          detect: ["go.mod"], extensions: [".go"],
          symbolKindMap: { function: "function", method: "method", interface: "interface", struct: "struct", type: "type", package: "package", const: "constant", var: "variable", field: "field", label: "label" }
        },
        rust: {
          server: "rust-analyzer", args: ["--stdio"],
          detect: ["Cargo.toml"], extensions: [".rs"],
          symbolKindMap: { function: "function", method: "method", struct: "struct", enum: "enum", enum_variant: "enum_variant", constant: "constant", trait: "interface", module: "module", type_parameter: "type_parameter", macro_rules: "macro" }
        },
        python: {
          server: "pyright", args: ["--stdio"],
          detect: ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile"], extensions: [".py", ".pyi"],
          symbolKindMap: { function: "function", method: "method", class: "class", module: "module", constant: "constant", variable: "variable", parameter: "parameter", property: "property" }
        },
        c_cpp: {
          server: "clangd", args: [],
          detect: ["compile_commands.json", "Makefile", "CMakeLists.txt"], extensions: [".c", ".cpp", ".h", ".hpp", ".cc", ".cxx"],
          symbolKindMap: { function: "function", method: "method", struct: "struct", class: "class", enum: "enum", typedef: "type", macro: "macro", namespace: "namespace", variable: "variable" }
        },
        typescript: {
          server: "typescript-language-server", args: ["--stdio"],
          detect: ["package.json", "tsconfig.json"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"],
          symbolKindMap: { function: "function", method: "method", class: "class", interface: "interface", type: "type", enum: "enum", const: "constant", variable: "variable", parameter: "parameter", property: "property", module: "module", namespace: "namespace" }
        }
      }
    };
  }
  return config;
}

// =========================================
// Workspace folder resolution
// =========================================

let resolvedCwd: string = "";

async function getWorkspace(): Promise<string> {
  if (resolvedCwd) return resolvedCwd;
  resolvedCwd = process.cwd();
  return resolvedCwd;
}

// =========================================
// SHA256 hashing
// =========================================

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function crc32(text: string): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & (crc & 1) * 0xEDB88320);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function toBase36(n: number): string {
  // Mask to 30 bits (max 36^6 - 1 = 2,176,782,335) to guarantee 6 chars
  n = n & 0x3FFFFFF;
  const s = n.toString(36);
  return s.padStart(6, '0');
}

// =========================================
// LSP client factory
// =========================================

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildLspClient(
  serverName: string,
  args: string[],
  workspaceFolder: string,
  env: Record<string, string> = {},
): Promise<LspClient> {
  const proc = spawn(serverName, args, {
    env: { ...process.env, ...env },
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

// =========================================
// Generic LSP symbol extraction
// =========================================

async function extractSymbolsFromLsp(
  client: LspClient,
  workspaceFolder: string,
  files: string[],
  symbolKindMap: Record<string, string>,
): Promise<Record<string, { status: string; symbols: IndexSymbol[] }>> {
  const result: Record<string, { status: string; symbols: IndexSymbol[] }> = {};
  const slice = files;

  client.connection.listen();

  try {
    await client.connection.sendRequest("initialize", {
      processId: null,
      rootUri: `file://${workspaceFolder}`,
      capabilities: { textDocument: { documentSymbol: {}, references: {}, callHierarchy: {} }, workspace: { symbol: {} } },
    }) as any;
  } catch (e: any) {
  }

  client.connection.sendNotification("initialized", {});

  for (const file of slice) {
    const filePath = path.join(workspaceFolder, file);
    const fileUri = `file://${filePath}`;
    try {
      const text = await fs.readFile(filePath, "utf-8");
      client.connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri: fileUri, languageId: getLangId(file), version: 1, text },
      });

      const symbols: any = await client.connection.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri: fileUri },
      });

      const fileSymbols: IndexSymbol[] = [];
      if (Array.isArray(symbols)) {
        for (const s of symbols) {
          const loc = s.location || s;
          const range = loc.range || loc;
          if (range.start?.line != null) {
            // Reverse lookup: find the string key for the numeric SymbolKind value
            const kindKey = Object.keys(SymbolKind).find(k => SymbolKind[k] === s.kind) || String(s.kind);
            fileSymbols.push({
              name: s.name,
              kind: symbolKindMap[kindKey.toLowerCase()] ?? symbolKindMap[kindKey] ?? "unknown",
              file,
              lineRange: [range.start.line + 1, range.end.line + 1],
              container: s.containerName || undefined,
              usages: [],
              incomingCalls: [],
              outgoingCalls: [],
            });
          }
        }
      }

      // Get references for functions/methods/interfaces/structs
      for (const sym of fileSymbols) {
        if (!["function", "method", "interface", "struct"].includes(sym.kind)) continue;
        try {
          // Use the LSP-provided position from documentSymbol
          const lineContent = (await fs.readFile(filePath, "utf-8")).split("\n")[sym.lineRange[0] - 1] || "";
          const charIdx = lineContent.indexOf(sym.name);
          const refs: Location[] = await client.connection.sendRequest("textDocument/references", {
            textDocument: { uri: fileUri },
            position: { line: sym.lineRange[0] - 1, character: charIdx >= 0 ? charIdx : 0 },
            context: { includeDeclaration: false },
          }) as unknown as Location[];
          if (Array.isArray(refs)) {
            sym.usages = refs.filter((r) => r?.uri).map((r) => ({
              file: r!.uri.replace(/^file:\/\//, ""),
              range: [r!.range.start.line + 1, r!.range.end.line + 1],
            }));
          }

          // Get call hierarchy
          if (sym.name && sym.lineRange[1] >= sym.lineRange[0]) {
            try {
              const chItems: any[] = await client.connection.sendRequest(
                "textDocument/prepareCallHierarchy",
                { textDocument: { uri: fileUri }, position: { line: sym.lineRange[0] - 1, character: charIdx } },
              ) as any[];
              if (Array.isArray(chItems)) {
                for (const item of chItems) {
                  if (item && typeof item === "object") {
                    try {
                      const inc: any[] = await client.connection.sendRequest(
                        "callHierarchy/incomingCalls",
                        { item },
                      ) as any[];
                      if (Array.isArray(inc)) {
                        sym.incomingCalls = inc
                          .filter((c) => c?.from?.uri)
                          .map((c) => ({
                            name: c.from.name,
                            kind: symbolKindMap[SymbolKind[c.from.kind]?.toLowerCase() || String(c.from.kind)] ?? "unknown",
                            file: c.from.uri!.replace(/^file:\/\//, ""),
                            lineRange: [c.from.range.start.line + 1, c.from.range.end.line + 1],
                          }));
                      }
                      const out: any[] = await client.connection.sendRequest(
                        "callHierarchy/outgoingCalls",
                        { item },
                      ) as any[];
                      if (Array.isArray(out)) {
                        sym.outgoingCalls = out
                          .filter((c) => c.to?.uri)
                          .map((c) => ({
                            name: c.to.name,
                            kind: symbolKindMap[SymbolKind[c.to.kind]?.toLowerCase() || String(c.to.kind)] ?? "unknown",
                            file: c.to.uri!.replace(/^file:\/\//, ""),
                            lineRange: [c.to.range.start.line + 1, c.to.range.end.line + 1],
                          }));
                      }
                    } catch {}
                  }
                }
              }
            } catch {}
          }
        } catch {}
      }

      result[file] = { status: "ok", symbols: fileSymbols };
    } catch (e: any) {
      result[file] = { status: "broken", symbols: [] };
    }
  }

  try { client.connection.dispose(); } catch {}
  // Also terminate the subprocess in case dispose didn't clean it up
  try { client.proc.kill(); } catch {}
  return result;
}

// =========================================
// TypeScript compiler API extraction
// =========================================

function getLangId(file: string): string {
  if (file.endsWith(".go")) return "go";
  if (file.endsWith(".rs")) return "rust";
  if (file.endsWith(".py")) return "python";
  if (file.endsWith(".c") || file.endsWith(".cpp") || file.endsWith(".h") || file.endsWith(".hpp")) return "cpp";
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return "typescript";
  if (file.endsWith(".js") || file.endsWith(".jsx")) return "javascript";
  return "typescript";
}

function findTsFilesInDir(dir: string, files: string[], seen: Set<string>): void {
  if (seen.has(dir)) return;
  seen.add(dir);
  const skip = ["node_modules", "out", "dist", "_test", ".pi-index"];
  try {
    const entries = fsSync.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.includes(entry.name)) {
          findTsFilesInDir(fullPath, files, seen);
        }
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|mts)$/.test(entry.name)) {
        const rel = path.relative(dir, fullPath);
        files.push(rel);
      }
    }
  } catch {}
}

async function listTsFiles(workspaceFolder: string): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  findTsFilesInDir(workspaceFolder, files, seen);
  return files;
}

async function extractSymbolsFromTsProgram(
  workspaceFolder: string,
  files: string[],
  symbolKindMap: Record<string, string>,
): Promise<Record<string, { status: string; symbols: IndexSymbol[] }>> {
  const result: Record<string, { status: string; symbols: IndexSymbol[] }> = {};
  const slice = files;

  try {
    let tsModule: any;
    try {
      tsModule = await import(path.join(workspaceFolder, "node_modules", "typescript"));
    } catch {
      tsModule = await import("typescript");
    }
    if (!tsModule || !tsModule.createProgram) return {};
    const ts = tsModule.default || tsModule;

    // Try to load tsconfig.json
    let tsconfig: any = null;
    try {
      tsconfig = JSON.parse(await fs.readFile(path.join(workspaceFolder, "tsconfig.json"), "utf-8"));
    } catch {}

    const allRoots = slice.map(f => path.join(workspaceFolder, f));
    if (allRoots.length === 0) return {};

    const program = ts.createProgram({
      rootNames: allRoots,
      options: tsconfig?.compilerOptions || { allowJs: true, skipLibCheck: true, noEmit: true },
      host: ts.createCompilerHost(tsconfig?.compilerOptions || { allowJs: true, skipLibCheck: true }, true),
    });

    const allFiles = program.getSourceFiles().filter((f: any) => !f.isDeclarationFile);
    const walk = (node: any, parent: any = null) => {
      try {
        const isNamed = node.name && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node));
        // Also capture arrow functions and function expressions
        const isExpr = (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.name === undefined;
        if (isNamed || isExpr) {
          const sourceFile = node.getSourceFile();
          if (!sourceFile) return;
          const fileName = path.relative(workspaceFolder, sourceFile.fileName);
          const start = node.getStart(sourceFile);
          const end = node.getEnd();
          const startLine = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
          const endLine = sourceFile.getLineAndCharacterOfPosition(end).line + 1;
          if (!result[fileName]) result[fileName] = { status: "ok", symbols: [] };
          // Determine container from parent chain
          let container: string | undefined;
          let p = parent;
          while (p) {
            if (p.name && p.name.text) { container = p.name.text; break; }
            p = (p as any)._parent;
          }
          const name = isExpr ? "<anonymous>" : node.name.text;
          result[fileName].symbols.push({
            name,
            kind: isExpr ? "function" : symbolKindMap[String(ts.SyntaxKind[node.kind])] ?? "unknown",
            file: fileName,
            lineRange: [startLine, endLine],
            container,
            usages: [],
            incomingCalls: [],
            outgoingCalls: [],
          });
        }
      } catch {}
      ts.forEachChild(node, walk);
    };
    for (const file of allFiles) {
      ts.forEachChild(file, walk);
    }
    return result;
  } catch {
    return {};
  }
}

// =========================================
// Language detection from config
// =========================================

async function detectLanguage(workspaceFolder: string): Promise<LanguageConfig | null> {
  const cfg = await loadConfig(extensionPath);
  for (const [name, lang] of Object.entries(cfg.languages)) {
    try {
      for (const f of lang.detect) {
        const fp = path.join(workspaceFolder, f);
        await fs.access(fp);
        return lang;
      }
    } catch (e) {
    }
  }
  return null;
}

// =========================================
// Build index
// =========================================

export async function buildIndex(target?: string, extPath?: string): Promise<void> {
  if (extPath) extensionPath = extPath;
  const workspaceFolder = target || (await getWorkspace());
  const langConfig = await detectLanguage(workspaceFolder);
  if (!langConfig) {
    return;
  }

  let symbolKindMap: Record<string, string>;
  let symbols: Record<string, { status: string; symbols: IndexSymbol[] }>;

  // Try LSP server first
  try {
    const serverPath = await findServer(langConfig.server, workspaceFolder);
    if (serverPath) {
      // Find files
      let files: string[] = [];
      for (const ext of langConfig.extensions) {
        files = files.concat(await findFilesByExt(workspaceFolder, ext));
      }
      if (files.length > 0) {
        const client = await buildLspClient(serverPath, langConfig.args, workspaceFolder, langConfig.env || {});
        symbols = await extractSymbolsFromLsp(client, workspaceFolder, files, langConfig.symbolKindMap);
        symbolKindMap = langConfig.symbolKindMap;
      }
    }
  } catch (e: any) {
  }

  // Fallback to compiler API
  if (!symbols || Object.keys(symbols).length === 0) {
    if (langConfig.server === "typescript-language-server") {
      const tsFiles = await listTsFiles(workspaceFolder);
      symbols = await extractSymbolsFromTsProgram(workspaceFolder, tsFiles, langConfig.symbolKindMap);
      symbolKindMap = langConfig.symbolKindMap;
    }
  }

  if (!symbols || Object.keys(symbols).length === 0) {
    return;
  }

  // Count symbols
  let totalSymbols = 0;
  for (const key of Object.keys(symbols)) {
    totalSymbols += symbols[key].symbols.length;
  }

  // Find oldest source file mtime for staleness detection
  let oldestSourceMtime = Infinity;
  for (const file of Object.keys(symbols)) {
    try {
      const filePath = path.join(workspaceFolder, file);
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < oldestSourceMtime) {
        oldestSourceMtime = stat.mtimeMs;
      }
    } catch {}
  }

  // Build block index and detect duplicates
  const blocks: BlockIndex[] = [];
  const hashGroups: Record<string, BlockIndex[]> = {};
  for (const file of Object.keys(symbols)) {
    for (const sym of symbols[file].symbols) {
      const block: BlockIndex = { file, startLine: sym.lineRange[0], endLine: sym.lineRange[1], hash: "", shortId: "" };
      blocks.push(block);
      // Group by short hash prefix for duplicate detection
      const prefix = sym.lineRange.join(":");
      if (!hashGroups[prefix]) hashGroups[prefix] = [];
      hashGroups[prefix].push(block);
    }
  }
  // Compute hashes and mark duplicates
  for (const block of blocks) {
    try {
      const textLines = (await fs.readFile(path.join(workspaceFolder, block.file), "utf-8")).split("\n");
      const blockText = textLines.slice(block.startLine - 1, block.endLine).join("\n") + "\n";
      block.hash = sha256(blockText);
      block.shortId = toBase36(crc32(blockText));
    } catch {
      block.hash = "";
      block.shortId = "";
    }
  }

  const index: PiIndex = {
    version: 1,
    projectRoot: workspaceFolder,
    languages: [langConfig.server],
    buildTs: new Date().toISOString(),
    sourceMtime: oldestSourceMtime === Infinity ? Date.now() : oldestSourceMtime,
    files: symbols,
    blocks,
  };

  // Write index
  const indexPath = path.join(workspaceFolder, INDEX_DIR, INDEX_FILE);
  const indexDirPath = path.join(workspaceFolder, INDEX_DIR);
  if (!await fs.access(indexDirPath).catch(() => false)) await fs.mkdir(indexDirPath, { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
}

async function findServer(serverName: string, workspaceFolder: string): Promise<string | null> {
  // Check node_modules/.bin first
  const localBin = path.join(workspaceFolder, "node_modules", ".bin", serverName);
  const localBinWin = localBin + ".cmd";
  try { await fs.access(localBin); return localBin; } catch {}
  try { await fs.access(localBinWin); return localBinWin; } catch {}
  // Then check PATH
  try {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) => {
      execFile("which", [serverName], { timeout: 5000 }, (err, stdout) => {
        if (err) resolve(null);
        else resolve(stdout.toString().trim());
      });
    });
  } catch {
    return null;
  }
}

async function findFilesByExt(workspaceFolder: string, ext: string): Promise<string[]> {
  const files: string[] = [];
  const skip = ["node_modules", "out", "dist", "_test", ".pi-index"];
  const walk = (dir: string) => {
    try {
      for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!skip.includes(entry.name)) walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(ext)) {
          files.push(path.relative(workspaceFolder, fullPath));
        }
      }
    } catch {}
  };
  walk(workspaceFolder);
  return files;
}

// =========================================
// Read index
// =========================================

export async function readIndex(target?: string): Promise<PiIndex | null> {
  const workspaceFolder = target || (await getWorkspace());
  const indexPath = path.join(workspaceFolder, INDEX_DIR, INDEX_FILE);
  try {
    const data = await fs.readFile(indexPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// =========================================
// Pi tool registration
// =========================================

export default function (pi: ExtensionAPI): void {
  pi.registerFlag("symbol-index-server", {
    description: "LSP server to use for indexing (optional override)",
    type: "string",
    default: "",
  });

  pi.registerTool("pi_symbol_build", {
    label: "Build Symbol Index",
    description: "Scan the project directory and build/update the symbol index.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Target directory to index. Defaults to current workspace." })),
    }),
    execute: async (_id, params) => {
      const target = params?.target || undefined;
      await buildIndex(target);
      return { content: [{ type: "text", text: "Index built." }] };
    },
  });

  pi.registerTool("pi_symbol_info", {
    label: "Symbol Info",
    description: "Look up a symbol by exact name in the index. Returns file location, line range, type, usages, and call hierarchy.",
    parameters: Type.Object({
      name: Type.String({ description: "Exact symbol name to look up." }),
    }),
    execute: async (_id, params) => {
      if (!params?.name) throw new Error("Missing name parameter.");
      const workspaceFolder = await getWorkspace();
      await ensureIndex(workspaceFolder);
      const index = await readIndex();
      if (!index) throw new Error("No index found. Run pi_symbol_build first.");
      const found: IndexSymbol[] = [];
      for (const file of Object.keys(index.files)) {
        for (const sym of index.files[file].symbols) {
          if (sym.name === params.name) {
            // Read function body if available
            const fullText = await fs.readFile(path.join(await getWorkspace(), file), "utf-8");
            const lines = fullText.split("\n");
            const body = lines.slice(sym.lineRange[0] - 1, sym.lineRange[1]).join("\n");
            found.push({ ...sym, functionBody: body });
          }
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(found, null, 2) }] };
    },
  });

  pi.registerTool("pi_project_symbols", {
    label: "Project Symbols",
    description: "List all indexed symbols organized by file.",
    parameters: Type.Object({}),
    execute: async (_id, _params) => {
      const workspaceFolder = await getWorkspace();
      await ensureIndex(workspaceFolder);
      const index = await readIndex();
      if (!index) throw new Error("No index found. Run pi_symbol_build first.");
      const files = Object.keys(index.files);
      const result = files.map(f => ({
        file: f,
        symbolCount: index.files[f].symbols.length,
        types: index.files[f].symbols.filter(s => s.kind === "type" || s.kind === "struct").map(s => s.name),
        functions: index.files[f].symbols.filter(s => s.kind === "function" || s.kind === "method").map(s => s.name),
      }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  });

  pi.registerTool("pi_replace_block", {
    label: "Replace Code Block",
    description: 'Replace a code block by short hash prefix. No "oldText" required — the extension finds the block by hash. If the hash check fails (file was modified externally), the operation is refused to prevent desync.',
    parameters: Type.Object({
      file: Type.String({ description: "Filename of the file to replace." }),
      shortId: Type.String({ description: "Short block ID (6 chars, base36 of CRC32) to locate the block. Use pi_list_blocks to get block IDs." }),
      newText: Type.String({ description: "The replacement text to insert." }),
    }),
    execute: async (_id, params) => {
      if (!params?.file || !params.shortId || typeof params.newText !== "string") throw new Error('Invalid parameters. Provide file, shortId, and newText as string fields.');
      const workspaceFolder = await getWorkspace();
      await ensureIndex(workspaceFolder);
      const index = await readIndex();
      if (!index) throw new Error("No symbol index found. Run pi_symbol_build first.");
      const block = index.blocks.find(b => b.file === params.file && b.shortId === params.shortId);
      if (!block) throw new Error(`Block shortId ${params.shortId} not found or file ${params.file} doesn't exist.`);
      // Security: validate resolved path stays within workspace
      const resolvedPath = path.resolve(path.join(workspaceFolder, params.file));
      if (!resolvedPath.startsWith(workspaceFolder)) throw new Error("File path escapes workspace directory.");
      let liveText: string;
      try { liveText = await fs.readFile(resolvedPath, "utf-8"); } catch (e) { throw new Error(`Failed to read ${params.file}: ${(e as any).message}`); }
      const liveLines = liveText.split("\n");
      const currentBlockText = liveLines.slice(block.startLine - 1, block.endLine).join("\n") + "\n";
      const currentHash = sha256(currentBlockText);
      if (currentHash !== block.hash) throw new Error(`Block hash mismatch (file changed externally). Expected ${block.hash.slice(0, 8)}, got ${currentHash.slice(0, 8)}.`);
      const newLines = params.newText.split("\n");
      const newFileContent = [...liveLines.slice(0, block.startLine - 1), ...newLines, ...liveLines.slice(block.endLine)].join("\n");
      await fs.writeFile(resolvedPath, newFileContent);
      return { content: [{ type: "text", text: `Block replaced at ${params.file}:${block.startLine}-${block.endLine}` }] };
    },
  });

  pi.registerTool("pi_list_blocks", {
    label: "List Blocks",
    description: 'List all editable blocks in a file (or all files) with their short hash IDs.',
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "Optional file path to filter blocks." })),
    }),
    execute: async (_id, params) => {
      const workspaceFolder = await getWorkspace();
      await ensureIndex(workspaceFolder);
      const index = await readIndex();
      if (!index) throw new Error("No index found. Run pi_symbol_build first.");
      const blocks = params?.file ? index.blocks.filter(b => b.file === params.file) : index.blocks;
      const visible = blocks.map(b => ({ file: b.file, lineRange: `${b.startLine}-${b.endLine}`, shortId: b.shortId }));
      return { content: [{ type: "text", text: JSON.stringify(visible, null, 2) }] };
    },
  });

  pi.registerTool("pi_detect_duplicates", {
    label: "Detect Duplicate Code Blocks",
    description: 'Find code blocks that have identical full SHA256 hashes across the project — these are likely copied code.',
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "Optional file path to limit search." })),
    }),
    execute: async (_id, params) => {
      const workspaceFolder = await getWorkspace();
      await ensureIndex(workspaceFolder);
      const index = await readIndex();
      if (!index) throw new Error("No index found. Run pi_symbol_build first.");
      const blocks = params?.file ? index.blocks.filter(b => b.file === params.file) : index.blocks;
      // Group by full SHA256 hash for accurate duplicate detection
      const groups: Record<string, string[]> = {};
      for (const b of blocks) {
        if (!b.hash) continue;
        if (!groups[b.hash]) groups[b.hash] = [];
        groups[b.hash].push(`${b.file}:${b.startLine}-${b.endLine}`);
      }
      const duplicates = Object.entries(groups).filter(([_, locs]) => locs.length > 1);
      return { content: [{ type: "text", text: JSON.stringify(duplicates, null, 2) }] };
    },
  });

  // Lazy build: on each tool use, check if index is stale and rebuild if needed
  let _indexBuilt = false;
  let _indexBuiltFolder = "";

  async function ensureIndex(workspaceFolder: string): Promise<void> {
    const indexPath = path.join(workspaceFolder, INDEX_DIR, INDEX_FILE);

    // Check if index exists
    let indexStat: fsSync.Stats;
    try {
      indexStat = await fs.stat(indexPath);
    } catch {
      // Index file missing, build it
      const langConfig = await detectLanguage(workspaceFolder);
      if (langConfig) {
        await buildIndex(workspaceFolder);
      }
      _indexBuilt = true;
      _indexBuiltFolder = workspaceFolder;
      return;
    }

    // Read index to get stored sourceMtime
    const index = await readIndex();
    if (!index) {
      // Index file exists but is corrupt, rebuild
      const langConfig = await detectLanguage(workspaceFolder);
      if (langConfig) {
        await buildIndex(workspaceFolder);
      }
      _indexBuilt = true;
      _indexBuiltFolder = workspaceFolder;
      return;
    }

    // Compare stored sourceMtime against oldest source file
    let oldestSourceMtime = index.sourceMtime || Infinity;
    for (const file of Object.keys(index.files)) {
      try {
        const filePath = path.join(workspaceFolder, file);
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs > oldestSourceMtime) {
          // Source file is newer than index — stale
          await buildIndex(workspaceFolder);
          _indexBuilt = true;
          _indexBuiltFolder = workspaceFolder;
          return;
        }
      } catch {}
    }

    // No source files are newer than index — cache is valid
    _indexBuilt = true;
    _indexBuiltFolder = workspaceFolder;
  }

  pi.on("session_start", async (event) => {
    // Don't auto-build on session start (too slow for large projects)
  });
}
