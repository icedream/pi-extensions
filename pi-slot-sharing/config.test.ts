import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "./config.ts";
import { MIB } from "./sessions.ts";

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

test("nothing is required: the server comes from the model when not pinned", () => {
	const { config, problems } = resolveConfig({}, EMPTY_ENV);
	assert.deepEqual(problems, []);
	assert.equal(config?.baseUrl, undefined, "absent means derive it from the session's model");
	const pinned = resolveConfig({ baseUrl: "http://127.0.0.1:11182/" }, EMPTY_ENV);
	assert.deepEqual(pinned.problems, []);
	assert.equal(pinned.config?.baseUrl, "http://127.0.0.1:11182");
});

test("defaults match the engine's defaults, not a guess of ours", () => {
	const { config } = resolveConfig({ baseUrl: "http://h:1/" }, EMPTY_ENV);
	assert.equal(config?.ramFloorBytes, 2560 * MIB, "Strata's own --conversation-cache-min-free-mib default");
	assert.equal(config?.marginBytes, 256 * MIB);
	assert.equal(config?.saveEveryTurns, 1);
	assert.equal(config?.enabled, true);
});

test("the RAM floor is stated, because the server does not report it", () => {
	const { config } = resolveConfig({ baseUrl: "http://h:1/", ramFloorMib: 1024 }, EMPTY_ENV);
	assert.equal(config?.ramFloorBytes, 1024 * MIB);
});

test("a malformed server is a problem, not a silent no-op", () => {
	assert.match(resolveConfig({ baseUrl: "h:1" }, EMPTY_ENV).problems.join(";"), /must start with/);
	assert.deepEqual(resolveConfig(null, EMPTY_ENV).problems, ["config file must contain a JSON object"]);
});

test("the key may come from the environment", () => {
	const fromEnv = resolveConfig({ baseUrl: "http://h:1/" }, { SLOT_SHARING_API_KEY: "secret" } as NodeJS.ProcessEnv);
	assert.equal(fromEnv.config?.apiKey, "secret");
	const explicit = resolveConfig({ baseUrl: "http://h:1/", apiKey: "in-file" }, { SLOT_SHARING_API_KEY: "secret" } as NodeJS.ProcessEnv);
	assert.equal(explicit.config?.apiKey, "in-file");
});

test("nonsense values are reported instead of being coerced", () => {
	const { problems } = resolveConfig({ baseUrl: "http://h:1/", marginMib: "lots", saveEveryTurns: 0, enabled: "yes" }, EMPTY_ENV);
	assert.equal(problems.length, 3, problems.join("; "));
});
