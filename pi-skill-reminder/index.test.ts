/**
 * Wiring: that a read of a skill file is recorded, that a compaction sends the reminder once per
 * changed set, and that a resume rebuilds the set from the transcript.
 *
 * The skill set lives at module scope in the extension, so one harness is shared and the tests are
 * cumulative in file order.
 */

import assert from "node:assert/strict";
import test from "node:test";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

function stubPi() {
	const handlers = new Map<string, Handler[]>();
	const sent: { customType: string; content: string; deliverAs?: string }[] = [];
	const notices: string[] = [];
	const commands: { name: string; handler: (args: string, ctx: unknown) => Promise<void> }[] = [];

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendMessage(message: { customType: string; content: string }, options?: { deliverAs?: string }) {
			sent.push({ ...message, deliverAs: options?.deliverAs });
		},
		registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.push({ name, handler: def.handler });
		},
	};

	function ctxWith(branch: unknown[] = []) {
		return {
			sessionManager: { getBranch: () => branch },
			ui: { notify: (message: string) => notices.push(message) },
		};
	}

	async function fire(event: string, payload: Record<string, unknown>, ctx: unknown) {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	}

	function compact(ctx: unknown = ctxWith(), reason = "threshold") {
		return fire("session_compact", { type: "session_compact", compactionEntry: {}, fromExtension: false, reason, willRetry: false }, ctx);
	}

	function read(path: string, isError = false) {
		return fire("tool_result", { type: "tool_result", toolName: "read", isError, input: { path }, content: [] }, ctxWith());
	}

	return { pi, ctxWith, fire, compact, read, sent, notices, commands };
}

const { default: extend } = await import("./index.ts");
const harness = stubPi();
extend(harness.pi as never);

test("a read of something that is not a skill records nothing", async () => {
	await harness.read("/repo/src/index.mjs");
	await harness.compact();
	assert.equal(harness.sent.length, 0, "a plain file read must not produce a reminder");
});

test("a failed read records nothing", async () => {
	await harness.read("/home/me/.agents/skills/never-loaded/SKILL.md", true);
	await harness.compact();
	assert.equal(harness.sent.length, 0, "a skill whose read failed is not a skill that was read");
});

test("a skill read is named after the compaction", async () => {
	await harness.read("/home/me/.agents/skills/no-ai-slop/SKILL.md");
	await harness.compact();

	assert.equal(harness.sent.length, 1, "one reminder for the one set that changed");
	const [first] = harness.sent;
	assert.equal(first.customType, "skill-reminder");
	assert.equal(first.deliverAs, "nextTurn", "the reminder must reach the next turn, not steer this one");
	assert.match(first.content, /no-ai-slop: skills\/no-ai-slop\/SKILL\.md/);
	assert.ok(!first.content.includes("/home/me"), "the reminder must not carry absolute paths");
});

test("an unchanged set does not repeat the reminder", async () => {
	await harness.compact();
	await harness.compact({}, "manual");
	assert.equal(harness.sent.length, 1, "the same set must not send a second message");
});

test("a skill read later joins the reminder", async () => {
	await harness.read("/repo/.pi/skills/go-code/SKILL.md");
	await harness.compact();

	const last = harness.sent[harness.sent.length - 1];
	assert.equal(harness.sent.length, 2);
	assert.match(last.content, /no-ai-slop/);
	assert.match(last.content, /go-code/);
});

test("a resumed session rebuilds the set from its transcript", async () => {
	const branch = [
		{ type: "compaction", id: "c1", summary: "earlier work", firstKeptEntryId: null, tokensBefore: 10 },
		{
			type: "message",
			id: "m1",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: "read", arguments: { path: "/home/me/.agents/skills/tdd/SKILL.md" }, id: "t1" }],
			},
		},
		{
			type: "message",
			id: "m2",
			message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls skills/tdd/SKILL.md" }, id: "t2" }] },
		},
		{ type: "custom", id: "x1", customType: "other" },
	];

	await harness.fire("session_start", { type: "session_start", reason: "resume" }, harness.ctxWith(branch));
	await harness.compact(harness.ctxWith(branch));

	const last = harness.sent[harness.sent.length - 1];
	assert.match(last.content, /tdd: skills\/tdd\/SKILL\.md/);
});

test("/skills-loaded reports the set", async () => {
	await harness.commands[0].handler("", harness.ctxWith());
	assert.equal(harness.commands[0].name, "skills-loaded");
	assert.ok(harness.notices.some((n) => n.includes("tdd:")), "the command prints the skills read so far");
});
