// Runtime wiring tests: drive index.ts against a fake pi and a throwaway agent directory, no model
// calls and no network. Run from budget-routing/: node --test runtime.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type Handler = (event: any, ctx: any) => Promise<any>;

interface FakePi {
	on: (name: string, h: Handler) => void;
	registerCommand: (name: string, opts: unknown) => void;
	registerTool: (def: any) => void;
	handlers: Map<string, Handler[]>;
	commands: Map<string, unknown>;
	tools: Map<string, any>;
}

function fakePi(): FakePi {
	return {
		handlers: new Map(),
		commands: new Map(),
		tools: new Map(),
		on(name, h) {
			const list = this.handlers.get(name) ?? [];
			list.push(h);
			this.handlers.set(name, list);
		},
		registerCommand(name, opts) {
			this.commands.set(name, opts);
		},
		registerTool(def) {
			this.tools.set(def.name, def);
		},
	};
}

const MODELS = [
	{ provider: "github-copilot", id: "claude-sonnet-5.5", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 1_000_000 },
	{ provider: "mistral", id: "magistral-medium-latest", cost: { input: 2, output: 5, cacheRead: 0, cacheWrite: 0.6 }, contextWindow: 128_000 },
	{ provider: "strata", id: "local", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 393_216 },
];

interface Trace {
	notices: string[];
	statuses: Map<string, string | undefined>;
	compacts: number;
	confirms: string[];
}

function newTrace(): Trace {
	return { notices: [], statuses: new Map(), compacts: 0, confirms: [] };
}

function fakeCtx(trace: Trace, provider = "github-copilot") {
	return {
		model: { provider, id: "claude-sonnet-5.5" },
		modelRegistry: {
			getAll: () => MODELS,
			find: (p: string, id: string) => MODELS.find((m) => m.provider === p && m.id === id),
		},
		ui: {
			theme: { fg: (_c: string, t: string) => t },
			notify: (m: string) => trace.notices.push(m),
			setStatus: (k: string, v: string | undefined) => trace.statuses.set(k, v),
			confirm: async (title: string, body: string) => {
				trace.confirms.push(`${title}: ${body}`);
				return false;
			},
		},
		compact: () => {
			trace.compacts++;
		},
	};
}

const line = (provider: string, timestamp: number, cost: number) =>
	JSON.stringify({ type: "message", message: { role: "assistant", provider, timestamp, usage: { cost: { total: cost } } } });

const SETTINGS = { subagents: { agentOverrides: { worker: { model: "github-copilot/claude-sonnet-5.5" }, scout: { model: "mistral/magistral-medium-latest" } } } };

/**
 * A throwaway agent directory: config, settings.json with agent overrides, and session logs with known
 * costs, so tiers and table numbers are exact instead of whatever this machine happens to have logged.
 */
async function loadWith(capCopilot: number | undefined, capMistral = 20) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "budget-routing-runtime-"));
	const now = Date.now();
	await fs.mkdir(path.join(dir, "sessions", "proj"), { recursive: true });
	await fs.writeFile(
		path.join(dir, "sessions", "proj", "current.jsonl"),
		[line("github-copilot", now, 5), line("mistral", now, 0.2), line("strata", now, 0)].join("\n") + "\n",
	);
	const config = {
		localModel: { provider: "strata", modelId: "local", subagentRef: "strata/local" },
		localSubagents: ["scout"],
		thresholds: { nudge: 0.7, warn: 0.8, prepare: 0.95, divert: 1 },
		enforce: "reject",
		providers: [
			{ provider: "github-copilot", ...(capCopilot === undefined ? {} : { monthlyCapUsd: capCopilot }) },
			{ provider: "mistral", monthlyCapUsd: capMistral },
		],
	};
	await fs.writeFile(path.join(dir, "budget-routing.json"), JSON.stringify(config));
	await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify(SETTINGS));
	process.env.PI_BUDGET_ROUTING_AGENT_DIR = dir;
	process.env.PI_BUDGET_ROUTING_CONFIG = path.join(dir, "budget-routing.json");
	// The query keeps each test on a fresh module instance, since the paths are read at import.
	const mod = await import(`./index.ts?agentdir=${encodeURIComponent(dir)}`);
	const pi = fakePi();
	mod.default(pi as never);
	return { pi, dir, config };
}

test("registers the budget tool, both commands, and one footer key per provider", async () => {
	const { pi } = await loadWith(50);
	const trace = newTrace();
	await pi.handlers.get("before_agent_start")?.[0]({ systemPromptOptions: {} }, fakeCtx(trace));

	assert.ok(pi.tools.get("budget"), "budget tool missing");
	assert.ok(pi.commands.get("budget") && pi.commands.get("budget-seat"), "commands missing");
	assert.deepEqual([...trace.statuses.keys()].sort(), ["budget-routing/github-copilot", "budget-routing/mistral"]);
	assert.equal(trace.statuses.get("budget-routing/github-copilot"), "copilot ~10%");
});

test("the prompt section names every provider and carries no live numbers", async () => {
	const { pi } = await loadWith(50);
	const event: { systemPromptOptions: { sections?: Record<string, string> } } = { systemPromptOptions: {} };
	await pi.handlers.get("before_agent_start")?.[0](event, fakeCtx(newTrace()));
	const section = event.systemPromptOptions.sections?.budget ?? "";
	assert.match(section, /copilot credits, under cap/);
	assert.match(section, /mistral metered, under cap/);
	assert.ok(!/\d/.test(section), `section must not carry numbers: ${section}`);
});

test("an uncapped provider is reported, priced, and never tiered", async () => {
	const { pi } = await loadWith(undefined);
	const trace = newTrace();
	const out = await pi.tools.get("budget").execute("c1", { action: "status" }, undefined, undefined, fakeCtx(trace));
	assert.match(out.content[0].text, /copilot +credits +none +\$5\.00 +- +no cap +meter/);
	assert.equal(trace.statuses.size, 0, "the tool does not touch the footer");

	await pi.handlers.get("before_agent_start")?.[0]({ systemPromptOptions: {} }, fakeCtx(trace));
	assert.match(trace.statuses.get("budget-routing/github-copilot") ?? "", /copilot \$5\.00/);
});

test("the budget tool tables differ by action and price the routes", async () => {
	const { pi } = await loadWith(50);
	const trace = newTrace();
	const ctx = fakeCtx(trace);
	const status = await pi.tools.get("budget").execute("c1", { action: "status" }, undefined, undefined, ctx);
	const models = await pi.tools.get("budget").execute("c2", { action: "models" }, undefined, undefined, ctx);
	assert.match(status.content[0].text, /provider +billing +cap +spent +pct +headroom +figure/);
	assert.ok(!/route +billing/.test(status.content[0].text), "status must not include the menu");
	assert.match(models.content[0].text, /route +billing +\$\/Mtok in\/out/);
	// the menu is the models the agent settings already point at, plus the local model
	assert.match(models.content[0].text, /mistral\/magistral-medium-latest +metered +2\/5 +0\/0\.6 +128k +99% left/);
	assert.match(models.content[0].text, /strata\/local +free +- +- +393k +not tracked +\(last resort/);
});

test("a launch spending an over-cap provider is refused with the open routes listed", async () => {
	const { pi } = await loadWith(4); // 5 USD logged against a 4 USD cap: 125%
	const trace = newTrace();
	const ctx = fakeCtx(trace);
	await pi.handlers.get("before_agent_start")?.[0]({ systemPromptOptions: {} }, ctx);
	const result = await pi.handlers.get("tool_call")?.[0](
		{ toolName: "subagent", input: { agent: "worker", model: "github-copilot/claude-sonnet-5.5", task: "x" } },
		ctx,
	);
	assert.ok(result?.block, "expected the launch to be blocked");
	assert.match(result.reason, /over the monthly cap on copilot 125%/);
	assert.match(result.reason, /worker -> github-copilot/);
	assert.match(result.reason, /mistral\/magistral-medium-latest/);
	assert.match(result.reason, /Local fallback: strata\/local/);
});

test("a launch aimed at a provider with room left is left alone", async () => {
	const { pi } = await loadWith(4);
	const ctx = fakeCtx(newTrace());
	await pi.handlers.get("before_agent_start")?.[0]({ systemPromptOptions: {} }, ctx);
	const result = await pi.handlers.get("tool_call")?.[0](
		{ toolName: "subagent", input: { agent: "worker", model: "mistral/magistral-medium-latest", task: "x" } },
		ctx,
	);
	assert.equal(result, undefined);
});

test("a refused launch is reported once per provider and month", async () => {
	const { pi } = await loadWith(4);
	const trace = newTrace();
	const ctx = fakeCtx(trace);
	await pi.handlers.get("before_agent_start")?.[0]({ systemPromptOptions: {} }, ctx);
	await pi.handlers.get("before_agent_start")?.[0]({ systemPromptOptions: {} }, ctx);
	const warns = trace.notices.filter((n) => n.includes("divert"));
	assert.equal(warns.length, 1, trace.notices.join(" | "));
});

test(`subagent({action:"models"}) gets the price table appended`, async () => {
	const { pi } = await loadWith(1000);
	const out = await pi.handlers.get("tool_result")?.[0](
		{
			toolName: "subagent",
			toolCallId: "t",
			input: { action: "models" },
			content: [{ type: "text", text: "Available models in this session's registry" }],
			structuredContent: { models: [] },
		},
		fakeCtx(newTrace()),
	);
	assert.equal(out.content.length, 2);
	assert.match(out.content[1].text, /budget-routing:/);
	assert.match(out.content[1].text, /\$\/Mtok in\/out/);
	assert.deepEqual(out.structuredContent, { models: [] }, "structuredContent must survive");
});

test("a models listing without an action is untouched", async () => {
	const { pi } = await loadWith(1000);
	const out = await pi.handlers.get("tool_result")?.[0](
		{ toolName: "subagent", toolCallId: "t", input: { agent: "scout", task: "x" }, content: [{ type: "text", text: "done" }], structuredContent: {} },
		fakeCtx(newTrace()),
	);
	assert.equal(out, undefined);
});

test("the session's own provider drives compaction, not another provider's tier", async () => {
	const { pi } = await loadWith(4);
	const trace = newTrace();
	const mistralCtx = fakeCtx(trace, "mistral");
	await pi.handlers.get("agent_end")?.[0]({}, mistralCtx);
	assert.equal(trace.compacts, 0, "a session on mistral must not compact because copilot is over cap");

	const copilotCtx = fakeCtx(trace, "github-copilot");
	await pi.handlers.get("agent_end")?.[0]({}, copilotCtx);
	assert.equal(trace.compacts, 1);
	await pi.handlers.get("agent_end")?.[0]({}, copilotCtx);
	assert.equal(trace.compacts, 1, "the once-per-crossing flag stays consumed for that provider");
});

test("footer keys for providers removed from the config are cleared", async () => {
	const { pi, dir } = await loadWith(1000);
	await pi.handlers.get("before_agent_start")?.[0]({ systemPromptOptions: {} }, fakeCtx(newTrace()));

	const trimmed = { ...JSON.parse(await fs.readFile(path.join(dir, "budget-routing.json"), "utf8")), providers: [{ provider: "github-copilot", monthlyCapUsd: 1000 }] };
	await fs.writeFile(path.join(dir, "budget-routing.json"), JSON.stringify(trimmed));
	const trace = newTrace();
	await pi.handlers.get("before_agent_start")?.[0]({ systemPromptOptions: {} }, fakeCtx(trace));
	assert.equal(trace.statuses.get("budget-routing/mistral"), undefined);
});
