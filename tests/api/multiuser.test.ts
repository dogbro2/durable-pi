import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopServer } from "./teardown";

/**
 * 多使用者隔離（v0.45.0）：知識庫與檔案都落在各自 DO，
 * 這個檔案專門跑「有密碼」模式，驗證邀請碼使用者看不到主人的資料。
 */
const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.MULTIUSER_TEST_PORT ?? 8798);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-multi");
const PASSWORD = "golden-owner-pass";

let proc: ChildProcess | null = null;
let ownerCookie = "";
let userCookie = "";
let userId = "";

async function call(path: string, init: RequestInit = {}, cookie = ownerCookie) {
	const headers = new Headers(init.headers);
	if (cookie) headers.set("cookie", cookie);
	const res = await fetch(`${BASE}${path}`, { ...init, headers });
	const text = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		// 非 JSON 響應
	}
	const setCookie = res.headers.get("set-cookie") ?? "";
	return { status: res.status, json, text, cookie: setCookie.split(";")[0] ?? "" };
}

const post = (path: string, body: unknown, cookie?: string) =>
	call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, cookie);

async function waitForServer(timeoutMs = 90_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const res = await fetch(`${BASE}/api/auth`, { signal: AbortSignal.timeout(1500) });
			if (res.ok) return;
		} catch {
			// 還沒起來
		}
		await new Promise((resolve) => setTimeout(resolve, 800));
	}
	throw new Error("wrangler dev 未在超時內就緒");
}

beforeAll(async () => {
	rmSync(STATE, { recursive: true, force: true });
	proc = spawn(
		"npx",
		["wrangler", "dev", "--config", "wrangler.test.jsonc", "--port", String(PORT), "--var", `ACCESS_PASSWORD:${PASSWORD}`, "--var", "CF_DISABLE_VECTOR:1", "--persist-to", STATE],
		{ cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "ignore", detached: true },
	);
	await waitForServer();

	const login = await post("/api/login", { password: PASSWORD }, "");
	ownerCookie = login.cookie;
	expect(ownerCookie).toMatch(/^pi_access=/);

	const created = await post("/api/users", { name: "隔離使用者" });
	userId = created.json.user.id as string;
	const invite = created.json.code as string;
	const userLogin = await post("/api/login", { password: invite }, "");
	userCookie = userLogin.cookie;
	expect(userCookie).toMatch(/^pi_access=u_/);
});

afterAll(async () => {
	await stopServer(proc, STATE);
});

describe("多使用者隔離", () => {
	it("未登入訪問知識庫被拒絕", async () => {
		const res = await call("/api/kb", {}, "");
		expect(res.status).toBe(401);
	});

	it("知識庫各自獨立", async () => {
		const ownerAdd = await post("/api/kb", { title: "主人資料", content: "只有主人能看到的久期筆記" });
		expect(ownerAdd.json.id).toBeGreaterThan(0);

		const userBefore = await call("/api/kb", {}, userCookie);
		expect(userBefore.json.docs).toEqual([]);

		const userAdd = await post("/api/kb", { title: "使用者資料", content: "使用者自己的城投筆記" }, userCookie);
		expect(userAdd.json.id).toBeGreaterThan(0);

		const ownerSearch = await call(`/api/kb/search?q=${encodeURIComponent("使用者")}`, {}, ownerCookie);
		expect(ownerSearch.json.hits).toEqual([]);

		const userSearch = await call(`/api/kb/search?q=${encodeURIComponent("主人")}`, {}, userCookie);
		expect(userSearch.json.hits).toEqual([]);

		const userDocs = await call("/api/kb", {}, userCookie);
		expect(userDocs.json.docs.map((d: { title: string }) => d.title)).toEqual(["使用者資料"]);
	});

	it("檔案總覽只包含自己的檔案", async () => {
		await post("/api/restore", {
			version: 1,
			data: { files: [{ conversation_id: "1", name: "owner-only.md", content: "# owner", updated_at: new Date().toISOString() }] },
		});
		const userSession = await post("/api/sessions", {}, userCookie);
		await post(
			"/api/restore",
			{ version: 1, data: { files: [{ conversation_id: userSession.json.id, name: "user-only.md", content: "# user", updated_at: new Date().toISOString() }] } },
			userCookie,
		);

		const ownerFiles = await call("/api/files/all", {});
		expect(ownerFiles.json.files.map((f: { name: string }) => f.name)).toEqual(["owner-only.md"]);

		const userFiles = await call("/api/files/all", {}, userCookie);
		expect(userFiles.json.files.map((f: { name: string }) => f.name)).toEqual(["user-only.md"]);
	});

	it("普通使用者不能管理使用者", async () => {
		const res = await call("/api/users", {}, userCookie);
		expect(res.status).toBe(403);
	});

	it("刪除使用者後其會話失效", async () => {
		const removed = await call(`/api/users?id=${userId}`, { method: "DELETE" }, ownerCookie);
		expect(removed.json.ok).toBe(true);
		const after = await call("/api/kb", {}, userCookie);
		expect(after.status).toBe(401);
	});
});

describe("首屏聚合（邀請使用者）", () => {
	it("新使用者一次拿全首屏，只查一次登錄檔", async () => {
		const created = await post("/api/users", { name: "首屏使用者" }, ownerCookie);
		const code = created.json.code as string;
		const login = await post("/api/login", { password: code }, "");
		const cookie = login.cookie;
		expect(cookie).toMatch(/^pi_access=u_/);

		const before = await call("/api/debug/registry", {}, ownerCookie);
		expect(typeof before.json.lookups).toBe("number");

		const boot = await call("/api/bootstrap?sessionId=1", {}, cookie);
		expect(boot.status).toBe(200);
		expect(boot.json.errors).toEqual({});
		expect(boot.json.entries).toEqual([]);
		expect(boot.json.files).toEqual([]);
		expect(boot.json.skills).toEqual([]);
		expect(boot.json.prompts).toEqual([]);
		expect(boot.json.settings.webSearch).toBe(true);
		// v1.1.0：沒有內建供應商，新使用者就是空列表；配了供應商才會有模型
		expect(Array.isArray(boot.json.models.models)).toBe(true);
		expect(boot.json.models.provider).toBe("");
		// bootstrap 內部 17 個面板共用一個請求 → 登錄檔只被查一次（舊路徑是 17-18 次）。
		const after = await call("/api/debug/registry", {}, ownerCookie);
		expect(after.json.lookups - before.json.lookups).toBe(1);
	});
});

describe("階段 4：設定 / 自定義工具按使用者隔離（R5）", () => {
	it("各自 DO 的設定與自定義工具名不互相覆蓋", async () => {
		await post("/api/settings", { displayName: "主人署名" });
		const saved = await post("/api/custom-tools", { name: "owner_probe", description: "主人工具有效", code: "return 1" });
		expect(saved.json.ok).toBe(true);

		const created = await post("/api/users", { name: "階段四使用者" }, ownerCookie);
		const login = await post("/api/login", { password: created.json.code as string }, "");
		const cookie = login.cookie;
		expect(cookie).toMatch(/^pi_access=u_/);

		const userSettings = await call("/api/settings", {}, cookie);
		expect(userSettings.json.displayName).toBe("");

		const userTools = await call("/api/custom-tools", {}, cookie);
		expect(userTools.json.tools.map((t: { name: string }) => t.name)).not.toContain("owner_probe");

		const ownerTools = await call("/api/custom-tools", {}, ownerCookie);
		expect(ownerTools.json.tools.map((t: { name: string }) => t.name)).toContain("owner_probe");

		// /api/tools 的 category 讀的是各自例項的 customToolNames 集合。
		const userList = await call("/api/tools", {}, cookie);
		expect(userList.status).toBe(200);
		expect(userList.json.tools.some((t: { name: string }) => t.name === "owner_probe")).toBe(false);

		const ownerList = await call("/api/tools", {}, ownerCookie);
		expect(ownerList.json.tools.find((t: { name: string }) => t.name === "owner_probe")?.category).toBe("exec");
	});
});

describe("使用者吊銷生命週期（NERE-24）", () => {
	async function inviteUser(name: string) {
		const created = await post("/api/users", { name }, ownerCookie);
		const id = created.json.user.id as string;
		const login = await post("/api/login", { password: created.json.code as string }, "");
		return { id, cookie: login.cookie as string };
	}

	async function seedUser(cookie: string) {
		const session = await post("/api/sessions", {}, cookie);
		const sessionId = session.json.id as string;
		await post(
			"/api/restore",
			{
				version: 1,
				data: {
					files: [{ conversation_id: sessionId, name: "lifecycle.md", content: "# keep", updated_at: new Date().toISOString() }],
				},
			},
			cookie,
		);
		const conversation = await post("/api/share", { sessionId, kind: "conversation", ttlSeconds: 0 }, cookie);
		const file = await post("/api/share", { sessionId, kind: "file", name: "lifecycle.md", ttlSeconds: 0 }, cookie);
		return { sessionId, conversationToken: conversation.json.token as string, fileToken: file.json.token as string };
	}

	it("刪除使用者後舊分享連結 404、舊 token 401，重複刪除冪等", async () => {
		const { id, cookie } = await inviteUser("吊銷連結使用者");
		const seeded = await seedUser(cookie);
		expect((await fetch(`${BASE}/s/${seeded.conversationToken}`)).status).toBe(200);
		expect((await fetch(`${BASE}/s/${seeded.fileToken}`)).status).toBe(200);

		const removed = await call(`/api/users?id=${id}`, { method: "DELETE" }, ownerCookie);
		expect(removed.status).toBe(200);
		expect(removed.json).toMatchObject({ ok: true, id, deleted: true, shares: 2 });
		expect(removed.json.retained.sessions).toBeGreaterThanOrEqual(1);
		expect(removed.json.retained.files).toBe(1);

		expect((await fetch(`${BASE}/s/${seeded.conversationToken}`)).status).toBe(404);
		expect((await fetch(`${BASE}/s/${seeded.fileToken}`)).status).toBe(404);
		expect((await call("/api/kb", {}, cookie)).status).toBe(401);

		const again = await call(`/api/users?id=${id}`, { method: "DELETE" }, ownerCookie);
		expect(again.status).toBe(200);
		expect(again.json).toMatchObject({ ok: true, id, deleted: false, shares: 0 });
	});

	it("匯出 → 刪除使用者 → 二次確認清空資料，重複清空為 0", async () => {
		const { id, cookie } = await inviteUser("待清空使用者");
		await post("/api/kb", { title: "待匯出筆記", content: "purge 前必須能匯出" }, cookie);
		const seeded = await seedUser(cookie);

		const exported = await call(`/api/users/export?id=${id}`, {}, ownerCookie);
		expect(exported.status).toBe(200);
		expect(exported.json.version).toBe(1);
		expect(exported.json.data.kbDocs.map((doc: { title: string }) => doc.title)).toEqual(["待匯出筆記"]);
		expect(exported.json.data.files.map((file: { name: string }) => file.name)).toContain("lifecycle.md");

		const missingConfirm = await call(`/api/users/data?id=${id}`, { method: "DELETE" }, ownerCookie);
		expect(missingConfirm.status).toBe(400);
		const stillRegistered = await call(`/api/users/data?id=${id}&confirm=${id}`, { method: "DELETE" }, ownerCookie);
		expect(stillRegistered.status).toBe(409);

		expect((await call(`/api/users?id=${id}`, { method: "DELETE" }, ownerCookie)).json.ok).toBe(true);
		expect((await fetch(`${BASE}/s/${seeded.fileToken}`)).status).toBe(404);

		const purged = await call(`/api/users/data?id=${id}&confirm=${id}`, { method: "DELETE" }, ownerCookie);
		expect(purged.status).toBe(200);
		expect(purged.json).toMatchObject({ ok: true, id });
		expect(purged.json.purged).toMatchObject({ sessions: 1, files: 1, shares: 0, kbDocs: 1 });
		expect(purged.json.purged.kbChunks).toBeGreaterThanOrEqual(1);

		const again = await call(`/api/users/data?id=${id}&confirm=${id}`, { method: "DELETE" }, ownerCookie);
		expect(again.status).toBe(200);
		expect(again.json.purged).toMatchObject({ sessions: 0, files: 0, shares: 0, kbDocs: 0, kbChunks: 0 });
		expect((await call("/api/kb", {}, cookie)).status).toBe(401);
	});

	it("客戶端偽造內部頭也不能呼叫處置端點", async () => {
		const spoof = await call(
			"/api/internal/purge-user",
			{ method: "POST", headers: { "x-pi-internal": "1" } },
			ownerCookie,
		);
		expect(spoof.status).toBe(404);
	});

	it("刪除會話級聯失效該會話的分享並清理檔案", async () => {
		const session = await post("/api/sessions", {});
		const sessionId = session.json.id as string;
		await post("/api/restore", {
			version: 1,
			data: {
				files: [{ conversation_id: sessionId, name: "cascade.md", content: "# cascade", updated_at: new Date().toISOString() }],
			},
		});
		const conversation = await post("/api/share", { sessionId, kind: "conversation", ttlSeconds: 0 });
		const file = await post("/api/share", { sessionId, kind: "file", name: "cascade.md", ttlSeconds: 0 });

		const removed = await call(`/api/sessions?id=${sessionId}`, { method: "DELETE" }, ownerCookie);
		expect(removed.status).toBe(200);
		expect(removed.json.deleted).toMatchObject({ shares: 2, files: 1 });

		expect((await fetch(`${BASE}/s/${conversation.json.token}`)).status).toBe(404);
		expect((await fetch(`${BASE}/s/${file.json.token}`)).status).toBe(404);
		const files = await call(`/api/files/all?q=cascade`, {}, ownerCookie);
		expect(files.json.files).toEqual([]);
	});
});
