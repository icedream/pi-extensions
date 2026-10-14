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
	/**
	 * Manual calibration from the GitHub seat page (copy creditsUsed and the time you read it).
	 * asOfMs is epoch ms. When it falls in the current month, it replaces the meter as the baseline.
	 */
	observed?: { creditsUsed: number; usdPerCredit: number; asOfMs: number };
	/**
	 * Fetches the seat figure from GitHub and uses it as the month-to-date baseline, in memory only.
	 * Absent means the extension never contacts GitHub and relies on the hand-written `observed`.
	 */
	seat?: SeatConfig;
}

export const CREDENTIAL_SOURCES = ["auto", "pi", "gh"] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

export interface SeatConfig {
	/** Minimum minutes between seat fetches. */
	refreshMinutes: number;
	/** "auto" tries Pi's own Copilot credential, then the gh CLI. */
	credential: CredentialSource;
}

export const DEFAULT_THRESHOLDS: Thresholds = { nudge: 0.7, warn: 0.8, prepare: 0.95, divert: 1 };

export const DEFAULT_SEAT: SeatConfig = { refreshMinutes: 15, credential: "auto" };

function str(v: unknown, name: string): string {
	if (typeof v !== "string" || v.length === 0) throw new Error(`budget config: ${name} must be a non-empty string`);
	return v;
}

function num(v: unknown, name: string): number {
	if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`budget config: ${name} must be a number`);
	return v;
}

function credentialSource(v: unknown, name: string): CredentialSource {
	if (v === undefined) return DEFAULT_SEAT.credential;
	if (typeof v === "string" && (CREDENTIAL_SOURCES as readonly string[]).includes(v)) return v as CredentialSource;
	throw new Error(`budget config: ${name} must be one of ${CREDENTIAL_SOURCES.join(", ")}`);
}

export function parseConfig(raw: unknown): BudgetConfig {
	if (typeof raw !== "object" || raw === null) throw new Error("budget config must be a JSON object");
	const r = raw as Record<string, unknown>;

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

	let observed: BudgetConfig["observed"];
	if (r.observed !== undefined) {
		const o = r.observed as Record<string, unknown>;
		if (typeof o !== "object" || o === null) throw new Error("budget config: observed must be an object");
		const creditsUsed = num(o.creditsUsed, "observed.creditsUsed");
		if (creditsUsed < 0) throw new Error("budget config: observed.creditsUsed must be >= 0");
		const usdPerCredit = o.usdPerCredit === undefined ? 0.01 : num(o.usdPerCredit, "observed.usdPerCredit");
		if (usdPerCredit <= 0) throw new Error("budget config: observed.usdPerCredit must be positive");
		const asOfMs = Date.parse(str(o.asOf, "observed.asOf"));
		if (Number.isNaN(asOfMs)) throw new Error("budget config: observed.asOf must be an ISO date");
		observed = { creditsUsed, usdPerCredit, asOfMs };
	}

	let seat: SeatConfig | undefined;
	if (r.seat !== undefined) {
		const s = r.seat as Record<string, unknown>;
		if (typeof s !== "object" || s === null) throw new Error("budget config: seat must be an object");
		const refreshMinutes = s.refreshMinutes === undefined ? DEFAULT_SEAT.refreshMinutes : num(s.refreshMinutes, "seat.refreshMinutes");
		if (refreshMinutes < 1) throw new Error("budget config: seat.refreshMinutes must be >= 1");
		seat = {
			refreshMinutes,
			credential: credentialSource(s.credential, "seat.credential"),
		};
	}

	return { provider: str(r.provider, "provider"), monthlyCapUsd, thresholds, localModel, localSubagents: ls as string[], observed, seat };
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

/** The seat figure behind github.com/settings/copilot/features. */
export interface SeatFigure {
	login: string;
	/** AI credits spent this month, as the settings page shows them. */
	creditsUsed: number;
	/** Credit allowance for the month. entitlement * usdPerCredit is the USD cap. */
	entitlement: number;
	remaining: number;
	/** When GitHub took the snapshot (premium_interactions.timestamp_utc). */
	asOfMs: number;
	/** Quota reset instant, 0 when absent. */
	resetDateMs: number;
	tokenBasedBilling: boolean;
}

/**
 * Reads the copilot_internal/user payload. Throws when the payload is not the expected shape, so a
 * GitHub-side change surfaces as a notification instead of a silently wrong budget.
 */
export function parseSeatFigure(raw: unknown): SeatFigure {
	if (typeof raw !== "object" || raw === null) throw new Error("seat payload must be a JSON object");
	const r = raw as Record<string, unknown>;
	const snaps = r.quota_snapshots;
	const pi = typeof snaps === "object" && snaps !== null ? (snaps as Record<string, unknown>).premium_interactions : undefined;
	if (typeof pi !== "object" || pi === null) throw new Error("seat payload has no quota_snapshots.premium_interactions");
	const p = pi as Record<string, unknown>;

	const creditsUsed = num(p.credits_used, "premium_interactions.credits_used");
	if (creditsUsed < 0) throw new Error("budget: premium_interactions.credits_used must be >= 0");
	const entitlement = num(p.entitlement, "premium_interactions.entitlement");
	if (entitlement <= 0) throw new Error("premium_interactions.entitlement is not positive: this seat is not on credit-based billing");

	const asOfMs = Date.parse(typeof p.timestamp_utc === "string" ? p.timestamp_utc : "");
	if (Number.isNaN(asOfMs)) throw new Error("premium_interactions.timestamp_utc is not a date");
	const resetDateMs = Date.parse(typeof r.quota_reset_date_utc === "string" ? r.quota_reset_date_utc : "");

	return {
		login: typeof r.login === "string" ? r.login : "",
		creditsUsed,
		entitlement,
		remaining: typeof p.remaining === "number" && Number.isFinite(p.remaining) ? p.remaining : 0,
		asOfMs,
		resetDateMs: Number.isNaN(resetDateMs) ? 0 : resetDateMs,
		tokenBasedBilling: r.token_based_billing === true,
	};
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
		if (e.isDirectory()) {
			// Transcripts duplicate child sessions (run-0/session.jsonl); counting both doubles subagent spend.
			if (e.name !== "subagent-artifacts") yield* jsonlFiles(p);
		} else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
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

export interface MonthSpend {
	spend: number;
	/** "live" = fetched seat figure, "calibrated" = hand-written observed, "meter" = Pi logs only. */
	source: "meter" | "calibrated" | "live";
	/** An observation exists but is from another month (or in the future), so it was not used. */
	observationIgnored: boolean;
}

/**
 * Month-to-date spend in USD. A live seat figure fetched from GitHub wins over the hand-written
 * `observed`. Either one, when it falls in the current month, is the baseline: it already counts Pi
 * and non-Pi usage up to its timestamp, and Pi-logged spend since then is added on top.
 */
export async function monthSpend(
	cfg: BudgetConfig,
	sessionsDir: string,
	now: Date = new Date(),
	live?: SeatFigure,
): Promise<MonthSpend> {
	const start = monthStartMs(now);
	const o = live
		? { creditsUsed: live.creditsUsed, usdPerCredit: cfg.observed?.usdPerCredit ?? 0.01, asOfMs: live.asOfMs }
		: cfg.observed;
	if (o && o.asOfMs >= start && o.asOfMs <= now.getTime()) {
		const local = await spendSince(sessionsDir, cfg.provider, o.asOfMs);
		const source = live ? "live" : "calibrated";
		return { spend: o.creditsUsed * o.usdPerCredit + local, source, observationIgnored: false };
	}
	return { spend: await spendSince(sessionsDir, cfg.provider, start), source: "meter", observationIgnored: o !== undefined };
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
