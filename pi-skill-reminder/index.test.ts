/**
 * Wiring: that a skill whose text a compaction dropped earns a notice naming it, that the default mode
 * leaves the file text to the model's own re-read, and that PI_SKILL_RULES=full carries the text itself.
 *
 * The handlers read the session through the stub context, so a test controls both the transcript
 * (`branch`) and the compaction-aware projection (`context`).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

interface StubEntry {
	type: string;
	id: string;
	customType?: string;
	content?: unknown;
	message?: unknown;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-reminder-"));

function skillFile(name: string, body: string, file = "SKILL.md"): string {
	const target = path.join(root, "skills", name, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, body);
	return target;
}

const shortSkill = skillFile("demo-guidelines", "# Demo guidelines\n\nMARKER-TEXT: name the file, not the convention.\n");
const longSkill = skillFile("huge-guidelines", `${"x".repeat(60)}\n`.repeat(2000));
const describedSkill = skillFile("described-guidelines", "---\nname: described-guidelines\ndescription: \"Write commit messages in the imperative mood.\"\n---\n\nBODY-TEXT\n");

function readCall(path: string, id: string): StubEntry {
	return {
		type: "message",
		id,
		message: { role: "assistant", content: [{ type: "toolCall", name: "read", id, arguments: { path } }] },
	};
}

function readResult(id: string, isError = false): StubEntry {
	return { type: "message", id: `${id}-result`, message: { role: "toolResult", toolCallId: id, toolName: "read", isError, content: [] } };
}

function compaction(id: string): StubEntry {
	return { type: "compaction", id };
}

function skillBlock(name: string, location: string): StubEntry {
	return { type: "message", id: `u-${name}`, message: { role: "user", content: [{ type: "text", text: `<skill name="${name}" location="${location}">\nbody\n</skill>` }] } };
}

function stubPi() {
	const handlers = new Map<string, Handler[]>();
	const sent: { customType: string; content: string; details?: unknown; deliverAs?: string }[] = [];
	const notices: string[] = [];
	const commands: { name: string; handler: (args: string, ctx: unknown) => Promise<void> }[] = [];

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendMessage(message: { customType: string; content: string; details?: unknown }, options?: { deliverAs?: string }) {
			sent.push({ ...message, deliverAs: options?.deliverAs });
		},
		registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.push({ name, handler: def.handler });
		},
	};

	function ctxWith(branch: StubEntry[] = [], context: StubEntry[] = branch) {
		return {
			hasUI: false,
			isIdle: () => true,
			sessionManager: {
				getSessionId: () => "stub-session",
				getBranch: () => branch,
				buildContextEntries: () => context,
			},
			ui: { notify: (message: string) => notices.push(message) },
		};
	}

	/** A finished run releases the reloads it queued without delivering. */
	function endRun() {
		for (const handler of handlers.get("agent_end") ?? []) handler({ type: "agent_end" }, ctxWith());
	}

	/** A finished run releases queued reloads; session_start also drops the notices already given. */
	function reset() {
		sent.length = 0;
		endRun();
		for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "resume" }, ctxWith());
	}

	async function fire(event: string, payload: Record<string, unknown>, ctx: unknown) {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
		return results;
	}

	/** A compaction that kept only the entries after the cut, which is what drops the skill text. */
	function compact(branch: StubEntry[], kept: StubEntry[] = []) {
		return fire("session_compact", { type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "threshold", willRetry: false }, ctxWith(branch, kept));
	}

	function agentStart(branch: StubEntry[], kept: StubEntry[] = branch) {
		return fire("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "next" }, ctxWith(branch, kept));
	}

	return { pi, ctxWith, fire, compact, agentStart, sent, notices, commands, reset, endRun };
}

const { default: extend } = await import("./index.ts");
const harness = stubPi();
extend(harness.pi as never);

/** The mode is read from the environment on each call, so a test sets it and restores the default. */
async function withMode(value: string | undefined, run: () => Promise<void>) {
	const previous = process.env.PI_SKILL_RULES;
	if (value === undefined) delete process.env.PI_SKILL_RULES;
	else process.env.PI_SKILL_RULES = value;
	try {
		await run();
	} finally {
		if (previous === undefined) delete process.env.PI_SKILL_RULES;
		else process.env.PI_SKILL_RULES = previous;
	}
}

const stale = (path: string, boundary = "c1") => [readCall(path, `t-${boundary}`), readResult(`t-${boundary}`), compaction(boundary)];

test("a read of something that is not a skill produces no notice", async () => {
	await withMode(undefined, async () => {
		harness.reset();
		await harness.compact([readCall("/repo/src/index.mjs", "t1"), readResult("t1"), compaction("c1")]);
		assert.equal(harness.sent.length, 0, "a plain file read must not produce a notice");
	});
});

test("a failed read produces no notice", async () => {
	await withMode(undefined, async () => {
		harness.reset();
		await harness.compact([readCall("/home/me/.agents/skills/never-loaded/SKILL.md", "t2"), readResult("t2", true), compaction("c1")]);
		assert.equal(harness.sent.length, 0, "a skill whose read failed was never read");
	});
});

test("the default mode names the dropped skill and leaves the re-read to the model", async () => {
	await withMode(undefined, async () => {
		harness.reset();
		await harness.compact(stale(shortSkill));

		assert.equal(harness.sent.length, 1, "one notice for one dropped skill");
		const [first] = harness.sent;
		assert.equal(first.customType, "skill-rules");
		assert.equal(first.deliverAs, "nextTurn", "the notice must reach the next turn, not steer this one");
		assert.ok(first.content.includes(shortSkill), "the notice did not name the file to re-read");
		assert.match(first.content, /Read each applicable file\s+below in full/, "the notice did not ask for a full read of the relevant files");
		assert.match(first.content, /skills that do not apply to this task/, "the notice did not scope the re-read to the task");
		assert.match(first.content, /<read-files>/, "the notice did not name the list the model mistakes for the rules");
		assert.ok(!first.content.includes("MARKER-TEXT"), "the default mode injected the file text");
	});
});

test("the notice states each skill's description so relevance can be judged without opening it", async () => {
	await withMode(undefined, async () => {
		harness.reset();
		await harness.compact(stale(describedSkill));

		const [first] = harness.sent;
		assert.ok(first.content.includes("Write commit messages in the imperative mood."), "the notice omitted the description");
		assert.ok(first.content.includes("read in full:"), "the notice did not give the path to read");
		assert.ok(!first.content.includes("BODY-TEXT"), "the default notice injected the file text");
	});
});

test("one boundary is noticed once, however many runs start on it", async () => {
	await withMode(undefined, async () => {
		harness.reset();
		await harness.compact(stale(shortSkill, "c1"));
		await harness.endRun();
		await harness.agentStart(stale(shortSkill, "c1"), [compaction("c1")]);
		await harness.endRun();
		await harness.compact(stale(shortSkill, "c1"));
		assert.equal(harness.sent.length, 1, `the notice was sent ${harness.sent.length} times for one boundary`);
	});
});

test("a later compaction notices again", async () => {
	await withMode(undefined, async () => {
		harness.reset();
		await harness.compact(stale(shortSkill, "c1"));
		await harness.endRun();
		await harness.compact(stale(shortSkill, "c2"));
		await harness.endRun();
		assert.equal(harness.sent.length, 2, "a new compaction boundary earned no notice");
		assert.ok(harness.sent[1].content.includes(shortSkill), "the second notice did not name the dropped file");
	});
});

test("a skill whose text is still in context is not noticed at all", async () => {
	await withMode(undefined, async () => {
		harness.reset();
		const branch = stale(shortSkill);
		await harness.compact(branch, branch);
		assert.equal(harness.sent.length, 0, "text the model still holds was noticed");
	});
});

test("an expanded skill block counts as text in context", async () => {
	await withMode(undefined, async () => {
		harness.reset();
		const branch = [skillBlock("demo-guidelines", shortSkill), ...stale(shortSkill)];
		await harness.compact(branch, branch.slice(0, 1));
		assert.equal(harness.sent.length, 0, "the invoked skill block already carries the rules");
	});
});

test("PI_SKILL_RULES=full puts the file text into the message itself", async () => {
	await withMode("full", async () => {
		harness.reset();
		await harness.compact(stale(shortSkill));

		const [first] = harness.sent;
		assert.ok(first.content.includes("MARKER-TEXT: name the file, not the convention."), "the reload did not carry the file text");
		assert.ok(first.content.includes(`<skill name="demo-guidelines" location="${shortSkill}">`), "the reload did not use Pi's skill block shape");
		assert.match(first.content, /instead of recalling an earlier read/, "the reload did not forbid answering from recall");
	});
});

test("PI_SKILL_RULES=full stays quiet while the text is still in context", async () => {
	await withMode("full", async () => {
		harness.reset();
		const branch = stale(shortSkill);
		await harness.compact(branch, branch);
		await harness.compact(branch, branch);
		assert.equal(harness.sent.length, 0, "text the model holds was injected twice");
	});
});

test("PI_SKILL_RULES=full cuts an oversized file and says where to resume reading", async () => {
	await withMode("full", async () => {
		harness.reset();
		await harness.compact(stale(longSkill));

		const [first] = harness.sent;
		assert.ok(first.content.includes("[truncated: lines"), "an oversized skill was injected whole or without a marker");
		assert.match(first.content, /offset=\d+/, "the truncation note must say where to resume reading");
		assert.ok(first.content.length < 60_000, `the injected text grew past the cap: ${first.content.length}`);
	});
});

test("PI_SKILL_RULES=off stays silent", async () => {
	await withMode("off", async () => {
		harness.reset();
		const started = (await harness.agentStart(stale(shortSkill), [compaction("c1")])) as { message?: unknown }[];
		assert.equal(harness.sent.length, 0, "off mode queued a message");
		assert.ok(!started.some((r) => r?.message), "off mode injected a message");
	});
});

test("a run that starts on dropped text gets the notice inside that run", async () => {
	await withMode(undefined, async () => {
		harness.reset();
		const results = (await harness.agentStart(stale(shortSkill), [compaction("c1")])) as { message?: { content: string } }[];

		const injected = results.find((r) => r?.message)?.message;
		assert.ok(injected, "before_agent_start returned nothing for a dropped skill");
		assert.ok(injected.content.includes(shortSkill), "the injected message did not name the file");
	});
});

test("a read of a nested skill file is tracked too", async () => {
	await withMode(undefined, async () => {
		harness.reset();
		const nested = skillFile("nested-guidelines", "# Inner\n\nINNER-MARKER\n", "guides/deep/inner.md");
		await harness.compact(stale(nested));
		assert.ok(harness.sent[0].content.includes(nested), "a nested skill file was not noticed");
	});
});

test("/skills-loaded separates text in context from text the compaction dropped", async () => {
	await withMode(undefined, async () => {
		harness.reset();
		const command = harness.commands.find((c) => c.name === "skills-loaded");
		assert.ok(command, "the /skills-loaded command is not registered");
		await command.handler("", harness.ctxWith(stale(shortSkill), [compaction("c1")]));

		assert.match(harness.notices[harness.notices.length - 1], /demo-guidelines: text dropped by compaction/);
	});
});

test("/skills-reload carries the text even in the default mode", async () => {
	await withMode(undefined, async () => {
		harness.reset();
		const command = harness.commands.find((c) => c.name === "skills-reload");
		assert.ok(command, "the /skills-reload command is not registered");
		await command.handler("", harness.ctxWith(stale(shortSkill), [compaction("c1")]));

		assert.match(harness.sent[harness.sent.length - 1].content, /MARKER-TEXT/);
	});
});

test("/skills-reload force re-reads a skill whose text is still in context", async () => {
	await withMode(undefined, async () => {
		harness.reset();
		const branch = stale(shortSkill);
		const command = harness.commands.find((c) => c.name === "skills-reload");
		assert.ok(command, "the /skills-reload command is not registered");
		await command.handler("force", harness.ctxWith(branch, branch));

		assert.match(harness.sent[harness.sent.length - 1].content, /MARKER-TEXT/);
	});
});
