import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeOpenAI } from "../helpers/fakeOpenAI";
import { stopServer } from "./teardown";

/**
 * NERE-40 驗收（端到端，假模型）：
 * 命中知識庫的一輪把 `${docId, chunkId, chunkSeq, title, source?}` 掛到 assistant entry，
 * 隨 GET /api/entries 返回，並在 SSE done 事件裡透傳；未命中的一輪不寫該欄位。
 */
const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.KB_REFS_TEST_PORT ?? 18797);
const FAKE_PORT = Number(process.env.KB_REFS_FAKE_PORT ?? 18896);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-kb-refs");

let proc: ChildProcess | null = null;
const fake = startFakeOpenAI(FAKE_PORT);

async function api(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		// 非 JSON 響應
	}
	return { status: res.status, json, text };
}

const post = (path: string, body: unknown) =>
	api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function waitForServer(timeoutMs = 90_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const res = await fetch(`${BASE}/api/auth`, { signal: AbortSignal.timeout(1500) });
			if (res.ok) return;
		} catch {
			// 還沒起來
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 800);
		await promise;
	}
	throw new Error("wrangler dev 未在超時內就緒");
}

function parseSse(text: string): { event: string; data: Record<string, unknown> }[] {
	const events: { event: string; data: Record<string, unknown> }[] = [];
	for (const frame of text.split("\n\n")) {
		const event = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
		const data = frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
		if (!event || !data) continue;
		try {
			events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
		} catch {
			// 忽略損壞幀
		}
	}
	return events;
}

/** 寬容讀取 JSON 物件欄位：介面返回可能是錯誤體或非 JSON。 */
function obj(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

async function newSession(): Promise<string> {
	const created = await post("/api/sessions", {});
	const id = String(obj(created.json)?.id ?? "");
	expect(id).toBeTruthy();
	expect((await post("/api/model", { sessionId: id, modelId: "fake" })).status).toBe(200);
	return id;
}

async function chat(sessionId: string, message: string) {
	const res = await fetch(`${BASE}/api/chat/stream`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message, sessionId }),
	});
	expect(res.status).toBe(200);
	return parseSse(await res.text());
}

function doneOf(events: { event: string; data: Record<string, unknown> }[]): Record<string, unknown> {
	const done = events.find((item) => item.event === "done");
	expect(done, "SSE 應包含 done 事件").toBeTruthy();
	return done!.data;
}

type Ref = { docId: number; chunkId: number; chunkSeq: number; title: string; source?: string };
type Entry = { id: number; kind: string; kbRefs?: Ref[] };

async function assistantEntries(sessionId: string): Promise<Entry[]> {
	const entries = await api(`/api/entries?sessionId=${sessionId}`);
	expect(entries.status).toBe(200);
	if (!Array.isArray(entries.json)) return [];
	return (entries.json as Entry[]).filter((entry) => entry.kind === "pi.assistant");
}

beforeAll(async () => {
	rmSync(STATE, { recursive: true, force: true });
	await fake.listen();
	proc = spawn(
		"npx",
		["wrangler", "dev", "--config", "wrangler.test.jsonc", "--port", String(PORT), "--var", "ACCESS_PASSWORD:",
			"--var", "PI_ALLOW_OPEN:1", "--var", "CF_DISABLE_VECTOR:1", "--persist-to", STATE],
		{ cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "ignore", detached: true },
	);
	await waitForServer();

	expect(
		(
			await post("/api/providers", {
				id: "fake",
				name: "Fake OpenAI",
				baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1`,
				apiKey: "sk-fake",
				models: "fake",
			})
		).status,
	).toBe(200);
	expect((await post("/api/providers/activate", { id: "fake" })).status).toBe(200);
}, 180_000);

afterAll(async () => {
	await stopServer(proc, STATE);
	await fake.close();
});

describe("assistant entry.kbRefs（端到端）", () => {
	it("命中「久期」：entry 與 done 都帶結構化引用，docId 能取回同標題文件", async () => {
		const added = await post("/api/kb", {
			title: "債券研究筆記",
			content: "久期是衡量利率風險的核心指標。組合久期 3.2 年，久期越長，價格對利率越敏感。",
			source: "固定收益講義.md",
		});
		expect(added.status).toBe(200);
		const docId = Number(obj(added.json)?.id);
		expect(docId).toBeGreaterThan(0);

		fake.setSteps([{ text: "久期衡量債券價格對利率變化的敏感度。" }]);
		const sid = await newSession();
		const events = await chat(sid, "久期是什麼");

		const done = doneOf(events);
		const doneRefs = done.kbRefs as Ref[] | undefined;
		expect(Array.isArray(doneRefs)).toBe(true);
		expect(doneRefs![0]).toMatchObject({ docId, title: "債券研究筆記", source: "固定收益講義.md" });
		expect(Number.isFinite(doneRefs![0]!.chunkId)).toBe(true);
		expect(Number.isFinite(doneRefs![0]!.chunkSeq)).toBe(true);

		const assistants = await assistantEntries(sid);
		expect(assistants).toHaveLength(1);
		expect(assistants[0]!.kbRefs).toEqual(doneRefs);

		const doc = await api(`/api/kb/doc?id=${assistants[0]!.kbRefs![0]!.docId}`);
		expect(doc.status).toBe(200);
		expect(obj(doc.json)?.title).toBe(assistants[0]!.kbRefs![0]!.title);
	});

	it("未命中「今天天氣」：entry 與 done 都不出現 kbRefs", async () => {
		fake.setSteps([{ text: "我查不到今天的天氣。" }]);
		const sid = await newSession();
		const events = await chat(sid, "今天天氣");

		expect(doneOf(events)).not.toHaveProperty("kbRefs");
		const assistants = await assistantEntries(sid);
		expect(assistants).toHaveLength(1);
		expect(assistants[0]).not.toHaveProperty("kbRefs");
	});
});

describe("長會話迴歸：>100 assistant entries（繫結引數上限）", () => {
	it("101 輪對話後 /api/entries 仍 200，頁內每條 assistant entry 都帶 kbRefs", async () => {
		await post("/api/kb", {
			title: "利率風險筆記",
			content: "久期衡量債券價格對利率變化的敏感度，久期越長波動越大。",
		});
		const sid = await newSession();
		for (let i = 0; i < 101; i++) await chat(sid, `第 ${i} 輪：久期是什麼`);

		// 一頁 200 條 = 100 組 user/assistant；舊實現用 IN(?,…) 時這裡是 101 個繫結引數 → DO 報錯 500。
		const entries = await api(`/api/entries?sessionId=${sid}`);
		expect(entries.status).toBe(200);
		const assistants = (entries.json as Entry[]).filter((entry) => entry.kind === "pi.assistant");
		expect(assistants).toHaveLength(100);
		for (const assistant of assistants) {
			expect(Array.isArray(assistant.kbRefs), `entry ${assistant.id} 缺 kbRefs`).toBe(true);
			expect(assistant.kbRefs!.length).toBeGreaterThan(0);
		}
	});
});
