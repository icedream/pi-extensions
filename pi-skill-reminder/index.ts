/**
 * Names the skill rules a compaction dropped, so the model reloads the ones its task needs.
 *
 * The `<available_skills>` block is part of the system prompt and a compaction summary lists every file the
 * session read under `<read-files>`, so a session that no longer holds a skill's text still sees evidence
 * that it read the file, and answers from recall of it. The rules are the text, not the path: the extension
 * detects which skill texts left the context and orders a full re-read of them before any of their rules may
 * be restated. PI_SKILL_RULES=full skips the ordering and puts the text in context itself.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Pi's own tag for expanded skill content. Injecting the same shape makes a reload indistinguishable from a fresh load. */
const SKILL_TAG = /<skill name="([^"]+)" location="([^"]+)">/g;
const SKILL_FILE = /(?:^|\/)skills\/([^/]+)\/(.+\.md)$/i;

/** The read tool gives at most 50 KB of a file, so a larger block is more than a normal read would have carried. */
const MAX_SKILL_BYTES = 48_000;
const MAX_MESSAGE_BYTES = 160_000;

const CUSTOM_TYPE = "skill-rules";

type Part = {
	type?: string;
	text?: string;
	name?: string;
	id?: string;
	arguments?: Record<string, unknown>;
};

type EntryLike = {
	type?: string;
	customType?: string;
	content?: unknown;
	message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean };
};

type SkillRef = { name: string; location: string };

/**
 * "relevant" (default) lists the skills whose text a compaction dropped and makes the model re-read the
 * ones its task needs; "full" re-reads every one of them itself; "off" leaves compaction summaries alone.
 */
function mode(): "relevant" | "full" | "off" {
	const value = (process.env.PI_SKILL_RULES ?? "relevant").toLowerCase();
	if (value === "off") return "off";
	return value === "full" ? "full" : "relevant";
}

function skillRef(path: unknown): SkillRef | null {
	if (typeof path !== "string") return null;
	const match = SKILL_FILE.exec(path);
	return match ? { name: match[1], location: path } : null;
}

function entryParts(entry: EntryLike): Part[] {
	const content = entry.message?.content ?? entry.content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content as Part[];
	return [];
}

function tagsIn(text: string): SkillRef[] {
	// A session's transcript is mostly text that cannot contain a skill block; skip the regex for it.
	if (!text.includes("<skill name=\"")) return [];
	const found: SkillRef[] = [];
	for (const match of text.matchAll(SKILL_TAG)) found.push({ name: match[1], location: match[2] });
	return found;
}

/**
 * Skills the given entries put in front of the model: a successful read of a skill file, or an expanded
 * skill block. A failed read counts as nothing, and a summarized span is simply absent from the entries.
 */
function skillsIn(entries: EntryLike[]): Map<string, SkillRef> {
	const calls = new Map<string, SkillRef>();
	const failed = new Set<string>();
	const found = new Map<string, SkillRef>();

	for (const entry of entries) {
		for (const part of entryParts(entry)) {
			if (part.type === "toolCall" && part.name === "read" && part.id) {
				const ref = skillRef(part.arguments?.path);
				if (ref) calls.set(part.id, ref);
			} else if (typeof part.text === "string") {
				for (const ref of tagsIn(part.text)) found.set(ref.location, ref);
			}
		}
		const message = entry.message;
		if (message?.role === "toolResult" && message.isError && message.toolCallId) failed.add(message.toolCallId);
	}

	for (const [id, ref] of calls) if (!failed.has(id)) found.set(ref.location, ref);
	return found;
}

function branchEntries(ctx: ExtensionContext): EntryLike[] {
	return ctx.sessionManager.getBranch() as unknown as EntryLike[];
}

function contextEntries(ctx: ExtensionContext): EntryLike[] {
	const build = (ctx.sessionManager as unknown as { buildContextEntries?: () => EntryLike[] }).buildContextEntries;
	return (build ? build.call(ctx.sessionManager) : ctx.sessionManager.getBranch()) as unknown as EntryLike[];
}

/** Skills the session has read at some point whose text is not in the context of the next model call. */
function staleSkills(ctx: ExtensionContext): SkillRef[] {
	const context = skillsIn(contextEntries(ctx));
	const pending = queuedFor(ctx);
	for (const location of [...pending]) if (context.has(location)) pending.delete(location);
	return [...skillsIn(branchEntries(ctx)).values()].filter((ref) => !context.has(ref.location) && !pending.has(ref.location));
}

type Block = { ref: SkillRef; body: string; bytes: number };

function loadBlock(ref: SkillRef): Block {
	let raw: string;
	try {
		raw = readFileSync(ref.location, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : "read failed";
		return { ref, body: `[unavailable: ${message}]`, bytes: 0 };
	}

	if (raw.length <= MAX_SKILL_BYTES) return { ref, body: raw, bytes: raw.length };

	const lines = raw.split("\n");
	let kept = 0;
	let bytes = 0;
	while (kept < lines.length && bytes + lines[kept].length + 1 <= MAX_SKILL_BYTES) bytes += lines[kept++].length + 1;
	return {
		ref,
		body: `${lines.slice(0, kept).join("\n")}\n\n[truncated: lines ${kept + 1}-${lines.length} of ${lines.length} left out. Read the location attribute with offset=${kept + 1} before applying any rule from them.]`,
		bytes,
	};
}

/** The frontmatter description, so the model can judge relevance without opening the file again. */
function descriptionOf(location: string): string {
	let head: string;
	try {
		head = readFileSync(location, "utf8").slice(0, 4000);
	} catch {
		return "";
	}
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
	const line = frontmatter?.[1].split(/\r?\n/).find((l) => l.startsWith("description:"));
	if (!line) return "";
	return line.slice("description:".length).trim().replace(/^["']|["']$/g, "");
}

function fullHeader(count: number): string {
	return [
		"Skill rules reloaded. A compaction dropped the text of the skills this session read, while their",
		"paths survive in the summary's <read-files> list and in <available_skills>. Those paths carry no",
		"rules. The text below is the current file content and is the authority for this session: apply it",
		"instead of recalling an earlier read, and do not treat the path list as knowledge of the rules.",
		`${count} skill file(s) follow.`,
	].join("\n");
}

function relevantHeader(count: number): string {
	return [
		"Skills this session read but no longer holds. A compaction removed their text; only the paths",
		"survive, in the summary's <read-files> list and in <available_skills>. A path is not a rule, and the",
		"earlier read is no longer a source you can quote.",
		"",
		"Decide which of these skills apply to the task you are working on now. Read each applicable file",
		"below in full with the read tool before applying any rule from it, and name which ones you loaded.",
		"Leave the skills that do not apply to this task alone. Never restate a rule from a file you have",
		"not read in this context window: if you are unsure whether a rule is real, read the file first.",
		`${count} skill file(s) listed.`,
	].join("\n");
}

function render(blocks: Block[]): string {
	return blocks.map((b) => `<skill name="${b.ref.name}" location="${b.ref.location}">\n${b.body}\n</skill>`).join("\n\n");
}

function renderList(blocks: Block[]): string {
	return blocks
		.map((b) => {
			const description = descriptionOf(b.ref.location);
			return `- ${b.ref.name}${description ? `: ${description}` : ""}\n  read in full: ${b.ref.location}`;
		})
		.join("\n");
}

type Reload = { content: string; details: { paths: string[]; injected: boolean; part: number; of: number } };

/**
 * Reloads queued for delivery are not in the transcript until they are delivered, so the next hook would
 * otherwise send the same text twice. Keyed by session id: one extension instance survives a resume, a
 * fork or a session switch, and the previous session's queue is not this session's queue.
 */
const queued = new Map<string, Set<string>>();

/**
 * A list-mode notice carries no text that could be recognized as present later, so it is deduplicated by the
 * compaction boundary: one notice per compaction. Within one boundary the dropped set only shrinks as the
 * model re-reads, and the notice that named it stays in the transcript, so repeating it every run would only
 * be noise.
 */
const noticed = new Map<string, Set<string>>();

function boundaryOf(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i] as { type?: string; id?: string };
		if (entry.type === "compaction" || entry.type === "branch_summary") return `${entry.type}:${entry.id}`;
	}
	return "no-compaction";
}

function markNotice(ctx: ExtensionContext, signature: string): void {
	const seen = noticed.get(ctx.sessionManager.getSessionId()) ?? new Set<string>();
	seen.add(signature);
	noticed.set(ctx.sessionManager.getSessionId(), seen);
}

function queuedFor(ctx: ExtensionContext): Set<string> {
	const id = ctx.sessionManager.getSessionId();
	const set = queued.get(id) ?? new Set<string>();
	queued.set(id, set);
	return set;
}

/**
 * Inside a run the reload is steered: a "nextTurn" message only joins the next run, which would leave the
 * turns after a mid-run compaction answering without the rules.
 */
function queueReloads(pi: ExtensionAPI, ctx: ExtensionContext, messages: Reload[]): void {
	const deliverAs = ctx.isIdle() ? "nextTurn" : "steer";
	const pending = queuedFor(ctx);
	for (const message of messages) {
		pi.sendMessage({ customType: CUSTOM_TYPE, content: message.content, display: false, details: message.details }, { deliverAs });
		for (const path of message.details.paths) pending.add(path);
	}
}

/** One message holds a reload when it fits; the split is only ever needed for an unusually large set. */
function reloadMessages(
	ctx: ExtensionContext,
	opts: { text?: boolean; includeFresh?: boolean } = {},
): Reload[] {
	if (mode() === "off") return [];
	const inject = opts.text ?? mode() === "full";
	const stale = opts.includeFresh ? [...skillsIn(branchEntries(ctx)).values()] : staleSkills(ctx);
	if (stale.length === 0) return [];

	const blocks = stale.map((ref) => (inject ? loadBlock(ref) : { ref, body: "", bytes: 0 }));
	const chunks: Block[][] = [];
	let current: Block[] = [];
	let size = 0;
	for (const block of blocks) {
		if (current.length && size + block.bytes > MAX_MESSAGE_BYTES) {
			chunks.push(current);
			current = [];
			size = 0;
		}
		current.push(block);
		size += block.bytes;
	}
	if (current.length) chunks.push(current);

	return chunks.map((chunk, index) => ({
		content: `${inject ? fullHeader(chunk.length) : relevantHeader(chunk.length)}\n\n${inject ? render(chunk) : renderList(chunk)}`,
		details: { paths: chunk.map((b) => b.ref.location), injected: inject, part: index + 1, of: chunks.length },
	}));
}

function countPaths(messages: Reload[]): number {
	return messages.reduce((total, message) => total + message.details.paths.length, 0);
}

/**
 * A list-mode notice carries no text that could be recognized as present later, so it is deduplicated by
 * the compaction boundary: one notice per compaction. Within one boundary the stale set only shrinks, and
 * the notice that named it stays in the transcript, so repeating it every run would only be noise.
 */
function noticeFor(ctx: ExtensionContext, messages: Reload[]): { send: boolean; signature: string | null } {
	if (messages.some((m) => m.details.injected)) return { send: true, signature: null };

	const signature = boundaryOf(ctx);
	if (noticed.get(ctx.sessionManager.getSessionId())?.has(signature)) return { send: false, signature: null };
	return { send: true, signature };
}

function statusText(ctx: ExtensionContext): string {
	const context = skillsIn(contextEntries(ctx));
	const tracked = skillsIn(branchEntries(ctx));
	if (tracked.size === 0) return "No skill file has been read in this session";
	return [
		`Skills in this session (${tracked.size}), ${context.size} with text in the current context. Mode: ${mode()}.`,
		...[...tracked.values()].map((ref) => `- ${ref.name}: ${context.has(ref.location) ? "in context" : "text dropped by compaction"}`),
	].join("\n");
}

function noticeLabel(messages: Reload[]): string {
	const files = countPaths(messages);
	return messages[0].details.injected ? `reloaded ${files} skill rule file(s)` : `listed ${files} skill rule file(s) for re-read`;
}

export default function (pi: ExtensionAPI): void {
	// A compaction inside a run has no before_agent_start, so it queues the reload itself.
	pi.on("session_compact", (_event, ctx) => {
		const messages = reloadMessages(ctx);
		if (messages.length === 0) return;
		const notice = noticeFor(ctx, messages);
		if (!notice.send) return;

		queueReloads(pi, ctx, messages);
		if (notice.signature) markNotice(ctx, notice.signature);
		if (ctx.hasUI) ctx.ui.notify(`After the compaction: ${noticeLabel(messages)}`, "info");
	});

	// A run that starts on a compacted transcript, a resume, a fork or a branch jump has had no
	// session_compact of its own, so the reload goes into this run.
	pi.on("before_agent_start", (_event, ctx) => {
		const messages = reloadMessages(ctx);
		if (messages.length === 0) return;
		const notice = noticeFor(ctx, messages);
		if (!notice.send) return;

		queueReloads(pi, ctx, messages.slice(1));
		if (notice.signature) markNotice(ctx, notice.signature);
		if (ctx.hasUI) ctx.ui.notify(`Into this run: ${noticeLabel(messages)}`, "info");

		const [first] = messages;
		for (const path of first.details.paths) queuedFor(ctx).add(path);
		return { message: { customType: CUSTOM_TYPE, content: first.content, display: false, details: first.details } };
	});

	// A reload that was never delivered must not stay suppressed, and a session runtime rebuilt for the
	// same session id starts with an empty delivery queue and has to be told again.
	pi.on("agent_end", (_event, ctx) => {
		queued.delete(ctx.sessionManager.getSessionId());
	});

	pi.on("session_start", (_event, ctx) => {
		queued.delete(ctx.sessionManager.getSessionId());
		noticed.delete(ctx.sessionManager.getSessionId());
	});

	pi.registerCommand("skills-loaded", {
		description: "List the skills this session read and whether their text is still in context",
		handler: async (_args, ctx) => {
			ctx.ui.notify(statusText(ctx), "info");
		},
	});

	pi.registerCommand("skills-reload", {
		description: "Read the skill files this session read and put their text into context",
		handler: async (args, ctx) => {
			// "force" also covers text that is already in context, which is what a manual reload asks for.
			const messages = reloadMessages(ctx, { text: true, includeFresh: args.trim() === "force" });
			if (messages.length === 0) {
				ctx.ui.notify(statusText(ctx), "info");
				return;
			}
			queueReloads(pi, ctx, messages);
			ctx.ui.notify(`Reloaded ${countPaths(messages)} skill rule file(s)`, "info");
		},
	});
}
