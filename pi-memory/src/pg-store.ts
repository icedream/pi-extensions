/**
 * Postgres backend, so one memory store serves every machine a pi session runs on.
 *
 * Ranking note, stated rather than hidden: the SQLite backend prefers FTS5 bm25 and falls back
 * to a matched-term fraction. This backend uses the fraction everywhere. At the size this
 * corpus is (hundreds of rows) the two agree on the queries these tools make, and a tsvector
 * reimplementation would be a second ranking to keep honest without buying parity anyway,
 * since ts_rank is not bm25.
 *
 * Concurrency note: the SQLite backend's dedup and confidence rules are read-then-write. Here
 * the confidence rule runs inside a locked transaction and lesson dedup also leans on the
 * unique rule_hash index, because two machines can consolidate at the same moment.
 */
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolConfig } from "pg";
import { cosine, fromBlob } from "./vector.js";
import { jaccard, type MemoryEvent, type LessonEntry, type MemoryStore, type SemanticEntry } from "./store.js";

export interface PgOptions {
  connectionString: string;
  /** Same sslmode values libpq uses: disable, prefer, require, verify-ca, verify-full. */
  sslmode: string;
  sslrootcert?: string;
  applicationName?: string;
  connectionTimeoutMs?: number;
}

/**
 * Translate a libpq-style DSN into driver options. `sslrootcert` arrives percent-encoded in the
 * query string, which `URL` decodes for us.
 *
 * The TLS parameters are stripped from the connection string on purpose. node-postgres parses
 * `sslmode` itself and, since 8.16, treats `verify-ca` as `verify-full` unless the string carries
 * `uselibpqcompat=true`, which silently overrides the `ssl` object passed alongside it. Keeping
 * TLS decisions in one place, here, avoids two implementations disagreeing about the same DSN.
 */
export function parseDsn(dsn: string): PgOptions {
  const u = new URL(dsn);
  const sslmode = u.searchParams.get("sslmode") ?? "prefer";
  const rootcert = u.searchParams.get("sslrootcert") ?? undefined;
  if (sslmode === "verify-ca" || sslmode === "verify-full") {
    if (!rootcert) {
      throw new Error(`pi-memory: sslmode=${sslmode} needs sslrootcert pointing at the issuing CA`);
    }
  }
  for (const p of ["sslmode", "sslrootcert", "sslcert", "sslkey", "sslpassword", "uselibpqcompat"]) {
    u.searchParams.delete(p);
  }
  return { connectionString: u.toString(), sslmode, sslrootcert: rootcert, applicationName: "pi-memory" };
}

export function tlsFor(o: PgOptions): PoolConfig["ssl"] {
  if (o.sslmode === "disable") return undefined;
  const ca = o.sslrootcert ? readFileSync(o.sslrootcert, "utf8") : undefined;
  if (!ca) {
    // require/prefer without a CA: encrypt, verify nothing. Same as libpq, same weakness.
    return { rejectUnauthorized: false };
  }
  if (o.sslmode === "verify-full") return { ca };
  // verify-ca: chain must validate, hostname is not checked, matching libpq.
  return { ca, checkServerIdentity: () => undefined };
}

/** Timestamps come back in SQLite's text shape so callers cannot tell the backends apart. */
const TS = `to_char({col} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;
const ts = (col: string) => TS.replace("{col}", col);
const FACT_COLS = `key, value, confidence, source, ${ts("created_at")} as created_at,
  ${ts("updated_at")} as updated_at, ${ts("last_accessed")} as last_accessed`;
const LESSON_COLS = `id, rule, category, source, negative, project, ${ts("created_at")} as created_at`;

export class PostgresStore implements MemoryStore {
  private pool: Pool;

  constructor(opts: PgOptions) {
    this.pool = new Pool({
      connectionString: opts.connectionString,
      ssl: tlsFor(opts),
      application_name: opts.applicationName ?? "pi-memory",
      max: 4,
      connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5000,
      statement_timeout: 10000,
    } as PoolConfig);
  }

  /** Fail loudly at startup rather than writing somewhere unexpected later. */
  static async connect(opts: PgOptions): Promise<PostgresStore> {
    const store = new PostgresStore(opts);
    const r = await store.pool.query("select current_database() as db, version() as v");
    const db = r.rows[0]?.db as string;
    if (!db) throw new Error("pi-memory: connected but could not read current_database()");
    return store;
  }

  private async withTransaction<T>(fn: (q: <R = any>(sql: string, vals?: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const q = async <R = any>(sql: string, vals?: unknown[]): Promise<R[]> =>
        (await client.query(sql, vals as any[])).rows as R[];
      const out = await fn(q);
      await client.query("commit");
      return out;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  private static hash(rule: string): string {
    return createHash("sha256").update(rule).digest("hex");
  }

  // ─── semantic facts ───────────────────────────────────────────────

  async getSemantic(key: string): Promise<SemanticEntry | undefined> {
    const r = await this.pool.query(`SELECT ${FACT_COLS} FROM memory_fact WHERE key = $1`, [key.toLowerCase()]);
    return r.rows[0] as SemanticEntry | undefined;
  }

  async setSemantic(key: string, value: string, confidence = 0.8, source: SemanticEntry["source"] = "consolidation"): Promise<void> {
    const k = key.toLowerCase();
    await this.withTransaction(async (q) => {
      const existing = await q<{ confidence: number }>("SELECT confidence FROM memory_fact WHERE key = $1 FOR UPDATE", [k]);
      if (existing.length && existing[0].confidence > confidence) return; // higher confidence wins
      const kind = existing.length ? "update" : "create";
      await q(
        `INSERT INTO memory_fact (key, value, confidence, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, now(), now())
         ON CONFLICT (key) DO UPDATE
           SET value = excluded.value, confidence = excluded.confidence,
               source = excluded.source, updated_at = now()`,
        [k, value, confidence, source],
      );
      await q("INSERT INTO memory_event (event_type, memory_type, memory_key) VALUES ($1, 'fact', $2)", [kind, k]);
    });
  }

  async deleteSemantic(key: string): Promise<boolean> {
    const k = key.toLowerCase();
    return this.withTransaction(async (q) => {
      const d = await q("DELETE FROM memory_fact WHERE key = $1 RETURNING key", [k]);
      if (d.length) {
        await q("INSERT INTO memory_event (event_type, memory_type, memory_key) VALUES ('delete', 'fact', $1)", [k]);
      }
      return d.length > 0;
    });
  }

  async setEmbedding(key: string, embedding: Float32Array): Promise<void> {
    const blob = Buffer.from(new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength));
    await this.pool.query("UPDATE memory_fact SET embedding = $2, embedding_dims = $3 WHERE key = $1",
      [key.toLowerCase(), blob, embedding.length]);
  }

  async getAllEmbeddings(): Promise<Array<{ key: string; embedding: Buffer | null }>> {
    const r = await this.pool.query("SELECT key, embedding FROM memory_fact ORDER BY updated_at DESC");
    return r.rows as Array<{ key: string; embedding: Buffer | null }>;
  }

  async searchSemanticByVector(queryVector: Float32Array, limit = 10, minScore = 0.15): Promise<SemanticEntry[]> {
    const scored: Array<{ key: string; score: number }> = [];
    for (const row of await this.getAllEmbeddings()) {
      const vec = fromBlob(row.embedding);
      if (!vec) continue;
      const score = cosine(queryVector, vec);
      if (score >= minScore) scored.push({ key: row.key, score });
    }
    if (scored.length === 0) return [];
    scored.sort((a, b) => b.score - a.score);
    const out: SemanticEntry[] = [];
    for (const s of scored.slice(0, limit)) {
      const e = await this.getSemantic(s.key);
      if (e) out.push(e);
    }
    return out;
  }

  async embeddingCoverage(): Promise<{ embedded: number; total: number }> {
    const rows = await this.getAllEmbeddings();
    return { embedded: rows.filter((r) => fromBlob(r.embedding) !== null).length, total: rows.length };
  }

  async entriesNeedingEmbedding(dimensions?: number, limit = 500): Promise<Array<{ key: string; value: string }>> {
    const stale: string[] = [];
    for (const row of await this.getAllEmbeddings()) {
      const vec = fromBlob(row.embedding);
      if (vec === null || (dimensions !== undefined && vec.length !== dimensions)) stale.push(row.key);
      if (stale.length >= limit) break;
    }
    if (!stale.length) return [];
    const r = await this.pool.query("SELECT key, value FROM memory_fact WHERE key = ANY($1)", [stale]);
    return r.rows as Array<{ key: string; value: string }>;
  }

  async listSemantic(prefix?: string, limit = 100): Promise<SemanticEntry[]> {
    const sql = prefix
      ? `SELECT ${FACT_COLS} FROM memory_fact WHERE key LIKE $1 ORDER BY updated_at DESC LIMIT $2`
      : `SELECT ${FACT_COLS} FROM memory_fact ORDER BY updated_at DESC LIMIT $1`;
    const vals = prefix ? [`${prefix.toLowerCase()}%`, limit] : [limit];
    const r = await this.pool.query(sql, vals);
    return r.rows as SemanticEntry[];
  }

  async searchSemantic(query: string, limit = 10): Promise<SemanticEntry[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const r = await this.pool.query(`SELECT ${FACT_COLS} FROM memory_fact`);
    return (r.rows as SemanticEntry[])
      .map((entry) => {
        const text = `${entry.key} ${entry.value}`.toLowerCase();
        return { entry, score: terms.filter((t) => text.includes(t)).length / terms.length };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entry);
  }

  async touchAccessed(keys: string[]): Promise<void> {
    if (!keys.length) return;
    await this.pool.query("UPDATE memory_fact SET last_accessed = now() WHERE key = ANY($1)", [keys.map((k) => k.toLowerCase())]);
  }

  // ─── lessons ──────────────────────────────────────────────────────

  async addLesson(rule: string, category = "general", source = "consolidation", negative = false, project?: string) {
    const trimmed = rule.trim();
    if (!trimmed) return { success: false as const, reason: "empty rule" as const };
    const cat = category.trim().toLowerCase() || "general";
    try {
      return await this.withTransaction(async (q) => {
        const exact = await q<{ id: string }>(
          "SELECT id FROM memory_lesson WHERE lower(trim(rule)) = lower($1) AND is_deleted = false FOR UPDATE", [trimmed]);
        if (exact.length) return { success: false as const, reason: "duplicate" as const, id: exact[0].id };

        const all = await q<{ id: string; rule: string }>("SELECT id, rule FROM memory_lesson WHERE is_deleted = false");
        for (const r of all) {
          if (jaccard(trimmed, r.rule) >= 0.7) return { success: false as const, reason: "similar" as const, id: r.id };
        }

        const id = randomUUID();
        await q("INSERT INTO memory_lesson (id, rule_hash, rule, category, source, negative, project) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [id, PostgresStore.hash(trimmed), trimmed, cat, source, negative, project ?? null]);
        await q("INSERT INTO memory_event (event_type, memory_type, memory_key, detail) VALUES ('create', 'lesson', $1, $2)",
          [id, trimmed.slice(0, 100)]);
        return { success: true as const, id };
      });
    } catch (e) {
      // Two machines can pass the checks above and arrive at the index at once. That is the
      // dedup working, not a failure worth surfacing to the model.
      if ((e as { code?: string }).code === "23505") {
        const hit = await this.pool.query("SELECT id FROM memory_lesson WHERE rule_hash = $1", [PostgresStore.hash(trimmed)]);
        return { success: false as const, reason: "duplicate" as const, id: hit.rows[0]?.id as string | undefined };
      }
      throw e;
    }
  }

  async getLesson(id: string): Promise<LessonEntry | undefined> {
    const r = await this.pool.query(`SELECT ${LESSON_COLS} FROM memory_lesson WHERE id = $1 AND is_deleted = false`, [id]);
    return r.rows[0] as LessonEntry | undefined;
  }

  async listLessons(category?: string, limit = 50, project?: string): Promise<LessonEntry[]> {
    const where = ["is_deleted = false"];
    const vals: unknown[] = [];
    if (category) { vals.push(category.trim().toLowerCase()); where.push(`category = $${vals.length}`); }
    if (project) { vals.push(project); where.push(`(project = $${vals.length} OR project IS NULL)`); }
    vals.push(limit);
    const r = await this.pool.query(
      `SELECT ${LESSON_COLS} FROM memory_lesson WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT $${vals.length}`, vals);
    return r.rows as LessonEntry[];
  }

  async searchLessons(query: string, limit = 20): Promise<LessonEntry[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const r = await this.pool.query(`SELECT ${LESSON_COLS} FROM memory_lesson WHERE is_deleted = false`);
    return (r.rows as LessonEntry[])
      .map((entry) => {
        const text = `${entry.rule} ${entry.category}`.toLowerCase();
        return { entry, score: terms.filter((t) => text.includes(t)).length / terms.length };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entry);
  }

  async deleteLesson(id: string): Promise<boolean> {
    return this.withTransaction(async (q) => {
      let up = await q("UPDATE memory_lesson SET is_deleted = true WHERE id = $1 AND is_deleted = false RETURNING id", [id]);
      if (!up.length && id.length < 36) {
        const matches = await q<{ id: string }>("SELECT id FROM memory_lesson WHERE id LIKE $1 AND is_deleted = false", [`${id}%`]);
        if (matches.length === 1) {
          up = await q("UPDATE memory_lesson SET is_deleted = true WHERE id = $1 AND is_deleted = false RETURNING id", [matches[0].id]);
          if (up.length) await q("INSERT INTO memory_event (event_type, memory_type, memory_key) VALUES ('delete', 'lesson', $1)", [matches[0].id]);
          return true;
        }
      }
      if (up.length) await q("INSERT INTO memory_event (event_type, memory_type, memory_key) VALUES ('delete', 'lesson', $1)", [id]);
      return up.length > 0;
    });
  }

  // ─── audit and stats ──────────────────────────────────────────────

  async listEvents(limit = 50): Promise<MemoryEvent[]> {
    const r = await this.pool.query(
      `SELECT id, event_type, memory_type, memory_key, detail as details, ${ts("created_at")} as created_at
       FROM memory_event ORDER BY id DESC LIMIT $1`, [limit]);
    return r.rows as MemoryEvent[];
  }

  async stats(): Promise<{ semantic: number; lessons: number; events: number }> {
    const r = await this.pool.query(
      `SELECT (SELECT count(*) FROM memory_fact)::int as semantic,
              (SELECT count(*) FROM memory_lesson WHERE is_deleted = false)::int as lessons,
              (SELECT count(*) FROM memory_event)::int as events`);
    return r.rows[0];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
