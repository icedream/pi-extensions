import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, ramFloorBytesFor, resolveConfig, settingsFor } from "./config.ts";
import { MIB } from "./sessions.ts";

test("an empty config is a working config", () => {
	const { config, problems } = resolveConfig({});
	assert.deepEqual(problems, []);
	assert.ok(config);
});

test("defaults leave the RAM floor to the engine", () => {
	const { config } = resolveConfig({});
	const s = settingsFor(config!, undefined);
	assert.equal(s.ramFloorBytes, undefined, "unspecified: Strata reports its own floor on /metrics");
	assert.equal(ramFloorBytesFor(s.ramFloorBytes, undefined), 2560 * MIB, "and the default is Strata's own default");
	assert.equal(s.marginBytes, 256 * MIB);
	assert.equal(s.saveEveryTurns, 1);
	assert.equal(s.enabled, true);
});

test("the floor is the operator's if stated, the server's otherwise", () => {
	assert.equal(ramFloorBytesFor(1024 * MIB, 512), 1024 * MIB, "a stated floor wins");
	assert.equal(ramFloorBytesFor(undefined, 1024), 1024 * MIB, "otherwise believe the server");
	assert.equal(ramFloorBytesFor(undefined, undefined), 2560 * MIB, "and failing both, Strata's default");
	assert.equal(ramFloorBytesFor(undefined, -1), 2560 * MIB, "a nonsense report is not a floor");
});

test("the RAM floor can still be stated for a server that reports nothing", () => {
	const { config } = resolveConfig({ ramFloorMib: 1024 });
	assert.equal(settingsFor(config!, undefined).ramFloorBytes, 1024 * MIB);
});

test("nonsense values are reported instead of being coerced", () => {
	const { problems } = resolveConfig({ marginMib: "lots", saveEveryTurns: 0, enabled: "yes" });
	assert.equal(problems.length, 3, problems.join("; "));
});

test("a file that is not an object is a problem, not a silent no-op", () => {
	assert.deepEqual(resolveConfig(null).problems, ["config file must contain a JSON object"]);
	assert.deepEqual(resolveConfig("strata").problems, ["config file must contain a JSON object"]);
});

test("per-provider blocks inherit the top level and replace only what they name", () => {
	const { config, problems } = resolveConfig({
		ramFloorMib: 2560,
		marginMib: 256,
		providers: {
			"icedream-homepc/strata": { marginMib: 512 },
			"lab/llamacpp": { ramFloorMib: 0, maxSessionTokens: 60_000, enabled: false },
		},
	});
	assert.deepEqual(problems, []);
	const strata = settingsFor(config!, "icedream-homepc/strata");
	assert.equal(strata.ramFloorBytes, 2560 * MIB, "inherited");
	assert.equal(strata.marginBytes, 512 * MIB, "overridden");
	const llama = settingsFor(config!, "lab/llamacpp");
	assert.equal(llama.ramFloorBytes, 0);
	assert.equal(llama.maxSessionTokens, 60_000);
	assert.equal(llama.enabled, false);
	assert.equal(llama.marginBytes, 256 * MIB, "still inherited");
});

test("an unlisted provider gets the top level", () => {
	const { config } = resolveConfig({ ramFloorMib: 1024, providers: { "a/b": { ramFloorMib: 0 } } });
	assert.equal(settingsFor(config!, "other/provider").ramFloorBytes, 1024 * MIB);
	assert.equal(settingsFor(config!, undefined).ramFloorBytes, 1024 * MIB);
});

test("a bad value inside a provider block names where it came from", () => {
	const { problems } = resolveConfig({ providers: { "a/b": { marginMib: "lots" } } });
	assert.match(problems.join("; "), /providers\.a\/b\.marginMib/);
});

test("providers must be a map of objects, and cannot nest", () => {
	assert.match(resolveConfig({ providers: [] }).problems.join("; "), /providers must be an object/);
	assert.match(resolveConfig({ providers: { "a/b": 3 } }).problems.join("; "), /providers\.a\/b must be an object/);
	assert.match(resolveConfig({ providers: { "a/b": { providers: {} } } }).problems.join("; "), /not allowed/);
});

test("no config file means the extension does nothing", () => {
	const r = loadConfig("/nonexistent/slot-sharing.json");
	assert.equal(r.present, false);
	assert.equal(r.config, undefined);
	assert.deepEqual(r.problems, []);
});
