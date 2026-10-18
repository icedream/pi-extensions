/**
 * Configuration for pi-thinking-hygiene.
 *
 * The matcher is the product here, so the config only carries a switch and a way to widen it
 * without editing the extension. An absent config file means the default: on.
 */

import { existsSync, readFileSync } from "node:fs";

export interface Config {
	enabled: boolean;
	/** Extra anchored openings, tried alongside the built-in ones. */
	extraPatterns: RegExp[];
}

export const DEFAULT_CONFIG: Config = { enabled: true, extraPatterns: [] };

/** `undefined` when the input is usable; a message when it is not. */
export function parseConfig(raw: unknown): { config?: Config; problem?: string } {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { problem: "config must be a JSON object" };
	}
	const entry = raw as Record<string, unknown>;
	const config: Config = { ...DEFAULT_CONFIG };
	if (entry.enabled !== undefined) {
		if (typeof entry.enabled !== "boolean") return { problem: `"enabled" must be a boolean, got ${typeof entry.enabled}` };
		config.enabled = entry.enabled;
	}
	if (entry.extraPatterns !== undefined) {
		if (!Array.isArray(entry.extraPatterns) || entry.extraPatterns.some((p) => typeof p !== "string")) {
			return { problem: `"extraPatterns" must be an array of regex source strings` };
		}
		const patterns: RegExp[] = [];
		for (const source of entry.extraPatterns as string[]) {
			try {
				patterns.push(new RegExp(source, "i"));
			} catch (error) {
				return { problem: `"extraPatterns" entry is not a valid regex: ${(error as Error).message}` };
			}
		}
		config.extraPatterns = patterns;
	}
	const unknown = Object.keys(entry).filter((key) => key !== "enabled" && key !== "extraPatterns");
	if (unknown.length > 0) return { problem: `unknown config key(s): ${unknown.join(", ")}` };
	return { config };
}

export function loadConfig(path: string): { config: Config; problem?: string } {
	if (!existsSync(path)) return { config: DEFAULT_CONFIG };
	try {
		const parsed = parseConfig(JSON.parse(readFileSync(path, "utf8")));
		return parsed.config ? { config: parsed.config } : { config: DEFAULT_CONFIG, problem: parsed.problem };
	} catch (error) {
		return { config: DEFAULT_CONFIG, problem: `${path}: ${(error as Error).message}` };
	}
}
