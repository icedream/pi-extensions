/**
 * Configuration for pi-slot-sharing.
 *
 * Everything a server can be asked, the extension asks: the server address comes from the model's own
 * `baseUrl`, credentials from Pi's provider store, and the backend from `/props`. Nothing about a server
 * is configured here, because a second copy of any of it is one more thing that can disagree with the
 * thing it copies.
 *
 * What remains is only what no server reports — chiefly the RAM floor it keeps free for a session read,
 * which is a launch argument — plus behaviour knobs. An empty config object is a working config.
 */

import { existsSync, readFileSync } from "node:fs";
import { MIB } from "./sessions.ts";

export interface SessionsConfig {
	/**
	 * The engine's `--conversation-cache-min-free-mib`. Strata refuses a restore unless it can read the
	 * file and still hold this much free, and it does not report the value, so it has to be stated.
	 * Defaults to Strata's own default (2560). Only used by the Strata backend: llama.cpp has no such
	 * check and no refusal to predict.
	 */
	ramFloorMib?: number;
	/** Extra headroom beyond the floor, in MiB. Covers our own allocations and the gap between
	 *  `MemAvailable` and the free/used pair `/v1/status` reports. Default 256. */
	marginMib?: number;
	/** Bytes per token assumed until a save reports `n_written` / `n_saved`. Default 16896 (int8 KV). */
	bytesPerTokenFallback?: number;
	/** Refuse a restore above this token count even when the gate passes. Default: whatever the gate allows. */
	maxRestoreTokens?: number;
	/** A lock or owner record older than this, held by a process that is gone, is taken over. Default 120000. */
	lockStaleMs?: number;
	/** Save after every N agent runs. 1 saves after each. Default 1. */
	saveEveryTurns?: number;
	/** Master switch. Default true. */
	enabled?: boolean;
}

export interface ResolvedConfig {
	ramFloorBytes: number;
	marginBytes: number;
	bytesPerTokenFallback: number;
	maxRestoreTokens?: number;
	lockStaleMs: number;
	saveEveryTurns: number;
	enabled: boolean;
}

export interface ConfigResult {
	config?: ResolvedConfig;
	problems: string[];
	path: string;
	present: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown, name: string, problems: string[]): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		problems.push(`${name} must be a non-negative number`);
		return undefined;
	}
	return value;
}

export function resolveConfig(raw: unknown): { config?: ResolvedConfig; problems: string[] } {
	const problems: string[] = [];
	if (!isRecord(raw)) return { problems: ["config file must contain a JSON object"] };

	const ramFloorMib = positiveNumber(raw.ramFloorMib, "ramFloorMib", problems);
	const marginMib = positiveNumber(raw.marginMib, "marginMib", problems);
	const bytesPerTokenFallback = positiveNumber(raw.bytesPerTokenFallback, "bytesPerTokenFallback", problems);
	const maxRestoreTokens = positiveNumber(raw.maxRestoreTokens, "maxRestoreTokens", problems);
	const lockStaleMs = positiveNumber(raw.lockStaleMs, "lockStaleMs", problems);
	const saveEveryTurns = positiveNumber(raw.saveEveryTurns, "saveEveryTurns", problems);

	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") problems.push("enabled must be true or false");
	if (raw.saveEveryTurns !== undefined && (saveEveryTurns ?? 0) < 1) problems.push("saveEveryTurns must be at least 1");

	if (problems.length > 0) return { problems };

	return {
		config: {
			ramFloorBytes: (ramFloorMib ?? 2560) * MIB,
			marginBytes: (marginMib ?? 256) * MIB,
			bytesPerTokenFallback: bytesPerTokenFallback ?? 16896,
			maxRestoreTokens,
			lockStaleMs: lockStaleMs ?? 120_000,
			saveEveryTurns: saveEveryTurns ?? 1,
			enabled: raw.enabled !== false,
		},
		problems,
	};
}

export function loadConfig(path: string): ConfigResult {
	if (!existsSync(path)) return { problems: [], path, present: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { problems: [`${path}: ${(error as Error).message}`], path, present: true };
	}
	const { config, problems } = resolveConfig(parsed);
	return { config, problems, path, present: true };
}
