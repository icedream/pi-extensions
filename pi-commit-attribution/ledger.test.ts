/**
 * A ledger is only as good as its snapshot diff, so these cases build real repositories in a temp
 * directory and check which paths a session would be charged with. The status letters come straight
 * from `git status --porcelain -z`, and a path whose letters changed counts as touched even when the
 * path itself did not.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendEntries, diffSnapshot, ledgerPath, prune, readEntries, snapshot, unclaimedPaths } from "./ledger.ts";

function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-attribution-ledger-"));
	const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	run("init", "-q", ".");
	run("config", "user.name", "Dev");
	run("config", "user.email", "dev@example.com");
	run("config", "commit.gpgsign", "false");
	writeFileSync(join(dir, "seed.txt"), "seed\n");
	run("add", "seed.txt");
	run("commit", "-q", "-m", "chore: seed");
	return dir;
}

const TRAILER = "Assisted-by: pi 1.4.0 / Qwen 3.8 Flash Next (local, self-hosted, Strata)";

test("an untracked file, a staged edit and a committed file each read as they should", () => {
	const dir = repo();
	try {
		writeFileSync(join(dir, "new.txt"), "new\n");
		const untracked = snapshot(dir);
		assert.equal(untracked.get("new.txt"), "??");
		assert.equal(untracked.has("seed.txt"), false, "a clean file is not part of a delta");

		writeFileSync(join(dir, "new.txt"), "new2\n");
		execFileSync("git", ["add", "new.txt"], { cwd: dir, stdio: "pipe" });
		assert.equal(snapshot(dir).get("new.txt"), "A ");

		execFileSync("git", ["commit", "-q", "-m", "feat: add new file"], { cwd: dir, stdio: "pipe" });
		assert.equal(snapshot(dir).has("new.txt"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the diff names the paths a session is responsible for", () => {
	const previous = new Map([
		["kept.txt", "M "],
		["gone.txt", "??"],
		["quiet.txt", "M "],
	]);
	const next = new Map([
		["kept.txt", "MM"],
		["added.txt", "A "],
		["quiet.txt", "M "],
	]);
	assert.deepEqual(diffSnapshot(previous, next), ["added.txt", "gone.txt", "kept.txt"]);
});

test("a path another session claimed is not claimed twice", () => {
	const entries = [{ t: 5_000, session: "child", trailer: TRAILER, files: ["src/svc.go"] }];
	assert.deepEqual(unclaimedPaths(["src/svc.go", "src/main.go"], entries, "parent"), ["src/main.go"]);
	// The claiming session itself may record the same path again after another edit.
	assert.deepEqual(unclaimedPaths(["src/svc.go"], entries, "child"), ["src/svc.go"]);
});

test("entries round-trip, and a burst of paths is split into one append each", () => {
	const dir = repo();
	try {
		const many = Array.from({ length: 145 }, (_unused, index) => `src/file-${index}.ts`);
		const lines = appendEntries(dir, { t: Date.now(), session: "s-1", trailer: TRAILER }, many);
		assert.equal(lines, 3);
		const entries = readEntries(dir);
		assert.equal(entries.length, 3);
		assert.deepEqual(
			entries.map((entry) => entry.files.length),
			[60, 60, 25],
		);
		assert.ok(entries.every((entry) => entry.truncated === true));
		assert.equal(entries[0].files[0], "src/file-0.ts");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a read since a timestamp ignores older sessions", () => {
	const dir = repo();
	try {
		appendEntries(dir, { t: 1_000, session: "old", trailer: TRAILER }, ["a.ts"]);
		appendEntries(dir, { t: 5_000, session: "new", trailer: TRAILER }, ["b.ts"]);
		assert.deepEqual(
			readEntries(dir, 2_000).map((entry) => entry.session),
			["new"],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pruning drops stale lines and leaves a line a torn writer left unreadable", () => {
	const dir = repo();
	try {
		appendEntries(dir, { t: Date.now() - 30 * 24 * 60 * 60 * 1000, session: "stale", trailer: TRAILER }, ["a.ts"]);
		appendEntries(dir, { t: Date.now(), session: "fresh", trailer: TRAILER }, ["b.ts"]);
		appendFileSync(ledgerPath(dir), `{"trailer":\n`);
		const report = prune(dir);
		assert.equal(report.removed, 2, "the stale line and the torn line");
		assert.deepEqual(
			readEntries(dir).map((entry) => entry.session),
			["fresh"],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
