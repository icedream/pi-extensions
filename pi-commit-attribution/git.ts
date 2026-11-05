/**
 * Read-only git calls the extension and the hook share.
 *
 * `--no-optional-locks` goes before the subcommand: it is a git flag, not a `status` flag, and asking
 * `status` for it is a usage error. The flag matters because a session snapshots the working tree while
 * another process may hold the index lock, and an attribution helper must never be the reason a
 * repository's index gets written or a command fails.
 */

import { spawnSync } from "node:child_process";

export interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number;
}

export function git(args: string[], cwd?: string, input?: string): GitResult {
	const run = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	const stdout = run.stdout ?? "";
	return {
		ok: run.status === 0,
		stdout,
		stderr: run.stderr ?? (run.error ? String(run.error) : ""),
		code: run.status ?? 128,
	};
}
