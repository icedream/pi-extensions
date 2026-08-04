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
  buildMtimes: Record<string, number>; // per-file mtime at build time
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

interface RebuildHooks {
  onStart?: () => void;
  onDone?: (stats: { files: number; symbols: number }) => void;
  onPartialStart?: () => void;
  onPartialDone?: (stats: { files: number; symbols: number }) => void;
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

// Per-file LSP extraction
async function extractSymbolsFromLspForFile(
  client: LspClient,
  workspaceFolder: string,
  filePath: string,
  symbolKindMap: Record<string, string>,
): Promise<IndexSymbol[]> {
  const fullFilePath = path.join(workspaceFolder, filePath);
  const fileUri = `file://${fullFilePath}`;
  try {
    const text = await fs.readFile(fullFilePath, "utf-8");
    client.connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri: fileUri, languageId: getLangId(filePath), version: 1, text },
    });

    const symbols: any = await client.connection.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri: fileUri },
    });

    const result: IndexSymbol[] = [];
    if (Array.isArray(symbols)) {
      for (const s of symbols) {
        const loc = s.location || s;
        const range = loc.range || loc;
        if (range.start?.line != null) {
          const kindKey = Object.keys(SymbolKind).find(k => SymbolKind[k] === s.kind) || String(s.kind);
          result.push({
            name: s.name,
            kind: symbolKindMap[kindKey.toLowerCase()] ?? symbolKindMap[kindKey] ?? "unknown",
            file: filePath,
            lineRange: [range.start.line + 1, range.end.line + 1],
            container: s.containerName || undefined,
            usages: [],
            incomingCalls: [],
            outgoingCalls: [],
          });
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}

// =========================================
// Per-file TypeScript extraction (no tree walk)
// =========================================

async function extractSymbolsFromTsFile(workspaceFolder: string, filePath: string, symbolKindMap: Record<string, string>): Promise<IndexSymbol[]> {
  const fullFilePath = path.join(workspaceFolder, filePath);
  try {
    const text = await fs.readFile(fullFilePath, "utf-8");
  } catch {
    return [];
  }

  let tsModule: any;
  try {
    tsModule = await import(path.join(workspaceFolder, "node_modules", "typescript"));
  } catch {
    tsModule = await import("typescript");
  }
  if (!tsModule || !tsModule.createProgram) return [];
  const ts = tsModule.default || tsModule;

  const program = ts.createProgram({
    rootNames: [fullFilePath],
    options: { allowJs: true, skipLibCheck: true, noEmit: true },
    host: ts.createCompilerHost({ allowJs: true, skipLibCheck: true }, true),
  });

  const sf = program.getSourceFile(fullFilePath);
  if (!sf) return [];

  const symbols: IndexSymbol[] = [];
  const walk = (node: any) => {
    try {
      if (!node || !node.getStart) return;
      const isNamed = node.name && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node));
      const isExpr = (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.name === undefined;
      if (isNamed || isExpr) {
        const start = node.getStart(sf);
        const end = node.getEnd();
        const startLine = sf.getLineAndCharacterOfPosition(start).line + 1;
        const endLine = sf.getLineAndCharacterOfPosition(end).line + 1;
        let kind = "unknown";
        if (ts.isFunctionDeclaration(node)) kind = "function";
        else if (ts.isMethodDeclaration(node)) kind = "method";
        else if (ts.isClassDeclaration(node)) kind = "class";
        else if (ts.isInterfaceDeclaration(node)) kind = "interface";
        else if (ts.isTypeAliasDeclaration(node)) kind = "type";
        else if (ts.isEnumDeclaration(node)) kind = "enum";
        else if (isExpr) kind = "function";
        const name = node.name?.text || "<anonymous>";
        symbols.push({ name, kind, file: filePath, lineRange: [startLine, endLine], container: undefined, usages: [], incomingCalls: [], outgoingCalls: [] });
      }
    } catch {}
    try { for (const child of node.getChildren()) walk(child); } catch {}
  };

  walk(sf);
  return symbols;
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
  const skip = ["node_modules", "out", "dist", "_test", ".pi-index", ".git"];
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

// Per-directory config detection — find configs in subdirectories and extract symbols
interface DirConfig {
  dir: string;
  config: LanguageConfig;
  files: string[];
}

async function findDirConfigs(workspaceFolder: string, langConfig: LanguageConfig): Promise<DirConfig[]> {
  const results: DirConfig[] = [];
  const skip = ["node_modules", "out", "dist", "_test", ".pi-index", ".git"];
  const walk = (dir: string) => {
    try {
      const entries = fsSync.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (skip.includes(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Check for config file in this directory
          for (const f of langConfig.detect) {
            try {
              fsSync.accessSync(path.join(fullPath, f));
              // Found config — collect files in this directory
              const files: string[] = [];
              const collectFiles = (d: string) => {
                try {
                  const subEntries = fsSync.readdirSync(d, { withFileTypes: true });
                  for (const se of subEntries) {
                    if (se.isFile() && langConfig.extensions.some(ext => se.name.endsWith(ext))) {
                      files.push(path.relative(workspaceFolder, path.join(d, se.name)));
                    }
                  }
                } catch {}
              };
              collectFiles(fullPath);
              results.push({ dir: fullPath, config: langConfig, files });
              break;
            } catch {}
          }
          walk(fullPath);
        }
      }
    } catch {}
  };
  walk(workspaceFolder);
  return results;
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

export async function buildIndex(target?: string, extPath?: string, hooks?: RebuildHooks): Promise<void> {
  if (extPath) extensionPath = extPath;
  hooks?.onStart?.();
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

  // Fallback to compiler API for TS
  if (!symbols || Object.keys(symbols).length === 0) {
    if (langConfig.server === "typescript-language-server") {
      const tsFiles: string[] = [];
      const seenSet = new Set<string>();
      findTsFilesInDir(workspaceFolder, tsFiles, seenSet);
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

  // Report rebuild stats
  hooks?.onDone?.({ files: Object.keys(symbols).length, symbols: totalSymbols });

  // Capture per-file mtimes for incremental staleness detection
  const buildMtimes: Record<string, number> = {};
  for (const file of Object.keys(symbols)) {
    try {
      const filePath = path.join(workspaceFolder, file);
      const stat = await fs.stat(filePath);
      buildMtimes[file] = stat.mtimeMs;
    } catch {}
  }

  const index: PiIndex = {
    version: 1,
    projectRoot: workspaceFolder,
    languages: [langConfig.server],
    buildTs: new Date().toISOString(),
    buildMtimes,
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

  pi.registerTool({
    name: "symbol_index_build",
    label: "Build Symbol Index",
    description: "Scan the project directory and build/update the symbol index.",
    parameters: Type.Object({
      target: Type.Optional(Type.String({ description: "Target directory to index. Defaults to current workspace." })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const target = params?.target || undefined;
      const hooks: RebuildHooks = {
        onStart: () => ctx.ui.setStatus("symbol-index", "Rebuilding symbol index..."),
        onDone: (stats) => {
          ctx.ui.setStatus("symbol-index", undefined);
          ctx.ui.notify(`Symbol index rebuilt: ${stats.symbols} symbols in ${stats.files} files`, "info");
        },
      };
      await buildIndex(target, undefined, hooks);
      return { content: [{ type: "text", text: "Index built." }] };
    },
  });

  pi.registerTool({
    name: "symbol_index_info",
    label: "Symbol Info",
    description: "Look up a symbol by exact name in the index. Returns file location, line range, type, usages, and call hierarchy.\n\nBefore using this tool, call symbol_index_build first to ensure the index is up-to-date. If you're working with a specific file that isn't indexed yet, pass its path as the 'file' parameter to extract it on-demand.",
    promptGuidelines: [
      "Always run symbol_index_build first before using symbol_index_info, symbol_index_replace_block, or symbol_index_list_blocks.",
      "Use symbol_index_info to look up a symbol's location before editing it.",
      "If the index is stale or a file isn't indexed, pass the file path to symbol_index_info to extract it on-demand.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Exact symbol name to look up." }),
      file: Type.Optional(Type.String({ description: "Optional file path to extract symbols for on-demand." })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      if (!params?.name) throw new Error("Missing name parameter.");
      const workspaceFolder = await getWorkspace();
      const hooks: RebuildHooks = {
        onStart: () => ctx.ui.setStatus("symbol-index", "Rebuilding symbol index..."),
        onDone: (stats) => {
          ctx.ui.setStatus("symbol-index", undefined);
          ctx.ui.notify(`Symbol index rebuilt: ${stats.symbols} symbols in ${stats.files} files`, "info");
        },
      };
      if (params.file) {
        await ensureIndex(workspaceFolder, hooks, params.file);
      } else {
        await ensureIndex(workspaceFolder, hooks);
      }
      const index = await readIndex();
      if (!index) throw new Error("No index found. Run symbol_index_build first.");
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

  pi.registerTool({
    name: "symbol_index_symbols",
    label: "Project Symbols",
    description: "List all indexed symbols organized by file.",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      const workspaceFolder = await getWorkspace();
      const hooks: RebuildHooks = {
        onStart: () => ctx.ui.setStatus("symbol-index", "Rebuilding symbol index..."),
        onDone: (stats) => {
          ctx.ui.setStatus("symbol-index", undefined);
          ctx.ui.notify(`Symbol index rebuilt: ${stats.symbols} symbols in ${stats.files} files`, "info");
        },
      };
      await ensureIndex(workspaceFolder, hooks);
      const index = await readIndex();
      if (!index) throw new Error("No index found. Run symbol_index_build first.");
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

  pi.registerTool({
    name: "symbol_index_replace_block",
    label: "Replace Code Block",
    description: 'Replace a code block by short hash prefix. No "oldText" required — the extension finds the block by hash. If the hash check fails (file was modified externally), the operation is refused to prevent desync.\n\nBefore using this tool, call symbol_index_build first to ensure the block hashes are in the index.',
    promptGuidelines: [
      "Always run symbol_index_build first before using symbol_index_replace_block.",
      "Use symbol_index_list_blocks to find the shortId of a block you want to replace.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "Filename of the file to replace." }),
      shortId: Type.String({ description: "Short block ID (6 chars, base36 of CRC32) to locate the block. Use symbol_index_list_blocks to get block IDs." }),
      newText: Type.String({ description: "The replacement text to insert." }),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      if (!params?.file || !params.shortId || typeof params.newText !== "string") throw new Error('Invalid parameters. Provide file, shortId, and newText as string fields.');
      const workspaceFolder = await getWorkspace();
      const hooks: RebuildHooks = {
        onStart: () => ctx.ui.setStatus("symbol-index", "Rebuilding symbol index..."),
        onDone: (stats) => {
          ctx.ui.setStatus("symbol-index", undefined);
          ctx.ui.notify(`Symbol index rebuilt: ${stats.symbols} symbols in ${stats.files} files`, "info");
        },
      };
      await ensureIndex(workspaceFolder, hooks);
      const index = await readIndex();
      if (!index) throw new Error("No symbol index found. Run symbol_index_build first.");
      const block = index.blocks.find(b => b.file === params.file && b.shortId === params.shortId);
      if (!block) throw new Error(`Block shortId ${params.shortId} not found or file ${params.file} doesn't exist.`);
      // Security: validate resolved path stays within workspace
      const resolvedPath = path.resolve(path.join(workspaceFolder, params.file));
      if (!resolvedPath.startsWith(workspaceFolder + path.sep)) throw new Error("File path escapes workspace directory.");
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

  pi.registerTool({
    name: "symbol_index_list_blocks",
    label: "List Blocks",
    description: 'List all editable blocks in a file (or all files) with their short hash IDs.\n\nBefore using this tool, call symbol_index_build first.',
    promptGuidelines: [
      "Always run symbol_index_build first before using symbol_index_list_blocks.",
    ],
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "Optional file path to filter blocks." })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const workspaceFolder = await getWorkspace();
      const hooks: RebuildHooks = {
        onStart: () => ctx.ui.setStatus("symbol-index", "Rebuilding symbol index..."),
        onDone: (stats) => {
          ctx.ui.setStatus("symbol-index", undefined);
          ctx.ui.notify(`Symbol index rebuilt: ${stats.symbols} symbols in ${stats.files} files`, "info");
        },
      };
      await ensureIndex(workspaceFolder, hooks);
      const index = await readIndex();
      if (!index) throw new Error("No index found. Run symbol_index_build first.");
      const blocks = params?.file ? index.blocks.filter(b => b.file === params.file) : index.blocks;
      const visible = blocks.map(b => ({ file: b.file, lineRange: `${b.startLine}-${b.endLine}`, shortId: b.shortId }));
      return { content: [{ type: "text", text: JSON.stringify(visible, null, 2) }] };
    },
  });

  pi.registerTool({
    name: "symbol_index_detect_duplicates",
    label: "Detect Duplicate Code Blocks",
    description: 'Find code blocks that have identical full SHA256 hashes across the project — these are likely copied code.\n\nBefore using this tool, call symbol_index_build first.',
    promptGuidelines: [
      "Always run symbol_index_build first before using symbol_index_detect_duplicates.",
    ],
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "Optional file path to limit search." })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const workspaceFolder = await getWorkspace();
      const hooks: RebuildHooks = {
        onStart: () => ctx.ui.setStatus("symbol-index", "Rebuilding symbol index..."),
        onDone: (stats) => {
          ctx.ui.setStatus("symbol-index", undefined);
          ctx.ui.notify(`Symbol index rebuilt: ${stats.symbols} symbols in ${stats.files} files`, "info");
        },
      };
      await ensureIndex(workspaceFolder, hooks);
      const index = await readIndex();
      if (!index) throw new Error("No index found. Run symbol_index_build first.");
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

  async function ensureIndex(workspaceFolder: string, hooks?: RebuildHooks, targetFile?: string): Promise<void> {
    const indexPath = path.join(workspaceFolder, INDEX_DIR, INDEX_FILE);

    // If a specific file is targeted, extract its symbols on-demand
    if (targetFile) {
      const index = await readIndex(workspaceFolder);
      if (index?.files[targetFile]) {
        // Check staleness
        const storedMtime = index.buildMtimes?.[targetFile];
        if (storedMtime) {
          try {
            const stat = await fs.stat(path.join(workspaceFolder, targetFile));
            if (stat.mtimeMs <= storedMtime) {
              _indexBuilt = true;
              _indexBuiltFolder = workspaceFolder;
              return; // Up to date
            }
          } catch {}
        }
      }
      // Extract symbols for this file
      const langConfig = await detectLanguage(workspaceFolder);
      if (langConfig) {
        hooks?.onStart?.();
        if (langConfig.server === "typescript-language-server") {
          const symbols = await extractSymbolsFromTsFile(workspaceFolder, targetFile, langConfig.symbolKindMap);
          if (!index) {
            await buildIndex(workspaceFolder, undefined, hooks);
          }
          const updatedIndex = await readIndex(workspaceFolder);
          if (updatedIndex) {
            updatedIndex.files[targetFile] = { status: symbols.length > 0 ? "ok" : "broken", symbols };
            // Update mtime
            try {
              const stat = await fs.stat(path.join(workspaceFolder, targetFile));
              updatedIndex.buildMtimes[targetFile] = stat.mtimeMs;
            } catch {}
            await fs.writeFile(indexPath, JSON.stringify(updatedIndex, null, 2));
          }
          hooks?.onDone?.({ files: Object.keys(updatedIndex?.files || {}).length, symbols: updatedIndex?.blocks?.length || 0 });
        } else {
          const serverPath = await findServer(langConfig.server, workspaceFolder);
          if (serverPath) {
            const client = await buildLspClient(serverPath, langConfig.args, workspaceFolder, langConfig.env || {});
            const symbols = await extractSymbolsFromLspForFile(client, workspaceFolder, targetFile, langConfig.symbolKindMap);
            if (!index) {
              await buildIndex(workspaceFolder, undefined, hooks);
            }
            const updatedIndex = await readIndex(workspaceFolder);
            if (updatedIndex) {
              updatedIndex.files[targetFile] = { status: symbols.length > 0 ? "ok" : "broken", symbols };
              try {
                const stat = await fs.stat(path.join(workspaceFolder, targetFile));
                updatedIndex.buildMtimes[targetFile] = stat.mtimeMs;
              } catch {}
              await fs.writeFile(indexPath, JSON.stringify(updatedIndex, null, 2));
            }
            hooks?.onDone?.({ files: Object.keys(updatedIndex?.files || {}).length, symbols: updatedIndex?.blocks?.length || 0 });
          } else {
            hooks?.onDone?.({ files: 0, symbols: 0 });
          }
        }
      }
      _indexBuilt = true;
      _indexBuiltFolder = workspaceFolder;
      return;
    }

    // Check if index exists
    let indexStat: fsSync.Stats;
    try {
      indexStat = await fs.stat(indexPath);
    } catch {
      // Index file missing, build it
      const langConfig = await detectLanguage(workspaceFolder);
      if (langConfig) {
        await buildIndex(workspaceFolder, undefined, hooks);
      }
      _indexBuilt = true;
      _indexBuiltFolder = workspaceFolder;
      return;
    }

    // Read index to check staleness
    const index = await readIndex(workspaceFolder);
    if (!index) {
      // Index file exists but is corrupt, rebuild
      const langConfig = await detectLanguage(workspaceFolder);
      if (langConfig) {
        await buildIndex(workspaceFolder, undefined, hooks);
      }
      _indexBuilt = true;
      _indexBuiltFolder = workspaceFolder;
      return;
    }

    // Compare per-file mtime against stored buildMtimes
    const buildMtimes = index.buildMtimes || {};
    const changedFiles: string[] = [];

    for (const [file, storedMtime] of Object.entries(buildMtimes)) {
      const filePath = path.join(workspaceFolder, file);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs > storedMtime) {
          changedFiles.push(file);
        }
      } catch {
        // File deleted — stale entry
        changedFiles.push(file);
      }
    }

    // Detect new files (not in buildMtimes)
    const langConfig = await detectLanguage(workspaceFolder);
    if (langConfig) {
      for (const ext of langConfig.extensions) {
        const files = await findFilesByExt(workspaceFolder, ext);
        for (const file of files) {
          if (!buildMtimes[file]) {
            changedFiles.push(file);
          }
        }
      }
    }

    if (changedFiles.length === 0) {
      // No changes — cache is valid
      _indexBuilt = true;
      _indexBuiltFolder = workspaceFolder;
      return;
    }

    // Rebuild only changed files
    if (changedFiles.length === Object.keys(buildMtimes).length && changedFiles.length > 5) {
      // Most files changed — full rebuild is more efficient
      await buildIndex(workspaceFolder, undefined, hooks);
    } else {
      // Partial rebuild — only re-extract symbols for changed files
      await partialRebuild(workspaceFolder, langConfig, changedFiles, hooks);
    }

    _indexBuilt = true;
    _indexBuiltFolder = workspaceFolder;
  }

  async function partialRebuild(
    workspaceFolder: string,
    langConfig: LanguageConfig,
    changedFiles: string[],
    hooks?: RebuildHooks,
  ): Promise<void> {
    hooks?.onPartialStart?.();
    const index = await readIndex();
    if (!index) return;

    // Re-extract symbols for changed files
    let partialResult: Record<string, { status: string; symbols: IndexSymbol[] }> = {};

    if (langConfig.server === "typescript-language-server") {
      partialResult = await extractSymbolsFromTsProgram(workspaceFolder, changedFiles, langConfig.symbolKindMap);
    } else {
      const serverPath = await findServer(langConfig.server, workspaceFolder);
      if (serverPath) {
        const client = await buildLspClient(serverPath, langConfig.args, workspaceFolder, langConfig.env || {});
        partialResult = await extractSymbolsFromLsp(client, workspaceFolder, changedFiles, langConfig.symbolKindMap);
      }
    }

    // Merge new/updated symbols into index
    for (const [file, data] of Object.entries(partialResult)) {
      index.files[file] = data;
    }

    // Remove files that were tracked but no longer exist on disk
    // (not files that were not in the changed set — those are unchanged)
    for (const file of changedFiles) {
      const filePath = path.join(workspaceFolder, file);
      try {
        await fs.stat(filePath);
      } catch {
        // File deleted — remove from index
        delete index.files[file];
        delete index.buildMtimes[file];
      }
    }

    // Rebuild blocks index
    const blocks: BlockIndex[] = [];
    for (const file of Object.keys(index.files)) {
      for (const sym of index.files[file].symbols) {
        const block: BlockIndex = { file, startLine: sym.lineRange[0], endLine: sym.lineRange[1], hash: "", shortId: "" };
        blocks.push(block);
      }
    }
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
    index.blocks = blocks;

    // Update buildMtimes
    for (const file of Object.keys(index.files)) {
      try {
        const filePath = path.join(workspaceFolder, file);
        const stat = await fs.stat(filePath);
        index.buildMtimes[file] = stat.mtimeMs;
      } catch {
        delete index.buildMtimes[file];
      }
    }

    // Write updated index
    const indexPath = path.join(workspaceFolder, INDEX_DIR, INDEX_FILE);
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

    // Report partial rebuild stats
    hooks?.onPartialDone?.({ files: Object.keys(index.files).length, symbols: index.blocks.length });
  }

  // Custom command: /symbol-index
  pi.registerCommand("symbol-index", {
    description: "Show what's in the symbol index (files, symbols, kinds, build time)",
    handler: async (_args, ctx) => {
      const workspaceFolder = await getWorkspace();
      const index = await readIndex(workspaceFolder);
      if (!index) {
        ctx.ui.notify("No symbol index found. Run symbol_index_build first.", "warning");
        return;
      }

      const files = Object.keys(index.files);
      const totalSymbols = files.reduce((sum, f) => sum + index.files[f].symbols.length, 0);
      const kinds = new Map<string, number>();
      for (const f of files) {
        for (const s of index.files[f].symbols) {
          kinds.set(s.kind, (kinds.get(s.kind) || 0) + 1);
        }
      }
      const kindSummary = Array.from(kinds.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k, c]) => `${c} ${k}`)
        .join(", ");

      const buildAge = Math.round((Date.now() - new Date(index.buildTs).getTime()) / 60000);
      const ageStr = buildAge < 1 ? "just now" : `${buildAge}m ago`;
      const summary = `Symbol index: ${totalSymbols} symbols across ${files.length} files (${kindSummary}). Built ${ageStr}.`;

      // Show in TUI popup if available
      if (ctx.hasUI) {
        const fileOptions = files.map(f => `${index.files[f].symbols.length} × ${path.basename(f)} (${f})`);
        await ctx.ui.select("Symbol Index", fileOptions);
      } else {
        ctx.ui.notify(summary, "info");
      }
    },
  });

  pi.on("session_start", async (event) => {
    // Don't auto-build on session start (too slow for large projects)
  });
}
