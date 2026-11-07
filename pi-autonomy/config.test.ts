/**
 * The config layer: validation, layering, and the trust gate. Uses temp dirs throughout, so
 * nothing here reads a real `~/.pi/agent/autonomy.json`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Belt and braces: tests that let resolveConfig fall back to process.env must not pick up the
// developer's own config file.
process.env.PI_AUTONOMY_CONFIG = join(tmpdir(), "pi-autonomy-absent-config.json");

import { defaultAgentDir, describeConfig, loadFile, parseConfig, resolveConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./protocol.ts";

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

function dirs(): { agent: string; project: string; projectConfig: string } {
	const agent = mkdtempSync(join(tmpdir(), "pi-autonomy-agent-"));
	const project = mkdtempSync(join(tmpdir(), "pi-autonomy-project-"));
	const projectConfig = join(project, ".pi");
	mkdirSync(projectConfig);
	return { agent, project, projectConfig };
}

function writeGlobal(agent: string, text: string): string {
	const path = join(agent, "autonomy.json");
	writeFileSync(path, text);
	return path;
}

function writeProject(projectConfig: string, text: string): string {
	const path = join(projectConfig, "autonomy.json");
	writeFileSync(path, text);
	return path;
}

test("nothing on disk leaves the defaults, with no sources and no problems", () => {
	const { agent } = dirs();
	const resolved = resolveConfig({ agentDir: agent, env: EMPTY_ENV });
	assert.deepEqual(resolved.config, DEFAULT_CONFIG);
	assert.deepEqual(resolved.sources, []);
	assert.deepEqual(resolved.provenance, {});
	assert.deepEqual(resolved.problems, []);
	assert.equal(resolved.projectSkipped, undefined);
});

test("a partial global file applies its keys and leaves the rest default", () => {
	const { agent } = dirs();
	const path = writeGlobal(agent, JSON.stringify({ maxMinutes: 360 }));
	const resolved = resolveConfig({ agentDir: agent, env: EMPTY_ENV });
	assert.equal(resolved.config.maxMinutes, 360);
	assert.equal(resolved.config.maxContinuations, DEFAULT_CONFIG.maxContinuations);
	assert.deepEqual(resolved.provenance, { maxMinutes: path });
	assert.deepEqual(resolved.sources, [path]);
});

test("the project file wins over the global one in a trusted project", () => {
	const { agent, project, projectConfig } = dirs();
	writeGlobal(agent, JSON.stringify({ maxMinutes: 360, repeatLimit: 4 }));
	const projectPath = writeProject(projectConfig, JSON.stringify({ maxMinutes: 30 }));
	const resolved = resolveConfig({ agentDir: agent, cwd: project, projectTrusted: true, env: EMPTY_ENV });
	assert.equal(resolved.config.maxMinutes, 30, "project layer wins for the key it sets");
	assert.equal(resolved.config.repeatLimit, 4, "global layer still supplies the keys the project omits");
	assert.equal(resolved.provenance.maxMinutes, projectPath);
	assert.deepEqual(resolved.sources, [join(agent, "autonomy.json"), projectPath]);
});

test("an untrusted project's file is skipped and reported", () => {
	const { agent, project, projectConfig } = dirs();
	writeGlobal(agent, JSON.stringify({ maxMinutes: 360 }));
	const projectPath = writeProject(projectConfig, JSON.stringify({ maxMinutes: 5 }));
	const resolved = resolveConfig({ agentDir: agent, cwd: project, projectTrusted: false, env: EMPTY_ENV });
	assert.equal(resolved.config.maxMinutes, 360, "the untrusted project file is not applied");
	assert.equal(resolved.projectSkipped, projectPath, "…but the user is told it was there");
});

test("PI_AUTONOMY_CONFIG replaces every layer, including the project file", () => {
	const { agent, project, projectConfig } = dirs();
	writeGlobal(agent, JSON.stringify({ maxMinutes: 360 }));
	writeProject(projectConfig, JSON.stringify({ maxMinutes: 5 }));
	const only = join(agent, "override.json");
	writeFileSync(only, JSON.stringify({ maxContinuations: 7 }));
	const resolved = resolveConfig({ agentDir: agent, cwd: project, projectTrusted: true, env: { PI_AUTONOMY_CONFIG: only } });
	assert.deepEqual(resolved.sources, [only]);
	assert.equal(resolved.config.maxContinuations, 7);
	assert.equal(resolved.config.maxMinutes, DEFAULT_CONFIG.maxMinutes, "the global file is not consulted either");
	assert.equal(resolved.config.repeatLimit, DEFAULT_CONFIG.repeatLimit);
});

test("an unparseable layer is dropped and reported, other layers still apply", () => {
	const { agent, project, projectConfig } = dirs();
	writeGlobal(agent, "{ not json");
	const projectPath = writeProject(projectConfig, JSON.stringify({ maxStallTurns: 1 }));
	const resolved = resolveConfig({ agentDir: agent, cwd: project, projectTrusted: true, env: EMPTY_ENV });
	assert.equal(resolved.config.maxStallTurns, 1, "the readable layer still applies");
	assert.equal(resolved.config.maxMinutes, DEFAULT_CONFIG.maxMinutes, "the broken layer leaves defaults");
	assert.equal(resolved.sources.length, 1);
	assert.equal(resolved.problems.length, 1);
	assert.match(resolved.problems[0] ?? "", /autonomy\.json/);
	assert.ok(!resolved.provenance.maxStallTurns || resolved.provenance.maxStallTurns === projectPath);
});

test("parseConfig accepts every key in range and rejects everything else", () => {
	assert.deepEqual(parseConfig({}).config, {});
	assert.deepEqual(parseConfig({ maxContinuations: 1, maxStallTurns: 1, repeatLimit: 2, maxMinutes: 0.5 }).config, {
		maxContinuations: 1,
		maxStallTurns: 1,
		repeatLimit: 2,
		maxMinutes: 0.5,
	});
	assert.deepEqual(parseConfig({ repeatLimit: 6 }).config, { repeatLimit: 6 });

	const rejected: [string, unknown][] = [
		["maxContinuations", 0],
		["maxContinuations", -1],
		["maxContinuations", 1.5],
		["maxContinuations", "40"],
		["maxContinuations", true],
		["maxContinuations", null],
		["maxStallTurns", 0],
		["maxStallTurns", 2.5],
		["repeatLimit", 1],
		["repeatLimit", 0],
		["repeatLimit", 7],
		["repeatLimit", 1000],
		["maxMinutes", 0],
		["maxMinutes", -5],
		["maxMinutes", "60"],
	];
	for (const [key, value] of rejected) {
		const result = parseConfig({ [key]: value });
		assert.equal(result.config, undefined, `${key}: ${JSON.stringify(value)} must be rejected`);
		assert.match(result.problem ?? "", new RegExp(`"${key}"`), `${key}: ${JSON.stringify(value)}`);
	}
});

test("a maxMinutes of Infinity is rejected: JSON.parse('1e999') would disable the clock", () => {
	const parsed = JSON.parse("1e999");
	assert.equal(parsed, Infinity);
	const result = parseConfig({ maxMinutes: parsed });
	assert.equal(result.config, undefined);
	assert.match(result.problem ?? "", /finite/);
});

test("repeatLimit above the loop window is rejected rather than silently disabled", () => {
	// RepeatDetector only remembers REPEAT_WINDOW calls, so a higher limit never trips the
	// run check. The config layer refuses it instead of accepting a guard that cannot fire.
	const result = parseConfig({ repeatLimit: 7 });
	assert.equal(result.config, undefined);
	assert.match(result.problem ?? "", /<= 6/);
});

test("unknown keys are named, along with the valid ones", () => {
	const result = parseConfig({ maxMinutes: 30, maxMinute: 30 });
	assert.equal(result.config, undefined);
	assert.match(result.problem ?? "", /maxMinute/);
	assert.match(result.problem ?? "", /maxContinuations/);
});

test("a non-object document is rejected", () => {
	for (const raw of [null, [], "60", 60]) {
		assert.match(parseConfig(raw).problem ?? "", /JSON object/, JSON.stringify(raw));
	}
});

test("loadFile: missing is silent, unreadable is a problem", () => {
	assert.deepEqual(loadFile(join(tmpdir(), "pi-autonomy-definitely-absent.json")), {});
	const { agent } = dirs();
	const path = writeGlobal(agent, "[]");
	assert.match(loadFile(path).problem ?? "", new RegExp(path));
});

test("describeConfig attributes each value to the file that set it", () => {
	const { agent, project, projectConfig } = dirs();
	writeGlobal(agent, JSON.stringify({ maxMinutes: 360 }));
	writeProject(projectConfig, JSON.stringify({ repeatLimit: 5 }));
	const resolved = resolveConfig({ agentDir: agent, cwd: project, projectTrusted: true, env: EMPTY_ENV });
	const line = describeConfig(resolved);
	assert.match(line, /maxMinutes 360/);
	assert.match(line, /repeatLimit 5/);
	assert.match(line, /maxContinuations 40/);
	assert.ok(line.includes(join(agent, "autonomy.json")) && line.includes(join(projectConfig, "autonomy.json")), line);
	assert.doesNotMatch(describeConfig(resolveConfig({ agentDir: agent, env: { ...EMPTY_ENV, PI_AUTONOMY_CONFIG: "/nonexistent" } })), /from /, "defaults alone name no file");
});

test("defaultAgentDir honours PI_CODING_AGENT_DIR like pi's getAgentDir does", () => {
	assert.equal(defaultAgentDir({ PI_CODING_AGENT_DIR: "/tmp/some-agent-dir" }), "/tmp/some-agent-dir");
	assert.match(defaultAgentDir({}), /[/\\]\.pi[/\\]agent$/);
	assert.match(defaultAgentDir({ PI_CODING_AGENT_DIR: "~/custom" }), /[/\\]custom$/);
});
