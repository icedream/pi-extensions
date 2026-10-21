/**
 * Remembers which skills a session has read, and says so after a compaction.
 *
 * The `<available_skills>` block is part of the system prompt, so compaction does not remove it. What
 * compaction removes is the record that a skill's text was read and applied. The next turn then either
 * re-reads the file or answers without it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ToolCallPart = { type?: string; name?: string; arguments?: Record<string, unknown> };

/** skill name to the skill-relative path the read tool was given */
const loaded = new Map<string, string>();
let lastReminder = "";

const SKILL_FILE = /(?:^|\/)skills\/([^/]+)\/([^/]+)\.md$/i;

function notePath(path: unknown): void {
  if (typeof path !== "string") return;
  const match = SKILL_FILE.exec(path);
  if (match) loaded.set(match[1], match[0].replace(/^\//, ""));
}

/** Rebuilds the set after a resume or a fork, where the reads sit in the transcript. */
function scanHistory(ctx: ExtensionContext): void {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    // AgentMessage is a union; the transcript scan only cares about the message-shaped members.
    const content = (entry.message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content as ToolCallPart[]) {
      if (part?.type === "toolCall" && part.name === "read") notePath(part.arguments?.path);
    }
  }
}

function reminderText(): string {
  return [
    "Skills already read in this session. Their rules still apply.",
    "Do not re-read one unless you need its wording exactly.",
    ...[...loaded.entries()].map(([name, path]) => `- ${name}: ${path}`),
  ].join("\n");
}

export default function (pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "read" || event.isError) return;
    notePath(event.input.path);
  });

  pi.on("session_start", (_event, ctx) => {
    scanHistory(ctx);
  });

  pi.on("session_compact", () => {
    if (loaded.size === 0) return;
    const text = reminderText();
    if (text === lastReminder) return;
    lastReminder = text;
    pi.sendMessage({ customType: "skill-reminder", content: text, display: false }, { deliverAs: "nextTurn" });
  });

  pi.registerCommand("skills-loaded", {
    description: "List the skills this session has already read",
    handler: async (_args, ctx) => {
      if (loaded.size === 0) {
        ctx.ui.notify("No skill file has been read in this session", "info");
        return;
      }
      ctx.ui.notify(reminderText(), "info");
    },
  });
}
