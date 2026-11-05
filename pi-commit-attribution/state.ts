/**
 * Which files Pi remembers about an attribution session, and where.
 *
 * The git hook runs in its own process, outside the extension, and it needs the Pi version to name in
 * the trailer. Getting that from `pi --version` would start another Pi per commit, so the session writes
 * it here once. The paths to config and catalog are baked into the generated hooks instead, because they
 * are fixed for the life of the farm. Everything else the hook reads from the environment Pi already
 * sets (`PI_PROVIDER`, `PI_MODEL`) and from Pi's own model catalog.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SCHEMA = 1;

/** `~/.pi/agent/attribution`: the hook directory, the ledger per repository, and this state file. */
export function attributionHome(): string {
	return process.env.PI_ATTRIBUTION_HOME ?? join(homedir(), ".pi", "agent", "attribution");
}

export function hooksDir(home = attributionHome()): string {
	return join(home, "hooks");
}

export function statePath(home = attributionHome()): string {
	return join(home, "state.json");
}

export interface SessionState {
	schema: number;
	/** Baked so the hook names the tool version without starting `pi --version`. */
	tool: string;
	toolVersion: string;
	/** Written by the session that wrote this file, so a status line can say which one is current. */
	sessionId: string;
	updatedAt: string;
}

export function writeState(state: Omit<SessionState, "schema" | "updatedAt">, home = attributionHome()): string {
	const path = statePath(home);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ schema: SCHEMA, updatedAt: new Date().toISOString(), ...state }, null, "\t")}\n`);
	return path;
}
