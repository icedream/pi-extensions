// Unit tests for pi-model-context. Run from pi-model-context/: node --test discovery.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	DEFAULT_MAX_TOKENS,
	canDiscover,
	describeRejections,
	discoveryFlag,
	fetchModels,
	groupRejections,
	hasNoTextOutput,
	isDecisionModel,
	modelsUrlFor,
	parseRequire,
	parseModelsPayload,
	readModelsJsonProviders,
	reportedContextWindow,
	reportedCost,
	reportedInput,
	reportedReasoning,
	resolveConfigValue,
	setDiscoveryFlagInFile,
	setDiscoveryFlagInText,
	type RejectedModel,
} from "./discovery.ts";

/** Mirrors the awkward shapes a hand-maintained models.json really has. */
const fixture = `{
  "providers": {
    "catalog": {
      "api": "openai-completions",
      "apiKey": "k1",
      "apiKey": "k2",
      "baseUrl": "https://x/api/v1",
      "discoverModels": true,
      "models": [
        {"id":"auto","name":"Router Auto"}
      ]
    },
    "other": { "baseUrl": "http://y/v1" }
  },
  "defaultModel": "catalog/auto"
}
`;

/** The shape Strata's /v1/models actually returns. */
const strataPayload = {
	object: "list",
	data: [
		{
			id: "qwen3.8-flash-next-iq3_s",
			object: "model",
			status: { value: "loaded" },
			meta: { n_ctx: 393216 },
			architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		},
	],
};

test("reads the context window from meta.n_ctx", () => {
	const { models, rejected } = parseModelsPayload(strataPayload);
	assert.equal(rejected.length, 0);
	assert.equal(models.length, 1);
	assert.equal(models[0].contextWindow, 393216);
});

test("does not invent a context window when the endpoint reports none", () => {
	const { models, rejected } = parseModelsPayload({
		data: [{ id: "silent-model", object: "model" }],
	});
	assert.equal(models.length, 0);
	assert.equal(rejected.length, 1);
	assert.equal(rejected[0].id, "silent-model");
	assert.match(rejected[0].reason, /pin "contextWindow".*in models\.json/);
});

test("reads the vLLM context window from max_model_len", () => {
	const { models, rejected } = parseModelsPayload({
		object: "list",
		data: [
			{
				id: "some/model-35b",
				object: "model",
				created: 1791470824,
				owned_by: "vllm",
				root: "s3://models/model-35b-fp8",
				parent: null,
				max_model_len: 262144,
			},
		],
	});
	assert.equal(rejected.length, 0);
	assert.equal(models[0].contextWindow, 262144);
	// vLLM declares no modalities, so text is the only safe assumption.
	assert.deepEqual(models[0].input, ["text"]);
});

test("accepts the OpenAI-style keys as fallbacks", () => {
	assert.equal(reportedContextWindow({ context_window: 131072 }), 131072);
	assert.equal(reportedContextWindow({ contextWindow: 65536 }), 65536);
	assert.equal(reportedContextWindow({ n_ctx: 32768 }), 32768);
	assert.equal(reportedContextWindow({ context_length: 1048576 }), 1048576);
	// meta.n_ctx wins when a server sends both.
	assert.equal(reportedContextWindow({ meta: { n_ctx: 393216 }, context_window: 1000000 }), 393216);
});

test("coerces a numeric string and rejects a non-positive one", () => {
	assert.equal(reportedContextWindow({ meta: { n_ctx: "393216" } }), 393216);
	assert.equal(reportedContextWindow({ meta: { n_ctx: 0 } }), undefined);
	assert.equal(reportedContextWindow({ meta: { n_ctx: -1 } }), undefined);
	assert.equal(reportedContextWindow({ meta: { n_ctx: "not-a-number" } }), undefined);
});

test("reads input modalities, and defaults to text only", () => {
	assert.deepEqual(reportedInput({ architecture: { input_modalities: ["text", "image"] } }), ["text", "image"]);
	assert.deepEqual(reportedInput({ architecture: { input_modalities: ["text"] } }), ["text"]);
	// Assuming image support is the failure this guards against.
	assert.deepEqual(reportedInput({}), ["text"]);
	assert.deepEqual(reportedInput({ architecture: { input_modalities: [] } }), ["text"]);
	assert.deepEqual(reportedInput({ architecture: { input_modalities: ["audio"] } }), ["text"]);
});

test("a vision model is registered with image input", () => {
	const { models } = parseModelsPayload({
		data: [
			{
				id: "vision-model",
				meta: { n_ctx: 32768 },
				architecture: { input_modalities: ["text", "image"] },
			},
		],
	});
	assert.deepEqual(models[0].input, ["text", "image"]);
});

test("decision models are skipped rather than registered as chat models", () => {
	const decision = { id: "julia-1", meta: { n_ctx: 8192 }, architecture: { output_modalities: ["decisions"] } };
	assert.equal(isDecisionModel(decision), true);
	const { models, rejected } = parseModelsPayload({ data: [decision] });
	assert.equal(models.length, 0);
	assert.match(rejected[0].reason, /classifier/);
});

test("reads the context window from context_length, as OpenRouter-style lists send it", () => {
	const { models, rejected } = parseModelsPayload({
		object: "list",
		data: [
			{
				id: "alibaba:global/deepseek-v4-pro",
				object: "model",
				context_length: 1048576,
				architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
				vendor: { type: "llm", max_output_tokens: 393216 },
			},
		],
	});
	assert.equal(rejected.length, 0);
	assert.equal(models[0].contextWindow, 1048576);
	assert.equal(models[0].maxTokens, 393216);
	assert.equal(models[0].maxTokensReported, true);
});

test("maxTokens comes from the nested max_output_tokens, clamped to the context window", () => {
	const { models } = parseModelsPayload({
		data: [
			{ id: "gemma", context_length: 262144, vendor: { max_output_tokens: 8192 } },
			{ id: "tiny", context_length: 4096, vendor: { max_output_tokens: 8192 } },
		],
	});
	assert.equal(models[0].maxTokens, 8192);
	assert.equal(models[1].maxTokens, 4096);
});

test("max_output_tokens is read from any object-valued field, and endpoint-level keys still win", () => {
	const { models } = parseModelsPayload({
		data: [
			{ id: "any-name", context_length: 262144, acme: { max_output_tokens: 8192 } },
			{ id: "endpoint-wins", context_length: 262144, meta: { n_predict: 2048 }, billing: { max_output_tokens: 4096 } },
			{ id: "array-ignored", context_length: 262144, list: [{ max_output_tokens: 1024 }] },
		],
	});
	assert.equal(models[0].maxTokens, 8192);
	assert.equal(models[1].maxTokens, 2048);
	assert.equal(models[2].maxTokens, DEFAULT_MAX_TOKENS);
});

test("embedding and image-only models are skipped rather than registered as chat models", () => {
	const embedding = { id: "deepinfra/BAAI/bge-m3", context_length: 8192, architecture: { output_modalities: ["embeddings"] } };
	const image = { id: "novita/ming-image-0.1-design", context_length: 4096, architecture: { output_modalities: ["image"] } };
	const { models, rejected } = parseModelsPayload({ data: [embedding, image] });
	assert.equal(models.length, 0);
	assert.deepEqual(
		rejected.map((r) => r.cause),
		["no text output", "no text output"],
	);
	assert.match(rejected[0].reason, /\["embeddings"\]; not a chat model/);
});

test("only a declared output without text is treated as non-chat", () => {
	assert.equal(hasNoTextOutput({ architecture: { output_modalities: ["text", "image"] } }), false);
	assert.equal(hasNoTextOutput({ architecture: { output_modalities: ["embeddings"] } }), true);
	// Silence about outputs is kept as a chat model, as before.
	assert.equal(hasNoTextOutput({ architecture: {} }), false);
	assert.equal(hasNoTextOutput({ architecture: { output_modalities: [] } }), false);
	assert.equal(hasNoTextOutput({}), false);
});

test("maxTokens comes from the endpoint when reported", () => {
	const { models } = parseModelsPayload({
		data: [{ id: "m", meta: { n_ctx: 262144, n_predict: 8192 } }],
	});
	assert.equal(models[0].maxTokens, 8192);
	assert.equal(models[0].maxTokensReported, true);
});

test("an unreported maxTokens falls back to half the window and is flagged", () => {
	// Large window: DEFAULT_MAX_TOKENS is the smaller half, unchanged.
	const { models } = parseModelsPayload({ data: [{ id: "big", meta: { n_ctx: 393216 } }] });
	assert.equal(models[0].maxTokens, DEFAULT_MAX_TOKENS);
	assert.equal(models[0].maxTokensReported, false);

	// Small window: the whole window is not a budget, because the prompt has to fit in it too.
	const small = parseModelsPayload({ data: [{ id: "small", meta: { n_ctx: 4096 } }] });
	assert.equal(small.models[0].maxTokens, 2048);

	// llama.cpp reporting -1 (--n-predict default, "no limit") is not a reported cap.
	const unbounded = parseModelsPayload({ data: [{ id: "olala", meta: { n_ctx: 32768, n_predict: -1 } }] });
	assert.equal(unbounded.models[0].maxTokens, 16384);
	assert.equal(unbounded.models[0].maxTokensReported, false);
});

test("a reported cap still wins over the fallback", () => {
	const { models } = parseModelsPayload({ data: [{ id: "capped", meta: { n_ctx: 32768, n_predict: 8192 } }] });
	assert.equal(models[0].maxTokens, 8192);
	assert.equal(models[0].maxTokensReported, true);
});

test("a mixed list keeps usable models and reports the skipped ones", () => {
	const { models, rejected } = parseModelsPayload({
		data: [
			{ id: "ok-a", meta: { n_ctx: 32768 } },
			{ id: "no-context" },
			{ id: "ok-b", context_window: 8192 },
			{ id: "", meta: { n_ctx: 1024 } },
		],
	});
	assert.deepEqual(
		models.map((m) => m.id),
		["ok-a", "ok-b"],
	);
	assert.deepEqual(
		rejected.map((r) => r.id),
		["no-context"],
	);
});

test("a bare array payload is accepted", () => {
	const { models } = parseModelsPayload([{ id: "m", meta: { n_ctx: 4096 } }]);
	assert.equal(models.length, 1);
});

test("per-token prices become per-Mtok costs", () => {
	const { models } = parseModelsPayload({
		data: [
			{
				id: "claude-sonnet-5-5",
				context_length: 1_000_000,
				pricing: { prompt: "0.0000022", completion: "0.000011", input_cache_read: "0.00000025", input_cache_write: "0.00000275" },
			},
		],
	});
	assert.deepEqual(models[0].cost, { input: 2.2, output: 11, cacheRead: 0.25, cacheWrite: 2.75 });
});

test("price strings are rounded, not left as float noise", () => {
	assert.deepEqual(reportedCost({ pricing: { prompt: "0.000003", completion: "0.000015" } }), {
		input: 3,
		output: 15,
		cacheRead: 0,
		cacheWrite: 0,
	});
	// 1.7985600000000002 would end up in every registered model otherwise.
	assert.equal(reportedCost({ pricing: { prompt: "0.00000179856", completion: "0.00000359712" } })?.input, 1.79856);
});

test("dynamic or one-sided pricing leaves a model unpriced", () => {
	// OpenRouter-style lists put -1 where the price is negotiated per call.
	assert.equal(reportedCost({ pricing: { prompt: "-1", completion: "-1" } }), undefined);
	// Half a price would bill one side at zero, so it is not registered as a price either.
	assert.equal(reportedCost({ pricing: { prompt: "0.000002" } }), undefined);
	assert.equal(reportedCost({ pricing: { completion: "0.00001" } }), undefined);
	assert.equal(reportedCost({}), undefined);
	assert.equal(parseModelsPayload({ data: [{ id: "m", meta: { n_ctx: 4096 } }] }).models[0].cost, undefined);
});

test("discover.pricing false keeps a provider free despite prices", () => {
	const priced = { data: [{ id: "m", meta: { n_ctx: 4096 }, pricing: { prompt: "0.000001", completion: "0.000002" } }] };
	assert.equal(parseModelsPayload(priced, { pricing: false }).models[0].cost, undefined);
	assert.equal(parseModelsPayload(priced, { pricing: true }).models[0].cost?.input, 1);
});

test("reportedReasoning reads the levels an endpoint names", () => {
	assert.deepEqual(
		reportedReasoning({ opper: { reasoning: { supported: ["low", "medium", "high"] }, capabilities: ["reasoning", "tools"] } }),
		{ supported: true, levels: ["low", "medium", "high"] },
	);
	assert.deepEqual(reportedReasoning({ params: { reasoning: { supported: ["none", "low"] } } }), { supported: true, levels: ["none", "low"] });
	// A capability list without a level list still says whether the model reasons at all.
	assert.deepEqual(reportedReasoning({ opper: { reasoning: null, capabilities: ["text"] } }), { supported: false });
	// Silence keeps the assumption this extension always made before.
	assert.deepEqual(reportedReasoning({}), { supported: true });
	assert.deepEqual(reportedReasoning({ opper: { reasoning: { supported: [] }, capabilities: ["reasoning"] } }), { supported: true });
});

test("the reasoning flag and level list reach the registered model", () => {
	const { models } = parseModelsPayload({
		data: [
			{ id: "thinker", context_length: 1_000_000, opper: { reasoning: { supported: ["low", "high", "xhigh"] }, capabilities: ["reasoning"] } },
			{ id: "plain", context_length: 8192, opper: { capabilities: ["text"] } },
		],
	});
	assert.deepEqual(models[0].thinkingLevels, ["low", "high", "xhigh"]);
	assert.equal(models[0].reasoning, true);
	assert.equal(models[1].reasoning, false);
	assert.equal(models[1].thinkingLevels, undefined);
});

test("discover.require narrows an aggregator list by a reported field", () => {
	const payload = {
		data: [
			{ id: "eu-route", context_length: 1000, opper: { gdpr_residency: "EU" } },
			{ id: "us-route", context_length: 1000, opper: { gdpr_residency: "US" } },
			{ id: "silent", context_length: 1000 },
		],
	};
	const { models, rejected } = parseModelsPayload(payload, { require: ["opper.gdpr_residency=EU"] });
	assert.deepEqual(models.map((m) => m.id), ["eu-route"]);
	assert.equal(rejected.length, 2);
	assert.match(rejected[1].reason, /gdpr_residency/);
	// Values compare case-insensitively, and every predicate has to hold.
	assert.equal(parseModelsPayload(payload, { require: ["opper.gdpr_residency=eu"] }).models.length, 1);
	assert.equal(parseModelsPayload(payload, { require: ["opper.gdpr_residency=EU", "type=llm"] }).models.length, 0);
});

test("a require predicate matches any element of an array field", () => {
	const payload = {
		data: [
			{ id: "tooly", context_length: 1000, opper: { capabilities: ["text", "tools"] } },
			{ id: "plain", context_length: 1000, opper: { capabilities: ["text"] } },
		],
	};
	const { models } = parseModelsPayload(payload, { require: ["opper.capabilities=tools"] });
	assert.deepEqual(models.map((m) => m.id), ["tooly"]);
});

test("a malformed require predicate fails instead of matching nothing", () => {
	assert.throws(() => parseRequire("gdpr_residency"), /not path=value/);
	assert.throws(() => parseModelsPayload({ data: [] }, { require: ["=EU"] }), /not path=value/);
	// A value may contain `=`: the path is everything before the first one.
	assert.deepEqual(parseRequire("a.b=x=y").value, "x=y");
});

test("a filter that rejects the whole list says the filter is what rejected it", async () => {
	const realFetch = globalThis.fetch;
	try {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ data: [{ id: "m", context_length: 1000 }] }), { status: 200 })) as typeof fetch;
		await assert.rejects(
			fetchModels({ id: "p", baseUrl: "http://x/v1", discover: { require: ["opper.gdpr_residency=EU"] } }),
			/failed discover.require/,
		);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("modelsUrl overrides the discovery URL, and a trailing slash is trimmed", () => {
	assert.equal(modelsUrlFor({ id: "p", baseUrl: "http://h:1/v1" }), "http://h:1/v1/models");
	assert.equal(modelsUrlFor({ id: "p", baseUrl: "http://h:1/v1/" }), "http://h:1/v1/models");
	assert.equal(modelsUrlFor({ id: "p", baseUrl: "http://h:1/v1", modelsUrl: "http://other/catalog" }), "http://other/catalog");
});

test("config values resolve environment interpolation", () => {
	process.env.PMC_TEST_KEY = "literal-from-env";
	assert.deepEqual(resolveConfigValue("$PMC_TEST_KEY"), { value: "literal-from-env", error: null });
	assert.deepEqual(resolveConfigValue("${PMC_TEST_KEY}"), { value: "literal-from-env", error: null });
	assert.deepEqual(resolveConfigValue("sk-plain"), { value: "sk-plain", error: null });
	assert.deepEqual(resolveConfigValue("$$literal"), { value: "$literal", error: null });
	assert.deepEqual(resolveConfigValue("$!leading"), { value: "!leading", error: null });
});

test("a missing environment variable is an error, not an empty key", () => {
	const resolved = resolveConfigValue("$PMC_NOT_SET_ANYWHERE");
	assert.equal(resolved.value, null);
	assert.match(resolved.error ?? "", /PMC_NOT_SET_ANYWHERE/);
});

test("command values are refused for discovery requests", () => {
	const resolved = resolveConfigValue("!vault read");
	assert.equal(resolved.value, null);
	assert.match(resolved.error ?? "", /command values/i);
});

test("readModelsJsonProviders keeps every provider so false can turn discovery off", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-model-context-"));
	const file = path.join(dir, "models.json");
	await fs.writeFile(
		file,
		JSON.stringify({
			providers: {
				"host/local": { baseUrl: "http://127.0.0.1:8080/v1", discoverModels: true },
				"host/pinned": { baseUrl: "http://127.0.0.1:9/v1", discoverModels: false },
				"host/plain": { baseUrl: "http://127.0.0.1:8/v1" },
			},
		}),
		"utf-8",
	);

	const providers = await readModelsJsonProviders(file);
	assert.deepEqual(
		providers.map((p) => [p.id, p.discoverModels]),
		[
			["host/local", true],
			["host/pinned", false],
			["host/plain", undefined],
		],
	);
	await fs.rm(dir, { recursive: true, force: true });
});

test("discoveryFlag reports on, off and never-opted-in separately", () => {
	assert.equal(discoveryFlag({ discoverModels: true }), "on");
	assert.equal(discoveryFlag({ discoverModels: false }), "off");
	assert.equal(discoveryFlag({}), "unset");
});

test("canDiscover requires somewhere to ask", () => {
	assert.equal(canDiscover({ id: "p", baseUrl: "http://h/v1" }), true);
	assert.equal(canDiscover({ id: "p", modelsUrl: "http://h/catalog" }), true);
	assert.equal(canDiscover({ id: "p" }), false);
});

test("the text edit changes only the flag token", () => {
	const { text, changed } = setDiscoveryFlagInText(fixture, "catalog", false);
	assert.equal(changed, true);

	const before = fixture.split("\n");
	const after = text.split("\n");
	assert.equal(before.length, after.length);
	assert.deepEqual(
		before.filter((line, i) => line !== after[i]),
		['      "discoverModels": true,'],
	);
	assert.deepEqual(
		after.filter((line, i) => line !== before[i]),
		['      "discoverModels": false,'],
	);
});

test("the text edit leaves hand formatting and duplicate keys alone", () => {
	const { text } = setDiscoveryFlagInText(fixture, "catalog", false);
	// Two apiKey lines in one object: a JSON round trip would collapse them.
	assert.equal((text.match(/"apiKey":/g) ?? []).length, 2);
	// A compact inline object stays compact.
	assert.match(text, /\{"id":"auto","name":"Router Auto"\}/);
	// Everything still parses, and unrelated keys are untouched.
	const parsed = JSON.parse(text) as { providers: { catalog: { discoverModels: boolean } }; defaultModel: string };
	assert.equal(parsed.defaultModel, "catalog/auto");
	assert.equal(parsed.providers.catalog.discoverModels, false);
});

test("the text edit inserts the key when the provider has none", () => {
	const { text, changed } = setDiscoveryFlagInText(fixture, "other", true);
	assert.equal(changed, true);
	const parsed = JSON.parse(text) as { providers: Record<string, { discoverModels?: boolean; baseUrl?: string }> };
	assert.equal(parsed.providers.other.discoverModels, true);
	assert.equal(parsed.providers.other.baseUrl, "http://y/v1");
	assert.match(text, /"other": \{\n\s*"discoverModels": true,/);
});

test("the text edit is a no-op when already in the wanted state", () => {
	assert.equal(setDiscoveryFlagInText(fixture, "catalog", true).changed, false);
});

test("the text edit ignores an unknown provider and non-provider keys", () => {
	assert.equal(setDiscoveryFlagInText(fixture, "nope", true).changed, false);
	// "defaultModel" is a root member, not a provider, so it must not be touched.
	assert.equal(setDiscoveryFlagInText(fixture, "defaultModel", true).changed, false);
	assert.equal(setDiscoveryFlagInText(fixture, "catalog", false).changed, true);
});

test("setDiscoveryFlagInFile writes the edit and keeps a pre-write copy", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-model-context-write-"));
	const file = path.join(dir, "models.json");
	await fs.writeFile(file, fixture, "utf-8");

	assert.equal(await setDiscoveryFlagInFile(file, "catalog", false), true);
	assert.equal(await fs.readFile(file, "utf-8"), setDiscoveryFlagInText(fixture, "catalog", false).text);
	assert.equal(await fs.readFile(`${file}.bak`, "utf-8"), fixture);

	// A second call to the same state writes nothing, so no new backup either.
	await fs.rm(`${file}.bak`, { force: true });
	assert.equal(await setDiscoveryFlagInFile(file, "catalog", false), false);
	await assert.rejects(() => fs.access(`${file}.bak`));
	await fs.rm(dir, { recursive: true, force: true });
});

test("a missing models.json is not an error", async () => {
	const providers = await readModelsJsonProviders(path.join(os.tmpdir(), "pi-model-context-absent.json"));
	assert.deepEqual(providers, []);
});

const skipped = (ids: string[], cause: string): RejectedModel[] => ids.map((id) => ({ id, cause, reason: `${cause}; see models.json` }));

test("parseModelsPayload names the cause of every skip, not just its advice", () => {
	const { rejected } = parseModelsPayload({
		data: [{ id: "no-context" }, { id: "julia-1", meta: { n_ctx: 8192 }, architecture: { output_modalities: ["decisions"] } }],
	});
	assert.deepEqual(
		rejected.map((r) => r.cause),
		["no context window reported", "decision model"],
	);
});

test("skips are counted per cause, biggest first", () => {
	const rejected = [...skipped(["a", "b", "c"], "no context window reported"), ...skipped(["d", "e"], "decision model")];
	assert.deepEqual(groupRejections(rejected), [
		{ cause: "no context window reported", count: 3 },
		{ cause: "decision model", count: 2 },
	]);
});

test("one cause is named without a count, because the caller already printed the total", () => {
	assert.equal(describeRejections(skipped(["a", "b", "c"], "no context window reported")), "no context window reported");
	assert.equal(
		describeRejections([...skipped(["a", "b", "c"], "no context window reported"), ...skipped(["d", "e"], "decision model")]),
		"no context window reported (3), decision model (2)",
	);
	assert.equal(describeRejections([]), "");
});

test("more causes than the limit collapse into a remainder that still adds up", () => {
	const rejected = [
		...skipped(["a1", "a2", "a3"], "alpha"),
		...skipped(["b1", "b2"], "bravo"),
		...skipped(["c1"], "charlie"),
		...skipped(["d1"], "delta"),
	];
	const groups = groupRejections(rejected, 2);
	assert.deepEqual(groups, [
		{ cause: "alpha", count: 3 },
		{ cause: "3 other cause(s)", count: 4 },
	]);
	assert.equal(groups.reduce((total, group) => total + group.count, 0), rejected.length);
});

test("fetchModels returns what registered and what was skipped", async () => {
	const payload = { data: [{ id: "ok", meta: { n_ctx: 32768 } }, { id: "no-context" }] };
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify(payload))) as typeof globalThis.fetch;
	try {
		const result = await fetchModels({ id: "p", baseUrl: "http://x/v1" });
		assert.deepEqual(
			result.models.map((m) => m.id),
			["ok"],
		);
		assert.deepEqual(
			result.rejected.map((r) => r.id),
			["no-context"],
		);
	} finally {
		globalThis.fetch = original;
	}
});

test("an endpoint whose whole list is unusable fails with counts, not one clause per model", async () => {
	const payload = { data: Array.from({ length: 300 }, (_, i) => ({ id: `model-${i}` })) };
	const original = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify(payload))) as typeof globalThis.fetch;
	try {
		await assert.rejects(fetchModels({ id: "p", baseUrl: "http://x/v1" }), (error: Error) => {
			assert.match(error.message, /listed no usable models \(300 skipped: no context window reported\)/);
			// The old message joined 300 ids and reasons into one line; this one stays a notification.
			assert.ok(error.message.length < 160, `error message is ${error.message.length} characters`);
			return true;
		});
	} finally {
		globalThis.fetch = original;
	}
});
