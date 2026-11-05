/**
 * pi-commit-attribution: put the `Assisted-by:` trailer on commits an agent makes, without the model
 * remembering to write it and without installing anything into the repository.
 *
 * The trailer is added by git hooks. The session points git at a hooks directory Pi owns through
 * `GIT_CONFIG_*`, which is config for one process only, so the repositories stay untouched and the whole
 * arrangement ends when the process does. Each generated hook runs the hook the repository declares with
 * its arguments and exit status, in sh, and then hands the message hooks to `apply.mjs`. That step can
 * only tell a Pi commit from a human one because Pi puts the model in the child's environment.
 *
 * Commands:
 *   /attribution            status for this session and the repository it sits in
 *   /attribution test       one commit in a throwaway repository, and the message it produced
 *   /attribution disable    stop attributing for the rest of this session
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { assistedBy, finalizeLines, resolveModel } from "./format.mjs";
import type { ModelCatalog } from "./format.mjs";
import { configPath, loadConfig, type AttributionConfig } from "./config.ts";
import { git } from "./git.ts";
import { CHAINED_HOOKS, farmIsCurrent, inventory, repoHookDirs, writeFarm, type HookInventory } from "./hooks.ts";
import { applyInjection, MARKER, planInjection, readInjection } from "./inject.ts";
import { appendEntries, diffSnapshot, ledgerTarget, prune, readEntries, snapshot, unclaimedPaths } from "./ledger.ts";
import { attributionHome, hooksDir, writeState } from "./state.ts";

const STATUS_KEY = "pi-commit-attribution";
const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_SPECIFIER = "pi-subagents/required-child-extensions";
const requireResolve = createRequire(join(HERE, "index.ts")).resolve;

/** Tools that change files in the working tree, and so make the next snapshot worth taking. */
const MUTATING_TOOLS = new Set(["edit", "write"]);

interface Session {
	config: AttributionConfig;
	problems: string[];
	home: string;
	farmDir: string;
	applyPath: string;
	conflict?: string;
	/** Last snapshot per repository, so the next one yields a delta rather than the whole working tree. */
	baselines: Map<string, Map<string, string>>;
	lastSnapshotAt: number;
	/** Only ledger observations made during this session can outrank its own claims. */
	startedAt: number;
	checkedCommits: Set<string>;
	disabled: boolean;
}

export default function (pi: ExtensionAPI) {
	const session: Session = {
		config: loadConfig().config,
		problems: [],
		home: attributionHome(),
		farmDir: hooksDir(),
		applyPath: join(HERE, "apply.mjs"),
		baselines: new Map(),
		lastSnapshotAt: 0,
		startedAt: Date.now(),
		checkedCommits: new Set(),
		disabled: false,
	};
	let restore: (() => void) | undefined;
	/** The pi-subagents registration that keeps this extension loaded in child sessions. */
	let children: { dispose: () => void } | undefined;

	pi.on("session_start", async (_event, ctx) => {
		teardown();
		const loaded = loadConfig();
		session.config = loaded.config;
		session.problems = loaded.problems;
		session.baselines.clear();
		session.checkedCommits.clear();
		session.startedAt = Date.now();
		session.lastSnapshotAt = 0;
		session.disabled = !session.config.enabled;

		if (session.disabled || session.config.inject === "off") {
			status(ctx, "attribution off");
			return;
		}

		if (!existsSync(session.applyPath)) {
			session.problems.push(`${session.applyPath} is missing; the extension is incomplete`);
			status(ctx, "attribution unavailable", true);
			return;
		}

		const probe = spawnSync(process.execPath, [session.applyPath, "--self-test"], { encoding: "utf8", timeout: 15_000 });
		if (probe.status !== 0) {
			session.problems.push(`this Node cannot run ${session.applyPath}: ${(probe.stderr || String(probe.status ?? "unknown")).trim()}`);
			status(ctx, "attribution unavailable", true);
			return;
		}

		writeFarm(session.farmDir, {
			applyPath: session.applyPath,
			home: session.home,
			configPath: configPath(),
			modelsPath: modelsPath(),
		});
		writeState({ tool: "pi", toolVersion: VERSION, sessionId: ctx.sessionManager.getSessionId() }, session.home);

		const plan = planInjection(process.env, session.farmDir);
		session.conflict = plan.conflict;
		if (plan.conflict) {
			status(ctx, "attribution skipped: hooks routed elsewhere", true);
			return;
		}
		restore = applyInjection(process.env, plan.vars);

		children = await registerChildExtensions(ctx.sessionManager.getSessionId());
		const common = ledgerTarget(ctx.cwd);
		if (common) prune(common);
		// The baseline is taken before anything can change, so the first observation after a write is a
		// delta. Taken at the first observation instead, a session that wrote one file and committed it
		// would credit itself with nothing, and a subagent that wrote one file would disappear from the
		// commit entirely.
		session.baselines.set(ctx.cwd, snapshot(ctx.cwd));
		status(ctx);
	});

	pi.on("session_shutdown", async () => teardown());

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const command = commandOf(event.input);
		// Snapshot before a commit rather than after it: once the commit is made the working tree is
		// clean, and a turn that wrote files and committed them in one go would credit nobody.
		if (/\bgit\b[^\n]*\bcommit\b/.test(command)) record(ctx, true);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "bash") {
			const command = commandOf(event.input);
			if (/\bgit\b[^\n]*\bcommit\b/.test(command) && !event.isError) warnIfUnattributed(ctx, command);
			return;
		}
		if (!MUTATING_TOOLS.has(event.toolName)) return;
		// One snapshot per two seconds of editing: a turn that ran twenty edits is one observation.
		record(ctx, Date.now() - session.lastSnapshotAt >= 2_000);
	});

	// The subcommand is documented in the description rather than a schema: the command has three fixed
	// words and Pi shows the description wherever the user is typing.
	pi.registerCommand("attribution", {
		description: "Report how commits are attributed in this session; `test` commits in a throwaway repository, `disable` stops for this session",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().split(/\s+/)[0];
			if (sub === "disable") {
				session.disabled = true;
				teardown();
				ctx.ui.notify("pi-commit-attribution: off for this session; repositories and hooks left as they were", "info");
				status(ctx, "attribution off");
				return;
			}
			if (sub === "test") {
				ctx.ui.notify(describeTrial(ctx), "info");
				return;
			}
			report(ctx);
		},
	});

	function teardown() {
		if (restore) restore();
		restore = undefined;
		if (children) children.dispose();
		children = undefined;
	}

	function commandOf(input: unknown): string {
		const command = (input as { command?: unknown } | undefined)?.command;
		return typeof command === "string" ? command : "";
	}

	function currentTrailer(ctx: ExtensionContext): string | undefined {
		const model = ctx.model;
		if (!model) return undefined;
		const catalog: ModelCatalog = { providers: { [model.provider]: { baseUrl: model.baseUrl, models: [{ id: model.id, name: model.name, baseUrl: model.baseUrl }] } } };
		const resolved = resolveModel({ provider: model.provider, id: model.id }, { catalog, providers: session.config.providers, models: session.config.models, localDomains: session.config.localDomains });
		return assistedBy(resolved, { name: "pi", version: VERSION });
	}

	/**
	 * Record which files this session is responsible for. `force` skips the throttle, which is what a
	 * commit needs: the observation has to happen while the tree still shows the work.
	 */
	function record(ctx: ExtensionContext, force = false): void {
		if (session.disabled || !session.config.ledger) return;
		if (!force && Date.now() - session.lastSnapshotAt < 2_000) return;
		const trailer = currentTrailer(ctx);
		if (!trailer) return;
		const cwd = ctx.cwd;
		const previous = session.baselines.get(cwd) ?? snapshot(cwd);
		const next = snapshot(cwd);
		const common = ledgerTarget(cwd);
		if (!common) return;
		const entries = readEntries(common, session.startedAt);
		const changed = unclaimedPaths(diffSnapshot(previous, next), entries, ctx.sessionManager.getSessionId());
		session.baselines.set(cwd, next);
		if (changed.length === 0) return;
		session.lastSnapshotAt = Date.now();
		try {
			appendEntries(common, { t: Date.now(), session: ctx.sessionManager.getSessionId(), trailer }, changed);
		} catch (error) {
			session.problems.push(`ledger write failed: ${(error as Error).message}`);
		}
	}

	/**
	 * A commit whose message carries no `Assisted-by:` means the injection did not reach git. The usual
	 * reason is that the command overrode it (`-c core.hooksPath=...`, its own `GIT_CONFIG_COUNT`), and
	 * nothing here can survive that, so the session says so instead of trying to rewrite the commit.
	 */
	function warnIfUnattributed(ctx: ExtensionContext, command: string): void {
		if (session.disabled || !process.env[MARKER]) return;
		const head = git(["log", "-1", "--format=%H%x00%B"], ctx.cwd);
		if (!head.ok) return;
		const [sha, message] = head.stdout.split("\0");
		if (message.includes("Assisted-by:") || session.checkedCommits.has(sha)) return;
		session.checkedCommits.add(sha);
		ctx.ui.notify(`pi-commit-attribution: ${sha.slice(0, 8)} has no Assisted-by trailer; the command reached git without the injected hooks (${command.slice(0, 60)})`, "warning");
	}

	/** One commit in a temporary repository, so the report can show the message instead of describing it. */
	function describeTrial(ctx: ExtensionContext): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-attribution-trial-"));
		const made = git(["init", "-q", "."], dir);
		if (!made.ok) return `trial could not start: ${made.stderr.trim()}`;
		try {
			git(["config", "user.email", "trial@example.com"], dir);
			git(["config", "user.name", "Attribution Trial"], dir);
			git(["config", "commit.gpgsign", "false"], dir);
			writeFileSync(join(dir, "trial.txt"), "trial\n");
			git(["add", "trial.txt"], dir);
			// Pi puts PI_MODEL in the environment of each command it runs, not in the session process, so the
			// trial has to supply what a real command would have carried.
			const model = ctx.model;
			const env = { ...process.env, PI_MODEL: model?.id ?? "unresolved", PI_PROVIDER: model?.provider ?? "unresolved", [MARKER]: "1" };
			const commit = spawnSync("git", ["commit", "-q", "-m", "feat: trial commit"], { cwd: dir, encoding: "utf8", env });
			if (commit.status !== 0) return `trial commit failed: ${(commit.stderr ?? "").trim()}`;
			return `trial message:\n${git(["log", "-1", "--format=%B"], dir).stdout.trim()}`;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	function report(ctx: ExtensionCommandContext): void {
		const lines: string[] = [];
		const injected = readInjection(process.env);
		const ours = injected.entries.filter((entry) => entry.key === "core.hooksPath");
		lines.push(session.disabled || session.config.inject === "off" ? "attribution: off this session" : `attribution: hooks at ${session.farmDir}`);
		lines.push(`injected core.hooksPath: ${ours.length ? ours.map((entry) => entry.value).join(", ") : "none"}${session.conflict ? ` (${session.conflict})` : ""}`);
		lines.push(`farm: ${farmIsCurrent(session.farmDir, { applyPath: session.applyPath, home: session.home, configPath: configPath(), modelsPath: modelsPath() }) ? "current" : "not installed"}`);
		const trailer = currentTrailer(ctx);
		lines.push(`this model: ${trailer ?? "no model resolved"}`);
		const configured = session.config.operator;
		const identity = configured ?? identityOf(ctx.cwd);
		lines.push(`operator: ${identity ?? "not resolved, so no Operated-by line"}${configured ? " (from attribution.json)" : " (the identity this repository authors with, so Operated-by appears only when the author is overridden)"}`);
		const found = repoInventory(ctx.cwd);
		lines.push(`repository hooks: ${found.declared.length ? found.declared.map((name) => `${name} (${found.paths[name]})`).join(", ") : "the repository declares none"}`);
		for (const [name, reason] of Object.entries(found.unchained)) lines.push(`not chained: ${name} - ${reason}`);
		for (const problem of session.problems) lines.push(`problem: ${problem}`);
		ctx.ui.notify(lines.join("\n"), "info");
	}

	/** The identity git would author with in this repository, which is what Operated-by falls back to. */
	function identityOf(cwd: string): string | undefined {
		const name = git(["config", "user.name"], cwd).stdout.trim();
		const email = git(["config", "user.email"], cwd).stdout.trim();
		return name && email ? `${name} <${email}>` : undefined;
	}

	function repoInventory(cwd: string): HookInventory {
		const run = git(["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"], cwd);
		if (!run.ok) return inventory([]);
		const [top, gitDir, rawCommon] = run.stdout.trim().split("\n");
		const commonDir = rawCommon.startsWith("/") ? rawCommon : join(top, rawCommon);
		const declared = repoHookDirs({ top, gitDir, commonDir }).flatMap((dir) => {
			if (!existsSync(dir)) return [];
			return readdirSync(dir)
				.filter((name) => !name.endsWith(".sample"))
				.filter((name) => spawnSync("sh", ["-c", 'test -x "$1"', "sh", join(dir, name)], { stdio: "ignore" }).status === 0)
				.map((name) => ({ name, path: join(dir, name) }));
		});
		return inventory(declared);
	}

	function status(ctx: ExtensionContext, text?: string, error = false): void {
		if (!text && session.problems.length === 0 && !session.conflict) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const label = text ?? `attribution: ${session.problems[0] ?? session.conflict}`;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(error ? "error" : "warning", label));
	}
}

function modelsPath(): string {
	return process.env.PI_ATTRIBUTION_MODELS ?? process.env.PI_MODELS_JSON ?? join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"), "models.json");
}

/**
 * Subagent children. A local foreground child runs inside this process and never loads the ambient
 * extensions, and a background child loads them only when its agent definition allows it, so a session
 * that delegates has to ask pi-subagents to load this one into the child. Without pi-subagents installed
 * there is nothing to ask, and a commit then credits the models this session saw.
 */
interface RequiredChildExtensions {
	registerRequiredChildExtensions?: (input: { sessionId: string; extensions: Array<{ id: string; path: string }> }) => { dispose: () => void } | undefined;
}

async function registerChildExtensions(sessionId: string): Promise<{ dispose: () => void } | undefined> {
	let target: string | undefined;
	try {
		// pi-subagents is a sibling extension, not a dependency of this one: resolve it from the package
		// directory Pi installs extensions into, so a child registration does not depend on where this
		// repository happens to live.
		target = requireResolve(CHILD_SPECIFIER, { paths: [join(homedir(), ".pi", "agent", "npm", "node_modules")] });
	} catch {
		return undefined;
	}
	try {
		const module = (await import(pathToFileURL(target).href)) as RequiredChildExtensions;
		return module.registerRequiredChildExtensions?.({ sessionId, extensions: [{ id: "pi-commit-attribution", path: join(HERE, "index.ts") }] });
	} catch {
		return undefined;
	}
}
