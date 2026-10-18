/**
 * pi-thinking-hygiene: keep confabulated reasoning out of the prompt.
 *
 * Pi replays prior thinking to the provider as `reasoning_content`. That is what normally
 * makes a reasoning model coherent across turns, and it is also how one bad block seeds a
 * run of them: a model that recites a "this is only a system-prompt setup, there is no
 * question here" orientation sees it again on the next turn as its own prior reasoning and
 * continues it. 60 such blocks were found across seven sessions, six of them consecutive in
 * one session, all on one local model.
 *
 * So this extension runs on the request-time context transform and drops those blocks from
 * the transcript Pi is about to send. The session file and the UI are untouched: the
 * reasoning is still visible, it just stops being fed back.
 *
 * Dropping a block makes the prompt diverge from the one already sent at that block's
 * position, so the engine re-prefills from there. The block sits near the end of the prompt
 * when it is first dropped, so the tail is 56 to 3,161 approximate tokens over the 60
 * observed blocks, median 261, and the transform is deterministic, so it is paid once per
 * block rather than once per turn.
 *
 * Config: ~/.pi/agent/thinking-hygiene.json (override with PI_THINKING_HYGIENE_CONFIG).
 * Without a config file the extension is on.
 *
 * Commands:
 *   /thinking-hygiene          what was kept out of the prompt, and the current setting
 *   /thinking-hygiene on|off
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type Config } from "./config.ts";
import { stripConfabulatedThinking } from "./hygiene.ts";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = process.env.PI_THINKING_HYGIENE_CONFIG ?? join(AGENT_DIR, "thinking-hygiene.json");
const STATUS_KEY = "pi-thinking-hygiene";
const ENTRY_TYPE = "thinking-hygiene";

interface HygieneData {
	blocks: number;
	/** Assistant messages that were nothing but a removed block and went with it. */
	droppedMessages: number;
	openings: string[];
}

export default function (pi: ExtensionAPI) {
	let config: Config;
	let problem: string | undefined;
	let session = { blocks: 0, droppedMessages: 0, runs: 0 };
	let announced = false;

	({ config, problem } = loadConfig(CONFIG_PATH));

	function status(ctx: ExtensionContext) {
		if (session.blocks === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const label = `${session.blocks} confabulated reasoning block${session.blocks === 1 ? "" : "s"} kept out of the prompt`;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `thinking hygiene: ${label}`));
	}

	pi.on("session_start", async (_event, ctx) => {
		session = { blocks: 0, droppedMessages: 0, runs: 0 };
		announced = false;
		status(ctx);
		if (problem) ctx.ui.notify(`pi-thinking-hygiene: ${problem}`, "warning");
	});

	pi.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
		if (!config.enabled) return undefined;
		const before = event.messages;
		const result = stripConfabulatedThinking(before, config.extraPatterns);
		if (result.messages === before) return undefined;

		session.blocks += result.stripped;
		session.droppedMessages += result.dropped;
		session.runs++;
		if (!announced) {
			announced = true;
			ctx.ui.notify(
				`pi-thinking-hygiene: the model's own session-opening reasoning is being replayed back to it; ${result.stripped} block${result.stripped === 1 ? "" : "s"} removed from this request`,
				"info",
			);
		}
		status(ctx);
		pi.appendEntry<HygieneData>(ENTRY_TYPE, { blocks: result.stripped, droppedMessages: result.dropped, openings: result.openings });
		return { messages: result.messages };
	});

	pi.registerCommand("thinking-hygiene", {
		description: "Report, enable, or disable the confabulated-reasoning filter",
		getArgumentCompletions: (prefix) => ([{ value: "on", label: "on" }, { value: "off", label: "off" }]).filter((item) => item.value.startsWith(prefix)),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				config = { ...config, enabled: arg === "on" };
				ctx.ui.notify(`pi-thinking-hygiene ${config.enabled ? "on" : "off"} for this session (${CONFIG_PATH} still decides at startup)`, "info");
			}
			const state = config.enabled ? "on" : "off";
			const detail = session.blocks === 0 ? "nothing matched yet" : `${session.blocks} blocks out, ${session.droppedMessages} empty messages dropped, over ${session.runs} request(s)`;
			ctx.ui.notify(`pi-thinking-hygiene: ${state}; ${detail}`, "info");
		},
	});
}
