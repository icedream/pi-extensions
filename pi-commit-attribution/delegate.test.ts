import assert from "node:assert/strict";
import test from "node:test";
import { DELEGATION_TOOL, delegatedModels, delegatedSessionId, splitModelSpec } from "./delegate.ts";

test("a delegation names the models it asked for", () => {
	assert.deepEqual(delegatedModels({ agent: "worker", model: "github-copilot/gpt-5.6-luna", task: "write it" }), ["github-copilot/gpt-5.6-luna"]);
	assert.deepEqual(
		delegatedModels({ workflow: "parallel", args: { tasks: [{ agent: "worker", model: "local/strata/a" }, { agent: "reviewer", model: "local/strata/b" }, { agent: "worker" }] } }),
		["local/strata/a", "local/strata/b"],
	);
});

test("a delegation that names no model yields nothing", () => {
	assert.deepEqual(delegatedModels({ agent: "worker", task: "write it" }), []);
	assert.deepEqual(delegatedModels(undefined), []);
	assert.deepEqual(delegatedModels({ workflow: "script", args: { tasks: "not an array" } }), []);
});

test("a provider may itself contain slashes", () => {
	const known = ["phantomglass/strata", "github-copilot", "local"];
	assert.deepEqual(splitModelSpec("phantomglass/strata/qwen3.8-flash", known), { provider: "phantomglass/strata", id: "qwen3.8-flash" });
	assert.deepEqual(splitModelSpec("github-copilot/claude-haiku-5.5", known), { provider: "github-copilot", id: "claude-haiku-5.5" });
	assert.deepEqual(splitModelSpec("unlisted/model-5", known), { provider: "unlisted", id: "model-5" });
});

test("delegated work is claimed under its own ledger key", () => {
	assert.equal(delegatedSessionId("session-1", "call-9"), "session-1-delegated-call-9");
	assert.equal(DELEGATION_TOOL, "subagent");
});
