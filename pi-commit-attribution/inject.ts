/**
 * Putting the hook directory in front of git without touching git's configuration.
 *
 * `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` mean the same thing as `-c`:
 * measured on git 2.56, they outrank repository and global config, and they exist only in the process
 * that carries them. Setting them in `process.env` reaches everything a session spawns, Pi's own bin
 * directory handling included, and the values are gone when the process is.
 *
 * Two rules keep this honest: a count already in the environment is extended rather than replaced, and
 * a `core.hooksPath` the user injected themselves is never overwritten. Their value wins, and the
 * extension says so instead of quietly taking their hooks away.
 */

export const HOOKS_PATH_KEY = "core.hooksPath";

/** Present in the environment of any process a session starts, and the hook's proof that it is one. */
export const MARKER = "PI_ATTR";

export interface EnvRecord {
	[key: string]: string | undefined;
}

export interface InjectionPlan {
	vars: Record<string, string>;
	/** Set when the environment already routes hooks elsewhere; nothing is injected then. */
	conflict?: string;
}

export function planInjection(env: EnvRecord, hooksDir: string): InjectionPlan {
	const declared = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
	const count = Number.isFinite(declared) && declared > 0 ? declared : 0;

	for (let index = 0; index < count; index += 1) {
		if (env[`GIT_CONFIG_KEY_${index}`] === HOOKS_PATH_KEY) {
			return { vars: {}, conflict: `GIT_CONFIG_KEY_${index} already sets ${HOOKS_PATH_KEY} to ${env[`GIT_CONFIG_VALUE_${index}`] ?? ""}` };
		}
	}

	const vars: Record<string, string> = {
		GIT_CONFIG_COUNT: String(count + 1),
		[`GIT_CONFIG_KEY_${count}`]: HOOKS_PATH_KEY,
		[`GIT_CONFIG_VALUE_${count}`]: hooksDir,
		[MARKER]: "1",
	};
	return { vars };
}

/**
 * Applies the plan to `process.env` and returns the exact undo. A key that was not present is deleted
 * again rather than set to an empty string, so a session that starts and stops leaves the environment
 * byte for byte as it found it.
 */
export function applyInjection(env: EnvRecord, vars: Record<string, string>): () => void {
	const previous: EnvRecord = {};
	for (const [key, value] of Object.entries(vars)) {
		previous[key] = env[key];
		env[key] = value;
	}
	return () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete env[key];
			else env[key] = value;
		}
	};
}

/** Reads back what a live environment actually says, for `/attribution status`. */
export function readInjection(env: EnvRecord): { count: number; entries: Array<{ key: string; value: string }> } {
	const declared = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
	const count = Number.isFinite(declared) && declared > 0 ? declared : 0;
	const entries: Array<{ key: string; value: string }> = [];
	for (let index = 0; index < count; index += 1) {
		const key = env[`GIT_CONFIG_KEY_${index}`];
		if (!key) continue;
		entries.push({ key, value: env[`GIT_CONFIG_VALUE_${index}`] ?? "" });
	}
	return { count, entries };
}
