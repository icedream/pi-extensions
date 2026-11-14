// Unit tests for merge.mjs against real repositories. Run from pi-commit-attribution/: node --test merge.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { committedMergeState, mergeState, pendingMergeState } from "./merge.mjs";

/** The environment without any hook injection, so a commit in a test never runs the attribution farm. */
function cleanEnv() {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key) || key === "PI_ATTR") delete env[key];
	}
	return env;
}

/**
 * Runs git in `cwd` with a fixed identity, no signing and no hooks. Throws unless `allowFail` is set.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ allowFail?: boolean }} [options]
 */
function git(cwd, args, { allowFail = false } = {}) {
	const run = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		encoding: "utf8",
		env: cleanEnv(),
	});
	if (run.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
	return run;
}

/** @returns {string} a repository on main with one commit */
function repo() {
	const dir = mkdtempSync(join(tmpdir(), "pi-merge-test-"));
	git(dir, ["init", "-q", "-b", "main", "."]);
	writeFileSync(join(dir, "base.txt"), "base\n");
	git(dir, ["add", "base.txt"]);
	git(dir, ["commit", "-q", "-m", "chore: base"]);
	return dir;
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} text
 * @param {string} message
 */
function commitFile(dir, name, text, message) {
	writeFileSync(join(dir, name), text);
	git(dir, ["add", name]);
	git(dir, ["commit", "-q", "-m", message]);
}

/**
 * main and side both change base.txt, so merging side conflicts.
 * @param {string} dir
 */
function divergeBase(dir) {
	git(dir, ["checkout", "-q", "-b", "side"]);
	commitFile(dir, "base.txt", "side edit\n", "feat: side edits base");
	git(dir, ["checkout", "-q", "main"]);
	commitFile(dir, "base.txt", "main edit\n", "feat: main edits base");
}

test("a clean merge git made itself is not the agent's", () => {
	const dir = repo();
	try {
		git(dir, ["checkout", "-q", "-b", "side"]);
		commitFile(dir, "side.txt", "side\n", "feat: side");
		git(dir, ["checkout", "-q", "main"]);
		commitFile(dir, "main.txt", "main\n", "feat: main");
		git(dir, ["merge", "-q", "--no-ff", "-m", "Merge side", "side"]);
		assert.equal(committedMergeState(dir, "HEAD"), "clean");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a conflict resolved by hand makes the merge the agent's", () => {
	const dir = repo();
	try {
		divergeBase(dir);
		git(dir, ["merge", "-q", "--no-ff", "-m", "Merge side", "side"], { allowFail: true });
		writeFileSync(join(dir, "base.txt"), "resolved\n");
		git(dir, ["add", "base.txt"]);
		git(dir, ["commit", "-q", "--no-edit"]);
		assert.equal(committedMergeState(dir, "HEAD"), "authored");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a clean merge edited before it is committed is the agent's", () => {
	const dir = repo();
	try {
		git(dir, ["checkout", "-q", "-b", "side"]);
		commitFile(dir, "side.txt", "side\n", "feat: side");
		git(dir, ["checkout", "-q", "main"]);
		git(dir, ["merge", "-q", "--no-ff", "--no-commit", "side"]);
		assert.equal(pendingMergeState(dir), "clean", "git's own result, nothing added yet");
		writeFileSync(join(dir, "extra.txt"), "hand written\n");
		git(dir, ["add", "extra.txt"]);
		assert.equal(pendingMergeState(dir), "authored");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an ordinary commit is not a merge", () => {
	const dir = repo();
	try {
		commitFile(dir, "more.txt", "more\n", "feat: more");
		assert.equal(pendingMergeState(dir), "not-merge");
		assert.equal(committedMergeState(dir, "HEAD"), "not-merge");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("only two-parent merges can be clean, and an unknown parent is never guessed at", () => {
	const dir = repo();
	try {
		const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
		const tree = git(dir, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
		assert.equal(mergeState(dir, [head], tree), "not-merge");
		assert.equal(mergeState(dir, [head, head, head], tree), "authored", "octopus merges keep their lines");
		assert.equal(mergeState(dir, ["0".repeat(40), head], tree), "authored", "git cannot recompute it");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
