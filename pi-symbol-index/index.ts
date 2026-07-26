// Pi Symbol Index Extension — Phase 1: gopls + symbol tools
//
// Uses vscode-jsonrpc (LSP JSON-RPC over LSP framing) to drive gopls
// and exposes symbol info tools to the model.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc/node";
import {
  DocumentSymbol as LSPDocumentSymbol,
  Location,
} from "vscode-languageserver-types/node";

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

const KIND_MAP: Record<number, string> = {
  12: "function", 6: "method", 11: "interface",
  23: "struct", 5: "class", 1: "file", 2: "module",
  13: "variable", 14: "constant",
};

function getKindName(kind: number): string {
  return KIND_MAP[kind] ?? "unknown";
}

function fileUriToFile(uri: string): string {
  return uri.replace(/^file:\/\//, "");
}

// =========================================
// LSP client (wrapped around gopls)
// =========================================

function buildGoplsClient(workspaceFolder: string) {
  const gopls = spawn("gopls", ["serve"], {
    env: { ...process.env, GOFLAGS: "" },
  });

  gopls.stderr?.on("data", (chunk) => {
    console.error(`[gopls stderr] ${chunk.toString().trim()}`);
  });

  const reader = new StreamMessageReader(gopls.stdout);
  const writer = new StreamMessageWriter(gopls.stdin);
  const connection = createMessageConnection(reader, writer);

  // Filter noise
  connection.onNotification("window/showMessage", () => {
    // suppress
  });
  connection.onNotification("window/logMessage", () => {
    // suppress
  });
  connection.onNotification("textDocument/publishDiagnostics", () => {
    // suppress
  });

  return { gopls, connection };
}

export async function buildIndex(workspaceFolder: string): Promise<void> {
  console.log(`[pi-symbol-index] Building index for workspace: ${workspaceFolder}`);

  try {
    await fs.mkdir(INDEX_DIR, { recursive: true });
  } catch (e: any) {
    throw new Error(`Can't create index dir: ${e.message}`);
  }

  const { gopls, connection } = buildGoplsClient(workspaceFolder);

  // Need to register a listener BEFORE any requests
  connection.listen();

  const rootUri = `file://${workspaceFolder}`;

  try {
    // Initialize
    await connection.sendRequest("initialize", {
      processId: null,
      rootUri,
      capabilities: {
        textDocument: {
          documentSymbol: {},
          references: {},
        },
      },
    }) as any;

    // Notify that we're ready
    connection.sendNotification("initialized", {});

    // Discover Go files
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

        // Open the document to tell gopls about it
        connection.sendNotification("textDocument/didOpen", {
          textDocument: {
            uri: fileUri,
            languageId: "go",
            version: 1,
            text,
          },
        });

        // Wait for gopls to process
        await sleep(500);

        // Get document symbols
        const symbols: any = await connection.sendRequest(
          "textDocument/documentSymbol",
          { textDocument: { uri: fileUri } },
        );

        const fileSymbols: IndexSymbol[] = [];


        if (Array.isArray(symbols)) {
          for (const s of symbols) {
            const loc = s.location || s;
            const range = loc.range || loc;
            if (range.start?.line != null) {
              fileSymbols.push({
                name: s.name,
                kind: getKindName(s.kind),
                file,
                lineRange: [range.start.line + 1, range.end.line + 1],
                container: s.containerName || undefined,
                usages: [],
                outgoingCalls: [],
                incomingCalls: [],
              });
            }
          }
        }


        // Get references for function/method/interface/struct types
        for (const sym of fileSymbols) {
          if (
            ["function", "method", "interface", "struct", "type"].includes(
              sym.kind,
            )
          ) {
            try {
              // Read the file text to find identifier position
              const fullText = await fs.readFile(filePath, "utf-8");
              const lineContent = fullText.split("\n")[sym.lineRange[0] - 1] || "";
              const charIdx = lineContent.indexOf(sym.name);
              if (charIdx === -1) continue;

              const refs: Location[] = await connection.sendRequest(
                "textDocument/references",
                {
                  textDocument: { uri: fileUri },
                  position: {
                    line: sym.lineRange[0] - 1,
                    character: charIdx,
                  },
                  context: { includeDeclaration: false },
                },
              ) as any;

              if (Array.isArray(refs)) {
                sym.usages = refs
                  .filter((r) => r?.uri)
                  .map((r) => ({
                    file: fileUriToFile(r.uri),
                    range: [r.range.start.line + 1, r.range.end.line + 1],
                  }));
              }
            } catch (e: any) {
              // References may fail for certain identifiers / symbols — ignore
            }
          }
        }

        index.files[file] = { status: "ok", symbols: fileSymbols };
      } catch (e: any) {
        console.error(`[pi-symbol-index] Failed to index ${file}: ${e.message}`);
        index.files[file] = { status: "broken", symbols: [] };
      }
    }

    await fs.writeFile(
      path.join(INDEX_DIR, INDEX_FILE),
      JSON.stringify(index, null, 2),
    );
    console.log(
      `[pi-symbol-index] Index built: ${Object.keys(index.files).length} files, ` +
        Object.values(index.files).reduce((a, f) => a + f.symbols.length, 0) +
        " symbols",
    );
  } finally {
    try { connection.dispose(); } catch {}
    try { gopls.kill(); } catch {}
  }
}

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
        if (
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          entry.name === "vendor" ||
          entry.name === ".git"
        ) continue;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readIndex(): Promise<PiIndex | null> {
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

  // Auto-build index on session_start when go.mod exists
  pi.on("session_start", async (event) => {
    console.log(`[pi-symbol-index] session_start: ${event.cwd}`);
    try {
      const goMod = await fs
        .readFile(path.join(event.cwd, "go.mod"), "utf-8")
        .catch(() => null);
      if (goMod) {
        console.log("[pi-symbol-index] Found go.mod, building index...");
        await buildIndex(event.cwd);
      }
    } catch (e: any) {
      console.warn(
        `[pi-symbol-index] session_start build failed: ${e.message}`,
      );
    }
  });

  // ---- pi_symbol_build tool & command ----
  pi.registerTool({
    name: "pi_symbol_build",
    label: "Build symbol index",
    description:
      "Build the symbol index for the current project. Scans Go files, queries gopls, and writes the index to .pi-index/symbols.json.",
    parameters: { properties: {} },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      await buildIndex(ctx.cwd);
      return { content: [{ type: "text", text: `Index built for ${ctx.cwd}` }] };
    },
  });

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
    parameters: {
      properties: { symbol: { type: "string", description: "Symbol name to look up" } },
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const index = await readIndex();
      if (!index) {
        return {
          content: [
            {
              type: "text",
              text: 'Symbol index not built yet. Run "pi_symbol_build" first to build it for the current project.',
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
              ? `Usages: ${r.usages
                  .map((u) => `${u.file}:${u.range[0]}`)
                  .join(", ")}`
              : "") +
            (r.outgoingCalls.length
              ? `\nCalls: ${r.outgoingCalls.join(", ")}`
              : "") +
            (r.incomingCalls.length
              ? `\nCalled by: ${r.incomingCalls.join(", ")}`
              : ""),
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
    parameters: { properties: {} },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const index = await readIndex();
      if (!index) {
        return {
          content: [
            { type: "text", text: "Symbol index not built yet. Run pi_symbol_build first." },
          ],
        };
      }

      const lines: string[] = [
        `Symbol Index for ${index.projectRoot}`,
        `Languages: ${index.languages.join(", ")}`,
        `Files: ${Object.keys(index.files).length}`,
        `Total symbols: ${Object.values(index.files).reduce(
          (a, f) => a + f.symbols.length,
          0,
        )}`,
        "",
      ];

      for (const file of Object.keys(index.files)) {
        const fi = index.files[file];
        const funcs = fi.symbols.filter((s) => s.kind === "function").length;
        const types = fi.symbols.filter((s) =>
          ["struct", "interface", "type", "class"].includes(s.kind),
        ).length;
        lines.push(
          `${file}: ${fi.symbols.length} symbols — ${funcs} funs, ${types} types (${fi.status})`,
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
