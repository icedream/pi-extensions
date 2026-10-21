/**
 * The inputs are the adapter's own strings, taken from ui-session.ts as released: the notice is
 * appended after the tool result text, so it either ends a text block or sits in one of its own.
 * The table's point is that the fact survives the rewrite and unrelated text is returned by
 * reference, since a later handler composes on whatever this one returns.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isMcpToolName, rewriteContent, rewriteNotices } from "./notices.ts";

const OPEN_NOTICE = "Interactive UI is open. I'll respond to your prompts and intents as you interact with it.";
const UPDATED_NOTICE = "Updated the open UI.";

test("the first-person notice is reworded, the fact kept", () => {
	const result = rewriteNotices(`{"data":{"issues":[]}}\n\n${OPEN_NOTICE}`);
	assert.equal(result.changed, true);
	assert.ok(result.text.includes('{"data":{"issues":[]}}'), "the payload is untouched");
	assert.ok(result.text.includes("Interactive UI is open"));
	assert.ok(!/I'?ll|I will/.test(result.text), result.text);
});

test("notices that already speak impersonally are left alone", () => {
	const KEEP = [
		`${UPDATED_NOTICE}\n\nSomething else.`,
		"Interactive UI was unavailable; returning the tool result inline.",
		"MCP UI window was suppressed. Open manually: http://localhost:7777/x",
	];
	for (const text of KEEP) assert.equal(rewriteNotices(text).changed, false, text);
	assert.equal(rewriteNotices(OPEN_NOTICE).changed, true);
});

test("a result with no notice is returned by reference", () => {
	const content = [{ type: "text", text: '{"data":{"issues":[]}}' }];
	const result = rewriteContent(content);
	assert.equal(result.rewrites, 0);
	assert.equal(result.content, content);
});

test("a notice in its own block is rewritten without touching the payload block", () => {
	const payload = { type: "text", text: '{"data":{"issues":[]}}' };
	const notice = { type: "text", text: OPEN_NOTICE };
	const result = rewriteContent([payload, notice]);
	assert.equal(result.rewrites, 1);
	assert.equal(result.content[0], payload, "untouched blocks keep their identity");
	assert.ok(!/I'?ll/.test(String(result.content[1].text)), JSON.stringify(result.content[1]));
});

test("image blocks and malformed blocks pass through", () => {
	const content = [{ type: "image", data: "AAAA" }, { type: "text" }, null as unknown as { type: string }];
	assert.equal(rewriteContent(content).rewrites, 0);
});

test("only the adapter's tools are considered", () => {
	for (const name of ["mcp", "mcp__atlassian", "mcp__grafana__list_alerts", "mcp-adapter"]) {
		assert.equal(isMcpToolName(name), true, name);
	}
	for (const name of ["bash", "read", "edit", "mcpScript_", "mcpmcp", "notmcp"]) {
		assert.equal(isMcpToolName(name), false, name);
	}
});
