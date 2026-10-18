import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, parseConfig } from "./config.ts";

test("defaults to on with no patterns", () => {
	assert.deepEqual(parseConfig({}).config, DEFAULT_CONFIG);
	assert.equal(DEFAULT_CONFIG.enabled, true);
});

test("accepts a switch and extra openings", () => {
	const parsed = parseConfig({ enabled: false, extraPatterns: ["^nothing to do here"] });
	assert.equal(parsed.problem, undefined);
	assert.deepEqual(parsed.config, { enabled: false, extraPatterns: [/^nothing to do here/i] });
});

test("refuses to guess at anything malformed", () => {
	const cases: [string, unknown, string][] = [
		["array", [], "config must be a JSON object"],
		["enabled not boolean", { enabled: "yes" }, `"enabled" must be a boolean, got string`],
		["patterns not strings", { extraPatterns: [1] }, `"extraPatterns" must be an array of regex source strings`],
		["bad regex", { extraPatterns: ["("] }, `"extraPatterns" entry is not a valid regex`],
		["typo in a key", { enable: true }, "unknown config key(s): enable"],
	];
	for (const [name, raw, want] of cases) {
		const parsed = parseConfig(raw);
		assert.ok(parsed.problem, name);
		assert.ok(parsed.problem.startsWith(want), `${name}: ${parsed.problem}`);
	}
});
