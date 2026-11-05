/**
 * A config that is wrong in one place must not silence attribution everywhere else, so each field is
 * read on its own and every unusable value is collected for the status line rather than thrown.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULTS, resolveConfig } from "./config.ts";

test("no file at all is the default config", () => {
	const { config, problems } = resolveConfig(undefined);
	assert.deepEqual(problems, []);
	assert.equal(config.enabled, DEFAULTS.enabled);
	assert.equal(config.inject, "process-env");
	assert.equal(config.maxModels, 8);
	assert.equal(config.ledger, true);
	assert.equal(config.chainRepoHooks, true);
	assert.deepEqual(config.providers, {});
	assert.deepEqual(config.models, {});
});

test("the exceptions and the identity are read", () => {
	const { config, problems } = resolveConfig({
		operator: "Carl Kittelberger <icedream@icedream.pw>",
		providers: { "lan-proxy": { placement: "cloud", label: "Lan Proxy", engine: "LiteLLM" }, strata: { engine: "Strata" } },
		models: { "local/qwen-iq3_s": { name: "Qwen 3.8 Flash Next", placement: "local" } },
		skipRepos: ["/srv/legacy-repo"],
		localDomains: ["lan.example.net"],
		maxModels: 3,
		inject: "off",
	});
	assert.deepEqual(problems, []);
	assert.equal(config.operator, "Carl Kittelberger <icedream@icedream.pw>");
	assert.deepEqual(config.providers["lan-proxy"], { placement: "cloud", label: "Lan Proxy", engine: "LiteLLM" });
	assert.deepEqual(config.models["local/qwen-iq3_s"], { name: "Qwen 3.8 Flash Next", placement: "local" });
	assert.deepEqual(config.skipRepos, ["/srv/legacy-repo"]);
	assert.deepEqual(config.localDomains, ["lan.example.net"]);
	assert.equal(config.maxModels, 3);
	assert.equal(config.inject, "off");
});

test("one unusable value is reported and the rest still applies", () => {
	const { config, problems } = resolveConfig({
		enabled: "yes",
		inject: "telepathy",
		maxModels: 0,
		operator: "   ",
		chainRepoHooks: "always",
		providers: { one: { placement: "maybe", label: 7, engine: "Strata" }, two: "nope" },
		localDomains: "lan.example.net",
		ledger: false,
	});
	assert.equal(config.enabled, true, "the default stands");
	assert.equal(config.inject, "process-env");
	assert.equal(config.maxModels, 8);
	assert.equal(config.operator, undefined);
	assert.equal(config.chainRepoHooks, true);
	assert.equal(config.ledger, false);
	assert.deepEqual(config.providers, { one: { engine: "Strata" } });
	assert.equal(problems.length, 9, problems.join("; "));
});

test("a file that is not an object leaves the defaults standing with one problem", () => {
	const { config, problems } = resolveConfig([1, 2, 3]);
	assert.equal(config.enabled, true);
	assert.deepEqual(problems, ["config: expected a JSON object"]);
});
