// Unit tests for budget-routing. Run from budget-routing/: node --test budget.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { utimes } from "node:fs/promises";
import {
	applyDivert,
	DEFAULT_THRESHOLDS,
	monthSpend,
	monthStartMs,
	parseConfig,
	spendSince,
	tierFor,
} from "./budget.ts";

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
