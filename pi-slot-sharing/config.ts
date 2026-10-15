/**
 * Configuration for pi-slot-sharing.
 *
 * Everything the extension can learn from the server, it learns: context size, KV type, slot count,
 * engine start time, and the server's own RAM figures come from `/props`, `/metrics` and `/v1/status`.
 * What is left here is only what the server does not report — chiefly the RAM floor the engine keeps
 * free for a session read, which is a launch argument (`--conversation-cache-min-free-mib`) and is not
 * exposed over HTTP. Getting that number wrong in the safe direction is the point of `marginMib`.
 */

import { existsSync, readFileSync } from "node:fs";
import { MIB } from "./sessions.ts";

export interface SessionsConfig {
	/**
	 * Pin the extension to one server. Leave it out to talk to whatever server the session's own model
	 * reports — Pi already knows, and repeating it here is one more thing that can disagree with reality.
	 * Set it only to restrict the extension to a single server, or to reach one no Pi model points at.
	 */
	baseUrl?: string;
	/**
	 * Which server this is. `auto` reads `/props`: Strata says `build_info: "Strata 0.1.44"`, llama.cpp
	 * says `build_info: "b10920 <sha>"`. Set it explicitly only if auto-detection refuses.
	 */
	backend?: "auto" | "strata" | "llama.cpp";
	/**
	 * Override for the slot API's bearer token. Normally leave this out: the extension asks Pi for the
	 * same credentials the model's requests use. Set it only for a server Pi has no credential for.
	 * `SLOT_SHARING_API_KEY` is the environment form of the same escape hatch.
	 */
	apiKey?: string;
	/** Only act for sessions whose model provider matches. Absent means any provider. */
	provider?: string;
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
	baseUrl?: string;
	backend: "auto" | "strata" | "llama.cpp";
	apiKey?: string;
	provider?: string;
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

export function resolveConfig(raw: unknown, env: NodeJS.ProcessEnv): { config?: ResolvedConfig; problems: string[] } {
	const problems: string[] = [];
	if (!isRecord(raw)) return { problems: ["config file must contain a JSON object"] };

	const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.replace(/\/+$/, "") : undefined;
	if (baseUrl !== undefined && !/^https?:\/\//.test(baseUrl)) problems.push("baseUrl must start with http:// or https://");

	const apiKey = typeof raw.apiKey === "string" && raw.apiKey.length > 0 ? raw.apiKey : env.SLOT_SHARING_API_KEY;
	const knownBackends = ["auto", "strata", "llama.cpp"] as const;
	let backend: "auto" | "strata" | "llama.cpp" = "auto";
	if (raw.backend !== undefined) {
		if (typeof raw.backend === "string" && (knownBackends as readonly string[]).includes(raw.backend)) {
			backend = raw.backend as typeof backend;
		} else {
			problems.push('backend must be "auto", "strata" or "llama.cpp"');
		}
	}
	const provider = typeof raw.provider === "string" && raw.provider.length > 0 ? raw.provider : undefined;

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
			baseUrl,
			backend,
			apiKey,
			provider,
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

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): ConfigResult {
	if (!existsSync(path)) return { problems: [], path, present: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { problems: [`${path}: ${(error as Error).message}`], path, present: true };
	}
	const { config, problems } = resolveConfig(parsed, env);
	return { config, problems, path, present: true };
}
