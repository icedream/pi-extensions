// Pi Symbol Index Extension — Phase 1: gopls + pi_symbol_info
//
// Spawns gopls via LSP over stdio, builds a structured symbol index,
// and exposes tools for querying it.
//
// Built-in flow:
//   - session_start: try to auto-build the index for the current project
//   - pi_symbol_info(symbol): return symbol info
//   - pi_project_symbols(): return project symbol inventory
//   - pi_symbol_build(): explicit build (also a tool)

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

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
  outgoingCalls: string[];
  incomingCalls: string[];
}

interface FileIndex {
  status: "ok" | "partial" | "broken";
  symbols: IndexSymbol[];
}

interface PiIndex {
  version: number;
  projectRoot: string;
  languages: string[];
  buildTs: string;
  files: Record<string, FileIndex>;
}

const INDEX_DIR = ".pi-index";
const INDEX_FILE = "symbols.json";

// =========================================
// LSP Helpers (JSON-RPC over stdio)
// =========================================

interface LSPStream {
  child: any;
  pending: Map<
    number | string,
    { resolve: (r: any) => void; reject: (e: any) => void }
  >;
  nextId: number;
  running: boolean;
  // Buffer for partial reads
  _buf: Buffer;
}

interface LSPMessage {
  jsonrpc: "2.0";
  id?: number | string;
  result?: any;
  error?: { code: number; message: string };
  method?: string;
  params?: any;
}

const HEADER_RE = /^Content-Length: (\d+)\r\n\r\n/;

function sendRequest(stream: LSPStream, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++stream.nextId;
    const msg: LSPMessage = { jsonrpc: "2.0", id, method, params };
    stream.pending.set(id, { resolve, reject });
    const payload = bufJSON(msg);
    const header = `Content-Length: ${payload.length}\r\n\r\n`;
    stream.child.stdin.write(header, "utf8", (e: Error | undefined) => {
      if (e) {
        stream.pending.delete(id);
        reject(e);
        return;
      }
      stream.child.stdin.write(payload);
    });
  });
}

function sendNotification(stream: LSPStream, method: string, params: any): void {
  const msg: LSPMessage = { jsonrpc: "2.0", method, params };
  const payload = bufJSON(msg);
  const header = `Content-Length: ${payload.length}\r\n\r\n`;
  stream.child.stdin.write(header + payload, "utf8");
}

function bufJSON(obj: any): string {
  return JSON.stringify(obj);
}

function startGopls(): LSPStream {
  const stream: LSPStream = {
    child: null,
    pending: new Map(),
    nextId: 0,
    running: false,
    _buf: Buffer.alloc(0),
  };

  const child = spawn("gopls", ["serve", "-mode=none"]);
  stream.child = child;
  stream.running = true;

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line: string) => {
    if (HEADER_RE.test(line)) {
      const m = HEADER_RE.exec(line)!;
      const len = parseInt(m[1], 10);
      let full = line.replace(HEADER_RE, "");
      while (full.length < len) {
        // Will fill in the next chunk
      }
      // In streaming mode, we need to accumulate lines until full payload
    }
  });

  let buf = Buffer.alloc(0);

  child.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    handleBuffer(stream, buf);
  });

  child.stderr!.on("data", (chunk: Buffer) => {
    console.error(`[gopls stderr] ${chunk.toString().trim()}`);
  });

  child.on("close", (code: number) => {
    stream.running = false;
    console.log(`[pi-symbol-index] gopls exited: ${code}`);
  });

  return stream;
}

// Parse LSP data stream into messages
function handleBuffer(stream: LSPStream, buf: Buffer): void {
  // The LSP data stream has Content-Length: N\r\n\r\n followed by N bytes
  // We need to parse this repeatedly.
  const content = buf.toString("utf8");
  while (true) {
    const m = HEADER_RE.exec(content);
    if (!m) break;
    const headerLen = m[0].length;
    const headerEnd = content.indexOf("\r\n\r\n", content.indexOf(m[0]));
    const payloadStart = headerEnd + 4; // after \r\n\r\n
    const len = parseInt(m[1], 10);
    const payloadEnd = payloadStart + len;
    if (payloadEnd > content.length) break; // incomplete message
    const payload = content.slice(payloadStart, payloadEnd);
    buf = Buffer.from(content.slice(payloadEnd));
    
    // Found a complete message
    try {
      const msg = JSON.parse(payload) as LSPMessage;
      if (msg.id !== undefined) {
        const key = typeof msg.id === "string" ? msg.id : msg.id as number;
        const p = stream.pending.get(key);
        if (p) {
          stream.pending.delete(key);
          if (msg.error) {
            p.reject(new Error(msg.error.message));
          } else {
            p.resolve(msg.result);
          }
        }
      }
    } catch (e: any) {
      console.error(`[pi-symbol-index] JSON parse error: ${e.message}`);
    }
  }
  // Store partial buffer for next iteration
  stream._buf = buf;
}

async function goplsInit(stream: LSPStream, rootUri: string): Promise<void> {
  await sendRequest(stream, "initialize", {
    processId: process.pid,
    rootUri,
    capabilities: {
      textDocument: {
        documentSymbol: {},
        references: {},
      },
    },
  });
  sendNotification(stream, "initialized", {});
}

async function goplsDocSymbols(stream: LSPStream, uri: string): Promise<any[]> {
  const r = await sendRequest(stream, "textDocument/documentSymbol", {
    textDocument: { uri },
  });
  return r as any;
}

async function goplsReferences(
  stream: LSPStream,
  uri: string,
  line: number
): Promise<any[]> {
  const r = await sendRequest(stream, "textDocument/references", {
    textDocument: { uri },
    position: { line, character: 0 },
    context: { includeDeclaration: false },
  });
  return r as any;
}

async function goplsDidOpen(stream: LSPStream, filePath: string, text: string): Promise<void> {
  sendNotification(stream, "textDocument/didOpen", {
    textDocument: {
      uri: `file://${filePath}`,
      languageId: "go",
      version: 1,
      text,
    },
  });
}

// =========================================
// Index building
// =========================================

async function listGoFiles(workspaceFolder: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" ||
            entry.name === "vendor" || entry.name === ".git") continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".go")) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(workspaceFolder, full);
        files.push(rel);
      }
    }
  }
  await walk(workspaceFolder);
  return files;
}

const KIND_MAP: Record<number, string> = {
  1: "file", 2: "module", 3: "namespace", 4: "package",
  5: "class", 6: "method", 7: "property", 8: "field",
  9: "constructor", 10: "enum", 11: "interface", 12: "function",
  13: "variable", 14: "constant", 15: "string", 16: "number",
  17: "boolean", 18: "array", 19: "object", 20: "key",
  21: "null", 22: "enum_member", 23: "struct", 24: "event",
  25: "operator", 26: "type_parameter",
};

async function buildIndex(workspaceFolder: string): Promise<void> {
  console.log(`[pi-symbol-index] Building index for workspace: ${workspaceFolder}`);

  try {
    await fs.mkdir(INDEX_DIR, { recursive: true });
  } catch (e: any) {
    throw new Error(`Can't create index dir: ${e.message}`);
  }

  const rootUri = `file://${workspaceFolder}`;

  // Start gopls
  const stream = startGopls();
  await goplsInit(stream, rootUri);

  const goFiles = await listGoFiles(workspaceFolder);
  console.log(`[pi-symbol-index] Found ${goFiles.length} Go files`);

  const index: PiIndex = {
    version: 1,
    projectRoot: workspaceFolder,
    languages: ["go"],
    buildTs: new Date().toISOString(),
    files: {},
  };

  for (const file of goFiles) {
    const filePath = path.join(workspaceFolder, file);
    const fileUri = `file://${filePath}`;
    try {
      const text = await fs.readFile(filePath, "utf-8");
      await goplsDidOpen(stream, filePath, text);
      const raw: any = await goplsDocSymbols(stream, fileUri);
      const symbols: IndexSymbol[] = [];

      if (Array.isArray(raw)) {
        for (const s of raw) {
          if (s.range?.start?.line != null) {
            symbols.push({
              name: s.name,
              kind: KIND_MAP[s.kind] ?? "unknown",
              file,
              lineRange: [s.range.start.line + 1, s.range.end.line + 1],
              container: s.containerName || undefined,
              usages: [],
              outgoingCalls: [],
              incomingCalls: [],
            });
          }
        }
      }

      // Get references for function/method/interface types
      for (const sym of symbols) {
        if (["function", "method", "interface", "struct", "type"].includes(sym.kind)) {
          try {
            const refs: any = await goplsReferences(stream, fileUri, sym.lineRange[0] - 1);
            if (Array.isArray(refs)) {
              sym.usages = refs
                .filter((r: any) => r?.uri)
                .map((r: any) => ({
                  file: r.uri.replace(/^file:\/\//, ""),
                  range: [r.range.start.line + 1, r.range.end.line + 1],
                }));
            }
          } catch (e: any) {
            console.error(
              `[pi-symbol-index] refs failed for ${sym.name} in ${file}: ${e.message}`
            );
          }
        }
      }

      index.files[file] = { status: "ok", symbols };
    } catch (e: any) {
      console.error(`[pi-symbol-index] Failed to index ${file}: ${e.message}`);
      index.files[file] = { status: "broken", symbols: [] };
    }
  }

  await fs.writeFile(path.join(INDEX_DIR, INDEX_FILE), JSON.stringify(index, null, 2));
  console.log(
    `[pi-symbol-index] Index built: ${Object.keys(index.files).length} files, ` +
      Object.values(index.files).reduce((a, f) => a + f.symbols.length, 0) +
      " symbols"
  );

  stream.child?.kill();
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

export default function (pi: ExtensionAPI) {
  console.log("[pi-symbol-index] Extension loaded");

  // session_start: try to auto-build index for current CWD
  pi.on("session_start", async (event) => {
    console.log(`[pi-symbol-index] session_start: ${event.cwd}`);
    try {
      // Check if there's a Go module in the project
      const goMod = await fs
        .readFile(path.join(event.cwd, "go.mod"), "utf-8")
        .catch(() => null);
      if (goMod) {
        console.log("[pi-symbol-index] Found go.mod, building index...");
        await buildIndex(event.cwd);
      }
    } catch (e: any) {
      console.warn(`[pi-symbol-index] session_start build failed: ${e.message}`);
    }
  });

  // ---- pi_symbol_build tool (also callable as a slash command via registerCommand) ----
  pi.registerTool({
    name: "pi_symbol_build",
    label: "Build symbol index",
    description:
      "Build the symbol index for the current project. Scans Go files, queries gopls, and writes the index to .pi-index/symbols.json.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      await buildIndex(ctx.cwd);
      return {
        content: [{ type: "text", text: `Index built for ${ctx.cwd}` }],
      };
    },
  });

  // Also expose as a slash command (so users can run /pi_symbol_build in TUI)
  pi.registerCommand("pi_symbol_build", {
    description: "Build the symbol index for the current project.",
    handler: async (_args, ctx) => {
      await buildIndex(ctx.cwd);
      ctx.ui.notify("pi_symbol_build: index built", "info");
    },
  });

  // ---- pi_symbol_info tool ----
  pi.registerTool({
    name: "pi_symbol_info",
    label: "Symbol info",
    description:
      "Look up a symbol name across the project. Returns the file location, line range, container, usage list, outgoing calls, and incoming calls for the symbol. Built from gopls LSP. The model can use this to find a symbol definition without scanning source files manually.",
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name to look up" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const index = await readIndex();
      if (!index) {
        return {
          content: [
            {
              type: "text",
              text: `Symbol index not built yet. Run "pi_symbol_build" first to build it for the current project.`,
            },
          ],
        };
      }

      const results: any[] = [];
      for (const file of Object.keys(index.files)) {
        const fi = index.files[file];
        for (const sym of fi.symbols) {
          if (sym.name === params.symbol) {
            results.push({
              name: sym.name,
              kind: sym.kind,
              file,
              lineRange: sym.lineRange,
              container: sym.container,
              usages: sym.usages,
              outgoingCalls: sym.outgoingCalls,
              incomingCalls: sym.incomingCalls,
            });
          }
        }
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Symbol "${params.symbol}" not found in the index.`,
            },
          ],
        };
      }

      const text = results
        .map(
          (r) =>
            `Symbol "${r.name}" (${r.kind}) in ${r.file}:${r.lineRange[0]}-${r.lineRange[1]}\n` +
            (r.container ? `Container: ${r.container}\n` : "") +
            (r.usages.length
              ? `Usages: ${r.usages.map((u) => `${u.file}:${u.range[0]}`).join(", ")}`
              : "") +
            (r.outgoingCalls.length ? `\nCalls: ${r.outgoingCalls.join(", ")}` : "") +
            (r.incomingCalls.length ? `\nCalled by: ${r.incomingCalls.join(", ")}` : "")
        )
        .join("\n\n");

      return { content: [{ type: "text", text }] };
    },
  });

  // ---- pi_project_symbols tool ----
  pi.registerTool({
    name: "pi_project_symbols",
    label: "Project symbols",
    description:
      "Get a high-level overview of symbol counts and file inventory for the current project. Useful for understanding a project before starting work.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const index = await readIndex();
      if (!index) {
        return {
          content: [{ type: "text", text: "Symbol index not built yet. Run pi_symbol_build first." }],
        };
      }

      const lines: string[] = [
        `Symbol Index for ${index.projectRoot}`,
        `Languages: ${index.languages.join(", ")}`,
        `Files: ${Object.keys(index.files).length}`,
        `Total symbols: ${Object.values(index.files).reduce((a, f) => a + f.symbols.length, 0)}`,
        "",
      ];

      for (const file of Object.keys(index.files)) {
        const fi = index.files[file];
        const funcs = fi.symbols.filter((s) => s.kind === "function").length;
        const types = fi.symbols.filter((s) =>
          ["struct", "interface", "type", "class"].includes(s.kind)
        ).length;
        lines.push(
          `${file}: ${fi.symbols.length} symbols — ${funcs} funs, ${types} types (${fi.status})`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
