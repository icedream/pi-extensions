import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuth } from "./auth.ts";

const model = { id: "qwen3.8-flash-next", provider: "icedream-homepc/strata" };

function registry(result: { ok: true; apiKey?: string; headers?: Record<string, string | null> } | { ok: false; error: string }) {
	return { getApiKeyAndHeaders: async () => result };
}

test("Pi's provider credential is what gets used by default", async () => {
	const resolved = await resolveAuth({ registry: registry({ ok: true, apiKey: "from-provider" }), model, env: {} });
	assert.equal(resolved.source, "provider");
	assert.equal(resolved.auth?.apiKey, "from-provider");
});

test("provider headers come along, and null-valued ones are dropped", async () => {
	const resolved = await resolveAuth({
		registry: registry({ ok: true, apiKey: "k", headers: { "x-session": "abc", "x-drop": null, "x-empty": "" } }),
		model,
		env: {},
	});
	assert.deepEqual(resolved.auth?.headers, { "x-session": "abc" });
});

test("an explicit config key is an override, not a fallback", async () => {
	const resolved = await resolveAuth({ configApiKey: "explicit", registry: registry({ ok: true, apiKey: "from-provider" }), model, env: {} });
	assert.equal(resolved.source, "config");
	assert.equal(resolved.auth?.apiKey, "explicit");
});

test("a provider that cannot authenticate is reported, not swallowed", async () => {
	const resolved = await resolveAuth({ registry: registry({ ok: false, error: "no credential for icedream-homepc/strata" }), model, env: {} });
	assert.equal(resolved.source, "none");
	assert.equal(resolved.auth, undefined);
	assert.match(resolved.note ?? "", /no credential/);
});

test("the environment covers headless use with no Pi model", async () => {
	const resolved = await resolveAuth({ env: { SLOT_SHARING_API_KEY: "from-env" } });
	assert.equal(resolved.source, "env");
	assert.equal(resolved.auth?.apiKey, "from-env");
});

test("nothing configured says so plainly", async () => {
	const resolved = await resolveAuth({ env: {} });
	assert.equal(resolved.source, "none");
	assert.match(resolved.note ?? "", /no credential/i);
});
