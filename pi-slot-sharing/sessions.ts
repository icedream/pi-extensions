/**
 * Pure policy for pi-slot-sharing: identity, file naming, and the RAM gate that decides whether a
 * session file can be restored. No I/O, no network — everything here is testable on its own.
 *
 * The gate mirrors Strata's own admission check rather than guessing at it:
 *   include/strata/core/conversation_memory.hpp
 *     conversation_memory_admit(available, allocation, floor)
 *       => available >= floor && allocation <= available - floor
 *   src/core/conversation_file.cpp
 *     session_read_peak_bytes(file_bytes)
 *       => file_bytes + 16 MiB + (file_bytes / 16 MiB + 1) * 4096 + 1 MiB
 * A restore therefore needs roughly the whole file resident in RAM, on top of the configured floor.
 * A save does not: session_save_peak_bytes() is a write buffer plus the live state, which is why saves
 * succeed at sizes where restores are refused.
 */

export const KIB = 1024;
export const MIB = 1024 * 1024;
export const GIB = 1024 * 1024 * 1024;

/** Strata reads session files in aligned 16 MiB blocks; the peak estimate is built from that. */
export const STRATA_READ_BLOCK_BYTES = 16 * MIB;

/** Mirrors session_read_peak_bytes() in strata src/core/conversation_file.cpp. */
export function sessionReadPeakBytes(fileBytes: number): number {
	if (!Number.isFinite(fileBytes) || fileBytes < 0) return Number.POSITIVE_INFINITY;
	const segments = Math.floor(fileBytes / STRATA_READ_BLOCK_BYTES) + 1;
	return fileBytes + STRATA_READ_BLOCK_BYTES + segments * 4096 + MIB;
}

export interface GateInput {
	/** Bytes the engine could still allocate (its MemAvailable, or our best reading of it). */
	availableBytes: number;
	/** The engine's `--conversation-cache-min-free-mib`, in bytes. */
	floorBytes: number;
	/** Extra headroom we keep for ourselves, in bytes. */
	marginBytes: number;
	/** Size of the session file we want to read, in bytes. */
	fileBytes: number;
}

export interface GateVerdict {
	ok: boolean;
	/** Bytes that must be available for the restore to be admitted. */
	needBytes: number;
	/** Bytes short of `needBytes`; 0 when the restore is admitted. */
	shortByBytes: number;
	reason: string;
}

const mib = (bytes: number) => Math.round(bytes / MIB);

/** Decide whether Strata would admit a restore of `fileBytes`, before asking it. */
export function restoreGate(input: GateInput): GateVerdict {
	const peak = sessionReadPeakBytes(input.fileBytes);
	const need = peak + input.floorBytes + input.marginBytes;
	if (!Number.isFinite(need)) {
		return { ok: false, needBytes: need, shortByBytes: Number.POSITIVE_INFINITY, reason: "unknown session file size" };
	}
	if (input.availableBytes >= need) {
		return {
			ok: true,
			needBytes: need,
			shortByBytes: 0,
			reason: `peak ${mib(peak)} MiB + floor ${mib(input.floorBytes)} MiB + margin ${mib(input.marginBytes)} MiB fits in ${mib(input.availableBytes)} MiB`,
		};
	}
	return {
		ok: false,
		needBytes: need,
		shortByBytes: need - input.availableBytes,
		reason: `needs ${mib(need)} MiB (peak ${mib(peak)} + floor ${mib(input.floorBytes)} + margin ${mib(input.marginBytes)}), only ${mib(input.availableBytes)} MiB available`,
	};
}

/**
 * Bytes per token of a session file, from one save's own report. Strata tells us both numbers
 * (`n_saved`, `n_written`), so we never have to assume a KV size — we measure the server's.
 */
export function bytesPerTokenFromSave(fileBytes: number, tokens: number): number | undefined {
	if (!Number.isFinite(fileBytes) || !Number.isFinite(tokens) || tokens <= 0) return undefined;
	return fileBytes / tokens;
}

export function estimateFileBytes(tokens: number, bytesPerToken: number): number {
	if (!Number.isFinite(tokens) || !Number.isFinite(bytesPerToken) || tokens < 0) return Number.POSITIVE_INFINITY;
	return tokens * bytesPerToken;
}

/** Largest token count whose restore still passes the gate. Used for reporting, and to size a compact. */
export function maxRestorableTokens(availableBytes: number, floorBytes: number, marginBytes: number, bytesPerToken: number): number {
	if (!Number.isFinite(availableBytes) || !Number.isFinite(bytesPerToken) || bytesPerToken <= 0) return 0;
	let tokens = Math.max(0, Math.floor((availableBytes - floorBytes - marginBytes) / bytesPerToken));
	while (tokens > 0 && !restoreGate({ availableBytes, floorBytes, marginBytes, fileBytes: tokens * bytesPerToken }).ok) {
		tokens = Math.floor(tokens * 0.98);
	}
	return tokens;
}

/**
 * Whether the token count the server reports for its slot can be this session's conversation.
 *
 * A save writes whatever the engine is holding, and the owner record only says who meant to use the slot
 * last: another session's request can be in flight while this one finishes, and then the save writes that
 * other conversation out under this session's name. The two directions are not equally sure, so the
 * tolerances differ — a slot holding far more than this session ever sent cannot be ours, while a slot
 * holding less may only be a server that counts generated tokens separately.
 */
export function slotContentProblem(held: number | undefined, expected: number | undefined): string | undefined {
	if (held === undefined || expected === undefined || !Number.isFinite(held) || !Number.isFinite(expected)) return undefined;
	if (held > expected + Math.max(512, Math.round(expected * 0.05))) {
		return `the slot holds ${held.toLocaleString()} tokens but this session's last request was ${expected.toLocaleString()}`;
	}
	if (held < expected - Math.max(2048, Math.round(expected * 0.1))) {
		return `the slot holds ${held.toLocaleString()} tokens, this session's last request was ${expected.toLocaleString()}`;
	}
	return undefined;
}

/**
 * Prompt plus completion tokens of the last assistant message of a run: what the engine's slot should be
 * holding once the run is over. Undefined when the run was aborted or failed before reporting usage, which
 * is also the case where the slot may be holding somebody else's conversation.
 */
export function lastRunTokens(messages: readonly unknown[]): number | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: unknown; stopReason?: unknown; usage?: Record<string, unknown> } | undefined;
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
		const sum = ["input", "cacheRead", "cacheWrite", "output"].reduce((total, field) => total + (typeof message.usage?.[field] === "number" ? (message.usage[field] as number) : 0), 0);
		return sum > 0 ? sum : undefined;
	}
	return undefined;
}

/** Names are stable across processes, so two Pi sessions never collide on one file. */
export function sessionKey(sessionId: string, modelRef: string): string {
	return `${sessionId}|${modelRef}`;
}

const WIN_DEVICES = new Set([
	"con", "prn", "aux", "nul", "conin$", "conout$",
	...["1", "2", "3", "4", "5", "6", "7", "8", "9", "\u00b9", "\u00b2", "\u00b3"].map((d) => `com${d}`),
	...["1", "2", "3", "4", "5", "6", "7", "8", "9", "\u00b9", "\u00b2", "\u00b3"].map((d) => `lpt${d}`),
]);

/**
 * Mirrors slot_filename_problem() in strata serve/server.py. We generate names that always pass, but
 * the check is here so a hand-written name in the index is rejected before it reaches the server.
 */
export function slotFilenameProblem(name: unknown): string | undefined {
	if (typeof name !== "string" || name.length === 0) return "must be a non-empty string";
	if (Buffer.byteLength(name, "utf8") > 200) return "is too long (at most 200 bytes)";
	if (new RegExp("[\\u0000-\\u001f\\u007f]").test(name)) return "must not contain control characters";
	if (/[/\\:*?"<>|]/.test(name)) return 'must be a plain file name (no / \\ : * ? " < > |)';
	if (name.startsWith(".")) return "must not start with a dot";
	if (name.endsWith(".") || name.endsWith(" ")) return "must not end with a dot or a space";
	if (WIN_DEVICES.has(name.split(".")[0].replace(/ +$/, "").toLowerCase())) return "names a Windows device";
	return undefined;
}

export interface SessionRecord {
	/** Pi session id this record belongs to. */
	sessionId: string;
	/** `provider/modelId` the file was saved for; a file is refused by a differently configured engine. */
	modelRef: string;
	fileName: string;
	tokens: number;
	bytes: number;
	/** Seconds since epoch of the save. */
	savedAt: number;
	/** `/v1/status.started` of the engine that wrote the file. */
	engineStarted: number;
}

export interface SessionIndexEntry {
	record: SessionRecord;
	/** Set when the file stopped matching the conversation (compaction, fork, tree) or the slot moved on. */
	stale?: string;
}

export interface SessionIndex {
	version: 1;
	/** Learned from saves; absent until the first save reports both numbers. */
	bytesPerToken?: number;
	records: Record<string, SessionIndexEntry>;
}

export function emptyIndex(): SessionIndex {
	return { version: 1, records: {} };
}

/** Who holds the engine's single slot right now. One record for the whole server, not per session. */
export interface SlotOwner {
	key: string;
	sessionId: string;
	pid: number;
	/** Seconds since epoch of the last touch. */
	at: number;
}

export function ownerIsFresh(owner: SlotOwner, nowSeconds: number, staleSeconds: number): boolean {
	return nowSeconds - owner.at <= staleSeconds;
}

/**
 * A process that is gone cannot hold the slot. Used before taking over a lock left behind by a crash,
 * so a dead Pi session does not block the living ones forever.
 */
export function pidLooksAlive(pid: number, kill: (pid: number, signal: 0) => void): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
