# Postgres backend

Fork of `@samfp/pi-memory` 1.6.1, kept in this repo so several machines share one memory store.
Everything below is the difference from upstream.

## Why a fork rather than a config option

The upstream store resolves a local file path only, and every method on it is synchronous on
`node:sqlite`'s `DatabaseSync`. A database reached over TCP cannot satisfy a synchronous
interface, so the store became an interface:

- `src/store.ts` exports `interface MemoryStore` (all methods `Promise`-returning) and
  `class SqliteStore implements MemoryStore`.
- `src/pg-store.ts` is `class PostgresStore implements MemoryStore`.
- `index.ts`, `injector.ts`, `consolidator.ts` and `bootstrap.ts` were changed to await. That is
  the whole cost of the fork, roughly 40 call sites, and TypeScript enumerated every one of them.

pi loads `dist/index.js`, an esbuild bundle, so `npm run build` is required after any change.
There is no tsconfig upstream in the published tarball; one is included here and
`npm run typecheck` is the gate.

## Choosing a backend

```json
{
  "packages": ["./pi-memory/dist/index.js"],
  "pi-memory": {
    "dsn": "postgresql://pi_memory:pw@172.24.1.20:31432/pimemory?sslmode=verify-ca&sslrootcert=%2Fhome%2Fme%2F.cnpg-pg-ca.crt"
  }
}
```

Precedence is `PI_MEMORY_DSN`, then `pi-memory.dsn` in global settings, then in
`{cwd}/.pi/settings.json`. No DSN means the local SQLite file, which is upstream's behaviour.

**There is no fallback from Postgres to the file.** If a DSN is configured and unreachable the
extension reports it and leaves the store uninitialised for that session. Falling back would
resume writing to a stale copy, and old high-confidence facts in that copy would later shadow
newer shared ones with nothing in the way.

Project-level `localPath` outranks a global DSN in upstream's resolver, so any project
`.pi/settings.json` carrying it wins for that checkout.

## Schema

`sql/schema.sql` matches the plan at `~/.pi/agent/plans/2026-11-12-shared-pi-memory/`. Three
tables, no extensions. Two columns are additions rather than copies, and both exist because more
than one machine writes:

- `memory_lesson.rule_hash`, unique. Upstream's lesson `id` is a runtime `randomUUID()`, so there
  is no natural key, and its dedup is a read followed by a write. The unique index turns the
  concurrent case, two clients inserting the same rule, into a duplicate that is caught instead of
  stored twice.
- `memory_event.source_id`, unique. The rowid from the SQLite table this store was imported from,
  which is what makes the importer re-runnable.

## Where behaviour differs, and why

- **Ranking.** SQLite prefers FTS5 `bm25` and falls back to a matched-term fraction. Postgres uses
  the fraction always. At a few hundred rows the two agree on the queries these tools make, and
  `ts_rank` would not be bm25 either, so a tsvector port would be a second ranking to maintain
  without buying parity. Overlap between the two orderings is printed by `npm run test:pg`.
- **Timestamps** are returned as SQLite's `YYYY-MM-DD HH:MM:SS` text via `to_char`, so callers
  cannot tell the backends apart.
- **TLS.** `sslmode` and `sslrootcert` are stripped from the connection string before it reaches
  node-postgres, which since 8.16 parses them itself and treats `verify-ca` as `verify-full`
  unless the string says `uselibpqcompat=true`. Letting both the driver and this code decide gave
  `ERR_TLS_CERT_ALTNAME_INVALID` against a CNPG server certificate that has `CN=pg-rw` and no SAN
  at all. TLS is configured only in `tlsFor()`.

## Checking it

```sh
# one run, both backends, same calls; needs a snapshot and a DSN
sqlite3 ~/.pi/memory/memory.db ".backup /tmp/parity-src.db"
PI_MEMORY_DSN="$(cat ~/.pi/agent/secrets/pimemory.dsn)" SQLITE_SNAPSHOT=/tmp/parity-src.db npm run test:pg

# what session_start and the tools would produce against the shared store
PI_MEMORY_DSN="$(cat ~/.pi/agent/secrets/pimemory.dsn)" npx tsx test/inject-probe.mts
```

`test/parity.ts` asserts exact agreement on counts, single reads, prefix lists, the dedup rules
and the confidence rule. It compares search results as sets because ranking differs by design. It
writes under the key `paritytest.probe` and category `paritytest`, then deletes them, including
the audit rows it created.

## Rebasing on upstream

`diff -r src/ <upstream>/src/` after copying a new release over, then reapply in this order: the
`MemoryStore` interface and `SqliteStore` rename in `store.ts`, the awaits in the four consumers,
`resolveDsn` and backend selection plus `dsn` in the known-keys list in `index.ts`. Expect
conflict wherever upstream touches the store surface.
