import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopServer } from "./teardown";

const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.TEST_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state");

let proc: ChildProcess | null = null;

async function api(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		// 非 JSON 響應（如匯出 Markdown）
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
		await new Promise((r) => setTimeout(r, 800));
	}
	throw new Error("wrangler dev 未在超時內就緒");
}

beforeAll(async () => {
	rmSync(STATE, { recursive: true, force: true });
	proc = spawn(
		"npx",
		["wrangler", "dev", "--config", "wrangler.test.jsonc", "--port", String(PORT), "--var", "ACCESS_PASSWORD:",
			"--var", "PI_ALLOW_OPEN:1", "--var", "CF_DISABLE_VECTOR:1", "--var", "DEMO_SHARE_URL:/s/demo-demo-demo",
			"--var", "REPO_URL:https://github.com/example/durable-pi", "--persist-to", STATE],
		{ cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "ignore", detached: true },
	);
	await waitForServer();
}, 180_000);

afterAll(async () => {
	await stopServer(proc, STATE);
});

describe("空庫首啟", () => {
	it("第一個 DO 請求 GET /api/sessions 直接 200", async () => {
		const { status, json } = await api("/api/sessions");
		expect(status).toBe(200);
		expect(Array.isArray(json.sessions)).toBe(true);
	});
});

describe("訪問控制", () => {
	it("未配置密碼時 auth 返回無需登入", async () => {
		const { json } = await api("/api/auth");
		expect(json).toMatchObject({ required: false, authenticated: true });
		expect(json.owner).toBe(true);
	});

	it("配置了 DEMO_SHARE_URL 時 auth 返回演示入口（NERE-13）", async () => {
		const { json } = await api("/api/auth");
		expect(json.demoUrl).toBe("/s/demo-demo-demo");
	});
});

describe("會話", () => {
	it("新建 → 列表 → 改名 → 刪除", async () => {
		const created = await post("/api/sessions", {});
		const id = created.json.id as string;
		expect(id).toBeTruthy();

		const list1 = await api("/api/sessions");
		expect(list1.json.sessions.some((s: { id: string }) => s.id === id)).toBe(true);

		await api("/api/sessions", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id, title: "改名後" }),
		});
		const list2 = await api("/api/sessions");
		expect(list2.json.sessions.find((s: { id: string }) => s.id === id)?.title).toBe("改名後");

		await api(`/api/sessions?id=${id}`, { method: "DELETE" });
		const list3 = await api("/api/sessions");
		expect(list3.json.sessions.some((s: { id: string }) => s.id === id)).toBe(false);
	});
});

describe("設定", () => {
	it("思考檔位讀寫", async () => {
		const before = await api("/api/settings");
		expect(["off", "low", "high"]).toContain(before.json.thinkingLevel);

		const set = await post("/api/settings", { thinkingLevel: "high" });
		expect(set.json.thinkingLevel).toBe("high");

		const after = await api("/api/settings");
		expect(after.json.thinkingLevel).toBe("high");

		await post("/api/settings", { thinkingLevel: "low" });
	});

	it("非法檔位被忽略", async () => {
		await post("/api/settings", { thinkingLevel: "ultra" });
		const after = await api("/api/settings");
		expect(["off", "low", "high"]).toContain(after.json.thinkingLevel);
	});
});

describe("模型供應商", () => {
	it("新增 → 啟用 → 模型列表跟隨 → 切回預設 → 刪除", async () => {
		const empty = await api("/api/providers");
		expect(empty.json.active).toBe("");
		expect(Array.isArray(empty.json.providers)).toBe(true);

		const created = await post("/api/providers", {
			name: "測試供應商",
			baseUrl: "https://api.example.com/v1",
			apiKey: "sk-golden-0001",
			models: "model-a, model-b",
		});
		expect(created.json.ok).toBe(true);
		const id = created.json.id as string;

		const list = await api("/api/providers");
		const item = list.json.providers.find((p: { id: string }) => p.id === id);
		expect(item).toMatchObject({ name: "測試供應商", models: ["model-a", "model-b"] });
		// 金鑰只回傳掩碼
		expect(item.keyHint).toBe("••••0001");
		expect(JSON.stringify(list.json)).not.toContain("sk-golden-0001");

		await post("/api/providers/activate", { id });
		const models = await api("/api/models");
		expect(models.json.models).toEqual(["model-a", "model-b"]);
		expect(models.json.provider).toBe(id);

		// v1.1.0：沒有內建供應商了。取消顯式選擇後，唯一存在的供應商仍會生效。
		await post("/api/providers/activate", { id: "" });
		const back = await api("/api/models");
		expect(back.json.provider).toBe(id);
		expect(back.json.models).toEqual(["model-a", "model-b"]);

		await api(`/api/providers?id=${id}`, { method: "DELETE" });
		const after = await api("/api/providers");
		expect(after.json.providers.some((p: { id: string }) => p.id === id)).toBe(false);
		// 刪光供應商後模型列表為空，聊天入口會提示先去設定裡配置
		const none = await api("/api/models");
		expect(none.json.models).toEqual([]);
		expect(none.json.provider).toBe("");
	});

	it("缺少 API Key 的新增被拒絕", async () => {
		const res = await post("/api/providers", { name: "無金鑰", baseUrl: "https://x.example.com", models: "m" });
		expect(res.status).toBe(400);
	});

	it("啟用不存在的供應商返回 404", async () => {
		const res = await post("/api/providers/activate", { id: "not-exist" });
		expect(res.status).toBe(404);
	});
});

describe("技能", () => {
	it("新增 → 列表 → 刪除", async () => {
		await post("/api/skills", { name: "golden-skill", description: "迴歸用", content: "# 指令\n1. 做點什麼" });
		const list = await api("/api/skills");
		expect(list.json.skills.some((s: { name: string }) => s.name === "golden-skill")).toBe(true);

		await api("/api/skills?name=golden-skill", { method: "DELETE" });
		const after = await api("/api/skills");
		expect(after.json.skills.some((s: { name: string }) => s.name === "golden-skill")).toBe(false);
	});
});

describe("提示模板", () => {
	it("新增 → 列表 → 刪除", async () => {
		const created = await post("/api/prompts", { name: "golden-prompt", description: "迴歸用", content: "總結 $1" });
		expect(created.json.ok).toBe(true);

		const list = await api("/api/prompts");
		const item = list.json.prompts.find((p: { name: string }) => p.name === "golden-prompt");
		expect(item).toMatchObject({ description: "迴歸用", content: "總結 $1" });

		await api("/api/prompts?name=golden-prompt", { method: "DELETE" });
		const after = await api("/api/prompts");
		expect(after.json.prompts.some((p: { name: string }) => p.name === "golden-prompt")).toBe(false);
	});

	it("缺內容被拒絕", async () => {
		const res = await post("/api/prompts", { name: "bad" });
		expect(res.status).toBe(400);
	});
});

describe("規則檔案", () => {
	it("新增 → 啟用/停用 → 刪除", async () => {
		await post("/api/rules", { name: "golden-rule", content: "始終用中文回答" });
		const list1 = await api("/api/rules");
		const rule = list1.json.rules.find((r: { name: string }) => r.name === "golden-rule");
		expect(rule).toMatchObject({ enabled: true, content: "始終用中文回答" });

		await api("/api/rules", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "golden-rule", enabled: false }),
		});
		const list2 = await api("/api/rules");
		expect(list2.json.rules.find((r: { name: string }) => r.name === "golden-rule")?.enabled).toBe(false);

		await api("/api/rules?name=golden-rule", { method: "DELETE" });
		const list3 = await api("/api/rules");
		expect(list3.json.rules.some((r: { name: string }) => r.name === "golden-rule")).toBe(false);
	});
});

describe("能力登錄檔", () => {
	it("返回內建 / 資料 / 協議三組", async () => {
		const { json } = await api("/api/capabilities");
		const keys = (json.groups ?? []).map((g: { key: string }) => g.key);
		expect(keys).toEqual(["builtin", "data", "protocol"]);

		const builtinIds = json.groups[0].items.map((i: { id: string }) => i.id);
		expect(builtinIds).toEqual(expect.arrayContaining(["codemode", "compaction", "plan", "subagents", "web_search"]));

		const dataIds = json.groups[1].items.map((i: { id: string }) => i.id);
		expect(dataIds).toEqual(["skills", "prompts", "rules"]);
	});

	it("計數隨資料變化", async () => {
		await post("/api/prompts", { name: "count-prompt", content: "x" });
		const { json } = await api("/api/capabilities");
		const promptsItem = json.groups[1].items.find((i: { id: string }) => i.id === "prompts");
		expect(promptsItem.count).toBeGreaterThanOrEqual(1);
		await api("/api/prompts?name=count-prompt", { method: "DELETE" });
	});
});

describe("記憶庫", () => {
	it("恢復寫入 → 一鍵清空", async () => {
		await post("/api/restore", {
			version: 1,
			data: { memories: [{ content: "金標用例寫入的記憶", created_at: new Date().toISOString(), source: "manual" }] },
		});
		const withMemory = await api("/api/memories");
		expect(withMemory.json.memories.length).toBeGreaterThan(0);

		const cleared = await api("/api/memories?all=1", { method: "DELETE" });
		expect(cleared.json.ok).toBe(true);
		expect(cleared.json.deleted).toBeGreaterThan(0);

		const after = await api("/api/memories");
		expect(after.json.memories).toEqual([]);
	});
});

describe("備份與恢復", () => {
	it("備份包含各類資料鍵", async () => {
		const { json } = await api("/api/backup");
		expect(json.version).toBe(1);
		for (const key of ["memories", "files", "automations", "mcpServers", "sessions", "skills", "settings", "plans", "providers", "prompts", "rules", "kbDocs"]) {
			expect(json.data).toHaveProperty(key);
		}
	});

	it("恢復後能讀回供應商", async () => {
		const res = await post("/api/restore", {
			version: 1,
			data: {
				providers: [
					{ id: "golden-provider", name: "恢復的供應商", base_url: "https://api.restore.test/v1", api_key: "sk-restore", models: "r1" },
				],
			},
		});
		expect(res.json.counts.providers).toBe(1);

		const list = await api("/api/providers");
		expect(list.json.providers.some((p: { id: string }) => p.id === "golden-provider")).toBe(true);

		await api("/api/providers?id=golden-provider", { method: "DELETE" });
	});
});

describe("知識庫", () => {
	let docId = 0;
	const CONTENT = "信用債研究筆記\n\n久期是衡量利率風險的核心指標。組合久期 3.2 年，AA+ 城投佔比 40%。\n\nEnglish note: duration and spread duration.";

	it("空庫返回空列表", async () => {
		const res = await api("/api/kb");
		expect(res.status).toBe(200);
		expect(Array.isArray(res.json.docs)).toBe(true);
	});

	it("入庫後自動分塊並建立索引", async () => {
		const res = await post("/api/kb", { title: "債券研究筆記", content: CONTENT, source: "金標用例", tags: "固收" });
		expect(res.status).toBe(200);
		expect(res.json.chunks).toBeGreaterThanOrEqual(1);
		docId = res.json.id;

		const list = await api("/api/kb");
		const doc = list.json.docs.find((d: { id: number }) => d.id === docId);
		expect(doc).toMatchObject({ title: "債券研究筆記", source: "金標用例", tags: "固收" });
		expect(doc.chunks).toBeGreaterThanOrEqual(1);
		expect(doc.size).toBeGreaterThan(0);
	});

	it("中文兩字詞也能檢索", async () => {
		const res = await api(`/api/kb/search?q=${encodeURIComponent("久期")}`);
		expect(res.json.hits.length).toBeGreaterThan(0);
		expect(res.json.hits[0].title).toBe("債券研究筆記");
		expect(res.json.hits[0].text).toContain("久期");
	});

	it("英文檢索不區分大小寫", async () => {
		const res = await api(`/api/kb/search?q=${encodeURIComponent("DURATION")}`);
		expect(res.json.hits.length).toBeGreaterThan(0);
	});

	it("預檢索預設開啟並返回注入塊", async () => {
		const pref = await api(`/api/kb/prefetch?q=${encodeURIComponent("久期")}`);
		expect(pref.json.enabled).toBe(true);
		expect(pref.json.block).toContain("知識庫參考資料");
		expect(pref.json.block).toContain("債券研究筆記");
		expect(pref.json.block.length).toBeLessThan(2500);
	});

	it("預檢索內容進入本輪 instructions", async () => {
		const res = await api(`/api/debug/agent?sessionId=1&message=${encodeURIComponent("組合久期怎麼看")}`);
		expect(res.json.instructions).toContain("知識庫參考資料");
		expect(res.json.instructions).toContain("債券研究筆記");
	});

	it("關閉預檢索後不再注入，模型仍可主動檢索", async () => {
		const before = await api("/api/settings");
		expect(before.json.kbPrefetch).toBe(true);

		const off = await post("/api/settings", { kbPrefetch: false });
		expect(off.json.kbPrefetch).toBe(false);
		const pref = await api(`/api/kb/prefetch?q=${encodeURIComponent("久期")}`);
		expect(pref.json.block).toBe("");
		const dbg = await api(`/api/debug/agent?sessionId=1&message=${encodeURIComponent("久期")}`);
		expect(dbg.json.instructions).not.toContain("知識庫參考資料");

		// 主動檢索工具不受開關影響
		const search = await api(`/api/kb/search?q=${encodeURIComponent("久期")}`);
		expect(search.json.hits.length).toBeGreaterThan(0);

		await post("/api/settings", { kbPrefetch: true });
	});

	it("未命中返回空", async () => {
		const res = await api(`/api/kb/search?q=${encodeURIComponent("量子糾纏")}`);
		expect(res.json.hits).toEqual([]);
	});

	it("讀取全文", async () => {
		const res = await api(`/api/kb/doc?id=${docId}`);
		expect(res.json.title).toBe("債券研究筆記");
		expect(res.json.content).toContain("久期");
	});

	it("標題與正文必填", async () => {
		const res = await post("/api/kb", { title: "只有標題" });
		expect(res.status).toBe(400);
	});

	it("未配置向量時狀態可用但未啟用", async () => {
		const status = await api("/api/kb/status");
		expect(status.json.mode).toBe("fts");
		expect(status.json.available).toBe(false);
		expect(status.json.total).toBeGreaterThan(0);
		expect(status.json.index).toBe("pi-kb");
	});

	it("向量模式未配置時回退關鍵詞，重建索引返回 400", async () => {
		const set = await post("/api/settings", { kbRetrieval: "vector" });
		expect(set.json.kbRetrieval).toBe("vector");
		expect(set.json.kbVector.available).toBe(false);

		const search = await api(`/api/kb/search?q=${encodeURIComponent("久期")}`);
		expect(search.json.hits.length).toBeGreaterThan(0);

		const reindex = await api("/api/kb/reindex", { method: "POST" });
		expect(reindex.status).toBe(400);

		await post("/api/settings", { kbRetrieval: "fts" });
	});

	it("刪除後不再可檢索", async () => {
		const res = await api(`/api/kb?id=${docId}`, { method: "DELETE" });
		expect(res.json.ok).toBe(true);
		const search = await api(`/api/kb/search?q=${encodeURIComponent("久期")}`);
		expect(search.json.hits.length).toBe(0);
	});

	it("無 AI 繫結時 PDF 返回 501，文本匯入與貼上不受影響", async () => {
		const pdf = new FormData();
		pdf.append("file", new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" }));
		const res = await api("/api/kb/ingest", { method: "POST", body: pdf });
		expect(res.status).toBe(501);
		expect(res.json).toMatchObject({ ok: false, code: "ai_unavailable" });
		expect(res.json.message).toContain("不支援 PDF");

		const text = new FormData();
		text.append("file", new File(["# 無 AI 也能匯入\n\n正文"], "no-ai.md", { type: "text/markdown" }));
		const textRes = await api("/api/kb/ingest", { method: "POST", body: text });
		expect(textRes.status).toBe(200);
		expect(textRes.json.ok).toBe(true);
		await api(`/api/kb?id=${textRes.json.docId}`, { method: "DELETE" });

		const paste = await post("/api/kb", { title: "貼上仍然可用", content: "貼上正文不受 AI 繫結缺失影響" });
		expect(paste.status).toBe(200);
		await api(`/api/kb?id=${paste.json.id}`, { method: "DELETE" });
	});
});

describe("全部檔案", () => {
	let childSession = "";
	let childTitle = "";

	beforeAll(async () => {
		const created = await post("/api/sessions", {});
		childSession = created.json.id as string;
		childTitle = (created.json.title as string) ?? "";
		await post("/api/restore", {
			version: 1,
			data: {
				files: [
					{ conversation_id: "1", name: "all-files-root.md", content: "# root", updated_at: new Date().toISOString() },
					{ conversation_id: childSession, name: "all-files-child.md", content: "# child", updated_at: new Date().toISOString() },
				],
			},
		});
	});

	it("跨會話彙總並帶會話資訊", async () => {
		const res = await api("/api/files/all");
		expect(res.status).toBe(200);
		const child = res.json.files.find((f: { name: string; sessionId: string }) => f.name === "all-files-child.md");
		expect(child.sessionId).toBe(childSession);
		expect(child.sessionTitle).toBe(childTitle);
		const root = res.json.files.find((f: { name: string }) => f.name === "all-files-root.md");
		expect(root.sessionId).toBe("1");
	});

	it("按檔名篩選", async () => {
		const res = await api(`/api/files/all?q=${encodeURIComponent("child")}`);
		expect(res.json.files.map((f: { name: string }) => f.name)).toEqual(["all-files-child.md"]);
	});

	it("同名檔案按會話區分", async () => {
		await post("/api/restore", {
			version: 1,
			data: { files: [{ conversation_id: childSession, name: "all-files-root.md", content: "# child copy", updated_at: new Date().toISOString() }] },
		});
		const res = await api(`/api/files/all?q=${encodeURIComponent("all-files-root")}`);
		const sessions = (res.json.files as { sessionId: string }[]).map((f) => f.sessionId).sort();
		expect(sessions).toEqual(["1", childSession].sort());
	});
});

describe("檔案分享", () => {
	const MD = "# 分享測試\n\n**重點** 與 `code`\n\n- 第一條\n- 第二條\n\n| 列 | 值 |\n| --- | --- |\n| a | 1 |";
	const TOC = "# 總覽\n\n## 第一節\n\n內容\n\n## 第二節\n\n### 小節\n\n內容\n\n## 重複\n\n## 重複";
	const HTML = '<!doctype html><html><body><h1 id="shared">HTML 分享</h1><script>document.title="ok"</script></body></html>';

	beforeAll(async () => {
		await post("/api/restore", {
			version: 1,
			data: {
				files: [
					{ conversation_id: "1", name: "share-test.md", content: MD, updated_at: new Date().toISOString() },
					{ conversation_id: "1", name: "share-toc.md", content: TOC, updated_at: new Date().toISOString() },
					{ conversation_id: "1", name: "share-test.html", content: HTML, updated_at: new Date().toISOString() },
				],
			},
		});
	});

	it("Markdown 生成帶域名的連結並渲染", async () => {
		const created = await post("/api/share", { sessionId: "1", kind: "file", name: "share-test.md", ttlSeconds: 3600 });
		expect(created.status).toBe(200);
		expect(created.json.ok).toBe(true);
		const url = new URL(created.json.url as string);
		expect(url.protocol).toBe("http:");
		expect(url.host).toBeTruthy();
		expect(url.pathname).toMatch(/^\/s\/[a-z0-9]+$/);
		expect(created.json.expiresAt).toBeGreaterThan(Date.now());

		const page = await fetch(created.json.url);
		const html = await page.text();
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toContain("text/html");
		expect(html).toContain('id="分享測試"');
		expect(html).toContain("分享測試</h1>");
		expect(html).toContain("<strong>重點</strong>");
		expect(html).toContain("<li>第一條</li>");
		expect(html).toContain("<table>");
		expect(html).toContain("連結有效期至");
		// 永久連結也應該顯示生成時間（NERE-13 驗收 4）
		expect(html).toContain("生成於");
		// 未指定主題時回落深色（Arco 深色底）
		expect(html).toContain("--bg:#17171a");
	});

	it("預設有效期與分享頁署名/生成時間跟隨設定（v0.55.0）", async () => {
		const set = await post("/api/settings", { displayName: "董長陽", shareTtlSeconds: 3600 });
		expect(set.json).toMatchObject({ displayName: "董長陽", shareTtlSeconds: 3600 });

		const before = Date.now();
		const created = await post("/api/share", { sessionId: "1", kind: "file", name: "share-test.md" });
		expect(created.status).toBe(200);
		// 不傳 ttlSeconds → 用設定裡的 1 小時，而不是永久
		expect(created.json.expiresAt).toBeGreaterThan(before);
		expect(created.json.expiresAt).toBeLessThanOrEqual(Date.now() + 3600_000);

		const html = await (await fetch(created.json.url)).text();
		expect(html).toContain("由 董長陽 分享");
		expect(html).toContain("生成於");
		expect(html).toContain("連結有效期至");

		// 顯式 ttlSeconds 覆蓋設定預設
		const explicit = await post("/api/share", { sessionId: "1", kind: "file", name: "share-test.md", ttlSeconds: 60 });
		expect(explicit.json.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);

		await post("/api/settings", { displayName: "", shareTtlSeconds: 604800 });
	});

	it("分享頁記錄主題，?theme= 可覆蓋", async () => {
		const created = await post("/api/share", {
			sessionId: "1",
			kind: "file",
			name: "share-test.md",
			ttlSeconds: 3600,
			theme: "light",
		});
		const light = await (await fetch(created.json.url)).text();
		expect(light).toContain("--bg:#f7f8fa");
		expect(light).toContain("color-scheme:light");

		const sepia = await (await fetch(`${created.json.url}?theme=sepia`)).text();
		expect(sepia).toContain("--bg:#fcf8ec");

		// 未知主題引數不生效，仍用分享時記錄的淺色
		const fallback = await (await fetch(`${created.json.url}?theme=dracula`)).text();
		expect(fallback).toContain("--bg:#f7f8fa");
	});

	it("HTML 原樣輸出並帶 sandbox CSP", async () => {
		const created = await post("/api/share", { sessionId: "1", kind: "file", name: "share-test.html", ttlSeconds: 0 });
		expect(created.json.expiresAt).toBe(0);

		const page = await fetch(created.json.url);
		const body = await page.text();
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toContain("text/html");
		expect(page.headers.get("content-security-policy")).toContain("sandbox");
		expect(body).toContain('<h1 id="shared">HTML 分享</h1>');
	});

	it("過期後返回 410", async () => {
		const created = await post("/api/share", { sessionId: "1", kind: "file", name: "share-test.md", ttlSeconds: 0.05 });
		expect(created.json.expiresAt).toBeGreaterThan(0);
		await new Promise((resolve) => setTimeout(resolve, 120));

		const page = await fetch(created.json.url);
		expect(page.status).toBe(410);
		expect(await page.text()).toContain("分享連結已過期");
	});

	it("多標題 Markdown 生成目錄與錨點", async () => {
		const created = await post("/api/share", {
			sessionId: "1",
			kind: "file",
			name: "share-toc.md",
			ttlSeconds: 3600,
			theme: "light",
		});
		const html = await (await fetch(created.json.url)).text();
		expect(html).toContain('class="toc"');
		expect(html).toContain('href="#總覽"');
		expect(html).toContain('id="總覽"');
		expect(html).toContain('href="#第二節"');
		expect(html).toContain('class="l3"');
		expect(html).toContain('href="#小節"');
		// 重複標題自動加序號
		expect(html).toContain('id="重複"');
		expect(html).toContain('id="重複-2"');

		// 只有一個標題時不顯示目錄
		const single = await post("/api/share", { sessionId: "1", kind: "file", name: "share-test.md", ttlSeconds: 3600 });
		expect(await (await fetch(single.json.url)).text()).not.toContain('class="toc"');
	});

	it("分享頁帶列印按鈕與列印樣式（NERE-39）", async () => {
		const created = await post("/api/share", {
			sessionId: "1",
			kind: "file",
			name: "share-toc.md",
			ttlSeconds: 3600,
			theme: "dark",
		});
		const html = await (await fetch(created.json.url)).text();

		// 頁頭按鈕走瀏覽器原生列印
		expect(html).toContain('class="print-btn"');
		expect(html).toContain('onclick="window.print()"');
		expect(html).toContain("列印 / 存為 PDF");

		// 列印預覽隱藏按鈕，目錄與頁尾保留
		expect(html).toContain("@media print");
		expect(html).toContain(".print-btn{display:none}");
		expect(html).toContain('class="toc"');
		expect(html).toContain("<footer>");

		// 表格不攔腰切斷，長表格跨頁時重複表頭
		expect(html).toContain("table{display:table");
		expect(html).toContain("break-inside:avoid");
		expect(html).toContain("thead{display:table-header-group}");

		// 螢幕樣式仍在 @media 之外，未被列印規則改寫
		expect(html).toContain("--bg:#17171a");
		expect(html).toContain("header{position:sticky");
	});

	it("分享頁頁尾有部署出口，列印預覽裡不出現（NERE-46）", async () => {
		const created = await post("/api/share", {
			sessionId: "1",
			kind: "file",
			name: "share-toc.md",
			ttlSeconds: 3600,
			theme: "dark",
		});
		const html = await (await fetch(created.json.url)).text();

		// 頁尾出口完全由 REPO_URL 決定（測試裡設成 example/durable-pi），帶來源引數
		expect(html).toContain('class="share-cta"');
		expect(html).toContain('href="https://github.com/example/durable-pi?utm_source=share"');
		expect(html).toContain("用同樣的方式做一個");

		// 列印 / 存為 PDF 時不出現（不汙染 NERE-39 的輸出）
		expect(html).toContain(".share-cta,.demo-note{display:none}");

		// 普通分享不冒充演示頁：沒有隻讀樣例橫條
		expect(html).not.toContain('class="demo-note"');
	});

	it("已生成的連結可複用", async () => {
		const created = await post("/api/share", {
			sessionId: "1",
			kind: "file",
			name: "share-test.md",
			ttlSeconds: 3600,
			theme: "light",
		});
		const list = await api("/api/shares?sessionId=1&kind=file&name=share-test.md");
		expect(list.status).toBe(200);
		const item = (list.json.shares as { token: string; url: string; expiresAt: number; theme: string }[]).find(
			(entry) => entry.token === created.json.token,
		);
		expect(item).toBeTruthy();
		expect(item?.url).toContain(`/s/${created.json.token}`);
		expect(item?.expiresAt).toBeGreaterThan(Date.now());
		expect(item?.theme).toBe("light");
	});

	it("過期連結不再出現在複用列表", async () => {
		const created = await post("/api/share", { sessionId: "1", kind: "file", name: "share-test.md", ttlSeconds: 0.05 });
		await new Promise((resolve) => setTimeout(resolve, 120));
		const list = await api("/api/shares?sessionId=1&kind=file&name=share-test.md");
		expect(
			(list.json.shares as { token: string }[]).some((entry) => entry.token === created.json.token),
		).toBe(false);
	});

	it("檔案不存在時拒絕生成", async () => {
		const res = await post("/api/share", { sessionId: "1", kind: "file", name: "no-such-file.md", ttlSeconds: 3600 });
		expect(res.status).toBe(400);
		expect(res.json.error).toContain("檔案不存在");
	});

	it("會話分享也能列出", async () => {
		const createdSession = await post("/api/sessions", {});
		const id = createdSession.json.id as string;
		const shared = await post("/api/share", { sessionId: id, kind: "conversation", ttlSeconds: 0 });
		const list = await api(`/api/shares?sessionId=${id}&kind=conversation`);
		expect(list.status).toBe(200);
		expect((list.json.shares as { token: string }[]).some((entry) => entry.token === shared.json.token)).toBe(true);
		await api(`/api/sessions?id=${id}`, { method: "DELETE" });
	});

	it("未知 token 返回 404", async () => {
		const page = await fetch(`${BASE}/s/doesnotexist`);
		expect(page.status).toBe(404);
	});
});

describe("上下文佔用", () => {
	it("返回估算的上下文佔比", async () => {
		const res = await api("/api/context?sessionId=1");
		expect(res.status).toBe(200);
		expect(res.json.contextWindow).toBeGreaterThan(0);
		expect(res.json.usedTokens).toBeGreaterThanOrEqual(0);
		expect(res.json.percent).toBeGreaterThanOrEqual(0);
		expect(res.json.percent).toBeLessThanOrEqual(100);
	});
});

describe("使用者管理", () => {
	let userId = "";
	let firstCode = "";

	it("建立使用者返回一次性邀請碼", async () => {
		const res = await post("/api/users", { name: "金標使用者" });
		expect(res.status).toBe(200);
		expect(res.json.ok).toBe(true);
		expect(res.json.code).toMatch(/^[a-z2-9]{16}$/);
		expect(res.json.user.id).toMatch(/^u_[a-z2-9]{8}$/);
		expect(res.json.user.codeHint).toBe(res.json.code.slice(-4));
		userId = res.json.user.id;
		firstCode = res.json.code;
	});

	it("列表只返回尾號，不洩露邀請碼", async () => {
		const res = await api("/api/users");
		expect(res.status).toBe(200);
		const item = (res.json.users as { id: string; name: string; codeHint: string }[]).find((u) => u.id === userId);
		expect(item).toMatchObject({ name: "金標使用者", codeHint: firstCode.slice(-4) });
		expect(JSON.stringify(res.json)).not.toContain(firstCode);
	});

	it("重置邀請碼會生成新碼", async () => {
		const res = await post("/api/users/reset", { id: userId });
		expect(res.status).toBe(200);
		expect(res.json.code).toMatch(/^[a-z2-9]{16}$/);
		expect(res.json.code).not.toBe(firstCode);
	});

	it("刪除使用者後列表不再返回", async () => {
		const res = await api(`/api/users?id=${userId}`, { method: "DELETE" });
		expect(res.json.ok).toBe(true);
		const list = await api("/api/users");
		expect((list.json.users as { id: string }[]).some((u) => u.id === userId)).toBe(false);
	});
});

describe("工具註冊（防迴歸）", () => {
	it("關鍵工具都已註冊給模型", async () => {
		const { json } = await api("/api/debug/agent");
		const tools: string[] = json.tools ?? [];
		for (const name of ["dispatch_tasks", "update_plan", "web_search", "web_fetch_page", "write_file", "codemode", "remember", "recall", "install_skill"]) {
			expect(tools).toContain(name);
		}
		// 分享工具（v0.55.0）：模型必須能直接生成連結
		for (const name of ["share_file", "share_conversation"]) {
			expect(tools).toContain(name);
		}
		// 使用者知識庫（v0.45.0）
		for (const name of ["kb_add", "kb_search", "kb_list", "kb_delete"]) {
			expect(tools).toContain(name);
		}
		// 目標模式（v0.31.0）
		for (const name of ["set_goal", "complete_goal", "report_goal"]) {
			expect(tools).toContain(name);
		}
	});

	it("子代理工具暴露可用工具清單", async () => {
		const { json } = await api("/api/debug/agent");
		const callable: string[] = json.callable ?? [];
		// codemode 指令碼能呼叫的工具（callers 含 tools）
		expect(callable).toContain("web_search");
		expect(callable).toContain("write_file");
	});
});

describe("計劃", () => {
	it("空計劃返回空陣列", async () => {
		const { json } = await api("/api/plan?sessionId=1");
		expect(Array.isArray(json.steps)).toBe(true);
	});
});

describe("目標模式", () => {
	it("初始為空", async () => {
		const { json } = await api("/api/goal?sessionId=1");
		expect(json.goal).toBeNull();
	});

	it("空目標被拒絕", async () => {
		const { status, json } = await post("/api/goal", { sessionId: "1", objective: "  " });
		expect(status).toBe(400);
		expect(json.ok).toBe(false);
	});

	it("建立 → 讀取 → 停止", async () => {
		const created = await post("/api/goal", {
			sessionId: "1",
			objective: "寫完對比報告",
			tokenBudget: 50000,
			maxTurns: 5,
		});
		expect(created.json.ok).toBe(true);
		expect(created.json.goal.status).toBe("active");
		expect(created.json.goal.objective).toBe("寫完對比報告");
		expect(created.json.goal.tokenBudget).toBe(50000);
		expect(created.json.goal.maxTurns).toBe(5);

		const read = await api("/api/goal?sessionId=1");
		expect(read.json.goal.status).toBe("active");

		const stopped = await api("/api/goal?sessionId=1", { method: "DELETE" });
		expect(stopped.json.ok).toBe(true);
		expect(stopped.json.goal.status).toBe("paused");
	});

	it("重複建立會覆蓋舊目標", async () => {
		await post("/api/goal", { sessionId: "1", objective: "第一版", tokenBudget: 20000 });
		const second = await post("/api/goal", { sessionId: "1", objective: "第二版", tokenBudget: 30000 });
		expect(second.json.goal.objective).toBe("第二版");
		expect(second.json.goal.status).toBe("active");
		expect(second.json.goal.tokensUsed).toBe(0);
		await api("/api/goal?sessionId=1", { method: "DELETE" });
	});
});

describe("會話分支", () => {
	it("無效 entryId 被拒絕", async () => {
		const res = await post("/api/branches", { sessionId: "1", entryId: 0 });
		expect(res.status).toBe(400);
	});

	it("建立分支 → 記錄來源 → 子會話帶歷史", async () => {
		const created = await post("/api/sessions", {});
		const sid: string = created.json.id;
		await post("/api/reset", { sessionId: sid });
		await post("/api/reset", { sessionId: sid });

		const entries = await api(`/api/entries?sessionId=${sid}`);
		const ids: number[] = entries.json.map((e: { id: number }) => e.id);
		const maxId = Math.max(...ids);

		const res = await post("/api/branches", { sessionId: sid, entryId: maxId });
		expect(res.json.ok).toBe(true);
		const childId: string = res.json.id;
		expect(childId).not.toBe(sid);

		const sessions = await api("/api/sessions");
		const child = sessions.json.sessions.find((s: { id: string }) => s.id === childId);
		expect(child.parent_id).toBe(sid);
		expect(child.fork_at).toBeGreaterThan(0);
		expect(child.fork_at).toBeLessThan(maxId);

		// 分叉點之前的歷史被繼承，且不包含被點的那條訊息
		const childEntries = await api(`/api/entries?sessionId=${childId}`);
		expect(childEntries.json.length).toBeGreaterThan(0);
		expect(Math.max(...childEntries.json.map((e: { id: number }) => e.id))).toBeLessThanOrEqual(child.fork_at);

		await api(`/api/sessions?id=${childId}`, { method: "DELETE" });
		await api(`/api/sessions?id=${sid}`, { method: "DELETE" });
	});
});

describe("生成中插話", () => {
	it("空插話被拒絕", async () => {
		const res = await post("/api/interject", { sessionId: "1", message: "   " });
		expect(res.status).toBe(400);
		expect(res.json.ok).toBe(false);
	});
});

describe("互動式問答（ask_user）", () => {
	it("待回答問題預設為空", async () => {
		const { json } = await api("/api/questions?sessionId=1");
		expect(Array.isArray(json.questions)).toBe(true);
	});

	it("缺少問題 id 被拒絕", async () => {
		const bad = await post("/api/questions", { answers: [] });
		expect(bad.status).toBe(400);
	});

	it("不存在的問題返回 404", async () => {
		const missing = await post("/api/questions", { id: 999999, answers: [{ id: "q1", choice: "a" }] });
		expect(missing.status).toBe(404);
	});

	it("ask_user 工具已註冊", async () => {
		const { json } = await api("/api/debug/agent");
		expect(json.tools).toContain("ask_user");
	});
});

describe("自定義工具", () => {
	it("非法工具名被拒絕", async () => {
		const bad = await post("/api/custom-tools", { name: "1bad", code: "return 1" });
		expect(bad.status).toBe(400);
	});

	it("內建工具名被拒絕", async () => {
		const bad = await post("/api/custom-tools", { name: "codemode", code: "return 1" });
		expect(bad.status).toBe(400);
		expect(bad.json.error).toContain("內建");
		const share = await post("/api/custom-tools", { name: "share_file", code: "return 1" });
		expect(share.status).toBe(400);
	});

	it("引數 schema 必須是物件", async () => {
		const bad = await post("/api/custom-tools", { name: "bad_schema", parameters: "[1,2]", code: "return 1" });
		expect(bad.status).toBe(400);
	});

	it("空程式碼被拒絕", async () => {
		const bad = await post("/api/custom-tools", { name: "no_code", code: "   " });
		expect(bad.status).toBe(400);
	});

	it("新增 → 列表 → 工具清單可見（exec 級）→ 刪除", async () => {
		const created = await post("/api/custom-tools", {
			name: "test_tool",
			description: "測試用",
			parameters: JSON.stringify({ type: "object", properties: { x: { type: "number" } } }),
			code: "return { doubled: Number(args.x ?? 0) * 2 };",
		});
		expect(created.json.ok).toBe(true);
		expect(created.json.tools).toBe(1);

		const list = await api("/api/custom-tools");
		expect(list.json.tools.map((t: { name: string }) => t.name)).toContain("test_tool");

		const tools = await api("/api/tools");
		const entry = tools.json.tools.find((t: { name: string }) => t.name === "test_tool");
		expect(entry).toMatchObject({ category: "exec" });

		const del = await api("/api/custom-tools?name=test_tool", { method: "DELETE" });
		expect(del.json.ok).toBe(true);
		const after = await api("/api/custom-tools");
		expect(after.json.tools.map((t: { name: string }) => t.name)).not.toContain("test_tool");
	});
});

describe("工具審批", () => {
	it("工具清單帶分級，預設全部放行", async () => {
		const { json } = await api("/api/tools");
		expect(json.approval).toEqual({ read: "allow", write: "allow", exec: "allow" });
		const byName = new Map(json.tools.map((t: { name: string; category: string; policy: string }) => [t.name, t]));
		expect(byName.get("read_file")).toMatchObject({ category: "read", policy: "allow" });
		expect(byName.get("write_file")).toMatchObject({ category: "write" });
		expect(byName.get("share_file")).toMatchObject({ category: "write" });
		expect(byName.get("share_conversation")).toMatchObject({ category: "write" });
		expect(byName.get("codemode")).toMatchObject({ category: "exec" });
		expect(byName.get("dispatch_tasks")).toMatchObject({ category: "exec" });
	});

	it("改分級策略後生效策略跟隨", async () => {
		await post("/api/settings", { approval: { write: "ask" } });
		const { json } = await api("/api/tools");
		expect(json.approval.write).toBe("ask");
		const writeTool = json.tools.find((t: { name: string }) => t.name === "write_file");
		expect(writeTool.policy).toBe("ask");
		// 其它檔位不受影響
		expect(json.tools.find((t: { name: string }) => t.name === "read_file").policy).toBe("allow");
	});

	it("逐工具覆蓋優先於分級", async () => {
		await post("/api/settings", { approvalTools: { write_file: "allow" } });
		const { json } = await api("/api/tools");
		expect(json.tools.find((t: { name: string }) => t.name === "write_file").policy).toBe("allow");
		await post("/api/settings", { approvalTools: { write_file: "follow" }, approval: { write: "allow" } });
	});

	it("非法與不存在的審批決定被拒絕", async () => {
		const bad = await post("/api/approvals", { id: 0, action: "once" });
		expect(bad.status).toBe(400);
		const missing = await post("/api/approvals", { id: 999999, action: "once" });
		expect(missing.status).toBe(404);
	});

	it("待審批列表預設空", async () => {
		const { json } = await api("/api/approvals?sessionId=1");
		expect(Array.isArray(json.approvals)).toBe(true);
	});
});

describe("定時任務編輯（NERE-64）", () => {
	const ids: string[] = [];

	/** 與後端同口徑：daily 按 UTC+8 解釋。 */
	function nextDaily(time: string, now = Date.now()): number {
		const [hour, minute] = time.split(":").map(Number);
		const offset = 8 * 3600_000;
		const local = new Date(now + offset);
		const at = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour!, minute!, 0) - offset;
		return at > now ? at : at + 24 * 3600_000;
	}

	async function create(schedule: unknown, name = "編輯測試") {
		const created = await post("/api/automations", { name, prompt: "舊提示", sessionId: "1", schedule });
		expect(created.json.ok).toBe(true);
		ids.push(created.json.id as string);
		return created.json.id as string;
	}

	async function row(id: string) {
		const { json } = await api("/api/automations");
		return json.automations.find((item: { id: string }) => item.id === id);
	}

	afterAll(async () => {
		for (const id of ids) await api(`/api/automations?id=${id}`, { method: "DELETE" });
	});

	it("改名稱 / 提示詞 / 會話：GET 列表立即反映，next_run_at 保留", async () => {
		const id = await create({ kind: "interval", minutes: 30 });
		const before = await row(id);

		const res = await patch("/api/automations", { id, name: "  每日科技日報 ", prompt: " 新的提示詞 ", sessionId: "2991" });
		expect(res.status).toBe(200);
		expect(res.json.ok).toBe(true);
		expect(res.json.automation).toMatchObject({
			id,
			name: "每日科技日報",
			prompt: "新的提示詞",
			sessionId: "2991",
			schedule: { kind: "interval", minutes: 30 },
			enabled: true,
			next_run_at: before.next_run_at,
		});

		const after = await row(id);
		expect(after).toMatchObject({
			name: "每日科技日報",
			prompt: "新的提示詞",
			session_id: "2991",
			schedule: JSON.stringify({ kind: "interval", minutes: 30 }),
			next_run_at: before.next_run_at,
		});
	});

	it("GET 列表與 PATCH 返回體帶 last_status，新任務為空（NERE-68）", async () => {
		const id = await create({ kind: "interval", minutes: 20 });
		expect(await row(id)).toMatchObject({ last_run_at: null, last_status: null });

		const res = await patch("/api/automations", { id, name: "帶狀態" });
		expect(res.status).toBe(200);
		expect(res.json.automation).toMatchObject({ last_run_at: null, last_status: null });
	});

	it("新任務預設每輪新建會話，PATCH 可關閉並回顯 last_session_id（NERE-84）", async () => {
		const id = await create({ kind: "interval", minutes: 20 });
		expect(await row(id)).toMatchObject({ fresh_session: 1, last_session_id: null });

		const res = await patch("/api/automations", { id, fresh_session: false });
		expect(res.status).toBe(200);
		expect(res.json.automation).toMatchObject({ fresh_session: false, last_session_id: null });
		expect(await row(id)).toMatchObject({ fresh_session: 0 });

		// 非法型別 400，不改庫
		expect((await patch("/api/automations", { id, fresh_session: "off" })).status).toBe(400);
		expect(await row(id)).toMatchObject({ fresh_session: 0 });
	});

	it("改 daily 08:03 → next_run_at 為下一個 08:03（UTC+8）", async () => {
		const id = await create({ kind: "interval", minutes: 30 });
		const res = await patch("/api/automations", { id, schedule: { kind: "daily", time: "08:03" }, enabled: true });
		expect(res.status).toBe(200);
		expect(res.json.automation.schedule).toEqual({ kind: "daily", time: "08:03" });

		const next = Number(res.json.automation.next_run_at);
		expect(next).toBe(nextDaily("08:03"));
		// 同一斷言換個角度：UTC+8 的時分就是 08:03，且落在未來 24 小時內
		const local = new Date(next + 8 * 3600_000);
		expect([local.getUTCHours(), local.getUTCMinutes()]).toEqual([8, 3]);
		expect(next).toBeGreaterThan(Date.now());
		expect(next).toBeLessThanOrEqual(Date.now() + 24 * 3600_000);
	});

	it("改 interval 5 → next_run_at = now + 5 分鐘", async () => {
		const id = await create({ kind: "daily", time: "09:00" });
		const before = Date.now();
		const res = await patch("/api/automations", { id, schedule: { kind: "interval", minutes: 5 }, enabled: true });
		const after = Date.now();
		expect(res.status).toBe(200);
		const next = Number(res.json.automation.next_run_at);
		expect(next).toBeGreaterThanOrEqual(before + 5 * 60_000);
		expect(next).toBeLessThanOrEqual(after + 5 * 60_000);
	});

	it("只傳 enabled=false：只停用，其他欄位與下一次時間不動", async () => {
		const id = await create({ kind: "interval", minutes: 30 });
		const before = await row(id);

		const res = await patch("/api/automations", { id, enabled: false });
		expect(res.status).toBe(200);
		expect(res.json.automation).toMatchObject({ id, name: before.name, prompt: before.prompt, sessionId: before.session_id, enabled: false, next_run_at: before.next_run_at });

		const after = await row(id);
		expect(after).toMatchObject({ ...before, enabled: 0 });
	});

	it("編輯帶回 enabled=true 不會把任務提前到 60 秒後", async () => {
		const id = await create({ kind: "daily", time: "09:00" });
		const before = await row(id);
		const res = await patch("/api/automations", { id, name: "改名不改時間", enabled: true });
		expect(res.status).toBe(200);
		expect(res.json.automation.next_run_at).toBe(before.next_run_at);
	});

	it("非法 schedule / 空名稱 / 超長提示詞 → 400，原記錄不變", async () => {
		const id = await create({ kind: "interval", minutes: 30 });
		const before = await row(id);
		const invalid = [
			{ id, schedule: { kind: "daily", time: "24:00" } },
			{ id, schedule: { kind: "interval", minutes: 0 } },
			{ id, schedule: { kind: "weekly" } },
			{ id, name: "   " },
			{ id, name: "x".repeat(41) },
			{ id, prompt: "" },
			{ id, prompt: "x".repeat(2001) },
			{ name: "缺少 id" },
			{ id, enabled: "false" },
		];
		for (const body of invalid) {
			const res = await patch("/api/automations", body);
			expect(res.status).toBe(400);
			expect(typeof res.json.error).toBe("string");
		}
		expect(await row(id)).toEqual(before);

		const missing = await patch("/api/automations", { id: "a-not-exist", name: "x" });
		expect(missing.status).toBe(404);
	});
});

describe("匯出與版本", () => {
	it("匯出 Markdown 返回文本", async () => {
		const res = await fetch(`${BASE}/api/export?format=md&sessionId=1`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/markdown");
	});

	it("版本介面返回構建號", async () => {
		const { json } = await api("/api/version");
		expect(typeof json.build).toBe("string");
	});
});

describe("首屏聚合 /api/bootstrap", () => {
	it("一次返回所有面板，且與單端點結果一致", async () => {
		const created = await post("/api/sessions", {});
		const sid = created.json.id as string;
		await post("/api/restore", {
			version: 1,
			data: {
				files: [{ conversation_id: sid, name: "bootstrap.md", content: "# bootstrap", updated_at: new Date().toISOString() }],
				memories: [{ content: "bootstrap 記憶", created_at: new Date().toISOString(), source: "manual" }],
			},
		});

		const boot = await api(`/api/bootstrap?sessionId=${sid}`);
		expect(boot.status).toBe(200);
		expect(boot.json.errors).toEqual({});
		expect(boot.json.session).toEqual({ ok: true, name: "durable-pi" });
		// v1.1.0：沒有內建供應商，模型列表可以為空；有模型時 default 必須是第一個
		expect(Array.isArray(boot.json.models.models)).toBe(true);
		expect(boot.json.models.default).toBe(boot.json.models.models[0] ?? "");

		const [
			entries, sessions, files, memories, approvals, settings, plan,
			goal, questions, prompts, rules, customTools, skills, automations, mcpServers,
		] = await Promise.all([
			api(`/api/entries?sessionId=${sid}`),
			api("/api/sessions"),
			api(`/api/files?sessionId=${sid}`),
			api("/api/memories"),
			api(`/api/approvals?sessionId=${sid}`),
			api("/api/settings"),
			api(`/api/plan?sessionId=${sid}`),
			api(`/api/goal?sessionId=${sid}`),
			api(`/api/questions?sessionId=${sid}`),
			api("/api/prompts"),
			api("/api/rules"),
			api("/api/custom-tools"),
			api("/api/skills"),
			api("/api/automations"),
			api("/api/mcp"),
		]);

		expect(boot.json.entries).toEqual(entries.json);
		expect(boot.json.sessions).toEqual(sessions.json.sessions);
		expect(boot.json.files).toEqual(files.json.files);
		expect(boot.json.files.map((f: { name: string }) => f.name)).toContain("bootstrap.md");
		expect(boot.json.memories).toEqual(memories.json.memories);
		expect(boot.json.approvals).toEqual(approvals.json.approvals);
		expect(boot.json.settings).toEqual(settings.json);
		expect(boot.json.plan).toEqual(plan.json.steps);
		expect(boot.json.goal).toEqual(goal.json.goal);
		expect(boot.json.questions).toEqual(questions.json.questions);
		expect(boot.json.prompts).toEqual(prompts.json.prompts);
		expect(boot.json.rules).toEqual(rules.json.rules);
		expect(boot.json.customTools).toEqual(customTools.json.tools);
		expect(boot.json.skills).toEqual(skills.json.skills);
		expect(boot.json.automations).toEqual(automations.json.automations);
		expect(boot.json.mcpServers).toEqual(mcpServers.json.servers);

		await api(`/api/sessions?id=${sid}`, { method: "DELETE" });
	});

	it("空白會話的預設值可被前端容錯解析", async () => {
		const created = await post("/api/sessions", {});
		const sid = created.json.id as string;
		const { json } = await api(`/api/bootstrap?sessionId=${sid}`);

		expect(json.entries).toEqual([]);
		expect(json.files).toEqual([]);
		expect(json.approvals).toEqual([]);
		expect(json.plan).toEqual([]);
		expect(json.goal).toBeNull();
		expect(json.questions).toEqual([]);
		expect(Array.isArray(json.sessions)).toBe(true);
		expect(json.sessions.some((s: { id: string }) => s.id === sid)).toBe(true);
		expect(typeof json.settings.webSearch).toBe("boolean");
		expect(json.errors).toEqual({});

		await api(`/api/sessions?id=${sid}`, { method: "DELETE" });
	});

	it("非法 sessionId 返回 400", async () => {
		for (const value of ["abc", "0", "-1", "1.5", "1e3"]) {
			const res = await api(`/api/bootstrap?sessionId=${encodeURIComponent(value)}`);
			expect(res.status).toBe(400);
			expect(res.json.error).toContain("正整數");
		}
	});

	it("預設 sessionId 落到根會話", async () => {
		const res = await api("/api/bootstrap");
		expect(res.status).toBe(200);
		expect(res.json.errors).toEqual({});
	});
});
