/**
 * Credentials.
 *
 * The slot API is authenticated by the same token the model's requests carry, and Pi already holds that
 * token: `ctx.modelRegistry.getApiKeyAndHeaders(model)` resolves whatever the provider is configured
 * with — an API key in models.json, a value from the environment, or an OAuth credential with its
 * refresh handled — and returns the headers that go with it. So the extension asks Pi instead of
 * keeping a second copy of the secret in its own config.
 *
 * That matters beyond tidiness. A duplicated key is a second thing to rotate, a second file to keep out
 * of git, and a second place to be stale after a rotation. It also cannot refresh an OAuth credential.
 *
 * Order: an explicit `apiKey` in the config (an escape hatch for a server Pi has no credential for),
 * then the provider's own credentials for the current model, then `SLOT_SHARING_API_KEY` for headless
 * use with no Pi model in play.
 */

import type { RequestAuth } from "./http.ts";

/** The part of ModelRegistry this needs; keeps the resolution testable without a live registry. */
export interface AuthResolver {
	getApiKeyAndHeaders(model: unknown): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string | null> } | { ok: false; error: string }>;
}

export interface ResolvedAuth {
	auth?: RequestAuth;
	source: "config" | "provider" | "env" | "none";
	/** Why there are no credentials, for the caller to report rather than fail silently. */
	note?: string;
}

/** Provider headers may carry `null` to mean "delete this header"; those never go on our requests. */
function usableHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const kept = Object.fromEntries(Object.entries(headers).filter(([, value]) => typeof value === "string" && value.length > 0)) as Record<string, string>;
	return Object.keys(kept).length > 0 ? kept : undefined;
}

export async function resolveAuth(options: {
	configApiKey?: string;
	env?: NodeJS.ProcessEnv;
	registry?: AuthResolver;
	model?: unknown;
}): Promise<ResolvedAuth> {
	if (options.configApiKey) return { auth: { apiKey: options.configApiKey }, source: "config" };

	const { registry, model, env } = options;
	if (registry && model !== undefined) {
		const resolved = await registry.getApiKeyAndHeaders(model);
		if (resolved.ok && (resolved.apiKey || resolved.headers)) {
			return { auth: { apiKey: resolved.apiKey, headers: usableHeaders(resolved.headers) }, source: "provider" };
		}
		if (!resolved.ok) return { source: "none", note: resolved.error };
	}

	const fromEnv = env?.SLOT_SHARING_API_KEY;
	if (fromEnv) return { auth: { apiKey: fromEnv }, source: "env" };
	return { source: "none", note: "no credential for this model's provider, and no apiKey in the config" };
}
