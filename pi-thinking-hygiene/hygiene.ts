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
 * The second family is a phantom channel rather than the recited schema: the block asserts that
 * the prompt carries an injected block or a hook event. Pi has no hook events, so naming one is
 * false by construction, and Pi replaying the block seeds the next turn exactly as the schema
 * does. Instructions that really are injected into fetched content describe their own content
 * instead of a harness mechanism, and reasoning about Pi's own injection paths names the path it
 * checked, so neither is caught here.
 */
const HARNESS_MECHANISM_REF: RegExp[] = [
	/\buserpromptsubmit\b|\bpre[- ]?tool[- ]?use\b|\bsubagent[- ]?stop\b/i,
	/\bhook (?:context|extension|output that|fires)\b/i,
	/\binjected (?:hook |prompt )?(?:text|context|block|message)\b/i,
	/\bintervention (?:on|in) (?:my|the) (?:reasoning|thinking|context)\b/i,
];

/** The claim stated as its own sentence, so a block that only mentions the words while doing something else stays. */
const CLAIM_SENTENCE =
	/^(?:(?:also |separately |additionally |note|one more thing|and|but|so|then)[^a-z0-9]{0,4}){0,2}(?:the |this |that )?(?:tool result|prompt|user(?:'s)? (?:message|turn)|turn|message|context|block|text|hook context)\b[^.]{0,48}\b(?:shows?|showed|contains?|contained|includes?|included|carries|carried|displays?|says|appears?|appeared|appended|arrives?|arrived|again|looked like|seems? to)\b/i;

/** ...and the recurring form, which claims the same block arrived again. */
const RECURRING_CLAIM = /^(?:the )?(?:same|that|this)\b[^.]{0,20}\b(?:injected|hook)\b[^.]{0,24}\bagain\b/i;

/** Reasoning that asks where the text came from, or that no such mechanism exists, is diagnosis and stays. */
const PROVENANCE_WORK: RegExp[] = [
	/\bgrep\b|\bsearch(?:ed|ing)? for\b/i,
	/\b(?:doesn'?t|does not|didn'?t) appear\b|\bnowhere in\b|\bno such\b|\bisn'?t from\b|\bnot (?:found|present|produced by)\b/i,
	/\bno extension\b|\bhook (?:event|mechanism|support|name)\b/i,
	/\b(?:confabulat|hallucinat|fabricat|invent(?:ed|ion))\b/i,
	/\bpi-memory\b|\bmemory (?:block|context|injection)\b|\bcustom_message\b/i,
];

/** Sentence boundaries for the claim test: a period, question mark, exclamation or newline ends one. */
const SENTENCE = /[^.!?\n]+/g;

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

/** Is this reasoning claiming an injected block or a hook event in the prompt that Pi did not put there? */
export function isPhantomInjection(thinking: string): boolean {
	const body = thinking.trimStart();
	if (PROVENANCE_WORK.some((pattern) => pattern.test(body))) return false;
	for (const sentence of (body.match(SENTENCE) ?? []).slice(0, 3)) {
		const claim = sentence.trimStart();
		if (HARNESS_MECHANISM_REF.some((pattern) => pattern.test(sentence)) && (CLAIM_SENTENCE.test(claim) || RECURRING_CLAIM.test(claim))) return true;
	}
	return false;
}

/** Is this reasoning the recited session-opening schema or a phantom channel, rather than reasoning about the turn? */
export function isConfabulatedThinking(thinking: string, extraPatterns: RegExp[] = []): boolean {
	const opening = thinking.trimStart();
	if (isPhantomInjection(opening)) return true;
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
