/**
 * Wiring, not matching: that the extension listens on the request-time context transform,
 * returns the shape Pi expects, and reports what it removed. A real session is not needed
 * to check that, and a real session is the only place the transform is honoured.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_THINKING_HYGIENE_CONFIG = join(tmpdir(), "pi-thinking-hygiene-absent-config.json");

type Handler = (event: unknown, ctx: unknown) => { messages?: unknown[] } | undefined;

function stubPi() {
	const handlers = new Map<string, Handler[]>();
	const entries: { type: string; data: unknown }[] = [];
	const notices: string[] = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
		registerCommand() {},
	};
	const ctx = { ui: { setStatus() {}, notify: (m: string) => notices.push(m), theme: { fg: (_c: string, t: string) => t } } };
	return { pi, ctx, entries, notices, handlers };
}

test("the context handler drops the block and reports it", async () => {
	const { pi, ctx, entries, notices, handlers } = stubPi();
	const { default: extend } = await import("./index.ts");
	extend(pi as never);

	const start = handlers.get("session_start");
	assert.ok(start);
	for (const handler of start) await handler({}, ctx);

	const messages = [
		{ role: "user", content: [{ type: "text", text: "do the thing" }] },
		{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "The user hasn't asked anything substantive yet — the last message was just the system instructions block plus a context reminder.",
					thinkingSignature: "reasoning_content",
				},
				{ type: "toolCall", name: "bash", arguments: { command: "pwd" } },
			],
		},
	];

	let cleaned: unknown[] = messages;
	for (const handler of handlers.get("context") ?? []) {
		const result = handler({ type: "context", messages }, ctx);
		assert.ok(result?.messages, "handler must return the replacement transcript");
		cleaned = result.messages;
		assert.deepEqual(cleaned[1], { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "pwd" } }] });
	}

	assert.equal(entries.length, 1);
	assert.deepEqual((entries[0].data as { blocks: number }).blocks, 1);
	assert.equal(notices.length, 1);

	// The cleaned transcript is what the next request carries, so nothing is reported twice.
	for (const handler of handlers.get("context") ?? []) {
		assert.equal(handler({ type: "context", messages: cleaned }, ctx), undefined);
	}
});
