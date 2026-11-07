/**
 * pi-autonomy: run a goal autonomously, with a pre-flight check-in and runaway guards.
 *
 * /autonomy <goal> sends the agent into a short check-in: it reviews the goal and asks
 * any open questions (the user answers in the normal way). When the agent ends a message
 * with [autonomy:ready], the working phase starts and the extension forces the run to
 * continue after every text-only stop until the agent ends a message with [autonomy:done]
 * (goal fully complete) or a safety guard halts it: continuation cap, two consecutive
 * tool-free turns, the same tool call repeated three times, or the wall-clock cap.
 *
 * Commands:
 *   /autonomy <goal>       check-in first, then work autonomously
 *   /autonomy now <goal>   work autonomously immediately (skip the check-in)
 *   /autonomy go           start now (after a check-in) or resume (after a pause)
 *   /autonomy stop         end the session (aborts the current run)
 *   /autonomy status       show the current state and the effective guard values
 *
 * The guard values come from autonomy.json: the agent dir, plus a project file in a trusted
 * project. Read once at session start, so editing the file wants a /reload. See config.ts.
 *
 * State is per session in memory; a reload or session switch resets it to idle.
 */

import type {
	AgentSettledEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	type HaltReason,
	type WorkingState,
	READY_MARKER,
	checkinMessage,
	decideWorkingTurn,
	endsWithMarker,
	freshWorkingState,
	haltReasons,
	resumeMessage,
	systemPromptSection,
	toolCallSignature,
	usageText,
	workStartMessage,
} from "./protocol.ts";
import { describeConfig, resolveConfig, type ResolvedConfig } from "./config.ts";

const STATUS_KEY = "pi-autonomy";
const SECTION_KEY = "autonomy";

type Phase = "idle" | "checkin" | "working" | "paused";

export default function (pi: ExtensionAPI) {
	// Global layer at load, project layer added by session_start: the project file needs
	// ctx.cwd and the trust decision, which do not exist yet here.
	let resolved: ResolvedConfig = resolveConfig({});
	let reasons: Record<HaltReason, string> = haltReasons(resolved.config);
	const usage = () => usageText(resolved.config);

	/**
	 * Re-read the config files. Only called from session_start: `repeatLimit` is baked into
	 * the RepeatDetector when a working phase starts while the other budgets are read per
	 * turn, so reloading mid-session would run one session under mixed numbers. /reload
	 * re-emits session_start, which is the documented way in.
	 */
	function refreshConfig(ctx: ExtensionContext) {
		resolved = resolveConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		reasons = haltReasons(resolved.config);
		for (const problem of resolved.problems) ctx.ui.notify(`autonomy: ignoring config — ${problem}`, "warning");
		if (resolved.projectSkipped) {
			ctx.ui.notify(`autonomy: found ${resolved.projectSkipped} but the project is not trusted, using the global config`, "info");
		}
	}

	let phase: Phase = "idle";
	let goal = "";
	let pauseReason = "";
	let startedAt = 0;
	let work: WorkingState = freshWorkingState(resolved.config);
	let pendingWorkStart = false;
	let workingRunActive = false;

	const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

	function status(ctx: ExtensionContext) {
		const t = ctx.ui.theme;
		const max = resolved.config.maxContinuations;
		if (phase === "checkin") ctx.ui.setStatus(STATUS_KEY, t.fg("muted", `autonomy: check-in — ${truncate(goal, 44)}`));
		else if (phase === "working")
			ctx.ui.setStatus(STATUS_KEY, t.fg("warning", `autonomy: working (${work.continuations}/${max}) — ${truncate(goal, 36)}`));
		else if (phase === "paused") ctx.ui.setStatus(STATUS_KEY, t.fg("error", `autonomy: paused (${pauseReason})`));
		else ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function resetSession() {
		phase = "idle";
		goal = "";
		pauseReason = "";
		startedAt = 0;
		work = freshWorkingState(resolved.config);
		pendingWorkStart = false;
		workingRunActive = false;
	}

	function start(ctx: ExtensionCommandContext, goalText: string, immediate: boolean) {
		if (phase !== "idle") {
			ctx.ui.notify("autonomy: already active — use /autonomy stop first", "warning");
			return;
		}
		goal = goalText.trim();
		if (!goal) {
			ctx.ui.notify(usage(), "warning");
			return;
		}
		work = freshWorkingState(resolved.config);
		pauseReason = "";
		startedAt = Date.now();
		phase = immediate ? "working" : "checkin";
		status(ctx);
		pi.sendUserMessage(immediate ? workStartMessage(goal) : checkinMessage(goal), { deliverAs: "followUp" });
	}

	function beginWorking() {
		work = freshWorkingState(resolved.config);
		pauseReason = "";
		startedAt = Date.now();
		phase = "working";
	}

	function go(ctx: ExtensionCommandContext) {
		if (phase === "checkin") {
			if (!ctx.isIdle()) {
				ctx.ui.notify("autonomy: the check-in turn is still running — wait for it to finish, then the work starts on its own", "info");
				return;
			}
			pendingWorkStart = false;
			beginWorking();
			status(ctx);
			pi.sendUserMessage(workStartMessage(goal), { deliverAs: "followUp" });
			return;
		}
		if (phase === "paused" || (phase === "working" && ctx.isIdle())) {
			if (!ctx.isIdle()) {
				ctx.ui.notify("autonomy: the agent is busy — wait for it to finish", "warning");
				return;
			}
			beginWorking();
			status(ctx);
			pi.sendUserMessage(resumeMessage(goal), { deliverAs: "followUp" });
			return;
		}
		if (phase === "working") {
			ctx.ui.notify("autonomy: already working — it continues until the agent emits the completion marker", "info");
			return;
		}
		ctx.ui.notify("autonomy: nothing to start or resume — use /autonomy <goal>", "info");
	}

	function stop(ctx: ExtensionCommandContext) {
		if (phase === "idle") {
			ctx.ui.notify("autonomy: not active", "info");
			return;
		}
		resetSession();
		status(ctx);
		if (!ctx.isIdle()) ctx.abort();
		ctx.ui.notify("autonomy: stopped", "info");
	}

	function reportStatus(ctx: ExtensionContext) {
		if (phase === "idle") {
			ctx.ui.notify(`${usage()}\n\n${describeConfig(resolved)}`, "info");
			reportProblems(ctx);
			return;
		}
		const parts = [`phase: ${phase}`, `goal: ${truncate(goal, 60)}`];
		if (phase === "working") {
			const minutes = Math.floor((Date.now() - startedAt) / 60_000);
			parts.push(
				`forced continuations: ${work.continuations}/${resolved.config.maxContinuations}`,
				`turns: ${work.turns}`,
				`running: ${minutes}/${resolved.config.maxMinutes} min`,
			);
		}
		if (phase === "paused") parts.push(`reason: ${pauseReason}`, "resume with /autonomy go");
		ctx.ui.notify(`autonomy — ${parts.join(" · ")}\n${describeConfig(resolved)}`, "info");
		reportProblems(ctx);
	}

	function reportProblems(ctx: ExtensionContext) {
		for (const problem of resolved.problems) ctx.ui.notify(`autonomy: ignoring config — ${problem}`, "warning");
		if (resolved.projectSkipped) ctx.ui.notify(`autonomy: project config skipped (untrusted project): ${resolved.projectSkipped}`, "info");
	}

	pi.registerCommand("autonomy", {
		description: "Run a goal autonomously: /autonomy <goal> | /autonomy now <goal> | /autonomy go | /autonomy stop | /autonomy status",
		getArgumentCompletions: (prefix) =>
			["now", "go", "stop", "status"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v })),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim();
			if (!arg) {
				reportStatus(ctx);
				return;
			}
			const [first, ...rest] = arg.split(/\s+/);
			switch (first) {
				case "stop":
					stop(ctx);
					return;
				case "go":
					go(ctx);
					return;
				case "status":
					reportStatus(ctx);
					return;
				case "now": {
					const g = rest.join(" ");
					if (!g.trim()) {
						ctx.ui.notify("Usage: /autonomy now <goal>", "warning");
						return;
					}
					start(ctx, g, true);
					return;
				}
				default:
					start(ctx, arg, false);
			}
		},
	});

	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		refreshConfig(ctx);
		resetSession();
		status(ctx);
	});

	pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
		if (phase === "checkin" || phase === "working") {
			event.systemPromptOptions.sections[SECTION_KEY] = systemPromptSection(phase, goal);
		} else {
			delete event.systemPromptOptions.sections[SECTION_KEY];
		}
	});

	pi.on("turn_end", async (event: TurnEndEvent, ctx: ExtensionContext) => {
		const message = event.message;
		if (message.role !== "assistant") return undefined;
		const parts = message.content;
		const text = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
		const toolCalls: { name: string; arguments: unknown }[] = [];
		for (const p of parts) if (p.type === "toolCall") toolCalls.push({ name: p.name, arguments: p.arguments });

		if (phase === "checkin") {
			// The ready marker only counts on a text-only turn: with tool calls in flight
			// the run continues under the check-in system prompt anyway.
			if (toolCalls.length === 0 && endsWithMarker(text, READY_MARKER)) {
				beginWorking();
				pendingWorkStart = true;
				status(ctx);
				ctx.ui.notify(`autonomy: check-in complete — working on “${truncate(goal, 48)}”`, "info");
			}
			return undefined;
		}

		if (phase !== "working" || !workingRunActive) return undefined;

		const decision = decideWorkingTurn(
			work,
			resolved.config,
			event.outcome,
			toolCalls.length > 0 ? { kind: "tool", signatures: toolCalls.map((c) => toolCallSignature(c.name, c.arguments)) } : { kind: "text", text },
			goal,
			Date.now() - startedAt,
		);

		if (decision.action === "complete") {
			const summary = `autonomy: complete — ${truncate(goal, 60)} (${work.turns} turns, ${work.continuations} forced continuations)`;
			resetSession();
			status(ctx);
			ctx.ui.notify(summary, "info");
			return { entries: [{ type: "custom_message", customType: "autonomy/result", content: summary, display: true }] };
		}

		if (decision.action === "halt") {
			pauseReason = reasons[decision.reason];
			phase = "paused";
			pendingWorkStart = false;
			status(ctx);
			ctx.ui.notify(`autonomy: paused — ${pauseReason}. Resume with /autonomy go, end with /autonomy stop.`, "warning");
			const note = `Autonomy paused: ${pauseReason}. The autonomous session for “${goal}” is on hold; the user can resume it with /autonomy go.`;
			return { entries: [{ type: "custom_message", customType: "autonomy/result", content: note, display: true }] };
		}

		if (decision.action === "nudge") {
			status(ctx);
			return {
				continue: true,
				entries: [{ type: "custom_message", customType: "autonomy/continue", content: decision.text, display: false }],
			};
		}

		// "proceed": the turn executed tools, so the agent loop continues on its own.
		return undefined;
	});

	pi.on("agent_start", (_event: AgentStartEvent) => {
		if (phase === "working") workingRunActive = true;
	});

	pi.on("agent_settled", (_event: AgentSettledEvent, ctx: ExtensionContext) => {
		if (pendingWorkStart) {
			// The check-in run has fully settled; start the working phase as a fresh run
			// so the working system prompt section applies from its first turn.
			pendingWorkStart = false;
			pi.sendUserMessage(workStartMessage(goal), { deliverAs: "followUp" });
			return;
		}
		if (phase === "working" && workingRunActive) {
			// Defensive backstop: the working run ended without a turn_end decision (for
			// example a rejected continuation). Never leave the user hanging in "working".
			// (Not taken when a queued start message still has to begin its run.)
			pauseReason = "the run ended without a completion marker";
			phase = "paused";
			status(ctx);
			ctx.ui.notify(`autonomy: paused — ${pauseReason}. Resume with /autonomy go.`, "warning");
		}
		workingRunActive = false;
	});
}
