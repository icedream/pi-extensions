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
	{ provider: "opper", id: "aws/claude-sonnet-5-5", cost: { input: 2.2, output: 11, cacheRead: 0.25, cacheWrite: 2.75 }, contextWindow: 1_000_000 },
	{ provider: "mistral", id: "magistral-medium-latest", cost: { input: 2, output: 5, cacheRead: 0, cacheWrite: 0.6 }, contextWindow: 128_000 },
	{ provider: "anthropic", id: "claude-sonnet-5-5", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 1_000_000 },
	{ provider: "strata", id: "local", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 393_216 },
];

/**
 * Providers Pi can authenticate to here. A `discoverModels` provider whose catalog has not loaded yet
 * is in this list and in no model list, which is still its machine.
 */
const AUTH_CONFIGURED = ["github-copilot", "anthropic", "mistral", "opper", "strata", "litellm"];

interface Trace {
	notices: string[];
	statuses: Map<string, string | undefined>;
	compacts: number;
	confirms: string[];
}

/** The footer refresh runs off the message_end path, so a test has to wait for it to land. */
async function statusEventually(trace: Trace, key: string, want: string | undefined, ms = 3000): Promise<string | undefined> {
	const deadline = Date.now() + ms;
	let seen = trace.statuses.get(key);
	while (seen !== want && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10));
		seen = trace.statuses.get(key);
	}
	return seen;
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
			getProviderAuthStatus: (p: string) => ({ configured: AUTH_CONFIGURED.includes(p) }),
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

const line = (provider: string, timestamp: number, cost: number, model = "m", input = 0, output = 0) =>
	JSON.stringify({
		type: "message",
		message: { role: "assistant", provider, model, timestamp, usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } },
	});

const SETTINGS = { subagents: { agentOverrides: { worker: { model: "github-copilot/claude-sonnet-5.5" }, scout: { model: "mistral/magistral-medium-latest" } } } };

/**
 * A throwaway agent directory: config, settings.json with agent overrides, and session logs with known
 * costs, so tiers and table numbers are exact instead of whatever this machine happens to have logged.
 */
async function loadWith(capCopilot: number | undefined, capMistral = 20, advisoryModels?: string[]) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "budget-routing-runtime-"));
	const now = Date.now();
	await fs.mkdir(path.join(dir, "sessions", "proj"), { recursive: true });
	await fs.writeFile(
		path.join(dir, "sessions", "proj", "current.jsonl"),
		[
			line("github-copilot", now, 4.5, "claude-sonnet-5.5", 600, 300_000),
			line("github-copilot", now, 0.5, "claude-haiku-5.5", 40, 60_000),
			line("mistral", now, 0.2, "magistral-medium-latest", 100, 20_000),
			line("anthropic", now, 0.3, "claude-haiku-5-5", 50, 10_000),
			line("strata", now, 0, "qwen3.8-flash-next-iq3_s", 900, 400),
			line("deepseek", now, 1.25, "deepseek-chat", 80, 30_000),
		].join("\n") + "\n",
	);
	const config = {
		localModel: { provider: "strata", modelId: "local", subagentRef: "strata/local" },
		localSubagents: ["scout"],
		thresholds: { nudge: 0.7, warn: 0.8, prepare: 0.95, divert: 1 },
		enforce: "reject",
		...(advisoryModels === undefined ? {} : { advisory: { models: advisoryModels, maxModels: 10 } }),
		providers: [
			{ provider: "github-copilot", ...(capCopilot === undefined ? {} : { monthlyCapUsd: capCopilot }) },
			{ provider: "mistral", monthlyCapUsd: capMistral },
			{ provider: "anthropic", reset: "utc" },
			// A shared config lists providers that are only registered on some machines.
			{ provider: "deepseek", monthlyCapUsd: 10 },
			{ provider: "gemini" },
			// Credentials configured, model catalog not loaded yet: this machine, so it stays tracked.
			{ provider: "litellm", monthlyCapUsd: 5 },
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
	assert.ok(pi.commands.get("budget") && pi.commands.get("budget-seat") && pi.commands.get("budget-balance"), "commands missing");
	assert.deepEqual([...trace.statuses.keys()].sort(), [
		"budget-routing/anthropic",
		"budget-routing/github-copilot",
		"budget-routing/litellm",
		"budget-routing/mistral",
	]);
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

test("a provider in the catalog with no credential here is tracked nowhere", async () => {
	const { pi } = await loadWith(50);
	const trace = newTrace();
	const ctx = fakeCtx(trace);
	// Pi installs the anthropic and mistral catalogs on every machine. Nothing bills on them without a
	// credential, and the model registry alone cannot tell those two situations apart.
	(ctx.modelRegistry as Record<string, unknown>).getProviderAuthStatus = (p: string) => ({ configured: p !== "anthropic" && p !== "mistral" });
	const event: { systemPromptOptions: { sections?: Record<string, string> } } = { systemPromptOptions: {} };
	await pi.handlers.get("before_agent_start")?.[0](event, ctx);
	assert.equal(trace.statuses.get("budget-routing/anthropic"), undefined, "no footer indicator for an unauthenticated provider");
	assert.equal(trace.statuses.get("budget-routing/mistral"), undefined, "no footer indicator for an unauthenticated provider");
	assert.ok(!/anthropic|mistral/.test(event.systemPromptOptions.sections?.budget ?? ""), event.systemPromptOptions.sections?.budget ?? "no section written");
	assert.ok(trace.notices.some((n) => /anthropic is configured but this machine has no models or credentials for it/.test(n)), trace.notices.join(" | "));
	const out = await pi.tools.get("budget").execute("c1", { action: "status" }, undefined, undefined, ctx);
	assert.ok(!out.content[0].text.includes("anthropic") && !out.content[0].text.includes("mistral"), out.content[0].text);
});

test("a provider with no models in this machine's registry is tracked nowhere", async () => {
	const { pi } = await loadWith(50);
	const trace = newTrace();
	const event: { systemPromptOptions: { sections?: Record<string, string> } } = { systemPromptOptions: {} };
	await pi.handlers.get("before_agent_start")?.[0](event, fakeCtx(trace));

	const section = event.systemPromptOptions.sections?.budget ?? "";
	assert.match(section, /copilot credits, under cap/);
	assert.ok(!section.includes("deepseek"), `the section must not name it: ${section}`);
	assert.equal(trace.statuses.get("budget-routing/deepseek"), undefined, "no footer indicator for it");
	assert.ok(trace.notices.some((n) => /deepseek is configured but this machine has no models or credentials for it/.test(n)), trace.notices.join(" | "));

	const tool = await pi.tools.get("budget").execute("c1", { action: "models" }, undefined, undefined, fakeCtx(newTrace()));
	assert.ok(!tool.content[0].text.includes("deepseek"), tool.content[0].text);
	// What this machine logged for it is still readable, it just carries no cap state.
	assert.match(await runBudget(pi, "deepseek", newTrace()), /deepseek: configured, but this machine has no models or credentials for it, usage only, logged \$1\.25/);
	// With nothing logged either there is no report to give, and the reason is stated instead.
	assert.match(
		await runBudget(pi, "gemini", newTrace()),
		/gemini is configured but this machine has no models or credentials for it, so nothing is tracked for it here\. Tracked: github-copilot, mistral, anthropic, litellm\./,
	);
	// Credentials here but no loaded catalog is still this machine, so its cap is tracked.
	const litellm = await pi.tools.get("budget").execute("c2", { action: "status" }, undefined, undefined, fakeCtx(newTrace()));
	assert.match(litellm.content[0].text, /litellm +metered +\$5\.00 +\$0\.00 +0% +100% left +meter/);
});

test("route refs are dropped for an unregistered provider and kept for a mistyped model id", async () => {
	const { pi } = await loadWith(50, 20, ["strata/local", "deepseek/deepseek-chat", "github-copilot/claude-sonnet-5", "mistral/magistral-medium-latest"]);
	const out = await pi.tools.get("budget").execute("c1", { action: "models" }, undefined, undefined, fakeCtx(newTrace()));
	const table = out.content[0].text;
	assert.match(table, /mistral\/magistral-medium-latest/);
	assert.ok(!table.includes("deepseek/deepseek-chat"), table);
	assert.match(table, /github-copilot\/claude-sonnet-5 +metered +- +- +- +not tracked +\(not in the model registry\)/);
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

// --- /budget -----------------------------------------------------------------------------------

async function runBudget(pi: FakePi, args: string, trace: Trace): Promise<string> {
	const cmd = pi.commands.get("budget") as { handler: (args: string, ctx: unknown) => Promise<void> };
	const before = trace.notices.length;
	await cmd.handler(args, fakeCtx(trace));
	return trace.notices.slice(before).join("\n");
}

test("/budget with no argument keeps the all-provider table", async () => {
	const { pi } = await loadWith(50);
	const out = await runBudget(pi, "", newTrace());
	assert.match(out, /provider +billing +cap +spent +pct +headroom +figure/);
	assert.match(out, /copilot +credits +\$50\.00 +\$5\.00 +10%/);
	assert.match(out, /route +billing/);
});

test("/budget <provider> shows that provider's per-model usage", async () => {
	const { pi } = await loadWith(50);
	const out = await runBudget(pi, "github-copilot", newTrace());
	assert.match(out, /^github-copilot: credits, cap \$50\.00, 10% used, spent \$5\.00 \(meter\)/);
	assert.match(out, /model +msgs +input +output +cache r +cache w +cost/);
	// largest cost first, with the totals row last
	assert.match(out, /claude-sonnet-5\.5 +1 +600 +300k +0 +0 +\$4\.50/);
	assert.match(out, /claude-haiku-5\.5 +1 +40 +60k +0 +0 +\$0\.50/);
	assert.match(out, /total +2 +640 +360k +0 +0 +\$5\.00/);
	assert.ok(out.indexOf("claude-sonnet-5.5") < out.indexOf("claude-haiku-5.5"));
});

test("/budget <provider> works for a provider that is only in the session logs", async () => {
	const { pi } = await loadWith(50);
	const out = await runBudget(pi, "strata", newTrace());
	assert.match(out, /^strata: not in budget-routing\.json, usage only, logged \$0\.00/);
	assert.match(out, /qwen3\.8-flash-next-iq3_s +1 +900 +400 +0 +0 +\$0\.00/);
});

test("/budget <unknown> says so and names what is tracked", async () => {
	const { pi } = await loadWith(50);
	const out = await runBudget(pi, "nope", newTrace());
	assert.match(out, /no usage logged for "nope" this month/);
	assert.match(out, /Tracked: github-copilot, mistral, anthropic, litellm/);
});

test("/budget completions offer the configured providers", async () => {
	const { pi } = await loadWith(50);
	const cmd = pi.commands.get("budget") as { getArgumentCompletions: (p: string) => Promise<{ value: string }[] | null> };
	assert.deepEqual(await cmd.getArgumentCompletions(""), [
		{ value: "github-copilot", label: "github-copilot" },
		{ value: "mistral", label: "mistral" },
		{ value: "anthropic", label: "anthropic" },
		{ value: "deepseek", label: "deepseek" },
		{ value: "gemini", label: "gemini" },
		{ value: "litellm", label: "litellm" },
	]);
	assert.deepEqual(await cmd.getArgumentCompletions("mis"), [{ value: "mistral", label: "mistral" }]);
	assert.equal(await cmd.getArgumentCompletions("zzz"), null);
});

test("/budget reports a missing config instead of an empty table", async () => {
	const { pi, dir } = await loadWith(50);
	await fs.rm(path.join(dir, "budget-routing.json"));
	const trace = newTrace();
	const out = await runBudget(pi, "", trace);
	assert.match(out, /no config at/);
});

// --- out-of-budget detection -------------------------------------------------------------------

const spendLimitError = (provider: string) => ({
	role: "assistant",
	provider,
	stopReason: "error",
	errorMessage:
		'429 {"type":"error","error":{"type":"rate_limit_error","message":"You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC."}}',
});

test("a spend-limit error marks the provider out of budget and refuses its launches", async () => {
	const { pi } = await loadWith(1000);
	const trace = newTrace();
	const ctx = fakeCtx(trace, "anthropic");
	await pi.handlers.get("message_end")?.[0]({ message: spendLimitError("anthropic") }, ctx);

	assert.ok(trace.notices.some((n) => /anthropic is out of budget \(spend limit reached\)/.test(n)), trace.notices.join(" | "));
	assert.equal(await statusEventually(trace, "budget-routing/anthropic", "anthropic out of budget"), "anthropic out of budget");

	const blocked = await pi.handlers.get("tool_call")?.[0](
		{ toolName: "subagent", input: { agent: "worker", model: "mistral/magistral-medium-latest", task: "x" } },
		ctx,
	);
	assert.equal(blocked, undefined, "mistral still has room, so that launch is untouched");

	const toAnthropic = await pi.handlers.get("tool_call")?.[0](
		{ toolName: "subagent", input: { agent: "worker", model: "anthropic/claude-sonnet-5-5", task: "x" } },
		ctx,
	);
	assert.ok(toAnthropic?.block, "a launch to the exhausted provider is refused");
	assert.match(toAnthropic.reason, /out of budget on anthropic \(spend limit reached\)/);
});

test("a transient rate limit does not mark the provider out of budget", async () => {
	const { pi } = await loadWith(1000);
	const trace = newTrace();
	const ctx = fakeCtx(trace, "anthropic");
	await pi.handlers.get("before_agent_start")?.[0]({ systemPromptOptions: {} }, ctx);
	assert.equal(await statusEventually(trace, "budget-routing/anthropic", "anthropic $0.30"), "anthropic $0.30");

	await pi.handlers.get("message_end")?.[0](
		{ message: { role: "assistant", provider: "anthropic", stopReason: "error", errorMessage: "429 rate_limit_error: too many requests" } },
		ctx,
	);
	// Nothing refreshed, because a plain rate limit changes no state.
	assert.equal(trace.statuses.get("budget-routing/anthropic"), "anthropic $0.30");
	assert.ok(!trace.notices.some((n) => /out of budget/.test(n)));
});

test("a successful call clears the out-of-budget state", async () => {
	const { pi } = await loadWith(1000);
	const trace = newTrace();
	const ctx = fakeCtx(trace, "anthropic");
	await pi.handlers.get("message_end")?.[0]({ message: spendLimitError("anthropic") }, ctx);
	assert.equal(await statusEventually(trace, "budget-routing/anthropic", "anthropic out of budget"), "anthropic out of budget");

	await pi.handlers.get("message_end")?.[0]({ message: { role: "assistant", provider: "anthropic", stopReason: "stop" } }, ctx);
	assert.equal(await statusEventually(trace, "budget-routing/anthropic", "anthropic $0.30"), "anthropic $0.30");
});

test("/budget clear drops a remembered refusal", async () => {
	const { pi } = await loadWith(1000);
	const trace = newTrace();
	const ctx = fakeCtx(trace, "anthropic");
	await pi.handlers.get("message_end")?.[0]({ message: spendLimitError("anthropic") }, ctx);

	assert.match(await runBudget(pi, "anthropic", trace), /OUT OF BUDGET: spend limit reached/);
	assert.match(await runBudget(pi, "clear anthropic", trace), /cleared the out-of-budget state for anthropic/);
	assert.doesNotMatch(await runBudget(pi, "anthropic", trace), /OUT OF BUDGET/);
	assert.match(await runBudget(pi, "clear nope", trace), /nope was not marked out of budget/);
});

/** What /v3/me answers for a wallet with `balanceCents` left and `spentCents` billed this period. */
function mePayload(spentCents: number, balanceCents: number, blocked = false, blockReason?: string) {
	const now = new Date();
	const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
	const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
	return {
		object: "me",
		organization: { name: "acme", plan: "gateway" },
		project: { name: "default" },
		visibility: { organization_finance: true },
		balance: { balance_cents: balanceCents },
		spend: { spent_cents: spentCents, limit_cents: null, period_start: periodStart, period_end: periodEnd },
		blocked,
		...(blockReason === undefined ? {} : { block_reason: blockReason }),
	};
}

/**
 * The same throwaway agent directory, but with a prepaid gateway under observation and a stubbed
 * /v3/me, so the wallet path runs end to end without a network.
 */
async function loadOpper(opts: {
	monthlyCapUsd?: number;
	me?: unknown;
	noKey?: boolean;
	fetchShouldFail?: boolean;
	onFetch?: () => void;
} = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "budget-opper-"));
	const now = Date.now();
	await fs.mkdir(path.join(dir, "sessions", "proj"), { recursive: true });
	await fs.writeFile(
		path.join(dir, "sessions", "proj", "current.jsonl"),
		[line("opper", now - 5 * 60_000, 0.35, "aws/claude-sonnet-5-5", 400, 90_000)].join("\n") + "\n",
	);
	const config = {
		localModel: { provider: "strata", modelId: "local", subagentRef: "strata/local" },
		localSubagents: ["scout"],
		thresholds: { nudge: 0.7, warn: 0.8, prepare: 0.95, divert: 1 },
		enforce: "reject",
		providers: [{ provider: "opper", reset: "utc", billing: "metered", balance: { refreshMinutes: 15 }, ...(opts.monthlyCapUsd === undefined ? {} : { monthlyCapUsd: opts.monthlyCapUsd }) }],
	};
	await fs.writeFile(path.join(dir, "budget-routing.json"), JSON.stringify(config));
	await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify(SETTINGS));
	process.env.PI_BUDGET_ROUTING_AGENT_DIR = dir;
	process.env.PI_BUDGET_ROUTING_CONFIG = path.join(dir, "budget-routing.json");
	const mod = await import(`./index.ts?opperdir=${encodeURIComponent(dir)}`);
	const pi = fakePi();
	mod.default(pi as never);

	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		opts.onFetch?.();
		if (opts.fetchShouldFail) return new Response("nope", { status: 401 });
		return new Response(JSON.stringify(opts.me ?? mePayload(122, 877)), { status: 200 });
	}) as typeof fetch;

	const trace = newTrace();
	const ctx = fakeCtx(trace, "opper");
	(ctx.modelRegistry as Record<string, unknown>).getApiKeyForProvider = async () => (opts.noKey ? undefined : "opp-key");
	await pi.handlers.get("session_start")?.[0]({}, ctx);
	return { pi, ctx, trace, restore: () => (globalThis.fetch = realFetch) };
}

test("a wallet figure sets the cap, the footer and the report", async () => {
	const { pi, trace, restore } = await loadOpper();
	try {
		assert.equal(await statusEventually(trace, "budget-routing/opper", "opper 12% $8.77 left"), "opper 12% $8.77 left");
		const out = await runBudget(pi, "opper", trace);
		assert.match(out, /opper: metered, cap \$9\.99, 12% used/);
		assert.match(out, /account balance \$8\.77/);
		// The single-provider report names the source; only the all-provider table labels the kind.
		assert.match(await runBudget(pi, "", trace), /live \(balance\)/);
	} finally {
		restore();
	}
});

test("an empty wallet refuses launches aimed at it and leaves the session alone", async () => {
	const { pi, ctx, trace, restore } = await loadOpper({ me: mePayload(122, 0, true, "balance_exhausted") });
	try {
		assert.equal(await statusEventually(trace, "budget-routing/opper", "opper out of budget"), "opper out of budget");
		const toolCall = pi.handlers.get("tool_call")?.[0];
		const blocked = await toolCall?.({ toolName: "subagent", input: { agent: "worker", task: "x", model: "opper/aws/claude-sonnet-5-5" } }, ctx);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason, /out of budget on opper \(balance_exhausted\)/);
		// A launch that spends another provider is untouched by a drained wallet.
		const passed = await toolCall?.({ toolName: "subagent", input: { agent: "scout", task: "x", model: "mistral/magistral-medium-latest" } }, ctx);
		assert.equal(passed, undefined);
		// Compacting would summarize with the provider that is refusing calls, so it is skipped.
		await pi.handlers.get("agent_end")?.[0]({}, ctx);
		assert.equal(trace.compacts, 0);
	} finally {
		restore();
	}
});

test("no API key means no wallet, so the cap is unknown and its launches are refused", async () => {
	const { pi, ctx, trace, restore } = await loadOpper({ noKey: true });
	try {
		// The logged 0.35 is still printed, but only the wallet knows what the account spent, so the
		// footer claims nothing about headroom and a launch aimed at it is not waved through.
		assert.equal(await statusEventually(trace, "budget-routing/opper", "opper ? cap unknown"), "opper ? cap unknown");
		assert.equal(trace.notices.filter((n) => /no API key for opper/.test(n)).length, 1);
		const blocked = await pi.handlers.get("tool_call")?.[0]({ toolName: "subagent", toolCallId: "k1", input: { agent: "worker", task: "x", model: "opper/aws/claude-sonnet-5-5" } }, ctx);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason, /unable to read the cap on opper \(cap unreadable\)/);
	} finally {
		restore();
	}
});

/** The seat payload the stub answers with, in the shape api.github.com sends. */
function seatPayload(used: number, entitlement: number, remaining: number, timestampUtc = new Date().toISOString()) {
	return {
		login: "tester",
		quota_reset_date_utc: new Date(Date.now() + 6 * 24 * 3600_000).toISOString(),
		token_based_billing: true,
		quota_snapshots: {
			chat: { credits_used: 0, unlimited: true },
			completions: { credits_used: 0, unlimited: true },
			premium_interactions: { credits_used: used, entitlement, remaining, percent_remaining: 70, timestamp_utc: timestampUtc, token_based_billing: true },
		},
	};
}

/** The throwaway agent directory again, this time with a Copilot seat under observation and a stubbed endpoint. */
async function loadSeat(opts: { seat?: unknown; seatShouldFail?: boolean } = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "budget-seat-"));
	const now = Date.now();
	await fs.mkdir(path.join(dir, "sessions", "proj"), { recursive: true });
	await fs.writeFile(path.join(dir, "sessions", "proj", "current.jsonl"), [line("github-copilot", now - 5 * 60_000, 3, "claude-sonnet-5.5", 100, 9_000)].join("\n") + "\n");
	const config = {
		localModel: { provider: "strata", modelId: "local", subagentRef: "strata/local" },
		localSubagents: ["scout"],
		thresholds: { nudge: 0.7, warn: 0.8, prepare: 0.95, divert: 1 },
		enforce: "reject",
		providers: [{ provider: "github-copilot", monthlyCapUsd: 150, seat: { refreshMinutes: 15, credential: "pi" } }],
	};
	await fs.writeFile(path.join(dir, "budget-routing.json"), JSON.stringify(config));
	await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify(SETTINGS));
	await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ "github-copilot": { refresh: "ghu_testtokenforfixture" } }));
	process.env.PI_BUDGET_ROUTING_AGENT_DIR = dir;
	process.env.PI_BUDGET_ROUTING_CONFIG = path.join(dir, "budget-routing.json");
	const mod = await import(`./index.ts?seatdir=${encodeURIComponent(dir)}`);
	const pi = fakePi();
	mod.default(pi as never);

	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		opts.seatShouldFail ? new Response("nope", { status: 401 }) : new Response(JSON.stringify(opts.seat ?? seatPayload(4000, 15000, 11000)), { status: 200 })) as typeof fetch;

	const trace = newTrace();
	const ctx = fakeCtx(trace, "github-copilot");
	await pi.handlers.get("session_start")?.[0]({}, ctx);
	return { pi, ctx, trace, restore: () => (globalThis.fetch = realFetch) };
}

test("a seat that will not answer leaves the cap unknown and refuses Copilot launches", async () => {
	const { pi, ctx, trace, restore } = await loadSeat({ seatShouldFail: true });
	try {
		assert.equal(await statusEventually(trace, "budget-routing/github-copilot", "copilot ? cap unknown"), "copilot ? cap unknown");
		const blocked = await pi.handlers.get("tool_call")?.[0]({ toolName: "subagent", toolCallId: "c1", input: { agent: "worker", task: "x", model: "github-copilot/claude-sonnet-5.5" } }, ctx);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason, /unable to read the cap on copilot \(cap unreadable\)/);
		// The reason the figure is missing stays readable after the single notice has been spent.
		assert.match(await runBudget(pi, "", trace), /figure unreadable: seat fetch rejected the credential \(HTTP 401\)/);
	} finally {
		restore();
	}
});

test("a refusal inside a subagent result marks that provider out of budget for later launches", async () => {
	const { pi, ctx, trace, restore } = await loadSeat();
	try {
		const toolCall = pi.handlers.get("tool_call")?.[0];
		// The seat says there is credit left, so the first launch is allowed.
		assert.equal(await toolCall?.({ toolName: "subagent", toolCallId: "c1", input: { agent: "worker", task: "x", model: "github-copilot/claude-sonnet-5.5" } }, ctx), undefined);
		// A child run's 429 never reaches this session as a message, so it is read back from the result.
		await pi.handlers.get("tool_result")?.[0]({ toolName: "subagent", toolCallId: "c1", input: {}, content: [{ type: "text", text: "Workflow child failed: 429 quota exceeded" }] }, ctx);
		assert.equal(trace.notices.filter((n) => /copilot refused a subagent call/.test(n)).length, 1);
		const blocked = await toolCall?.({ toolName: "subagent", toolCallId: "c2", input: { agent: "worker", task: "x", model: "github-copilot/claude-sonnet-5.5" } }, ctx);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason, /out of budget on copilot \(quota exhausted\)/);
	} finally {
		restore();
	}
});

test("a failing balance fetch is attempted once, not on every settle", async () => {
	let calls = 0;
	const { pi, ctx, trace, restore } = await loadOpper({ fetchShouldFail: true, onFetch: () => calls++ });
	try {
		await pi.handlers.get("agent_settled")?.[0]({}, ctx);
		await pi.handlers.get("agent_settled")?.[0]({}, ctx);
		await new Promise((r) => setTimeout(r, 50));
		// One attempt from session_start; the settles are inside the refresh window.
		assert.equal(calls, 1);
		assert.equal(trace.notices.filter((n) => /balance refresh failed/.test(n)).length, 1);
	} finally {
		restore();
	}
});
