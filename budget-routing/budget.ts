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

export interface BalanceConfig {
	/** Minimum minutes between wallet fetches. */
	refreshMinutes: number;
}

export const USAGE_SOURCES = ["gcp-quota"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

/**
 * A provider-side counter for a provider whose bill this machine cannot read. It is displayed only:
 * caps and tiers stay USD, so a counter never diverts a launch.
 */
export interface UsageConfig {
	refreshMinutes: number;
	source: UsageSource;
	/** GCP project whose quota is read. Set either this or `projectEnv`, never both meanings at once. */
	project?: string;
	/** Name of an environment variable holding the project, for a config file shared between machines. */
	projectEnv?: string;
	/** Quota metric label value, e.g. "generativelanguage.googleapis.com/api_requests". */
	quotaMetric: string;
}

export const DEFAULT_USAGE: Omit<UsageConfig, "source" | "project"> = {
	refreshMinutes: 15,
	quotaMetric: "generativelanguage.googleapis.com/api_requests",
};

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
	/**
	 * Fetches the provider's own wallet figure. Only honoured for the `opper` provider, the same way
	 * `seat` is only honoured for Copilot: a provider renamed locally gets no figure.
	 */
	balance?: BalanceConfig;
	/** A request counter instead of a money figure, for a provider with no readable bill. */
	usage?: UsageConfig;
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
export const DEFAULT_BALANCE: BalanceConfig = { refreshMinutes: 15 };

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

function parseBalance(raw: unknown, name: string): BalanceConfig | undefined {
	if (raw === undefined) return undefined;
	const b = raw as Record<string, unknown>;
	if (typeof b !== "object" || b === null) throw new Error(`budget config: ${name} must be an object`);
	const refreshMinutes = b.refreshMinutes === undefined ? DEFAULT_BALANCE.refreshMinutes : num(b.refreshMinutes, `${name}.refreshMinutes`);
	if (refreshMinutes < 1) throw new Error(`budget config: ${name}.refreshMinutes must be >= 1`);
	return { refreshMinutes };
}

function parseUsage(raw: unknown, name: string): UsageConfig | undefined {
	if (raw === undefined) return undefined;
	const u = raw as Record<string, unknown>;
	if (typeof u !== "object" || u === null) throw new Error(`budget config: ${name} must be an object`);
	const refreshMinutes = u.refreshMinutes === undefined ? DEFAULT_USAGE.refreshMinutes : num(u.refreshMinutes, `${name}.refreshMinutes`);
	if (refreshMinutes < 1) throw new Error(`budget config: ${name}.refreshMinutes must be >= 1`);
	const project = u.project === undefined ? undefined : str(u.project, `${name}.project`);
	const projectEnv = u.projectEnv === undefined ? undefined : str(u.projectEnv, `${name}.projectEnv`);
	if (project === undefined && projectEnv === undefined) throw new Error(`budget config: ${name} needs project or projectEnv`);
	return {
		refreshMinutes,
		source: oneOf<UsageSource>(u.source, USAGE_SOURCES, `${name}.source`, "gcp-quota"),
		...(project === undefined ? {} : { project }),
		...(projectEnv === undefined ? {} : { projectEnv }),
		quotaMetric: u.quotaMetric === undefined ? DEFAULT_USAGE.quotaMetric : str(u.quotaMetric, `${name}.quotaMetric`),
	};
}

/** The project a counter reads: the literal, else the variable named by `projectEnv`. */
export function usageProject(cfg: UsageConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (cfg.project) return cfg.project;
	return cfg.projectEnv ? env[cfg.projectEnv] || undefined : undefined;
}

/**
 * The entries this machine can be billed on. Presence in the model catalog is not enough: Pi registers
 * the built-in catalog of providers that have no credential here, and those never spend from this box.
 */
export function trackedProviders<T extends { provider: string }>(entries: readonly T[], authConfigured: Iterable<string>): T[] {
	const authed = new Set(authConfigured);
	return entries.filter((e) => authed.has(e.provider));
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
		balance: parseBalance(r.balance, `${name}.balance`),
		usage: parseUsage(r.usage, `${name}.usage`),
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

/** Opper's wallet snapshot, the shape `GET https://api.opper.ai/v3/me` answers with. */
export interface BalanceFigure {
	/** Money left in the account. Can be negative when usage overshoots the last top-up. */
	balanceUsd: number;
	/** Billed so far in the provider's own billing period. */
	spendUsd: number;
	/** A spend-limit rule the provider enforces itself. Absent when the account has none. */
	limitUsd?: number;
	periodStartMs: number;
	/** Infinity for a `total` budget, which has no period end. */
	periodEndMs: number;
	blocked: boolean;
	blockReason?: string;
}

/**
 * Reads a /v3/me payload. The organization-wide fields are only there for a key with the
 * `billing:read` permission, so a key without it is an error rather than a silently wrong budget.
 * `project_spend` and `member_spend` are deliberately ignored: they cover a narrower scope than the
 * balance, and mixing them would compare a project's spend against the whole organization's money.
 */
export function parseBalanceFigure(raw: unknown): BalanceFigure {
	if (typeof raw !== "object" || raw === null) throw new Error("balance payload must be a JSON object");
	const r = raw as Record<string, unknown>;
	const visibility = r.visibility as Record<string, unknown> | undefined;
	if (visibility?.organization_finance !== true) {
		throw new Error("/v3/me reported no organization finance: this API key lacks the billing:read permission");
	}
	const spend = r.spend as Record<string, unknown> | undefined;
	if (typeof spend !== "object" || spend === null) throw new Error("/v3/me has no organization spend block");
	const balance = r.balance as Record<string, unknown> | undefined;
	if (typeof balance !== "object" || balance === null) throw new Error("/v3/me has no organization balance block");

	const spendUsd = num(spend.spent_cents, "spend.spent_cents") / 100;
	// Negative is a real state: usage that overshot the last top-up. Clamping happens at the cap.
	const balanceUsd = num(balance.balance_cents, "balance.balance_cents") / 100;
	const limitUsd = spend.limit_cents === undefined || spend.limit_cents === null ? undefined : num(spend.limit_cents, "spend.limit_cents") / 100;
	const periodStartMs = Date.parse(typeof spend.period_start === "string" ? spend.period_start : "");
	if (Number.isNaN(periodStartMs)) throw new Error("spend.period_start is not a date");
	const periodEndMs = Date.parse(typeof spend.period_end === "string" ? spend.period_end : "");

	return {
		spendUsd,
		balanceUsd,
		...(limitUsd === undefined ? {} : { limitUsd }),
		periodStartMs,
		periodEndMs: Number.isNaN(periodEndMs) ? Number.POSITIVE_INFINITY : periodEndMs,
		blocked: r.blocked === true,
		...(typeof r.block_reason === "string" ? { blockReason: r.block_reason } : {}),
	};
}

/** A counter read from the provider's own meter, in the provider's own unit rather than dollars. */
export interface UsageCounter {
	requests: number;
	/** What contributed to the total, so a spike is attributable without a second query. */
	byMethod: Array<{ method: string; requests: number }>;
	periodStartMs: number;
	asOfMs: number;
}

export const QUOTA_METRIC_TYPE = "serviceruntime.googleapis.com/quota/rate/net_usage";

/**
 * Sums Cloud Monitoring quota-usage points inside the tracked month. Points before the period start are
 * dropped rather than clamped: the fetch window is wider than the month at the edges, and clamping would
 * count a boundary point in two periods.
 */
export function parseQuotaUsage(raw: unknown, opts: { quotaMetric: string; periodStartMs: number; asOfMs: number }): UsageCounter {
	if (typeof raw !== "object" || raw === null) throw new Error("quota payload must be a JSON object");
	const series = (raw as Record<string, unknown>).timeSeries;
	if (series !== undefined && !Array.isArray(series)) throw new Error("quota payload has no timeSeries array");
	const byMethod = new Map<string, number>();
	let requests = 0;
	for (const ts of (series ?? []) as Array<Record<string, unknown>>) {
		const metric = ts.metric as Record<string, unknown> | undefined;
		const labels = (metric?.labels ?? {}) as Record<string, unknown>;
		if (metric?.type !== QUOTA_METRIC_TYPE || labels.quota_metric !== opts.quotaMetric) continue;
		const method = typeof labels.method === "string" && labels.method !== "" ? labels.method : "unspecified";
		const points = ts.points;
		if (!Array.isArray(points)) continue;
		for (const p of points as Array<Record<string, unknown>>) {
			const start = Date.parse(((p.interval as Record<string, unknown> | undefined)?.startTime ?? "") as string);
			if (Number.isNaN(start) || start < opts.periodStartMs) continue;
			const value = p.value as Record<string, unknown> | undefined;
			const n = Number(value?.int64Value);
			if (!Number.isFinite(n) || n < 0) continue;
			requests += n;
			byMethod.set(method, (byMethod.get(method) ?? 0) + n);
		}
	}
	return {
		requests,
		byMethod: [...byMethod.entries()].map(([method, count]) => ({ method, requests: count })).sort((a, b) => b.requests - a.requests),
		periodStartMs: opts.periodStartMs,
		asOfMs: opts.asOfMs,
	};
}

/**
 * A usage figure fetched from the provider itself. The Copilot seat and the Opper wallet both
 * normalize into this, so the meter, the cap and the validity rule live in one place.
 */
export interface LiveFigure {
	spendUsd: number;
	/** Money left, for display. Only a wallet figure has one. */
	balanceUsd?: number;
	/** Seat: the credit allowance. Wallet: money spent plus money left. */
	hardCapUsd?: number;
	/** A ceiling the provider enforces itself, such as Opper's Spend limit rule. */
	limitUsd?: number;
	asOfMs: number;
	/** The provider's own billing period. A figure outside it is ignored. */
	validFromMs: number;
	validUntilMs: number;
	/** Inside its period, a figure older than this is ignored too: a fetch that keeps failing must not pin the budget to an old number. */
	staleAfterMs: number;
	/**
	 * Whether the figure may set a cap. A wallet's remaining money is a hard ceiling. A seat's
	 * entitlement is not: your own `monthlyCapUsd` stays the number, and a disagreement between the
	 * two is reported as drift instead of silently overriding it.
	 */
	caps: boolean;
	blocked?: boolean;
	blockReason?: string;
	label: "seat" | "balance";
	/** One line for the refresh command, worded by whoever fetched the figure. */
	detail: string;
}

/** A figure only counts while it is recent, inside the provider's own period, and not from the future. */
export function figureUsable(f: LiveFigure, now: Date = new Date()): boolean {
	const at = now.getTime();
	return f.asOfMs <= at && f.asOfMs >= f.validFromMs && at < f.validUntilMs && at - f.asOfMs <= f.staleAfterMs;
}

export function seatLiveFigure(f: SeatFigure, usdPerCredit: number, reset: ResetZone, refreshMinutes = DEFAULT_SEAT.refreshMinutes): LiveFigure {
	const asOf = new Date(f.asOfMs);
	const pct = f.entitlement > 0 ? Math.round((f.creditsUsed / f.entitlement) * 100) : 0;
	return {
		spendUsd: f.creditsUsed * usdPerCredit,
		hardCapUsd: f.entitlement * usdPerCredit,
		asOfMs: f.asOfMs,
		validFromMs: monthStartMs(asOf, reset),
		validUntilMs: monthEndMs(asOf, reset),
		staleAfterMs: refreshMinutes * 4 * 60_000,
		caps: false,
		label: "seat",
		detail: `${f.login}: ${f.creditsUsed}/${f.entitlement} credits (${pct}%), ${f.remaining} left`,
	};
}

/**
 * The wallet as a live figure. The balance is clamped here: a negative balance means the account is
 * already over, and a cap below the spend would make every percentage meaningless.
 */
export function balanceLiveFigure(f: BalanceFigure, refreshMinutes: number, asOfMs: Date = new Date()): LiveFigure {
	return {
		spendUsd: f.spendUsd,
		balanceUsd: f.balanceUsd,
		hardCapUsd: f.spendUsd + Math.max(0, f.balanceUsd),
		...(f.limitUsd === undefined ? {} : { limitUsd: f.limitUsd }),
		asOfMs: asOfMs.getTime(),
		validFromMs: f.periodStartMs,
		validUntilMs: f.periodEndMs,
		staleAfterMs: refreshMinutes * 4 * 60_000,
		caps: true,
		blocked: f.blocked,
		...(f.blockReason === undefined ? {} : { blockReason: f.blockReason }),
		label: "balance",
		detail: `${usd(f.spendUsd)} spent this period, ${usd(f.balanceUsd)} left in the account`,
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

/** Start of the month after the one containing `now`, used as the end of a seat's period. */
export function monthEndMs(now: Date = new Date(), zone: ResetZone = "local"): number {
	if (zone === "utc") return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
	return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
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
	model?: string;
	timestamp?: number;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
	};
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

export interface ModelUsage {
	model: string;
	messages: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Pi's estimate at registry prices, USD. */
	cost: number;
}

/** Per-model usage of one provider since `sinceMs`, one walk of the session tree. Largest cost first. */
export async function usageSince(sessionsDir: string, provider: string, sinceMs: number): Promise<ModelUsage[]> {
	const byModel = new Map<string, ModelUsage>();
	for await (const fp of jsonlFiles(sessionsDir)) {
		if ((await stat(fp)).mtimeMs < sinceMs) continue;
		const text = await readFile(fp, "utf8");
		for (const line of text.split("\n")) {
			if (!line.includes('"role":"assistant"')) continue;
			let m: AssistantMessage | undefined;
			try {
				m = JSON.parse(line).message as AssistantMessage | undefined;
			} catch {
				continue;
			}
			if (!m || m.role !== "assistant" || m.provider !== provider || (m.timestamp ?? 0) < sinceMs) continue;
			const model = m.model ?? "(unknown model)";
			const u = m.usage ?? {};
			const row = byModel.get(model) ?? { model, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
			row.messages++;
			row.input += u.input ?? 0;
			row.output += u.output ?? 0;
			row.cacheRead += u.cacheRead ?? 0;
			row.cacheWrite += u.cacheWrite ?? 0;
			row.cost += u.cost?.total ?? 0;
			byModel.set(model, row);
		}
	}
	return [...byModel.values()].sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
}

/** Token counts in the compact form the report uses: 812, 14k, 2.4M, 3.5B. */
export function formatTokens(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
	return String(n);
}

/** The window a report covers, named in the zone the provider resets in. */
export function windowLabel(startMs: number, zone: ResetZone): string {
	const d = new Date(startMs);
	const pad = (n: number) => String(n).padStart(2, "0");
	if (zone === "utc") return `since ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} 00:00 UTC`;
	return `since ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 00:00 local`;
}

/**
 * The `/budget <provider>` report: the cap state when the provider is tracked, then what the session
 * logs show per model. When the spent figure comes from the provider's own usage page, the logged total
 * is shown beside it, since the two cover different spans.
 */
export function usageReport(
	provider: string,
	rows: readonly ModelUsage[],
	windowText: string,
	status?: ProviderStatus,
	remembered?: Exhaustion,
	unregistered = false,
): string {
	const logged = rows.reduce((s, r) => s + r.cost, 0);
	const head: string[] = [];
	if (status) {
		const cap = status.capUsd === undefined ? "no cap" : `cap ${usd(status.capUsd)}, ${status.pct}% used`;
		head.push(`${provider}: ${status.billing}, ${cap}, spent ${usd(status.spend)} (${status.source}), ${windowText}`);
		if (status.balanceUsd !== undefined) {
		const fresh = status.figureStale ? ", but that figure is too old or outside its period to use" : "";
			head.push(`account balance ${usd(status.balanceUsd)}${fresh}`);
		}
		if (status.source !== "meter") {
			head.push(`logged by pi: ${usd(logged)}. The spent figure counts usage up to its own snapshot time, so the two differ.`);
		}
	} else {
		const why = unregistered ? "configured, but this machine has no models or credentials for it" : "not in budget-routing.json";
		head.push(`${provider}: ${why}, usage only, logged ${usd(logged)}, ${windowText}`);
	}
	const ex = status?.exhausted ?? remembered;
	if (ex) {
		const until = ex.untilMs === undefined ? "until the account has money again" : `until ${new Date(ex.untilMs).toISOString()}`;
		head.push(`OUT OF BUDGET: ${ex.reason} since ${new Date(ex.atMs).toISOString()}. Calls to this provider fail ${until}.`);
	}
	if (rows.length === 0) return [...head, "no assistant messages logged for this window"].join("\n");
	const total = rows.reduce((s, r) => s + r.messages, 0);
	const sum = (f: (r: ModelUsage) => number) => rows.reduce((s, r) => s + f(r), 0);
	const body = rows.map((r) => [
		r.model,
		String(r.messages),
		formatTokens(r.input),
		formatTokens(r.output),
		formatTokens(r.cacheRead),
		formatTokens(r.cacheWrite),
		usd(r.cost),
	]);
	const totals = [
		"total",
		String(total),
		formatTokens(sum((r) => r.input)),
		formatTokens(sum((r) => r.output)),
		formatTokens(sum((r) => r.cacheRead)),
		formatTokens(sum((r) => r.cacheWrite)),
		usd(logged),
	];
	const table = renderTable(["model", "msgs", "input", "output", "cache r", "cache w", "cost"], [...body, totals]);
	return [...head, "", table].join("\n");
}

export interface MonthSpend {
	spend: number;
	/** "live" = fetched seat figure, "calibrated" = hand-written observed, "meter" = Pi logs only. */
	source: "meter" | "calibrated" | "live";
	/** An observation exists but is from another month (or in the future), so it was not used. */
	observationIgnored: boolean;
}

/**
 * Spend in the provider's billing window. A figure fetched from the provider wins over the
 * hand-written `observed`. Either one, while it is usable, is the baseline: it already counts Pi and
 * non-Pi usage up to its own time, and Pi-logged spend since then is added on top.
 */
export async function monthSpend(
	pb: ProviderBudget,
	sessionsDir: string,
	now: Date = new Date(),
	live?: LiveFigure,
): Promise<MonthSpend> {
	if (live && figureUsable(live, now)) {
		const local = await spendSince(sessionsDir, pb.provider, live.asOfMs);
		return { spend: live.spendUsd + local, source: "live", observationIgnored: false };
	}
	const start = monthStartMs(now, pb.reset);
	const o = pb.observed;
	if (o && o.asOfMs >= start && o.asOfMs <= now.getTime()) {
		const local = await spendSince(sessionsDir, pb.provider, o.asOfMs);
		return { spend: o.creditsUsed * o.usdPerCredit + local, source: "calibrated", observationIgnored: false };
	}
	const ignored = o !== undefined || live !== undefined;
	return { spend: await spendSince(sessionsDir, pb.provider, start), source: "meter", observationIgnored: ignored };
}

/**
 * The window figure for every configured provider in one walk. A provider with a usable fetched or
 * hand-written baseline needs only the tail after that snapshot, which is a second window on the same
 * provider rather than a second walk.
 */
export async function monthSpendAll(
	cfg: BudgetConfig,
	sessionsDir: string,
	now: Date = new Date(),
	live?: Map<string, LiveFigure>,
): Promise<Map<string, MonthSpend>> {
	const baselineUsd = new Map<string, number>();
	const baselineSource = new Map<string, "live" | "calibrated">();
	const windows: { key: string; provider: string; sinceMs: number }[] = [];
	for (const pb of cfg.providers) {
		const monthStart = monthStartMs(now, pb.reset);
		const fig = live?.get(pb.provider);
		const o = pb.observed;
		if (fig && figureUsable(fig, now)) {
			baselineUsd.set(pb.provider, fig.spendUsd);
			baselineSource.set(pb.provider, "live");
			windows.push({ key: pb.provider, provider: pb.provider, sinceMs: fig.asOfMs });
		} else if (o !== undefined && o.asOfMs >= monthStart && o.asOfMs <= now.getTime()) {
			baselineUsd.set(pb.provider, o.creditsUsed * o.usdPerCredit);
			baselineSource.set(pb.provider, "calibrated");
			windows.push({ key: pb.provider, provider: pb.provider, sinceMs: o.asOfMs });
		} else {
			windows.push({ key: pb.provider, provider: pb.provider, sinceMs: monthStart });
		}
	}
	const walk = await spendByWindow(sessionsDir, windows);
	const out = new Map<string, MonthSpend>();
	for (const pb of cfg.providers) {
		const base = baselineUsd.get(pb.provider);
		const tail = walk.get(pb.provider) ?? 0;
		if (base !== undefined) {
			out.set(pb.provider, { spend: base + tail, source: baselineSource.get(pb.provider) as MonthSpend["source"], observationIgnored: false });
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
	/** Set while the provider itself refuses calls for spend or credit reasons. */
	exhausted?: Exhaustion;
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
	/** Money left in a prepaid account, from the provider's own figure. */
	balanceUsd?: number;
	/** A figure was fetched for this provider but is too old or outside its period to use. */
	figureStale?: boolean;
	/** Requests counted by the provider itself, for a provider with no readable bill. Never tiered. */
	usage?: UsageCounter;
}

/** Billing shape for a provider: the config wins, otherwise a Copilot seat is credits and a zero-priced model is free. */
export function billingFor(pb: ProviderBudget, models: readonly RegistryModelLike[]): Billing {
	if (pb.billing) return pb.billing;
	if (pb.provider === "github-copilot") return "credits";
	const mine = models.filter((m) => m.provider === pb.provider);
	if (mine.length > 0 && mine.every((m) => isZeroCost(m))) return "free";
	return "metered";
}

/**
 * The cap a provider is tiered against. `monthlyCapUsd` is the ceiling you set for yourself; a wallet
 * adds two of its own, the money actually in the account and any spend-limit rule the provider
 * enforces. A seat figure adds nothing: its entitlement is reported to you as drift rather than
 * quietly overriding your number.
 */
export function effectiveCapUsd(pb: ProviderBudget, live?: LiveFigure, now: Date = new Date()): number | undefined {
	const ceilings: number[] = [];
	if (pb.monthlyCapUsd !== undefined) ceilings.push(pb.monthlyCapUsd);
	if (live && live.caps && figureUsable(live, now)) {
		if (live.limitUsd !== undefined) ceilings.push(live.limitUsd);
		if (live.hardCapUsd !== undefined) ceilings.push(live.hardCapUsd);
	}
	return ceilings.length === 0 ? undefined : Math.min(...ceilings);
}

export function providerStatus(
	pb: ProviderBudget,
	m: MonthSpend,
	billing: Billing,
	exhausted?: Exhaustion,
	now: Date = new Date(),
	live?: LiveFigure,
	usage?: UsageCounter,
): ProviderStatus {
	const s: ProviderStatus = {
		provider: pb.provider,
		billing,
		capUsd: effectiveCapUsd(pb, live, now),
		spend: m.spend,
		tier: "ok",
		source: m.source,
		observationIgnored: m.observationIgnored,
		...(live?.balanceUsd === undefined ? {} : { balanceUsd: live.balanceUsd }),
		...(live === undefined ? {} : { figureStale: !figureUsable(live, now) }),
		...(usage === undefined ? {} : { usage }),
	};
	if (s.capUsd !== undefined) {
		if (s.capUsd <= 0) {
			// A drained wallet leaves no denominator. tierFor would read NaN as "ok" and the footer
			// would divide by zero, so an empty account is divert on its own terms.
			s.frac = Number.POSITIVE_INFINITY;
			s.pct = 100;
			s.tier = "divert";
			s.headroomUsd = 0;
		} else {
			s.frac = m.spend / s.capUsd;
			s.pct = Math.round(s.frac * 100);
			s.tier = tierFor(s.frac, pb.thresholds);
			s.headroomUsd = Math.max(0, s.capUsd - m.spend);
		}
	}
	// The provider's own refusal outranks the meter: a cap configured above the account's real limit
	// reads low right up until every call fails. A fresh "blocked" from the provider is the strongest
	// signal there is, and it expires with the figure rather than outliving a top-up.
	if (live && live.caps && live.blocked && figureUsable(live, now)) {
		// Only a spend-cap rule resets with the period. An empty balance stays empty until it is topped
		// up, so giving it a period end would promise a recovery that never comes.
		const periodScoped = (live.blockReason ?? "").endsWith("_spend_cap_hit");
		s.exhausted = {
			atMs: live.asOfMs,
			...(periodScoped && Number.isFinite(live.validUntilMs) ? { untilMs: live.validUntilMs } : {}),
			reason: live.blockReason ?? "the provider reports spending blocked",
		};
		s.tier = "divert";
	} else if (exhausted && exhaustionActive(exhausted, pb.reset, now)) {
		s.exhausted = exhausted;
		s.tier = "divert";
	}
	return s;
}

export interface Exhaustion {
	/** When the refusal was observed. */
	atMs: number;
	/** When the provider said access returns, if it said so. */
	untilMs?: number;
	reason: string;
}

/**
 * Spend and credit refusals, which persist until the provider's own reset, as opposed to a rate limit
 * that clears in seconds. Anthropic reports its spend limit as a 429 rate_limit_error whose message
 * names the usage limits, so the text is what separates the two.
 */
const EXHAUSTION_PATTERNS: { match: RegExp; reason: string }[] = [
	{ match: /enforced_spend_limit_reached/i, reason: "spend limit reached" },
	{ match: /reached your (specified )?api usage limits?/i, reason: "spend limit reached" },
	{ match: /credit balance is too low/i, reason: "credit balance exhausted" },
	{ match: /insufficient_quota|exceeded your current quota/i, reason: "quota exhausted" },
	{ match: /quota_exceeded|quota exceeded/i, reason: "quota exhausted" },
	// A prepaid gateway refuses the next call with 402 and names the cause. A plain 429 stays out of
	// this list: that is a throttle, not an empty account.
	{ match: /balance_exhausted/i, reason: "credit balance exhausted" },
	{ match: /(?:project|member|org)_spend_cap_hit/i, reason: "spend limit reached" },
];

/** "You will regain access on 2026-12-01 at 00:00 UTC" and plain ISO dates. */
function parseResetInstant(message: string): number | undefined {
	const named = /regain access on (\d{4}-\d{2}-\d{2})(?: at (\d{2}:\d{2}))?\s*(UTC)?/i.exec(message);
	if (named) {
		const ms = Date.parse(`${named[1]}T${named[2] ?? "00:00"}:00Z`);
		if (!Number.isNaN(ms)) return ms;
	}
	const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))/.exec(message);
	if (iso) {
		const ms = Date.parse(iso[1]);
		if (!Number.isNaN(ms)) return ms;
	}
	return undefined;
}

/**
 * Whether a provider's error message says the account is out of spend or credit rather than merely
 * rate limited. Returns the state to remember, or undefined when the error is something else.
 */
export function classifyExhaustion(message: string, now: Date = new Date()): Exhaustion | undefined {
	const hit = EXHAUSTION_PATTERNS.find((p) => p.match.test(message));
	if (!hit) return undefined;
	return { atMs: now.getTime(), untilMs: parseResetInstant(message), reason: hit.reason };
}

/**
 * A refusal stops counting once the provider said it would, or at the next month boundary in the
 * provider's own reset zone, since a spend limit is a monthly allowance.
 */
export function exhaustionActive(ex: Exhaustion, zone: ResetZone, now: Date = new Date()): boolean {
	if (ex.untilMs !== undefined) return now.getTime() < ex.untilMs;
	const d = new Date(ex.atMs);
	const next = zone === "utc" ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) : new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
	return now.getTime() < next;
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
	// ctx.compact() summarizes with the model of the session, so a session on a provider that is
	// already refusing calls would only fail, clear its flag, and try again on the next agent_end.
	if (session.exhausted) return { compact: false, compacted };
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
	if (s.exhausted) return { text: `${name} out of budget`, color: "error" };
	// The meter can still print a number, but the one that matters is unknown.
	if (s.figureStale && s.balanceUsd !== undefined) return { text: `${name} ? balance unknown`, color: "warning" };
	if (s.capUsd === undefined) return { text: `${name} ${usd(s.spend)}`, color: "dim" };
	const estimate = s.source === "meter" ? "~" : "";
	const balance = s.balanceUsd === undefined ? "" : ` ${usd(s.balanceUsd)} left`;
	const mark = s.tier === "prepare" ? " !" : s.tier === "divert" ? " over" : "";
	return { text: `${name} ${estimate}${s.pct}%${balance}${mark}`, color: STATUS_COLORS[s.tier] };
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

/**
 * Providers this machine can launch on: those the registry has a model for, plus those with
 * configured credentials and a catalog that has not loaded yet (`discoverModels` on a provider whose
 * endpoint is slow or briefly down). A provider with neither belongs to another machine's config.
 */
export function registeredProviders(models: readonly RegistryModelLike[], authConfigured?: Iterable<string>): Set<string> {
	const known = new Set(models.map((m) => m.provider));
	for (const p of authConfigured ?? []) known.add(p);
	return known;
}

/**
 * Route refs whose provider exists on this machine. A ref is `provider/id` and provider names may
 * themselves contain slashes, so the longest registered provider name that prefixes the ref decides.
 * A wrong model id under a known provider stays in the menu, where buildRoutes marks it.
 */
export function registeredRefs(refs: readonly string[], registered: ReadonlySet<string>, isConfigured?: (provider: string) => boolean): string[] {
	return refs.filter((r) => {
		const base = stripThinkingSuffix(r.trim());
		let best = "";
		for (const p of registered) if ((base === p || base.startsWith(`${p}/`)) && p.length > best.length) best = p;
		return best !== "" && (isConfigured === undefined || isConfigured(best));
	});
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
	if (s.exhausted) return "out of budget";
	// For a prepaid account the money left is the headroom, and it is the number worth reading.
	if (s.balanceUsd !== undefined) return s.figureStale ? "balance unknown" : `${usd(s.balanceUsd)} left`;
	if (s.capUsd === undefined) return "no cap";
	if (s.tier === "divert") return "over cap";
	return `${Math.max(0, Math.round(((s.capUsd - s.spend) / s.capUsd) * 100))}% left`;
}

/** Where the spent figure came from, with the kind of figure named when there is a fetched one. */
function figureLabel(s: ProviderStatus): string {
	if (s.source === "live") return s.balanceUsd === undefined ? "live (seat)" : "live (balance)";
	if (s.figureStale) return `${s.source} (figure stale)`;
	return s.source;
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
		figureLabel(s),
	]);
	const out = [renderTable(["provider", "billing", "cap", "spent", "pct", "headroom", "figure"], providerRows)];
	if (routes.length > 0) {
		const routeRows = routes.map((r) => [r.ref, r.billing, r.inOut, r.cachePair, r.ctxLabel ?? "-", headroomLabel(r.status) + (r.note ? `  (${r.note})` : "")]);
		out.push("", renderTable(["route", "billing", "$/Mtok in/out", "cache r/w", "ctx", "provider room"], routeRows));
	}
	const usageRows = statuses.filter((s) => s.usage).map((s) => [shortName(s.provider), s.usage!.requests.toLocaleString("en-US"), new Date(s.usage!.periodStartMs).toISOString().slice(0, 10), s.usage!.byMethod[0]?.method ?? "-"]);
	if (usageRows.length > 0) out.push("", renderTable(["provider", "requests this month", "period start (UTC)", "largest method"], usageRows));
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
export function advisorySection(statuses: readonly ProviderStatus[], localRef: string | undefined, toolName: string): string {
	if (statuses.length === 0) return "";
	const parts = statuses.map((s) => {
		if (s.exhausted) return `${shortName(s.provider)} ${s.billing}, out of budget (${s.exhausted.reason})`;
		if (s.capUsd === undefined) return `${shortName(s.provider)} ${s.billing}, no cap`;
		return `${shortName(s.provider)} ${s.billing}, ${TIER_LABELS[s.tier]}`;
	});
	const fallback = localRef === undefined ? "" : ` ${localRef} is the last resort, not the default.`;
	return (
		`Budget: ${parts.join("; ")}. ` +
		`Call ${toolName} with action "models" for the price and headroom table before routing work to another model. ` +
		`A launch that would spend a provider over its cap is rejected with the open routes listed, so re-queue the same task on one of them.` +
		fallback
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
export function rejectReason(result: DivertResult, statuses: readonly ProviderStatus[], routes: readonly Route[], localRef: string | undefined): string {
	const diverting = statuses.filter((s) => s.tier === "divert");
	const over = diverting.map((s) => (s.exhausted ? `${shortName(s.provider)} (${s.exhausted.reason})` : `${shortName(s.provider)} ${s.pct}%`));
	const why = diverting.some((s) => s.exhausted) ? "out of budget on" : "over the monthly cap on";
	const open = routes
		.filter((r) => r.ref !== localRef && r.status && r.status.tier !== "divert")
		.slice(0, 4)
		.map((r) => `${r.ref} (${r.price}, ${headroomLabel(r.status)})`);
	const blocked = result.rejected.map((r) => (r.provider ? `${r.label} -> ${r.provider}` : `${r.label} -> unattributable model`));
	return (
		`budget-routing: ${why} ${over.join(", ")}. Blocked launches: ${blocked.join(", ")}. ` +
		`Re-queue each task on an open route: ${open.length > 0 ? open.join("; ") : "none with headroom"}. ` +
		(localRef === undefined ? "No local fallback is registered on this machine." : `Local fallback: ${localRef}.`)
	);
}
