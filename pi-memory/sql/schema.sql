-- Shared pi memory store. Three tables mirroring @samfp/pi-memory's SQLite schema, with the
-- additions needed once more than one machine writes. No extensions: at this corpus size the
-- package's own substring search and client-side cosine are the behaviour being preserved.

SET ROLE pi_memory;

CREATE TABLE IF NOT EXISTS memory_fact (
  key            text PRIMARY KEY,
  value          text NOT NULL,
  confidence     real NOT NULL DEFAULT 0.8,
  source         text NOT NULL DEFAULT 'consolidation',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_accessed  timestamptz,
  -- Dimensions are recorded because the existing corpus is 384-dim while the embedder
  -- default is 512; mixed vectors must stay visible rather than fail silently.
  embedding      bytea,
  embedding_dims int
);

CREATE TABLE IF NOT EXISTS memory_lesson (
  id          text PRIMARY KEY,
  -- SQLite has no natural key here, id is a runtime randomUUID, so this hash is what makes
  -- import re-runnable and lets dedup be enforced by the database instead of by a read.
  rule_hash   text NOT NULL UNIQUE,
  rule        text NOT NULL,
  category    text NOT NULL DEFAULT 'general',
  source      text NOT NULL DEFAULT 'consolidation',
  negative    boolean NOT NULL DEFAULT false,
  is_deleted  boolean NOT NULL DEFAULT false,
  project     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_event (
  id           serial PRIMARY KEY,
  -- Original SQLite rowid, so a re-run of the importer cannot duplicate the audit trail.
  source_id    integer UNIQUE,
  event_type   text NOT NULL,
  memory_type  text NOT NULL,
  memory_key   text NOT NULL,
  detail       text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_fact_updated_idx ON memory_fact (updated_at DESC);
CREATE INDEX IF NOT EXISTS memory_lesson_active_idx ON memory_lesson (category, created_at DESC)
  WHERE is_deleted = false;
