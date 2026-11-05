/**
 * Reading a delegation the session made, so its files can be credited to the model that wrote them.
 *
 * A subagent that runs in its own process loads this extension and records its own ledger line. A
 * foreground subagent is a session inside the parent's Pi process, and those load no ambient extensions
 * (pi-subagents does that on purpose, so the parent does not start a second copy of each one), so nothing
 * records the child's work and the parent's next snapshot would claim it for the parent's model. The
 * parent is the only place left that can see the work: it knows which model it asked for and what the
 * working tree looked like before and after the call.
 *
 * What is not here is a reading of the child's answer. The subagent tool reports prose, and prose about
 * files is not evidence about files, so the file list comes from the git snapshot around the call.
 */

/** The tool pi-subagents registers for one child, parallel children, and scripted workflows. */
export const DELEGATION_TOOL = "subagent";

/** Model specs named by a delegation: `{model}` for one child, `{args:{tasks:[{model}]}}` for a fan-out. */
export function delegatedModels(input: unknown): string[] {
	const found = new Set<string>();
	addModel(input, found);
	const args = (input as { args?: unknown } | undefined)?.args;
	const tasks = (args as { tasks?: unknown } | undefined)?.tasks;
	if (Array.isArray(tasks)) for (const task of tasks) addModel(task, found);
	return [...found];
}

function addModel(value: unknown, into: Set<string>): void {
	const model = (value as { model?: unknown } | undefined)?.model;
	if (typeof model === "string" && model.includes("/")) into.add(model.trim());
}

/**
 * Split a `provider/model` spec, where the provider itself may contain slashes: the catalog keys are
 * checked longest-first, so `phantomglass/strata/qwen3` keeps its provider and `openai/gpt` still splits
 * once. The first candidate that the catalog knows wins; with no catalog match the spec is split at the
 * first slash, which is what Pi's own `provider/model` form means.
 */
export function splitModelSpec(spec: string, knownProviders: readonly string[]): { provider: string; id: string } {
	const parts = spec.split("/");
	for (let take = knownProviders.length ? Math.min(parts.length - 1, Math.max(...knownProviders.map((p) => p.split("/").length))) : 0; take >= 1; take--) {
		const provider = parts.slice(0, take).join("/");
		if (knownProviders.includes(provider)) return { provider, id: parts.slice(take).join("/") };
	}
	return { provider: parts[0], id: parts.slice(1).join("/") };
}

/** The ledger key for work a child did on this session's behalf, so the session cannot claim it twice. */
export function delegatedSessionId(sessionId: string, toolCallId: string): string {
	return `${sessionId}-delegated-${toolCallId}`;
}
