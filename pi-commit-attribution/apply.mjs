/**
 * The body of the two message hooks pi-commit-attribution installs: `prepare-commit-msg` and
 * `commit-msg`. Everything else the farm does is plain sh, because git may call a dozen hook names for
 * one command and starting Node for each would be rude.
 *
 * It is plain ES module JavaScript rather than TypeScript for one reason: git runs it in its own process,
 * and Pi supports Node releases that still need a flag to strip types. The format itself lives in
 * `format.mjs`, which the extension imports too, so there is one implementation of the line.
 *
 * Two rules keep this out of the way:
 *
 *   - It only acts when the environment says a Pi session is running (`PI_MODEL` from Pi, `PI_ATTR` from
 *     the extension). A human at a terminal, or Pi's own git calls, get nothing.
 *   - A message copied from an existing commit keeps the trailers it has. `--amend --no-edit`,
 *     `git commit -C <sha>` and a replayed rebase are not authoring, so a human commit an agent only
 *     content-amended is not retroactively credited.
 *
 * Failures exit 0 with one line on stderr: a broken attribution helper must never lose someone a commit.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assistedBy, finalizeLines, operatedBy, resolveModel } from "./format.mjs";

const hookName = process.argv[2] || "";
const hookArgs = process.argv.slice(3);

// The extension runs this before it installs the farm, so an unsupported Node is reported at session
// start rather than discovered at the first commit.
if (hookName === "--self-test") {
	console.log("pi-commit-attribution ok");
} else {
	try {
		attribute();
	} catch (error) {
		console.error(`pi-commit-attribution: skipped attribution: ${describe(error)}`);
	}
}

/** The message of whatever was thrown, without assuming it is an Error.
 *  @param {unknown} error */
function describe(error) {
	return error && typeof error === "object" && "message" in error ? String(/** @type {{ message: string }} */ (error).message) : String(error);
}

function attribute() {
	if (hookName !== "prepare-commit-msg" && hookName !== "commit-msg") return;
	if (!process.env.PI_ATTR || !process.env.PI_MODEL) return;

	const file = hookArgs[0];
	if (!file || !existsSync(file)) return;

	if (hookArgs[1] === "commit") return;
	// `commit-msg` gets the file alone, so the same rule is read from the message itself: byte-identical
	// to HEAD's message means the commit is being replaced rather than written.
	if (hookArgs.length === 1 && sameAsHead(readFileSync(file, "utf8"))) return;

	const message = readFileSync(file, "utf8");
	if (!hasContent(message)) return;

	const config = readConfig();
	if (config.enabled === false) return;

	const state = readState();
	const catalog = readCatalog();
	const repoName = gitConfig("user.name");
	const repoEmail = gitConfig("user.email");

	const lines = [];
	const model = resolveModel({ provider: process.env.PI_PROVIDER ?? "", id: process.env.PI_MODEL }, { catalog, providers: config.providers, models: config.models, localDomains: Array.isArray(config.localDomains) ? config.localDomains : [] });
	lines.push(assistedBy(model, { name: state?.tool ?? "pi", version: state?.toolVersion ?? "unknown" }));
	const fromLedger = ledgerLines();
	for (const entry of fromLedger) lines.push(entry);
	debug(`ledger contributed ${fromLedger.length} line(s)`);

	// The person driving the session is the identity the repository is configured with. `--author` and
	// GIT_AUTHOR_* change who a commit is credited to without changing who ran it, and a repository may be
	// set to a work address while the same person owns a personal one, so the line is only worth writing
	// when those two disagree.
	const authorEmail = process.env.GIT_AUTHOR_EMAIL || repoEmail;
	const configured = typeof config.operator === "string" && config.operator.trim() ? config.operator.trim() : undefined;
	const operator = operatedBy(configured ?? (repoName && repoEmail ? `${repoName} <${repoEmail}>` : undefined), authorEmail);
	if (operator) lines.push(operator);

	const wanted = finalizeLines(lines, config.maxModels ?? 8);
	if (wanted.length === 0) return;

	// `--if-exists=doNothing` looks at the key, so the second model's line would be dropped after the
	// first was written. Duplicates are matched by value here, and `addIfDifferent` keeps a near-match
	// from being written twice. `onExistingTrailer: "keep"` leaves a message alone once it carries an
	// `Assisted-by:` of the model's own.
	const existing = parseTrailers(file);
	if (config.onExistingTrailer === "keep" && existing.some((line) => /^assisted-by:/i.test(line))) return;
	const fresh = wanted.filter((line) => !existing.some((seen) => seen.trim().toLowerCase() === line.trim().toLowerCase()));
	if (fresh.length === 0) return;

	const args = ["interpret-trailers", "--in-place", "--where=end", "--if-exists=addIfDifferent", "--if-missing=add"];
	for (const trailer of fresh) args.push("--trailer", trailer);
	args.push(file);

	const run = spawnSync("git", args, { encoding: "utf8", env: process.env });
	if (run.status !== 0) console.error(`pi-commit-attribution: git interpret-trailers failed: ${(run.stderr ?? "").trim()}`);
}

/**
 * Models recorded as having changed files this commit contains. The parent commit's timestamp is what
 * "since the last commit" means without keeping state: at commit time HEAD is still the commit before
 * this one, so an older observation cannot be credited to a commit it played no part in.
 */
/** @returns {string[]} */
function ledgerLines() {
	const common = revParse("--git-common-dir");
	if (!common) return [];
	const dir = common.startsWith("/") ? common : join(process.cwd(), common);
	const path = join(dir, "pi-attribution", "ledger.jsonl");
	if (!existsSync(path)) return [];

	const parent = spawnSync("git", ["log", "-1", "--format=%ct"], { encoding: "utf8", env: process.env });
	const since = parent.status === 0 ? Number.parseInt(parent.stdout.trim(), 10) * 1000 : 0;

	const staged = spawnSync("git", ["diff", "--cached", "--name-only", "-z"], { encoding: "utf8", env: process.env });
	if (staged.status !== 0) return [];
	const files = new Set(staged.stdout.split("\0").filter((entry) => entry.length > 0));
	if (files.size === 0) return [];

	const out = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry.t !== "number" || entry.t <= since) continue;
		if (typeof entry.trailer !== "string" || !Array.isArray(entry.files)) continue;
		if (!/** @type {string[]} */ (entry.files).some((file) => files.has(file))) continue;
		out.push(entry.trailer);
	}
	return out;
}

/** @param {string} file @returns {string[]} */
function parseTrailers(file) {
	const run = spawnSync("git", ["interpret-trailers", "--parse", "--only-trailers", "--only-input", "--unfold", file], { encoding: "utf8", env: process.env });
	if (run.status !== 0) return [];
	return run.stdout.split("\n").filter((line) => line.trim().length > 0);
}

/** @param {string} message */
function sameAsHead(message) {
	const head = spawnSync("git", ["log", "-1", "--format=%B"], { encoding: "utf8", env: process.env });
	if (head.status !== 0) return false;
	return head.stdout.trimEnd() === message.trimEnd();
}

/** @param {string} message */
function hasContent(message) {
	return message
		.split("\n")
		.some((line) => line.trim().length > 0 && !line.startsWith("#") && !line.startsWith("diff --git "));
}

/** @param {string} arg */
function revParse(arg) {
	const run = spawnSync("git", ["rev-parse", arg], { encoding: "utf8", env: process.env });
	return run.status === 0 ? run.stdout.trim() : undefined;
}

/** @param {string} key */
function gitConfig(key) {
	const run = spawnSync("git", ["config", "--get", key], { encoding: "utf8", env: process.env });
	return run.status === 0 ? run.stdout.trim() : undefined;
}

/** @param {string | undefined} path */
function readJson(path) {
	if (!path || !existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function readConfig() {
	return readJson(process.env.PI_ATTRIBUTION_CONFIG || join(homedir(), ".pi", "agent", "attribution.json")) ?? {};
}

function readState() {
	const home = process.env.PI_ATTRIBUTION_HOME || join(homedir(), ".pi", "agent", "attribution");
	return readJson(join(home, "state.json"));
}

function readCatalog() {
	return readJson(process.env.PI_ATTRIBUTION_MODELS ?? process.env.PI_MODELS_JSON ?? join(homedir(), ".pi", "agent", "models.json"));
}

/** @param {string} text */
function debug(text) {
	if (process.env.PI_ATTR_DEBUG) console.error(`pi-commit-attribution: ${text}`);
}
