/**
 * pi-thinking-hygiene: keep confabulated reasoning out of the prompt.
 *
 * A local reasoning model sometimes opens a turn by announcing that the conversation is
 * nothing but a system-prompt setup with no question in it, and that its previous turn was
 * a bare acknowledgment. Neither is true: it has recited a session-opening schema from its
 * training data. The rest of the turn is fine, the tool calls that follow are correct, so
 * the artifact stays inside the reasoning channel.
 *
 * It persists because Pi replays prior thinking back to the model as `reasoning_content`.
 * Once one such block is in the transcript, the next turns read it as their own prior
 * reasoning and continue it: six turns in a row were observed in one session.
 *
 * Pi renders the non-conversational parts of a session as user turns that carry no request,
 * the memory block, a compaction summary, a branch summary, and that is the affordance the
 * schema expects. Not a bug to fix here, only the reason the schema is reachable.
 *
 * So this module answers one question: is this thinking block the recited schema?
 */

/** Thinking blocks Pi replays to the provider as plain text, keyed by `thinkingSignature`. */
const REPLAYED_SIGNATURES = new Set(["reasoning", "reasoning_content", "reasoning_text"]);

/**
 * The recited opening, asserted about the current turn. Each pattern is anchored so that
 * reasoning *about* the schema, which quotes it or diagnoses it, stays in the prompt.
 */
const OPEN_ASSERT: RegExp[] = [
	/^(?:So )?the user(?:'s (?:message|turn))? (?:hasn'?t|doesn'?t) (?:actually )?(?:asked|given|provided)/i,
	/^(?:So )?the user (?:has )?sent a system (?:prompt|reminder)/i,
	/^(?:So )?the user's (?:message|turn) appears? to (?:contain|be) (?:only|just)/i,
	/^(?:So )?the user(?:'s (?:message|turn))? (?:is|was) (?:just|only|essentially)/i,
];

/** The schema always names the prompt as the thing it is reading. */
const SETUP_REF = /system (?:prompt|instructions?|context|reminder)|environment\/context setup|environment and instructions/i;

/**
 * ...and it always lands on the same two claims: the turn carries no request, or there was
 * no reasoning before it worth continuing. A block that genuinely reads an odd prompt, one
 * that really is missing what it asks for, reasons about what to do next instead and does
 * not land here.
 */
const NOTHING_TO_ACT_ON: RegExp[] = [
	/hasn'?t (?:actually )?asked/i,
	/no actual [^.\n]{0,24}?(?:question|task|request|query|prompt|thinking|reasoning)/i,
	/nothing substantive/i,
	/appears? to (?:be (?:just|only|an? empty)|contain only)/i,
	/no task to /i,
	/no (?:real|substantive|meaningful|extended|detailed|prior) (?:reasoning|thinking)/i,
	/my previous turn (?:was|had|produced)/i,
];

export interface ThinkingBlockLike {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
}

export interface MessageLike {
	role: string;
	content?: unknown;
}

/** Would Pi send this block back to the model as text on the next request? */
export function isReplayedThinking(block: ThinkingBlockLike): boolean {
	return typeof block.thinkingSignature === "string" && REPLAYED_SIGNATURES.has(block.thinkingSignature);
}

/** Is this reasoning the recited session-opening schema rather than reasoning about the turn? */
export function isConfabulatedThinking(thinking: string, extraPatterns: RegExp[] = []): boolean {
	const opening = thinking.trimStart();
	if (!OPEN_ASSERT.some((pattern) => pattern.test(opening)) && !extraPatterns.some((pattern) => pattern.test(opening))) {
		return false;
	}
	return SETUP_REF.test(opening) && NOTHING_TO_ACT_ON.some((pattern) => pattern.test(opening));
}

export interface StripResult<T> {
	messages: T[];
	/** Blocks removed, and messages dropped whole because nothing else was in them. */
	stripped: number;
	dropped: number;
	/** First line of each removed block, for reporting what was taken out. */
	openings: string[];
}

/**
 * Remove the recited blocks from the transcript Pi is about to send. An assistant message
 * left with nothing but a removed block goes too: it carried no text and no tool calls, so
 * nothing downstream refers to it. Everything else is returned by reference, unchanged.
 */
export function stripConfabulatedThinking<T extends MessageLike>(messages: T[], extraPatterns: RegExp[] = []): StripResult<T> {
	let stripped = 0;
	let dropped = 0;
	let changed = false;
	const openings: string[] = [];
	const out: T[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			out.push(message);
			continue;
		}
		const content = message.content as ThinkingBlockLike[];
		const kept = content.filter(
			(block) => !(block && block.type === "thinking" && isReplayedThinking(block) && isConfabulatedThinking(block.thinking, extraPatterns)),
		);
		if (kept.length === content.length) {
			out.push(message);
			continue;
		}
		changed = true;
		stripped += content.length - kept.length;
		for (const block of content) {
			if (block && block.type === "thinking" && !kept.includes(block)) openings.push(block.thinking.trimStart().split("\n")[0].slice(0, 120));
		}
		if (kept.length === 0) {
			dropped++;
			continue;
		}
		out.push({ ...message, content: kept } as T);
	}
	return { messages: changed ? out : messages, stripped, dropped, openings };
}
