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
 *
 * Those remaining numbers are properties of one server, not of the extension. A Strata engine at 393216
 * positions with int8 KV and a llama.cpp server at 160k with q8_0 KV need different floors and different
 * caps, so `providers` gives per-provider overrides keyed by the model's provider name.
 */

import { existsSync, readFileSync } from "node:fs";
import { MIB } from "./sessions.ts";

/** The knobs, before resolution. `providers` is only valid at the top level. */
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
	/**
	 * Per-provider overrides, keyed by the model's provider name as Pi reports it (`ctx.model.provider`).
	 * Each entry starts from the values above and replaces only what it names, so a provider that needs a
	 * different RAM floor or a lower restore cap gets them without repeating the rest.
	 */
	providers?: Record<string, Omit<SessionsConfig, "providers">>;
}

/** The knobs, resolved to bytes and defaults. */
export interface Settings {
	ramFloorBytes: number;
	marginBytes: number;
	bytesPerTokenFallback: number;
	maxRestoreTokens?: number;
	lockStaleMs: number;
	saveEveryTurns: number;
	enabled: boolean;
}

export interface ResolvedConfig {
	defaults: Settings;
	/** Fully merged settings per provider: the top level, with that provider's keys on top. */
	byProvider: Record<string, Settings>;
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

/** Resolve one set of knobs. `label` prefixes problems from a provider block so they name their source. */
function resolveSettings(raw: Record<string, unknown>, problems: string[], label: string): Settings | undefined {
	const at = (name: string) => (label ? `${label}.${name}` : name);
	const ramFloorMib = positiveNumber(raw.ramFloorMib, at("ramFloorMib"), problems);
	const marginMib = positiveNumber(raw.marginMib, at("marginMib"), problems);
	const bytesPerTokenFallback = positiveNumber(raw.bytesPerTokenFallback, at("bytesPerTokenFallback"), problems);
	const maxRestoreTokens = positiveNumber(raw.maxRestoreTokens, at("maxRestoreTokens"), problems);
	const lockStaleMs = positiveNumber(raw.lockStaleMs, at("lockStaleMs"), problems);
	const saveEveryTurns = positiveNumber(raw.saveEveryTurns, at("saveEveryTurns"), problems);

	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") problems.push(`${at("enabled")} must be true or false`);
	if (raw.saveEveryTurns !== undefined && (saveEveryTurns ?? 0) < 1) problems.push(`${at("saveEveryTurns")} must be at least 1`);
	if (problems.length > 0) return undefined;

	return {
		ramFloorBytes: (ramFloorMib ?? 2560) * MIB,
		marginBytes: (marginMib ?? 256) * MIB,
		bytesPerTokenFallback: bytesPerTokenFallback ?? 16896,
		maxRestoreTokens,
		lockStaleMs: lockStaleMs ?? 120_000,
		saveEveryTurns: saveEveryTurns ?? 1,
		enabled: raw.enabled !== false,
	};
}

export function resolveConfig(raw: unknown): { config?: ResolvedConfig; problems: string[] } {
	const problems: string[] = [];
	if (!isRecord(raw)) return { problems: ["config file must contain a JSON object"] };

	const { providers, ...top } = raw;
	const defaults = resolveSettings(top, problems, "");
	if (providers !== undefined && !isRecord(providers)) problems.push("providers must be an object keyed by provider name");

	const byProvider: Record<string, Settings> = {};
	if (isRecord(providers)) {
		for (const [name, override] of Object.entries(providers)) {
			if (!isRecord(override)) {
				problems.push(`providers.${name} must be an object of settings`);
				continue;
			}
			if (override.providers !== undefined) problems.push(`providers.${name}.providers is not allowed`);
			const merged = resolveSettings({ ...top, ...override }, problems, `providers.${name}`);
			if (merged) byProvider[name] = merged;
		}
	}

	if (problems.length > 0 || !defaults) return { problems };
	return { config: { defaults, byProvider }, problems };
}

/** The settings that apply to one provider: its override if there is one, otherwise the top level. */
export function settingsFor(config: ResolvedConfig, provider: string | undefined): Settings {
	return (provider !== undefined ? config.byProvider[provider] : undefined) ?? config.defaults;
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
