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
  files: Record<string, { status: "ok" | "partial" | "broken"; symbols: IndexSymbol[] }>;
  blocks: BlockIndex[];
}

interface BlockIndex {
  file: string;
  startLine: number;
  endLine: number;
  hash: string;
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
  console.log(`[DEBUG] loadConfig called with extPath=${extPath}`);
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
  const { execSync } = await import("node:child_process");
  resolvedCwd = execSync("pwd").toString().trim();
  return resolvedCwd;
}

// =========================================
// SHA256 hashing
// =========================================

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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
  const slice = files.slice(0, 100);

  client.connection.listen();

  try {
    await client.connection.sendRequest("initialize", {
      processId: null,
      rootUri: `file://${workspaceFolder}`,
      capabilities: { textDocument: { documentSymbol: {}, references: {}, callHierarchy: {} }, workspace: { symbol: {} } },
    }) as any;
  } catch (e: any) {
    console.log(`[pi_symbol_index] initialize: ${e.message}`);
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
            console.log(`[DEBUG] extractSymbolsFromLsp: ${s.name} kind=${s.kind} (type=${typeof s.kind})`);
            console.log(`[DEBUG] extractSymbolsFromLsp: symbolKindMap keys=${JSON.stringify(Object.keys(symbolKindMap))}`);
            fileSymbols.push({
              name: s.name,
              kind: symbolKindMap[String(s.kind)] ?? "unknown",
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
                            kind: symbolKindMap[String(c.from.kind)] ?? "unknown",
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
                            kind: symbolKindMap[String(c.to.kind)] ?? "unknown",
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
      console.log(`[pi_symbol_index] Error processing ${file}: ${e.message}`);
      result[file] = { status: "broken", symbols: [] };
    }
  }

  try { client.connection.dispose(); } catch {}
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
  try {
    console.log(`[DEBUG] extractSymbolsFromTsProgram ENTRY`);
  } catch (e: any) {
    console.error(`[pi_symbol_index] extractSymbolsFromTsProgram outer error: ${e.message}`);
    return {};
  }
  const result: Record<string, { status: string; symbols: IndexSymbol[] }> = {};
  const slice = files.slice(0, 50);

  try {
    console.log(`[DEBUG] extractSymbolsFromTsProgram: workspace=${workspaceFolder}`);
    console.log(`[DEBUG] extractSymbolsFromTsProgram: files=${JSON.stringify(files)}`);
  } catch (e: any) {
    console.log(`[pi_symbol_index] TS program entry failed: ${e.message}`);
    return {};
  }

  try {
    console.log(`[DEBUG] TS: about to load module`);
    let tsModule: any;
    try {
      tsModule = await import(path.join(workspaceFolder, "node_modules", "typescript"));
      console.log(`[DEBUG] TS: loaded from workspace`);
    } catch (e: any) {
      console.log(`[DEBUG] TS: workspace failed: ${e.message}`);
      tsModule = await import("typescript");
      console.log(`[DEBUG] TS: loaded from global`);
    }
    if (!tsModule || !tsModule.createProgram) {
      console.log("[pi_symbol_index] TypeScript module not available");
      return {};
    }
    const ts = tsModule.default || tsModule;
    console.log(`[DEBUG] TS: createProgram ready`);
    // Use ALL files as roots
    const allRoots = slice.map(f => path.join(workspaceFolder, f));
    console.log(`[DEBUG] TS: roots=${JSON.stringify(allRoots)}`);
    if (allRoots.length === 0) return {};
    const program = ts.createProgram({
      rootNames: allRoots,
      options: { allowJs: true, skipLibCheck: true, noEmit: true },
      host: ts.createCompilerHost({ allowJs: true, skipLibCheck: true }, true),
    });
    console.log(`[DEBUG] TS: program created`);
    const sf = program.getSourceFile(allRoots[0]);
    console.log(`[DEBUG] TS: sf=${!!sf}`);
    if (!sf) return {};

    // Walk all source files
    const allFiles = program.getSourceFiles().filter((f: any) => !f.isDeclarationFile);
    let nodeCount = 0;
    const walk = (node: any) => {
      nodeCount++;
      try {
        if (node.name && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node))) {
          console.log(`[DEBUG] TS: found symbol ${node.name.text} kind=${node.kind}`);
          const fileName = node.getSourceFile() ? path.relative(workspaceFolder, node.getSourceFile().fileName) : "";
          const start = node.getStart(node.getSourceFile() || sf);
          const end = node.getEnd();
          const sourceFile = node.getSourceFile() || sf;
          const lines = sourceFile.text.split("\n");
          const startLine = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
          const endLine = sourceFile.getLineAndCharacterOfPosition(end).line + 1;
          if (!result[fileName]) {
            result[fileName] = { status: "ok", symbols: [] };
          }
          result[fileName].symbols.push({
            name: node.name.text,
            kind: symbolKindMap[String(ts.SyntaxKind[node.kind])] ?? "unknown",
            file: fileName,
            lineRange: [startLine, endLine],
            container: undefined,
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
    console.log(`[DEBUG] TS: after walk, ${Object.keys(result).length} files`);
    return result;
  } catch (e: any) {
    console.log(`[pi_symbol_index] TypeScript extraction failed: ${e.message}`);
    return {};
  }
}

// =========================================
// Language detection from config
// =========================================

async function detectLanguage(workspaceFolder: string): Promise<LanguageConfig | null> {
  console.log(`[DEBUG] detectLanguage: extPath=${extensionPath}, workspace=${workspaceFolder}`);
  const cfg = await loadConfig(extensionPath);
  console.log(`[DEBUG] detectLanguage: cfg.languages=${JSON.stringify(Object.keys(cfg.languages))}`);
  for (const [name, lang] of Object.entries(cfg.languages)) {
    console.log(`[DEBUG] detectLanguage: name=${name}, detect=[${lang.detect.join(', ')}]`);
    try {
      for (const f of lang.detect) {
        const fp = path.join(workspaceFolder, f);
        console.log(`[DEBUG] detectLanguage: trying access(${fp})`);
        await fs.access(fp);
        console.log(`[DEBUG] detectLanguage: FOUND ${name}`);
        return lang;
      }
    } catch (e) {
      console.log(`[DEBUG] detectLanguage: access failed for ${name}: ${e.message}`);
    }
  }
  console.log(`[DEBUG] detectLanguage: no language found, returning null`);
  return null;
}

// =========================================
// Build index
// =========================================

async function buildBlockIndex(index: PiIndex, workspaceFolder: string): Promise<void> {
  const blocks: BlockIndex[] = [];
  for (const file of Object.keys(index.files)) {
    for (const sym of index.files[file].symbols) {
      if (sym.lineRange[0] >= 1 && sym.lineRange[1] >= sym.lineRange[0]) {
        blocks.push({ file, startLine: sym.lineRange[0], endLine: sym.lineRange[1], hash: "" });
      }
    }
  }
  for (const block of blocks) {
    try {
      const textLines = (await fs.readFile(path.join(workspaceFolder, block.file), "utf-8")).split("\n");
      const blockText = textLines.slice(block.startLine - 1, block.endLine).join("\n") + "\n";
      block.hash = sha256(blockText);
      console.log(`[pi_replace_block] Built hash for ${block.file}:${block.startLine}-${block.endLine} = ${block.hash.slice(0, 16)}...`);
    } catch (e: any) {
      console.log(`[pi_replace_block] Failed to compute hash for ${block.file}:${block.startLine}-${block.endLine}: ${e.message}`);
      block.hash = "";
    }
  }
  index.blocks = blocks;
  console.log(`[pi_symbol_index] Found ${blocks.length} editable blocks`);
}

export async function buildIndex(target?: string, extPath?: string): Promise<void> {
  if (extPath) extensionPath = extPath;
  const workspaceFolder = target || (await getWorkspace());
  const langConfig = await detectLanguage(workspaceFolder);
  if (!langConfig) {
    console.log("[pi_symbol_index] No supported language detected");
    return;
  }

  let symbolKindMap: Record<string, string>;
  let symbols: Record<string, { status: string; symbols: IndexSymbol[] }>;

  // Try LSP server first
  try {
    console.log(`[DEBUG] buildIndex: server=${langConfig.server}`);
    const serverPath = await findServer(langConfig.server, workspaceFolder);
    console.log(`[DEBUG] buildIndex: serverPath=${serverPath}`);
    if (serverPath) {
      // Find files
      let files: string[] = [];
      for (const ext of langConfig.extensions) {
        files = files.concat(await findFilesByExt(workspaceFolder, ext));
      }
      console.log(`[DEBUG] buildIndex: files=[${files.join(', ')}]`);
      if (files.length > 0) {
        console.log(`[pi_symbol_index] Indexing for ${langConfig.server} in ${workspaceFolder}`);
        console.log(`[pi_symbol_index] Found ${files.length} files`);
        const client = await buildLspClient(serverPath, langConfig.args, workspaceFolder, langConfig.env || {});
        symbols = await extractSymbolsFromLsp(client, workspaceFolder, files, langConfig.symbolKindMap);
        symbolKindMap = langConfig.symbolKindMap;
      }
    }
  } catch (e: any) {
    console.log(`[pi_symbol_index] LSP failed: ${e.message}`);
  }

  // Fallback to compiler API
  console.log(`[DEBUG] buildIndex: symbols=${JSON.stringify(Object.keys(symbols || {}))}`);
  if (!symbols || Object.keys(symbols).length === 0) {
    console.log(`[DEBUG] buildIndex: entering fallback`);
    if (langConfig.server === "typescript-language-server") {
      console.log(`[DEBUG] buildIndex: falling back to TS compiler API`);
      const tsFiles = await listTsFiles(workspaceFolder);
      console.log(`[DEBUG] buildIndex: TS files=[${tsFiles.join(', ')}]`);
      symbols = await extractSymbolsFromTsProgram(workspaceFolder, tsFiles, langConfig.symbolKindMap);
      symbolKindMap = langConfig.symbolKindMap;
    }
  }

  if (!symbols || Object.keys(symbols).length === 0) {
    console.log("[pi_symbol_index] No symbols extracted");
    return;
  }

  // Count symbols
  let totalSymbols = 0;
  for (const key of Object.keys(symbols)) {
    totalSymbols += symbols[key].symbols.length;
  }
  console.log(`[pi_symbol_index] Indexed ${totalSymbols} symbols across ${Object.keys(symbols).length} files`);

  const index: PiIndex = {
    version: 1,
    projectRoot: workspaceFolder,
    languages: [langConfig.server],
    buildTs: new Date().toISOString(),
    files: symbols,
    blocks: [],
  };

  await buildBlockIndex(index, workspaceFolder);

  // Write index
  const indexPath = path.join(workspaceFolder, INDEX_DIR, INDEX_FILE);
  const indexDirPath = path.join(workspaceFolder, INDEX_DIR);
  if (!await fs.access(indexDirPath).catch(() => false)) await fs.mkdir(indexDirPath, { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  console.log(`[pi_symbol_index] Wrote ${INDEX_DIR}/${INDEX_FILE}`);
}

async function findServer(serverName: string, workspaceFolder: string): Promise<string | null> {
  // Check node_modules/.bin first
  const localBin = path.join(workspaceFolder, "node_modules", ".bin", serverName);
  const localBinWin = localBin + ".cmd";
  try { await fs.access(localBin); return localBin; } catch {}
  try { await fs.access(localBinWin); return localBinWin; } catch {}
  // Then check PATH
  try {
    const { exec } = await import("node:child_process");
    return new Promise((resolve) => {
      exec(`which ${serverName}`, { timeout: 5000 }, (err, stdout) => {
        if (err) resolve(null);
        else resolve(stdout.trim());
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
    description: "Search for a symbol by name in the index.",
    parameters: Type.Object({
      name: Type.String({ description: "Symbol name to search for." }),
    }),
    execute: async (_id, params) => {
      if (!params?.name) throw new Error("Missing name parameter.");
      const index = await readIndex();
      if (!index) throw new Error("No index found. Run pi_symbol_build first.");
      const found: IndexSymbol[] = [];
      for (const file of Object.keys(index.files)) {
        for (const sym of index.files[file].symbols) {
          if (sym.name.toLowerCase().includes(params.name.toLowerCase())) {
            found.push({ ...sym, usages: [], incomingCalls: [], outgoingCalls: [] });
          }
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(found, null, 2) }] };
    },
  });

  pi.registerTool("pi_project_symbols", {
    label: "Project Symbols",
    description: "List all symbols in the index.",
    parameters: Type.Object({}),
    execute: async (_id, _params) => {
      const index = await readIndex();
      if (!index) throw new Error("No index found. Run pi_symbol_build first.");
      const files = Object.keys(index.files);
      const totalSymbols = files.reduce((sum, f) => sum + index.files[f].symbols.length, 0);
      return { content: [{ type: "text", text: `${files.length} files, ${totalSymbols} symbols` }] };
    },
  });

  pi.registerTool("pi_replace_block", {
    label: "Replace Code Block",
    description: 'Replace a code block by hash. No "oldText" required — the extension finds the block by hash. If the hash check fails (file was modified externally), the operation is refused to prevent desync.',
    parameters: Type.Object({
      file: Type.String({ description: "Filename of the file to replace." }),
      hash: Type.String({ description: "SHA256 block hash to locate the block." }),
      newText: Type.String({ description: "The replacement text to insert." }),
    }),
    execute: async (_id, params) => {
      if (!params?.file || !params.hash || typeof params.newText !== "string") throw new Error('Invalid parameters. Provide file, hash, and newText as string fields.');
      const index = await readIndex();
      if (!index) throw new Error("No symbol index found. Run pi_symbol_build first.");
      const block = index.blocks.find(b => b.file === params.file && b.hash === params.hash);
      if (!block) throw new Error(`Block hash ${params.hash} not found or file ${params.file} doesn't exist.`);
      let liveText: string;
      try { liveText = await fs.readFile(path.join(await getWorkspace(), params.file), "utf-8"); } catch (e) { throw new Error(`Failed to read ${params.file}: ${(e as any).message}`); }
      const liveLines = liveText.split("\n");
      const currentBlockText = liveLines.slice(block.startLine - 1, block.endLine).join("\n") + "\n";
      const currentHash = sha256(currentBlockText);
      if (currentHash !== params.hash) throw new Error(`Block hash mismatch (file changed externally). Expected ${params.hash}, got ${currentHash}.`);
      const newLines = params.newText.split("\n");
      const newFileContent = [...liveLines.slice(0, block.startLine - 1), ...newLines, ...liveLines.slice(block.endLine)].join("\n");
      await fs.writeFile(path.join(await getWorkspace(), params.file), newFileContent);
      console.log(`[pi_replace_block] Replaced block ${params.hash} in ${params.file}`);
      return { content: [{ type: "text", text: `Block replaced at ${params.file}:${block.startLine}-${block.endLine}` }] };
    },
  });

  pi.registerTool("pi_list_blocks", {
    label: "List Blocks",
    description: 'List all editable blocks in a file (or all files) with their hashes.',
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "Optional file path to filter blocks." })),
    }),
    execute: async (_id, params) => {
      const index = await readIndex();
      if (!index) throw new Error("No index found. Run pi_symbol_build first.");
      const blocks = params?.file ? index.blocks.filter(b => b.file === params.file) : index.blocks;
      return { content: [{ type: "text", text: JSON.stringify(blocks, null, 2) }] };
    },
  });

  pi.on("session_start", async (event) => {
    const ctx = event as any;
    const workspaceFolder = ctx.cwd || "";
    if (workspaceFolder) {
      const langConfig = await detectLanguage(workspaceFolder);
      if (langConfig) {
        console.log(`[pi_symbol_index] Auto-building index for ${langConfig.server} in ${workspaceFolder}`);
        await buildIndex(workspaceFolder);
      }
    }
  });
}
