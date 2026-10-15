/**
 * Strata backend.
 *
 * Strata is the one server that tells you things: `/v1/status` carries the engine's start time and its
 * RAM, `/metrics` carries the model, the KV type and the context size. It is also the one server that
 * refuses a restore it cannot hold — see sessions.ts for the arithmetic it applies, mirrored here as
 * `gate()`. Refusing is a favour: a save at a size the restore cannot take back is otherwise a slow way
 * to discover the limit at the worst moment.
 */

import { probeCapability, slotAction, slotPromptTokens, type ServerInfo, type SlotBackend, type SlotCapability, type SlotResult } from "./backend.ts";
import { JsonClient } from "./http.ts";
import { restoreGate, type GateInput, type GateVerdict } from "./sessions.ts";

export class StrataBackend implements SlotBackend {
	readonly kind = "strata" as const;
	private client: JsonClient;

	constructor(client: JsonClient) {
		this.client = client;
	}

	async info(): Promise<ServerInfo> {
		const [status, metrics, props] = await Promise.all([
			this.client
				.request<{ started?: number; context?: { max_positions?: number }; machine?: { ram?: { used_gib?: number; total_gib?: number } } }>(
					"/v1/status",
				)
				.catch(() => undefined),
			this.client.request<{ engine?: { model?: string; max_context?: number; kv?: string; version?: string; conversation_cache_min_free_mib?: number } }>("/metrics").catch(() => undefined),
			this.client.request<{ total_slots?: number }>("/props").catch(() => undefined),
		]);

		const ram = status?.machine?.ram;
		return {
			kind: this.kind,
			model: metrics?.engine?.model,
			version: metrics?.engine?.version,
			kv: metrics?.engine?.kv,
			maxContext: status?.context?.max_positions ?? metrics?.engine?.max_context,
			totalSlots: props?.total_slots,
			conversationCacheMinFreeMib: metrics?.engine?.conversation_cache_min_free_mib,
			started: status?.started,
			ram: ram?.used_gib !== undefined && ram?.total_gib !== undefined ? { usedGib: ram.used_gib, totalGib: ram.total_gib } : undefined,
		};
	}

	capability(): Promise<SlotCapability> {
		return probeCapability(this.client);
	}

	slotTokens(): Promise<number | undefined> {
		return slotPromptTokens(this.client);
	}

	save(fileName: string): Promise<SlotResult> {
		return slotAction(this.client, "save", fileName);
	}

	restore(fileName: string): Promise<SlotResult> {
		return slotAction(this.client, "restore", fileName);
	}

	gate(input: GateInput): GateVerdict {
		return restoreGate(input);
	}
}
