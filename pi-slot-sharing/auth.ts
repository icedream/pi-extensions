/**
 * Credentials.
 *
 * The slot API is authenticated by the same token the model's requests carry, and Pi already holds that
 * token: `ctx.modelRegistry.getApiKeyAndHeaders(model)` resolves whatever the provider is configured
 * with — an API key in models.json, a value from the environment, or an OAuth credential with its
 * refresh handled — and returns the headers that go with it. The extension asks Pi, never stores a copy,
 * and never learns where the credential came from.
 *
 * Keeping a copy would mean a second secret to rotate, a second file to keep out of git, and a second
 * place to be stale after a rotation. It also could not refresh an OAuth credential, which is the failure
 * mode that actually bites eventually.
 */

import type { RequestAuth } from "./http.ts";

/** The part of ModelRegistry this needs; keeps the resolution testable without a live registry. */
export interface AuthResolver {
	getApiKeyAndHeaders(model: unknown): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string | null> } | { ok: false; error: string }>;
}

export interface ResolvedAuth {
	auth?: RequestAuth;
	source: "provider" | "none";
	/** Why there are no credentials, for the caller to report rather than fail silently. */
	note?: string;
}

/** Provider headers may carry `null` to mean "delete this header"; those never go on our requests. */
function usableHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const kept = Object.fromEntries(Object.entries(headers).filter(([, value]) => typeof value === "string" && value.length > 0)) as Record<string, string>;
	return Object.keys(kept).length > 0 ? kept : undefined;
}

export async function resolveAuth(registry: AuthResolver | undefined, model: unknown): Promise<ResolvedAuth> {
	if (!registry || model === undefined) {
		return { source: "none", note: "no model registry or no model in this context" };
	}
	const resolved = await registry.getApiKeyAndHeaders(model);
	if (!resolved.ok) return { source: "none", note: resolved.error };
	if (!resolved.apiKey && !resolved.headers) {
		return { source: "none", note: "the model's provider reports no credential" };
	}
	return { auth: { apiKey: resolved.apiKey, headers: usableHeaders(resolved.headers) }, source: "provider" };
}
