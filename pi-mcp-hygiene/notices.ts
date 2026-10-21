/**
 * pi-mcp-hygiene: rewrite the MCP adapter's own status sentence out of the model's tool result.
 *
 * The adapter appends a notice to every tool result that opened an interactive UI, and one
 * variant speaks as the agent: "Interactive UI is open. I'll respond to your prompts and intents
 * as you interact with it." That text lands in the model's context as a first-person voice it did
 * not produce, next to other unlabelled additions (the memory block, a compaction summary). A
 * local reasoning model was seen attributing unrelated text in its own prompt to an outside party
 * after turns that carried this notice.
 *
 * Pi's `tool_result` handlers run after the tool produced its result and compose, so the fact is
 * kept and only its voice changes: the result still says a UI is open, and the transcript keeps
 * the reworded form rather than a gap.
 */

const NOTICE_REWRITES: { match: RegExp; replacement: string }[] = [
	{
		match: /Interactive UI is open[.\s]+I'?ll respond to your prompts and intents as you interact with it\.?/i,
		replacement: "Interactive UI is open; follow-up input may arrive from it.",
	},
	{
		match: /Updated the open UI[.\s]+I'?ll respond to your prompts and intents as you interact with it\.?/i,
		replacement: "Updated the open UI; follow-up input may arrive from it.",
	},
];

/** Reword the adapter notices in one text block. `changed` is false when the text is returned untouched. */
export function rewriteNotices(text: string): { text: string; changed: boolean } {
	let out = text;
	for (const { match, replacement } of NOTICE_REWRITES) out = out.replace(match, replacement);
	return { text: out, changed: out !== text };
}

/** The adapter's own tool surface: the proxy tool and the direct `mcp__…` tools it registers. */
export function isMcpToolName(name: string): boolean {
	return name === "mcp" || name.startsWith("mcp__") || name.startsWith("mcp-");
}

interface TextLike {
	type?: string;
	text?: string;
}

/** Apply `rewriteNotices` across a tool result's content, returning the input by reference when nothing matched. */
export function rewriteContent<T extends TextLike>(content: T[]): { content: T[]; rewrites: number } {
	let rewrites = 0;
	const out = content.map((block) => {
		if (!block || block.type !== "text" || typeof block.text !== "string") return block;
		const result = rewriteNotices(block.text);
		if (!result.changed) return block;
		rewrites++;
		return { ...block, text: result.text };
	});
	return rewrites === 0 ? { content, rewrites } : { content: out, rewrites };
}
