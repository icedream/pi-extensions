import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "./store.ts";

const LOCK = "lock";
const HOLDER = "holder.json";
const DEAD_PID = 0x7ffffffe;

function freshStore(): { store: SessionStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "slot-sharing-store-"));
	return { store: new SessionStore(dir), dir };
}

/** Stand in for another Pi process that is holding the lock right now. */
function plantLock(dir: string, holder: { pid: number; at: number } | undefined): string {
	const lock = join(dir, LOCK);
	mkdirSync(lock, { mode: 0o700 });
	if (holder) writeFileSync(join(lock, HOLDER), JSON.stringify(holder), { mode: 0o600 });
	return lock;
}

test("a busy lock is a result, not an exception", async () => {
	const { store, dir } = freshStore();
	const lock = plantLock(dir, { pid: process.pid, at: Date.now() });
	let ran = false;
	const outcome = await store.withLock({ waitMs: 150, staleMs: 120_000 }, () => {
		ran = true;
		return Promise.resolve("nope");
	});
	assert.equal(outcome.ok, false);
	assert.equal(ran, false, "nothing may run without the lock");
	assert.match(outcome.reason ?? "", /pid/);
	assert.ok(existsSync(lock), "a live holder's lock is left alone");
	rmSync(dir, { recursive: true, force: true });
});

test("waiting out a competing session gets us the lock", async () => {
	const { store, dir } = freshStore();
	const order: string[] = [];
	// Two sessions reach their next turn at the same moment: the second must queue, not fail.
	const first = store.withLock({ waitMs: 1_000, staleMs: 120_000 }, async () => {
		order.push("first");
		await new Promise((resolve) => setTimeout(resolve, 150));
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	const second = store.withLock({ waitMs: 1_000, staleMs: 120_000 }, async () => {
		order.push("second");
	});
	const both = await Promise.all([first, second]);
	assert.deepEqual(both.map((o) => o.ok), [true, true], both.map((o) => o.reason ?? "").join("; "));
	assert.deepEqual(order, ["first", "second"]);
	assert.ok(!existsSync(join(dir, LOCK)), "both released");
	rmSync(dir, { recursive: true, force: true });
});

test("a lock left by a process that is gone is taken over", async () => {
	const { store, dir } = freshStore();
	plantLock(dir, { pid: DEAD_PID, at: Date.now() - 600_000 });
	const outcome = await store.withLock({ waitMs: 0, staleMs: 120_000 }, () => Promise.resolve(7));
	assert.equal(outcome.ok, true);
	assert.equal(outcome.value, 7);
	rmSync(dir, { recursive: true, force: true });
});

test("a lock that only just appeared is not stolen because its holder is unreadable", async () => {
	const { store, dir } = freshStore();
	// The gap between mkdir and the holder write: claiming this would put two sessions in at once.
	const lock = plantLock(dir, undefined);
	const outcome = await store.withLock({ waitMs: 100, staleMs: 120_000 }, () => Promise.resolve("stolen"));
	assert.equal(outcome.ok, false);
	assert.ok(existsSync(lock), "the other session's mkdir is still there");
	rmSync(dir, { recursive: true, force: true });
});

test("an unclaimed lock older than the stale window is a corpse", async () => {
	const { store, dir } = freshStore();
	const lock = plantLock(dir, undefined);
	const old = new Date(Date.now() - 600_000);
	utimesSync(lock, old, old);
	const outcome = await store.withLock({ waitMs: 0, staleMs: 120_000 }, () => Promise.resolve("taken"));
	assert.equal(outcome.ok, true);
	assert.equal(outcome.value, "taken");
	rmSync(dir, { recursive: true, force: true });
});

test("a lock taken over while we worked is not ours to delete", async () => {
	const { store, dir } = freshStore();
	const outcome = await store.withLock({ waitMs: 100, staleMs: 120_000 }, async () => {
		writeFileSync(join(dir, LOCK, HOLDER), JSON.stringify({ pid: DEAD_PID, at: Date.now() }), { mode: 0o600 });
	});
	assert.equal(outcome.ok, true);
	assert.ok(existsSync(join(dir, LOCK)), "the new holder keeps its lock");
	rmSync(dir, { recursive: true, force: true });
});

test("a real failure still surfaces, and still releases", async () => {
	const { store, dir } = freshStore();
	await assert.rejects(
		store.withLock({ waitMs: 100, staleMs: 120_000 }, () => Promise.reject(new Error("server said no"))),
		/server said no/,
	);
	assert.ok(!existsSync(join(dir, LOCK)));
	rmSync(dir, { recursive: true, force: true });
});

test("index and owner records survive a lock we did not hold", async () => {
	const { store, dir } = freshStore();
	plantLock(dir, { pid: process.pid, at: Date.now() });
	const index = store.readIndex();
	index.records["s|m"] = { record: { sessionId: "s", modelRef: "m", fileName: "pi-x.bin", tokens: 1, bytes: 1, savedAt: 1, engineStarted: 0 } };
	store.writeIndex(index);
	store.writeOwner({ key: "s|m", sessionId: "s", pid: process.pid, at: 1 });
	assert.equal(store.readIndex().records["s|m"]?.record.tokens, 1);
	assert.equal(store.readOwner()?.key, "s|m");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, LOCK, "holder.json"), "utf8")).pid, process.pid, "untouched");
	rmSync(dir, { recursive: true, force: true });
});
