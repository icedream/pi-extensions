// Unit tests for budget-routing. Run from budget-routing/: node --test budget.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { utimes } from "node:fs/promises";
import {
	applyDivert,
	DEFAULT_SEAT,
	DEFAULT_THRESHOLDS,
	monthSpend,
	monthStartMs,
	needsPreSwitchCompaction,
	parseConfig,
	parseSeatFigure,
	spendSince,
	statusLabel,
	tierFor,
} from "./budget.ts";
import { pickGitHubToken } from "./credential.ts";

const line = (provider: string, role: string, timestamp: number, cost: number) =>
	JSON.stringify({ type: "message", message: { role, provider, timestamp, usage: { cost: { total: cost } } } });

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

test("needsPreSwitchCompaction is true only at prepare/divert on the budget provider", () => {
	assert.equal(needsPreSwitchCompaction("prepare", "github-copilot", "github-copilot", false), true);
	assert.equal(needsPreSwitchCompaction("divert", "github-copilot", "github-copilot", false), true);
	for (const tier of ["ok", "nudge", "warn"] as const) {
		assert.equal(needsPreSwitchCompaction(tier, "github-copilot", "github-copilot", false), false);
	}
});

test("needsPreSwitchCompaction skips local models, an unknown session model, and repeat crossings", () => {
	assert.equal(
		needsPreSwitchCompaction("prepare", "llama-server=http://icedream-homepc:11180/qwen3.8-27b", "github-copilot", false),
		false,
	);
	assert.equal(needsPreSwitchCompaction("divert", "llama-server=http://icedream-homepc:11180/qwen3.8-27b", "github-copilot", false), false);
	assert.equal(needsPreSwitchCompaction("prepare", undefined, "github-copilot", false), false);
	assert.equal(needsPreSwitchCompaction("prepare", "github-copilot", "github-copilot", true), false);
	assert.equal(needsPreSwitchCompaction("divert", "github-copilot", "github-copilot", true), false);
});

test("applyDivert rewrites local-eligible launches and blocks the rest", () => {
	const ref = "llama-server=http://x:1/qwen";
	const local = ["scout", "Plan"];

	const single = { agent: "scout", task: "find X" };
	assert.deepEqual(applyDivert(single, local, ref), { rewritten: 1, blocked: [] });
	assert.equal((single as { model?: string }).model, ref);

	const blockedSingle = { agent: "worker", task: "implement" };
	assert.deepEqual(applyDivert(blockedSingle, local, ref), { rewritten: 0, blocked: ["worker"] });
	assert.equal((blockedSingle as { model?: string }).model, undefined);

	const batch = { tasks: [{ agent: "Plan", task: "a" }, { agent: "reviewer", task: "b" }, { task: "no agent" }] };
	const r = applyDivert(batch, local, ref);
	assert.deepEqual(r, { rewritten: 1, blocked: ["reviewer", "(no agent)"] });
	assert.equal(batch.tasks[0].model, ref);
	assert.equal((batch.tasks[1] as { model?: string }).model, undefined);
});

test("applyDivert leaves management actions untouched", () => {
	const status = { action: "status", id: "abc" };
	assert.deepEqual(applyDivert(status, ["scout"], "ref"), { rewritten: 0, blocked: [] });
	assert.equal((status as { model?: string }).model, undefined);
});

const validRaw = {
	provider: "github-copilot",
	monthlyCapUsd: 150,
	localModel: { provider: "llama-server=http://x:1", modelId: "qwen", subagentRef: "llama-server=http://x:1/qwen" },
	localSubagents: ["scout"],
};

test("parseConfig applies default thresholds", () => {
	const c = parseConfig(validRaw);
	assert.deepEqual(c.thresholds, DEFAULT_THRESHOLDS);
	assert.equal(c.monthlyCapUsd, 150);
});

test("parseConfig rejects bad values with a clear message", () => {
	assert.throws(() => parseConfig({ ...validRaw, monthlyCapUsd: 0 }), /monthlyCapUsd must be positive/);
	assert.throws(() => parseConfig({ ...validRaw, thresholds: { warn: 0.9, prepare: 0.5 } }), /non-decreasing/);
	assert.throws(() => parseConfig({ ...validRaw, localSubagents: [] }), /localSubagents/);
	assert.throws(() => parseConfig({ ...validRaw, localModel: undefined }), /localModel is required/);
	assert.throws(() => parseConfig(null), /JSON object/);
});

test("parseConfig validates the observed calibration and defaults usdPerCredit", () => {
	const ok = parseConfig({ ...validRaw, observed: { creditsUsed: 8216, asOf: "2026-10-01T00:00:00Z" } });
	assert.equal(ok.observed?.usdPerCredit, 0.01);
	assert.equal(ok.observed?.asOfMs, Date.parse("2026-10-01T00:00:00Z"));
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
	const r = await monthSpend(cfg, dir, now);
	assert.equal(r.source, "calibrated");
	assert.equal(r.observationIgnored, false);
	assert.ok(Math.abs(r.spend - (82.16 + 1.5)) < 1e-9, `got ${r.spend}`);
});

test("monthSpend: ignores an observation from a previous month", async () => {
	const dir = await tmpSessions();
	const cfg = parseConfig({ ...validRaw, observed: { creditsUsed: 8216, asOf: "2000-01-01T00:00:00Z" } });
	const r = await monthSpend(cfg, dir, new Date());
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
	assert.equal(parseConfig(validRaw).seat, undefined);
	assert.deepEqual(parseConfig({ ...validRaw, seat: {} }).seat, DEFAULT_SEAT);
	assert.deepEqual(parseConfig({ ...validRaw, seat: { refreshMinutes: 60, credential: "gh" } }).seat, {
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

	const r = await monthSpend(cfg, dir, now, live);
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

	const r = await monthSpend(cfg, dir, now, live);
	assert.equal(r.source, "live");
	assert.ok(Math.abs(r.spend - (15640 * 0.02 + 1.5)) < 1e-9, `got ${r.spend}`);
});

test("monthSpend: a live figure from another month falls back to the meter", async () => {
	const dir = await tmpSessions();
	await fs.writeFile(path.join(dir, "s.jsonl"), [line("github-copilot", "assistant", Date.now(), 4)].join("\n") + "\n");
	const cfg = parseConfig(validRaw);
	const stale = { ...parseSeatFigure(seatPayload), asOfMs: new Date(2000, 0, 1).getTime() };
	const r = await monthSpend(cfg, dir, new Date(), stale);
	assert.equal(r.source, "meter");
	assert.equal(r.observationIgnored, true);
	assert.ok(Math.abs(r.spend - 4) < 1e-9, `got ${r.spend}`);
});

test("statusLabel is compact, coloured by tier, and marks estimates", () => {
	assert.deepEqual(statusLabel("github-copilot", 42, "ok", "live"), { text: "copilot 42%", color: "dim" });
	assert.deepEqual(statusLabel("github-copilot", 74, "nudge", "calibrated"), { text: "copilot 74%", color: "accent" });
	assert.deepEqual(statusLabel("github-copilot", 96, "prepare", "live"), { text: "copilot 96% !", color: "warning" });
	assert.deepEqual(statusLabel("github-copilot", 103, "divert", "live"), { text: "copilot 103% over", color: "error" });
	assert.deepEqual(statusLabel("litellm", 70, "warn", "meter"), { text: "litellm ~70%", color: "warning" });
});
