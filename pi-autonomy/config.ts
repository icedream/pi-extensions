/**
 * Configuration for pi-autonomy.
 *
 * The four runaway guards are the product, so the config carries nothing else. Layers,
 * lowest precedence first: DEFAULT_CONFIG, the agent-dir file (`~/.pi/agent/autonomy.json`
 * in a standard install), then a project file inside a trusted project. `PI_AUTONOMY_CONFIG`
 * names a different file and replaces *every* layer — that is what makes the tests hermetic
 * and what gets you out of a committed project file that loosens the guards.
 *
 * A layer that does not parse is dropped and reported: the remaining layers still apply, and
 * the tighter defaults cover whatever is left. Nothing here throws.
 *
 * Pi-free by design: `agentDir`, `configDirName` and `env` come in as options so this module
 * stays unit-testable, exactly like `protocol.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, REPEAT_WINDOW, type AutonomyConfig } from "./protocol.ts";

/** File name in both layers; the extension name keeps its `pi-` prefix, the file does not. */
const CONFIG_BASENAME = "autonomy.json";

/**
 * Fallbacks for pi's `CONFIG_DIR_NAME` and `getAgentDir()`.
 *
 * The package exports both, but `@earendil-works/pi-coding-agent` does not resolve from this
 * directory (`npm test` runs here with no `node_modules`, which is why `index.ts` keeps to
 * type-only imports — pi-commit-attribution has no index tests for exactly that reason). So
 * the standard-install defaults are mirrored here and passed in as options instead.
 * `PI_CODING_AGENT_DIR` is honoured because pi's `getAgentDir()` reads it, and dropping that
 * would make this extension ignore a working override.
 */
const DEFAULT_CONFIG_DIR_NAME = ".pi";
const AGENT_DIR_ENV_VAR = "PI_CODING_AGENT_DIR";

/** Env var that replaces all layers with the single file it names. */
export const CONFIG_ENV_VAR = "PI_AUTONOMY_CONFIG";

function expandTilde(path: string): string {
	return path === "~" || path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(1)) : path;
}

/** Where the global `autonomy.json` lives, matching pi's own `getAgentDir()`. */
export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env[AGENT_DIR_ENV_VAR]?.trim();
	if (fromEnv) return expandTilde(fromEnv);
	return join(homedir(), DEFAULT_CONFIG_DIR_NAME, "agent");
}

const KEYS = ["maxContinuations", "maxStallTurns", "repeatLimit", "maxMinutes"] as const;
type ConfigKey = (typeof KEYS)[number];

export interface ResolvedConfig {
	config: AutonomyConfig;
	/** Per key: the file that set it. Keys that are absent came from DEFAULT_CONFIG. */
	provenance: Partial<Record<ConfigKey, string>>;
	/** Files actually applied, lowest precedence first. */
	sources: string[];
	/** Validation or parse failures, one per offending layer. */
	problems: string[];
	/** Set when a project file exists but was not read because the project is untrusted. */
	projectSkipped?: string;
}

export interface ResolveOptions {
	/** Directory holding the global `autonomy.json`; defaults to pi's agent dir. */
	agentDir?: string;
	/** pi's `CONFIG_DIR_NAME`, so a rebranded distribution resolves its own project dir. */
	configDirName?: string;
	cwd?: string;
	projectTrusted?: boolean;
	/** Test seam; defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
}

/** A rejected value. Caught by `parseConfig` and turned into a `problem` string. */
class ConfigError extends Error {}

function show(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (typeof value === "object") return Array.isArray(value) ? "an array" : "an object";
	return String(value);
}

/** An integer in `[min, max]`. */
function intValue(key: ConfigKey, raw: unknown, min: number, max: number | undefined): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		throw new ConfigError(`"${key}" must be a finite number, got ${show(raw)}`);
	}
	if (!Number.isInteger(raw)) throw new ConfigError(`"${key}" must be an integer, got ${raw}`);
	if (raw < min) throw new ConfigError(`"${key}" must be >= ${min}, got ${raw}`);
	if (max !== undefined && raw > max) {
		throw new ConfigError(`"${key}" must be <= ${max} (the loop guard only remembers the last ${max} tool calls, so a higher value never trips), got ${raw}`);
	}
	return raw;
}

/** A finite number above zero. `JSON.parse("1e999")` is Infinity, which would disable the clock. */
function positiveValue(key: ConfigKey, raw: unknown): number {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
		throw new ConfigError(`"${key}" must be a finite number above 0, got ${show(raw)}`);
	}
	return raw;
}

/** `undefined` problem when the object is usable. */
export function parseConfig(raw: unknown): { config?: Partial<AutonomyConfig>; problem?: string } {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { problem: "config must be a JSON object" };
	const entry = raw as Record<string, unknown>;
	const unknown = Object.keys(entry).filter((key) => !(KEYS as readonly string[]).includes(key));
	if (unknown.length > 0) return { problem: `unknown config key(s): ${unknown.join(", ")} (valid: ${KEYS.join(", ")})` };
	try {
		const config: Partial<AutonomyConfig> = {};
		if (entry.maxContinuations !== undefined) config.maxContinuations = intValue("maxContinuations", entry.maxContinuations, 1, undefined);
		if (entry.maxStallTurns !== undefined) config.maxStallTurns = intValue("maxStallTurns", entry.maxStallTurns, 1, undefined);
		if (entry.repeatLimit !== undefined) config.repeatLimit = intValue("repeatLimit", entry.repeatLimit, 2, REPEAT_WINDOW);
		if (entry.maxMinutes !== undefined) config.maxMinutes = positiveValue("maxMinutes", entry.maxMinutes);
		return { config };
	} catch (error) {
		if (error instanceof ConfigError) return { problem: error.message };
		return { problem: `invalid config: ${(error as Error).message}` };
	}
}

/** Missing file: nothing, silently. Bad file: a problem and no config. */
export function loadFile(path: string): { config?: Partial<AutonomyConfig>; problem?: string } {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { problem: `${path}: ${(error as Error).message}` };
	}
	const checked = parseConfig(parsed);
	return checked.problem ? { problem: `${path}: ${checked.problem}` } : { config: checked.config };
}

function projectCandidate(options: ResolveOptions): string | undefined {
	if (!options.cwd) return undefined;
	return join(options.cwd, options.configDirName ?? DEFAULT_CONFIG_DIR_NAME, CONFIG_BASENAME);
}

export function resolveConfig(options: ResolveOptions = {}): ResolvedConfig {
	const env = options.env ?? process.env;
	const problems: string[] = [];
	const layers: { path: string; config: Partial<AutonomyConfig> }[] = [];
	let projectSkipped: string | undefined;

	const add = (path: string): void => {
		const loaded = loadFile(path);
		if (loaded.problem) problems.push(loaded.problem);
		if (loaded.config) layers.push({ path, config: loaded.config });
	};

	const override = env[CONFIG_ENV_VAR]?.trim();
	if (override) {
		add(override);
	} else {
		const agentDir = options.agentDir ?? defaultAgentDir(env);
		add(join(agentDir, CONFIG_BASENAME));
		const candidate = projectCandidate(options);
		if (candidate) {
			if (options.projectTrusted) add(candidate);
			else if (existsSync(candidate)) projectSkipped = candidate;
		}
	}

	const config: AutonomyConfig = { ...DEFAULT_CONFIG };
	const provenance: ResolvedConfig["provenance"] = {};
	for (const layer of layers) {
		for (const key of KEYS) {
			const value = layer.config[key];
			if (value === undefined) continue;
			config[key] = value;
			provenance[key] = layer.path;
		}
	}

	const resolved: ResolvedConfig = { config, provenance, sources: layers.map((l) => l.path), problems };
	if (projectSkipped) resolved.projectSkipped = projectSkipped;
	return resolved;
}

/**
 * One line for `/autonomy status`: every value, with the file that set it on the key that
 * came from a file. Key-wise merging means "sources: a, b" alone does not say which one
 * owns `maxMinutes`.
 */
export function describeConfig(resolved: ResolvedConfig): string {
	const seen: string[] = [];
	let suffix = "";
	for (const key of KEYS) {
		const path = resolved.provenance[key];
		if (path && !seen.includes(path)) {
			seen.push(path);
			suffix += seen.length === 1 ? " from " : ", ";
			suffix += path;
		}
	}
	const values = KEYS.map((key) => `${key} ${resolved.config[key]}`).join(" · ");
	return `autonomy config — ${values}${suffix}`;
}
