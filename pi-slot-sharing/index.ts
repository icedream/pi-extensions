/**
 * pi-slot-sharing — let several Pi sessions take turns on a server that holds one sequence.
 *
 * A server that can hold only one conversation at a time makes every Pi session but the last one
 * re-prefill from scratch on each turn. Such a server can usually write the conversation it is holding
 * out to a file and read it back (`POST /slots/0?action=save|restore` — llama.cpp's API, which Strata
 * implements). Reading it back is far cheaper than re-prefilling it: measured on Qwen3.8-Flash-Next at
 * 107,695 tokens, 6.8 s to restore against 64.5 s to re-prefill, and the follow-up request reused
 * 107,690 of 107,695 prompt tokens.
 *
 * This extension does the turn-taking: before each provider request it makes sure the slot holds *this*
 * session's conversation, saving and restoring as needed, and arbitrating through a lock file so
 * concurrent Pi processes do not decide against each other.
 *
 * Nothing about the server is baked in. The backend is picked from `/props` (or stated in the config),
 * and each backend reports what its server will tell us — see backend.ts for what Strata and llama.cpp
 * share and where they differ. Bytes per token of a session file is learned from the server's own
 * `n_written` / `n_saved` on the first save. Whether save/restore is available at all is probed.
 *
 * Strata refuses a restore it cannot hold in RAM, and the refusal happens *before* it releases the
 * conversation in the slot, so the Strata backend mirrors that arithmetic and skips a restore that would
 * be refused. The session still works: the request prefills as it would have anyway. llama.cpp has no
 * such check, so there is nothing to predict there and the extension just tries.
 *
 * Config: ~/.pi/agent/slot-sharing.json (override with PI_SLOT_SHARING_CONFIG). Without a config
 * file the extension does nothing.
 *
 * Commands:
 *   /slot-sharing             what the server reports, what the gate allows, what is saved
 *   /slot-sharing-forget      drop this session's saved conversation from the index
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAuth, type AuthResolver } from "./auth.ts";
import { availableBytesFrom, detectKind, readProps, type ServerInfo, type ServerKind, type SlotBackend, type SlotCapability } from "./backend.ts";
import { loadConfig, settingsFor, type ResolvedConfig, type Settings } from "./config.ts";
import { JsonClient, ServerHttpError } from "./http.ts";
import { LlamaCppBackend } from "./llamacpp.ts";
import { StrataBackend } from "./strata.ts";
import { SessionStore } from "./store.ts";
import { bytesPerTokenFromSave, sessionKey, slotFilenameProblem, maxRestorableTokens, type SessionIndex } from "./sessions.ts";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = process.env.PI_SLOT_SHARING_CONFIG ?? join(AGENT_DIR, "slot-sharing.json");
const STATE_DIR = process.env.PI_SLOT_SHARING_STATE ?? join(AGENT_DIR, "slot-sharing");

const INFO_TTL_MS = 5_000;
const MEMINFO_PATH = "/proc/meminfo";

function fileNameFor(key: string): string {
	return `pi-${createHash("sha256").update(key).digest("hex").slice(0, 40)}.bin`;
}

function modelRef(ctx: ExtensionContext): string {
	return `${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}`;
}

const normalizeUrl = (url: string) => url.replace(/\/+$/, "").replace(/\/v1$/, "");

/**
 * Which server to talk to: the one the model this session uses already reports. Pi carries it, so the
 * config does not repeat it.
 */
function serverUrl(ctx: ExtensionContext): string | undefined {
	return ctx.model?.baseUrl ? normalizeUrl(ctx.model.baseUrl) : undefined;
}

/** Should this session take part at all? A model with no server cannot have a slot to share. */
function servesModel(ctx: ExtensionContext): boolean {
	return ctx.model?.baseUrl !== undefined;
}

function readMeminfo(): string | undefined {
	try {
		return readFileSync(MEMINFO_PATH, "utf8");
	} catch {
		return undefined;
	}
}

function isLoopback(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
	} catch {
		return false;
	}
}

const gib = (bytes: number) => `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
const describe = (error: unknown) => (error instanceof ServerHttpError ? `${error.status} ${error.message}` : String(error));

export default async function (pi: ExtensionAPI) {
	const loaded = loadConfig(CONFIG_PATH);
	if (!loaded.present) return;
	if (loaded.problems.length > 0 || !loaded.config) {
		const problems = loaded.problems.join("; ");
		pi.on("session_start", (_event, ctx) => ctx.ui.notify(`pi-slot-sharing: ${problems}`, "error"));
		return;
	}
	const cfg = loaded.config;
	const store = new SessionStore(STATE_DIR);

	/** The knobs that apply to this session's provider. They describe one server, not the extension. */
	const settings = (ctx: ExtensionContext): Settings => settingsFor(cfg, ctx.model?.provider);

	let backendChoice: { key?: string; url?: string; backend?: SlotBackend; note?: string } | undefined;
	let authSource = "none";
	let infoCache: { at: number; info?: ServerInfo; capability?: SlotCapability; note?: string } = { at: 0 };
	let turns = 0;
	let lastNote = "";

	function note(message: string, ctx: ExtensionContext): void {
		if (message === lastNote) return;
		lastNote = message;
		ctx.ui.notify(`pi-slot-sharing: ${message}`, "info");
	}

	/**
	 * Which server is this, and what does it speak? Credentials are resolved per model from Pi's provider
	 * store, so the choice is cached against the model reference and re-resolved when the model changes.
	 */
	async function pickBackend(ctx: ExtensionContext): Promise<{ key?: string; url?: string; backend?: SlotBackend; note?: string }> {
		const url = serverUrl(ctx);
		if (!url) return { note: "this model reports no server, so there is no slot to share" };
		const key = `${url}|${modelRef(ctx)}`;
		if (backendChoice?.key === key) return backendChoice;

		const resolved = await resolveAuth(ctx.modelRegistry as unknown as AuthResolver, ctx.model);
		authSource = resolved.source;
		if (!resolved.auth) return { key, url, note: resolved.note ?? "no credentials" };
		const client = new JsonClient(url, resolved.auth);

		let kind: ServerKind | undefined;
		if (!kind) {
			try {
				kind = detectKind(await readProps(client));
			} catch (error) {
				backendChoice = { key, url, note: `${url} unreadable: ${describe(error)}` };
				return backendChoice;
			}
		}
		if (!kind) {
			backendChoice = { key, url, note: `${url} is neither Strata nor llama.cpp; standing down` };
			return backendChoice;
		}
		backendChoice = { key, url, backend: kind === "strata" ? new StrataBackend(client) : new LlamaCppBackend(client) };
		return backendChoice;
	}

	async function info(force = false, ctx?: ExtensionContext) {
		if (!force && Date.now() - infoCache.at < INFO_TTL_MS) return infoCache;
		if (!ctx) return { at: Date.now(), note: "no session context" };
		const picked = await pickBackend(ctx);
		if (!picked.backend) return { at: Date.now(), note: picked.note };
		const next: typeof infoCache = { at: Date.now() };
		try {
			next.info = await picked.backend.info();
			next.capability = await picked.backend.capability();
		} catch (error) {
			next.note = describe(error);
		}
		infoCache = next;
		return next;
	}

	function availableBytes(found: ServerInfo | undefined, ctx: ExtensionContext): number | undefined {
		const url = serverUrl(ctx);
		return availableBytesFrom(found, url && isLoopback(url) ? readMeminfo() : undefined);
	}

	function identity(ctx: ExtensionContext) {
		const sessionId = ctx.sessionManager.getSessionId();
		const ref = modelRef(ctx);
		const key = sessionKey(sessionId, ref);
		return { sessionId, ref, key, fileName: fileNameFor(key) };
	}

	/** A server with several live slots is already serving sessions at once; there is nothing to arbitrate. */
	function singleSlot(found: ServerInfo | undefined): boolean {
		return found?.totalSlots === undefined || found.totalSlots <= 1;
	}

	/** Make sure the server's slot holds this session. Runs before every provider request. */
	async function ensureLoaded(ctx: ExtensionContext): Promise<void> {
		const s = settings(ctx);
		if (!s.enabled || !servesModel(ctx)) return;
		const { sessionId, key, fileName } = identity(ctx);
		const url = serverUrl(ctx) ?? "the model's server";
		const problem = slotFilenameProblem(fileName);
		if (problem) {
			note(`session file name ${problem}`, ctx);
			return;
		}
		if (store.readOwner()?.key === key) return; // already ours, nothing to do

		const found = await info(false, ctx);
		if (found.note) {
			note(`server unreadable, leaving the slot alone (${found.note})`, ctx);
			return;
		}
		if (!singleSlot(found.info)) {
			note(`${url} runs ${found.info?.totalSlots} slots at once — nothing to take turns over`, ctx);
			return;
		}
		if (!found.capability?.enabled) {
			note(`slot save/restore is off on ${url}; sessions will each re-prefill`, ctx);
			return;
		}
		const backend = found.info ? (await pickBackend(ctx)).backend : undefined;
		if (!backend) return;

		await store.withLock(s.lockStaleMs, async () => {
			if (store.readOwner()?.key === key) return;
			const index = store.readIndex();
			const entry = index.records[key];
			const claim = () => store.writeOwner({ key, sessionId, pid: process.pid, at: Math.floor(Date.now() / 1000) });

			if (!entry) {
				// First request of this session here: nothing saved to read, the request prefills.
				claim();
				return;
			}
			if (entry.stale) {
				note(`saved conversation is stale (${entry.stale}), re-prefilling`, ctx);
				claim();
				return;
			}

			const fresh = (await info(true, ctx)).info;
			const available = availableBytes(fresh, ctx);
			const verdict = backend.gate && available !== undefined ? backend.gate({ availableBytes: available, floorBytes: s.ramFloorBytes, marginBytes: s.marginBytes, fileBytes: entry.record.bytes }) : undefined;
			if (verdict && !verdict.ok) {
				note(`${entry.record.tokens.toLocaleString()} token conversation not restored: ${verdict.reason}. This request re-prefills.`, ctx);
				claim();
				return;
			}
			if (s.maxSessionTokens !== undefined && entry.record.tokens > s.maxSessionTokens) {
				note(`${entry.record.tokens.toLocaleString()} tokens is over maxSessionTokens (${s.maxSessionTokens.toLocaleString()}); this request re-prefills`, ctx);
				claim();
				return;
			}

			try {
				const restored = await backend.restore(fileName);
				index.records[key] = { record: { ...entry.record, tokens: restored.tokens || entry.record.tokens } };
				store.writeIndex(index);
				claim();
				note(`restored ${restored.tokens.toLocaleString()} tokens (${gib(restored.bytes)}) from ${fileName}`, ctx);
			} catch (error) {
				note(`restore of ${fileName} failed (${describe(error)}); this request re-prefills`, ctx);
				claim();
			}
		});
	}

	async function saveNow(ctx: ExtensionContext, why: string): Promise<void> {
		const s = settings(ctx);
		if (!s.enabled || !servesModel(ctx)) return;
		const { sessionId, ref, key, fileName } = identity(ctx);
		if (slotFilenameProblem(fileName)) return;
		const found = await info(true, ctx);
		const backend = found.info ? (await pickBackend(ctx)).backend : undefined;
		if (!backend || !found.capability?.enabled || !singleSlot(found.info)) return;

		// A save is not free: it writes roughly tokens x KV-bytes-per-token to disk. On a server with no RAM
		// gate this cap is the only brake, so it has to stop the write and not merely the read back. An
		// unknown slot size fails open: refusing every save because GET /slots is switched off would break
		// the feature, and the note below says which case ran.
		if (s.maxSessionTokens !== undefined) {
			const held = await backend.slotTokens();
			if (held === undefined) {
				note("maxSessionTokens is set but the server does not report the slot size, so the save was not capped", ctx);
			} else if (held > s.maxSessionTokens) {
				note(`not saving: the slot holds ${held.toLocaleString()} tokens, over maxSessionTokens (${s.maxSessionTokens.toLocaleString()})`, ctx);
				return;
			}
		}

		await store.withLock(s.lockStaleMs, async () => {
			const owner = store.readOwner();
			if (owner && owner.key !== key) {
				// Somebody else's conversation is in the slot now; saving would write their conversation out
				// under our name, so there is nothing of ours to keep.
				const index = store.readIndex();
				if (index.records[key]) index.records[key].stale = `slot taken by ${owner.sessionId}`;
				store.writeIndex(index);
				return;
			}
			try {
				const saved = await backend.save(fileName);
				const index = store.readIndex();
				index.records[key] = {
					record: {
						sessionId,
						modelRef: ref,
						fileName,
						tokens: saved.tokens,
						bytes: saved.bytes,
						savedAt: Math.floor(Date.now() / 1000),
						engineStarted: found.info?.started ?? 0,
					},
				};
				const learned = bytesPerTokenFromSave(saved.bytes, saved.tokens);
				if (learned !== undefined) index.bytesPerToken = learned;
				store.writeIndex(index);
				store.writeOwner({ key, sessionId, pid: process.pid, at: Math.floor(Date.now() / 1000) });
			} catch (error) {
				note(`save (${why}) failed: ${describe(error)}`, ctx);
			}
		});
	}

	/** The saved KV no longer matches this conversation: the transcript changed underneath it. */
	function invalidate(ctx: ExtensionContext, why: string): void {
		if (!settings(ctx).enabled || !servesModel(ctx)) return;
		const { key } = identity(ctx);
		const index = store.readIndex();
		if (!index.records[key]) return;
		index.records[key].stale = why;
		store.writeIndex(index);
	}

	pi.on("before_provider_request", async (_event, ctx) => {
		await ensureLoaded(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		turns += 1;
		const every = settings(ctx).saveEveryTurns;
		if (every > 1 && turns % every !== 0) return;
		await saveNow(ctx, "end of run");
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		await saveNow(ctx, "session switch");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await saveNow(ctx, "shutdown");
		store.clearOwner();
	});

	pi.on("session_before_compact", async (_event, ctx) => invalidate(ctx, "compacted"));
	pi.on("session_before_fork", async (_event, ctx) => invalidate(ctx, "forked"));
	pi.on("session_before_tree", async (_event, ctx) => invalidate(ctx, "tree moved"));

	pi.on("model_select", async (_event, ctx) => {
		// Credentials and the backend both belong to a model: re-resolve them, and stop trusting the cache.
		backendChoice = undefined;
		infoCache = { at: 0 };
		// A file belongs to one model and configuration; after a switch the old one is not readable back.
		if (!settings(ctx).enabled) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const index = store.readIndex();
		for (const entry of Object.values(index.records)) {
			if (entry.record.sessionId === sessionId && !entry.stale) entry.stale = "model changed";
		}
		store.writeIndex(index);
	});

	pi.registerCommand("slot-sharing", {
		description: "Show what the server reports and what its RAM gate allows this session to restore",
		handler: async (_args, ctx) => {
			const found = await info(true, ctx);
			const picked = await pickBackend(ctx);
			const lines: string[] = [`config: ${CONFIG_PATH}`, `server: ${picked.url ?? "not resolved"} (from this model's provider)`];
			if (found.note) lines.push(`server error: ${found.note}`);
			lines.push(`credentials: ${authSource === "provider" ? "from Pi's provider store for this model" : authSource}`);
			lines.push(`backend: ${found.info?.kind ?? picked.note ?? "unknown"}${found.info?.version ? ` (${found.info.version})` : ""}`);
			if (found.info?.model) lines.push(`model: ${found.info.model}${found.info.kv ? `, kv ${found.info.kv}` : ""}`);
			if (found.info?.maxContext) lines.push(`context: ${found.info.maxContext.toLocaleString()} positions, slots: ${found.info.totalSlots ?? "?"}`);
			if (found.info?.started) lines.push(`engine started: ${new Date(found.info.started * 1000).toISOString()}`);
			if (found.info?.ram) lines.push(`server ram: ${found.info.ram.usedGib} of ${found.info.ram.totalGib} GiB used`);
			lines.push(`save/restore: ${found.capability?.enabled ? "on" : `off (${found.capability?.reason ?? "unknown"})`}`);

			const s = settings(ctx);
			const index = store.readIndex();
			const perToken = index.bytesPerToken ?? s.bytesPerTokenFallback;
			lines.push(`bytes/token: ${perToken.toFixed(0)} (${index.bytesPerToken ? "learned from saves" : "config fallback, no save measured yet"})`);
			lines.push(`provider: ${ctx.model?.provider ?? "?"}${cfg.byProvider[ctx.model?.provider ?? ""] ? " (per-provider settings apply)" : " (top-level settings)"}`);

			if (picked.backend?.gate) {
				lines.push(`gate: floor ${Math.round(s.ramFloorBytes / (1024 * 1024))} MiB (config), margin ${Math.round(s.marginBytes / (1024 * 1024))} MiB (config)`);
				const available = availableBytes(found.info, ctx);
				if (available !== undefined) {
					const room = maxRestorableTokens(available, s.ramFloorBytes, s.marginBytes, perToken);
					lines.push(`free now: ${gib(available)} -> a restore of up to ~${room.toLocaleString()} tokens fits`);
					if (ctx.model && ctx.model.contextWindow > room) {
						lines.push(`this session's window (${ctx.model.contextWindow.toLocaleString()}) is past that: a long session re-prefills instead of restoring`);
					}
				}
			} else {
				lines.push("gate: this server does not refuse restores it cannot hold, so they are attempted and failures handled");
			}

			const owner = store.readOwner();
			lines.push(`slot held by: ${owner ? `${owner.sessionId} (pid ${owner.pid})` : "nobody recorded"}`);
			const mine = index.records[identity(ctx).key];
			lines.push(`this session: ${mine ? `${mine.record.tokens.toLocaleString()} tokens, ${gib(mine.record.bytes)}${mine.stale ? `, stale: ${mine.stale}` : ""}` : "nothing saved"}`);
			for (const [key, entry] of Object.entries(index.records)) {
				if (key === identity(ctx).key) continue;
				lines.push(`  saved: ${entry.record.sessionId} ${entry.record.modelRef} ${entry.record.tokens.toLocaleString()} tok ${gib(entry.record.bytes)} ${new Date(entry.record.savedAt * 1000).toISOString()}${entry.stale ? ` stale: ${entry.stale}` : ""}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("slot-sharing-forget", {
		description: "Stop tracking this session's saved conversation",
		handler: async (_args, ctx) => {
			const { key } = identity(ctx);
			const index: SessionIndex = store.readIndex();
			const had = index.records[key] !== undefined;
			delete index.records[key];
			store.writeIndex(index);
			if (store.readOwner()?.key === key) store.clearOwner();
			ctx.ui.notify(had ? "dropped this session's saved conversation from the index" : "nothing saved for this session", "info");
		},
	});
}
