// Test: exercise index.ts's detectLanguage + extractFromTsProgram
const fs = require("fs/promises");
const path = require("path");
const WORKSPACE = "/home/icedream/Documents/Source/Git/github.com/icedream/pi-extensions/_test/ts-project";

const KIND_MAP = {
  12: "function", 6: "method", 11: "interface", 23: "struct", 5: "class",
  1: "file", 13: "variable", 25: "enum", 7: "property",
};
function getKindName(kind) { return KIND_MAP[kind] || "unknown"; }

async function detectLanguage(workspaceFolder) {
  try {
    await fs.access(path.join(workspaceFolder, "package.json"));
    const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"];
    const files = [];
    async function walk(dir) {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "vendor" || entry.name === ".git") continue;
          await walk(path.join(dir, entry.name));
        } else if (exts.some(e => entry.name.endsWith(e))) {
          files.push(path.relative(workspaceFolder, path.join(dir, entry.name)));
        }
      }
    }
    await walk(workspaceFolder);
    return { name: "typescript", files };
  } catch {}
  return null;
}

async function extractFromTsProgram(workspaceFolder, files) {
  const ts = require("/home/icedream/Documents/Source/Git/github.com/icedream/pi-extensions/_test/ts-project/node_modules/typescript");
  const fullPaths = files.map((f) => path.join(workspaceFolder, f));
  const program = ts.createProgram(fullPaths, { noEmit: true });
  const result = {};
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(workspaceFolder)) continue;
    const relative = path.relative(workspaceFolder, sf.fileName);
    const symbols = [];
    const seen = new Set();
    function nodeSymbolKind(node) {
      if (ts.isFunctionDeclaration(node)) return 12;
      if (ts.isMethodDeclaration(node)) return 6;
      if (ts.isClassDeclaration(node)) return 5;
      if (ts.isInterfaceDeclaration(node)) return 11;
      if (ts.isTypeAliasDeclaration(node)) return 11;
      if (ts.isEnumDeclaration(node)) return 25;
      if (ts.isVariableStatement(node) && node.declarations && node.declarations[0]) {
        return 13;
      }
      return undefined;
    }
    function walk(node, container) {
      try {
        const kind = nodeSymbolKind(node);
        let symText = "";
        try { symText = node.name?.text || node.name?.escapedText || ""; } catch {}
        if (kind != null && symText) {
          const fullName = container ? `${container}.${symText}` : symText;
          if (!seen.has(fullName)) {
            seen.add(fullName);
            try {
              const sfRef = node.getSourceFile() || sf;
              const start = sfRef.getLineAndCharacterOfPosition(node.getStart(sfRef));
              const end = sfRef.getLineAndCharacterOfPosition(node.getEnd());
              symbols.push({
                name: symText, kind: getKindName(kind), file: relative,
                lineRange: [start.line + 1, end.line + 1],
                container: container && container !== "<module>" ? container : undefined,
                usages: [],
              });
            } catch { /* skip nodes without sourcemapping */ }
          }
        }
        const next = (kind === 5 || kind === 11) ? symText : container || "<module>";
        ts.forEachChild(node, (child) => walk(child, next));
      } catch {}
    }
    walk(sf);
    result[relative] = { status: "ok", symbols };
  }
  return result;
}

async function main() {
  const lang = await detectLanguage(WORKSPACE);
  console.log("=== Detected language:", lang.name, "===,", "files:", lang.files.length);
  if (!lang || lang.files.length === 0) throw new Error("No TS files detected");

  const result = await extractFromTsProgram(WORKSPACE, lang.files);
  console.log("\n=== Results ===");
  for (const [file, data] of Object.entries(result)) {
    console.log(`${file} (${data.symbols.length} symbols):`);
    for (const s of data.symbols) {
      console.log(`  ${s.kind} ${s.name} ${s.container ? `(${s.container})` : ""} [${s.lineRange[0]}-${s.lineRange[1]}]`);
    }
  }

  // Verify
  const allS = Object.values(result).flatMap((r) => r.symbols);
  const expected = allS.filter((s) => s.name === "User" || s.name === "greet" || s.name === "UserService" || s.name === "add");
  console.log(`\n=== Expected: ${expected.length} symbols (User, greet, UserService, add), got ${allS.length} ===`);
  if (expected.length !== 4) throw new Error("Symbol count mismatch");

  // Write index to verify persistence
  const indexDir = "./.pi-index";
  await fs.mkdir(indexDir, { recursive: true });
  const index = { version: 1, projectRoot: WORKSPACE, buildTs: new Date().toISOString(), files: result };
  const indexP = path.join(indexDir, "symbols.json");
  await fs.writeFile(indexP, JSON.stringify(index, null, 2));
  console.log(`=== Wrote ${indexP} ===`);

  // Read back
  const readBack = JSON.parse(await fs.readFile(indexP, "utf-8"));
  console.log(`=== Read back: ${Object.keys(readBack.files).length} files ===`);

  console.log("\n=== PASSED ===");
}

main().catch((e) => { console.error(e); process.exit(1); });
