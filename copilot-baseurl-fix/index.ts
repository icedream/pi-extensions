/**
 * Copilot BaseURL Fix
 *
 * Fixes compaction failures (421 / "Connection error") when using
 * GitHub Copilot Business or Enterprise plans.
 *
 * Root cause: Pi's summarization path for compaction sends requests to
 * the default individual endpoint (`api.individual.githubcopilot.com`)
 * regardless of the user's actual seat type, causing the endpoint to
 * reject or drop the request.
 *
 * This extension intercepts `globalThis.fetch` and rewrites the host
 * to match the seat type stored in the token's `proxy-ep` field.
 *
 * Forked from https://github.com/earendil-works/pi/issues/6768#issuecomment-5172433814
 * by @evillase.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_HOST = "api.individual.githubcopilot.com";
const FLAG = "__piCopilotBaseUrlFix";
const AUTH_PATH = join(homedir(), CONFIG_DIR_NAME, "agent", "auth.json");

/**
 * Extract the correct API host from the user's token.
 *
 * Reads auth.json each time so token refreshes are picked up.
 */
function seatHost(): string | null {
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
    const token = auth?.["github-copilot"]?.access;
    const proxyEp =
      typeof token === "string"
        ? /proxy-ep=([^;]+)/.exec(token)?.[1]
        : undefined;
    const host = proxyEp?.replace(/^proxy\./, "api.");
    return host && host !== DEFAULT_HOST ? host : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite a URL to use the correct seat host if it matches the default.
 */
function rewrite(url: string): string {
  if (!url.includes(DEFAULT_HOST)) return url;
  const host = seatHost();
  return host ? url.replace(DEFAULT_HOST, host) : url;
}

export default function copilotBaseUrlFix(_pi: ExtensionAPI): void {
  const scope = globalThis as typeof globalThis & Record<string, unknown>;
  if (scope[FLAG]) return;
  scope[FLAG] = true;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    if (typeof input === "string") return originalFetch(rewrite(input), init);
    if (input instanceof URL) return originalFetch(new URL(rewrite(input.href)), init);
    const request = input as Request;
    const url = rewrite(request.url);
    return originalFetch(url === request.url ? request : new Request(url, request), init);
  } as typeof globalThis.fetch;
}
