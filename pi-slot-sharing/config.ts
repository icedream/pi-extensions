/**
 * Configuration for pi-slot-sharing.
 *
 * Everything a server can be asked, the extension asks: the server address comes from the model's own
 * `baseUrl`, credentials from Pi's provider store, and the backend from `/props`. Nothing about a server
 * is configured here, because a second copy of any of it is one more thing that can disagree with the
 * thing it copies.
 *
 * What remains is only what the server will not tell us — or tells us in a form we cannot trust on its
 * own, like a RAM floor that a restart can change — plus behaviour knobs. An empty config object is a
 * working config.
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
	 * The engine's `--conversation-cache-min-free-mib`, in MiB: Strata refuses a restore unless it can read
	 * the file and still hold this much free. Strata 0.1.44 reports it on `/metrics`
	 * (`conversation_cache_min_free_mib`), so it only has to be stated for a server that does not, or to
	 * deliberately keep more headroom than the engine asks for. When it is stated it wins; otherwise the
	 * server's number is used, and failing that Strata's own default (2560).
	 */
	ramFloorMib?: number;
	/** Extra headroom beyond the floor, in MiB. Covers our own allocations and the gap between
	 *  `MemAvailable` and the free/used pair `/v1/status` reports. Default 256. */
	marginMib?: number;
	/** Bytes per token assumed until a save reports `n_written` / `n_saved`. Default 16896 (int8 KV). */
	bytesPerTokenFallback?: number;
	/**
	 * Refuse to swap a session larger than this at all: no save, and no restore of a file that big. A save
	 * is not free either — it writes a file of roughly tokens x KV-bytes-per-token to disk, and on a server
	 * with no RAM gate (llama.cpp) it is the only brake there is. Default: unlimited, except that a Strata
	 * restore is still refused by the RAM gate.
	 */
	maxSessionTokens?: number;
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
	/** Stated in the config, in bytes. Undefined means "let the server say" — see `ramFloorBytesFor`. */
	ramFloorBytes?: number;
	marginBytes: number;
	bytesPerTokenFallback: number;
	maxSessionTokens?: number;
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
	const maxSessionTokens = positiveNumber(raw.maxSessionTokens, at("maxSessionTokens"), problems);
	const lockStaleMs = positiveNumber(raw.lockStaleMs, at("lockStaleMs"), problems);
	const saveEveryTurns = positiveNumber(raw.saveEveryTurns, at("saveEveryTurns"), problems);

	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") problems.push(`${at("enabled")} must be true or false`);
	if (raw.saveEveryTurns !== undefined && (saveEveryTurns ?? 0) < 1) problems.push(`${at("saveEveryTurns")} must be at least 1`);
	if (problems.length > 0) return undefined;

	return {
		ramFloorBytes: ramFloorMib === undefined ? undefined : ramFloorMib * MIB,
		marginBytes: (marginMib ?? 256) * MIB,
		bytesPerTokenFallback: bytesPerTokenFallback ?? 16896,
		maxSessionTokens,
		lockStaleMs: lockStaleMs ?? 120_000,
		saveEveryTurns: saveEveryTurns ?? 1,
		enabled: raw.enabled !== false,
	};
}

/** Strata's own default for `--conversation-cache-min-free-mib`, for a server that states no floor. */
export const DEFAULT_RAM_FLOOR_MIB = 2560;

/**
 * The floor to gate a restore on. A stated value wins — it is how an operator keeps more headroom than
 * the engine asks for, and it survives a server that does not report one. Otherwise believe the server's
 * own number.
 */
export function ramFloorBytesFor(statedBytes: number | undefined, reportedMib: number | undefined): number {
	if (statedBytes !== undefined) return statedBytes;
	if (reportedMib !== undefined && Number.isFinite(reportedMib) && reportedMib >= 0) return reportedMib * MIB;
	return DEFAULT_RAM_FLOOR_MIB * MIB;
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
