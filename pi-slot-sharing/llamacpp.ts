/**
 * llama.cpp backend.
 *
 * The save/restore API is llama.cpp's own — Strata copied it — so the transport is shared and the
 * capability probe works unchanged: `post_slots` checks `slot_save_path.empty()` before it looks at the
 * slot id or the action, and reports `ERROR_TYPE_NOT_SUPPORTED`, which `format_error_response` maps to
 * 501. Same status, same probe.
 *
 * Two modes, and they address slots differently:
 *
 *   - **plain `llama-server`** — one process, one model. `/slots/0` is the whole story, and `/props`
 *     reports `total_slots`.
 *   - **router mode** (`--models-preset`) — one process fronting one child server per model. `/props` is
 *     answered by the router itself and is synthetic (no `total_slots`, `n_ctx` 0), and every slot route
 *     is refused with "model name is missing from the request" unless the model is named: `?model=` on
 *     GET, `"model"` in the body on POST. Naming a model also loads it, so every call here carries
 *     `autoload=false` — if the model is not resident the call fails and the session re-prefills, rather
 *     than the extension silently starting a multi-minute load.
 *
 * What llama.cpp does *not* do, and the extension has to know the difference:
 *
 *   - No RAM admission check. `handle_slots_save` / `handle_slots_restore` post the task with no
 *     preflight, so there is no arithmetic to mirror and no `gate()`.
 *   - No `/v1/status`: no engine start time, no reported RAM.
 */

import { detectRouter, probeCapability, slotAction, slotPromptTokens, type ServerInfo, type SlotBackend, type SlotCapability, type SlotResult, type SlotTarget } from "./backend.ts";
import { JsonClient } from "./http.ts";

interface LlamaCppProps {
	model_alias?: string;
	build_info?: string;
	total_slots?: number;
	default_generation_settings?: { n_ctx?: number };
	endpoint_metrics?: boolean;
}

export class LlamaCppBackend implements SlotBackend {
	readonly kind = "llama.cpp" as const;
	private client: JsonClient;
	private target: SlotTarget;

	constructor(client: JsonClient, target: SlotTarget = {}) {
		this.client = client;
		this.target = target;
	}

	async info(): Promise<ServerInfo> {
		const props = await this.client.request<LlamaCppProps>("/props");
		const router = detectRouter(props);
		let real = props;

		// In router mode the router's own /props says nothing useful about the model. Ask the child that
		// serves it — with autoload=false, so a model that is not resident stays not resident.
		if (router && this.target.model) {
			try {
				real = await this.client.request<LlamaCppProps>(`/props?model=${encodeURIComponent(this.target.model)}&autoload=false`);
			} catch {
				// not loaded: the synthetic answer is the honest one
			}
		}

		return {
			kind: this.kind,
			router,
			model: real.model_alias,
			version: real.build_info ?? props.build_info,
			// llama.cpp does not report the KV cache type over HTTP; it is a launch argument.
			kv: undefined,
			maxContext: real.default_generation_settings?.n_ctx || props.default_generation_settings?.n_ctx,
			totalSlots: real.total_slots,
		};
	}

	capability(): Promise<SlotCapability> {
		return probeCapability(this.client, this.target);
	}

	slotTokens(): Promise<number | undefined> {
		return slotPromptTokens(this.client, this.target);
	}

	save(fileName: string): Promise<SlotResult> {
		return slotAction(this.client, "save", fileName, this.target);
	}

	restore(fileName: string): Promise<SlotResult> {
		return slotAction(this.client, "restore", fileName, this.target);
	}
}
