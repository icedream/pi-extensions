/**
 * Discover models for models.json providers marked `"discoverModels": true`, and
 * register them with the context window and input modalities the endpoint actually
 * reports.
 *
 * Configure in ~/.pi/agent/models.json:
 *
 *   "providers": {
 *     "myhost/strata": {
 *       "api": "openai-completions",
 *       "baseUrl": "http://127.0.0.1:8080/v1",
 *       "apiKey": "...",
 *       "discoverModels": true
 *     }
 *   }
 *
 * What this fixes over a generic OpenAI model list: llama.cpp and Strata report the
 * context window as `meta.n_ctx`, not `context_window`. Reading only the OpenAI-style
 * key yields undefined, and a fallback constant then tells Pi it has a window the
 * server cannot serve - Pi keeps growing the session until the endpoint rejects it.
 * Here a model with no reported context window is skipped with a message naming it,
 * rather than guessed at.
 *
 * Input modalities come from `architecture.input_modalities`. A model that does not
 * declare image support is registered as text only.
 *
 * Values written in models.json for a model override what discovery reports, so a
 * context window can be pinned there and survives a refresh.
 *
 * Commands:
 *   /model-context            menu to turn automatic discovery on or off per provider
 *   /model-context-refresh   re-read models.json and re-fetch every discovery provider
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	canDiscover,
	discoveryFlag,
	fetchModels,
	LOG_PREFIX,
	modelsUrlFor,
	readModelsJsonProviders,
	setDiscoveryFlagInFile,
	type DiscoveredModel,
	type ProviderEntry,
} from "./discovery.ts";

const MODELS_JSON = process.env.PI_MODELS_JSON ?? join(homedir(), ".pi", "agent", "models.json");

/** Pi needs a non-negative cost object; local servers are free. */
const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * The chat member of the model-config union. `ProviderModelConfig` also covers image
 * and classifier models, which lack `compat` and `contextWindow`, so the union type
 * hides fields this extension legitimately sets. `Exclude` rather than `Extract`
 * because the chat member's `type` is optional, so it does not match `{ type: "chat" }`.
 */
type ChatModel = Exclude<ProviderModelConfig, { type: "image" } | { type: "classifier" }>;

interface Notify {
	(message: string, level?: "info" | "warning" | "error"): void;
}

function toModelConfig(entry: ProviderEntry, model: DiscoveredModel): ChatModel {
	return {
		type: "chat",
		id: model.id,
		name: model.name,
		reasoning: true,
		input: model.input,
		cost: FREE_COST,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		// xhigh and max only appear in /thinking when mapped; models that reject them
		// are overridden per id with modelOverrides in models.json.
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		...(entry.compat ? { compat: entry.compat as ChatModel["compat"] } : {}),
	};
}

/** Register one provider from a live fetch, and keep the result for offline refreshes. */
async function registerProvider(
	pi: ExtensionAPI,
	entry: ProviderEntry,
	notify: Notify,
): Promise<boolean> {
	let lastModels: ChatModel[] = [];

	const discover = async (signal?: AbortSignal): Promise<ChatModel[]> => {
		const discovered = await fetchModels(entry, signal);
		const models = discovered.map((model) => toModelConfig(entry, model));
		lastModels = models;
		const unreported = discovered.filter((model) => !model.maxTokensReported);
		if (unreported.length > 0) {
			notify(
				`${LOG_PREFIX} ${entry.id}: ${unreported.length} model(s) report no output limit; ` +
					`using ${unreported[0].maxTokens} (pin "maxTokens" in models.json to change it)`,
				"info",
			);
		}
		return models;
	};

	let models: ChatModel[];
	try {
		models = await discover();
	} catch (err) {
		notify(
			`${LOG_PREFIX} ${entry.id}: discovery failed against ${modelsUrlFor(entry)}: ` +
				`${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
		return false;
	}

	pi.registerProvider(entry.id, {
		baseUrl: entry.baseUrl,
		...(entry.api ? { api: entry.api as ProviderModelConfig["api"] } : {}),
		models,
		refreshModels: async (context: { allowNetwork?: boolean; signal?: AbortSignal }) => {
			if (context.allowNetwork === false) {
				if (lastModels.length === 0) throw new Error(`${entry.id}: no models discovered yet`);
				return lastModels;
			}
			try {
				return await discover(context.signal);
			} catch (err) {
				if (lastModels.length === 0) throw err;
				notify(
					`${LOG_PREFIX} ${entry.id}: refresh failed, keeping the last list: ` +
						`${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
				return lastModels;
			}
		},
	});

	notify(
		`${LOG_PREFIX} ${entry.id}: ${models.length} model(s) from ${modelsUrlFor(entry)}: ` +
			`${models.map((m) => `${m.id} (${m.contextWindow} tokens, ${m.input.join("+")})`).join(", ")}`,
		"info",
	);
	return true;
}

export default async function (pi: ExtensionAPI) {
	/** Register or unregister one provider according to its current flag. */
	const applyProvider = async (entry: ProviderEntry, notify: Notify): Promise<void> => {
		if (entry.discoverModels === true) {
			if (canDiscover(entry)) await registerProvider(pi, entry, notify);
			else notify(`${LOG_PREFIX} ${entry.id}: discovery is on but it has no baseUrl or modelsUrl`, "warning");
		} else if (entry.discoverModels === false) {
			// Discovery turned off on purpose: hand it back to plain models.json.
			pi.unregisterProvider(entry.id);
		}
	};

	/** Discover or un-discover every provider in models.json. Safe to re-run. */
	const run = async (notify: Notify): Promise<void> => {
		let providers: ProviderEntry[];
		try {
			providers = await readModelsJsonProviders(MODELS_JSON);
		} catch (err) {
			notify(
				`${LOG_PREFIX} cannot read ${MODELS_JSON}: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			return;
		}

		for (const entry of providers) await applyProvider(entry, notify);
	};

	// The factory is awaited before startup continues, so the model list is ready for
	// model selection and `pi --list-models`. A dead endpoint costs up to FETCH_TIMEOUT_MS
	// per provider here and reports one error line rather than hanging startup.
	await run((message, level) => {
		if (level && level !== "info") console.error(message);
	});

	// Re-read on every session start: a local server can change its context window
	// between sessions, and there is no cached list to go stale.
	pi.on("session_start", (_event, ctx) => {
		void run((message, level) => ctx.ui.notify(message, level ?? "info"));
	});

	// The menu stays open after a toggle so several providers can be changed in one go.
	// A toggle takes effect immediately: models.json is the record, and the provider is
	// registered or unregistered in the same handler, so no /reload is needed.
	pi.registerCommand("model-context", {
		description: "Toggle automatic model discovery per provider",
		handler: async (_args, ctx) => {
			const notify: Notify = (message, level) => ctx.ui.notify(message, level ?? "info");
			const refreshAll = "refresh every provider with discovery on";

			for (;;) {
				let providers: ProviderEntry[];
				try {
					providers = (await readModelsJsonProviders(MODELS_JSON)).filter(canDiscover);
				} catch (err) {
					notify(
						`${LOG_PREFIX} cannot read ${MODELS_JSON}: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
					return;
				}
				if (providers.length === 0) {
					notify(`${LOG_PREFIX} no provider in ${MODELS_JSON} has a baseUrl or modelsUrl`, "warning");
					return;
				}

				const options = providers.map((p) => `${discoveryFlag(p) === "on" ? "on " : "off"}  ${p.id}`);
				options.push(refreshAll);
				const picked = await ctx.ui.select("Model discovery - choose a provider to toggle", options);
				if (!picked) return; // Esc closes the menu
				if (picked === refreshAll) {
					await run(notify);
					continue;
				}

				const target = providers[options.indexOf(picked)];
				if (!target) continue;
				const enable = discoveryFlag(target) !== "on";
				try {
					if (!(await setDiscoveryFlagInFile(MODELS_JSON, target.id, enable))) {
						notify(`${LOG_PREFIX} ${target.id}: already discovery ${enable ? "on" : "off"}`, "info");
						continue;
					}
				} catch (err) {
					notify(
						`${LOG_PREFIX} could not write ${MODELS_JSON}: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
					return;
				}
				notify(
					`${LOG_PREFIX} ${target.id}: discovery ${enable ? "on" : "off"} ` +
						`(models.json edited in place, previous copy in models.json.bak)`,
					"info",
				);
				await applyProvider({ ...target, discoverModels: enable }, notify);
			}
		},
	});

	pi.registerCommand("model-context-refresh", {
		description: "Re-read models.json and re-fetch every provider with discoverModels",
		handler: async (_args, ctx) => {
			await run((message, level) => ctx.ui.notify(message, level ?? "info"));
		},
	});
}
