// Pure budget logic for the budget-routing extension. No pi imports, so it can be tested without the runtime.
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type Tier = "ok" | "nudge" | "warn" | "prepare" | "divert";

export interface Thresholds {
	nudge: number;
	warn: number;
	prepare: number;
	divert: number;
}

export interface BudgetConfig {
	/** Provider name as recorded in Pi session logs, e.g. "github-copilot". */
	provider: string;
	monthlyCapUsd: number;
	thresholds: Thresholds;
	localModel: { provider: string; modelId: string; subagentRef: string };
	/** Agent names whose launches are rewritten to the local model at divert. */
	localSubagents: string[];
}

export const DEFAULT_THRESHOLDS: Thresholds = { nudge: 0.7, warn: 0.8, prepare: 0.95, divert: 1 };

export function parseConfig(raw: unknown): BudgetConfig {
	if (typeof raw !== "object" || raw === null) throw new Error("budget config must be a JSON object");
	const r = raw as Record<string, unknown>;

	const str = (v: unknown, name: string): string => {
		if (typeof v !== "string" || v.length === 0) throw new Error(`budget config: ${name} must be a non-empty string`);
		return v;
	};
	const num = (v: unknown, name: string): number => {
		if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`budget config: ${name} must be a number`);
		return v;
	};

	const monthlyCapUsd = num(r.monthlyCapUsd, "monthlyCapUsd");
	if (monthlyCapUsd <= 0) throw new Error("budget config: monthlyCapUsd must be positive");

	const t = (r.thresholds ?? {}) as Record<string, unknown>;
	const thresholds: Thresholds = {
		nudge: t.nudge === undefined ? DEFAULT_THRESHOLDS.nudge : num(t.nudge, "thresholds.nudge"),
		warn: t.warn === undefined ? DEFAULT_THRESHOLDS.warn : num(t.warn, "thresholds.warn"),
		prepare: t.prepare === undefined ? DEFAULT_THRESHOLDS.prepare : num(t.prepare, "thresholds.prepare"),
		divert: t.divert === undefined ? DEFAULT_THRESHOLDS.divert : num(t.divert, "thresholds.divert"),
	};
	const order = [thresholds.nudge, thresholds.warn, thresholds.prepare, thresholds.divert];
	if (!order.every((v, i) => i === 0 || order[i - 1] <= v)) {
		throw new Error("budget config: thresholds must be non-decreasing nudge <= warn <= prepare <= divert");
	}

	const lm = r.localModel as Record<string, unknown> | undefined;
	if (typeof lm !== "object" || lm === null) throw new Error("budget config: localModel is required");
	const localModel = {
		provider: str(lm.provider, "localModel.provider"),
		modelId: str(lm.modelId, "localModel.modelId"),
		subagentRef: str(lm.subagentRef, "localModel.subagentRef"),
	};

	const ls = r.localSubagents;
	if (!Array.isArray(ls) || ls.length === 0 || !ls.every((x) => typeof x === "string")) {
		throw new Error("budget config: localSubagents must be a non-empty array of agent names");
	}

	return { provider: str(r.provider, "provider"), monthlyCapUsd, thresholds, localModel, localSubagents: ls as string[] };
}

export async function loadConfig(path: string): Promise<BudgetConfig> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		throw new Error(`budget config not found: ${path}`);
	}
	return parseConfig(JSON.parse(text));
}

/** Local midnight on the first day of the month containing `now`, in epoch ms. */
export function monthStartMs(now: Date = new Date()): number {
	return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

async function* jsonlFiles(dir: string): AsyncGenerator<string> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* jsonlFiles(p);
		else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
	}
}

interface AssistantMessage {
	role?: string;
	provider?: string;
	timestamp?: number;
	usage?: { cost?: { total?: number } };
}

/** Sum of Pi-estimated cost for assistant messages from `provider` at or after `sinceMs`. */
export async function spendSince(sessionsDir: string, provider: string, sinceMs: number): Promise<number> {
	let total = 0;
	for await (const fp of jsonlFiles(sessionsDir)) {
		if ((await stat(fp)).mtimeMs < sinceMs) continue; // file untouched since the window started
		const text = await readFile(fp, "utf8");
		for (const line of text.split("\n")) {
			if (!line.includes('"role":"assistant"')) continue;
			let m: AssistantMessage | undefined;
			try {
				m = JSON.parse(line).message as AssistantMessage | undefined;
			} catch {
				continue;
			}
			if (!m || m.role !== "assistant" || m.provider !== provider) continue;
			if ((m.timestamp ?? 0) < sinceMs) continue;
			total += m.usage?.cost?.total ?? 0;
		}
	}
	return total;
}

export function tierFor(frac: number, t: Thresholds): Tier {
	if (frac >= t.divert) return "divert";
	if (frac >= t.prepare) return "prepare";
	if (frac >= t.warn) return "warn";
	if (frac >= t.nudge) return "nudge";
	return "ok";
}

export interface DivertResult {
	/** Launches whose model was rewritten to the local subagent reference. */
	rewritten: number;
	/** Agent names of launches that cannot run locally and must be blocked. */
	blocked: string[];
}

/**
 * Rewrites subagent launch input in place at divert: local-eligible agents get the local model,
 * other launches are reported as blocked. Management actions (no agent and no task) are left alone.
 */
export function applyDivert(input: unknown, localSubagents: string[], subagentRef: string): DivertResult {
	type Launch = { agent?: unknown; task?: unknown; model?: unknown };
	const root = (input ?? {}) as Launch & { tasks?: unknown };
	const launches: Launch[] = Array.isArray(root.tasks) ? (root.tasks as Launch[]) : [root];
	const result: DivertResult = { rewritten: 0, blocked: [] };
	for (const l of launches) {
		const agent = typeof l.agent === "string" ? l.agent : undefined;
		if (agent === undefined && l.task === undefined) continue;
		if (agent !== undefined && localSubagents.includes(agent)) {
			l.model = subagentRef;
			result.rewritten++;
		} else {
			result.blocked.push(agent ?? "(no agent)");
		}
	}
	return result;
}
