import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopServer } from "./teardown";

/**
 * NERE-78 P1-1 驗收：只讀寫 SQL 的端點不應觸發 Harness `open()`。
 * 觀測點仍是 DO 的 `/debug/harness`（TEST_HARNESS_STATS=1，自身不 open）。
 * 冷啟動時首個 DO 請求就是純 SQL 端點，open 計數必須保持 0。
 */

const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.SQL_COLD_TEST_PORT ?? 18802);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-sql-cold");

let proc: ChildProcess | null = null;

async function api<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; json: T | null; text: string }> {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let json: T | null = null;
	try {
		json = JSON.parse(text) as T;
	} catch {
		// 非 JSON 響應
	}
	return { status: res.status, json, text };
}

const post = <T = unknown>(path: string, body: unknown) =>
	api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function harnessOpens(): Promise<number> {
	const res = await api<{ opens?: unknown }>("/api/debug/harness");
	expect(res.status).toBe(200);
	const opens = res.json?.opens;
	if (typeof opens !== "number") throw new Error("GET /api/debug/harness 未返回 opens 計數");
	return opens;
}

/** wrangler dev 就緒沒有事件鉤子，只能有界輪詢；整合測試共用這份探針。 */
async function waitForServer(timeoutMs = 90_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const res = await fetch(`${BASE}/api/auth`, { signal: AbortSignal.timeout(1500) });
			if (res.ok) return;
		} catch {
			// 還沒起來
		}
		await new Promise((r) => setTimeout(r, 800));
	}
	throw new Error("wrangler dev 未在超時內就緒");
}

beforeAll(async () => {
	rmSync(STATE, { recursive: true, force: true });
	proc = spawn(
		"npx",
		[
			"wrangler",
			"dev",
			"--config",
			"wrangler.test.jsonc",
			"--port",
			String(PORT),
			"--var",
			"ACCESS_PASSWORD:",
			"--var",
			"PI_ALLOW_OPEN:1",
			"--var",
			"CF_DISABLE_VECTOR:1",
			"--var",
			"TEST_HARNESS_STATS:1",
			"--persist-to",
			STATE,
		],
		{ cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "ignore", detached: true },
	);
	await waitForServer();
}, 180_000);

afterAll(async () => {
	await stopServer(proc, STATE);
});

describe("純 SQL 端點不啟動 Harness（NERE-78）", () => {
	it("空 persist 上 GET /api/automations、/api/files、/api/kb 均為 200，opens 保持 0", async () => {
		// 本檔案第一個 DO 請求就是純 SQL 列表端點；之前只有 worker 層的 /api/auth 探針。
		for (const path of ["/api/automations", "/api/files", "/api/kb"]) {
			const res = await api(path);
			expect(res.status, path).toBe(200);
		}
		expect(await harnessOpens()).toBe(0);
	});

	it("其餘只讀寫 SQL 的讀端點同樣不增加 opens", async () => {
		const before = await harnessOpens();
		const paths = [
			"/api/plan",
			"/api/goal",
			"/api/files/all",
			"/api/memories",
			"/api/capabilities",
			"/api/mcp",
			"/api/kb/status",
			"/api/kb/search?q=%E4%B9%85%E6%9C%9F",
			"/api/kb/prefetch?q=%E4%B9%85%E6%9C%9F",
		];
		for (const path of paths) {
			const res = await api(path);
			expect(res.status, path).toBe(200);
		}
		// 帶查詢引數 / 缺引數的 404 也不應拉起 Harness。
		expect((await api("/api/files/content?name=missing.md")).status).toBe(404);
		expect((await api("/api/kb/doc?id=999")).status).toBe(404);
		expect(await harnessOpens()).toBe(before);
	});

	it("寫端點（自動化 / 目標 / 知識庫 / 記憶）不啟動 Harness", async () => {
		const before = await harnessOpens();

		const created = await post<{ id?: string }>("/api/automations", { name: "冷啟動任務", prompt: "只寫 SQL" });
		expect(created.status).toBe(200);
		expect((await api(`/api/automations?id=${created.json?.id ?? ""}`, { method: "DELETE" })).status).toBe(200);

		expect((await api("/api/goal?sessionId=1", { method: "DELETE" })).status).toBe(200);

		const doc = await post<{ ok?: boolean; id?: number; vectorized?: number; pending?: number }>("/api/kb", {
			title: "冷啟動文件",
			content: "冷啟動入庫正文",
		});
		expect(doc.status).toBe(200);
		expect(doc.json).toMatchObject({ ok: true, vectorized: 0, pending: 0 });
		expect((await api(`/api/kb?id=${doc.json?.id ?? 0}`, { method: "DELETE" })).status).toBe(200);

		expect((await api("/api/memories?all=1", { method: "DELETE" })).status).toBe(200);

		expect(await harnessOpens()).toBe(before);
	});

	it("觀測點自證：需要 Harness 的路由會抬高 opens", async () => {
		const before = await harnessOpens();
		const res = await api("/api/bootstrap?sessionId=1");
		expect(res.status).toBe(200);
		expect(await harnessOpens()).toBeGreaterThan(before);
	});
});
