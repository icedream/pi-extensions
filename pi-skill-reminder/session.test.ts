/**
 * End to end: does the notice about dropped skill rules actually reach the model, and does the model's own
 * read of the file close it?
 *
 * The unit test drives the handlers directly; this one runs a real AgentSession against a scripted
 * OpenAI-compatible endpoint and reads the request bodies the endpoint received. No GPU, no cloud model,
 * no network.
 *
 *   npm run e2e
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "scripted";
const MODEL_ID = "scripted-check";
const NOTICE = "Skills this session read but no longer holds";
const RELOAD = "Skill rules reloaded";
const MARKER = "Name the file, not the convention.";
const EXTENSION = fileURLToPath(new URL("./index.ts", import.meta.url));

interface StubTurn {
	content?: string;
	tool_calls?: { name: string; args: Record<string, unknown> }[];
}

function createStubModel(turns: StubTurn[], promptTokens = 400) {
	const requests: { body: { messages: unknown[] } }[] = [];
	let index = 0;

	const server = http.createServer((req, res) => {
		const parts: Buffer[] = [];
		req.on("data", (d) => parts.push(d as Buffer));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
			requests.push({ body });

			const script = turns[Math.min(index, turns.length - 1)];
			index += 1;

			const base = { id: `stub-${index}`, object: "chat.completion.chunk", created: 0, model: MODEL_ID };
			const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
			send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
			if (script.content) {
				send({ ...base, choices: [{ index: 0, delta: { content: script.content }, finish_reason: null }] });
			}
			for (const [i, call] of (script.tool_calls ?? []).entries()) {
				send({
					...base,
					choices: [{
						index: 0,
						delta: { tool_calls: [{ index: i, id: `call_${index}_${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }] },
						finish_reason: null,
					}],
				});
			}
			send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: script.tool_calls?.length ? "tool_calls" : "stop" }] });
			send({ ...base, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 20, total_tokens: promptTokens + 20 } });
			send("[DONE]");
			res.end();
		});
	});

	const listen = new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

	return {
		async start() {
			const port = await listen;
			return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() };
		},
	};
}

function writeModels(agentDir: string, baseUrl: string, contextWindow: number) {
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[PROVIDER]: {
					api: "openai-completions",
					apiKey: "test-key",
					baseUrl,
					models: [{ id: MODEL_ID, name: "Scripted check model", contextWindow, reasoning: false }],
				},
			},
		}, null, 2),
	);
}

/**
 * `contextWindow` only matters for the automatic compaction scenario: a small window makes the
 * between-turn check cross its threshold inside a single run.
 */
function makeEnv(contextWindow = 131072) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-reminder-"));
	const agentDir = path.join(root, "agent");
	const skillPath = path.join(agentDir, "skills", "demo-guidelines", "SKILL.md");
	fs.mkdirSync(path.dirname(skillPath), { recursive: true });
	fs.writeFileSync(
		skillPath,
		`---\nname: demo-guidelines\ndescription: "Test skill."\n---\n\n# Demo guidelines\n\n${MARKER}\n`,
	);
	writeModels(agentDir, "http://127.0.0.1:1/v1", contextWindow);
	// Manual compaction refuses a session with nothing to cut, so the keep window has to be tiny.
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ compaction: { enabled: true, reserveTokens: contextWindow - 1000, keepRecentTokens: 1 } }, null, 2),
	);
	return { agentDir, skillPath, sessionDir: path.join(root, "sessions"), contextWindow };
}

async function openSession(env: ReturnType<typeof makeEnv>, baseUrl: string, sessionManager?: SessionManager, withExtension = true) {
	writeModels(env.agentDir, baseUrl, env.contextWindow);
	const services = await createAgentSessionServices({
		cwd: env.agentDir,
		agentDir: env.agentDir,
		resourceLoaderOptions: { noExtensions: true, additionalExtensionPaths: withExtension ? [EXTENSION] : [] },
	});
	const model = services.modelRuntime.getModel(PROVIDER, MODEL_ID);
	assert.ok(model, `model ${PROVIDER}/${MODEL_ID} did not resolve`);
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: sessionManager ?? SessionManager.create(env.agentDir, env.sessionDir),
		model,
		thinkingLevel: "off",
	});
	return session;
}

const sentText = (requests: { body: { messages: unknown[] } }[]) => requests.map((r) => JSON.stringify(r.body.messages)).join("\n");

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const noticesIn = (session: { sessionManager: SessionManager }) =>
	session.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "skill-rules").length;

const e2e = { skip: process.env.PI_SKILL_REMINDER_E2E !== "1" };

/** The mode is read from the environment on each call, so a scenario can select it without a restart. */
async function withMode(value: string, run: () => Promise<void>) {
	const previous = process.env.PI_SKILL_RULES;
	process.env.PI_SKILL_RULES = value;
	try {
		await run();
	} finally {
		if (previous === undefined) delete process.env.PI_SKILL_RULES;
		else process.env.PI_SKILL_RULES = previous;
	}
}

test("a dropped skill is noticed once, and the model's own read closes it", { ...e2e }, async () => {
	const env = makeEnv();
	const model = await createStubModel([
		{ tool_calls: [{ name: "read", args: { path: env.skillPath } }] },
		{ content: "read it" },
		{ content: "compacted summary" },
		{ tool_calls: [{ name: "read", args: { path: env.skillPath } }] },
		{ content: "re-read it" },
		{ content: "second prompt" },
	]).start();
	try {
		const session = await openSession(env, model.baseUrl);
		await session.prompt("read the skill");
		await session.compact();
		await session.prompt("and now?");

		const sent = sentText(model.requests);
		assert.ok(sent.includes(NOTICE), "the notice never reached the model");
		assert.ok(sent.includes(env.skillPath), "the notice did not name the file to re-read");
		assert.match(sent, /Read each applicable file/, "the notice did not ask for a full read");
		assert.match(sent, /skills that do not apply to this task/, "the notice did not scope the re-read to the task");
		assert.equal(noticesIn(session), 1, `the same boundary was noticed ${noticesIn(session)} times`);

		// The scripted model re-reads the file after the notice, so the rules are in context again.
		await session.prompt("and now again?");
		const later = JSON.stringify(model.requests[model.requests.length - 1].body.messages);
		assert.ok(later.includes(MARKER), "the model's re-read did not put the skill text back in context");
		assert.equal(noticesIn(session), 1, "a closed skill was noticed again");
		session.dispose();
	} finally {
		model.close();
	}
});

test("the default notice carries the path and not the file text", { ...e2e }, async () => {
	const env = makeEnv();
	const model = await createStubModel([
		{ tool_calls: [{ name: "read", args: { path: env.skillPath } }] },
		{ content: "read it" },
		{ content: "compacted summary" },
		{ content: "ack after compaction" },
	]).start();
	try {
		const session = await openSession(env, model.baseUrl);
		await session.prompt("read the skill");
		await session.compact();
		await session.prompt("and now?");

		const [notice] = session.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "skill-rules") as { content: string }[];
		assert.ok(notice, "no notice entry was recorded");
		assert.ok(notice.content.includes(NOTICE), "the notice is not the list form");
		assert.ok(notice.content.includes(env.skillPath), "the notice did not name the file to re-read");
		assert.ok(!notice.content.includes(MARKER), "the default notice injected the whole skill file");
		session.dispose();
	} finally {
		model.close();
	}
});

test("PI_SKILL_RULES=full puts the file text in front of the model itself", { ...e2e }, async () => {
	await withMode("full", async () => {
		const env = makeEnv();
		const model = await createStubModel([
			{ tool_calls: [{ name: "read", args: { path: env.skillPath } }] },
			{ content: "read it" },
			{ content: "compacted summary" },
			{ content: "ack after compaction" },
		]).start();
		try {
			const session = await openSession(env, model.baseUrl);
			await session.prompt("read the skill");
			await session.compact();
			await session.prompt("and now?");

			const sent = sentText(model.requests);
			assert.ok(sent.includes(RELOAD), "the reload notice never reached the model");
			assert.ok(sent.includes(MARKER), "the reload did not carry the skill text");
			assert.equal(noticesIn(session), 1, `the text was injected ${noticesIn(session)} times`);
			session.dispose();
		} finally {
			model.close();
		}
	});
});

test("no skill read means no notice", { ...e2e }, async () => {
	const env = makeEnv();
	const model = await createStubModel([
		{ content: "nothing read here" },
		{ content: "compacted summary" },
		{ content: "ack after compaction" },
	]).start();
	try {
		const session = await openSession(env, model.baseUrl);
		await session.prompt("say something");
		await session.compact();
		await session.prompt("and now?");
		assert.ok(!sentText(model.requests).includes(NOTICE), "a notice was sent without any skill read");
		session.dispose();
	} finally {
		model.close();
	}
});

test("an automatic compaction inside one run notices before that run continues", { ...e2e }, async () => {
	const env = makeEnv(4000);
	const filler = "filler line\n".repeat(300);
	const model = await createStubModel([
		{ tool_calls: [{ name: "read", args: { path: env.skillPath } }] },
		{ tool_calls: [{ name: "bash", args: { command: `printf '%s' '${filler}'` } }] },
		{ content: "still working" },
		{ content: "done" },
	]).start();
	try {
		const session = await openSession(env, model.baseUrl);
		await session.prompt("read the skill then run the command");

		const entries = session.sessionManager.getBranch();
		assert.ok(entries.some((e) => e.type === "compaction"), "the run never compacted, so this scenario proves nothing");
		assert.equal(noticesIn(session), 1, `the notice was sent ${noticesIn(session)} times during one run`);

		const last = JSON.stringify(model.requests[model.requests.length - 1].body.messages);
		assert.ok(last.includes(NOTICE), "the last turn of the run answered without the notice");
		assert.ok(last.includes(env.skillPath), "the notice inside the run did not name the file");
		session.dispose();
	} finally {
		model.close();
	}
});

test("a resumed session is told before its first answer", { ...e2e }, async () => {
	const env = makeEnv();
	const writer = await createStubModel([
		{ tool_calls: [{ name: "read", args: { path: env.skillPath } }] },
		{ content: "read it" },
		{ content: "first summary" },
		{ content: "keep going" },
		{ content: "second summary" },
	]).start();

	// Two compactions with a run between them, written without the extension so nothing notices:
	// the transcript is left naming a skill it can no longer quote.
	let sessionFile = "";
	try {
		const session = await openSession(env, writer.baseUrl, undefined, false);
		await session.prompt("read the skill");
		await session.compact();
		await session.prompt("and now?");
		await session.compact();
		sessionFile = session.sessionManager.getSessionFile() ?? "";
		assert.ok(sessionFile && fs.existsSync(sessionFile), "session file not found");
		session.dispose();
	} finally {
		writer.close();
	}

	const model = await createStubModel([
		{ content: "ack after resume" },
		{ content: "second prompt" },
	]).start();
	try {
		// A fresh extension instance: nothing is known until the transcript is scanned.
		const session = await openSession(env, model.baseUrl, SessionManager.open(sessionFile));
		const projection = session.sessionManager.buildContextEntries();
		assert.ok(!JSON.stringify(projection).includes(MARKER), "the resumed context still held the skill text, so this proves nothing");

		await session.prompt("and now?");
		const first = JSON.stringify(model.requests[0].body.messages);
		assert.ok(first.includes(NOTICE), "the resumed session started without the notice");
		assert.ok(first.includes(env.skillPath), "the resumed notice did not name the file");
		session.dispose();
	} finally {
		model.close();
	}
});
