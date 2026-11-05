/**
 * The farm is written into a temporary directory here. What matters to the repository is that every hook
 * name git might call is present, that our file is the only thing in a hooks directory we ever
 * overwrite, and that the generated hook keeps the repository's own hook callable.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CHAINED_HOOKS, farmIsCurrent, hookScript, inventory, MARKER, removeFarm, repoHookDirs, UNSHIMMED_HOOKS, writeFarm } from "./hooks.ts";

const INPUT = {
	applyPath: "/home/dev/.pi/agent/attribution/apply.mjs",
	home: "/home/dev/.pi/agent/attribution",
	configPath: "/home/dev/.pi/agent/attribution.json",
	modelsPath: "/home/dev/.pi/agent/models.json",
};

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-attribution-hooks-"));
}

test("every hook git may call is written, executable, and ours", () => {
	const dir = tempDir();
	try {
		const written = writeFarm(dir, INPUT);
		assert.equal(written.length, CHAINED_HOOKS.length);
		for (const name of CHAINED_HOOKS) {
			const path = join(dir, name);
			assert.ok(existsSync(path), `${name} missing`);
			assert.equal(statSync(path).mode & 0o111, 0o111, `${name} not executable`);
			const body = readFileSync(path, "utf8");
			assert.ok(body.includes(MARKER), name);
			assert.ok(body.includes(`git config --file "$common/config" --get core.hooksPath`), `${name} does not look for the repository's own hook`);
			assert.ok(body.includes(`"$dir/${name}" "$@"`), `${name} does not pass the hook's arguments through`);
			if (name === "prepare-commit-msg") assert.ok(body.includes(`node "${INPUT.applyPath}" "${name}" "$@"`), name);
			else if (name === "commit-msg") assert.ok(body.includes(`grep -qi '^Assisted-by:' "$1"`), name);
			else assert.ok(!body.includes(`node "${INPUT.applyPath}"`), `${name} should not start node`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rewriting an unchanged farm does nothing, and a changed one is refreshed", () => {
	const dir = tempDir();
	try {
		writeFarm(dir, INPUT);
		assert.deepEqual(writeFarm(dir, INPUT), []);
		assert.equal(farmIsCurrent(dir, INPUT), true);
		assert.equal(farmIsCurrent(dir, { ...INPUT, applyPath: "/moved/apply.mjs" }), false);
		// Only the two hooks that reach Node name the apply path, so only those two are rewritten.
		assert.deepEqual(writeFarm(dir, { ...INPUT, applyPath: "/moved/apply.mjs" }), ["commit-msg", "prepare-commit-msg"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("removal takes only our files, and leaves a hook we did not write", () => {
	const dir = tempDir();
	try {
		writeFarm(dir, INPUT);
		writeFileSync(join(dir, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const removed = removeFarm(dir);
		assert.equal(removed.length, CHAINED_HOOKS.length - 1);
		assert.equal(readFileSync(join(dir, "pre-commit"), "utf8"), "#!/bin/sh\nexit 1\n");
		rmSync(join(dir, "pre-commit"));
		assert.deepEqual(removeFarm(dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the receive-side names are named with the reason they are not shimmed", () => {
	const report = inventory([
		{ name: "pre-commit", path: join("/repo/.githooks", "pre-commit") },
		{ name: "update", path: join("/repo/.githooks", "update") },
		{ name: "push-to-checkout", path: join("/repo/.githooks", "push-to-checkout") },
	]);
	assert.deepEqual(report.declared.sort(), ["pre-commit", "push-to-checkout", "update"]);
	assert.ok(report.unchained.update, "update is reported");
	assert.ok(report.unchained["push-to-checkout"], "push-to-checkout is reported");
	assert.equal(report.unchained["pre-commit"], undefined, "pre-commit is chained, so it is not a finding");
	for (const [name, reason] of Object.entries(UNSHIMMED_HOOKS)) assert.ok(reason.length > 0, name);
});

test("repository hooks are looked for before the default ones", () => {
	const dirs = repoHookDirs({
		top: "/repo",
		gitDir: "/repo/.git/worktrees/wt",
		commonDir: "/repo/.git",
		repoHooksPath: ".githooks",
		globalHooksPath: "/home/dev/.git-hooks",
	});
	assert.deepEqual(dirs, ["/repo/.githooks", "/home/dev/.git-hooks", "/repo/.git/worktrees/wt/hooks", "/repo/.git/hooks"]);
	// git would not run a second copy of the same hook: the chain stops at the first hit.
	assert.equal(dirs.filter((dir) => dir === "/repo/.git/hooks").length, 1);
});

test("the script names the hook it was generated for", () => {
	const script = hookScript("pre-commit", INPUT);
	assert.match(script, /^#!\/bin\/sh/);
	assert.match(script, /The repository's own hook for "pre-commit"/);
	assert.ok(!script.includes(`node "${INPUT.applyPath}"`), "a hook that only chains should not start node");
	assert.match(hookScript("commit-msg", INPUT), /grep -qi '\^Assisted-by:'/);
	// One file per hook name, so the chain is written out for that name rather than derived at run time.
	assert.match(hookScript("pre-push", INPUT), /"\$dir\/pre-push" "\$@"/);
});

test("chaining can be turned off only deliberately", () => {
	const off = hookScript("pre-commit", { ...INPUT, chainRepoHooks: false });
	assert.ok(!off.includes("git rev-parse --show-toplevel"), off);
});
