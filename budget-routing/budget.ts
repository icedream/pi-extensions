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

/** How a provider charges: a flat seat's credit pool, per-token billing, or nothing metered. */
export type Billing = "credits" | "metered" | "free";

/** Which calendar the provider's monthly reset follows. */
export type ResetZone = "local" | "utc";

export const ENFORCE_MODES = ["reject", "rewrite", "off"] as const;
export type EnforceMode = (typeof ENFORCE_MODES)[number];

/** Manual calibration from the provider's own usage page (copy the figure and the time you read it). */
export interface Observation {
	creditsUsed: number;
	usdPerCredit: number;
	/** Epoch ms. When it falls in the tracked month it replaces the meter as the baseline. */
	asOfMs: number;
}

export const CREDENTIAL_SOURCES = ["auto", "pi", "gh"] as const;
export type CredentialSource = (typeof CREDENTIAL_SOURCES)[number];

export interface SeatConfig {
	/** Minimum minutes between seat fetches. */
	refreshMinutes: number;
	/** "auto" tries Pi's own Copilot credential, then the gh CLI. */
	credential: CredentialSource;
}

/** One provider under observation. Absent monthlyCapUsd means it is tracked but never capped. */
export interface ProviderBudget {
	/** Provider name as recorded in Pi session logs, e.g. "github-copilot". */
	provider: string;
	monthlyCapUsd?: number;
	thresholds: Thresholds;
	reset: ResetZone;
	/** Overrides the billing shape derived from the model registry. */
	billing?: Billing;
	observed?: Observation;
	/** Fetches the seat figure from GitHub. Only honoured for the Copilot provider. */
	seat?: SeatConfig;
}

export interface AdvisoryConfig {
	/** Model references to list as routes. Empty means the ones Pi's agent settings already use. */
	models: string[];
	maxModels: number;
}

export interface LocalModel {
	provider: string;
	modelId: string;
	subagentRef: string;
}

export interface BudgetConfig {
	localModel: LocalModel;
	/** Agent names whose launches may run on the local model. */
	localSubagents: string[];
	thresholds: Thresholds;
	enforce: EnforceMode;
	advisory: AdvisoryConfig;
	providers: ProviderBudget[];
}

export const DEFAULT_THRESHOLDS: Thresholds = { nudge: 0.7, warn: 0.8, prepare: 0.95, divert: 1 };

export const DEFAULT_SEAT: SeatConfig = { refreshMinutes: 15, credential: "auto" };

export const DEFAULT_ADVISORY: AdvisoryConfig = { models: [], maxModels: 8 };

function str(v: unknown, name: string): string {
	if (typeof v !== "string" || v.length === 0) throw new Error(`budget config: ${name} must be a non-empty string`);
	return v;
}

function optNum(v: unknown, name: string): number | undefined {
	if (v === undefined) return undefined;
	return num(v, name);
}

function num(v: unknown, name: string): number {
	if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`budget config: ${name} must be a number`);
	return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string, dflt: T): T {
	if (v === undefined) return dflt;
	if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
	throw new Error(`budget config: ${name} must be one of ${allowed.join(", ")}`);
}

function credentialSource(v: unknown, name: string): CredentialSource {
	if (v === undefined) return DEFAULT_SEAT.credential;
	if (typeof v === "string" && (CREDENTIAL_SOURCES as readonly string[]).includes(v)) return v as CredentialSource;
	throw new Error(`budget config: ${name} must be one of ${CREDENTIAL_SOURCES.join(", ")}`);
}

export function parseThresholds(raw: unknown, name: string): Thresholds {
	const t = (raw ?? {}) as Record<string, unknown>;
	const thresholds: Thresholds = {
		nudge: t.nudge === undefined ? DEFAULT_THRESHOLDS.nudge : num(t.nudge, `${name}.nudge`),
		warn: t.warn === undefined ? DEFAULT_THRESHOLDS.warn : num(t.warn, `${name}.warn`),
		prepare: t.prepare === undefined ? DEFAULT_THRESHOLDS.prepare : num(t.prepare, `${name}.prepare`),
		divert: t.divert === undefined ? DEFAULT_THRESHOLDS.divert : num(t.divert, `${name}.divert`),
	};
	const order = [thresholds.nudge, thresholds.warn, thresholds.prepare, thresholds.divert];
	if (!order.every((v, i) => i === 0 || order[i - 1] <= v)) {
		throw new Error(`budget config: ${name} must be non-decreasing nudge <= warn <= prepare <= divert`);
	}
	return thresholds;
}

function parseObserved(raw: unknown, name: string): Observation | undefined {
	if (raw === undefined) return undefined;
	const o = raw as Record<string, unknown>;
	if (typeof o !== "object" || o === null) throw new Error(`budget config: ${name} must be an object`);
	const creditsUsed = num(o.creditsUsed, `${name}.creditsUsed`);
	if (creditsUsed < 0) throw new Error(`budget config: ${name}.creditsUsed must be >= 0`);
	const usdPerCredit = o.usdPerCredit === undefined ? 0.01 : num(o.usdPerCredit, `${name}.usdPerCredit`);
	if (usdPerCredit <= 0) throw new Error(`budget config: ${name}.usdPerCredit must be positive`);
	const asOfMs = Date.parse(str(o.asOf, `${name}.asOf`));
	if (Number.isNaN(asOfMs)) throw new Error(`budget config: ${name}.asOf must be an ISO date`);
	return { creditsUsed, usdPerCredit, asOfMs };
}

function parseSeat(raw: unknown, name: string): SeatConfig | undefined {
	if (raw === undefined) return undefined;
	const s = raw as Record<string, unknown>;
	if (typeof s !== "object" || s === null) throw new Error(`budget config: ${name} must be an object`);
	const refreshMinutes = s.refreshMinutes === undefined ? DEFAULT_SEAT.refreshMinutes : num(s.refreshMinutes, `${name}.refreshMinutes`);
	if (refreshMinutes < 1) throw new Error(`budget config: ${name}.refreshMinutes must be >= 1`);
	return { refreshMinutes, credential: credentialSource(s.credential, `${name}.credential`) };
}

function parseProvider(raw: unknown, shared: Thresholds): ProviderBudget {
	const r = raw as Record<string, unknown>;
	const name = str(r.provider, "provider");
	const monthlyCapUsd = optNum(r.monthlyCapUsd, `${name}.monthlyCapUsd`);
	if (monthlyCapUsd !== undefined && monthlyCapUsd <= 0) throw new Error(`budget config: ${name}.monthlyCapUsd must be positive`);
	const billing = r.billing === undefined ? undefined : oneOf<Billing>(r.billing, ["credits", "metered", "free"] as const, `${name}.billing`, "metered");
	return {
		provider: name,
		monthlyCapUsd,
		thresholds: shared,
		reset: oneOf(r.reset, ["local", "utc"], `${name}.reset`, "local"),
		billing,
		observed: parseObserved(r.observed, `${name}.observed`),
		seat: parseSeat(r.seat, `${name}.seat`),
	};
}

export function parseConfig(raw: unknown): BudgetConfig {
	if (typeof raw !== "object" || raw === null) throw new Error("budget config must be a JSON object");
	const r = raw as Record<string, unknown>;

	const thresholds = parseThresholds(r.thresholds, "thresholds");

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

	const advisory = parseAdvisory(r.advisory);

	// v1 files carry one provider at the top level. A file may not mix that with a providers array.
	let providers: unknown[];
	if (Array.isArray(r.providers)) {
		if (typeof r.provider === "string") throw new Error("budget config: use either provider or providers, not both");
		providers = r.providers;
	} else if (r.provider !== undefined) {
		providers = [r];
	} else {
		throw new Error("budget config: providers must be a non-empty array");
	}
	if (providers.length === 0) throw new Error("budget config: providers must be a non-empty array");

	const parsed = providers.map((p) => parseProvider(p, thresholds));
	const seen = new Set<string>();
	for (const p of parsed) {
		if (seen.has(p.provider)) throw new Error(`budget config: duplicate provider ${p.provider}`);
		seen.add(p.provider);
	}

	return { localModel, localSubagents: ls as string[], thresholds, enforce: oneOf(r.enforce, ENFORCE_MODES, "enforce", "reject"), advisory, providers: parsed };
}

function parseAdvisory(raw: unknown): AdvisoryConfig {
	if (raw === undefined) return { ...DEFAULT_ADVISORY };
	const a = raw as Record<string, unknown>;
	if (typeof a !== "object" || a === null) throw new Error("budget config: advisory must be an object");
	const models = a.models === undefined ? [] : a.models;
	if (!Array.isArray(models) || !models.every((x) => typeof x === "string")) {
		throw new Error("budget config: advisory.models must be an array of model references");
	}
	const maxModels = a.maxModels === undefined ? DEFAULT_ADVISORY.maxModels : num(a.maxModels, "advisory.maxModels");
	if (maxModels < 1) throw new Error("budget config: advisory.maxModels must be >= 1");
	return { models: models as string[], maxModels: Math.floor(maxModels) };
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

/**
 * Start of the month containing `now`. A provider that resets on the 1st UTC needs the UTC
 * components; reading local ones and passing them to Date.UTC is off by the offset at the month edges.
 */
export function monthStartMs(now: Date = new Date(), zone: ResetZone = "local"): number {
	if (zone === "utc") return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
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

/**
 * Sum of Pi-estimated cost for assistant messages in each window, over one walk of the session tree.
 * A window is a provider plus a start time, so mixing reset zones or a baseline tail costs one read
 * rather than one tree walk per provider.
 */
export async function spendByWindow(sessionsDir: string, windows: { key: string; provider: string; sinceMs: number }[]): Promise<Map<string, number>> {
	const totals = new Map<string, number>();
	for (const w of windows) totals.set(w.key, 0);
	const floor = Math.min(...windows.map((w) => w.sinceMs));
	if (!Number.isFinite(floor)) return totals;

	for await (const fp of jsonlFiles(sessionsDir)) {
		if ((await stat(fp)).mtimeMs < floor) continue; // file untouched since the earliest window started
		const text = await readFile(fp, "utf8");
		for (const line of text.split("\n")) {
			if (!line.includes('"role":"assistant"')) continue;
			let m: AssistantMessage | undefined;
			try {
				m = JSON.parse(line).message as AssistantMessage | undefined;
			} catch {
				continue;
			}
			if (!m || m.role !== "assistant") continue;
			const ts = m.timestamp ?? 0;
			for (const w of windows) {
				if (w.provider !== m.provider || ts < w.sinceMs) continue;
				totals.set(w.key, (totals.get(w.key) ?? 0) + (m.usage?.cost?.total ?? 0));
			}
		}
	}
	return totals;
}

/** Sum of Pi-estimated cost for assistant messages from `provider` at or after `sinceMs`. */
export async function spendSince(sessionsDir: string, provider: string, sinceMs: number): Promise<number> {
	return (await spendByWindow(sessionsDir, [{ key: provider, provider, sinceMs }])).get(provider) ?? 0;
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
 * `observed`. Either one, when it falls in the tracked month, is the baseline: it already counts Pi
 * and non-Pi usage up to its timestamp, and Pi-logged spend since then is added on top.
 */
export async function monthSpend(
	pb: ProviderBudget,
	sessionsDir: string,
	now: Date = new Date(),
	live?: SeatFigure,
): Promise<MonthSpend> {
	const start = monthStartMs(now, pb.reset);
	const o = live
		? { creditsUsed: live.creditsUsed, usdPerCredit: pb.observed?.usdPerCredit ?? 0.01, asOfMs: live.asOfMs }
		: pb.observed;
	if (o && o.asOfMs >= start && o.asOfMs <= now.getTime()) {
		const local = await spendSince(sessionsDir, pb.provider, o.asOfMs);
		const source = live ? "live" : "calibrated";
		return { spend: o.creditsUsed * o.usdPerCredit + local, source, observationIgnored: false };
	}
	return { spend: await spendSince(sessionsDir, pb.provider, start), source: "meter", observationIgnored: o !== undefined };
}

/**
 * Month-to-date spend for every configured provider in one walk. A provider with a live or in-month
 * hand-written baseline needs only the tail after that snapshot, which is a second window on the same
 * provider rather than a second walk.
 */
export async function monthSpendAll(
	cfg: BudgetConfig,
	sessionsDir: string,
	now: Date = new Date(),
	live?: Map<string, SeatFigure>,
): Promise<Map<string, MonthSpend>> {
	const baseline = new Map<string, Observation>();
	const windows: { key: string; provider: string; sinceMs: number }[] = [];
	for (const pb of cfg.providers) {
		const start = monthStartMs(now, pb.reset);
		const fig = live?.get(pb.provider);
		const o = fig ? { creditsUsed: fig.creditsUsed, usdPerCredit: pb.observed?.usdPerCredit ?? 0.01, asOfMs: fig.asOfMs } : pb.observed;
		const usable = o !== undefined && o.asOfMs >= start && o.asOfMs <= now.getTime();
		if (o && usable) baseline.set(pb.provider, o);
		windows.push({ key: pb.provider, provider: pb.provider, sinceMs: usable ? o!.asOfMs : start });
	}
	const walk = await spendByWindow(sessionsDir, windows);
	const out = new Map<string, MonthSpend>();
	for (const pb of cfg.providers) {
		const o = baseline.get(pb.provider);
		const tail = walk.get(pb.provider) ?? 0;
		if (o) {
			const source: MonthSpend["source"] = live?.has(pb.provider) ? "live" : "calibrated";
			out.set(pb.provider, { spend: o.creditsUsed * o.usdPerCredit + tail, source, observationIgnored: false });
		} else {
			const stale = pb.observed !== undefined || live?.has(pb.provider) === true;
			out.set(pb.provider, { spend: tail, source: "meter", observationIgnored: stale });
		}
	}
	return out;
}

export interface ProviderStatus {
	provider: string;
	billing: Billing;
	/** undefined when the entry sets no cap: tracked, never limited. */
	capUsd?: number;
	spend: number;
	/** Fraction of the cap, undefined when uncapped. */
	frac?: number;
	/** usdPerCredit-style percentage, rounded, undefined when uncapped. */
	pct?: number;
	tier: Tier;
	headroomUsd?: number;
	source: MonthSpend["source"];
	observationIgnored: boolean;
}

/** Billing shape for a provider: the config wins, otherwise a Copilot seat is credits and a zero-priced model is free. */
export function billingFor(pb: ProviderBudget, models: readonly RegistryModelLike[]): Billing {
	if (pb.billing) return pb.billing;
	if (pb.provider === "github-copilot") return "credits";
	const mine = models.filter((m) => m.provider === pb.provider);
	if (mine.length > 0 && mine.every((m) => isZeroCost(m))) return "free";
	return "metered";
}

export function providerStatus(pb: ProviderBudget, m: MonthSpend, billing: Billing): ProviderStatus {
	const s: ProviderStatus = {
		provider: pb.provider,
		billing,
		capUsd: pb.monthlyCapUsd,
		spend: m.spend,
		tier: "ok",
		source: m.source,
		observationIgnored: m.observationIgnored,
	};
	if (pb.monthlyCapUsd !== undefined) {
		s.frac = m.spend / pb.monthlyCapUsd;
		s.pct = Math.round(s.frac * 100);
		s.tier = tierFor(s.frac, pb.thresholds);
		s.headroomUsd = Math.max(0, pb.monthlyCapUsd - m.spend);
	}
	return s;
}

export function tierFor(frac: number, t: Thresholds): Tier {
	if (frac >= t.divert) return "divert";
	if (frac >= t.prepare) return "prepare";
	if (frac >= t.warn) return "warn";
	if (frac >= t.nudge) return "nudge";
	return "ok";
}

export const TIERS: Tier[] = ["ok", "nudge", "warn", "prepare", "divert"];

/** The most severe tier in a set, used for the "what does an unattributable launch count as" reading. */
export function worstTier(tiers: Iterable<Tier>): Tier {
	let worst: Tier = "ok";
	for (const t of tiers) if (TIERS.indexOf(t) > TIERS.indexOf(worst)) worst = t;
	return worst;
}

export interface CompactionStep {
	/** Whether agent_end should call ctx.compact() now. */
	compact: boolean;
	/** New value for the once-per-crossing flag of that provider. */
	compacted: boolean;
}

/**
 * The pre-switch compaction decision for the provider the session is running on. ctx.compact()
 * summarizes with the current model, so a session on a provider that is not over its own cap neither
 * compacts nor consumes the flag. Keyed per provider on purpose: an over-cap provider elsewhere must
 * not compact a session that is spending a healthy one.
 */
export function preSwitchCompactionStep(session: ProviderStatus | undefined, compacted: boolean): CompactionStep {
	if (!session) return { compact: false, compacted };
	if (session.tier !== "prepare" && session.tier !== "divert") return { compact: false, compacted: false };
	if (compacted) return { compact: false, compacted: true };
	return { compact: true, compacted: true };
}

export const STATUS_COLORS: Record<Tier, "dim" | "accent" | "warning" | "error"> = {
	ok: "dim",
	nudge: "accent",
	warn: "warning",
	prepare: "warning",
	divert: "error",
};

const SHORT_NAMES: Record<string, string> = { "github-copilot": "copilot" };

export function shortName(provider: string): string {
	return SHORT_NAMES[provider] ?? provider;
}

/**
 * Compact footer indicator, e.g. "copilot 92%". A leading ~ marks an estimate from Pi's own logs
 * rather than the provider's own figure; the trailing marker names the tier once it matters. An
 * entry with no cap shows its spend instead of a percentage.
 */
export function statusLabel(s: ProviderStatus): { text: string; color: "dim" | "accent" | "warning" | "error" } {
	const name = shortName(s.provider);
	if (s.capUsd === undefined) return { text: `${name} ${usd(s.spend)}`, color: "dim" };
	const estimate = s.source === "meter" ? "~" : "";
	const mark = s.tier === "prepare" ? " !" : s.tier === "divert" ? " over" : "";
	return { text: `${name} ${estimate}${s.pct}%${mark}`, color: STATUS_COLORS[s.tier] };
}

function usd(v: number): string {
	return `$${v.toFixed(2)}`;
}

const THINKING_SUFFIXES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Removes a trailing `:level` thinking suffix, the way the subagent tool does before resolving a model. */
export function stripThinkingSuffix(ref: string): string {
	const i = ref.lastIndexOf(":");
	if (i === -1) return ref;
	return THINKING_SUFFIXES.includes(ref.slice(i + 1)) ? ref.slice(0, i) : ref;
}

/**
 * Model references from Pi's `subagents.agentOverrides`: the models agents actually inherit, so they
 * are the realistic routing menu. Malformed or missing settings yield an empty list.
 */
export function parseAgentOverrideModels(raw: unknown): string[] {
	if (typeof raw !== "object" || raw === null) return [];
	const sub = (raw as Record<string, unknown>).subagents;
	const ov = typeof sub === "object" && sub !== null ? (sub as Record<string, unknown>).agentOverrides : undefined;
	if (typeof ov !== "object" || ov === null) return [];
	const out: string[] = [];
	for (const v of Object.values(ov)) {
		const model = typeof v === "object" && v !== null ? (v as Record<string, unknown>).model : undefined;
		if (typeof model === "string" && model.length > 0) out.push(model);
	}
	return out;
}

/**
 * Route menu for the advisory and the budget tool. The configured `advisory.models` list wins;
 * otherwise the local model plus the models the agent settings already point at, plus whatever the
 * session is on. Deduped on the reference without its thinking suffix, capped at `maxModels`.
 */
export function menuModelRefs(cfg: BudgetConfig, overrides: readonly string[], sessionModelRef?: string): string[] {
	const refs = cfg.advisory.models.length > 0 ? [...cfg.advisory.models] : [cfg.localModel.subagentRef, ...overrides];
	if (sessionModelRef) refs.push(sessionModelRef);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of refs) {
		const key = stripThinkingSuffix(r);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(r);
	}
	return out.slice(0, cfg.advisory.maxModels);
}

export interface RegistryModelLike {
	provider: string;
	id: string;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
}

/**
 * Provider that a subagent `model` reference resolves to. Mirrors the subagent tool: an exact
 * `provider/id` match wins, otherwise a bare id counts when exactly one known model has it. Provider
 * names may themselves contain slashes (`icedream-homepc/strata`), so matching is against full ids
 * rather than a split on the first slash. undefined when the reference is unknown or ambiguous.
 */
export function providerForModelRef(ref: string, models: readonly RegistryModelLike[]): string | undefined {
	const base = stripThinkingSuffix(ref.trim());
	if (!base) return undefined;
	const exact = models.find((m) => `${m.provider}/${m.id}` === base);
	if (exact) return exact.provider;
	const byId = models.filter((m) => m.id === base);
	return byId.length === 1 ? byId[0].provider : undefined;
}

interface Cost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function costIsZero(c?: Cost): boolean {
	return !c || (c.input === 0 && c.output === 0 && c.cacheRead === 0 && c.cacheWrite === 0);
}

function isZeroCost(m: RegistryModelLike): boolean {
	return costIsZero(m.cost);
}

function trim(v: number): string {
	return Number(v.toFixed(4)).toString();
}

/** List price of a model in USD per million tokens, as Pi's registry records it. */
export function formatCost(m: RegistryModelLike | undefined): string {
	if (!m) return "price unknown";
	if (!m || !m.cost || costIsZero(m.cost)) return "no per-token charge";
	const c = m.cost;
	const cache = c.cacheRead === 0 && c.cacheWrite === 0 ? "" : `, cache r${trim(c.cacheRead)}/w${trim(c.cacheWrite)}`;
	return `$${trim(c.input)}/$${trim(c.output)} per Mtok${cache}`;
}

function pricePair(cost?: Cost): [string, string] {
	if (!cost || costIsZero(cost)) return ["-", "-"];
	const cache = cost.cacheRead === 0 && cost.cacheWrite === 0 ? "-" : `${trim(cost.cacheRead)}/${trim(cost.cacheWrite)}`;
	return [`${trim(cost.input)}/${trim(cost.output)}`, cache];
}

export interface Route {
	ref: string;
	provider: string;
	billing: Billing;
	/** Prose price, as a rejection message reads it. */
	price: string;
	/** USD per million tokens, in/out, for the table column. */
	inOut: string;
	cachePair: string;
	ctxLabel?: string;
	/** undefined when the route's provider is not tracked. */
	status?: ProviderStatus;
	note?: string;
}

/**
 * One route per menu reference, ordered the way a routing decision reads: paid routes with room left
 * by price, then tracked providers with no cap, then the local model last and labelled as such. An
 * over-cap provider stays visible with its tier so the model can see what to avoid.
 */
export function buildRoutes(
	refs: string[],
	models: readonly RegistryModelLike[],
	statuses: readonly ProviderStatus[],
	localRef: string,
): Route[] {
	const routes: Route[] = [];
	for (const ref of refs) {
		const base = stripThinkingSuffix(ref);
		const model = models.find((m) => `${m.provider}/${m.id}` === base) ?? models.find((m) => m.id === base);
		const provider = model?.provider ?? providerForModelRef(ref, models);
		// A reference the registry does not know stays in the menu with an unknown price: a typo in
		// advisory.models should be visible, not silently dropped.
		const unknown = provider === undefined;
		const status = unknown ? undefined : statuses.find((s) => s.provider === (provider as string));
		const billing = status?.billing ?? (model ? (isZeroCost(model) ? "free" : "metered") : "metered");
		routes.push({
			ref,
			provider: provider ?? "",
			billing,
			price: unknown ? "price unknown" : formatCost(model),
			inOut: pricePair(model?.cost)[0],
			cachePair: pricePair(model?.cost)[1],
			ctxLabel: model?.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : undefined,
			status,
			note: unknown ? "not in the model registry" : ref === localRef ? "last resort: self-hosted, cold start" : undefined,
		});
	}
	const rank = (r: Route): number => {
		if (r.ref === localRef || r.billing === "free") return 3;
		if (r.status === undefined) return 2;
		if (r.status.tier === "divert") return 4;
		return r.status.capUsd === undefined ? 2 : 1;
	};
	const priceOf = (r: Route): number => {
		const m = models.find((x) => stripThinkingSuffix(r.ref) === `${x.provider}/${x.id}`);
		const c = m?.cost;
		return c ? c.input + c.output : Number.MAX_SAFE_INTEGER;
	};
	return routes.sort((a, b) => rank(a) - rank(b) || priceOf(a) - priceOf(b) || a.ref.localeCompare(b.ref));
}

function pad(v: string, w: number): string {
	return v.length >= w ? v : v + " ".repeat(w - v.length);
}

function headroomLabel(s: ProviderStatus | undefined): string {
	if (!s) return "not tracked";
	if (s.capUsd === undefined) return "no cap";
	if (s.tier === "divert") return "over cap";
	return `${Math.max(0, Math.round(((s.capUsd - s.spend) / s.capUsd) * 100))}% left`;
}

/** Column widths come from the data, so a $1000000 cap does not shift the rest of the row. */
function renderTable(headers: string[], rows: string[][]): string {
	const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
	const line = (cells: string[]) => cells.map((c, i) => pad(c, w[i])).join("  ").trimEnd();
	return [line(headers), ...rows.map(line)].join("\n");
}

/** The table every budget surface shows: cap state per provider, then priced routes. */
export function costTable(statuses: readonly ProviderStatus[], routes: readonly Route[]): string {
	const providerRows = statuses.map((s) => [
		shortName(s.provider),
		s.billing,
		s.capUsd === undefined ? "none" : usd(s.capUsd),
		usd(s.spend),
		s.pct === undefined ? "-" : `${s.pct}%`,
		headroomLabel(s),
		s.source,
	]);
	const out = [renderTable(["provider", "billing", "cap", "spent", "pct", "headroom", "figure"], providerRows)];
	if (routes.length > 0) {
		const routeRows = routes.map((r) => [r.ref, r.billing, r.inOut, r.cachePair, r.ctxLabel ?? "-", headroomLabel(r.status) + (r.note ? `  (${r.note})` : "")]);
		out.push("", renderTable(["route", "billing", "$/Mtok in/out", "cache r/w", "ctx", "provider room"], routeRows));
	}
	return out.join("\n");
}

export const TIER_LABELS: Record<Tier, string> = {
	ok: "under cap",
	nudge: "filling",
	warn: "high",
	prepare: "nearly over",
	divert: "over cap",
};

/**
 * The `<budget>` prompt section. Deliberately free of live numbers: it only changes when a tier
 * changes, so Pi sends a prompt patch instead of rewriting the leading system message every turn,
 * which would cost a full cache miss on providers that bill cached prefixes cheaper.
 */
export function advisorySection(statuses: readonly ProviderStatus[], localRef: string, toolName: string): string {
	if (statuses.length === 0) return "";
	const parts = statuses.map((s) => {
		if (s.capUsd === undefined) return `${shortName(s.provider)} ${s.billing}, no cap`;
		return `${shortName(s.provider)} ${s.billing}, ${TIER_LABELS[s.tier]}`;
	});
	return (
		`Budget: ${parts.join("; ")}. ` +
		`Call ${toolName} with action "models" for the price and headroom table before routing work to another model. ` +
		`A launch that would spend a provider over its cap is rejected with the open routes listed, so re-queue the same task on one of them. ` +
		`${localRef} is the last resort, not the default.`
	);
}

export interface DivertOptions {
	/** What a divert does to a launch. */
	mode: EnforceMode;
	/** Agent names that may run on the local model. */
	localSubagents: string[];
	/** Model reference written to diverted launches. */
	subagentRef: string;
	/** Tier of every configured provider that has a cap. Providers not in here are unlimited. */
	tiers: Record<string, Tier>;
	/** Provider of the current session model: what a launch with no explicit model inherits. */
	sessionProvider?: string;
	/** Known registry models, used to attribute an explicit `model` reference to a provider. */
	models?: readonly RegistryModelLike[];
}

export interface RejectedLaunch {
	label: string;
	/** Provider the launch spends, undefined when the model reference could not be attributed. */
	provider?: string;
}

export interface DivertResult {
	/** Launches whose model was rewritten to the local subagent reference. */
	rewritten: number;
	/** Launches that spend an over-cap provider and are not rewritten. */
	rejected: RejectedLaunch[];
	/** Launches that spend a provider which is not over its cap. */
	passed: string[];
}

/**
 * Decides what happens to each subagent launch at divert. A launch is only a candidate when the
 * provider it will use is over its cap: an explicit `model` from another provider is left alone, and
 * so is a launch inheriting a session model from another provider. An explicit model that cannot be
 * attributed to a known model takes the worst tier among the capped providers, the safe reading.
 * `mode` says what happens to a candidate: "reject" leaves every model choice to the model and reports
 * it, "rewrite" points local-eligible agents at the local model. Management actions (no agent and no
 * task) are left alone.
 */
export function applyDivert(input: unknown, opts: DivertOptions): DivertResult {
	type Launch = { agent?: unknown; task?: unknown; model?: unknown };
	const root = (input ?? {}) as Launch & { tasks?: unknown };
	const launches: Launch[] = Array.isArray(root.tasks) ? (root.tasks as Launch[]) : [root];
	const result: DivertResult = { rewritten: 0, rejected: [], passed: [] };
	if (opts.mode === "off") return result;

	const capped = Object.entries(opts.tiers);
	const diverting = capped.filter(([, t]) => t === "divert").map(([p]) => p);
	const worst = worstTier(capped.map(([, t]) => t));

	for (const l of launches) {
		const agent = typeof l.agent === "string" ? l.agent : undefined;
		if (agent === undefined && l.task === undefined) continue;
		const label = agent ?? "(no agent)";
		const ref = typeof l.model === "string" ? l.model : undefined;
		let provider: string | undefined;
		let over = false;
		if (ref !== undefined) {
			provider = providerForModelRef(ref, opts.models ?? []);
			// An explicit model that cannot be attributed, like a model that cannot be resolved at all,
			// takes the worst tier among the capped providers: the safe reading.
			over = provider === undefined ? worst === "divert" : diverting.includes(provider);
		} else {
			provider = opts.sessionProvider;
			over = provider === undefined ? worst === "divert" : diverting.includes(provider);
		}
		if (!over) {
			result.passed.push(label);
			continue;
		}
		if (opts.mode === "rewrite" && agent !== undefined && opts.localSubagents.includes(agent)) {
			l.model = opts.subagentRef;
			result.rewritten++;
		} else {
			result.rejected.push({ label, provider });
		}
	}
	return result;
}

/**
 * The error a rejected launch gets back. It names the cap, and lists the routes that are open with
 * their price, so the model can re-queue the same task instead of guessing.
 */
export function rejectReason(result: DivertResult, statuses: readonly ProviderStatus[], routes: readonly Route[], localRef: string): string {
	const over = statuses.filter((s) => s.tier === "divert").map((s) => `${shortName(s.provider)} ${s.pct}%`);
	const open = routes
		.filter((r) => r.ref !== localRef && r.status && r.status.tier !== "divert")
		.slice(0, 4)
		.map((r) => `${r.ref} (${r.price}, ${headroomLabel(r.status)})`);
	const blocked = result.rejected.map((r) => (r.provider ? `${r.label} -> ${r.provider}` : `${r.label} -> unattributable model`));
	return (
		`budget-routing: over the monthly cap on ${over.join(", ")}. Blocked launches: ${blocked.join(", ")}. ` +
		`Re-queue each task on an open route: ${open.length > 0 ? open.join("; ") : "none with headroom"}. ` +
		`Local fallback: ${localRef}.`
	);
}
