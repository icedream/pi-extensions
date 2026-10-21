/**
 * End to end: does the reminder actually reach the model after a compaction?
 *
 * The unit test drives the handlers directly; this one runs a real AgentSession against a scripted
 * OpenAI-compatible endpoint and reads the request bodies the endpoint received. No GPU, no cloud
 * model, no network.
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
const REMINDER = "Skills already read in this session";
const EXTENSION = fileURLToPath(new URL("./index.ts", import.meta.url));

interface StubTurn {
	content?: string;
	tool_calls?: { name: string; args: Record<string, unknown> }[];
}

function createStubModel(turns: StubTurn[]) {
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
			send({ ...base, choices: [], usage: { prompt_tokens: 400, completion_tokens: 20, total_tokens: 420 } });
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

function writeModels(agentDir: string, baseUrl: string) {
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[PROVIDER]: {
					api: "openai-completions",
					apiKey: "test-key",
					baseUrl,
					models: [{ id: MODEL_ID, name: "Scripted check model", contextWindow: 131072, reasoning: false }],
				},
			},
		}, null, 2),
	);
}

function makeEnv() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skill-reminder-"));
	const agentDir = path.join(root, "agent");
	const skillPath = path.join(agentDir, "skills", "demo-guidelines", "SKILL.md");
	fs.mkdirSync(path.dirname(skillPath), { recursive: true });
	fs.writeFileSync(
		skillPath,
		"---\nname: demo-guidelines\ndescription: \"Test skill.\"\n---\n\n# Demo guidelines\n\nName the file, not the convention.\n",
	);
	writeModels(agentDir, "http://127.0.0.1:1/v1");
	// Manual compaction refuses a session with nothing to cut, so the keep window has to be tiny.
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } }, null, 2),
	);
	return { agentDir, skillPath, sessionDir: path.join(root, "sessions") };
}

async function openSession(env: ReturnType<typeof makeEnv>, sessionManager?: SessionManager) {
	const services = await createAgentSessionServices({
		cwd: env.agentDir,
		agentDir: env.agentDir,
		resourceLoaderOptions: { noExtensions: true, additionalExtensionPaths: [EXTENSION] },
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

let firstSessionFile = "";
const e2e = { skip: process.env.PI_SKILL_REMINDER_E2E !== "1" };

test("a skill read before compaction is still named afterwards", { ...e2e }, async () => {
	const env = makeEnv();
	const model = await createStubModel([
		{ tool_calls: [{ name: "read", args: { path: env.skillPath } }] },
		{ content: "read it" },
		{ content: "compacted summary" },
		{ content: "ack after compaction" },
	]).start();
	writeModels(env.agentDir, model.baseUrl);
	try {
		const session = await openSession(env);
		await session.prompt("read the skill");
		await session.compact();
		await session.prompt("and now?");

		const sent = sentText(model.requests);
		assert.ok(sent.includes(REMINDER), "the reminder never reached the model");
		assert.ok(sent.includes("demo-guidelines"), "the reminder did not name the skill");
		assert.ok(
			session.sessionManager.getBranch().some((e) => e.type === "custom_message" && e.customType === "skill-reminder"),
			"no skill-reminder entry recorded in the session",
		);

		const file = session.sessionManager.getSessionFile() ?? "";
		assert.ok(file && fs.existsSync(file), "session file not found");
		firstSessionFile = file;
		session.dispose();
	} finally {
		model.close();
	}
});

test("no skill read means no reminder", { ...e2e }, async () => {
	const env = makeEnv();
	const model = await createStubModel([
		{ content: "nothing read here" },
		{ content: "compacted summary" },
		{ content: "ack after compaction" },
	]).start();
	writeModels(env.agentDir, model.baseUrl);
	try {
		const session = await openSession(env);
		await session.prompt("say something");
		await session.compact();
		await session.prompt("and now?");
		assert.ok(!sentText(model.requests).includes(REMINDER), "a reminder was sent without any skill read");
		session.dispose();
	} finally {
		model.close();
	}
});

test("a resumed session rebuilds the set from its transcript", { ...e2e }, async () => {
	assert.ok(firstSessionFile, "the first scenario produced no session file");
	const env = makeEnv();
	const model = await createStubModel([
		{ content: "compacted summary" },
		{ content: "ack after compaction" },
	]).start();
	writeModels(env.agentDir, model.baseUrl);
	try {
		// A fresh extension instance: nothing is tracked until the transcript is scanned.
		const session = await openSession(env, SessionManager.open(firstSessionFile));
		await session.compact();
		await session.prompt("and now?");
		const sent = sentText(model.requests);
		assert.ok(sent.includes(REMINDER), "the reminder is missing after a resume");
		assert.ok(sent.includes("demo-guidelines"), "the resumed reminder did not name the skill");
		session.dispose();
	} finally {
		model.close();
	}
});
