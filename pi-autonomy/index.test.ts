/**
 * Wiring, not protocol: that the extension listens on the right events, drives the
 * check-in → working → complete/paused state machine, and returns the continuation
 * shapes Pi expects. The decision table itself is covered in protocol.test.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface BoundaryResult {
	continue?: boolean;
	entries?: { type: string; customType: string; content: string; display: boolean }[];
}

interface Stub {
	handlers: Map<string, Handler[]>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	sent: { content: string; options?: Record<string, unknown> }[];
	notices: string[];
	statuses: (string | undefined)[];
	aborted: number;
	setIdle(v: boolean): void;
	ctx: unknown;
	command(args: string): Promise<void>;
	beforeAgentStart(): Promise<Record<string, string>>;
	turnEnd(payload: Record<string, unknown>): Promise<BoundaryResult | undefined>;
	emit(event: string, payload?: Record<string, unknown>): Promise<void>;
}

async function stub(): Promise<Stub> {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const sent: Stub["sent"] = [];
	const notices: string[] = [];
	const statuses: (string | undefined)[] = [];
	let aborted = 0;
	let idle = true;

	const ctx = {
		ui: {
			setStatus(_key: string, v?: string) {
				statuses.push(v);
			},
			notify: (m: string) => notices.push(m),
			theme: { fg: (_c: string, t: string) => t },
		},
		isIdle: () => idle,
		abort: () => {
			aborted += 1;
		},
	};

	const s: Stub = {
		handlers,
		commands,
		sent,
		notices,
		statuses,
		get aborted() {
			return aborted;
		},
		setIdle: (v) => {
			idle = v;
		},
		ctx,
		command(args) {
			const cmd = commands.get("autonomy");
			assert.ok(cmd, "autonomy command registered");
			return cmd.handler(args, ctx);
		},
		async beforeAgentStart() {
			const sections: Record<string, string> = {};
			for (const h of handlers.get("before_agent_start") ?? []) await h({ systemPromptOptions: { sections } }, ctx);
			return sections;
		},
		async turnEnd(payload) {
			const results: (BoundaryResult | undefined)[] = [];
			for (const h of handlers.get("turn_end") ?? []) results.push((await h(payload, ctx)) as BoundaryResult | undefined);
			return results[0];
		},
		async emit(event, payload = {}) {
			for (const h of handlers.get(event) ?? []) await h(payload, ctx);
		},
	};

	// Wire the fake ExtensionAPI.
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(_name, options);
		},
		sendUserMessage(content: string, options?: Record<string, unknown>) {
			sent.push({ content, options });
		},
	};

	const { default: extend } = await import("./index.ts");
	extend(pi as never);

	return s;
}

function textTurn(text: string): Record<string, unknown> {
	return { type: "turn_end", turnIndex: 1, outcome: "completed", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }, toolResults: [] };
}
function toolTurn(name: string, args: unknown): Record<string, unknown> {
	return { type: "turn_end", turnIndex: 1, outcome: "completed", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name, arguments: args }], stopReason: "toolCall" }, toolResults: [] };
}

test("check-in then autonomous completion", async () => {
	const s = await stub();
	await s.emit("session_start");

	await s.command("migrate the database");
	assert.equal(s.sent.length, 1, "check-in message sent");
	assert.ok(s.sent[0].content.includes("[autonomy:ready]"));
	assert.ok((await s.beforeAgentStart())["autonomy"]?.includes("[autonomy:ready]"), "check-in section injected");

	// The model asks nothing and is ready.
	const ready = await s.turnEnd(textTurn("No open questions.\n[autonomy:ready]"));
	assert.equal(ready, undefined, "check-in transition does not itself continue the turn");
	assert.ok((await s.beforeAgentStart())["autonomy"]?.includes("[autonomy:done]"), "working section now injected");

	// The settled check-in run hands off to a fresh working run.
	await s.emit("agent_settled");
	assert.equal(s.sent.length, 2, "work start message sent after settle");
	assert.ok(s.sent[1].content.includes("[autonomy:done]"));
	await s.emit("agent_start");

	// A tool turn proceeds without a forced continuation.
	assert.equal(await s.turnEnd(toolTurn("bash", { command: "npm test" })), undefined);

	// A text-only turn with no marker gets nudged.
	const nudge = await s.turnEnd(textTurn("Still working…"));
	assert.equal(nudge?.continue, true, "forced continuation requested");
	assert.equal(nudge?.entries?.[0]?.display, false, "nudge is hidden from the transcript");

	// The model finishes.
	const done = await s.turnEnd(textTurn("Done, all green.\n[autonomy:done]"));
	assert.equal(done?.continue, undefined, "no continuation after completion");
	assert.equal(done?.entries?.[0]?.display, true, "completion noted in the transcript");
	assert.equal((await s.beforeAgentStart())["autonomy"], undefined, "section removed after completion");
});

test("stall guard pauses after the stall cap, and go resumes", async () => {
	const s = await stub();
	await s.emit("session_start");
	await s.command("now fix the flaky test");
	assert.ok(s.sent[0].content.includes("[autonomy:done]"), "now mode skips the check-in");
	await s.emit("agent_start");

	const first = await s.turnEnd(textTurn("hmm"));
	assert.equal(first?.continue, true);
	const second = await s.turnEnd(textTurn("hmm again"));
	assert.equal(second?.continue, true);
	const third = await s.turnEnd(textTurn("hmm still"));
	assert.equal(third?.continue, undefined, "stall guard stops the continuation");
	assert.equal(third?.entries?.[0]?.display, true, "pause is noted");
	assert.match(s.notices.at(-1) ?? "", /paused/);

	// Resume.
	await s.command("go");
	assert.ok(s.sent.at(-1)?.content.includes("Resume"), "resume message sent");
	assert.ok((await s.beforeAgentStart())["autonomy"]?.includes("[autonomy:done]"), "working section active again");
});

test("repeated tool calls halt the run", async () => {
	const s = await stub();
	await s.emit("session_start");
	await s.command("now retry the build");
	await s.emit("agent_start");
	assert.equal(await s.turnEnd(toolTurn("bash", { command: "make" })), undefined);
	assert.equal(await s.turnEnd(toolTurn("bash", { command: "make" })), undefined);
	const third = await s.turnEnd(toolTurn("bash", { command: "make" }));
	assert.equal(third?.continue, undefined);
	assert.equal(third?.entries?.[0]?.display, true, "repetition pause noted");
	assert.match(s.notices.at(-1) ?? "", /repeated|paused/i);
});

test("stop aborts an in-flight run and clears the section", async () => {
	const s = await stub();
	await s.emit("session_start");
	await s.command("now a long task");
	await s.emit("agent_start");
	s.setIdle(false);
	await s.command("stop");
	assert.equal(s.aborted, 1, "in-flight run aborted");
	assert.equal((await s.beforeAgentStart())["autonomy"], undefined, "section cleared");
	assert.equal(s.sent.length, 1, "no further messages after stop");
});

test("aborted turn ends in a paused state, not a silent one", async () => {
	const s = await stub();
	await s.emit("session_start");
	await s.command("now keep going");
	await s.emit("agent_start");
	const payload = textTurn("…");
	payload.outcome = "aborted";
	const result = await s.turnEnd(payload);
	assert.equal(result?.continue, undefined);
	assert.equal(result?.entries?.[0]?.display, true, "interruption noted");
	assert.match(s.notices.at(-1) ?? "", /paused/);
});

test("start is refused while a session is already active", async () => {
	const s = await stub();
	await s.emit("session_start");
	await s.command("first goal");
	const before = s.sent.length;
	await s.command("second goal");
	assert.equal(s.sent.length, before, "second start ignored");
	assert.match(s.notices.at(-1) ?? "", /already active/);
});

test("a queued working start does not hijack the run that is in flight", async () => {
	const s = await stub();
	await s.emit("session_start");

	// The agent is busy with unrelated work when the user starts the session.
	s.setIdle(false);
	await s.command("now migrate the database");
	assert.equal(s.sent.length, 1, "work start queued");

	// The in-flight run's turns must be left alone: no nudge, no pause.
	const stray = await s.turnEnd(textTurn("Unrelated final summary."));
	assert.equal(stray, undefined, "in-flight run is not governed by the new session");
	assert.equal(s.notices.length, 0);

	// The in-flight run settles, and the session's first run starts.
	await s.emit("agent_settled");
	assert.equal(s.notices.length, 0, "settling an unrelated run does not pause the session");

	// Once the session's own run starts, its turns are governed.
	await s.emit("agent_start");
	const turn = (await s.turnEnd(textTurn("Starting the migration…"))) as { continue?: boolean };
	assert.equal(turn?.continue, true, "the session's own run is governed");
});
