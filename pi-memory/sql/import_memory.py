#!/usr/bin/env python3
"""Copy a pi-memory SQLite snapshot into the shared Postgres store.

    ./import_memory.py /tmp/pimem-snapshot-<ts>.db            # first load
    ./import_memory.py <snapshot> --allow-nonempty            # pick up rows added since
    ./import_memory.py <snapshot> --dry-run                   # show what would go

Re-runnable by construction: everything lands in temp tables first and is inserted with
ON CONFLICT DO NOTHING, keyed on fact key, lesson id plus rule hash, and the original
event rowid kept as source_id.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import sqlite3

NS, POD, DB, ROLE = "postgres", "pg-2", "pimemory", "pi_memory"
TABLES = ("memory_fact", "memory_lesson", "memory_event")


def cell(v, *, bytea=False):
    """Render one value in PostgreSQL COPY text format."""
    if v is None:
        return r"\N"
    if bytea:
        # COPY text format eats one level of backslashes, so bytea's hex marker goes in doubled.
        return r"\\x" + bytes(v).hex() if isinstance(v, (bytes, bytearray)) else r"\N"
    if isinstance(v, (bytes, bytearray)):
        v = v.decode("utf-8", "replace")
    s = str(v)
    return (s.replace("\\", "\\\\").replace("\t", r"\t")
             .replace("\n", r"\n").replace("\r", r"\r"))


def utc(ts):
    """SQLite's datetime('now') is naive UTC text. Postgres needs the offset."""
    if not ts:
        return None
    return ts if "+" in ts or ts.endswith("Z") else ts + "+00"


def rows(snapshot: str):
    con = sqlite3.connect(f"file:{snapshot}?mode=ro", uri=True)
    con.text_factory = bytes
    def s(v):
        return v.decode("utf-8", "replace") if isinstance(v, bytes) else v

    facts = []
    for key, value, conf, source, created, updated, accessed, emb in con.execute(
            "select key,value,confidence,source,created_at,updated_at,last_accessed,embedding from semantic"):
        facts.append([cell(s(key)), cell(s(value)), cell(conf), cell(s(source) or "consolidation"),
                      cell(utc(s(created))), cell(utc(s(updated))), cell(utc(s(accessed))),
                      cell(emb, bytea=True) if emb else r"\N",
                      cell(len(emb) // 4) if emb else r"\N"])

    lessons = []
    for id_, rule, cat, source, neg, deleted, created, project in con.execute(
            "select id,rule,category,source,negative,is_deleted,created_at,project from lessons"):
        rule_txt = s(rule)
        lessons.append([cell(s(id_)),
                        cell(hashlib.sha256(rule_txt.encode()).hexdigest()),
                        cell(rule_txt), cell(s(cat) or "general"), cell(s(source) or "consolidation"),
                        cell("t" if neg else "f"), cell("t" if deleted else "f"),
                        cell(utc(s(created))), cell(s(project))])

    events = []
    for id_, etype, mtype, mkey, details, created in con.execute(
            "select id,event_type,memory_type,memory_key,details,created_at from events"):
        events.append([cell(id_), cell(etype), cell(mtype), cell(mkey),
                       cell(s(details) or ""), cell(utc(s(created)))])
    con.close()
    return {"semantic": len(facts), "lessons": len(lessons), "events": len(events)}, facts, lessons, events


COPY = {
    "memory_fact": "key, value, confidence, source, created_at, updated_at, last_accessed, embedding, embedding_dims",
    "memory_lesson": "id, rule_hash, rule, category, source, negative, is_deleted, created_at, project",
    "memory_event": "source_id, event_type, memory_type, memory_key, detail, created_at",
}
UPSERT = {
    "memory_fact": "insert into memory_fact ({c}) select {c} from tmp_fact on conflict (key) do nothing;",
    "memory_lesson": "insert into memory_lesson ({c}) select {c} from tmp_lesson "
                     "on conflict (id) do nothing;",
    "memory_event": "insert into memory_event ({c}) select {c} from tmp_event "
                    "on conflict (source_id) do nothing;",
}


def sql_text(snapshot: str) -> tuple[str, dict]:
    counts, facts, lessons, events = rows(snapshot)
    tmp = {"memory_fact": "tmp_fact", "memory_lesson": "tmp_lesson", "memory_event": "tmp_event"}
    data = {"memory_fact": facts, "memory_lesson": lessons, "memory_event": events}
    out = ["begin;"]
    for t in TABLES:
        out.append(f"drop table if exists {tmp[t]};")
        out.append(f"create temp table {tmp[t]} (like {t} including defaults);")
        out.append(f"copy {tmp[t]} ({COPY[t]}) from stdin with (format text);")
        out.extend("\t".join(r) for r in data[t])
        out.append("\\.")
        out.append(UPSERT[t].format(c=COPY[t]))
        out.append(f"drop table {tmp[t]};")
    out.append("commit;")
    return "\n".join(out) + "\n", counts


def psql(sql: str, *args: str) -> str:
    cmd = ["kubectl", "-n", NS, "exec", "-i", POD, "--",
           "psql", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", *args]
    p = subprocess.run(cmd, input=sql, text=True, capture_output=True)
    if p.returncode:
        sys.exit("psql failed:\n" + (p.stdout + p.stderr)[-2000:])
    return p.stdout


COUNTS = ("select 'memory_fact', count(*) from memory_fact union all "
          "select 'memory_lesson', count(*) from memory_lesson union all "
          "select 'memory_event', count(*) from memory_event;")


def counts_now() -> list[str]:
    lines = psql(COUNTS, "-At").strip().splitlines()
    return [ln for ln in lines if "|" in ln]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("snapshot")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-nonempty", action="store_true")
    a = ap.parse_args()
    if not shutil.which("kubectl"):
        sys.exit("kubectl is required")
    if not os.path.exists(a.snapshot):
        sys.exit(f"no such snapshot: {a.snapshot}")

    before = counts_now()
    nonempty = any(int(r.split("|")[1]) for r in before)
    if nonempty and not a.allow_nonempty:
        sys.exit("target already holds rows: " + ", ".join(before) +
                 "\nre-run with --allow-nonempty to add only what is missing")

    sql, counts = sql_text(a.snapshot)
    print(f"snapshot rows: {counts}")
    print(f"target before : {', '.join(before)}")
    if a.dry_run:
        print(f"--dry-run: would send {len(sql.splitlines())} lines")
        return
    psql(sql)
    after = counts_now()
    print(f"target after  : {', '.join(after)}")


if __name__ == "__main__":
    main()
