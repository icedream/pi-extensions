// Unit tests for budget-routing. Run from budget-routing/: node --test budget.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { utimes } from "node:fs/promises";
import {
	advisorySection,
	applyDivert,
	billingFor,
	buildRoutes,
	costTable,
	DEFAULT_SEAT,
	DEFAULT_THRESHOLDS,
	formatCost,
	menuModelRefs,
	monthSpend,
	monthSpendAll,
	monthStartMs,
	parseAgentOverrideModels,
	parseConfig,
	parseSeatFigure,
	preSwitchCompactionStep,
	providerForModelRef,
	providerStatus,
	rejectReason,
	classifyExhaustion,
	exhaustionActive,
	formatTokens,
	spendByWindow,
	spendSince,
	statusLabel,
	tierFor,
	usageReport,
	usageSince,
	windowLabel,
	type ProviderStatus,
	type Tier,
} from "./budget.ts";
import { pickGitHubToken } from "./credential.ts";

const line = (provider: string, role: string, timestamp: number, cost: number) =>
	JSON.stringify({ type: "message", message: { role, provider, timestamp, usage: { cost: { total: cost } } } });

// A full usage record, the shape Pi writes for every assistant message.
const usageLine = (provider: string, model: string, timestamp: number, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number }) =>
	JSON.stringify({
		type: "message",
		message: { role: "assistant", provider, model, timestamp, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...u, cost: { total: u.cost ?? 0 } } },
	});

async function tmpSessions(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "budget-routing-test-"));
}

test("monthStartMs is local midnight on the first of the month", () => {
	const now = new Date(2026, 9, 15, 13, 30); // 15 Oct 2026, local
	assert.equal(monthStartMs(now), new Date(2026, 9, 1).getTime());
});

test("spendSince sums only in-window assistant messages from the given provider", async () => {
	const dir = await tmpSessions();
	const since = monthStartMs();
	const now = Date.now();
	const lastMonth = since - 86_400_000;

	await fs.mkdir(path.join(dir, "proj"));
	await fs.writeFile(
		path.join(dir, "proj", "current.jsonl"),
		[
			line("github-copilot", "assistant", now, 2.5),
			line("github-copilot", "user", now, 99), // user message: ignored
			line("google", "assistant", now, 9), // other provider: ignored
			line("github-copilot", "assistant", now, 1.25),
			'{"role":"assistant" broken', // invalid JSON: skipped
			line("github-copilot", "assistant", lastMonth, 40), // previous month: ignored
		].join("\n"),
	);
	// A file untouched since before the window must be skipped entirely.
	const old = path.join(dir, "proj", "stale.jsonl");
	await fs.writeFile(old, line("github-copilot", "assistant", now, 500));
	const longAgo = new Date(since - 10 * 86_400_000);
	await utimes(old, longAgo, longAgo);

	assert.equal(await spendSince(dir, "github-copilot", since), 3.75);
});

test("spendSince skips subagent transcripts that duplicate child sessions", async () => {
	const dir = await tmpSessions();
	const now = Date.now();
	await fs.mkdir(path.join(dir, "proj", "run-0"), { recursive: true });
	await fs.mkdir(path.join(dir, "subagent-artifacts"));
	// The same child message appears in the child session and in its transcript.
	await fs.writeFile(path.join(dir, "proj", "run-0", "session.jsonl"), line("github-copilot", "assistant", now, 2));
	await fs.writeFile(path.join(dir, "subagent-artifacts", "x_transcript.jsonl"), line("github-copilot", "assistant", now, 2));
	assert.equal(await spendSince(dir, "github-copilot", monthStartMs()), 2);
});

test("spendSince returns 0 for a missing sessions directory", async () => {
	assert.equal(await spendSince(path.join(os.tmpdir(), "does-not-exist-budget"), "github-copilot", 0), 0);
});

test("usageSince breaks one provider down by model, largest cost first", async () => {
	const dir = await tmpSessions();
	const now = Date.now();
	const since = now - 3_600_000;
	await fs.mkdir(path.join(dir, "proj"));
	await fs.writeFile(
		path.join(dir, "proj", "s.jsonl"),
		[
			usageLine("anthropic", "claude-haiku-5-5", now, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.5 }),
			usageLine("anthropic", "claude-sonnet-5-5", now, { input: 100, output: 200, cacheRead: 300, cacheWrite: 400, cost: 2.5 }),
			usageLine("anthropic", "claude-haiku-5-5", now, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.25 }),
			usageLine("mistral", "magistral-medium-latest", now, { input: 5, output: 6, cost: 9 }), // other provider: ignored
			usageLine("anthropic", "claude-haiku-5-5", since - 1000, { input: 999, cost: 99 }), // before the window: ignored
		].join("\n") + "\n",
	);
	const rows = await usageSince(dir, "anthropic", since);
	assert.deepEqual(rows.map((r) => r.model), ["claude-sonnet-5-5", "claude-haiku-5-5"]);
	assert.deepEqual(rows[0], { model: "claude-sonnet-5-5", messages: 1, input: 100, output: 200, cacheRead: 300, cacheWrite: 400, cost: 2.5 });
	assert.deepEqual(rows[1], { model: "claude-haiku-5-5", messages: 2, input: 11, output: 22, cacheRead: 33, cacheWrite: 44, cost: 0.75 });
});

test("usageSince returns nothing for a provider with no logged messages", async () => {
	const dir = await tmpSessions();
	assert.deepEqual(await usageSince(dir, "anthropic", 0), []);
	assert.deepEqual(await usageSince(path.join(os.tmpdir(), "does-not-exist-usage"), "anthropic", 0), []);
});

test("formatTokens keeps the report columns narrow", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(812), "812");
	assert.equal(formatTokens(14_400), "14k");
	assert.equal(formatTokens(2_440_000), "2.4M");
	assert.equal(formatTokens(3_500_000_000), "3.5B");
});

test("windowLabel names the zone the window starts in", () => {
	assert.equal(windowLabel(Date.UTC(2026, 10, 1), "utc"), "since 2026-11-01 00:00 UTC");
	assert.equal(windowLabel(new Date(2026, 10, 1).getTime(), "local"), "since 2026-11-01 00:00 local");
});

test("usageReport shows the cap state, the per-model table, and a total row", () => {
	const rows = [
		{ model: "claude-sonnet-5-5", messages: 2, input: 100, output: 200, cacheRead: 300, cacheWrite: 400, cost: 2.5 },
		{ model: "claude-haiku-5-5", messages: 1, input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.5 },
	];
	const status: ProviderStatus = {
		provider: "anthropic",
		billing: "metered",
		capUsd: 60,
		spend: 3,
		pct: 5,
		tier: "ok",
		source: "meter",
		observationIgnored: false,
	};
	const out = usageReport("anthropic", rows, "since 2026-11-01 00:00 UTC", status);
	assert.match(out, /^anthropic: metered, cap \$60\.00, 5% used, spent \$3\.00 \(meter\), since 2026-11-01 00:00 UTC/);
	assert.match(out, /model +msgs +input +output +cache r +cache w +cost/);
	assert.match(out, /claude-sonnet-5-5 +2 +100 +200 +300 +400 +\$2\.50/);
	assert.match(out, /total +3 +110 +220 +330 +440 +\$3\.00/);
	// A meter figure already is the logged total, so there is nothing to reconcile.
	assert.ok(!/logged by pi/.test(out));
});

test("usageReport explains why a fetched figure and the logged total differ", () => {
	const rows = [{ model: "claude-sonnet-5.5", messages: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 1.5 }];
	const status: ProviderStatus = {
		provider: "github-copilot",
		billing: "credits",
		capUsd: 150,
		spend: 136.5,
		pct: 91,
		tier: "warn",
		source: "live",
		observationIgnored: false,
	};
	const out = usageReport("github-copilot", rows, "since 2026-11-01 00:00 local", status);
	assert.match(out, /spent \$136\.50 \(live\)/);
	assert.match(out, /logged by pi: \$1\.50/);
});

test("usageReport handles an untracked provider and an empty window", () => {
	const rows = [{ model: "qwen3.8-flash-next-iq3_s", messages: 4, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0 }];
	const untracked = usageReport("strata", rows, "since 2026-11-01 00:00 local");
	assert.match(untracked, /^strata: not in budget-routing\.json, usage only, logged \$0\.00/);
	assert.match(untracked, /qwen3\.8-flash-next-iq3_s +4 +1k +500 +0 +0 +\$0\.00/);

	const empty = usageReport("freellmapi", [], "since 2026-11-01 00:00 local");
	assert.match(empty, /no assistant messages logged for this window/);
});

test("tierFor maps fractions to tiers at the threshold boundaries", () => {
	const t = DEFAULT_THRESHOLDS;
	assert.equal(tierFor(0.69, t), "ok");
	assert.equal(tierFor(0.7, t), "nudge");
	assert.equal(tierFor(0.8, t), "warn");
	assert.equal(tierFor(0.95, t), "prepare");
	assert.equal(tierFor(0.999, t), "prepare");
	assert.equal(tierFor(1, t), "divert");
	assert.equal(tierFor(1.2, t), "divert");
});

const COPILOT = "github-copilot";
const LOCAL = "llama-server=http://icedream-homepc:11180/qwen3.8-27b";

// Registry fixture for divert tests: provider names with and without slashes, ids with colons.
const LOCAL_REF = "icedream-homepc/strata/qwen3.8-flash-next-iq3_s";
const REGISTRY = [
	{ provider: COPILOT, id: "claude-sonnet-5.5" },
	{ provider: "freellmapi", id: "auto" },
	{ provider: "freellmapi", id: "openai/gpt-oss-120b:free" },
	{ provider: "hetzner", id: "Qwen3.8-27B" },
	{ provider: "kubeai", id: "claude-sonnet-5.5" },
	{ provider: "icedream-homepc/strata", id: "qwen3.8-flash-next-iq3_s" },
];

const st = (tier: Tier, provider = COPILOT, capUsd = 150): ProviderStatus => ({
	provider,
	billing: "credits",
	capUsd,
	spend: 0,
	tier,
	source: "meter",
	observationIgnored: false,
});

// Simulate one crossing: each agent_end feeds its returned flag back in, exactly like index.ts,
// and each provider keeps its own flag.
function crossing(steps: Array<[Tier | undefined, string | undefined]>): boolean[] {
	const flags = new Map<string, boolean>();
	const compact: boolean[] = [];
	for (const [tier, sessionProvider] of steps) {
		const mine = tier !== undefined && sessionProvider === COPILOT ? st(tier) : undefined;
		const step = preSwitchCompactionStep(mine, flags.get(sessionProvider ?? "") ?? false);
		if (step.compacted) flags.set(sessionProvider ?? "", true);
		else flags.delete(sessionProvider ?? "");
		compact.push(step.compact);
	}
	return compact;
}

test("preSwitchCompactionStep compacts only at prepare/divert for the provider being spent", () => {
	assert.deepEqual(preSwitchCompactionStep(st("prepare"), false), { compact: true, compacted: true });
	assert.deepEqual(preSwitchCompactionStep(st("divert"), false), { compact: true, compacted: true });
	for (const tier of ["ok", "nudge", "warn"] as const) {
		assert.deepEqual(preSwitchCompactionStep(st(tier), false), { compact: false, compacted: false });
	}
	// A session on a provider that is not tracked at all neither compacts nor consumes the flag.
	assert.deepEqual(preSwitchCompactionStep(undefined, false), { compact: false, compacted: false });
	assert.deepEqual(preSwitchCompactionStep(undefined, true), { compact: false, compacted: true });
});

test("preSwitchCompactionStep skips an untracked session model without consuming the once-per-crossing flag", () => {
	assert.deepEqual(preSwitchCompactionStep(undefined, false), { compact: false, compacted: false });
	assert.deepEqual(preSwitchCompactionStep(undefined, true), { compact: false, compacted: true });
});

test("a local-model agent_end does not block a later Copilot compaction in the same crossing", () => {
	assert.deepEqual(crossing([["prepare", LOCAL], ["prepare", COPILOT], ["prepare", COPILOT]]), [false, true, false]);
});

test("dropping below prepare resets the flag so the next crossing compacts again", () => {
	assert.deepEqual(crossing([["prepare", COPILOT], ["warn", COPILOT], ["prepare", COPILOT]]), [true, false, true]);
});

test("divert does not compact again after prepare already compacted in the same crossing", () => {
	assert.deepEqual(crossing([["prepare", COPILOT], ["divert", COPILOT]]), [true, false]);
});

test("an over-cap provider elsewhere does not compact a session spending a healthy one", () => {
	const anthropic = st("ok", "anthropic", 60);
	assert.deepEqual(preSwitchCompactionStep(anthropic, false), { compact: false, compacted: false });
});

test("each provider gets its own once-per-crossing flag", () => {
	const flags = new Map<string, boolean>();
	const seen: boolean[] = [];
	for (const [tier, provider] of [["divert", COPILOT], ["divert", "anthropic"], ["divert", COPILOT]] as [Tier, string][]) {
		const step = preSwitchCompactionStep(st(tier, provider, 150), flags.get(provider) ?? false);
		flags.set(provider, step.compacted);
		seen.push(step.compact);
	}
	assert.deepEqual(seen, [true, true, false]);
});

test("applyDivert in rewrite mode rewrites local-eligible launches and rejects the rest", () => {
	const ref = "llama-server=http://x:1/qwen";
	const opts = { mode: "rewrite" as const, localSubagents: ["scout", "Plan"], subagentRef: ref, tiers: { [COPILOT]: "divert" as Tier }, sessionProvider: COPILOT };

	const single = { agent: "scout", task: "find X" };
	assert.deepEqual(applyDivert(single, opts), { rewritten: 1, rejected: [], passed: [] });
	assert.equal((single as { model?: string }).model, ref);

	const rejectedSingle = { agent: "worker", task: "implement" };
	assert.deepEqual(applyDivert(rejectedSingle, opts), { rewritten: 0, rejected: [{ label: "worker", provider: COPILOT }], passed: [] });
	assert.equal((rejectedSingle as { model?: string }).model, undefined);

	const batch = { tasks: [{ agent: "Plan", task: "a" }, { agent: "reviewer", task: "b" }, { task: "no agent" }] };
	const r = applyDivert(batch, opts);
	assert.deepEqual(r.rewritten, 1);
	assert.deepEqual(r.rejected, [{ label: "reviewer", provider: COPILOT }, { label: "(no agent)", provider: COPILOT }]);
	assert.equal((batch.tasks[0] as { model?: string }).model, ref);
	assert.equal((batch.tasks[1] as { model?: string }).model, undefined);
});

test("applyDivert in reject mode rewrites nothing and reports every over-cap launch", () => {
	const opts = { mode: "reject" as const, localSubagents: ["scout"], subagentRef: LOCAL_REF, tiers: { [COPILOT]: "divert" as Tier } };
	const scout = { agent: "scout", task: "look" };
	assert.deepEqual(applyDivert(scout, opts), { rewritten: 0, rejected: [{ label: "scout", provider: undefined }], passed: [] });
	assert.equal((scout as { model?: string }).model, undefined);
});

test("applyDivert in off mode touches nothing even at divert", () => {
	const opts = { mode: "off" as const, localSubagents: ["scout"], subagentRef: LOCAL_REF, tiers: { [COPILOT]: "divert" as Tier } };
	assert.deepEqual(applyDivert({ agent: "scout", task: "look" }, opts), { rewritten: 0, rejected: [], passed: [] });
});

test("applyDivert leaves management actions untouched", () => {
	const status = { action: "status", id: "abc" };
	assert.deepEqual(
		applyDivert(status, { mode: "reject", localSubagents: ["scout"], subagentRef: "ref", tiers: { [COPILOT]: "divert" } }),
		{ rewritten: 0, rejected: [], passed: [] },
	);
	assert.equal((status as { model?: string }).model, undefined);
});

test("applyDivert does not touch launches aimed at another provider", () => {
	const opts = { mode: "rewrite" as const, localSubagents: ["scout"], subagentRef: LOCAL_REF, tiers: { [COPILOT]: "divert" as Tier }, models: REGISTRY };

	// The reported bug: a non-local agent explicitly on freellmapi is neither rejected nor rewritten.
	const researcher = { agent: "researcher", model: "freellmapi/auto", task: "critique the plan" };
	assert.deepEqual(applyDivert(researcher, opts), { rewritten: 0, rejected: [], passed: ["researcher"] });
	assert.equal(researcher.model, "freellmapi/auto");

	const advisor = { agent: "advisor", model: "hetzner/Qwen3.8-27B:xhigh", task: "critique" };
	assert.deepEqual(applyDivert(advisor, opts), { rewritten: 0, rejected: [], passed: ["advisor"] });

	// A local-eligible agent that already names another provider keeps that model.
	const scout = { agent: "scout", model: "hetzner/Qwen3.8-27B", task: "look" };
	assert.deepEqual(applyDivert(scout, opts), { rewritten: 0, rejected: [], passed: ["scout"] });
	assert.equal(scout.model, "hetzner/Qwen3.8-27B");

	// Mixed batch: only the copilot launch is a candidate.
	const batch = {
		tasks: [
			{ agent: "worker", model: "github-copilot/claude-sonnet-5.5", task: "a" },
			{ agent: "delegate", model: LOCAL_REF, task: "b" },
			{ agent: "scout", task: "c" },
		],
	};
	assert.deepEqual(applyDivert(batch, opts), { rewritten: 1, rejected: [{ label: "worker", provider: COPILOT }], passed: ["delegate"] });
	assert.equal((batch.tasks[2] as { model?: string }).model, LOCAL_REF);
});

test("applyDivert treats an unattributable model as the worst tier among the capped providers", () => {
	const opts = {
		mode: "reject" as const,
		localSubagents: ["scout"],
		subagentRef: LOCAL_REF,
		tiers: { [COPILOT]: "ok", anthropic: "divert" } as Record<string, Tier>,
		models: REGISTRY,
		sessionProvider: COPILOT,
	};
	// The session sits on a healthy provider, but the alias could resolve to the diverting one.
	const unknown = { agent: "worker", model: "not-a-provider/whatever", task: "a" };
	assert.deepEqual(applyDivert(unknown, opts), { rewritten: 0, rejected: [{ label: "worker", provider: undefined }], passed: [] });
	const ambiguous = { agent: "worker", model: "claude-sonnet-5.5", task: "a" };
	assert.deepEqual(applyDivert(ambiguous, opts), { rewritten: 0, rejected: [{ label: "worker", provider: undefined }], passed: [] });
});

test("applyDivert ignores a provider that is only at prepare", () => {
	const opts = { mode: "reject" as const, localSubagents: ["scout"], subagentRef: LOCAL_REF, tiers: { [COPILOT]: "prepare" as Tier } };
	assert.deepEqual(applyDivert({ agent: "worker", model: "github-copilot/claude-sonnet-5.5", task: "a" }, opts), {
		rewritten: 0,
		rejected: [],
		passed: ["worker"],
	});
});

test("applyDivert uses the session provider when a launch names no model", () => {
	const local = {
		mode: "rewrite" as const,
		localSubagents: ["scout"],
		subagentRef: LOCAL_REF,
		tiers: { [COPILOT]: "divert" as Tier },
		sessionProvider: "freellmapi",
	};
	assert.deepEqual(applyDivert({ agent: "worker", task: "a" }, local), { rewritten: 0, rejected: [], passed: ["worker"] });
	assert.deepEqual(applyDivert({ agent: "scout", task: "a" }, local), { rewritten: 0, rejected: [], passed: ["scout"] });

	const capped = { mode: "rewrite" as const, localSubagents: ["scout"], subagentRef: LOCAL_REF, tiers: { [COPILOT]: "divert" as Tier }, sessionProvider: COPILOT };
	assert.deepEqual(applyDivert({ agent: "worker", task: "a" }, capped), { rewritten: 0, rejected: [{ label: "worker", provider: COPILOT }], passed: [] });
	assert.deepEqual(applyDivert({ agent: "scout", task: "a" }, capped), { rewritten: 1, rejected: [], passed: [] });
});

test("providerForModelRef resolves full ids, bare ids, and thinking suffixes", () => {
	assert.equal(providerForModelRef("freellmapi/auto", REGISTRY), "freellmapi");
	// Provider names may contain slashes: the full id, not the first slash, decides.
	assert.equal(providerForModelRef(LOCAL_REF, REGISTRY), "icedream-homepc/strata");
	assert.equal(providerForModelRef("hetzner/Qwen3.8-27B:xhigh", REGISTRY), "hetzner");
	assert.equal(providerForModelRef("openai/gpt-oss-120b:free", REGISTRY), "freellmapi");
	assert.equal(providerForModelRef("Qwen3.8-27B", REGISTRY), "hetzner");
	assert.equal(providerForModelRef("claude-sonnet-5.5", REGISTRY), undefined); // ambiguous
	assert.equal(providerForModelRef("nope/nope", REGISTRY), undefined);
	assert.equal(providerForModelRef("", REGISTRY), undefined);
});

const validRaw = {
	provider: "github-copilot",
	monthlyCapUsd: 150,
	localModel: { provider: "llama-server=http://x:1", modelId: "qwen", subagentRef: "llama-server=http://x:1/qwen" },
	localSubagents: ["scout"],
};

test("parseConfig applies default thresholds and reads a v1 file as one provider", () => {
	const c = parseConfig(validRaw);
	assert.deepEqual(c.thresholds, DEFAULT_THRESHOLDS);
	assert.equal(c.providers.length, 1);
	assert.equal(c.providers[0].monthlyCapUsd, 150);
	assert.equal(c.enforce, "reject");
});

test("parseConfig rejects bad values with a clear message", () => {
	assert.throws(() => parseConfig({ ...validRaw, monthlyCapUsd: 0 }), /monthlyCapUsd must be positive/);
	assert.throws(() => parseConfig({ ...validRaw, thresholds: { warn: 0.9, prepare: 0.5 } }), /non-decreasing/);
	assert.throws(() => parseConfig({ ...validRaw, localSubagents: [] }), /localSubagents/);
	assert.throws(() => parseConfig({ ...validRaw, localModel: undefined }), /localModel is required/);
	assert.throws(() => parseConfig({ ...validRaw, enforce: "yolo" }), /enforce must be one of/);
	assert.throws(() => parseConfig(null), /JSON object/);
});

test("parseConfig validates the observed calibration and defaults usdPerCredit", () => {
	const ok = parseConfig({ ...validRaw, observed: { creditsUsed: 8216, asOf: "2026-10-01T00:00:00Z" } });
	assert.equal(ok.providers[0].observed?.usdPerCredit, 0.01);
	assert.equal(ok.providers[0].observed?.asOfMs, Date.parse("2026-10-01T00:00:00Z"));
	assert.throws(() => parseConfig({ ...validRaw, observed: { creditsUsed: -1, asOf: "2026-10-01T00:00:00Z" } }), /creditsUsed must be >= 0/);
	assert.throws(() => parseConfig({ ...validRaw, observed: { creditsUsed: 1, asOf: "not a date" } }), /asOf must be an ISO date/);
	assert.throws(() => parseConfig({ ...validRaw, observed: { creditsUsed: 1, usdPerCredit: 0, asOf: "2026-10-01T00:00:00Z" } }), /usdPerCredit must be positive/);
});

test("monthSpend: calibrated baseline plus Pi spend since asOf only", async () => {
	const dir = await tmpSessions();
	const now = new Date();
	const asOf = Math.max(monthStartMs(now) + 1000, now.getTime() - 3_600_000);
	await fs.mkdir(path.join(dir, "proj"));
	await fs.writeFile(
		path.join(dir, "proj", "s.jsonl"),
		[
			line("github-copilot", "assistant", asOf - 1000, 50), // before asOf: already in the seat figure
			line("github-copilot", "assistant", now.getTime(), 1.5), // after asOf: added on top
		].join("\n"),
	);
	const cfg = parseConfig({ ...validRaw, observed: { creditsUsed: 8216, asOf: new Date(asOf).toISOString() } });
	const r = await monthSpend(cfg.providers[0], dir, now);
	assert.equal(r.source, "calibrated");
	assert.equal(r.observationIgnored, false);
	assert.ok(Math.abs(r.spend - (82.16 + 1.5)) < 1e-9, `got ${r.spend}`);
});

test("monthSpend: ignores an observation from a previous month", async () => {
	const dir = await tmpSessions();
	const cfg = parseConfig({ ...validRaw, observed: { creditsUsed: 8216, asOf: "2000-01-01T00:00:00Z" } });
	const r = await monthSpend(cfg.providers[0], dir, new Date());
	assert.equal(r.source, "meter");
	assert.equal(r.observationIgnored, true);
});

// Trimmed from a real copilot_internal/user response.
const seatPayload = {
	login: "icedream",
	quota_reset_date_utc: "2026-11-01T00:00:00.000Z",
	token_based_billing: true,
	quota_snapshots: {
		chat: { credits_used: 0, unlimited: true },
		completions: { credits_used: 0, unlimited: true },
		premium_interactions: {
			credits_used: 15640,
			entitlement: 17000,
			remaining: 1361,
			percent_remaining: 8,
			timestamp_utc: "2026-10-14T08:04:32.173-07:00",
			token_based_billing: true,
		},
	},
};

test("parseSeatFigure reads the premium_interactions snapshot", () => {
	const f = parseSeatFigure(seatPayload);
	assert.equal(f.login, "icedream");
	assert.equal(f.creditsUsed, 15640);
	assert.equal(f.entitlement, 17000);
	assert.equal(f.remaining, 1361);
	assert.equal(f.resetDateMs, Date.parse("2026-11-01T00:00:00.000Z"));
	assert.equal(f.tokenBasedBilling, true);
	// the UTC offset in the payload must survive
	assert.equal(new Date(f.asOfMs).toISOString(), "2026-10-14T15:04:32.173Z");
});

test("parseSeatFigure rejects payloads that are not the seat shape", () => {
	assert.throws(() => parseSeatFigure(null), /must be a JSON object/);
	assert.throws(() => parseSeatFigure({}), /no quota_snapshots.premium_interactions/);
	assert.throws(() => parseSeatFigure({ quota_snapshots: { chat: {} } }), /no quota_snapshots.premium_interactions/);
	assert.throws(
		() => parseSeatFigure({ quota_snapshots: { premium_interactions: { entitlement: 17000 } } }),
		/credits_used/,
	);
	assert.throws(
		() => parseSeatFigure({ quota_snapshots: { premium_interactions: { credits_used: 1, entitlement: 0 } } }),
		/not on credit-based billing/,
	);
	assert.throws(
		() => parseSeatFigure({ quota_snapshots: { premium_interactions: { credits_used: 1, entitlement: 100 } } }),
		/timestamp_utc is not a date/,
	);
});

test("pickGitHubToken uses a GitHub token and never the Copilot proxy token", () => {
	assert.equal(pickGitHubToken({ access: "tid=abc123", refresh: "ghu_B6bwEXAMPLE" }), "ghu_B6bwEXAMPLE");
	assert.equal(pickGitHubToken({ access: "gho_plain", refresh: "ghu_other" }), "gho_plain");
	assert.equal(pickGitHubToken({ access: "github_pat_11ABCDEFG" }), "github_pat_11ABCDEFG");
	assert.equal(pickGitHubToken({ access: "tid=abc" }), undefined);
	assert.equal(pickGitHubToken({ refresh: "ghr_notabearer" }), undefined);
	assert.equal(pickGitHubToken(undefined), undefined);
	assert.equal(pickGitHubToken("nope"), undefined);
});

test("parseConfig leaves seat off by default and validates the block", () => {
	assert.equal(parseConfig(validRaw).providers[0].seat, undefined);
	assert.deepEqual(parseConfig({ ...validRaw, seat: {} }).providers[0].seat, DEFAULT_SEAT);
	assert.deepEqual(parseConfig({ ...validRaw, seat: { refreshMinutes: 60, credential: "gh" } }).providers[0].seat, {
		refreshMinutes: 60,
		credential: "gh",
	});
	assert.throws(() => parseConfig({ ...validRaw, seat: { refreshMinutes: 0 } }), /refreshMinutes must be >= 1/);
	assert.throws(() => parseConfig({ ...validRaw, seat: { credential: "browser" } }), /credential must be one of/);
	assert.throws(() => parseConfig({ ...validRaw, seat: 5 }), /seat must be an object/);
});

test("monthSpend: a live seat figure wins over the hand-written observed", async () => {
	const dir = await tmpSessions();
	await fs.writeFile(path.join(dir, "s.jsonl"), [line("github-copilot", "assistant", Date.now(), 2.5)].join("\n") + "\n");
	const now = new Date();
	const cfg = parseConfig({ ...validRaw, observed: { creditsUsed: 999_999, asOf: new Date(now).toISOString() } });
	const live = { ...parseSeatFigure(seatPayload), asOfMs: now.getTime() - 60_000 };

	const r = await monthSpend(cfg.providers[0], dir, now, live);
	assert.equal(r.source, "live");
	assert.equal(r.observationIgnored, false);
	// 15640 credits at the default 0.01, plus the 2.50 logged after the snapshot
	assert.ok(Math.abs(r.spend - (156.4 + 2.5)) < 1e-9, `got ${r.spend}`);
});

test("monthSpend: live figure adds Pi spend since the snapshot, and usdPerCredit still applies", async () => {
	const dir = await tmpSessions();
	const now = new Date();
	await fs.writeFile(path.join(dir, "s.jsonl"), [
		line("github-copilot", "assistant", now.getTime() - 10 * 60_000, 3), // before the snapshot: excluded
		line("github-copilot", "assistant", now.getTime() - 60_000, 1.5), // after it: counted
	].join("\n") + "\n");
	const cfg = parseConfig({ ...validRaw, observed: { creditsUsed: 1, asOf: new Date(now).toISOString(), usdPerCredit: 0.02 } });
	const live = { ...parseSeatFigure(seatPayload), asOfMs: now.getTime() - 5 * 60_000 };

	const r = await monthSpend(cfg.providers[0], dir, now, live);
	assert.equal(r.source, "live");
	assert.ok(Math.abs(r.spend - (15640 * 0.02 + 1.5)) < 1e-9, `got ${r.spend}`);
});

test("monthSpend: a live figure from another month falls back to the meter", async () => {
	const dir = await tmpSessions();
	await fs.writeFile(path.join(dir, "s.jsonl"), [line("github-copilot", "assistant", Date.now(), 4)].join("\n") + "\n");
	const cfg = parseConfig(validRaw);
	const stale = { ...parseSeatFigure(seatPayload), asOfMs: new Date(2000, 0, 1).getTime() };
	const r = await monthSpend(cfg.providers[0], dir, new Date(), stale);
	assert.equal(r.source, "meter");
	assert.equal(r.observationIgnored, true);
	assert.ok(Math.abs(r.spend - 4) < 1e-9, `got ${r.spend}`);
});

test("statusLabel is compact, coloured by tier, marks estimates, and shows spend when uncapped", () => {
	const mk = (provider: string, pct: number, tier: Tier, source: ProviderStatus["source"], capUsd = 150): ProviderStatus => ({
		provider,
		billing: "credits",
		capUsd,
		spend: (capUsd * pct) / 100,
		pct,
		tier,
		source,
		observationIgnored: false,
	});
	assert.deepEqual(statusLabel(mk("github-copilot", 42, "ok", "live")), { text: "copilot 42%", color: "dim" });
	assert.deepEqual(statusLabel(mk("github-copilot", 74, "nudge", "calibrated")), { text: "copilot 74%", color: "accent" });
	assert.deepEqual(statusLabel(mk("github-copilot", 96, "prepare", "live")), { text: "copilot 96% !", color: "warning" });
	assert.deepEqual(statusLabel(mk("github-copilot", 103, "divert", "live")), { text: "copilot 103% over", color: "error" });
	assert.deepEqual(statusLabel(mk("litellm", 70, "warn", "meter")), { text: "litellm ~70%", color: "warning" });
	assert.deepEqual(statusLabel({ ...mk("mistral", 0, "ok", "meter"), capUsd: undefined, spend: 6.46 }), { text: "mistral $6.46", color: "dim" });
});

// Today's on-disk config, verbatim, must keep parsing.
const v1OnDisk = {
	provider: "github-copilot",
	monthlyCapUsd: 150,
	thresholds: { nudge: 0.7, warn: 0.8, prepare: 0.95, divert: 1.0 },
	localModel: { provider: "strata", modelId: "qwen3.8-flash-next-iq3_s", subagentRef: "strata/qwen3.8-flash-next-iq3_s" },
	localSubagents: ["scout", "delegate", "Plan", "Explore"],
	seat: { refreshMinutes: 15, credential: "auto" },
};

const v2Raw = {
	localModel: { provider: "strata", modelId: "qwen3.8-flash-next-iq3_s", subagentRef: "strata/qwen3.8-flash-next-iq3_s" },
	localSubagents: ["scout"],
	thresholds: { nudge: 0.7, warn: 0.8, prepare: 0.95, divert: 1.0 },
	providers: [
		{ provider: "github-copilot", monthlyCapUsd: 150, seat: { refreshMinutes: 15 } },
		{ provider: "anthropic", reset: "utc" },
		{ provider: "mistral", monthlyCapUsd: 20 },
	],
};

test("parseConfig reads the current on-disk v1 file as a one-entry provider list", () => {
	const c = parseConfig(v1OnDisk);
	assert.deepEqual(c.providers.map((p) => p.provider), [COPILOT]);
	assert.equal(c.providers[0].monthlyCapUsd, 150);
	assert.deepEqual(c.providers[0].seat, { refreshMinutes: 15, credential: "auto" });
	assert.deepEqual(c.localSubagents, ["scout", "delegate", "Plan", "Explore"]);
});

test("parseConfig reads a providers array, an optional cap, and a reset zone", () => {
	const c = parseConfig(v2Raw);
	assert.deepEqual(c.providers.map((p) => p.provider), [COPILOT, "anthropic", "mistral"]);
	assert.equal(c.providers[1].monthlyCapUsd, undefined);
	assert.equal(c.providers[1].reset, "utc");
	assert.equal(c.providers[0].reset, "local");
	assert.equal(c.providers[2].monthlyCapUsd, 20);
	// every entry shares the one threshold set
	assert.deepEqual(c.providers[2].thresholds, DEFAULT_THRESHOLDS);
});

test("parseConfig rejects mixing v1 and v2 keys, duplicates, and a non-positive cap", () => {
	assert.throws(() => parseConfig({ ...v1OnDisk, providers: [{ provider: "mistral" }] }), /either provider or providers, not both/);
	assert.throws(
		() => parseConfig({ ...v2Raw, providers: [{ provider: "mistral" }, { provider: "mistral", monthlyCapUsd: 5 }] }),
		/duplicate provider mistral/,
	);
	assert.throws(() => parseConfig({ ...v2Raw, providers: [{ provider: "mistral", monthlyCapUsd: 0 }] }), /mistral.monthlyCapUsd must be positive/);
	assert.throws(() => parseConfig({ ...v2Raw, providers: [] }), /providers must be a non-empty array/);
	assert.throws(() => parseConfig({ localModel: v2Raw.localModel, localSubagents: ["scout"] }), /providers must be a non-empty array/);
});

test("monthStartMs in utc reads utc components, even when the local month differs", () => {
	for (const iso of ["2026-11-01T00:30:00Z", "2026-10-31T23:30:00Z", "2026-01-01T00:00:00Z", "2026-12-15T12:00:00Z"]) {
		const d = new Date(iso);
		assert.equal(monthStartMs(d, "utc"), Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), iso);
	}
	// A date that is November in UTC but still October locally must not pick the local month.
	const boundary = new Date(Date.UTC(2026, 10, 1, 0, 30));
	const localMonth = new Date(boundary).getMonth();
	if (localMonth !== 10) {
		assert.notEqual(monthStartMs(boundary, "utc"), new Date(boundary.getFullYear(), localMonth, 1).getTime());
		assert.equal(monthStartMs(boundary, "utc"), Date.UTC(2026, 10, 1));
	}
});

test("spendByWindow sums several providers and windows in one walk", async () => {
	const dir = await tmpSessions();
	const now = Date.now();
	const monthAgo = now - 20 * 86_400_000;
	await fs.writeFile(
		path.join(dir, "s.jsonl"),
		[
			line(COPILOT, "assistant", monthAgo, 40),
			line(COPILOT, "assistant", now, 3),
			line("anthropic", "assistant", monthAgo, 4),
			line("anthropic", "assistant", now, 2),
			line("mistral", "assistant", now, 0.5),
		].join("\n") + "\n",
	);
	const m = await spendByWindow(dir, [
		{ key: "copilot:month", provider: COPILOT, sinceMs: monthAgo },
		{ key: "copilot:tail", provider: COPILOT, sinceMs: now - 60_000 },
		{ key: "anthropic", provider: "anthropic", sinceMs: monthAgo },
		{ key: "mistral", provider: "mistral", sinceMs: monthAgo },
	]);
	assert.equal(m.get("copilot:month"), 43);
	assert.equal(m.get("copilot:tail"), 3);
	assert.equal(m.get("anthropic"), 6);
	assert.equal(m.get("mistral"), 0.5);
});

test("monthSpendAll mixes a fetched baseline with plain meters in one walk", async () => {
	const dir = await tmpSessions();
	const now = new Date();
	await fs.writeFile(
		path.join(dir, "s.jsonl"),
		[
			line(COPILOT, "assistant", now.getTime() - 10 * 60_000, 3), // before the snapshot: already counted
			line(COPILOT, "assistant", now.getTime() - 60_000, 1.5), // after it: counted again
			line("anthropic", "assistant", now.getTime() - 60_000, 6.25),
			line("mistral", "assistant", now.getTime() - 60_000, 0.2),
		].join("\n") + "\n",
	);
	const cfg = parseConfig(v2Raw);
	const live = new Map([[COPILOT, { ...parseSeatFigure(seatPayload), asOfMs: now.getTime() - 5 * 60_000 }]]);
	const m = await monthSpendAll(cfg, dir, now, live);
	assert.equal(m.get(COPILOT)?.source, "live");
	assert.ok(Math.abs((m.get(COPILOT)?.spend ?? 0) - (156.4 + 1.5)) < 1e-9, `got ${m.get(COPILOT)?.spend}`);
	assert.equal(m.get("anthropic")?.source, "meter");
	assert.ok(Math.abs((m.get("anthropic")?.spend ?? 0) - 6.25) < 1e-9);
	assert.ok(Math.abs((m.get("mistral")?.spend ?? 0) - 0.2) < 1e-9);
});

test("an entry without a cap is tracked but never tiered", () => {
	const c = parseConfig(v2Raw);
	const s = providerStatus(c.providers[1], { spend: 6.46, source: "meter", observationIgnored: false }, "metered");
	assert.equal(s.capUsd, undefined);
	assert.equal(s.pct, undefined);
	assert.equal(s.tier, "ok");
	assert.equal(s.headroomUsd, undefined);
	assert.equal(s.spend, 6.46);
});

test("billingFor derives the shape from the provider and the registry, and config wins", () => {
	const models = [
		{ provider: COPILOT, id: "claude-sonnet-5.5", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
		{ provider: "strata", id: "qwen3.8-flash-next-iq3_s", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		{ provider: "mistral", id: "magistral-medium-latest", cost: { input: 2, output: 5, cacheRead: 0, cacheWrite: 0.6 } },
	];
	assert.equal(billingFor({ provider: COPILOT, thresholds: DEFAULT_THRESHOLDS, reset: "local" }, models), "credits");
	assert.equal(billingFor({ provider: "strata", thresholds: DEFAULT_THRESHOLDS, reset: "local" }, models), "free");
	assert.equal(billingFor({ provider: "mistral", thresholds: DEFAULT_THRESHOLDS, reset: "local" }, models), "metered");
	assert.equal(billingFor({ provider: "strata", thresholds: DEFAULT_THRESHOLDS, reset: "local", billing: "metered" }, models), "metered");
});

test("formatCost labels the three registry shapes apart", () => {
	assert.equal(formatCost({ provider: "mistral", id: "m", cost: { input: 2, output: 5, cacheRead: 0, cacheWrite: 0.6 } }), "$2/$5 per Mtok, cache r0/w0.6");
	assert.equal(formatCost({ provider: "strata", id: "s", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), "no per-token charge");
	assert.equal(formatCost({ provider: "x", id: "x" }), "no per-token charge");
	assert.equal(formatCost(undefined), "price unknown");
});

test("advisorySection carries tiers, not numbers, and only changes at a tier change", () => {
	const statuses = [providerStatus({ provider: COPILOT, monthlyCapUsd: 150, thresholds: DEFAULT_THRESHOLDS, reset: "local" }, { spend: 100, source: "live", observationIgnored: false }, "credits")];
	const later = providerStatus({ provider: COPILOT, monthlyCapUsd: 150, thresholds: DEFAULT_THRESHOLDS, reset: "local" }, { spend: 104, source: "live", observationIgnored: false }, "credits");
	const a = advisorySection(statuses, "strata/qwen", "budget");
	const b = advisorySection([later], "strata/qwen", "budget");
	assert.equal(a, b, "spend moved 18 USD inside one tier band and the text must not change");
	assert.ok(!/%\)/.test(a) && !/\d+\.\d+/.test(a), `no live numbers expected: ${a}`);
	const crossed = advisorySection(
		[providerStatus({ provider: COPILOT, monthlyCapUsd: 150, thresholds: DEFAULT_THRESHOLDS, reset: "local" }, { spend: 151, source: "live", observationIgnored: false }, "credits")],
		"strata/qwen",
		"budget",
	);
	assert.notEqual(a, crossed);
	assert.match(crossed, /copilot credits, over cap/);
	assert.match(crossed, /budget/);
});

test("costTable shows every provider and prices the routes, seat providers by their seat", () => {
	const cfg = parseConfig(v2Raw);
	const statuses = [
		providerStatus(cfg.providers[0], { spend: 151, source: "live", observationIgnored: false }, "credits"),
		providerStatus(cfg.providers[1], { spend: 6.46, source: "meter", observationIgnored: false }, "metered"),
		providerStatus(cfg.providers[2], { spend: 19.9, source: "meter", observationIgnored: false }, "metered"),
	];
	const models = [
		{ provider: COPILOT, id: "claude-sonnet-5.5", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 1_000_000 },
		{ provider: "anthropic", id: "claude-sonnet-5-5", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 1_000_000 },
		{ provider: "mistral", id: "magistral-medium-latest", cost: { input: 2, output: 5, cacheRead: 0, cacheWrite: 0.6 }, contextWindow: 128_000 },
		{ provider: "strata", id: "qwen3.8-flash-next-iq3_s", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 393_216 },
	];
	const routes = buildRoutes(["strata/qwen3.8-flash-next-iq3_s", "anthropic/claude-sonnet-5-5", "mistral/magistral-medium-latest", "github-copilot/claude-sonnet-5.5"], models, statuses, "strata/qwen3.8-flash-next-iq3_s");
	const table = costTable(statuses, routes);
	assert.match(table, /copilot *credits *\$150\.00 *\$151\.00 *101% *over cap *live/);
	assert.match(table, /anthropic *metered *none *\$6\.46 *- *no cap/);
	assert.match(table, /mistral\/magistral-medium-latest *metered *2\/5 *0\/0\.6 *128k/);
	// the local route comes before a route that is over its cap, which is listed last
	assert.ok(table.indexOf("anthropic/claude-sonnet-5-5") < table.indexOf("strata/qwen3.8-flash-next-iq3_s"));
	assert.ok(table.indexOf("strata/qwen3.8-flash-next-iq3_s") < table.indexOf("github-copilot/claude-sonnet-5.5"));
	assert.match(table, /last resort/);
});

test("buildRoutes keeps a reference the registry does not know, priced as unknown", () => {
	const models = [{ provider: "anthropic", id: "claude-sonnet-5-5", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }];
	const routes = buildRoutes(["anthropic/claude-sonnet-5-5", "anthropic/claud-sonnet-5-5"], models, [], "anthropic/claud-sonnet-5-5");
	assert.equal(routes.length, 2);
	const typo = routes.find((r) => r.ref === "anthropic/claud-sonnet-5-5");
	assert.equal(typo?.price, "price unknown");
	assert.match(costTable([], routes), /not in the model registry/);
});

test("rejectReason names the cap and lists open routes so the task can be re-queued", () => {
	const cfg = parseConfig(v2Raw);
	const statuses = [
		providerStatus(cfg.providers[0], { spend: 151, source: "live", observationIgnored: false }, "credits"),
		providerStatus(cfg.providers[1], { spend: 6.46, source: "meter", observationIgnored: false }, "metered"),
	];
	const models = [
		{ provider: "anthropic", id: "claude-sonnet-5-5", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
		{ provider: COPILOT, id: "claude-sonnet-5.5", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
	];
	const routes = buildRoutes(["anthropic/claude-sonnet-5-5", "strata/qwen3.8-flash-next-iq3_s"], models, statuses, "strata/qwen3.8-flash-next-iq3_s");
	const plan = applyDivert({ agent: "worker", model: "github-copilot/claude-sonnet-5.5", task: "a" }, {
		mode: "reject",
		localSubagents: ["scout"],
		subagentRef: "strata/qwen3.8-flash-next-iq3_s",
		tiers: { [COPILOT]: "divert", anthropic: "ok" },
		models,
	});
	const reason = rejectReason(plan, statuses, routes, "strata/qwen3.8-flash-next-iq3_s");
	assert.match(reason, /over the monthly cap on copilot 101%/);
	assert.match(reason, /worker -> github-copilot/);
	assert.match(reason, /anthropic\/claude-sonnet-5-5 \(\$3\/\$15 per Mtok/);
	assert.match(reason, /Local fallback: strata\/qwen3\.8-flash-next-iq3_s/);
	assert.ok(reason.split("\n").length <= 3, "reason stays one paragraph");
});

test("menuModelRefs prefers the configured list, else the agent settings, and dedupes", () => {
	const cfg = parseConfig(v2Raw);
	const overrides = parseAgentOverrideModels({ subagents: { agentOverrides: { oracle: { model: "github-copilot/claude-sonnet-5.5" }, scout: { model: "strata/qwen3.8-flash-next-iq3_s" }, broken: {} } } });
	assert.deepEqual(overrides, ["github-copilot/claude-sonnet-5.5", "strata/qwen3.8-flash-next-iq3_s"]);
	assert.deepEqual(parseAgentOverrideModels(undefined), []);
	assert.deepEqual(parseAgentOverrideModels({ subagents: "nope" }), []);

	const refs = menuModelRefs(cfg, overrides, "strata/qwen3.8-flash-next-iq3_s:xhigh");
	assert.deepEqual(refs, ["strata/qwen3.8-flash-next-iq3_s", "github-copilot/claude-sonnet-5.5"]);

	const pinned = parseConfig({ ...v2Raw, advisory: { models: ["mistral/magistral-medium-latest", "anthropic/claude-sonnet-5-5", "mistral/other"] } });
	assert.deepEqual(menuModelRefs(pinned, overrides, undefined), ["mistral/magistral-medium-latest", "anthropic/claude-sonnet-5-5", "mistral/other"]);
	const tight = parseConfig({ ...v2Raw, advisory: { models: ["a/x", "b/y", "c/z"], maxModels: 2 } });
	assert.deepEqual(menuModelRefs(tight, [], undefined), ["a/x", "b/y"]);
});

// --- out-of-budget detection -------------------------------------------------------------------

const ANTHROPIC_SPEND_LIMIT =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';
const ANTHROPIC_USAGE_LIMIT =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC."}}';

test("classifyExhaustion recognises spend and credit refusals, not rate limits", () => {
	const now = new Date("2026-11-14T12:00:00Z");
	const spend = classifyExhaustion(ANTHROPIC_USAGE_LIMIT, now);
	assert.equal(spend?.reason, "spend limit reached");
	assert.equal(spend?.atMs, now.getTime());
	assert.equal(spend?.untilMs, Date.parse("2026-12-01T00:00:00Z"));

	assert.equal(classifyExhaustion(ANTHROPIC_SPEND_LIMIT, now)?.reason, "credit balance exhausted");
	assert.equal(classifyExhaustion('{"error":{"code":"insufficient_quota"}}', now)?.reason, "quota exhausted");
	assert.equal(classifyExhaustion("429 rate_limit_error: too many requests, retry in 12s", now), undefined);
	assert.equal(classifyExhaustion("Connection error.", now), undefined);
	assert.equal(classifyExhaustion("", now), undefined);
});

test("classifyExhaustion reads an ISO reset instant when the message carries one", () => {
	const ex = classifyExhaustion('{"message":"quota exceeded, resets 2026-12-01T00:00:00Z"}', new Date("2026-11-14T12:00:00Z"));
	assert.equal(ex?.untilMs, Date.parse("2026-12-01T00:00:00Z"));
});

test("exhaustionActive expires at the stated reset, else at the next month boundary", () => {
	const now = new Date("2026-11-14T12:00:00Z");
	const stated = { atMs: now.getTime(), untilMs: Date.parse("2026-12-01T00:00:00Z"), reason: "spend limit reached" };
	assert.equal(exhaustionActive(stated, "utc", new Date("2026-11-30T23:59:00Z")), true);
	assert.equal(exhaustionActive(stated, "utc", new Date("2026-12-01T00:00:01Z")), false);

	// No stated reset: a monthly allowance, so it holds until the next month in that zone.
	const unstated = { atMs: Date.parse("2026-11-14T12:00:00Z"), reason: "quota exhausted" };
	assert.equal(exhaustionActive(unstated, "utc", new Date("2026-11-30T23:00:00Z")), true);
	assert.equal(exhaustionActive(unstated, "utc", new Date("2026-12-01T00:30:00Z")), false);
});

test("an out-of-budget provider is forced to divert even with no cap configured", () => {
	const pb = { provider: "anthropic", thresholds: DEFAULT_THRESHOLDS, reset: "utc" as const };
	const m = { spend: 5.89, source: "meter" as const, observationIgnored: false };
	const now = new Date("2026-11-14T12:00:00Z");
	const ex = classifyExhaustion(ANTHROPIC_USAGE_LIMIT, now);

	const plain = providerStatus(pb, m, "metered", undefined, now);
	assert.equal(plain.tier, "ok");
	assert.equal(plain.exhausted, undefined);

	const hit = providerStatus(pb, m, "metered", ex, now);
	assert.equal(hit.tier, "divert", "a refusal outranks the meter, which still reads 5.89 spent");
	assert.equal(hit.exhausted?.reason, "spend limit reached");
	assert.deepEqual(statusLabel(hit), { text: "anthropic out of budget", color: "error" });
	assert.match(costTable([hit], []), /anthropic +metered +none +\$5\.89 +- +out of budget +meter/);
	assert.match(advisorySection([hit], "strata/local", "budget"), /anthropic metered, out of budget \(spend limit reached\)/);
});

test("a refusal that has expired stops forcing divert", () => {
	const pb = { provider: "anthropic", thresholds: DEFAULT_THRESHOLDS, reset: "utc" as const };
	const m = { spend: 1, source: "meter" as const, observationIgnored: false };
	const ex = { atMs: Date.parse("2026-11-14T12:00:00Z"), untilMs: Date.parse("2026-12-01T00:00:00Z"), reason: "spend limit reached" };
	const after = new Date("2026-12-02T00:00:00Z");
	assert.equal(providerStatus(pb, m, "metered", ex, after).tier, "ok");
});

test("rejectReason says out of budget when the provider refused, and names the reset", () => {
	const now = new Date("2026-11-14T12:00:00Z");
	const pb = { provider: "anthropic", thresholds: DEFAULT_THRESHOLDS, reset: "utc" as const };
	const status = providerStatus(pb, { spend: 5.89, source: "meter", observationIgnored: false }, "metered", classifyExhaustion(ANTHROPIC_USAGE_LIMIT, now), now);
	const plan = applyDivert({ agent: "worker", model: "anthropic/claude-sonnet-5-5", task: "a" }, {
		mode: "reject",
		localSubagents: ["scout"],
		subagentRef: "strata/local",
		tiers: { anthropic: "divert" },
		models: [{ provider: "anthropic", id: "claude-sonnet-5-5" }],
	});
	const reason = rejectReason(plan, [status], [], "strata/local");
	assert.match(reason, /out of budget on anthropic \(spend limit reached\)/);
	assert.match(reason, /worker -> anthropic/);
	assert.match(reason, /Local fallback: strata\/local/);
});

test("usageReport states the refusal above the table", () => {
	const now = new Date("2026-11-14T12:00:00Z");
	const ex = classifyExhaustion(ANTHROPIC_USAGE_LIMIT, now);
	const rows = [{ model: "claude-haiku-5-5", messages: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1 }];
	const out = usageReport("anthropic", rows, "since 2026-11-01 00:00 UTC", undefined, ex);
	assert.match(out, /OUT OF BUDGET: spend limit reached since 2026-11-14T12:00:00\.000Z, back 2026-12-01T00:00:00\.000Z/);
});
