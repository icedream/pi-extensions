import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuth, type AuthResolver } from "./auth.ts";

const model = { id: "qwen3.8-flash-next", provider: "icedream-homepc/strata" };

function registry(result: { ok: true; apiKey?: string; headers?: Record<string, string | null> } | { ok: false; error: string }): AuthResolver {
	return { getApiKeyAndHeaders: async () => result };
}

test("the model provider's credential is what gets used", async () => {
	const resolved = await resolveAuth(registry({ ok: true, apiKey: "from-provider" }), model);
	assert.equal(resolved.source, "provider");
	assert.equal(resolved.auth?.apiKey, "from-provider");
});

test("provider headers come along, and null-valued ones are dropped", async () => {
	const resolved = await resolveAuth(registry({ ok: true, apiKey: "k", headers: { "x-session": "abc", "x-drop": null, "x-empty": "" } }), model);
	assert.deepEqual(resolved.auth?.headers, { "x-session": "abc" });
});

test("a provider that cannot authenticate is reported, not swallowed", async () => {
	const resolved = await resolveAuth(registry({ ok: false, error: "no credential for icedream-homepc/strata" }), model);
	assert.equal(resolved.source, "none");
	assert.equal(resolved.auth, undefined);
	assert.match(resolved.note ?? "", /no credential/);
});

test("a provider that answers but holds nothing is still no credential", async () => {
	const resolved = await resolveAuth(registry({ ok: true }), model);
	assert.equal(resolved.source, "none");
	assert.match(resolved.note ?? "", /no credential/);
});

test("no registry or no model says so plainly", async () => {
	assert.equal((await resolveAuth(undefined, model)).source, "none");
	assert.equal((await resolveAuth(registry({ ok: true, apiKey: "k" }), undefined)).source, "none");
});
