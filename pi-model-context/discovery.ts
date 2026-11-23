/**
 * Model discovery for OpenAI-compatible endpoints that report their real context
 * window the way llama.cpp and Strata do: `meta.n_ctx` on each entry of GET /models.
 *
 * The parse functions are pure so they can be tested without a server.
 */

import { readFile, writeFile } from "node:fs/promises";

export const LOG_PREFIX = "pi-model-context:";
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * Only used when the endpoint reports no output limit. Matches what Pi's own
 * llama.cpp provider uses, so a local server is not capped below what it serves.
 */
export const DEFAULT_MAX_TOKENS = 65_536;

/** How long a successful fetch is reused for, so one session does not fetch twice per provider. */
export const DEFAULT_REFRESH_MINUTES = 10;

/** Per-provider discovery knobs, set with the `discover` member in models.json. */
export interface DiscoverOptions {
	/**
	 * false registers the provider as free even when the endpoint reports prices. Some
	 * hosts list display prices or prices in another currency.
	 */
	pricing?: boolean;
	/**
	 * `dotted.path=value` predicates, all of which must match for a model to register.
	 * Case-insensitive; an array on the path matches when any element matches. This is how an
	 * aggregator with thousands of routes gets narrowed without naming every model:
	 * `"require": ["opper.gdpr_residency=EU"]`. A path the endpoint stops sending rejects
	 * everything, so the provider fails with a message that names the predicate.
	 */
	require?: string[];
	/**
	 * Minutes a fetched list stays good for inside one Pi process. The factory fetch already
	 * blocks startup, so the session_start pass reuses it unless this says otherwise.
	 */
	refreshMinutes?: number;
}

/** A provider entry from models.json that opted into discovery. */
export interface ProviderEntry {
	id: string;
	name?: string;
	baseUrl?: string;
	modelsUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	discoverModels?: boolean;
	discover?: DiscoverOptions;
}

/** One entry of a GET /models response, typed as loosely as servers actually send it. */
export interface EndpointModel {
	id?: string;
	name?: string;
	n_ctx?: number | string;
	context_window?: number | string;
	contextWindow?: number | string;
	max_model_len?: number | string;
	context_length?: number | string;
	max_tokens?: number | string;
	maxTokens?: number | string;
	meta?: { n_ctx?: number | string; n_predict?: number | string; [key: string]: unknown };
	pricing?: Record<string, unknown>;
	params?: Record<string, unknown>;
	opper?: Record<string, unknown>;
	capabilities?: string[];
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export interface DiscoveredModel {
	id: string;
	name: string;
	type: "chat";
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	/** True when maxTokens came from the endpoint rather than from DEFAULT_MAX_TOKENS. */
	maxTokensReported: boolean;
	/** List price in USD per million tokens, when the endpoint reports one. */
	cost?: ModelCost;
	/** Thinking levels the endpoint names; absent means it named none. */
	thinkingLevels?: string[];
}

/** USD per million tokens, the shape Pi's model config takes. */
export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface RejectedModel {
	id: string;
	/** Short label for why, so a list of hundreds can be reported as counts instead of names. */
	cause: string;
	/** Full guidance for a human fixing one entry. */
	reason: string;
}

function positiveNumber(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
	return undefined;
}

/**
 * The context window the endpoint reports, or undefined when it reports none.
 *
 * `meta.n_ctx` first: that is what llama.cpp and Strata send. `max_model_len` is what
 * vLLM sends, and `context_length` is what OpenRouter-style lists send. None of these is
 * an OpenAI-style key, so a client that only reads `context_window` sees nothing.
 * Never guess a number here: a made-up window is worse than no window, because Pi then
 * keeps growing the session past what the server accepts.
 */
export function reportedContextWindow(model: EndpointModel): number | undefined {
	const candidates = [
		model.meta?.n_ctx,
		model.n_ctx,
		model.context_window,
		model.contextWindow,
		model.max_model_len,
		model.context_length,
	];
	for (const candidate of candidates) {
		const n = positiveNumber(candidate);
		if (n !== undefined) return n;
	}
	return undefined;
}

/**
 * The output limit the endpoint reports, or undefined. Endpoint-level keys win. Otherwise
 * `max_output_tokens` inside any object-valued field counts: providers that nest their own
 * metadata report the real cap per model there, and some caps are well below DEFAULT_MAX_TOKENS.
 */
/**
 * The output budget to assume when the endpoint reports none.
 *
 * A server that reports no cap is not saying "zero", and it is not saying "the whole window"
 * either: llama.cpp's `-n/--n-predict` defaults to -1, meaning no limit, and every generated token
 * has to fit in the same `n_ctx` as the prompt. Budgeting the whole window therefore assumes the
 * prompt is free, which turns any request with a real prompt into a truncated turn at the server's
 * own wall. Half the window leaves room for the prompt and still gives small windows a usable
 * budget; DEFAULT_MAX_TOKENS remains the cap for windows large enough not to need one.
 */
export function fallbackMaxTokens(contextWindow: number): number {
	return Math.min(DEFAULT_MAX_TOKENS, Math.max(1, Math.floor(contextWindow / 2)));
}

export function reportedMaxTokens(model: EndpointModel): number | undefined {
	const candidates = [model.meta?.n_predict, model.max_tokens, model.maxTokens];
	for (const candidate of candidates) {
		const n = positiveNumber(candidate);
		if (n !== undefined) return n;
	}
	for (const value of Object.values(model)) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
		const n = positiveNumber((value as { max_output_tokens?: unknown }).max_output_tokens);
		if (n !== undefined) return n;
	}
	return undefined;
}

/**
 * Input modalities the endpoint declares. Falls back to text only: assuming
 * image support is what makes a client attach a screenshot to a model that
 * cannot read one.
 */
export function reportedInput(model: EndpointModel): ("text" | "image")[] {
	const modalities = model.architecture?.input_modalities;
	if (!Array.isArray(modalities)) return ["text"];
	const kept = modalities.filter((m): m is "text" | "image" => m === "text" || m === "image");
	return kept.length > 0 ? kept : ["text"];
}

/** llama.cpp 0.6.0 and later mark decision models with an output modality of "decisions". */
export function isDecisionModel(model: EndpointModel): boolean {
	const outputs = model.architecture?.output_modalities;
	return Array.isArray(outputs) && outputs.includes("decisions");
}

/**
 * Embedding and image-only models list an output modality other than text, so they cannot
 * answer a chat request. An endpoint that declares no output modalities is taken at its word
 * and kept, as before.
 */
export function hasNoTextOutput(model: EndpointModel): boolean {
	const outputs = model.architecture?.output_modalities;
	return Array.isArray(outputs) && outputs.length > 0 && !outputs.includes("text");
}

/**
 * A per-token price in USD. Aggregators send these as strings, and OpenRouter-style lists
 * put "-1" where pricing is negotiated per call, so only a finite non-negative number counts.
 * Multiplied into per-Mtok prices and rounded, because 0.000003 * 1e6 is 3.0000000000000004.
 */
function reportedPrice(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
	const perMtok = n * 1_000_000;
	return Number.isInteger(perMtok) ? perMtok : Math.round(perMtok * 1e6) / 1e6;
}

/**
 * The list price to register. A model is unpriced when either side is missing: billing input
 * against a real price and output against zero would report spend that never happened.
 */
export function reportedCost(model: EndpointModel): ModelCost | undefined {
	const input = reportedPrice(model.pricing?.prompt);
	const output = reportedPrice(model.pricing?.completion);
	if (input === undefined || output === undefined) return undefined;
	return {
		input,
		output,
		cacheRead: reportedPrice(model.pricing?.input_cache_read) ?? 0,
		cacheWrite: reportedPrice(model.pricing?.input_cache_write) ?? 0,
	};
}

/** What an endpoint says about thinking. */
export interface ReportedReasoning {
	supported: boolean;
	/** The levels it names, when it names any. "none" means thinking can be switched off. */
	levels?: string[];
}

/**
 * Opper reports thinking under `opper.reasoning.supported` and `opper.capabilities`, a model
 * catalog under `params.reasoning.supported`. A model that reports neither keeps today's
 * assumption that it can reason, since that is what registering it always assumed.
 */
export function reportedReasoning(model: EndpointModel): ReportedReasoning {
	const block = (model.opper?.reasoning ?? model.params?.reasoning) as { supported?: unknown } | false | undefined;
	if (block === false) return { supported: false };
	const caps = [model.opper?.capabilities, model.capabilities].find((c) => Array.isArray(c)) as string[] | undefined;
	const named = typeof block === "object" && block !== null && Array.isArray(block.supported) ? block.supported : [];
	const levels = named.filter((level): level is string => typeof level === "string");
	return { supported: caps ? caps.includes("reasoning") : true, ...(levels.length > 0 ? { levels } : {}) };
}

/** Levels Pi offers in /thinking, in the order it climbs them. */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * The shape Pi's model config takes for `thinkingLevelMap`: a level mapped to `null` is not
 * offered, and a token string is what the endpoint is sent for that level.
 */
export interface ThinkingLevelMap {
	off?: string | null;
	minimal?: string | null;
	low?: string | null;
	medium?: string | null;
	high?: string | null;
	xhigh?: string | null;
	max?: string | null;
}

/**
 * The thinking levels to offer for one model. xhigh and max only reach /thinking when they are
 * mapped, so an endpoint that names its levels gets exactly those: offering a level the route
 * rejects turns a thinking-level choice into a failed request. Pi's `off` becomes the endpoint's
 * own "none" token when it names one, otherwise there is no value to send and off is not offered.
 * Without a list the previous guess stays.
 */
export function thinkingLevelMap(levels: string[] | undefined): ThinkingLevelMap {
	if (!levels) return { xhigh: "xhigh", max: "max" };
	const map: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) map[level] = levels.includes(level) ? level : null;
	map.off = levels.includes("none") ? "none" : null;
	return map;
}

/** One `dotted.path=value` predicate from discover.require. */
export interface RequirePredicate {
	text: string;
	path: string[];
	value: string;
}

/**
 * Split on the first `=`, so a value may contain one. A malformed predicate throws rather than
 * being ignored: a filter that silently matches nothing would register an empty provider.
 */
export function parseRequire(text: string): RequirePredicate {
	const at = text.indexOf("=");
	if (at <= 0) throw new Error(`discover.require: predicate "${text}" is not path=value`);
	return { text, path: text.slice(0, at).trim().split("."), value: text.slice(at + 1).trim() };
}

function valueAt(entry: unknown, path: string[]): unknown {
	let value: unknown = entry;
	for (const key of path) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

/** A path that holds an array matches when any element matches, so capabilities read naturally. */
function matchesRequire(entry: EndpointModel, predicate: RequirePredicate): boolean {
	const found = valueAt(entry, predicate.path);
	const wanted = predicate.value.toLowerCase();
	const candidates = Array.isArray(found) ? found : [found];
	return candidates.some((c) => c !== undefined && c !== null && String(c).toLowerCase() === wanted);
}

/** Parse a GET /models payload into models to register, plus what was skipped and why. */
export function parseModelsPayload(payload: unknown, discover?: DiscoverOptions): { models: DiscoveredModel[]; rejected: RejectedModel[] } {
	const entries = Array.isArray(payload)
		? (payload as EndpointModel[])
		: ((payload as { data?: EndpointModel[] })?.data ?? []);

	const required = (discover?.require ?? []).map(parseRequire);
	const models: DiscoveredModel[] = [];
	const rejected: RejectedModel[] = [];

	for (const entry of entries) {
		const id = typeof entry?.id === "string" ? entry.id.trim() : "";
		if (!id) continue;

		if (isDecisionModel(entry)) {
			rejected.push({
				id,
				cause: "decision model",
				reason: "reports output modality 'decisions'; register it as a classifier instead",
			});
			continue;
		}

		if (hasNoTextOutput(entry)) {
			rejected.push({
				id,
				cause: "no text output",
				reason: `reports output modalities ${JSON.stringify(entry.architecture?.output_modalities)}; not a chat model`,
			});
			continue;
		}

		const missed = required.find((predicate) => !matchesRequire(entry, predicate));
		if (missed) {
			rejected.push({
				id,
				cause: "excluded by discover.require",
				reason: `${missed.text} did not match; the endpoint reports no such field, or a different value`,
			});
			continue;
		}

		const contextWindow = reportedContextWindow(entry);
		if (contextWindow === undefined) {
			rejected.push({
				id,
				cause: "no context window reported",
				reason: "endpoint reports no context window; pin \"contextWindow\" for this model in models.json",
			});
			continue;
		}

		const reported = reportedMaxTokens(entry);
		const cost = discover?.pricing === false ? undefined : reportedCost(entry);
		const thinking = reportedReasoning(entry);
		models.push({
			id,
			name: typeof entry.name === "string" && entry.name ? entry.name : id,
			type: "chat",
			reasoning: thinking.supported,
			input: reportedInput(entry),
			contextWindow,
			maxTokens: reported !== undefined ? Math.min(reported, contextWindow) : fallbackMaxTokens(contextWindow),
			maxTokensReported: reported !== undefined,
			...(cost ? { cost } : {}),
			...(thinking.levels ? { thinkingLevels: thinking.levels } : {}),
		});
	}

	return { models, rejected };
}

/**
 * Skipped entries counted per cause, most skipped first. An endpoint that lists 500 models can skip
 * 50 of them for two reasons; naming all 50 is a wall of text, counting them by cause is one line.
 * At most `limit` causes are kept, and the last one carries the remainder so the total still adds up.
 */
export function groupRejections(rejected: RejectedModel[], limit = 3): { cause: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const entry of rejected) counts.set(entry.cause, (counts.get(entry.cause) ?? 0) + 1);

	const groups = [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([cause, count]) => ({ cause, count }));
	if (groups.length <= limit) return groups;
	const kept = groups.slice(0, limit - 1);
	const rest = groups.slice(limit - 1);
	kept.push({ cause: `${rest.length} other cause(s)`, count: rest.reduce((total, group) => total + group.count, 0) });
	return kept;
}

/**
 * The groups as one fragment: `no context window reported`, or `no context window reported (56),
 * decision model (4)`. A single group leaves out its count because the caller prints the total.
 * "" when nothing was rejected.
 */
export function describeRejections(rejected: RejectedModel[], limit = 3): string {
	const groups = groupRejections(rejected, limit);
	if (groups.length === 0) return "";
	if (groups.length === 1) return groups[0].cause;
	return groups.map((group) => `${group.cause} (${group.count})`).join(", ");
}

/** Resolve `$NAME`, `${NAME}`, `$$` and `$!`. A leading `!` (command) is refused. */
export function resolveConfigValue(raw: string): { value: string | null; error: string | null } {
	if (raw.startsWith("!")) return { value: null, error: "command values are not used for discovery requests" };

	const missing: string[] = [];
	const value = raw.replace(/\$\$|\$!|\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braceName, plainName) => {
		if (match === "$$") return "\0DOLLAR\0";
		if (match === "$!") return "\0BANG\0";
		const name = String(braceName ?? plainName);
		const fromEnv = process.env[name];
		if (fromEnv === undefined) {
			missing.push(name);
			return "";
		}
		return fromEnv;
	});

	if (missing.length > 0) return { value: null, error: `environment variables not set: ${missing.join(", ")}` };
	return { value: value.replaceAll("\0DOLLAR\0", "$").replaceAll("\0BANG\0", "!"), error: null };
}

/** Full URL of the model list. `modelsUrl` only affects discovery, never chat requests. */
export function modelsUrlFor(entry: ProviderEntry): string {
	if (entry.modelsUrl) return entry.modelsUrl;
	return `${(entry.baseUrl ?? "").replace(/\/+$/, "")}/models`;
}

/** Request the model list. Throws with the reason so the caller can report one line per provider. */
export async function fetchModels(
	entry: ProviderEntry,
	signal?: AbortSignal,
): Promise<{ models: DiscoveredModel[]; rejected: RejectedModel[] }> {
	if (!entry.baseUrl && !entry.modelsUrl) throw new Error("provider has neither baseUrl nor modelsUrl");

	const headers: Record<string, string> = {};
	for (const [key, raw] of Object.entries(entry.headers ?? {})) {
		const resolved = resolveConfigValue(raw);
		if (resolved.error) throw new Error(`header ${key}: ${resolved.error}`);
		if (resolved.value !== null) headers[key] = resolved.value;
	}
	if (entry.apiKey !== undefined) {
		const resolved = resolveConfigValue(entry.apiKey);
		if (resolved.error) throw new Error(`apiKey: ${resolved.error}`);
		if (resolved.value) headers.Authorization = `Bearer ${resolved.value}`;
	}

	const url = modelsUrlFor(entry);
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
	} catch (err) {
		throw new Error(`GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);

	const payload = await response.json().catch(() => undefined);
	if (payload === undefined) throw new Error(`GET ${url} returned a body that is not JSON`);

	const { models, rejected } = parseModelsPayload(payload, entry.discover);
	if (models.length === 0) {
		const detail = describeRejections(rejected);
		// A field the endpoint stops sending rejects everything, which is fail-closed but useless
		// to read unless the message says where to look.
		const filtered = rejected.length > 0 && rejected.every((r) => r.cause === "excluded by discover.require");
		throw new Error(
			`GET ${url} listed no usable models${detail ? ` (${rejected.length} skipped: ${detail})` : ""}` +
				(filtered ? "; every entry failed discover.require, check it against what this endpoint reports" : ""),
		);
	}
	return { models, rejected };
}

/**
 * Every provider entry in models.json, in file order, with `discoverModels` kept as
 * read. The caller decides what to do with each state: true discovers, false turns
 * discovery back off, absent means the provider is not this extension's business.
 */
export async function readModelsJsonProviders(modelsJsonPath: string): Promise<ProviderEntry[]> {
	let raw: string;
	try {
		raw = await readFile(modelsJsonPath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		return [];
	}

	const parsed = JSON.parse(raw) as { providers?: Record<string, Record<string, unknown>> };
	const providers = parsed?.providers;
	if (!providers || typeof providers !== "object") return [];

	const found: ProviderEntry[] = [];
	for (const [id, entry] of Object.entries(providers)) {
		if (!entry || typeof entry !== "object") continue;
		found.push({ ...(entry as object), id } as ProviderEntry);
	}
	return found;
}

/** A provider can only be discovered if there is somewhere to ask. */
export function canDiscover(entry: ProviderEntry): boolean {
	return Boolean(entry.baseUrl || entry.modelsUrl);
}

export type DiscoveryFlag = "on" | "off" | "unset";

export function discoveryFlag(entry: { discoverModels?: boolean }): DiscoveryFlag {
	if (entry.discoverModels === true) return "on";
	if (entry.discoverModels === false) return "off";
	return "unset";
}

/** Skip a JSON string from its opening quote; returns the index after the closing quote. */
function skipString(text: string, open: number): number {
	for (let i = open + 1; i < text.length; i++) {
		if (text[i] === "\\") {
			i++;
			continue;
		}
		if (text[i] === '"') return i + 1;
	}
	return text.length;
}

/** Index of the `}` closing the object that starts at `open`, or -1 if unbalanced. */
function findMatchingBrace(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			i = skipString(text, i) - 1;
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

interface Member {
	name: string;
	/** Index of the first non-space character of the value. */
	valueStart: number;
}

/** Direct members of the object starting at `open`, in file order. */
function findMembers(text: string, open: number): Member[] {
	const members: Member[] = [];
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			const after = skipString(text, i);
			let j = after;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (text[j] === ":" && depth === 1) {
				let k = j + 1;
				while (k < text.length && /\s/.test(text[k])) k++;
				members.push({ name: text.slice(i + 1, after - 1), valueStart: k });
			}
			i = after - 1;
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return members;
		}
	}
	return members;
}

/**
 * Set one provider's `discoverModels` by changing only the bytes that need to change.
 *
 * A `JSON.parse`/`stringify` round trip would reformat the whole file: expanding inline
 * objects, normalising whitespace, and collapsing duplicate keys a hand edit left behind.
 * This file is hand-maintained, so the edit stays local - either the value token of an
 * existing `discoverModels` is replaced, or one member line is inserted after the
 * provider's opening brace. Everything else comes back byte for byte.
 *
 * `false` is written explicitly rather than the key removed, so "turned off on purpose"
 * stays distinguishable from "never opted in".
 */
export function setDiscoveryFlagInText(
	raw: string,
	providerId: string,
	enabled: boolean,
): { text: string; changed: boolean } {
	const unchanged = { text: raw, changed: false };

	const rootOpen = raw.indexOf("{");
	if (rootOpen < 0) return unchanged;
	const providers = findMembers(raw, rootOpen).find((m) => m.name === "providers");
	if (!providers || raw[providers.valueStart] !== "{") return unchanged;

	const provider = findMembers(raw, providers.valueStart).find((m) => m.name === providerId);
	if (!provider || raw[provider.valueStart] !== "{") return unchanged;

	const bodyOpen = provider.valueStart;
	const wanted = enabled ? "true" : "false";
	const flag = findMembers(raw, bodyOpen).find((m) => m.name === "discoverModels");

	if (flag) {
		const literal = /^(true|false)/.exec(raw.slice(flag.valueStart))?.[1];
		if (!literal || literal === wanted) return unchanged;
		return {
			text: raw.slice(0, flag.valueStart) + wanted + raw.slice(flag.valueStart + literal.length),
			changed: true,
		};
	}

	const close = findMatchingBrace(raw, bodyOpen);
	if (close < 0) return unchanged;
	const afterBrace = bodyOpen + 1;
	const firstMemberLine = raw.slice(afterBrace, close).split("\n").find((line) => line.trim().length > 0) ?? "";
	const indent = firstMemberLine.match(/^\s*/)?.[0] ?? "  ";
	return {
		text: `${raw.slice(0, afterBrace)}\n${indent}"discoverModels": ${wanted},${raw.slice(afterBrace)}`,
		changed: true,
	};
}

/**
 * Read, edit and write models.json for one provider, keeping a pre-write copy beside it.
 * Returns false when nothing needed to change, in which case nothing is written.
 */
export async function setDiscoveryFlagInFile(
	modelsJsonPath: string,
	providerId: string,
	enabled: boolean,
): Promise<boolean> {
	const raw = await readFile(modelsJsonPath, "utf-8");
	const { text, changed } = setDiscoveryFlagInText(raw, providerId, enabled);
	if (!changed) return false;
	await writeFile(`${modelsJsonPath}.bak`, raw, "utf-8");
	await writeFile(modelsJsonPath, text, "utf-8");
	return true;
}
