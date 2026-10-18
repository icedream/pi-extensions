/**
 * The positives are the openings of real blocks, taken from 36 assistant turns across seven
 * sessions, all on one model (Qwen 3.8 Flash Next, thinking
 * level xhigh, 8k to 325k token prompts). They are the model's own boilerplate, so they read
 * alike; the point of the table is that the matcher catches every phrasing that was actually
 * produced without reaching past it into reasoning that merely mentions the same words.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isConfabulatedThinking, isReplayedThinking, stripConfabulatedThinking, type MessageLike, type ThinkingBlockLike } from "./hygiene.ts";

const CONFABULATED = [
	"The user hasn't asked anything substantive yet — the last message was just the system instructions block plus a context reminder.",
	"The user hasn't asked anything substantive yet — the last message was just system instructions plus a system-reminder with context (email, date).",
	"The user hasn't asked anything substantive yet — the last message was just the system instructions preamble (\"You are an expert software engineer.\").",
	"The user hasn't asked anything substantive yet — the last message was just the system instructions block plus the deferred tools listing.",
	"The user hasn't asked anything substantive yet — the last turn was just system instructions being acknowledged.",
	"The user hasn't asked anything substantive yet — the conversation consists of system instructions and a system reminder with context.",
	"The user hasn't asked anything substantive yet. The system prompt sets up the environment, and there's a system reminder.",
	"The user hasn't actually asked a question yet. The system prompt contains instructions and context.",
	"The user hasn't asked a question yet — the message is just system instructions plus context.",
	"The user hasn't asked a question yet. The system prompt sets up the environment and instructions.",
	"The user has sent a system prompt setup with instructions, and the \"user\" turn is essentially just the environment/context setup with no actual question asked.",
	"The user has sent a system prompt setup with instructions, and the last message appears to be an empty or minimal prompt.",
	"The user has sent a system prompt setup with instructions, and the last message appears to be just an acknowledgment.",
	"So the user has sent a system prompt setup and an acknowledgment. There was no actual prior thinking content.",
	"So the user has sent a system prompt setup and my previous turn was just an acknowledgment \"Understood. I will follow these instructions.\"",
	"The user sent a system reminder with context, then presumably the environment. There was no actual task.",
	"The user's message appears to contain only system instructions and context, with no actual task or question.",
	"The user's turn appears to be just system context (email, date) with no actual question or request.",
];

test("every phrasing the model actually produced is recognised", () => {
	for (const thinking of CONFABULATED) {
		assert.equal(isConfabulatedThinking(thinking), true, thinking);
	}
});

test("reasoning about the schema stays in the prompt", () => {
	const KEEP = [
		"The user wants me to investigate why the model sometimes replied with \"The user has sent a system prompt setup with instructions, and the user turn is essentially just the environment/context setup with no actual question asked.\"",
		"The user asked why the system prompt is rebuilt on every turn; check where Pi folds the tool deltas.",
		"The user hasn't asked for tests here, but the repository convention wants them, so add one.",
		"The user's message is a follow-up on the compaction summary: they want the second PR split further.",
	];
	for (const thinking of KEEP) {
		assert.equal(isConfabulatedThinking(thinking), false, thinking);
	}
});

test("only blocks Pi would replay are candidates", () => {
	assert.equal(isReplayedThinking({ type: "thinking", thinking: "x", thinkingSignature: "reasoning_content" }), true);
	assert.equal(isReplayedThinking({ type: "thinking", thinking: "x", thinkingSignature: "reasoning" }), true);
	assert.equal(isReplayedThinking({ type: "thinking", thinking: "x", thinkingSignature: "reasoning_text" }), true);
	assert.equal(isReplayedThinking({ type: "thinking", thinking: "x" }), false);
	assert.equal(isReplayedThinking({ type: "thinking", thinking: "x", thinkingSignature: "opaque-base64-blob" }), false);
});

function thinking(signature = "reasoning_content"): ThinkingBlockLike {
	return { type: "thinking", thinking: CONFABULATED[0], thinkingSignature: signature };
}

test("a block is removed from a message that has other content", () => {
	const messages = [
		{ role: "assistant", content: [thinking(), { type: "toolCall", name: "bash" }, { type: "text", text: "on it" }] },
	] as MessageLike[];
	const result = stripConfabulatedThinking(messages);
	assert.equal(result.stripped, 1);
	assert.equal(result.dropped, 0);
	assert.deepEqual(result.messages[0].content, [{ type: "toolCall", name: "bash" }, { type: "text", text: "on it" }]);
});

test("a message that was only the block goes with it", () => {
	const messages = [{ role: "assistant", content: [thinking()] }] as MessageLike[];
	const result = stripConfabulatedThinking(messages);
	assert.equal(result.stripped, 1);
	assert.equal(result.dropped, 1);
	assert.equal(result.openings.length, 1);
	assert.ok(result.openings[0].startsWith("The user hasn't asked anything substantive yet"));
	assert.ok(result.openings[0].length <= 120);
	assert.deepEqual(result.messages, []);
});

test("an unreplayed block survives even when the text matches", () => {
	const messages = [{ role: "assistant", content: [thinking("opaque-base64-blob")] }] as MessageLike[];
	const result = stripConfabulatedThinking(messages);
	assert.equal(result.stripped, 0);
	assert.equal(result.messages, messages);
});

test("an unchanged transcript is returned by reference", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "do the thing" }] },
		{ role: "assistant", content: [{ type: "thinking", thinking: "the user asked for the thing; run the build", thinkingSignature: "reasoning_content" }] },
	] as MessageLike[];
	assert.equal(stripConfabulatedThinking(messages).messages, messages);
});

test("extra patterns widen the opening without dropping the other two conditions", () => {
	const thinking_ = "Nothing to do here — the system prompt was acknowledged already, so there is no task to perform.";
	assert.equal(isConfabulatedThinking(thinking_), false);
	assert.equal(isConfabulatedThinking(thinking_, [/^nothing to do here/i]), true);
	assert.equal(isConfabulatedThinking("Nothing to do here — the tests are green.", [/^nothing to do here/i]), false);
});

test("a block that reads an odd prompt honestly is left alone", () => {
	// A real turn: the message did ask for an email analysis and really did carry no email.
	const thinking_ =
		"The user sent a system reminder with context about the email, then an instruction that says \"Analyze the email\". But there's no actual email content provided. I should ask for it.";
	assert.equal(isConfabulatedThinking(thinking_), false);
});
