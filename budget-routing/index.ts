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
import { applyDivert, loadConfig, monthSpend, tierFor, type BudgetConfig, type MonthSpend, type Tier } from "./budget.ts";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
const CONFIG_PATH = process.env.PI_BUDGET_ROUTING_CONFIG ?? join(AGENT_DIR, "budget-routing.json");
const CACHE_MS = 120_000;

interface State {
	tier: Tier;
	pct: number;
	spend: number;
	cfg: BudgetConfig;
	observationIgnored: boolean;
}

let cache: { at: number; key: string; result: MonthSpend } | undefined;

async function cachedSpend(cfg: BudgetConfig): Promise<MonthSpend> {
	const key = JSON.stringify([cfg.provider, cfg.observed ?? null]);
	if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.result;
	const result = await monthSpend(cfg, SESSIONS_DIR);
	cache = { at: Date.now(), key, result };
	return result;
}

/** undefined when no config file exists. Throws when the config is invalid or logs cannot be read. */
async function currentState(): Promise<State | undefined> {
	if (!existsSync(CONFIG_PATH)) return undefined;
	const cfg = await loadConfig(CONFIG_PATH);
	const m = await cachedSpend(cfg);
	const frac = m.spend / cfg.monthlyCapUsd;
	return { tier: tierFor(frac, cfg.thresholds), pct: Math.round(frac * 100), spend: m.spend, cfg, observationIgnored: m.observationIgnored };
}

export default function (pi: ExtensionAPI) {
	const announced = new Set<string>();
	let compactedThisCrossing = false;

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

	pi.on("session_start", async () => {
		announced.clear();
		compactedThisCrossing = false;
	});

	// Nudge the model and notify. At divert, offer the main-session switch.
	pi.on("before_agent_start", async (event, ctx) => {
		const st = await safeState(ctx);
		if (st?.observationIgnored && !announced.has("stale-observation")) {
			announced.add("stale-observation");
			ctx.ui.notify("budget-routing: the observed seat figure is from another month. Update observed.asOf.", "warning");
		}
		if (!st || st.tier === "ok") return;

		const t = st.cfg.localModel;
		event.systemPromptOptions.appendSystemPrompt +=
			`\n\n## Budget (automatic, advisory)\n` +
			`${st.cfg.provider} spend is ${st.pct}% of the monthly cap (state: ${st.tier}). ` +
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
		if (!st || (st.tier !== "prepare" && st.tier !== "divert")) {
			compactedThisCrossing = false;
			return;
		}
		if (compactedThisCrossing) return;
		compactedThisCrossing = true;
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

	// At divert: light subagent launches run locally; other launches are blocked.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "subagent") return undefined;
		const st = await safeState(ctx);
		if (!st || st.tier !== "divert") return undefined;

		const plan = applyDivert(
			(event as unknown as { input?: unknown }).input,
			st.cfg.localSubagents,
			st.cfg.localModel.subagentRef,
		);
		if (plan.blocked.length > 0) {
			return {
				block: true,
				reason:
					`${st.cfg.provider} cap reached (${st.pct}%). Blocked launches: ${plan.blocked.join(", ")}. ` +
					`Local-eligible: ${st.cfg.localSubagents.join(", ")}. Raise monthlyCapUsd in budget-routing.json to override.`,
			};
		}
		return undefined;
	});
}
