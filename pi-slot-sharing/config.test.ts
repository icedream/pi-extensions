import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, resolveConfig } from "./config.ts";
import { MIB } from "./sessions.ts";

test("an empty config is a working config", () => {
	const { config, problems } = resolveConfig({});
	assert.deepEqual(problems, []);
	assert.ok(config);
});

test("defaults match the engine's defaults, not a guess of ours", () => {
	const { config } = resolveConfig({});
	assert.equal(config?.ramFloorBytes, 2560 * MIB, "Strata's own --conversation-cache-min-free-mib default");
	assert.equal(config?.marginBytes, 256 * MIB);
	assert.equal(config?.saveEveryTurns, 1);
	assert.equal(config?.enabled, true);
});

test("the RAM floor is stated, because no server reports it", () => {
	const { config } = resolveConfig({ ramFloorMib: 1024 });
	assert.equal(config?.ramFloorBytes, 1024 * MIB);
});

test("nonsense values are reported instead of being coerced", () => {
	const { problems } = resolveConfig({ marginMib: "lots", saveEveryTurns: 0, enabled: "yes" });
	assert.equal(problems.length, 3, problems.join("; "));
});

test("a file that is not an object is a problem, not a silent no-op", () => {
	assert.deepEqual(resolveConfig(null).problems, ["config file must contain a JSON object"]);
	assert.deepEqual(resolveConfig("strata").problems, ["config file must contain a JSON object"]);
});

test("no config file means the extension does nothing", () => {
	const r = loadConfig("/nonexistent/slot-sharing.json");
	assert.equal(r.present, false);
	assert.equal(r.config, undefined);
	assert.deepEqual(r.problems, []);
});
