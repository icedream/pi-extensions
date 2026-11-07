/**
 * The working-phase decision table and its helpers. The table is the entire runaway
 * protection of the extension, so it gets a full sweep: markers, signatures, loop
 * detection, and every branch of decideWorkingTurn.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	DONE_MARKER,
	type AutonomyConfig,
	type HaltReason,
	type WorkingState,
	DEFAULT_CONFIG,
	READY_MARKER,
	checkinMessage,
	decideWorkingTurn,
	endsWithMarker,
	freshWorkingState,
	haltReasons,
	nudgeMessage,
	RepeatDetector,
	resumeMessage,
	stableStringify,
	systemPromptSection,
	toolCallSignature,
	usageText,
	workStartMessage,
} from "./protocol.ts";

test("the marker counts only at the end of the message", () => {
	assert.equal(endsWithMarker(`All done.\n${DONE_MARKER}`, DONE_MARKER), true, "own final line");
	assert.equal(endsWithMarker(`summary ${DONE_MARKER}\n`, DONE_MARKER), true, "final line, trailing newline");
	assert.equal(endsWithMarker(`done ${DONE_MARKER.toUpperCase()}`, DONE_MARKER), true, "case-insensitive");
	assert.equal(endsWithMarker(`I will emit ${DONE_MARKER} when finished.`, DONE_MARKER), false, "quoted mid-prose");
	assert.equal(endsWithMarker(`use ${DONE_MARKER}\nmore text follows`, DONE_MARKER), false, "text after the marker");
	assert.equal(endsWithMarker("no marker at all", DONE_MARKER), false);
	assert.equal(endsWithMarker("", DONE_MARKER), false, "empty message");
	assert.equal(endsWithMarker(`ready\n${READY_MARKER}`, READY_MARKER), true, "ready marker on its own line");
});

test("stableStringify ignores key order and truncates deterministically", () => {
	assert.equal(stableStringify({ a: 1, b: [2, 3] }), stableStringify({ b: [2, 3], a: 1 }));
	assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
	const long = "x".repeat(3000);
	const a = stableStringify({ v: long + "A" });
	const b = stableStringify({ v: long + "B" });
	assert.equal(a, b, "differences beyond the cap collapse (accepted) — signatures are loop hints, not hashes");
	const c = stableStringify({ v: "x".repeat(3000) + "A" });
	const d = stableStringify({ v: "y".repeat(3000) + "B" });
	assert.notEqual(c, d, "differences inside the cap survive truncation");
	assert.ok(a.endsWith("…"), "truncation is marked");
	assert.equal(a, stableStringify({ v: long + "A" }), "deterministic");
	assert.equal(stableStringify({ broken: { cycle: 1 } }), stableStringify({ broken: { cycle: 1 } }), "same shape, same string");
});

test("toolCallSignature folds argument key order", () => {
	assert.equal(toolCallSignature("bash", { command: "npm test", timeout: 30 }), toolCallSignature("bash", { timeout: 30, command: "npm test" }));
	assert.notEqual(toolCallSignature("bash", { command: "npm test" }), toolCallSignature("bash", { command: "npm run lint" }));
	assert.notEqual(toolCallSignature("bash", {}), toolCallSignature("read", {}));
});

test("RepeatDetector trips on runs and tight cycles", () => {
	const d = new RepeatDetector(3);
	assert.equal(d.add("A"), false);
	assert.equal(d.add("A"), false);
	assert.equal(d.add("A"), true, "AAA trips on the third");

	const c2 = new RepeatDetector(3);
	for (const s of ["A", "B", "A"]) assert.equal(c2.add(s), false);
	assert.equal(c2.add("B"), true, "ABAB trips on the fourth");

	const c3 = new RepeatDetector(3);
	for (const s of ["A", "B", "C", "A", "B"]) assert.equal(c3.add(s), false);
	assert.equal(c3.add("C"), true, "ABCABC trips on the sixth");

	const ok = new RepeatDetector(3);
	for (const s of ["A", "B", "C", "A", "B", "D"]) assert.equal(ok.add(s), false, "no 3-cycle");

	const reset = new RepeatDetector(3);
	reset.add("A");
	reset.add("A");
	reset.reset();
	assert.equal(reset.add("A"), false, "reset clears the window");
});

const cfg: AutonomyConfig = { ...DEFAULT_CONFIG, maxMinutes: 60 };
const text = (t: string) => ({ kind: "text", text: t } as const);
const tools = (...sigs: string[]) => ({ kind: "tool", signatures: sigs } as const);

test("decideWorkingTurn: aborted and error halt immediately", () => {
	let state = freshWorkingState(cfg);
	assert.deepEqual(decideWorkingTurn(state, cfg, "aborted", text("anything"), "goal", 0), { action: "halt", reason: "aborted" });
	state = freshWorkingState(cfg);
	assert.deepEqual(decideWorkingTurn(state, cfg, "error", tools("A"), "goal", 0), { action: "halt", reason: "error" });
});

test("decideWorkingTurn: tool turns proceed and reset the stall", () => {
	const state = freshWorkingState(cfg);
	const first = decideWorkingTurn(state, cfg, "completed", tools("A"), "goal", 0);
	assert.deepEqual(first, { action: "proceed" });
	state.stallTurns = 1;
	assert.equal(decideWorkingTurn(state, cfg, "completed", tools("B"), "goal", 0).action, "proceed");
	assert.equal(state.stallTurns, 0, "a tool turn clears the stall streak");
	assert.equal(state.turns, 2);
});

test("decideWorkingTurn: repeated tool calls halt the run", () => {
	const state = freshWorkingState(cfg);
	assert.equal(decideWorkingTurn(state, cfg, "completed", tools("A"), "goal", 0).action, "proceed");
	assert.equal(decideWorkingTurn(state, cfg, "completed", tools("A"), "goal", 0).action, "proceed");
	assert.deepEqual(decideWorkingTurn(state, cfg, "completed", tools("A"), "goal", 0), { action: "halt", reason: "repeated-tool-calls" });
});

test("decideWorkingTurn: the done marker completes even after a stalled run", () => {
	const state = freshWorkingState(cfg);
	state.stallTurns = cfg.maxStallTurns; // one more text turn would halt
	assert.deepEqual(decideWorkingTurn(state, cfg, "completed", text(`summary\n${DONE_MARKER}`), "goal", 0), { action: "complete" });
});

test("decideWorkingTurn: text-only turns nudge up to the stall cap, then halt", () => {
	const state: WorkingState = freshWorkingState(cfg);
	const goal = "ship it";
	const first = decideWorkingTurn(state, cfg, "completed", text("thinking out loud"), goal, 0);
	assert.equal(first.action, "nudge");
	assert.equal(state.continuations, 1);
	assert.equal(state.stallTurns, 1);
	assert.ok(first.action === "nudge", `expected a nudge, got ${first.action}`);
	assert.ok(first.text.includes("forced continuation 1 of 40"), first.text);

	const second = decideWorkingTurn(state, cfg, "completed", text("more thinking"), goal, 0);
	assert.equal(second.action, "nudge", "second consecutive text turn still nudged (cap is 2)");
	assert.equal(state.stallTurns, 2);

	assert.deepEqual(decideWorkingTurn(state, cfg, "completed", text("still thinking"), goal, 0), {
		action: "halt",
		reason: "max-stall-turns",
	});
});

test("decideWorkingTurn: the continuation cap halts before the next nudge", () => {
	const c: AutonomyConfig = { ...cfg, maxContinuations: 2 };
	const state = freshWorkingState(c);
	state.continuations = 2;
	assert.deepEqual(decideWorkingTurn(state, c, "completed", text("no marker"), "goal", 0), { action: "halt", reason: "max-continuations" });
});

test("decideWorkingTurn: the wall clock halts on both kinds of turns", () => {
	const state = freshWorkingState(cfg);
	assert.deepEqual(decideWorkingTurn(state, cfg, "completed", tools("A"), "goal", (cfg.maxMinutes + 1) * 60_000), {
		action: "halt",
		reason: "max-time",
	});
	const state2 = freshWorkingState(cfg);
	assert.deepEqual(decideWorkingTurn(state2, cfg, "completed", text("no marker"), "goal", (cfg.maxMinutes + 1) * 60_000), {
		action: "halt",
		reason: "max-time",
	});
});

test("the nudge names the budget and the marker", () => {
	const nudge = nudgeMessage("the goal", 3, 40);
	assert.ok(nudge.includes("forced continuation 3 of 40"));
	assert.ok(nudge.includes(DONE_MARKER));
	assert.ok(nudge.includes("the goal"));
});

test("the messages and system sections carry the right markers", () => {
	assert.ok(checkinMessage("g").includes(READY_MARKER));
	assert.ok(!checkinMessage("g").includes(DONE_MARKER), "check-in never pre-empts completion");
	assert.ok(workStartMessage("g").includes(DONE_MARKER));
	assert.ok(resumeMessage("g").includes(DONE_MARKER));
	assert.ok(systemPromptSection("checkin", "g").includes(READY_MARKER));
	assert.ok(!systemPromptSection("checkin", "g").includes(DONE_MARKER));
	assert.ok(systemPromptSection("working", "g").includes(DONE_MARKER));
	assert.ok(!systemPromptSection("working", "g").includes(READY_MARKER));
});

test("halt reasons and usage text name the configured values, not the defaults", () => {
	const HALT_REASONS_EXPECTED: HaltReason[] = ["aborted", "error", "max-continuations", "max-stall-turns", "repeated-tool-calls", "max-time"];
	const configured: AutonomyConfig = { maxContinuations: 5, maxStallTurns: 1, repeatLimit: 4, maxMinutes: 360 };
	const reasons = haltReasons(configured);
	assert.match(reasons["max-continuations"], /cap of 5/);
	assert.match(reasons["max-stall-turns"], /2 consecutive turns/, "the halting turn is maxStallTurns + 1");
	assert.match(reasons["repeated-tool-calls"], /repeated 4 times/);
	assert.match(reasons["max-time"], /360-minute/);
	assert.equal(reasons.aborted, "interrupted", "reasons that carry no budget stay fixed");
	assert.deepEqual(Object.keys(reasons).sort(), [...HALT_REASONS_EXPECTED].sort(), "every HaltReason has text");

	const usage = usageText(configured);
	for (const value of ["5", "1", "4", "360"]) assert.ok(usage.includes(value), `usage mentions ${value}`);
	assert.ok(usage.includes(DONE_MARKER));
	assert.ok(!usage.includes(String(DEFAULT_CONFIG.maxContinuations)), "the default is not baked in");
});
