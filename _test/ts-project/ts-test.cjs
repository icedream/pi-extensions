// Test: TypeScript program API symbol extraction
const ts = require("/home/icedream/Documents/Source/Git/github.com/icedream/pi-extensions/_test/ts-project/node_modules/typescript");
const path = require("path");

const WORKSPACE = "/home/icedream/Documents/Source/Git/github.com/icedream/pi-extensions/_test/ts-project";
const FILES = ["index.ts"];

const FULL_PATHS = FILES.map((f) => path.join(WORKSPACE, f));
const program = ts.createProgram(FULL_PATHS, { noEmit: true, allowJs: false });
const checker = program.getTypeChecker();

function getKindName(kind) {
  const m = { 12: "function", 6: "method", 11: "interface", 23: "struct", 5: "class", 13: "variable", 25: "enum" };
  return m[kind] || "unknown";
}

const results = [];
const seen = new Set();

for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || !sf.fileName.startsWith(WORKSPACE)) continue;
  const relative = path.relative(WORKSPACE, sf.fileName);
  const symbols = [];

  function walk(node, container) {
    let kind, symText;
    const n = node;
    if (ts.isFunctionDeclaration(n)) { kind = 12; symText = n.name.text; }
    else if (ts.isMethodDeclaration(n)) { kind = 6; symText = n.name.text; }
    else if (ts.isClassDeclaration(n)) { kind = 5; symText = n.name.text; }
    else if (ts.isInterfaceDeclaration(n)) { kind = 11; symText = n.name.text; }
    else if (ts.isTypeAliasDeclaration(n)) { kind = 11; symText = n.name.text; }
    else if (ts.isEnumDeclaration(n)) { kind = 25; symText = n.name.text; }
    else if (ts.isVariableStatement(n) && n.declarations && n.declarations[0]?.name && n.declarations[0].name.kind === ts.SyntaxKind.Identifier) {
      kind = 13; symText = n.declarations[0].name.text;
    } else { kind = undefined; symText = undefined; }

    if (kind != null && symText) {
      const fullName = container ? `${container}.${symText}` : symText;
      if (!seen.has(fullName)) {
        seen.add(fullName);
        const start = sf.getLineAndCharacterOfPosition(n.getStart());
        const end = sf.getLineAndCharacterOfPosition(n.getEnd());
        symbols.push({ name: symText, kind: getKindName(kind), file: relative, lineRange: [start.line + 1, end.line + 1], container: container && container !== "<module>" ? container : undefined, usages: [] });
      }
    }
    const next = (kind === 5 || kind === 11) ? symText : container || "<module>";
    ts.forEachChild(node, (child) => walk(child, next));
  }

  walk(sf);
  results.push({ file: relative, symbols });
}

console.log("=== Symbols found ===");
for (const r of results) {
  console.log(`\n${r.file}:`);
  for (const s of r.symbols) {
    console.log(`  ${s.kind} ${s.name} (${s.container}) [${s.lineRange[0]}-${s.lineRange[1]}]`);
  }
}

// Verify
const funcs = results.flatMap(r => r.symbols.filter(s => s.kind === "function")).length;
const classes = results.flatMap(r => r.symbols.filter(s => s.kind === "class")).length;
const interfaces = results.flatMap(r => r.symbols.filter(s => s.kind === "interface")).length;
console.log(`\n=== Total === functions=${funcs} classes=${classes} interfaces=${interfaces} ===`);
if (funcs === 0 && classes === 0) throw new Error("Failed to extract symbols");
console.log("=== PASSED ===");
