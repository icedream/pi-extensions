/**
 * Backend selection and field mapping, checked against payloads copied from the two servers rather than
 * from imagination: Strata 0.1.44 `/props`, and llama.cpp b10920 `/props` as assembled in
 * `server-context.cpp` (`total_slots: params.n_parallel`, `build_info: meta.build_info`).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { availableBytesFrom, detectKind, detectRouter, slotAction, slotPromptTokens, type ServerInfo, type SlotBackend } from "./backend.ts";
import { JsonClient, ServerHttpError } from "./http.ts";
import { LlamaCppBackend } from "./llamacpp.ts";
import { StrataBackend } from "./strata.ts";
import { MIB } from "./sessions.ts";

/** A JsonClient stand-in that answers with canned bodies and records the calls. */
function fakeClient(responses: Record<string, unknown>, calls: string[] = []): JsonClient {
	const client = {
		request: async (path: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${path}`);
			const match = Object.entries(responses).find(([route]) => path.startsWith(route));
			if (!match) throw new Error(`unexpected call ${path}`);
			return match[1];
		},
	} as unknown as JsonClient;
	return client;
}

test("the two servers are told apart by what they say about themselves", () => {
	const strataProps = {
		default_generation_settings: { n_ctx: 393216, params: { n_predict: -1 } },
		total_slots: 1,
		model_alias: "qwen3.8-flash-next-iq3_s",
		model_path: "/data/models/IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf",
		build_info: "Strata 0.1.44",
		models_autoload: true,
		is_sleeping: false,
	};
	const llamaProps = {
		default_generation_settings: { n_ctx: 131072, params: { n_predict: -1 } },
		total_slots: 4,
		model_alias: "Qwen3.5-27B-Ud-GGUF",
		model_ftype: "Q4_K_XL",
		build_info: "b10920 4a1f0e2",
		endpoint_slots: true,
		endpoint_props: true,
		endpoint_metrics: false,
	};
	assert.equal(detectKind(strataProps), "strata");
	assert.equal(detectKind(llamaProps), "llama.cpp");
	assert.equal(detectKind({}), undefined);
	assert.equal(detectKind(undefined), undefined);
	assert.equal(detectKind("<html>502 Bad Gateway</html>"), undefined);
});

test("save and restore field names are shared, and both are read", async () => {
	const calls: string[] = [];
	const client = fakeClient(
		{
			"/slots/0?action=save": { id_slot: 0, filename: "pi-x.bin", n_saved: 107_695, n_written: 1_734_536_070 },
			"/slots/0?action=restore": { id_slot: 0, filename: "pi-x.bin", n_restored: 107_695, n_read: 1_734_536_070 },
		},
		calls,
	);
	const saved = await slotAction(client, "save", "pi-x.bin");
	const restored = await slotAction(client, "restore", "pi-x.bin");
	assert.deepEqual(saved, { fileName: "pi-x.bin", tokens: 107_695, bytes: 1_734_536_070 });
	assert.deepEqual(restored, { fileName: "pi-x.bin", tokens: 107_695, bytes: 1_734_536_070 });
	assert.deepEqual(calls, ["POST /slots/0?action=save", "POST /slots/0?action=restore"]);
});

test("the slot's current prompt size is read from GET /slots", async () => {
	// both servers report it: llama.cpp server_slot::to_json, Strata's /slots
	const strata = fakeClient({ "/slots": [{ id: 0, n_ctx: 393216, is_processing: false, n_prompt_tokens: 61594 }] });
	assert.equal(await slotPromptTokens(strata), 61594);

	// a server that does not report it is unknown, not zero
	assert.equal(await slotPromptTokens(fakeClient({ "/slots": [{ id: 0, n_ctx: 4096 }] })), undefined);
	assert.equal(await slotPromptTokens(fakeClient({ "/slots": {} })), undefined);

	// llama.cpp without --slots answers 501; unknown must not become a refusal or a zero
	const refused = { request: async () => { throw new ServerHttpError("This server does not support slots endpoint", 501); } } as unknown as JsonClient;
	assert.equal(await slotPromptTokens(refused), undefined);
});

test("router mode is recognised and addressed per model", async () => {
	// captured live from the docker-llamacpp router with no model loaded
	const routerProps = {
		default_generation_settings: { params: {}, n_ctx: 0 },
		build_info: "b10850-6e09de1b4",
		model_alias: "llama-server",
		cors_proxy_enabled: false,
	};
	assert.equal(detectKind(routerProps), "llama.cpp", "no total_slots must not make it unknown");
	assert.equal(detectRouter(routerProps), true);

	const plain = { default_generation_settings: { n_ctx: 512 }, total_slots: 1, build_info: "b10920 4a1f0e2" };
	assert.equal(detectRouter(plain), false, "a plain llama-server reports total_slots");
	assert.equal(detectRouter({ build_info: "Strata 0.1.44", total_slots: 1 }), false, "Strata is never a router");
	assert.equal(detectRouter(undefined), false);

	const calls: string[] = [];
	const recording = {
		request: async (path: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${path} ${String(init?.body ?? "")}`);
			return [];
		},
	} as unknown as JsonClient;
	const router = new LlamaCppBackend(recording, { model: "maple", router: true });
	await router.slotTokens();
	await router.save("pi-x.bin");
	await router.restore("pi-x.bin");
	await router.capability();

	assert.deepEqual(calls, [
		"GET /slots?model=maple&autoload=false ",
		'POST /slots/0?action=save&model=maple&autoload=false {"filename":"pi-x.bin","model":"maple"}',
		'POST /slots/0?action=restore&model=maple&autoload=false {"filename":"pi-x.bin","model":"maple"}',
		'POST /slots/0?action=capability&model=maple&autoload=false {"model":"maple"}',
	]);
});

test("a plain llama-server is addressed without a model parameter", async () => {
	const calls: string[] = [];
	const recording = {
		request: async (path: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${path}`);
			return [];
		},
	} as unknown as JsonClient;
	const plain = new LlamaCppBackend(recording, { model: "qwen3-coder", router: false });
	await plain.slotTokens();
	await plain.save("pi-x.bin");
	assert.deepEqual(calls, ["GET /slots", "POST /slots/0?action=save"]);
});

test("only Strata warns before it fails", () => {
	const strata: SlotBackend = new StrataBackend(fakeClient({}));
	const llama: SlotBackend = new LlamaCppBackend(fakeClient({}));
	assert.equal(typeof strata.gate, "function");
	assert.equal(llama.gate, undefined, "llama.cpp has no admission check to mirror");
	assert.equal(strata.kind, "strata");
	assert.equal(llama.kind, "llama.cpp");
});

test("llama.cpp facts come from /props alone, and it reports no KV type", async () => {
	const llama = new LlamaCppBackend(
		fakeClient({
			"/props": { default_generation_settings: { n_ctx: 131072 }, total_slots: 1, model_alias: "Qwen3.5-27B", build_info: "b10920 4a1f0e2" },
		}),
	);
	const info = await llama.info();
	assert.deepEqual(info, { kind: "llama.cpp", router: false, model: "Qwen3.5-27B", version: "b10920 4a1f0e2", kv: undefined, maxContext: 131072, totalSlots: 1 });
	assert.equal(info.started, undefined, "no /v1/status on llama.cpp: a restart cannot be noticed there");
});

test("Strata merges its three reporting endpoints", async () => {
	const strata = new StrataBackend(
		fakeClient({
			"/v1/status": { started: 1791983814, context: { native: 393216, max_positions: 393216 }, machine: { ram: { used_gib: 58.5, total_gib: 62.0 } } },
			"/metrics": { engine: { model: "qwen3.8-flash-next-iq3_s", max_context: 393216, kv: "int8", version: "0.1.44", conversation_cache_min_free_mib: 1024 } },
			"/props": { total_slots: 1 },
		}),
	);
	const info = await strata.info();
	assert.equal(info.kind, "strata");
	assert.equal(info.kv, "int8");
	assert.equal(info.maxContext, 393216);
	assert.equal(info.totalSlots, 1);
	assert.equal(info.started, 1791983814);
	assert.deepEqual(info.ram, { usedGib: 58.5, totalGib: 62 });
	assert.equal(info.conversationCacheMinFreeMib, 1024, "the gate's floor comes from the server, not from a guess");
});

test("a server that does not report its floor leaves it unset rather than inventing one", async () => {
	const strata = new StrataBackend(
		fakeClient({
			"/v1/status": { started: 1791983814 },
			"/metrics": { engine: { model: "qwen3.8-flash-next-iq3_s", kv: "int8" } },
			"/props": { total_slots: 1 },
		}),
	);
	assert.equal((await strata.info()).conversationCacheMinFreeMib, undefined);
});

test("free RAM: meminfo wins, the server's used/total is the fallback, neither is neither", () => {
	const info: ServerInfo = { kind: "strata", ram: { usedGib: 58.5, totalGib: 62 } };
	const meminfo = "MemTotal: 64000000 kB\nMemAvailable:   4112384 kB\n";
	assert.equal(availableBytesFrom(info, meminfo), 4112384 * 1024);
	const fromServer = availableBytesFrom(info);
	assert.ok(fromServer !== undefined && Math.abs(fromServer - 3.5 * 1024 * MIB) < MIB);
	assert.equal(availableBytesFrom({ kind: "llama.cpp" }), undefined);
	assert.equal(availableBytesFrom(undefined, "nonsense"), undefined);
});

test("the shared capability probe reads 501 as off and anything else as on", async () => {
	const throwing = (status: number, message: string) =>
		({
			request: async () => {
				throw new ServerHttpError(message, status);
			},
		}) as unknown as JsonClient;

	// llama.cpp: "This server does not support slots action. Start it with `--slot-save-path`" -> 501
	const off = await new LlamaCppBackend(throwing(501, "This server does not support slots action. Start it with `--slot-save-path`")).capability();
	assert.equal(off.enabled, false);
	assert.match(off.reason ?? "", /slot-save-path/);

	// enabled: the probe's bogus action is rejected after the enable check
	const on = await new LlamaCppBackend(throwing(400, "Unknown action")).capability();
	assert.equal(on.enabled, true);

	// an unreachable server is not "off"; the caller reports it separately
	const unreachable = await new StrataBackend(throwing(0, "connection refused")).capability();
	assert.equal(unreachable.enabled, true, "unknown is not the same as refused");
});
