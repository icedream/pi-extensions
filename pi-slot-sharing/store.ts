/**
 * On-disk state for pi-slot-sharing: the per-server index of saved conversations, the record of who
 * holds the engine's single slot, and the lock that keeps two Pi processes from deciding at the same time.
 *
 * Everything lives under one directory (default `~/.pi/agent/slot-sharing`). The session files
 * themselves live on the server, in its `slot_save_path`; we only keep the metadata needed to decide
 * whether reading one is possible.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyIndex, pidLooksAlive, slotFilenameProblem, type SessionIndex, type SlotOwner } from "./sessions.ts";

const INDEX_FILE = "index.json";
const OWNER_FILE = "owner.json";
const LOCK_DIR = "lock";
const HOLDER_FILE = "holder.json";

/** Poll spacing while waiting out a competing session: grows to `RETRY_MAX_MS` and stays there. */
const RETRY_BASE_MS = 50;
const RETRY_MAX_MS = 500;
/** How many corpses we are willing to clear before deciding something is wedged. */
const MAX_DISPLACES = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface LockOutcome<T> {
	/** False means the lock stayed somebody else's for the whole wait; nothing ran. */
	ok: boolean;
	value?: T;
	/** Why it was not obtained, for a note that has to explain a skipped save or restore. */
	reason?: string;
}

function atomicWrite(path: string, data: string): void {
	const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export class SessionStore {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private ensure(): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
	}

	readIndex(): SessionIndex {
		const loaded = readJson<SessionIndex>(join(this.dir, INDEX_FILE));
		if (!loaded || loaded.version !== 1 || typeof loaded.records !== "object" || loaded.records === null) return emptyIndex();
		for (const [key, entry] of Object.entries(loaded.records)) {
			const problem = entry?.record ? slotFilenameProblem(entry.record.fileName) : "record missing";
			if (problem) delete loaded.records[key];
		}
		return loaded;
	}

	writeIndex(index: SessionIndex): void {
		this.ensure();
		atomicWrite(join(this.dir, INDEX_FILE), JSON.stringify(index, null, "\t"));
	}

	readOwner(): SlotOwner | undefined {
		const owner = readJson<SlotOwner>(join(this.dir, OWNER_FILE));
		if (!owner || typeof owner.key !== "string" || typeof owner.at !== "number") return undefined;
		return owner;
	}

	writeOwner(owner: SlotOwner): void {
		this.ensure();
		atomicWrite(join(this.dir, OWNER_FILE), JSON.stringify(owner, null, "\t"));
	}

	clearOwner(): void {
		rmSync(join(this.dir, OWNER_FILE), { force: true });
	}

	/**
	 * Run `fn` while holding the server-wide lock. `mkdir` is atomic, so it is the mutex; a holder that is
	 * gone (dead pid, or older than `staleMs`) is displaced so a crashed Pi session cannot wedge the rest.
	 * This is best-effort arbitration between cooperating processes, not a security boundary.
	 *
	 * Contention is the normal case — several sessions reach their next turn at nearly the same moment, and
	 * the winner holds the lock across a save or restore that takes seconds — so a busy lock is a result,
	 * not an exception: the caller skips its swap and the session prefills as it would have anyway. We wait
	 * up to `waitMs` first, because waiting costs the length of one HTTP call and giving up costs a full
	 * re-prefill.
	 */
	async withLock<T>(opts: { waitMs: number; staleMs: number }, fn: () => Promise<T>): Promise<LockOutcome<T>> {
		this.ensure();
		const lock = join(this.dir, LOCK_DIR);
		const acquired = await this.acquire(lock, opts.waitMs, opts.staleMs);
		if (acquired !== true) return { ok: false, reason: `${acquired} (waited ${opts.waitMs}ms)` };
		try {
			return { ok: true, value: await fn() };
		} finally {
			this.release(lock);
		}
	}

	/** True on success, otherwise why we stopped waiting. */
	private async acquire(lock: string, waitMs: number, staleMs: number): Promise<true | string> {
		const deadline = Date.now() + Math.max(0, waitMs);
		let displaced = 0;
		for (let attempt = 0; ; attempt++) {
			try {
				mkdirSync(lock, { mode: 0o700 });
				writeFileSync(join(lock, HOLDER_FILE), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const why = this.whyHeld(lock, staleMs);
				if (why === undefined) {
					// The holder is gone; its lock is a corpse, not a claim.
					if (displaced++ >= MAX_DISPLACES) return `lock kept reappearing under a dead pid`;
					rmSync(lock, { recursive: true, force: true });
					continue;
				}
				const remaining = deadline - Date.now();
				if (remaining <= 0) return why;
				await sleep(Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS, remaining));
			}
		}
	}

	/** Why the lock is somebody else's, or undefined when it is ours to take. */
	private whyHeld(lock: string, staleMs: number): string | undefined {
		const holder = readJson<{ pid?: number; at?: number }>(join(lock, HOLDER_FILE));
		if (!holder || typeof holder.at !== "number") {
			// No readable holder: either a crash between `mkdir` and the holder write, or a corpse. The
			// directory's own age is the only clock, and a lock that just appeared is not ours to steal.
			const age = this.ageMs(lock);
			if (age === undefined) return undefined;
			if (age <= staleMs) return `lock opened ${Math.round(age)}ms ago has no holder record yet`;
			return undefined;
		}
		if (Date.now() - holder.at <= staleMs) return `held by pid ${holder.pid ?? "?"}`;
		return pidLooksAlive(holder.pid ?? -1, process.kill) ? `held by pid ${holder.pid ?? "?"} for longer than ${staleMs}ms` : undefined;
	}

	private ageMs(path: string): number | undefined {
		try {
			return Date.now() - statSync(path).mtimeMs;
		} catch {
			return undefined;
		}
	}

	private release(lock: string): void {
		// Only clear a lock we still hold. If it was taken over while `fn` ran, removing it would let a
		// third session in behind the new holder.
		const holder = readJson<{ pid?: number }>(join(lock, HOLDER_FILE));
		if (holder && holder.pid !== process.pid) return;
		rmSync(lock, { recursive: true, force: true });
	}

	/** For `/slot-sharing`: whether the store has been written at all. */
	exists(): boolean {
		return existsSync(join(this.dir, INDEX_FILE));
	}

	indexAge(): number | undefined {
		try {
			return statSync(join(this.dir, INDEX_FILE)).mtimeMs;
		} catch {
			return undefined;
		}
	}
}
