/**
 * Pure logic for pi-autonomy: markers, tool-call signatures, loop detection, and the
 * working-phase decision table. No Pi imports, so the table is unit-testable.
 *
 * The protocol, in one breath: an autonomous session has two phases. In the check-in
 * phase the model reviews the goal and asks its open questions; it ends a text-only
 * message with [autonomy:ready] when it can proceed. In the working phase the extension
 * forces the run to continue after every text-only stop (a "nudge") until the model ends
 * a message with [autonomy:done] (goal fully complete) or a safety guard halts it.
 */

export const READY_MARKER = "[autonomy:ready]";
export const DONE_MARKER = "[autonomy:done]";

export interface AutonomyConfig {
	/** Forced continuations per working phase before a hard stop. */
	maxContinuations: number;
	/** Consecutive tool-free turns that get nudged before a hard stop (stall). */
	maxStallTurns: number;
	/** The same tool call repeated this many times in a row trips the loop guard. */
	repeatLimit: number;
	/** Wall-clock minutes for a working phase before a hard stop. */
	maxMinutes: number;
}

export const DEFAULT_CONFIG: AutonomyConfig = {
	maxContinuations: 40,
	maxStallTurns: 2,
	repeatLimit: 3,
	maxMinutes: 60,
};

/**
 * A marker only counts when it ends the message: everything after the last occurrence
 * must be whitespace. Quoting the marker mid-prose ("I will emit [autonomy:done] later")
 * never counts, because more text follows it.
 */
export function endsWithMarker(text: string, marker: string): boolean {
	const lower = text.toLowerCase();
	const m = marker.toLowerCase();
	const idx = lower.lastIndexOf(m);
	return idx >= 0 && lower.slice(idx + m.length).trim() === "";
}

/** JSON with object keys sorted recursively, so argument order never changes the hash. */
export function stableStringify(value: unknown, maxBytes = 2048): string {
	let json: string;
	try {
		json = JSON.stringify(sortDeep(value)) ?? "undefined";
	} catch {
		return `unserializable:${String(value)}`;
	}
	return json.length > maxBytes ? `${json.slice(0, maxBytes)}…` : json;
}

function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (value !== null && typeof value === "object") {
		const src = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(src).sort()) out[key] = sortDeep(src[key]);
		return out;
	}
	return value;
}

/** One comparable identity per model-issued tool call. */
export function toolCallSignature(name: string, args: unknown): string {
	return `${name}\t${stableStringify(args)}`;
}

/**
 * Sliding window over the most recent tool calls. Trips on the limit-th consecutive
 * repetition of the same call, and also on tight 2- and 3-cycles (ABAB, ABCABC) once
 * they fill the window, which is how "retry, fail, retry, fail" loops present.
 */
export class RepeatDetector {
	private readonly limit: number;
	private recent: string[] = [];

	constructor(limit: number) {
		this.limit = limit;
	}

	reset(): void {
		this.recent = [];
	}

	/** Record one tool call; true when the loop guard just tripped. */
	add(signature: string): boolean {
		this.recent.push(signature);
		if (this.recent.length > 6) this.recent.shift();
		const n = this.recent.length;
		if (n >= this.limit && this.limit <= 6) {
			const tail = this.recent.slice(n - this.limit);
			if (tail.every((s) => s === tail[0])) return true;
		}
		if (n >= 4) {
			const [a, b, c, d] = this.recent;
			if (a === c && b === d && a !== b) return true;
		}
		if (n >= 6) {
			const [a, b, c, d, e, f] = this.recent;
			if (a === d && b === e && c === f && !(a === b && b === c)) return true;
		}
		return false;
	}
}

export type HaltReason = "aborted" | "error" | "max-continuations" | "max-stall-turns" | "repeated-tool-calls" | "max-time";

export interface WorkingState {
	/** Forced continuations issued in this working phase. */
	continuations: number;
	/** Assistant turns seen in this working phase. */
	turns: number;
	/** Consecutive tool-free turns already nudged. */
	stallTurns: number;
	repeats: RepeatDetector;
}

export function freshWorkingState(config: AutonomyConfig): WorkingState {
	return { continuations: 0, turns: 0, stallTurns: 0, repeats: new RepeatDetector(config.repeatLimit) };
}

export type WorkingTurn =
	| { kind: "tool"; signatures: string[] }
	| { kind: "text"; text: string };

export type WorkingDecision =
	| { action: "proceed" } // tool turn: the agent loop continues on its own
	| { action: "nudge"; text: string } // force one more model request with this user message
	| { action: "complete" } // completion marker received
	| { action: "halt"; reason: HaltReason };

/**
 * The working-phase decision for one finished turn. Mutates `state`; the caller keeps
 * it for the rest of the working phase and replaces it via freshWorkingState() on a
 * new one.
 */
export function decideWorkingTurn(
	state: WorkingState,
	config: AutonomyConfig,
	outcome: "completed" | "aborted" | "error",
	turn: WorkingTurn,
	goal: string,
	elapsedMs: number,
): WorkingDecision {
	if (outcome === "aborted") return { action: "halt", reason: "aborted" };
	if (outcome === "error") return { action: "halt", reason: "error" };
	state.turns += 1;

	if (turn.kind === "tool") {
		state.stallTurns = 0;
		for (const signature of turn.signatures) {
			if (state.repeats.add(signature)) return { action: "halt", reason: "repeated-tool-calls" };
		}
		if (elapsedMs > config.maxMinutes * 60_000) return { action: "halt", reason: "max-time" };
		return { action: "proceed" };
	}

	if (endsWithMarker(turn.text, DONE_MARKER)) return { action: "complete" };
	if (state.continuations >= config.maxContinuations) return { action: "halt", reason: "max-continuations" };
	if (elapsedMs > config.maxMinutes * 60_000) return { action: "halt", reason: "max-time" };
	state.stallTurns += 1;
	if (state.stallTurns > config.maxStallTurns) return { action: "halt", reason: "max-stall-turns" };
	state.continuations += 1;
	return { action: "nudge", text: nudgeMessage(goal, state.continuations, config.maxContinuations) };
}

export function checkinMessage(goal: string): string {
	return [
		`Autonomous session check-in. Goal: ${goal}`,
		"",
		"Before the autonomous work phase begins: review the goal and the current context. If you have open questions, ambiguities, or unresolved topics that would change how you work, ask them now in a single batch (prefer the ask_user_question tool). If you have nothing to ask, say so in one sentence.",
		`Do not start the work yet. When you are confident you can proceed without further user input, end your message with ${READY_MARKER} as the final line.`,
	].join("\n");
}

export function workStartMessage(goal: string): string {
	return [
		`The working phase of the autonomous session is now active. Goal: ${goal}`,
		"",
		`Work on the goal without further user interaction until it is fully complete and verified. If you are genuinely blocked on a decision only the user can make, ask once with the ask_user_question tool. When the goal is fully complete, end your message with a short summary of what you did and how you verified it, followed by ${DONE_MARKER} as the final line.`,
	].join("\n");
}

export function resumeMessage(goal: string): string {
	return [
		`Resume the working phase of the autonomous session. Goal: ${goal}`,
		"",
		`Continue from where you left off, without further user interaction, until the goal is fully complete and verified. When it is, end your message with a short summary of what you did and how you verified it, followed by ${DONE_MARKER} as the final line.`,
	].join("\n");
}

export function nudgeMessage(goal: string, n: number, max: number): string {
	return [
		`Autonomous session: forced continuation ${n} of ${max}. The goal has not been marked complete.`,
		`Goal: ${goal}`,
		`If the goal is already fully complete and verified, end your message with a short summary followed by ${DONE_MARKER} as the final line. Otherwise continue working now: take the next concrete step with your tools instead of ending the turn.`,
	].join("\n");
}

export function systemPromptSection(phase: "checkin" | "working", goal: string): string {
	if (phase === "checkin") {
		return [
			"Autonomous session — check-in (pi-autonomy extension)",
			`Goal: ${goal}`,
			"",
			"An autonomous work session is about to start: you will complete the goal without user interaction, and it continues automatically until you signal completion.",
			"Check-in rules:",
			"- Review the goal and the current context. If you have open questions, ambiguities, or unresolved topics that affect the work, ask them now in a single batch (prefer the ask_user_question tool). Keep the check-in brief.",
			"- Do not start the actual work in this check-in.",
			`- When you have no more questions and are confident you can proceed, end your message with ${READY_MARKER} as the final line.`,
		].join("\n");
	}
	return [
		"Autonomous session — working (pi-autonomy extension)",
		`Goal: ${goal}`,
		"",
		"You are working autonomously: the session continues automatically until you signal completion.",
		"Working rules:",
		"- Work step by step until the goal is fully achieved and verified (build, test, and confirm the behavior where applicable). Do not pause to check with the user, and do not end a turn while work remains.",
		"- Make reasonable decisions yourself. If you are genuinely blocked on a decision only the user can make, ask once with the ask_user_question tool; the session waits for the answer.",
		"- Do not rework finished parts and do not start work that is not part of the goal.",
		`- When and only when the goal is fully complete and verified, end your message with a short summary of what you did and how you verified it, followed by ${DONE_MARKER} as the final line. Do not emit the marker earlier, and do not keep working after it.`,
	].join("\n");
}
