#!/usr/bin/env node
/**
 * Measure how often the confabulated session-opening reasoning block appears.
 *
 * pi-thinking-hygiene removes the blocks from the prompt; it does not change how often the
 * model writes them, and the session file keeps what it wrote. That makes the session files
 * the instrument: count hits over thinking blocks for one model, and the rate before and
 * after a change is comparable.
 *
 * Usage:
 *   node thinking-hygiene-rate.mjs [--since 2026-10-18T16:53:00Z] [--model <name>]
 *
 * `--since` restricts to entries timestamped at or after a moment, which is how a change
 * gets a window: run it once over everything for the baseline, then again with the moment
 * the change landed.
 *
 * `--model` matches a fragment of the `provider/model` recorded in the session file rather
 * than the whole string. The host part names one machine and the quantization suffix changes
 * with the build, so neither belongs in a default: `--model ornith` covers whatever ornith
 * build is on the box, and so does `--model qwen3.8-flash-next`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isConfabulatedThinking, isReplayedThinking } from "./hygiene.ts";

const SESSIONS = join(process.env.HOME, ".pi", "agent", "sessions");
const DEFAULT_MODEL = "qwen3.8-flash-next";

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
}

const since = arg("since", null) ? new Date(arg("since", null)).getTime() : null;
const wantModel = arg("model", DEFAULT_MODEL);
const matchesModel = (model) => model.includes(wantModel);

const files = [];
(function walk(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p);
		else if (e.name.endsWith(".jsonl")) files.push(p);
	}
})(SESSIONS);

const BUCKETS = [50_000, 100_000, 150_000, 200_000, 250_000, 300_000, 400_000];
const byModel = new Map();
const byTool = new Map();
const byBucket = BUCKETS.map((hi, i) => ({ lo: i ? BUCKETS[i - 1] : 0, hi, turns: 0, hits: 0 }));
let sessionsWithHits = 0;
let firstInSession = 0;
let afterToolResult = 0;
let withinThreeTurns = 0;
let allBlocks = 0;

for (const file of files) {
	const entries = [];
	for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			continue;
		}
		if (o.type !== "message") continue;
		if (since !== null && new Date(o.timestamp).getTime() < since) continue;
		entries.push(o.message);
	}
	if (entries.length === 0) continue;

	let assistantIndex = 0;
	let lastHitAt = -1;
	let lastTool = null;
	let hitsHere = 0;

	for (let i = 0; i < entries.length; i++) {
		const m = entries[i];
		if (m.role === "toolResult") {
			lastTool = m.toolName ?? "?";
			continue;
		}
		if (m.role !== "assistant") continue;

		const model = `${m.provider}/${m.model}`;
		const hit = m.content.some((c) => c.type === "thinking" && isReplayedThinking(c) && isConfabulatedThinking(c.thinking));
		const stats = byModel.get(model) ?? { blocks: 0, hits: 0 };
		for (const c of m.content) if (c.type === "thinking") { stats.blocks++; allBlocks++; }
		if (hit) stats.hits++;
		byModel.set(model, stats);

		if (matchesModel(model)) {
			const bucket = byBucket.find((b) => (m.usage?.totalTokens ?? 0) >= b.lo && (m.usage?.totalTokens ?? 0) < b.hi);
			if (bucket) {
				bucket.turns++;
				if (hit) bucket.hits++;
			}
			const tool = lastTool ?? "(no tool result)";
			const t = byTool.get(tool) ?? { turns: 0, hits: 0 };
			t.turns++;
			if (hit) t.hits++;
			byTool.set(tool, t);
			if (entries[i - 1]?.role === "toolResult") afterToolResult++;
		}

		if (hit) {
			hitsHere++;
			if (lastHitAt < 0) firstInSession++;
			else if (assistantIndex - lastHitAt <= 3) withinThreeTurns++;
			lastHitAt = assistantIndex;
		}
		assistantIndex++;
		lastTool = null;
	}
	if (hitsHere > 0) sessionsWithHits++;
}

const target = [...byModel].filter(([m]) => matchesModel(m)).reduce((a, [, v]) => ({ blocks: a.blocks + v.blocks, hits: a.hits + v.hits }), { blocks: 0, hits: 0 });
console.log(`model   ${wantModel} (matched ${[...byModel.keys()].filter(matchesModel).join(", ") || "nothing"})`);
console.log(`corpus  ${files.length} session files, ${allBlocks} thinking blocks across all models`);
console.log(`window  ${since === null ? "all stored sessions" : `since ${new Date(since).toISOString()}`}`);
console.log(`turns   ${byBucket.reduce((n, b) => n + b.turns, 0)}   thinking blocks ${target.blocks}   hits ${target.hits}   rate ${target.blocks ? ((100 * target.hits) / target.blocks).toFixed(2) : "0.00"}%`);
console.log(`shape   ${afterToolResult} immediately after a tool result, ${firstInSession} first in their session, ${withinThreeTurns} within 3 turns of a previous hit`);
console.log(`sessions with at least one hit: ${sessionsWithHits}`);

console.log("\nby prompt size");
for (const b of byBucket) if (b.turns) console.log(`  ${String(b.lo).padStart(6)}-${String(b.hi).padEnd(6)} ${String(b.turns).padStart(5)} turns ${String(b.hits).padStart(3)} hits ${(100 * b.hits) / b.turns > 0 ? ((100 * b.hits) / b.turns).toFixed(2) + "%" : "0%"}`);

console.log("\nby the tool whose result came last");
for (const [tool, v] of [...byTool].filter(([, x]) => x.hits > 0).sort((a, b) => b[1].hits / b[1].turns - a[1].hits / a[1].turns)) {
	console.log(`  ${tool.padEnd(22)} ${String(v.turns).padStart(6)} turns ${String(v.hits).padStart(3)} hits ${((100 * v.hits) / v.turns).toFixed(2)}%`);
}

console.log("\nother models in the same window");
for (const [model, v] of [...byModel].filter(([m, x]) => !matchesModel(m) && x.blocks > 200).sort((a, b) => b[1].blocks - a[1].blocks)) {
	console.log(`  ${model.padEnd(52)} ${String(v.blocks).padStart(6)} blocks ${String(v.hits).padStart(3)} hits`);
}
