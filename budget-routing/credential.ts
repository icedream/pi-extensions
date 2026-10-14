/**
 * Finds a GitHub token that api.github.com accepts for the Copilot seat figure.
 *
 * Two sources, either of which is enough on its own:
 *   pi - Pi's own github-copilot credential in auth.json. Its `access` field is a Copilot proxy
 *        token ("tid=...") that api.github.com rejects; the `refresh` field is the GitHub
 *        user-to-server token ("ghu_...") that Pi exchanges for it, and that one works.
 *   gh - `gh auth token`, where gh reads its own keyring and the token never reaches this process.
 *
 * The token is only ever sent to api.github.com, never logged, and never written to a config file.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialSource } from "./budget.ts";

/**
 * GitHub OAuth token prefixes: gho (classic), ghu (user-to-server), ghs (server-to-server),
 * github_pat_ (fine-grained). ghr_ is a refresh token and is deliberately excluded: it is not a
 * bearer credential. "tid=" (the Copilot proxy token) is excluded the same way.
 */
const GH_TOKEN = /^(gh[ous]_|github_pat_)[A-Za-z0-9_-]+$/;

/** Picks a usable GitHub token from a stored credential, or undefined when there is none. Pure. */
export function pickGitHubToken(cred: unknown): string | undefined {
	if (typeof cred !== "object" || cred === null) return undefined;
	const c = cred as Record<string, unknown>;
	// `access` first: if GitHub ever hands back a GitHub token directly, use it without touching
	// the refresh field. Today it is a tid= token and falls through to `refresh`.
	for (const field of ["access", "refresh"]) {
		const v = c[field];
		if (typeof v === "string" && GH_TOKEN.test(v)) return v;
	}
	return undefined;
}

function ghAuthToken(): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile("gh", ["auth", "token"], { timeout: 10_000 }, (err, stdout) => {
			if (err) return resolve(undefined);
			const t = stdout.trim();
			resolve(t.length > 0 && GH_TOKEN.test(t) ? t : undefined);
		});
	});
}

/**
 * Resolves the token for `provider`. Callers must gate on the Copilot provider before getting here;
 * this function does not know about providers other than by the credential field name.
 */
export async function resolveGitHubToken(
	agentDir: string,
	want: CredentialSource,
	provider = "github-copilot",
): Promise<{ token: string; source: Exclude<CredentialSource, "auto"> }> {
	if (want !== "gh") {
		let token: string | undefined;
		try {
			const store = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
			token = pickGitHubToken(store[provider]);
		} catch {
			token = undefined; // no auth.json, or unreadable: fall through to gh
		}
		if (token) return { token, source: "pi" };
		if (want === "pi") throw new Error(`no GitHub token in Pi's ${provider} credential`);
	}

	const viaGh = await ghAuthToken();
	if (viaGh) return { token: viaGh, source: "gh" };
	throw new Error(want === "gh" ? "gh auth token returned no usable token" : `no GitHub credential available (Pi auth.json and gh both unusable)`);
}
