/**
 * The environment cases are the ones that decide whether a repository keeps its own hooks: a clean
 * environment, an environment that already carries `GIT_CONFIG_*` for other keys, and an environment
 * where the user routed `core.hooksPath` somewhere themselves. The last one must not be overwritten,
 * and restoring has to leave the environment byte for byte as it was found, including keys that were
 * never there.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { applyInjection, HOOKS_PATH_KEY, MARKER, planInjection, readInjection, type EnvRecord } from "./inject.ts";

const DIR = "/home/dev/.pi/agent/attribution/hooks";

test("a clean environment gets one injected key and the session marker", () => {
	const plan = planInjection({}, DIR);
	assert.equal(plan.conflict, undefined);
	assert.deepEqual(plan.vars, {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: HOOKS_PATH_KEY,
		GIT_CONFIG_VALUE_0: DIR,
		[MARKER]: "1",
	});
});

test("an existing GIT_CONFIG_* set is extended, not replaced", () => {
	const env = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "http.proxy", GIT_CONFIG_VALUE_0: "http://proxy:3128", GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "store" };
	const plan = planInjection(env, DIR);
	assert.equal(plan.conflict, undefined);
	assert.equal(plan.vars.GIT_CONFIG_COUNT, "3");
	assert.equal(plan.vars.GIT_CONFIG_KEY_2, HOOKS_PATH_KEY);
	assert.equal(plan.vars.GIT_CONFIG_VALUE_2, DIR);
	assert.deepEqual(readInjection({ ...env, ...plan.vars }), {
		count: 3,
		entries: [
			{ key: "http.proxy", value: "http://proxy:3128" },
			{ key: "credential.helper", value: "store" },
			{ key: HOOKS_PATH_KEY, value: DIR },
		],
	});
});

test("a core.hooksPath the user injected themselves is left in charge", () => {
	const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: HOOKS_PATH_KEY, GIT_CONFIG_VALUE_0: "/home/dev/hooks" };
	const plan = planInjection(env, DIR);
	assert.deepEqual(plan.vars, {});
	assert.match(plan.conflict ?? "", /already sets core.hooksPath to \/home\/dev\/hooks/);
});

test("a junk count is treated as no entries rather than throwing", () => {
	const plan = planInjection({ GIT_CONFIG_COUNT: "many" }, DIR);
	assert.equal(plan.vars.GIT_CONFIG_COUNT, "1");
});

test("restore puts the environment back exactly, deleting what was absent", () => {
	const env: EnvRecord = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.proxy", GIT_CONFIG_VALUE_0: "http://proxy:3128", PATH: "/usr/bin" };
	const before = structuredClone(env);
	const undo = applyInjection(env, planInjection(env, DIR).vars);
	assert.equal(env.GIT_CONFIG_COUNT, "2");
	assert.equal(env.PI_ATTR, "1");
	undo();
	assert.deepEqual(env, before);
	assert.equal("PI_ATTR" in env, false);
});

test("restore re-applies a value an earlier session had already set", () => {
	const env = { GIT_CONFIG_COUNT: "7", PI_ATTR: "0" };
	const undo = applyInjection(env, planInjection(env, DIR).vars);
	assert.equal(env.PI_ATTR, "1");
	undo();
	assert.equal(env.GIT_CONFIG_COUNT, "7");
	assert.equal(env.PI_ATTR, "0");
});
