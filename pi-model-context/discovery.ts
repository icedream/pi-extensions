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
}

/** One entry of a GET /models response, typed as loosely as servers actually send it. */
export interface EndpointModel {
	id?: string;
	name?: string;
	n_ctx?: number | string;
	context_window?: number | string;
	contextWindow?: number | string;
	max_model_len?: number | string;
	max_tokens?: number | string;
	maxTokens?: number | string;
	meta?: { n_ctx?: number | string; n_predict?: number | string; [key: string]: unknown };
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
}

export interface RejectedModel {
	id: string;
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
 * vLLM sends. Neither is an OpenAI-style key, so a client that only reads
 * `context_window` sees nothing. Never guess a number here - a made-up window is worse
 * than no window, because Pi then keeps growing the session past what the server accepts.
 */
export function reportedContextWindow(model: EndpointModel): number | undefined {
	const candidates = [
		model.meta?.n_ctx,
		model.n_ctx,
		model.context_window,
		model.contextWindow,
		model.max_model_len,
	];
	for (const candidate of candidates) {
		const n = positiveNumber(candidate);
		if (n !== undefined) return n;
	}
	return undefined;
}

/** The output limit the endpoint reports, or undefined. */
export function reportedMaxTokens(model: EndpointModel): number | undefined {
	const candidates = [model.meta?.n_predict, model.max_tokens, model.maxTokens];
	for (const candidate of candidates) {
		const n = positiveNumber(candidate);
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

/** Parse a GET /models payload into models to register, plus what was skipped and why. */
export function parseModelsPayload(payload: unknown): { models: DiscoveredModel[]; rejected: RejectedModel[] } {
	const entries = Array.isArray(payload)
		? (payload as EndpointModel[])
		: ((payload as { data?: EndpointModel[] })?.data ?? []);

	const models: DiscoveredModel[] = [];
	const rejected: RejectedModel[] = [];

	for (const entry of entries) {
		const id = typeof entry?.id === "string" ? entry.id.trim() : "";
		if (!id) continue;

		if (isDecisionModel(entry)) {
			rejected.push({ id, reason: "reports output modality 'decisions'; register it as a classifier instead" });
			continue;
		}

		const contextWindow = reportedContextWindow(entry);
		if (contextWindow === undefined) {
			rejected.push({
				id,
				reason: "endpoint reports no context window; pin \"contextWindow\" for this model in models.json",
			});
			continue;
		}

		const reported = reportedMaxTokens(entry);
		models.push({
			id,
			name: typeof entry.name === "string" && entry.name ? entry.name : id,
			type: "chat",
			reasoning: true,
			input: reportedInput(entry),
			contextWindow,
			maxTokens: Math.min(reported ?? DEFAULT_MAX_TOKENS, contextWindow),
			maxTokensReported: reported !== undefined,
		});
	}

	return { models, rejected };
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
export async function fetchModels(entry: ProviderEntry, signal?: AbortSignal): Promise<DiscoveredModel[]> {
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

	const { models, rejected } = parseModelsPayload(payload);
	if (models.length === 0) {
		const skipped = rejected.map((r) => `${r.id} (${r.reason})`).join("; ");
		throw new Error(`GET ${url} listed no usable models${skipped ? `: ${skipped}` : ""}`);
	}
	return models;
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
