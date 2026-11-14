/**
 * Budget routing for monthly spend caps on one or more paid providers at the same time.
 *
 * Tiers, by fraction of a provider's monthlyCapUsd (thresholds are configurable):
 *   nudge   - advisory prompt section: name the priced routes before work is fanned out
 *   warn    - notification
 *   prepare - compact the main session while that provider still works (between agent runs)
 *   divert  - launches that would spend that provider are rejected with the open routes listed
 *             (`enforce: "reject"`), or local-eligible launches are rewritten to the local model
 *             (`enforce: "rewrite"`), or nothing is done (`enforce: "off"`)
 *
 * A provider entry with no monthlyCapUsd is tracked and priced but never capped.
 *
 * Config: ~/.pi/agent/budget-routing.json (override with PI_BUDGET_ROUTING_CONFIG). Without a config
 * file the extension does nothing. See budget-routing.example.json and README.md.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyDivert,
	advisorySection,
	billingFor,
	buildRoutes,
	costTable,
	DEFAULT_SEAT,
	loadConfig,
	menuModelRefs,
	monthSpendAll,
	parseAgentOverrideModels,
	preSwitchCompactionStep,
	providerStatus,
	rejectReason,
	statusLabel,
	type BudgetConfig,
	type CredentialSource,
	type MonthSpend,
	type ProviderStatus,
	type RegistryModelLike,
	type SeatFigure,
	type Tier,
} from "./budget.ts";
import { fetchCopilotSeat, isCopilotProvider } from "./seat.ts";
import { resolveGitHubToken } from "./credential.ts";

const AGENT_DIR = process.env.PI_BUDGET_ROUTING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const CONFIG_PATH = process.env.PI_BUDGET_ROUTING_CONFIG ?? join(AGENT_DIR, "budget-routing.json");
const CACHE_MS = 120_000;
const STATUS_PREFIX = "budget-routing";
const SECTION_TAG = "budget";
const TOOL_NAME = "budget";

interface Snapshot {
	cfg: BudgetConfig;
	statuses: ProviderStatus[];
}

interface SeatResult {
	ok: boolean;
	figure?: SeatFigure;
	source?: Exclude<CredentialSource, "auto">;
	note: string;
}

/** One slot for the whole provider set: the tree is walked once, so partial caching would cost more walks. */
let cache: { at: number; key: string; spend: Map<string, MonthSpend> } | undefined;

/** Figures fetched from providers this session. In memory only: the config file is never written. */
const seatFigures = new Map<string, SeatFigure>();
const seatFetchMs = new Map<string, number>();

function configKey(cfg: BudgetConfig): string {
	const entries = cfg.providers.map((pb) => [pb.provider, pb.monthlyCapUsd ?? null, pb.reset, pb.observed?.asOfMs ?? null, pb.observed?.creditsUsed ?? null]);
	return JSON.stringify([entries, [...seatFigures.entries()].map(([p, f]) => [p, f.creditsUsed, f.asOfMs])]);
}

async function spendAll(cfg: BudgetConfig): Promise<Map<string, MonthSpend>> {
	const key = configKey(cfg);
	if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.spend;
	const spend = await monthSpendAll(cfg, SESSIONS_DIR, new Date(), seatFigures);
	cache = { at: Date.now(), key, spend };
	return spend;
}

/** undefined when no config file exists. Throws when the config is invalid or logs cannot be read. */
async function currentSnapshot(models: readonly RegistryModelLike[]): Promise<Snapshot | undefined> {
	if (!existsSync(CONFIG_PATH)) return undefined;
	const cfg = await loadConfig(CONFIG_PATH);
	const spend = await spendAll(cfg);
	const statuses = cfg.providers.map((pb) =>
		providerStatus(pb, spend.get(pb.provider) ?? { spend: 0, source: "meter", observationIgnored: false }, billingFor(pb, models)),
	);
	return { cfg, statuses };
}

export default function (pi: ExtensionAPI) {
	const announced = new Set<string>();
	const compacted = new Map<string, boolean>();
	let seatInFlight: Promise<SeatResult[]> | undefined;
	const activeStatusKeys = new Set<string>();

	function notifyOnce(ctx: ExtensionContext, key: string, message: string, severity: "info" | "warning" | "error" = "warning") {
		if (announced.has(key)) return;
		announced.add(key);
		ctx.ui.notify(`budget-routing: ${message}`, severity);
	}

	/** One footer indicator per provider, coloured by tier. Cleared for providers no longer configured. */
	function updateStatus(ctx: ExtensionContext, snap: Snapshot | undefined): void {
		const seen = new Set<string>();
		for (const s of snap?.statuses ?? []) {
			const key = `${STATUS_PREFIX}/${s.provider}`;
			const label = statusLabel(s);
			ctx.ui.setStatus(key, ctx.ui.theme.fg(label.color, label.text));
			seen.add(key);
		}
		for (const stale of activeStatusKeys) if (!seen.has(stale)) ctx.ui.setStatus(stale, undefined);
		activeStatusKeys.clear();
		for (const k of seen) activeStatusKeys.add(k);
	}

	function refreshStatus(ctx: ExtensionContext): Promise<void> {
		return safeSnapshot(ctx).then((snap) => updateStatus(ctx, snap));
	}

	/** Fetch at most once at a time; a second caller joins the run already in flight. */
	function refreshSeats(ctx: ExtensionContext, force = false): Promise<SeatResult[]> {
		if (seatInFlight) return seatInFlight;
		seatInFlight = doRefreshSeats(ctx, force).finally(() => {
			seatInFlight = undefined;
		});
		return seatInFlight;
	}

	/**
	 * Refreshes every provider whose entry has a `seat` block. Never throws: it runs off the agent
	 * path, so each failure resolves with ok:false and a note. GitHub is contacted only for Copilot.
	 */
	async function doRefreshSeats(ctx: ExtensionContext, force: boolean): Promise<SeatResult[]> {
		if (!existsSync(CONFIG_PATH)) return [{ ok: false, note: "no config file" }];
		let cfg: BudgetConfig;
		try {
			cfg = await loadConfig(CONFIG_PATH);
		} catch (err) {
			return [{ ok: false, note: (err as Error).message }];
		}
		const out: SeatResult[] = [];
		for (const pb of cfg.providers) {
			if (!isCopilotProvider(pb.provider)) {
				if (pb.seat) out.push({ ok: false, note: `${pb.provider}: the GitHub seat fetch is not used for this provider` });
				continue;
			}
			if (!pb.seat && !force) continue;
			if (!force && Date.now() - (seatFetchMs.get(pb.provider) ?? 0) < (pb.seat ?? DEFAULT_SEAT).refreshMinutes * 60_000) {
				out.push({ ok: true, note: "figure is fresh" });
				continue;
			}
			const seat = pb.seat ?? DEFAULT_SEAT;
			let token: string;
			let source: Exclude<CredentialSource, "auto">;
			try {
				({ token, source } = await resolveGitHubToken(AGENT_DIR, seat.credential, pb.provider));
			} catch (err) {
				notifyOnce(ctx, `seat-credential:${pb.provider}`, `seat refresh skipped: ${(err as Error).message}`);
				out.push({ ok: false, note: (err as Error).message });
				continue;
			}
			let fig: SeatFigure;
			try {
				fig = await fetchCopilotSeat(token);
			} catch (err) {
				notifyOnce(ctx, `seat-fetch:${pb.provider}`, `seat refresh failed: ${(err as Error).message}`);
				out.push({ ok: false, note: (err as Error).message });
				continue;
			}
			seatFetchMs.set(pb.provider, Date.now());
			seatFigures.set(pb.provider, fig);
			cache = undefined;

			const usdPerCredit = pb.observed?.usdPerCredit ?? 0.01;
			const capFromSeat = fig.entitlement * usdPerCredit;
			if (pb.monthlyCapUsd !== undefined && Math.abs(capFromSeat - pb.monthlyCapUsd) > 0.005) {
				notifyOnce(
					ctx,
					`seat-cap-drift:${pb.provider}`,
					`seat entitlement is ${fig.entitlement} credits ($${capFromSeat.toFixed(2)}) but ${pb.provider}.monthlyCapUsd is $${pb.monthlyCapUsd}. Align the cap with the seat if you want it to track it.`,
				);
			}
			const pct = Math.round((fig.creditsUsed / fig.entitlement) * 100);
			out.push({
				ok: true,
				figure: fig,
				source,
				note: `${fig.login}: ${fig.creditsUsed}/${fig.entitlement} credits (${pct}%), ${fig.remaining} left, as of ${new Date(fig.asOfMs).toISOString()}, credential from ${source}`,
			});
		}
		return out;
	}

	async function safeSnapshot(ctx: ExtensionContext): Promise<Snapshot | undefined> {
		try {
			return await currentSnapshot(ctx.modelRegistry.getAll());
		} catch (err) {
			if (!announced.has("error")) {
				announced.add("error");
				ctx.ui.notify(`budget-routing inactive: ${(err as Error).message}`, "error");
			}
			return undefined;
		}
	}

	/** Route menu: the configured list, or the models Pi's agent settings already point agents at. */
	async function routesFor(ctx: ExtensionContext, snap: Snapshot): Promise<ReturnType<typeof buildRoutes>> {
		let overrides: unknown;
		try {
			overrides = JSON.parse(await readFile(join(AGENT_DIR, "settings.json"), "utf8"));
		} catch {
			overrides = undefined;
		}
		const refs = menuModelRefs(snap.cfg, parseAgentOverrideModels(overrides), ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
		return buildRoutes(refs, ctx.modelRegistry.getAll(), snap.statuses, snap.cfg.localModel.subagentRef);
	}

	function monthKey(): string {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
	}

	pi.on("session_start", async (_event, ctx) => {
		announced.clear();
		compacted.clear();
		void refreshSeats(ctx)
			.then(() => refreshStatus(ctx))
			.catch(() => undefined);
	});

	pi.registerCommand("budget", {
		description: "Spend, caps and priced routes for every tracked provider",
		handler: async (_args, ctx) => {
			const snap = await safeSnapshot(ctx);
			if (!snap) {
				ctx.ui.notify(`budget-routing: no config at ${CONFIG_PATH}`, "warning");
				return;
			}
			ctx.ui.notify(costTable(snap.statuses, await routesFor(ctx, snap)), "info");
		},
	});

	pi.registerCommand("budget-seat", {
		description: "Fetch the GitHub Copilot seat figure now and report it",
		handler: async (_args, ctx) => {
			const results = await refreshSeats(ctx, true);
			const usable = results.filter((r) => r.note !== undefined);
			ctx.ui.notify(usable.map((r) => `${r.ok ? "ok" : "failed"}: ${r.note}`).join(" | ") || "no seat block configured", usable.some((r) => r.ok) ? "info" : "warning");
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Budget",
		description:
			"Current month-to-date spend, cap state and priced route models for every provider this session is billed on. Read it before routing work to another model.",
		promptSnippet: "Look up provider cap state and the priced model routes before orchestrating subagent work onto another model.",
		promptGuidelines: [
			"Use the budget tool when choosing which provider or model a subagent should run on, or when a subagent launch was rejected for spending a provider over its cap.",
			"Do not re-read the budget tool inside one turn; its numbers only move between turns.",
		],
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: `"status" for the cap table (default), "models" for the cap table plus the priced route menu` })),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const snap = await safeSnapshot(ctx);
			if (!snap) return { content: [{ type: "text", text: `budget-routing: no config at ${CONFIG_PATH}` }], details: undefined };
			const withRoutes = params?.action !== "status";
			const table = costTable(snap.statuses, withRoutes ? await routesFor(ctx, snap) : []);
			return { content: [{ type: "text", text: table }], details: { statuses: snap.statuses } };
		},
	});

	// Nudge the model with the quantized state, and offer the main-session switch at divert.
	pi.on("before_agent_start", async (event, ctx) => {
		const snap = await safeSnapshot(ctx);
		updateStatus(ctx, snap);
		if (!snap) return;
		const month = monthKey();

		for (const s of snap.statuses) {
			if (s.observationIgnored) {
				notifyOnce(ctx, `stale-observation:${s.provider}:${month}`, `the figure for ${s.provider} is from another month and was ignored. Fix the seat fetch, or update observed.asOf.`);
			}
			if (s.tier !== "ok") {
				const severity = s.tier === "nudge" ? "info" : "warning";
				notifyOnce(ctx, `${s.tier}:${s.provider}:${month}`, `${s.provider} budget at ${s.pct}% (${s.tier})`, severity);
			}
		}

		event.systemPromptOptions.sections = {
			...(event.systemPromptOptions.sections ?? {}),
			[SECTION_TAG]: advisorySection(snap.statuses, snap.cfg.localModel.subagentRef, TOOL_NAME),
		};

		const mine = snap.statuses.find((s) => s.provider === ctx.model?.provider);
		if (mine?.tier === "divert") {
			const t = snap.cfg.localModel;
			const ok = await ctx.ui.confirm(
				"Monthly cap reached",
				`${mine.provider} is at ${mine.pct}% of its cap. Switch the main session to ${t.provider}/${t.modelId}? Pre-switch compaction ${compacted.get(mine.provider) ? "is done" : "was NOT done"}.`,
			);
			if (ok) {
				const target = ctx.modelRegistry.find(t.provider, t.modelId);
				if (!target) {
					ctx.ui.notify(`Local model ${t.provider}/${t.modelId} is not in the registry`, "error");
				} else if (!(await pi.setModel(target))) {
					ctx.ui.notify("Local model has no authentication configured", "error");
				}
			}
		}
	});

	// Compact while the provider the session is spending still works, before its cap blocks calls.
	pi.on("agent_end", async (_event, ctx) => {
		const snap = await safeSnapshot(ctx);
		if (!snap) return;
		const provider = ctx.model?.provider;
		if (!provider) return;
		const mine = snap.statuses.find((s) => s.provider === provider);
		const step = preSwitchCompactionStep(mine, compacted.get(provider) ?? false);
		if (step.compacted) compacted.set(provider, true);
		else compacted.delete(provider);
		if (!step.compact || !mine) return;
		ctx.ui.notify(`${provider} at ${mine.pct}%: compacting before any switch`, "warning");
		ctx.compact({
			customInstructions: "Keep the current task, decisions, file paths, and open todos. Be compact.",
			onComplete: () => ctx.ui.notify("Pre-switch compaction complete", "info"),
			onError: (err) => {
				compacted.delete(provider);
				ctx.ui.notify(`Pre-switch compaction failed: ${err.message}`, "error");
			},
		});
	});

	// Keep the fetched figures current between runs. Off the critical path: the next turn sees it
	// because currentSnapshot() re-reads the config file.
	pi.on("agent_settled", async (_event, ctx) => {
		void refreshSeats(ctx)
			.then(() => refreshStatus(ctx))
			.catch(() => undefined);
	});

	// A launch that would spend a provider over its cap is handled per `enforce`. Launches aimed at
	// another provider cost nothing against that cap and are left alone.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "subagent") return undefined;
		const snap = await safeSnapshot(ctx);
		if (!snap || snap.cfg.enforce === "off") return undefined;

		const tiers: Record<string, Tier> = {};
		for (const s of snap.statuses) if (s.capUsd !== undefined) tiers[s.provider] = s.tier;

		const plan = applyDivert((event as unknown as { input?: unknown }).input, {
			mode: snap.cfg.enforce,
			localSubagents: snap.cfg.localSubagents,
			subagentRef: snap.cfg.localModel.subagentRef,
			tiers,
			sessionProvider: ctx.model?.provider,
			models: ctx.modelRegistry.getAll(),
		});
		if (plan.rejected.length === 0) return undefined;
		return { block: true, reason: rejectReason(plan, snap.statuses, await routesFor(ctx, snap), snap.cfg.localModel.subagentRef) };
	});

	// The model asks for models exactly when it is about to route work. Prices belong in that answer,
	// not in every prompt.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "subagent") return undefined;
		const input = (event as unknown as { input?: { action?: unknown } }).input;
		if (typeof input?.action !== "string" || input.action !== "models") return undefined;
		const snap = await safeSnapshot(ctx);
		if (!snap) return undefined;
		const table = costTable(snap.statuses, await routesFor(ctx, snap));
		return {
			content: [...event.content, { type: "text", text: `budget-routing:\n${table}` }],
			structuredContent: event.structuredContent,
		};
	});
}
