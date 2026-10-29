import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopServer } from "./teardown";

/**
 * 階段 3 / NERE-22 驗收：清空 persist 後，`/s/*` 不觸發 Harness `open()`。
 * 觀測點是 DO 的 `/debug/harness`（只在 TEST_HARNESS_STATS=1 時存在，自身不 open）。
 */

const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.SHARE_COLD_TEST_PORT ?? 18801);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-share-cold");

let proc: ChildProcess | null = null;

async function api(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		// 非 JSON 響應（分享頁 HTML / 404 純文本）
	}
	return { status: res.status, json, text };
}

const post = (path: string, body: unknown) =>
	api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function harnessOpens(): Promise<number> {
	const res = await api("/api/debug/harness");
	expect(res.status).toBe(200);
	return (res.json as { opens: number }).opens;
}

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
			"--var",
			"DEMO_SHARE_URL:/s/demo-demo-demo",
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

describe("清空 persist 後的首個分享頁請求", () => {
	it("未知 token 直接 404，且不啟動 Harness（NERE-22）", async () => {
		// 本檔案第一個 DO 請求就是 /s/：之前只有 worker 層 /api/auth 探針（不進 DO）。
		const page = await api("/s/doesnotexist");
		expect(page.status).toBe(404);
		expect(page.text).toBe("分享連結不存在或已失效");
		expect(await harnessOpens()).toBe(0);
	});

	it("檔案分享在冷啟動下可讀，讀頁不增加 Harness 計數", async () => {
		const content = "# 冷啟動分享\n\n正文";
		await post("/api/restore", {
			version: 1,
			data: { files: [{ conversation_id: "1", name: "cold.md", content, updated_at: new Date().toISOString() }] },
		});
		const created = await post("/api/share", { sessionId: "1", kind: "file", name: "cold.md", ttlSeconds: 0 });
		expect(created.status).toBe(200);

		const before = await harnessOpens();
		// 觀測點自證：上面的 /api/restore 與 /api/share 都走 legacy/dispatch 的 open()。
		expect(before).toBeGreaterThan(0);
		const page = await api(`/s/${(created.json as { token: string }).token}`);
		expect(page.status).toBe(200);
		expect(page.text).toContain('<h1 id="冷啟動分享">冷啟動分享</h1>');
		expect(page.text).toContain("正文");
		expect(await harnessOpens()).toBe(before);
	});

	it("會話分享仍正常渲染（只有它的渲染路徑讀 Harness 條目）", async () => {
		const createdSession = await post("/api/sessions", {});
		const sessionId = (createdSession.json as { id: string }).id;
		const created = await post("/api/share", { sessionId, kind: "conversation", ttlSeconds: 0 });
		expect(created.status).toBe(200);

		const page = await api(`/s/${(created.json as { token: string }).token}`);
		expect(page.status).toBe(200);
		expect(page.text).toContain('class="thread"');
		expect(page.text).toContain("（暫無內容）");
		await api(`/api/sessions?id=${sessionId}`, { method: "DELETE" });
	});
});
