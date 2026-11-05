/**
 * The catalog entries below are the shapes Pi's `models.json` really has: a provider with a `baseUrl`
 * and a list of models carrying an id and a display name. The cases are the ones the house format turns
 * on, namely a cloud model named by its provider, a self-hosted model whose address is on the local
 * network, and the overrides a config has to carry when neither says enough.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { assistedBy, finalizeLines, operatedBy, placementFromUrl, prettifyModelId, prettifyProviderId, resolveModel } from "./format.mjs";

const TOOL = { name: "pi", version: "1.4.0" };

const CATALOG = {
	providers: {
		"github-copilot": {
			baseUrl: "https://api.business.githubcopilot.com",
			models: [{ id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", baseUrl: "https://api.business.githubcopilot.com" }],
		},
		local: {
			baseUrl: "http://127.0.0.1:39321/v1",
			models: [{ id: "qwen3.8-flash-next-iq3_s", name: "Qwen 3.8 Flash Next", baseUrl: "http://127.0.0.1:39321/v1" }],
		},
		"lan-proxy": {
			baseUrl: "http://192.168.4.20:4000/v1",
			models: [{ id: "auto", baseUrl: "http://192.168.4.20:4000/v1" }],
		},
	},
};

test("a cloud model is credited by name with the provider that served it", () => {
	const model = resolveModel({ provider: "github-copilot", id: "claude-sonnet-5.5" }, { catalog: CATALOG });
	assert.equal(assistedBy(model, TOOL), "Assisted-by: pi 1.4.0 / Claude Sonnet 5.5 (cloud, GitHub Copilot)");
});

test("a model on a loopback or private address is local and self-hosted", () => {
	const model = resolveModel({ provider: "local", id: "qwen3.8-flash-next-iq3_s" }, { catalog: CATALOG, providers: { local: { engine: "Strata" } } });
	assert.equal(assistedBy(model, TOOL), "Assisted-by: pi 1.4.0 / Qwen 3.8 Flash Next (local, self-hosted, Strata)");
});

test("a provider on the LAN that forwards to cloud models is cloud, because config says so", () => {
	const model = resolveModel({ provider: "lan-proxy", id: "auto" }, { catalog: CATALOG, providers: { "lan-proxy": { placement: "cloud", label: "Lan Proxy", engine: "LiteLLM" } } });
	assert.equal(model.placement, "cloud");
	assert.equal(assistedBy(model, TOOL), "Assisted-by: pi 1.4.0 / Auto (cloud, Lan Proxy, LiteLLM)");
});

test("a model the catalog does not name gets a readable name from its id", () => {
	assert.equal(prettifyModelId("qwen3.8-flash-next-iq3_s"), "Qwen 3.8 Flash Next");
	assert.equal(prettifyModelId("unsloth/gemma-4-26B-A4B-it-qat-GGUF:Q4_K_XL"), "Gemma 4 26B A4B");
	const model = resolveModel({ provider: "local", id: "qwen3.8-flash-next-iq3_s" }, { catalog: { providers: { local: { baseUrl: "http://[::1]:1/v1" } } }, models: { "local/qwen3.8-flash-next-iq3_s": { name: "Qwen 3.8 Flash Next" } } });
	assert.equal(model.placement, "local");
	assert.equal(model.name, "Qwen 3.8 Flash Next");
});

test("placement reads addresses, not names", () => {
	const cases = [
		["http://localhost:11434", "local"],
		["http://127.0.0.1:39321/v1", "local"],
		["http://10.0.3.7:8080/v1", "local"],
		["http://192.168.4.20:4000/v1", "local"],
		["http://100.64.1.2:11434/v1", "local"],
		["http://llm.kubed.home.int/v1", "local"],
		["http://lan-host:11180", "local"],
		["https://api.business.githubcopilot.com", "cloud"],
		["https://openrouter.ai/api/v1", "cloud"],
		["not a url", undefined],
		[undefined, undefined],
	];
	for (const [url, expected] of cases) assert.equal(placementFromUrl(url), expected, url ?? "undefined");
});

test("a dotted host that is not a private name reads as cloud unless config says otherwise", () => {
	const model = resolveModel({ provider: "kubed", id: "qwen" }, { catalog: { providers: { kubed: { baseUrl: "http://kubed.example.net:11180" } } } });
	assert.equal(model.placement, "cloud");
	// The operator names such a host in config; without that the claim stays on the safe side.
	const named = resolveModel({ provider: "kubed", id: "qwen" }, { catalog: { providers: { kubed: { baseUrl: "http://kubed.example.net:11180" } } }, providers: { kubed: { placement: "local", engine: "llama.cpp" } } });
	assert.equal(assistedBy(named, TOOL), "Assisted-by: pi 1.4.0 / Qwen (local, self-hosted, llama.cpp)");
});

test("a catalog name that is just the id in different punctuation is not used", () => {
	const catalog = { providers: { strata: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "qwen3.8-flash-next-iq3_s", name: "Qwen3.8-Flash-Next-IQ3_S" }] } } };
	const model = resolveModel({ provider: "strata", id: "qwen3.8-flash-next-iq3_s" }, { catalog });
	assert.equal(model.name, "Qwen 3.8 Flash Next");
	// A name with a quantisation tail is the same problem in the other direction.
	const quantised = { providers: { strata: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "m-1", name: "Some Model IQ4_S" }] } } };
	assert.equal(resolveModel({ provider: "strata", id: "m-1" }, { catalog: quantised }).name, "Some Model");
	// A real display name is used as it stands.
	const proper = { providers: { strata: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "m-1", name: "Claude Sonnet 5.5" }] } } };
	assert.equal(resolveModel({ provider: "strata", id: "m-1" }, { catalog: proper }).name, "Claude Sonnet 5.5");
});

test("a provider named through a namespace still names its engine", () => {
	const model = resolveModel({ provider: "vendor/strata", id: "m" }, { catalog: { providers: { "vendor/strata": { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "m", name: "M" }] } } } });
	assert.equal(assistedBy(model, TOOL), "Assisted-by: pi 1.4.0 / M (local, self-hosted, Strata)");
});

test("a domain the operator declares is local, and a provider inside it can still be cloud", () => {
	const lan = { providers: { kubed: { baseUrl: "https://llm.lan.example.net/v1", models: [{ id: "m", name: "Lan Model" }] } } };
	const without = resolveModel({ provider: "kubed", id: "m" }, { catalog: lan });
	assert.equal(without.placement, "cloud", "a public-sounding domain is cloud until the operator says otherwise");
	const with_ = resolveModel({ provider: "kubed", id: "m" }, { catalog: lan, localDomains: ["lan.example.net"] });
	assert.equal(with_.placement, "local");
	// The same domain can host a proxy that forwards to cloud models; the provider rule outranks it.
	const proxy = resolveModel({ provider: "kubed", id: "m" }, { catalog: lan, localDomains: ["lan.example.net"], providers: { kubed: { placement: "cloud" } } });
	assert.equal(proxy.placement, "cloud");
});

test("engine is named only when it is known", () => {
	const noEngine = resolveModel({ provider: "local", id: "m" }, { catalog: CATALOG });
	assert.ok(!noEngine.engine);
	assert.equal(assistedBy(noEngine, TOOL), "Assisted-by: pi 1.4.0 / M (local, self-hosted)");
});

test("a size suffix keeps its capital", () => {
	assert.equal(prettifyModelId("qwen3.8-27b"), "Qwen 3.8 27B");
	assert.equal(prettifyModelId("gemma-4-26B-A4B"), "Gemma 4 26B A4B");
});

test("Operated-by appears only when the operator is not the author", () => {
	assert.equal(operatedBy("Carl Kittelberger <icedream@icedream.pw>", "icedream@icedream.pw"), undefined);
	assert.equal(operatedBy("Carl Kittelberger <icedream@icedream.pw>", "icedream@example-corp.com"), "Operated-by: Carl Kittelberger <icedream@icedream.pw>");
	assert.equal(operatedBy(undefined, "icedream@icedream.pw"), undefined);
});

test("lines are deduplicated whole and capped, keeping first-touch order", () => {
	const a = "Assisted-by: pi 1.4.0 / A (cloud, GitHub Copilot)";
	const b = "Assisted-by: pi 1.4.0 / B (local, self-hosted, Strata)";
	const lines = finalizeLines([a, b, a, "  ", `${a} `, "Operated-by: C <c@example.com>"], 3);
	assert.deepEqual(lines, [a, b, "Operated-by: C <c@example.com>"]);
});

test("provider names read as names", () => {
	assert.equal(prettifyProviderId("github-copilot"), "GitHub Copilot");
	assert.equal(prettifyProviderId("google_cloud"), "Google Cloud");
});
