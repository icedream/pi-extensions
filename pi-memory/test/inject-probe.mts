// Exercise the injector and the tool-facing read paths against the shared store, the way
// session_start would, without restarting pi. Run with:
//   PI_MEMORY_DSN="$(cat ~/.pi/agent/secrets/pimemory.dsn)" npx tsx test/inject-probe.mts
import { resolveDsn } from "../src/index.js";
import { PostgresStore, parseDsn } from "../src/pg-store.js";
import { buildContextBlock } from "../src/injector.js";

const dsn = resolveDsn(process.cwd());
if (!dsn) {
  console.error("no DSN resolved: set PI_MEMORY_DSN or pi-memory.dsn in settings.json");
  process.exit(2);
}
const store = await PostgresStore.connect(parseDsn(dsn));

const fallback = await buildContextBlock(store, process.cwd());
const sections = [...fallback.text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
console.log(`fallback block: ${fallback.text.length} chars, ${fallback.stats.semantic} facts, `
  + `${fallback.stats.lessons} lessons, sections=[${sections.join(", ")}]`);

const selective = await buildContextBlock(store, process.cwd(), "firefox biDi pointer input");
console.log(`selective block: ${selective.text.length} chars, ${selective.stats.semantic} facts, `
  + `${selective.stats.lessons} lessons`);

console.log("search tool says:", JSON.stringify((await store.searchSemantic("browser consent wall", 3))
  .map((r) => `${r.key}@${r.confidence}`)));
console.log("lessons tool says:", (await store.searchLessons("screenshot verify", 3))
  .map((l) => `${l.id.slice(0, 8)}[${l.category}]`).join(" "));
console.log("stats tool says:", JSON.stringify(await store.stats()));

await store.close();
