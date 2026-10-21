/**
 * pi-mcp-hygiene: rewrite the MCP adapter's first-person UI notice out of tool results.
 * See notices.ts for why the wording matters and what is preserved.
 *
 * Commands:
 *   /mcp-hygiene          how many notices were reworded this session
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isMcpToolName, rewriteContent } from "./notices.ts";

const STATUS_KEY = "pi-mcp-hygiene";

export default function (pi: ExtensionAPI) {
	let rewrites = 0;

	function status(ctx: ExtensionContext) {
		if (rewrites === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const label = `mcp hygiene: ${rewrites} adapter notice${rewrites === 1 ? "" : "s"} reworded`;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", label));
	}

	pi.on("session_start", async (_event, ctx) => {
		rewrites = 0;
		status(ctx);
	});

	pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
		if (!isMcpToolName(event.toolName)) return undefined;
		const result = rewriteContent(event.content);
		if (result.rewrites === 0) return undefined;
		rewrites += result.rewrites;
		status(ctx);
		return { content: result.content };
	});

	pi.registerCommand("mcp-hygiene", {
		description: "Report how many MCP adapter notices were reworded this session",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const detail = rewrites === 0 ? "no adapter notice matched yet" : `${rewrites} notice${rewrites === 1 ? "" : "s"} reworded`;
			ctx.ui.notify(`pi-mcp-hygiene: ${detail}`, "info");
		},
	});
}
