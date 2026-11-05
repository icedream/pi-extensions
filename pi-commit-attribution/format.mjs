/**
 * The attribution line, and everything that has to be decided to write it.
 *
 * The format is a house rule, not a git convention: one `Assisted-by:` trailer per model that worked on
 * the commit, naming the tool and its version, the model's human-readable name, and whether that model
 * ran in the cloud or on the operator's own hardware. The engine is named when it is known, because
 * "self-hosted" alone does not say what is serving the model.
 *
 * This file is plain ES module JavaScript rather than TypeScript for one reason: git runs the hook in
 * its own process, and Pi supports Node versions older than the ones that strip TypeScript types by
 * default. Keeping the hook-side logic here means the hook runs on every Node Pi runs on, and the
 * extension imports the same functions instead of holding a second copy of the format.
 */

/**
 * @typedef {"cloud" | "local"} Placement
 * @typedef {{ provider: string, id: string }} ModelRef
 * @typedef {{ placement?: Placement, label?: string, engine?: string }} ProviderRule
 * @typedef {{ name?: string, placement?: Placement, label?: string, engine?: string }} ModelRule
 * @typedef {{ id: string, name?: string, baseUrl?: string }} CatalogModel
 * @typedef {{ baseUrl?: string, models?: CatalogModel[] }} CatalogProvider
 * @typedef {{ providers?: Record<string, CatalogProvider> }} ModelCatalog
 * @typedef {{ name: string, placement: Placement, label?: string, engine?: string }} ResolvedModel
 * @typedef {{ catalog?: ModelCatalog, providers?: Record<string, ProviderRule>, models?: Record<string, ModelRule>, localDomains?: string[] }} ResolveOptions
 */

/** Words whose usual capitalization is not title case. */
/** @type {Record<string, string>} */
const SPECIAL_WORDS = {
	github: "GitHub",
	gitlab: "GitLab",
	openai: "OpenAI",
	deepseek: "DeepSeek",
	qwen: "Qwen",
	llama: "Llama",
	litellm: "LiteLLM",
	ollama: "Ollama",
	azure: "Azure",
	aws: "AWS",
	gcp: "GCP",
};

/** Providers whose own name already states the engine, so config does not have to. */
/** @type {Record<string, string>} */
const ENGINE_BY_PROVIDER = {
	strata: "Strata",
	"llama-server": "llama.cpp",
	"llama.cpp": "llama.cpp",
};

/** Words kept uppercase when an id has to be turned into a name. */
const ACRONYMS = new Set(["gpt", "api", "mcp", "sre", "oss", "kv", "lora", "awq", "gptq", "fp8", "fp16", "fp32", "bf16", "bf8", "int8", "int4", "iq3", "iq2", "q2", "q3", "q4", "q5", "q6", "q8"]);

/** Quantisation, packing and publisher prefixes that are not part of a model's name. */
const QUANT_TAG = /:(?:q|iq|fp|bf|int)\w*$/i;

/**
 * Suffixes that mean a name is resolved by the operator's own network. A public-sounding domain that
 * happens to be served on the LAN is not covered: the operator names it in config under `localDomains`.
 */
const PRIVATE_SUFFIXES = [".local", ".localhost", ".home.arpa", ".home.int", ".home", ".lan", ".internal", ".intranet", ".corp", ".localdomain"];

/** @param {string} host @param {string[]} domains */
function inDomains(host, domains) {
	return domains.some((domain) => {
		const bare = domain.replace(/^\./, "").toLowerCase();
		return bare.length > 0 && (host === bare || host.endsWith(`.${bare}`));
	});
}

/** @param {ModelRef} ref */
export function modelKey(ref) {
	return `${ref.provider}/${ref.id}`;
}

/**
 * Loopback, the private address ranges, Tailscale's carrier-grade NAT block, or a private DNS name mean
 * the model runs on hardware the operator controls. Anything else is cloud, and an address we cannot
 * classify is cloud too: claiming local would understate where the prompt went.
 *
 * @param {string | undefined} url
 * @param {string[]} [localDomains] additional private domains from config
 * @returns {Placement | undefined}
 */
export function placementFromUrl(url, localDomains) {
	if (!url) return undefined;
	let host;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return undefined;
	}
	if (!host) return undefined;
	if (host === "localhost" || host.endsWith(".localhost")) return "local";
	if (host === "::1" || host === "[::1]") return "local";
	if (/^\d+$/.test(host)) return undefined;
	if (/^127\.\d+\.\d+\.\d+$/.test(host)) return "local";
	if (/^10\.\d+\.\d+\.\d+$/.test(host)) return "local";
	if (/^192\.168\.\d+\.\d+$/.test(host)) return "local";
	if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)) return "local";
	if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host)) return "local";
	if (/^169\.254\.\d+\.\d+$/.test(host)) return "local";
	if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "local";
	if (localDomains && inDomains(host, localDomains)) return "local";
	// A single-label name is one a resolver only answers from /etc/hosts, mDNS or a search domain, so it
	// is a machine on the operator's own network rather than a public service.
	if (!host.includes(".") && !/^[0-9.]+$/.test(host)) return "local";
	return "cloud";
}

/**
 * `qwen3.8-flash-next-iq3_s` becomes `Qwen 3.8 Flash Next`: separators to spaces, the quantisation tail
 * dropped from the end, version numbers split from the name in front of them. Only used when Pi's
 * catalog carries no name we can use, and the config `models` table is there to override what this gets
 * wrong.
 *
 * @param {string} id
 */
export function prettifyModelId(id) {
	const last = (id.split("/").pop() ?? id).replace(QUANT_TAG, "");
	const parts = last.split(/[-_:\s]+/).filter((part) => part.length > 0);
	while (parts.length > 1 && isQuantTail(parts[parts.length - 1])) parts.pop();
	return parts.flatMap(splitVersion).map(uppercaseWord).join(" ");
}

/** The tail of an id that says how the weights were packed rather than which model they are. */
/** @param {string} part */
function isQuantTail(part) {
	const lower = part.toLowerCase();
	return /^(iq?\d+([a-z]{1,2})?|fp(8|16|32)|bf(8|16)|int(4|8)|awq|gptq|gguf|qat|unsloth|instruct|exl[23]|[a-z]{1,2})$/.test(lower);
}

/** `qwen3.8` reads as two words, `26B` does not. */
/** @param {string} part @returns {string[]} */
function splitVersion(part) {
	return part.split(/(?<=[a-zA-Z])(?=\d+\.\d)/);
}

/** @param {string} provider */
export function prettifyProviderId(provider) {
	return provider
		.split(/[-_. ]+/)
		.filter((part) => part.length > 0)
		.map(uppercaseWord)
		.join(" ");
}

/** @param {string} part */
function uppercaseWord(part) {
	const lower = part.toLowerCase();
	if (SPECIAL_WORDS[lower]) return SPECIAL_WORDS[lower];
	if (ACRONYMS.has(lower)) return lower.toUpperCase();
	// A size suffix keeps its capital: `27b` is 27B, and 27b would read like a word.
	if (/^\d+[a-z]$/.test(lower)) return part.charAt(0) + part.slice(1).toUpperCase();
	return part.charAt(0).toUpperCase() + part.slice(1);
}

/** @param {ModelRef} ref @param {ModelCatalog | undefined} catalog */
/** @param {ModelRef} ref @param {ModelCatalog | undefined} catalog @returns {CatalogModel | undefined} */
/**
 * The name to put in the line. A catalog entry sometimes carries the id back with different
 * punctuation, which is not the human-readable name the format asks for: underscores, a quantisation
 * tail, or the id itself mean the entry is a label rather than a name, and it reads better cleaned than
 * repeated. A config `models` entry outranks all of this.
 *
 * @param {string | undefined} catalogName
 * @param {string} id
 */
function displayName(catalogName, id) {
	const name = (catalogName ?? "").trim();
	if (name.length === 0) return prettifyModelId(id);
	if (name.toLowerCase() === id.toLowerCase()) return prettifyModelId(name);
	if (name.includes("_") || name.includes(":") || /(^|[-.])iq?\d+[a-z_]*$/i.test(name)) return prettifyModelId(name);
	return name;
}

/** @param {ModelRef} ref @param {ModelCatalog | undefined} catalog @returns {CatalogModel | undefined} */
function catalogModel(ref, catalog) {
	const entry = catalog?.providers?.[ref.provider];
	if (!entry?.models) return undefined;
	return entry.models.find((model) => model.id === ref.id);
}

/**
 * Name, placement, label and engine for one model, in the order the operator can override: the config
 * rule for this exact model, then the rule for its provider, then Pi's catalog, then the address.
 *
 * @param {ModelRef} ref
 * @param {ResolveOptions} options
 * @returns {ResolvedModel}
 */
export function resolveModel(ref, options) {
	const providerRule = options.providers?.[ref.provider];
	const modelRule = options.models?.[modelKey(ref)];
	const catalog = catalogModel(ref, options.catalog);

	const name = modelRule?.name || displayName(catalog?.name, ref.id);
	const domains = options.localDomains ?? [];
	const placement =
		modelRule?.placement ||
		providerRule?.placement ||
		placementFromUrl(catalog?.baseUrl, domains) ||
		placementFromUrl(options.catalog?.providers?.[ref.provider]?.baseUrl, domains) ||
		"cloud";
	const label = modelRule?.label || providerRule?.label || (placement === "local" ? "self-hosted" : prettifyProviderId(ref.provider));
	const engine = modelRule?.engine || providerRule?.engine || ENGINE_BY_PROVIDER[ref.provider] || ENGINE_BY_PROVIDER[(ref.provider.split("/").pop() ?? ref.provider).toLowerCase()];

	return { name, placement, label, engine };
}

/**
 * `Assisted-by: pi 1.4.0 / Qwen 3.8 Flash Next (local, self-hosted, Strata)`
 *
 * @param {ResolvedModel} model
 * @param {{ name: string, version: string }} tool
 */
export function assistedBy(model, tool) {
	/** @type {string[]} */
	const parts = [model.placement];
	if (model.label) parts.push(model.label);
	if (model.engine) parts.push(model.engine);
	return `Assisted-by: ${tool.name} ${tool.version} / ${model.name} (${parts.join(", ")})`;
}

/**
 * The person driving the session, and only when that is not the author git would use. A config entry
 * that matches the commit author's address adds nothing, which is the common case.
 *
 * @param {string | undefined} operator
 * @param {string | undefined} authorEmail
 */
export function operatedBy(operator, authorEmail) {
	if (!operator) return undefined;
	const address = operator.match(/<([^>]+)>/)?.[1]?.trim();
	if (address && authorEmail && address.toLowerCase() === authorEmail.trim().toLowerCase()) return undefined;
	return `Operated-by: ${operator}`;
}

/**
 * Order and de-duplicate the lines for one commit. Lines are compared whole, so a hand-written
 * `Assisted-by:` for the same model is kept instead of a second one being added.
 *
 * @param {string[]} lines
 * @param {number} max
 */
export function finalizeLines(lines, max) {
	const seen = new Set();
	const out = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
		if (out.length >= max) break;
	}
	return out;
}
