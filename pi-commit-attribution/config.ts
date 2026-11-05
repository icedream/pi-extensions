/**
 * Configuration for pi-commit-attribution.
 *
 * Most of what the extension needs it does not ask about: the model name and its provider come from
 * Pi's own catalog, and cloud or local follows from the address that catalog reports. What stays here
 * is what no file tells us reliably, namely the exceptions (a LAN host that forwards to cloud models),
 * the human name for a model the catalog labels poorly, the engine serving a self-hosted model, and
 * the identity to write in `Operated-by:` when the person driving the session is not the commit author.
 *
 * An empty file is a working config. A value we cannot use is reported, and the rest of the config
 * still applies, so one typo does not silence attribution.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRule, Placement, ProviderRule } from "./format.mjs";

export type InjectRoute = "process-env" | "off";

export interface AttributionConfig {
	enabled: boolean;
	inject: InjectRoute;
	/** `Name <address>`. Emitted as `Operated-by:` only when it differs from the commit author. */
	operator?: string;
	/** Cap on `Assisted-by:` lines per commit, so a long session cannot write an unreadable block. */
	maxModels: number;
	/** Track which model changed which file, so a commit credits the models behind its files. */
	ledger: boolean;
	/** Run the repository's own hook before ours. Turning this off breaks the repository's hooks. */
	chainRepoHooks: boolean;
	/**
	 * What to do when the message already carries an `Assisted-by:` the model wrote itself. `merge` (the
	 * default) adds the session's line beside it, so a hand-written claim that names the wrong model is at
	 * least answered by one that names the right one. `keep` leaves the message alone.
	 */
	onExistingTrailer: "merge" | "keep";
	providers: Record<string, ProviderRule>;
	models: Record<string, ModelRule>;
	/** Repositories where injection is skipped entirely; the reason is reported by /attribution status. */
	skipRepos: string[];
	/**
	 * Domains whose hosts are on the operator's own network even though they resolve publicly. Without
	 * these, a model served at `llm.lan.example.net` is reported as cloud, which is the claim that does
	 * not understate where the prompt went.
	 */
	localDomains: string[];
}

export const DEFAULTS: AttributionConfig = {
	enabled: true,
	inject: "process-env",
	maxModels: 8,
	ledger: true,
	chainRepoHooks: true,
	onExistingTrailer: "merge",
	providers: {},
	models: {},
	skipRepos: [],
	localDomains: [],
};

const INJECT_ROUTES: InjectRoute[] = ["process-env", "off"];
const PLACEMENTS: Placement[] = ["cloud", "local"];

export function configPath(): string {
	return process.env.PI_ATTRIBUTION_CONFIG ?? join(homedir(), ".pi", "agent", "attribution.json");
}

function readRule(value: unknown, where: string, problems: string[]): ProviderRule | ModelRule | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		problems.push(`${where}: expected an object`);
		return undefined;
	}
	const entry = value as Record<string, unknown>;
	const rule: ModelRule = {};
	for (const field of ["name", "label", "engine"] as const) {
		const raw = entry[field];
		if (raw === undefined) continue;
		if (typeof raw !== "string" || raw.length === 0) {
			problems.push(`${where}.${field}: expected a non-empty string`);
			continue;
		}
		rule[field] = raw;
	}
	if (entry.placement !== undefined) {
		if (PLACEMENTS.includes(entry.placement as Placement)) rule.placement = entry.placement as Placement;
		else problems.push(`${where}.placement: expected "cloud" or "local"`);
	}
	return rule;
}

function readRuleMap(value: unknown, name: string, problems: string[]): Record<string, ProviderRule | ModelRule> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		problems.push(`${name}: expected an object keyed by ${name === "providers" ? "provider name" : "provider/model id"}`);
		return {};
	}
	const out: Record<string, ProviderRule | ModelRule> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		const rule = readRule(raw, `${name}.${key}`, problems);
		if (rule) out[key] = rule;
	}
	return out;
}

export function resolveConfig(raw: unknown): { config: AttributionConfig; problems: string[] } {
	const problems: string[] = [];
	const config: AttributionConfig = { ...DEFAULTS, providers: {}, models: {}, skipRepos: [], localDomains: [], onExistingTrailer: DEFAULTS.onExistingTrailer };
	if (raw === undefined || raw === null) return { config, problems };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		problems.push("config: expected a JSON object");
		return { config, problems };
	}
	const entry = raw as Record<string, unknown>;

	if (entry.enabled !== undefined) {
		if (typeof entry.enabled === "boolean") config.enabled = entry.enabled;
		else problems.push("enabled: expected true or false");
	}
	if (entry.inject !== undefined) {
		if (INJECT_ROUTES.includes(entry.inject as InjectRoute)) config.inject = entry.inject as InjectRoute;
		else problems.push(`inject: expected one of ${INJECT_ROUTES.join(", ")}`);
	}
	if (entry.operator !== undefined) {
		if (typeof entry.operator === "string" && entry.operator.trim().length > 0) config.operator = entry.operator.trim();
		else problems.push("operator: expected a non-empty string, for example `Name <mail@example.com>`");
	}
	if (entry.maxModels !== undefined) {
		if (typeof entry.maxModels === "number" && Number.isInteger(entry.maxModels) && entry.maxModels > 0) config.maxModels = entry.maxModels;
		else problems.push("maxModels: expected a positive integer");
	}
	if (entry.ledger !== undefined) {
		if (typeof entry.ledger === "boolean") config.ledger = entry.ledger;
		else problems.push("ledger: expected true or false");
	}
	if (entry.chainRepoHooks !== undefined) {
		if (typeof entry.chainRepoHooks === "boolean") config.chainRepoHooks = entry.chainRepoHooks;
		else problems.push("chainRepoHooks: expected true or false");
	}
	if (entry.onExistingTrailer !== undefined) {
		if (entry.onExistingTrailer === "merge" || entry.onExistingTrailer === "keep") config.onExistingTrailer = entry.onExistingTrailer;
		else problems.push('onExistingTrailer: expected "merge" or "keep"');
	}
	for (const [key, rule] of Object.entries(readRuleMap(entry.providers, "providers", problems))) config.providers[key] = rule as ProviderRule;
	for (const [key, rule] of Object.entries(readRuleMap(entry.models, "models", problems))) config.models[key] = rule as ModelRule;
	if (entry.skipRepos !== undefined) {
		if (Array.isArray(entry.skipRepos) && entry.skipRepos.every((item) => typeof item === "string")) config.skipRepos = entry.skipRepos as string[];
		else problems.push("skipRepos: expected an array of repository paths");
	}
	if (entry.localDomains !== undefined) {
		if (Array.isArray(entry.localDomains) && entry.localDomains.every((item) => typeof item === "string")) config.localDomains = entry.localDomains as string[];
		else problems.push("localDomains: expected an array of domain names");
	}

	return { config, problems };
}

/** Reads the config file. A missing file is the default config, not a problem. */
export function loadConfig(path = configPath()): { config: AttributionConfig; problems: string[] } {
	if (!existsSync(path)) return { config: { ...DEFAULTS, providers: {}, models: {}, skipRepos: [], localDomains: [], onExistingTrailer: DEFAULTS.onExistingTrailer }, problems: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return {
			config: { ...DEFAULTS, providers: {}, models: {}, skipRepos: [], localDomains: [], onExistingTrailer: DEFAULTS.onExistingTrailer },
			problems: [`${path}: ${(error as Error).message}`],
		};
	}
	return resolveConfig(parsed);
}
