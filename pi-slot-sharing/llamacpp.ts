/**
 * llama.cpp backend.
 *
 * The save/restore API is llama.cpp's own — Strata copied it — so the transport is shared and the
 * capability probe works unchanged: `post_slots` checks `slot_save_path.empty()` before it looks at the
 * slot id or the action, and reports `ERROR_TYPE_NOT_SUPPORTED`, which `format_error_response` maps to
 * 501. Same status, same probe.
 *
 * Two things llama.cpp does *not* do, and the extension has to know the difference:
 *
 *   - It has no RAM admission check. `handle_slots_save` / `handle_slots_restore` post the task with no
 *     preflight at all, so there is no arithmetic to mirror and no `gate()`. Guessing at another
 *     server's memory would be worse than trying the restore and handling the failure.
 *   - It has no `/v1/status`: no engine start time, no reported RAM. Facts come from `/props`
 *     (`total_slots`, `model_alias`, `build_info`, `default_generation_settings.n_ctx`).
 *
 * And one thing it does that Strata deliberately refuses: `-np, --parallel N` gives it several real
 * slots at once. Several live slots means no turn-taking is needed, so the caller stands down rather
 * than swapping conversations behind a server that is already serving them concurrently.
 */

import { probeCapability, slotAction, type ServerInfo, type SlotBackend, type SlotCapability, type SlotResult } from "./backend.ts";
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

	constructor(client: JsonClient) {
		this.client = client;
	}

	async info(): Promise<ServerInfo> {
		const props = await this.client.request<LlamaCppProps>("/props");
		return {
			kind: this.kind,
			model: props.model_alias,
			version: props.build_info,
			// llama.cpp does not report the KV cache type over HTTP; it is a launch argument.
			kv: undefined,
			maxContext: props.default_generation_settings?.n_ctx,
			totalSlots: props.total_slots,
		};
	}

	capability(): Promise<SlotCapability> {
		return probeCapability(this.client);
	}

	save(fileName: string): Promise<SlotResult> {
		return slotAction(this.client, "save", fileName);
	}

	restore(fileName: string): Promise<SlotResult> {
		return slotAction(this.client, "restore", fileName);
	}
}
