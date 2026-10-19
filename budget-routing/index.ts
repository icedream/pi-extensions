/**
 * Budget routing for a monthly spend cap on one provider (default: GitHub Copilot).
 *
 * Tiers, by fraction of monthlyCapUsd (thresholds are configurable):
 *   nudge   - advisory prompt section: prefer the local model for light subagents
 *   warn    - notification
 *   prepare - compact the main session while the provider still works (between agent runs)
 *   divert  - rewrite light subagent launches to the local model; block other launches for the
 *             provider; offer to switch the main session to the local model (confirmation required)
 *
 * Config: ~/.pi/agent/budget-routing.json (override with PI_BUDGET_ROUTING_CONFIG). Without a config
 * file the extension does nothing. See budget-routing.example.json and README.md.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyDivert,
	DEFAULT_SEAT,
	loadConfig,
	monthSpend,
	preSwitchCompactionStep,
	statusLabel,
	tierFor,
	type BudgetConfig,
	type CredentialSource,
	type MonthSpend,
	type SeatFigure,
	type Tier,
} from "./budget.ts";
import { fetchCopilotSeat, isCopilotProvider } from "./seat.ts";
import { resolveGitHubToken } from "./credential.ts";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const CONFIG_PATH = process.env.PI_BUDGET_ROUTING_CONFIG ?? join(AGENT_DIR, "budget-routing.json");
const CACHE_MS = 120_000;
const STATUS_KEY = "budget-routing";

interface State {
	tier: Tier;
	pct: number;
	spend: number;
	cfg: BudgetConfig;
	observationIgnored: boolean;
	source: MonthSpend["source"];
}

interface SeatResult {
	ok: boolean;
	figure?: SeatFigure;
	source?: Exclude<CredentialSource, "auto">;
	note: string;
}

let cache: { at: number; key: string; result: MonthSpend } | undefined;

/** Last figure fetched from GitHub. In memory only: the config file is never written. */
let seatFigure: SeatFigure | undefined;
let seatFetchMs = 0;

async function cachedSpend(cfg: BudgetConfig): Promise<MonthSpend> {
	const key = JSON.stringify([cfg.provider, cfg.observed ?? null, seatFigure ?? null]);
	if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.result;
	const result = await monthSpend(cfg, SESSIONS_DIR, new Date(), seatFigure);
	cache = { at: Date.now(), key, result };
	return result;
}

/** undefined when no config file exists. Throws when the config is invalid or logs cannot be read. */
async function currentState(): Promise<State | undefined> {
	if (!existsSync(CONFIG_PATH)) return undefined;
	const cfg = await loadConfig(CONFIG_PATH);
	const m = await cachedSpend(cfg);
	const frac = m.spend / cfg.monthlyCapUsd;
	return {
		tier: tierFor(frac, cfg.thresholds),
		pct: Math.round(frac * 100),
		spend: m.spend,
		cfg,
		observationIgnored: m.observationIgnored,
		source: m.source,
	};
}

export default function (pi: ExtensionAPI) {
	const announced = new Set<string>();
	let compactedThisCrossing = false;
	let seatInFlight: Promise<SeatResult> | undefined;

	function notifyOnce(ctx: ExtensionContext, key: string, message: string, severity: "info" | "warning" | "error" = "warning") {
		if (announced.has(key)) return;
		announced.add(key);
		ctx.ui.notify(`budget-routing: ${message}`, severity);
	}

	/** Footer indicator next to the session cost, coloured by tier. Cleared when there is no config. */
	function updateStatus(ctx: ExtensionContext, st: State | undefined): void {
		if (!st) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const label = statusLabel(st.cfg.provider, st.pct, st.tier, st.source);
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(label.color, label.text));
	}

	function refreshStatus(ctx: ExtensionContext): Promise<void> {
		return safeState(ctx).then((st) => updateStatus(ctx, st));
	}

	/** Fetch at most once at a time; a second caller joins the run already in flight. */
	function refreshSeat(ctx: ExtensionContext, force = false): Promise<SeatResult> {
		if (seatInFlight) return seatInFlight;
		seatInFlight = doRefreshSeat(ctx, force).finally(() => {
			seatInFlight = undefined;
		});
		return seatInFlight;
	}

	/**
	 * Fetches the seat figure and, when the config's `seat` block allows it, writes it into that file
	 * and commits. Never throws: it runs off the agent path, so every failure resolves with ok:false
	 * and a note. GitHub is contacted only while the configured provider is github-copilot.
	 */
	async function doRefreshSeat(ctx: ExtensionContext, force: boolean): Promise<SeatResult> {
		if (!existsSync(CONFIG_PATH)) return { ok: false, note: "no config file" };
		let cfg: BudgetConfig;
		try {
			cfg = await loadConfig(CONFIG_PATH);
		} catch (err) {
			return { ok: false, note: (err as Error).message };
		}
		if (!isCopilotProvider(cfg.provider)) {
			return { ok: false, note: `provider is ${cfg.provider}, so the GitHub credential is not used` };
		}
		if (!cfg.seat && !force) return { ok: false, note: "no seat block in the config: automatic refresh is off" };
		const seat = cfg.seat ?? DEFAULT_SEAT;
		if (!force && Date.now() - seatFetchMs < seat.refreshMinutes * 60_000) return { ok: true, note: "figure is fresh" };

		let token: string;
		let source: Exclude<CredentialSource, "auto">;
		try {
			({ token, source } = await resolveGitHubToken(AGENT_DIR, seat.credential, cfg.provider));
		} catch (err) {
			notifyOnce(ctx, "seat-credential", `seat refresh skipped: ${(err as Error).message}`);
			return { ok: false, note: (err as Error).message };
		}

		let fig: SeatFigure;
		try {
			fig = await fetchCopilotSeat(token);
		} catch (err) {
			notifyOnce(ctx, "seat-fetch", `seat refresh failed: ${(err as Error).message}`);
			return { ok: false, note: (err as Error).message };
		}
		seatFetchMs = Date.now();
		seatFigure = fig;

		const usdPerCredit = cfg.observed?.usdPerCredit ?? 0.01;
		const capFromSeat = fig.entitlement * usdPerCredit;
		if (Math.abs(capFromSeat - cfg.monthlyCapUsd) > 0.005) {
			notifyOnce(
				ctx,
				"seat-cap-drift",
				`seat entitlement is ${fig.entitlement} credits ($${capFromSeat.toFixed(2)}) but monthlyCapUsd is $${cfg.monthlyCapUsd}. Align monthlyCapUsd with the seat if you want the cap to track it.`,
			);
		}

		const pct = Math.round((fig.creditsUsed / fig.entitlement) * 100);
		return {
			ok: true,
			figure: fig,
			source,
			note: `${fig.login}: ${fig.creditsUsed}/${fig.entitlement} credits (${pct}%), ${fig.remaining} left, as of ${new Date(fig.asOfMs).toISOString()}, credential from ${source}`,
		};
	}

	async function safeState(ctx: ExtensionContext): Promise<State | undefined> {
		try {
			return await currentState();
		} catch (err) {
			if (!announced.has("error")) {
				announced.add("error");
				ctx.ui.notify(`budget-routing inactive: ${(err as Error).message}`, "error");
			}
			return undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		announced.clear();
		compactedThisCrossing = false;
		void refreshSeat(ctx).then(() => refreshStatus(ctx));
	});

	pi.registerCommand("budget-seat", {
		description: "Fetch the GitHub Copilot seat figure now and report it",
		handler: async (_args, ctx) => {
			const r = await refreshSeat(ctx, true);
			ctx.ui.notify(`Copilot seat: ${r.note}`, r.ok ? "info" : "warning");
		},
	});

	// Nudge the model and notify. At divert, offer the main-session switch.
	pi.on("before_agent_start", async (event, ctx) => {
		const st = await safeState(ctx);
		updateStatus(ctx, st);
		if (st?.observationIgnored && !announced.has("stale-observation")) {
			announced.add("stale-observation");
			ctx.ui.notify(
				"budget-routing: the seat figure is from another month and was ignored. Fix the seat fetch, or update observed.asOf.",
				"warning",
			);
		}
		if (!st || st.tier === "ok") return;

		const t = st.cfg.localModel;
		event.systemPromptOptions.appendSystemPrompt +=
			`\n\n## Budget (automatic, advisory)\n` +
			`${st.cfg.provider} spend is ${st.pct}% of the monthly cap (state: ${st.tier}, figure: ${st.source}). ` +
			`Prefer the local model (${t.subagentRef}) for ${st.cfg.localSubagents.join(", ")}. ` +
			`Avoid unnecessary ${st.cfg.provider} subagent launches.`;

		if (!announced.has(st.tier)) {
			announced.add(st.tier);
			ctx.ui.notify(`${st.cfg.provider} budget at ${st.pct}% (${st.tier})`, st.tier === "nudge" ? "info" : "warning");
		}

		if (st.tier === "divert" && ctx.model?.provider === st.cfg.provider) {
			const ok = await ctx.ui.confirm(
				"Monthly cap reached",
				`Switch the main session to local ${t.modelId}? Pre-switch compaction ${compactedThisCrossing ? "is done" : "was NOT done"}.`,
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

	// Compact while the provider still works, before the cap blocks calls. Runs between agent runs.
	pi.on("agent_end", async (_event, ctx) => {
		const st = await safeState(ctx);
		const step = preSwitchCompactionStep(st?.tier, ctx.model?.provider, st?.cfg.provider, compactedThisCrossing);
		compactedThisCrossing = step.compacted;
		if (!step.compact || !st) return;
		ctx.ui.notify(`${st.cfg.provider} at ${st.pct}%: compacting before any local switch`, "warning");
		ctx.compact({
			customInstructions: "Keep the current task, decisions, file paths, and open todos. Be compact.",
			onComplete: () => ctx.ui.notify("Pre-switch compaction complete", "info"),
			onError: (err) => {
				compactedThisCrossing = false;
				ctx.ui.notify(`Pre-switch compaction failed: ${err.message}`, "error");
			},
		});
	});

	// Keep the seat figure current between runs. Off the critical path: the next turn sees it because
	// currentState() re-reads the config file.
	pi.on("agent_settled", async (_event, ctx) => {
		void refreshSeat(ctx).then(() => refreshStatus(ctx));
	});

	// At divert: launches that would spend the capped provider are rewritten to the local model when
	// their agent is local-eligible, and blocked otherwise. Launches already aimed at another provider
	// cost nothing against this cap and are left alone.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "subagent") return undefined;
		const st = await safeState(ctx);
		if (!st || st.tier !== "divert") return undefined;

		const plan = applyDivert((event as unknown as { input?: unknown }).input, {
			localSubagents: st.cfg.localSubagents,
			subagentRef: st.cfg.localModel.subagentRef,
			budgetProvider: st.cfg.provider,
			sessionProvider: ctx.model?.provider,
			models: ctx.modelRegistry.getAll(),
		});
		if (plan.blocked.length > 0) {
			return {
				block: true,
				reason:
					`${st.cfg.provider} cap reached (${st.pct}%). Blocked launches: ${plan.blocked.join(", ")}. ` +
					`Local-eligible: ${st.cfg.localSubagents.join(", ")}. Launches with an explicit model from another ` +
					`provider are not blocked: pass model as "<other-provider>/<model-id>". Raise monthlyCapUsd in ` +
					`budget-routing.json to allow ${st.cfg.provider} launches again.` +
					(plan.passed.length > 0 ? ` Already allowed: ${plan.passed.join(", ")}.` : ""),
			};
		}
		return undefined;
	});
}
