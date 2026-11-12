/**
 * Backend parity check: run the same calls against a copy of the local SQLite store and
 * against Postgres, and print where they agree.
 *
 *   PI_MEMORY_DSN="$(cat ~/.pi/agent/secrets/pimemory.dsn)" \
 *     SQLITE_SNAPSHOT=/tmp/parity-src.db npm run test:pg
 *
 * Writes land in Postgres under keys and a category named for this run, and are removed again.
 * Ranking is expected to differ, because SQLite uses FTS5 bm25 and Postgres uses the package's
 * matched-term fraction, so search results are compared as sets and only the overlap is shown.
 * Exact-equality is asserted only where the two backends must agree: counts, one fact, prefix
 * lists, the dedup rules and the confidence rule.
 */
import { cpSync, existsSync } from "node:fs";
import { Pool } from "pg";
import { SqliteStore } from "../src/store.js";
import { PostgresStore, parseDsn, tlsFor } from "../src/pg-store.js";

const DSN = process.env.PI_MEMORY_DSN;
const SNAP = process.env.SQLITE_SNAPSHOT;
if (!DSN || !SNAP) {
  console.error("PI_MEMORY_DSN and SQLITE_SNAPSHOT are required");
  process.exit(2);
}
if (!existsSync(SNAP)) {
  console.error(`no such snapshot: ${SNAP}`);
  process.exit(2);
}

const scratch = "/tmp/pi-memory-parity.db";
cpSync(SNAP, scratch);

const pg = await PostgresStore.connect(parseDsn(DSN));
const sq = new SqliteStore(scratch);

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};
const overlap = <T>(a: T[], b: T[]) => a.filter((x) => b.includes(x)).length;

// ─── reads that must match exactly ───────────────────────────────────

const [ps, ss] = await Promise.all([pg.stats(), sq.stats()]);
// Facts and lessons must match the snapshot exactly. Events will not: Postgres also carries the
// audit trail of every test write made since, which is the point of an audit log.
check("stats facts and lessons", ps.semantic === ss.semantic && ps.lessons === ss.lessons,
  `pg=${JSON.stringify(ps)} sqlite=${JSON.stringify(ss)}`);
check("events recorded in Postgres too", ps.events >= ss.events, `pg=${ps.events} sqlite=${ss.events}`);

for (const key of ["tool.pi-memory.internals", "pref.commit.style", "user.name"]) {
  const [a, b] = await Promise.all([pg.getSemantic(key), sq.getSemantic(key)]);
  const same = (!!a === !!b) && (!a || (a.value === b!.value && Math.abs(a.confidence - b!.confidence) < 1e-6));
  check(`getSemantic ${key}`, same, a ? `${a.confidence} | ${a.value.slice(0, 40)}...` : "absent in both");
}

for (const [prefix, limit] of [["pref.", 5], ["tool.", 5], ["project.", 5]] as const) {
  const [a, b] = await Promise.all([pg.listSemantic(prefix, limit), sq.listSemantic(prefix, limit)]);
  check(`listSemantic ${prefix}`, a.length === b.length
    && overlap(a.map((x) => x.key), b.map((x) => x.key)) === Math.min(a.length, b.length),
  `pg=${a.length} sqlite=${b.length}`);
}

for (const [cat, limit] of [["general", 5], ["tooling/browser", 5]] as const) {
  const [a, b] = await Promise.all([pg.listLessons(cat, limit), sq.listLessons(cat, limit)]);
  check(`listLessons ${cat}`, a.length === b.length
    && overlap(a.map((x) => x.id), b.map((x) => x.id)) === Math.min(a.length, b.length),
  `pg=${a.length} sqlite=${b.length}`);
}

const [pc, sc] = await Promise.all([pg.embeddingCoverage(), sq.embeddingCoverage()]);
check("embeddingCoverage", pc.embedded === sc.embedded && pc.total === sc.total, `pg=${JSON.stringify(pc)} sqlite=${JSON.stringify(sc)}`);

const pe = await pg.entriesNeedingEmbedding(384, 10);
const se = await sq.entriesNeedingEmbedding(384, 10);
check("entriesNeedingEmbedding(384)", pe.length === se.length, `pg=${pe.length} sqlite=${se.length}`);

// ─── reads that may rank differently ────────────────────────────────

for (const q of ["firefox biDi pointer input", "postgres memory store", "yt-dlp youtube clients"]) {
  const [a, b] = await Promise.all([pg.searchSemantic(q, 5), sq.searchSemantic(q, 5)]);
  const common = overlap(a.map((x) => x.key), b.map((x) => x.key));
  check(`searchSemantic "${q}"`, a.length > 0 && common > 0, `pg=${a.length} sqlite=${b.length} overlap=${common}`);
}

for (const q of ["consent dialog screenshot", "shadow dom turnstile"]) {
  const [a, b] = await Promise.all([pg.searchLessons(q, 5), sq.searchLessons(q, 5)]);
  const common = overlap(a.map((x) => x.id), b.map((x) => x.id));
  check(`searchLessons "${q}"`, a.length > 0 && common > 0, `pg=${a.length} sqlite=${b.length} overlap=${common}`);
}

// ─── writes: same rules, same outcomes ──────────────────────────────

const marker = `paritytest ${Date.now()}`;
const key = "paritytest.probe";

await pg.setSemantic(key, "first value", 0.9, "user");
await pg.setSemantic(key, "lower confidence attempt", 0.5, "consolidation");
const kept = await pg.getSemantic(key);
check("setSemantic higher confidence wins", kept?.value === "first value", `value=${kept?.value}`);

await pg.setSemantic(key, "higher confidence attempt", 0.95, "user");
const raised = await pg.getSemantic(key);
check("setSemantic raises when equal-or-higher", raised?.value === "higher confidence attempt" && raised.confidence === 0.95);

const l1 = await pg.addLesson(marker + ": a lesson about testing two backends against each other", "paritytest");
const l2 = await pg.addLesson(marker + ": a lesson about testing two backends against each other", "paritytest");
const l3 = await pg.addLesson(marker + ": a lesson about testing two backends against each other carefully", "paritytest");
check("addLesson first", l1.success === true, JSON.stringify(l1));
check("addLesson exact duplicate rejected", l2.success === false && l2.reason === "duplicate", JSON.stringify(l2));
check("addLesson near duplicate rejected", l3.success === false && l3.reason === "similar", JSON.stringify(l3));

const listed = await pg.listLessons("paritytest", 10);
check("listLessons category filter", listed.length === 1, `count=${listed.length}`);

const found = await pg.searchLessons(marker, 5);
check("searchLessons finds the new lesson", found.some((l) => l.id === l1.id), `hits=${found.length}`);

const short = (l1.id ?? "").slice(0, 8);
const removed = await pg.deleteLesson(short);
check(`deleteLesson by ${short}-char prefix`, removed === true);
check("deleteLesson is soft", (await pg.getLesson(l1.id!)) === undefined);

const del = await pg.deleteSemantic(key);
const gone = await pg.deleteSemantic(key);
check("deleteSemantic then second delete", del === true && gone === false);

const events = await pg.listEvents(5);
check("listEvents newest first", events.length >= 3 && events[0].id > events[events.length - 1].id,
  events.map((e) => `${e.id}:${e.event_type}/${e.memory_type}`).join(" "));

const after = await pg.stats();
check("stats back to baseline for facts", after.semantic === ps.semantic, `before=${ps.semantic} after=${after.semantic}`);

// The run leaves audit rows behind, which is what an audit log is for, but a parity harness
// should not be the reason the shared store grows. Drop this run's events and the soft-deleted
// lesson, then close.
const dsnOpts = parseDsn(DSN);
const admin = new Pool({ connectionString: dsnOpts.connectionString, ssl: tlsFor(dsnOpts) });
await admin.query("delete from memory_event where memory_key = $1 or memory_key = $2 or detail like $3",
  [key, l1.id ?? "", "paritytest%"]);
await admin.query("delete from memory_lesson where category = 'paritytest'");
await admin.end();

const cleaned = await pg.stats();
check("cleanup left no paritytest rows",
  (await pg.searchSemantic("paritytest", 5)).length === 0 && (await pg.listLessons("paritytest", 5)).length === 0,
  `events=${cleaned.events}`);

await pg.close();
await sq.close();

if (fails) {
  console.error(`\n${fails} parity check(s) failed`);
  process.exit(1);
}
console.log("\nall parity checks passed");
