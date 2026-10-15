/**
 * Backend abstraction.
 *
 * The slot save/restore API is not a Strata invention — it is llama.cpp's, and Strata implements it
 * deliberately (`serve/server.py`: "llama-server's POST /slots/{id}?action=save|restore"). Verified
 * against upstream llama.cpp at b10398 and b10920, the request and the response fields are identical:
 *
 *   POST /slots/{id_slot}?action=save     {"filename": NAME} -> {id_slot, filename, n_saved, n_written}
 *   POST /slots/{id_slot}?action=restore  {"filename": NAME} -> {id_slot, filename, n_restored, n_read}
 *
 * and so is the refusal when the feature is off: llama.cpp answers `ERROR_TYPE_NOT_SUPPORTED`, which
 * `format_error_response` maps to 501 — the same status Strata uses. That is what makes one capability
 * probe serve both.
 *
 * What differs, and why this file exists:
 *   - where each server reports its own facts (`/v1/status` exists only on Strata);
 *   - whether the server warns before it fails: Strata refuses a restore it cannot hold in RAM, llama.cpp
 *     has no such check and simply tries. So the RAM gate belongs to the Strata backend alone.
 */

import { JsonClient, ServerHttpError } from "./http.ts";
import { restoreGate, type GateInput, type GateVerdict } from "./sessions.ts";

export type ServerKind = "strata" | "llama.cpp";

export interface ServerInfo {
	kind: ServerKind;
	model?: string;
	/** Engine build or version string. */
	version?: string;
	/** KV cache type, when the server reports it. */
	kv?: string;
	maxContext?: number;
	totalSlots?: number;
	/** Seconds since epoch the engine started. Strata only; absent on llama.cpp. */
	started?: number;
	/** The server's own RAM, when it reports it. Strata only. */
	ram?: { usedGib: number; totalGib: number };
}

export interface SlotCapability {
	enabled: boolean;
	reason?: string;
}

export interface SlotResult {
	fileName: string;
	tokens: number;
	bytes: number;
}

export interface SlotBackend {
	readonly kind: ServerKind;
	/** Everything the server will tell us about itself. */
	info(): Promise<ServerInfo>;
	capability(): Promise<SlotCapability>;
	/** Tokens the slot currently holds, when the server reports it. Used to refuse an oversized save. */
	slotTokens(): Promise<number | undefined>;
	save(fileName: string): Promise<SlotResult>;
	restore(fileName: string): Promise<SlotResult>;
	/**
	 * Only present for a server that refuses a restore it cannot hold. Where there is no such check there
	 * is nothing to predict, and guessing at another server's memory would be worse than trying.
	 */
	gate?(input: GateInput): GateVerdict;
}

/**
 * Ask for an action each server rejects *after* its own enable check: llama.cpp's `post_slots` tests
 * `slot_save_path.empty()` before it parses the slot id or the action, and Strata's `slot_action` checks
 * its save path and batch mode first too. So 501 means off, anything else means the feature is live.
 * No file is written either way.
 */
export async function probeCapability(client: JsonClient): Promise<SlotCapability> {
	try {
		await client.request("/slots/0?action=capability", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		return { enabled: true };
	} catch (error) {
		if (error instanceof ServerHttpError && error.status === 501) return { enabled: false, reason: error.message };
		return { enabled: true };
	}
}

export async function slotAction(client: JsonClient, action: "save" | "restore", fileName: string): Promise<SlotResult> {
	const r = await client.request<{ filename?: string; n_saved?: number; n_written?: number; n_restored?: number; n_read?: number }>(
		`/slots/0?action=${action}`,
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: fileName }) },
	);
	return {
		fileName: r.filename ?? fileName,
		tokens: r.n_saved ?? r.n_restored ?? 0,
		bytes: r.n_written ?? r.n_read ?? 0,
	};
}

/**
 * How many prompt tokens the server's slot currently holds. Both report it on `GET /slots`
 * (llama.cpp: `server_slot::to_json` sets `n_prompt_tokens`). Undefined means the server did not say —
 * llama.cpp answers 501 unless started with `--slots` — which callers must treat as unknown, not zero.
 */
export async function slotPromptTokens(client: JsonClient): Promise<number | undefined> {
	let slots: unknown;
	try {
		slots = await client.request("/slots");
	} catch {
		return undefined;
	}
	if (!Array.isArray(slots)) return undefined;
	for (const slot of slots) {
		if (slot && typeof slot === "object" && typeof (slot as { n_prompt_tokens?: unknown }).n_prompt_tokens === "number") {
			return (slot as { n_prompt_tokens: number }).n_prompt_tokens;
		}
	}
	return undefined;
}

/**
 * Which server is this? `build_info` is the honest marker — Strata reports "Strata 0.1.44", llama.cpp
 * reports its build ("b10920 <sha>"). The rest is the shape both share, used only to recognise llama.cpp.
 */
export function detectKind(props: unknown): ServerKind | undefined {
	if (!props || typeof props !== "object") return undefined;
	const p = props as { build_info?: unknown; total_slots?: unknown; default_generation_settings?: unknown };
	if (typeof p.build_info === "string" && /strata/i.test(p.build_info)) return "strata";
	if (typeof p.total_slots === "number" && p.default_generation_settings !== undefined) return "llama.cpp";
	return undefined;
}

export async function readProps(client: JsonClient): Promise<unknown> {
	return client.request("/props");
}

/**
 * Bytes the server could allocate for a restore. Prefer the exact number a Strata engine's own guard
 * reads (`MemAvailable` when we are on the same machine and reached over loopback); otherwise fall back
 * to the server's `total - used`. The two differ in either direction — 37 MiB apart on the reference
 * machine, with `total - used` the more optimistic one — so callers must keep a margin rather than trust
 * the fallback.
 */
export function availableBytesFrom(info: ServerInfo | undefined, meminfo?: string): number | undefined {
	if (meminfo) {
		const line = meminfo.split("\n").find((l) => l.startsWith("MemAvailable:"));
		const kib = line ? Number.parseInt(line.split(":")[1].trim(), 10) : Number.NaN;
		if (Number.isFinite(kib)) return kib * 1024;
	}
	if (info?.ram) return Math.max(0, (info.ram.totalGib - info.ram.usedGib) * 1024 * 1024 * 1024);
	return undefined;
}

/** The Strata gate, exported for the backend that uses it. */
export const strataGate = restoreGate;
