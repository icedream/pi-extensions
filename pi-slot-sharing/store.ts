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
	 */
	async withLock<T>(staleMs: number, fn: () => Promise<T>): Promise<T> {
		this.ensure();
		const lock = join(this.dir, LOCK_DIR);
		const acquired = await this.acquire(lock, staleMs);
		if (!acquired) throw new Error(`another Pi session holds ${lock}`);
		try {
			return await fn();
		} finally {
			this.release(lock);
		}
	}

	private async acquire(lock: string, staleMs: number): Promise<boolean> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				mkdirSync(lock, { mode: 0o700 });
				writeFileSync(join(lock, HOLDER_FILE), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (!this.displaceable(lock, staleMs)) return false;
				rmSync(lock, { recursive: true, force: true });
			}
		}
		return false;
	}

	private displaceable(lock: string, staleMs: number): boolean {
		const holder = readJson<{ pid?: number; at?: number }>(join(lock, HOLDER_FILE));
		if (!holder || typeof holder.at !== "number") return true;
		if (Date.now() - holder.at <= staleMs) return false;
		return !pidLooksAlive(holder.pid ?? -1, process.kill);
	}

	private release(lock: string): void {
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
