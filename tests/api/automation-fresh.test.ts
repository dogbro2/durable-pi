import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeOpenAI } from "../helpers/fakeOpenAI";
import { stopServer } from "./teardown";

/**
 * NERE-84 驗收（端到端，假模型）：
 * `fresh_session=1` 的定時任務每次執行都新建會話，歷史不再跨輪累積；
 * `fresh_session=0` 保持舊行為（固定會話）。alarm 的三態由
 * `tests/unit/automation-last-status.test.ts` 覆蓋，這裡走真實的 `/automations/run` +
 * session 建立路徑，確認組合根與遷移接得上。
 */
const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.AUTOMATION_FRESH_TEST_PORT ?? 18803);
const FAKE_PORT = Number(process.env.AUTOMATION_FRESH_FAKE_PORT ?? 18899);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-automation-fresh");

let proc: ChildProcess | null = null;
const fake = startFakeOpenAI(FAKE_PORT);

async function api(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		// 非 JSON 響應
	}
	return { status: res.status, json, text };
}

const post = (path: string, body: unknown) =>
	api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const patch = (path: string, body: unknown) =>
	api(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

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

async function automationRow(id: string): Promise<Record<string, unknown>> {
	const { json } = await api("/api/automations");
	const rows = (json?.automations ?? []) as Record<string, unknown>[];
	const row = rows.find((item) => item.id === id);
	expect(row, `automation ${id} 應出現在列表裡`).toBeTruthy();
	return row!;
}

async function assistantCount(sessionId: string): Promise<number> {
	const { json } = await api(`/api/entries?sessionId=${sessionId}`);
	if (!Array.isArray(json)) return 0;
	return (json as { kind?: string }[]).filter((entry) => entry.kind === "pi.assistant").length;
}

async function runNow(id: string): Promise<string> {
	const res = await post("/api/automations/run", { id });
	expect(res.status, res.text).toBe(200);
	const sessionId = String(res.json?.sessionId ?? "");
	expect(sessionId).not.toBe("");
	return sessionId;
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

describe("定時任務會話隔離（NERE-84）", () => {
	it("連續兩次執行各建一個會話，last_session_id 指向第二次，歷史不跨輪累積", async () => {
		fake.setSteps([{ text: "第一份日報" }, { text: "第二份日報" }]);
		const created = await post("/api/automations", {
			name: "科技日報",
			prompt: "整理今天的科技新聞",
			schedule: { kind: "interval", minutes: 60 },
		});
		expect(created.status).toBe(200);
		const id = String(created.json?.id ?? "");
		expect(await automationRow(id)).toMatchObject({ fresh_session: 1, last_session_id: null });

		const first = await runNow(id);
		expect(await automationRow(id)).toMatchObject({
			session_id: first,
			last_session_id: first,
			last_status: "ok",
			last_error: null,
		});

		const second = await runNow(id);
		expect(second).not.toBe(first);
		expect(await automationRow(id)).toMatchObject({ session_id: second, last_session_id: second, last_status: "ok" });

		// 每輪一個獨立會話：第二次的會話裡只有本輪的一條 assistant entry。
		expect(await assistantCount(first)).toBe(1);
		expect(await assistantCount(second)).toBe(1);
	});

	it("fresh_session=0 保持舊行為：每輪都寫同一個會話", async () => {
		fake.setSteps([{ text: "固定會話第一輪" }, { text: "固定會話第二輪" }]);
		const session = await post("/api/sessions", {});
		const sessionId = String(session.json?.id ?? "");
		expect(sessionId).not.toBe("");

		const created = await post("/api/automations", {
			name: "固定會話任務",
			prompt: "說一句話",
			sessionId,
			schedule: { kind: "interval", minutes: 60 },
		});
		const id = String(created.json?.id ?? "");
		const off = await patch("/api/automations", { id, fresh_session: false });
		expect(off.status, off.text).toBe(200);
		expect(off.json?.automation).toMatchObject({ fresh_session: false, last_session_id: null });

		expect(await runNow(id)).toBe(sessionId);
		expect(await runNow(id)).toBe(sessionId);
		expect(await automationRow(id)).toMatchObject({
			session_id: sessionId,
			last_session_id: sessionId,
			fresh_session: 0,
			last_status: "ok",
		});
		expect(await assistantCount(sessionId)).toBe(2);
	});
});

/**
 * NERE-85 驗收（端到端，假 provider）：
 * 上游一次斷流不再報廢整輪；3 次嘗試都失敗時錯誤摘要進 `last_error`，
 * 且重試只發生在 fetch 包裝層（不會疊加 pi-durable 的整輪重試）。
 */
describe("provider 斷流重試（NERE-85）", () => {
	async function createAutomation(name: string): Promise<string> {
		const created = await post("/api/automations", {
			name,
			prompt: "跑一輪日報",
			schedule: { kind: "interval", minutes: 60 },
		});
		expect(created.status).toBe(200);
		return String(created.json?.id ?? "");
	}

	it("第一次連線失敗、第二次成功：一輪完成，任務狀態 ok 且只有一條回答", async () => {
		const id = await createAutomation("斷流重試任務");
		fake.setSteps([{ text: "重試之後的日報" }]);
		const before = fake.droppedCount();
		fake.dropNext(1);

		const sessionId = await runNow(id);
		expect(fake.droppedCount() - before).toBe(1);
		expect(await assistantCount(sessionId)).toBe(1);
		expect(await automationRow(id)).toMatchObject({ last_status: "ok", last_error: null, last_session_id: sessionId });
	});

	it("一直連不上：3 次嘗試後失敗，原因寫進 last_error", async () => {
		const id = await createAutomation("持續斷流任務");
		const before = fake.droppedCount();
		fake.dropNext(3);

		const startedAt = Date.now();
		const res = await post("/api/automations/run", { id });
		const elapsed = Date.now() - startedAt;

		expect(res.status, res.text).toBe(500);
		expect(res.text).toContain("model_error");
		// 恰好 3 次連線：再多的重試會浪費按量計費的配額。
		expect(fake.droppedCount() - before).toBe(3);
		// 500ms + 2s 的退避確實發生了。
		expect(elapsed).toBeGreaterThanOrEqual(2400);
		const row = await automationRow(id);
		expect(row).toMatchObject({ last_status: "failed" });
		expect(String(row.last_error)).toContain("Connection error");
		expect(String(row.last_error)).toContain("model_error");
	});
});
