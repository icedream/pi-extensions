/**
 * Whether a merge commit holds anything an agent wrote.
 *
 * git computes a clean merge by itself, so a merge the agent ran and did not touch has a tree equal to
 * `git merge-tree --write-tree` of its two parents. A conflict the agent resolved, or an edit made before
 * the commit, changes the tree. Only that second kind is the agent's work, so only it carries a model line.
 *
 * When git cannot recompute a merge, the answer is `authored`, so the merge keeps the lines it would have had.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const OID = /^[0-9a-f]{40,64}$/;

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
	return spawnSync("git", args, { cwd, encoding: "utf8", env: process.env });
}

/**
 * @param {string} cwd
 * @param {string[]} parents the commit's parents, in order
 * @param {string} tree the tree the commit holds, or would hold
 * @returns {"not-merge" | "clean" | "authored"}
 *   `clean` is a two-parent merge whose tree is git's own automatic result. `authored` is every other
 *   merge, including one git cannot recompute, which keeps the lines it always had.
 */
export function mergeState(cwd, parents, tree) {
	if (parents.length < 2) return "not-merge";
	if (parents.length > 2) return "authored";
	// With conflicts git still prints the tree it would write, and exits 1. That tree differs from any
	// resolution, which is the point.
	const auto = git(cwd, ["merge-tree", "--write-tree", "--no-messages", parents[0], parents[1]]);
	const autoTree = (auto.stdout ?? "").split("\n")[0].trim();
	if (!OID.test(autoTree)) return "authored";
	return autoTree === tree ? "clean" : "authored";
}

/**
 * The state of the merge git is about to commit: MERGE_HEAD and the index. Called from the hooks, so it
 * costs one git call for an ordinary commit, which has no MERGE_HEAD.
 *
 * @param {string} cwd
 */
export function pendingMergeState(cwd) {
	const pathOut = git(cwd, ["rev-parse", "--git-path", "MERGE_HEAD"]).stdout.trim();
	if (!pathOut) return "not-merge";
	const mergeHeadPath = resolve(cwd, pathOut);
	if (!existsSync(mergeHeadPath)) return "not-merge";

	const head = git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).stdout.trim();
	const others = readFileSync(mergeHeadPath, "utf8").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
	const tree = git(cwd, ["write-tree"]).stdout.trim();
	if (!head || !OID.test(tree)) return "authored";
	return mergeState(cwd, [head, ...others], tree);
}

/**
 * The state of a commit that already exists, for the warning that asks whether a trailer went missing.
 *
 * @param {string} cwd
 * @param {string} sha
 */
export function committedMergeState(cwd, sha) {
	const listed = git(cwd, ["rev-list", "--parents", "-n", "1", sha]).stdout.trim().split(/\s+/);
	const parents = listed.slice(1);
	const tree = git(cwd, ["rev-parse", `${sha}^{tree}`]).stdout.trim();
	if (!OID.test(tree)) return "authored";
	return mergeState(cwd, parents, tree);
}
