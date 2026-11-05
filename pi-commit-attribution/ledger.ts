/**
 * The ledger: which model changed which file since the last commit.
 *
 * One `Assisted-by:` line for the model that ran `git commit` would be wrong for the commits this
 * extension exists to describe: a parent session plans, subagents write, and a different model may run
 * the commit at the end. Git cannot see that history, so the extension records it: after a turn that
 * could have changed files, a session notes the paths its snapshot found different since the last
 * snapshot and the line that would credit the model running that turn.
 *
 * The file lives at `<git common dir>/pi-attribution/ledger.jsonl`, one JSON object per line, in the
 * repository's own git directory: per repository, shared by its linked worktrees, never in a tracked
 * file, and gone when the repository is. Each line is written in one small append so that a parent and
 * a child session writing at the same moment cannot interleave into one broken line.
 *
 * The hook decides what a commit is credited to, by intersecting these entries with the files the commit
 * actually contains and dropping anything older than the commit it is amending on top of. That filter is
 * in `apply.mjs`, next to the decision that uses it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";

export interface LedgerEntry {
	/** Epoch milliseconds of the observation. */
	t: number;
	session: string;
	/** The finished `Assisted-by:` line, so the hook never has to re-resolve a model name. */
	trailer: string;
	files: string[];
	/** Set when a turn touched more paths than one line could hold. */
	truncated?: boolean;
}

export const LEDGER_SUBPATH = join("pi-attribution", "ledger.jsonl");

/** Paths per line stay under one system write, and a burst of renames should not make one huge record. */
const PATHS_PER_LINE = 60;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LINES = 2000;

export function ledgerPath(commonDir: string): string {
	return join(commonDir, LEDGER_SUBPATH);
}

/** `XY path` porcelain entries, keeping the status letters: a path that stayed dirty but changed state counts. */
export function snapshot(cwd: string): Map<string, string> {
	const run = git(["--no-optional-locks", "status", "--porcelain", "-z", "--no-renames"], cwd);
	const out = new Map<string, string>();
	if (!run.ok) return out;
	for (const entry of run.stdout.split("\0")) {
		if (entry.length < 4) continue;
		out.set(entry.slice(3), entry.slice(0, 2));
	}
	return out;
}

/** Paths a session is responsible for since its previous snapshot. */
export function diffSnapshot(previous: Map<string, string>, next: Map<string, string>): string[] {
	const changed: string[] = [];
	for (const [path, status] of next) {
		const before = previous.get(path);
		if (before === undefined || before !== status) changed.push(path);
	}
	for (const path of previous.keys()) if (!next.has(path)) changed.push(path);
	return changed.sort();
}

/**
 * Drop paths another session already claimed. A parent that snapshots after a subagent's work would
 * otherwise credit that work to its own model as well, and one line per model is the point.
 *
 * @param paths the paths this session found changed
 * @param entries ledger entries read since the session started
 * @param sessionId the session doing the recording
 */
export function unclaimedPaths(paths: string[], entries: LedgerEntry[], sessionId: string): string[] {
	const claimed = new Map<string, number>();
	for (const entry of entries) {
		if (entry.session === sessionId) continue;
		for (const file of entry.files) {
			const seen = claimed.get(file) ?? 0;
			if (entry.t > seen) claimed.set(file, entry.t);
		}
	}
	return paths.filter((path) => !claimed.has(path));
}

export function appendEntries(commonDir: string, entry: Omit<LedgerEntry, "files">, files: string[]): number {
	if (files.length === 0) return 0;
	const path = ledgerPath(commonDir);
	mkdirSync(join(commonDir, "pi-attribution"), { recursive: true });
	const chunks: string[][] = [];
	for (let index = 0; index < files.length; index += PATHS_PER_LINE) chunks.push(files.slice(index, index + PATHS_PER_LINE));
	const lines = chunks.map((chunk) => `${JSON.stringify({ ...entry, files: chunk, ...(chunks.length > 1 ? { truncated: true } : {}) })}\n`);
	appendFileSync(path, lines.join(""));
	return lines.length;
}

export function readEntries(commonDir: string, sinceMs = 0): LedgerEntry[] {
	const path = ledgerPath(commonDir);
	if (!existsSync(path)) return [];
	const out: LedgerEntry[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as LedgerEntry;
			if (typeof entry.t === "number" && entry.t > sinceMs && typeof entry.trailer === "string" && Array.isArray(entry.files)) out.push(entry);
		} catch {
			// A torn line from a concurrent writer is skipped rather than failing the commit.
		}
	}
	return out;
}

/** Drops what no commit can reference any more: older than a week, or beyond the newest 2000 lines. */
export function prune(commonDir: string, now = Date.now()): { removed: number } {
	const path = ledgerPath(commonDir);
	if (!existsSync(path)) return { removed: 0 };
	const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
	const kept = lines.filter((line) => {
		try {
			const entry = JSON.parse(line) as LedgerEntry;
			return typeof entry.t === "number" && now - entry.t <= MAX_AGE_MS;
		} catch {
			return false;
		}
	});
	const trimmed = kept.length > MAX_LINES ? kept.slice(kept.length - MAX_LINES) : kept;
	const removed = lines.length - trimmed.length;
	if (removed > 0) {
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, trimmed.length ? `${trimmed.join("\n")}\n` : "");
		renameSync(tmp, path);
	}
	return { removed };
}

/** Where the ledger for a working directory goes, or nowhere if it is not a repository. */
export function ledgerTarget(cwd: string): string | undefined {
	const run = git(["rev-parse", "--git-common-dir"], cwd);
	if (!run.ok) return undefined;
	const value = run.stdout.trim();
	return value.startsWith("/") ? value : join(cwd, value);
}
