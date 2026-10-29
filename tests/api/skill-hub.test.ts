import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopServer } from "./teardown";

/**
 * Skill Hub 端到端（NERE-55）：真實 `wrangler dev` + 真實 DO SQLite。
 * 覆蓋 422 blocked 不寫庫、Hub 篩選、審計詳情、社群收口、埋點指標與舊 /skills 相容。
 */

const ROOT = join(__dirname, "../..");
const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-skill-hub");

let proc: ChildProcess | null = null;

async function api(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		// 非 JSON 響應
	}
	return { status: res.status, json, text, headers: res.headers };
}

const post = (path: string, body: unknown) =>
	api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const sha256 = (content: string) =>
	`sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

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

describe("Skill Hub API", () => {
	it("GET /api/skills/hub 返回內建目錄、審計與篩選；python 過濾不報 400", async () => {
		const { status, json, headers } = await api("/api/skills/hub");
		expect(status).toBe(200);
		expect(json.catalog.count).toBeGreaterThanOrEqual(6);
		expect(json.skills.length).toBeGreaterThanOrEqual(6);
		expect(json.skills[0]).toMatchObject({ name: expect.any(String), audit: { status: expect.any(String) } });
		expect(json.skills.every((skill: { audit: { status: string } }) => skill.audit.status !== "blocked")).toBe(true);
		expect(json.filters.runtimes).toEqual(["prompt", "javascript", "typescript"]);
		expect(headers.get("cache-control")).toContain("private");
		expect(headers.get("cache-control")).toContain("max-age=30");

		// operator 修訂：python/shell/binary/other 作為篩選值必須 200
		for (const runtime of ["python", "shell", "binary", "other"]) {
			const filtered = await api(`/api/skills/hub?runtime=${runtime}`);
			expect(filtered.status).toBe(200);
			expect(filtered.json.skills).toEqual([]);
		}
		const bad = await api("/api/skills/hub?runtime=ruby");
		expect(bad.status).toBe(400);
		expect(bad.json.code).toBe("bad_request");

		// 驗收 9：8 條社群技能在 audit=blocked 檢視可見
		const blocked = await api("/api/skills/hub?audit=blocked");
		const blockedNames = (blocked.json.skills as { name: string }[]).map((skill) => skill.name);
		for (const name of ["brave-search", "youtube-transcript", "browser-tools", "transcribe", "gdcli", "gccli", "gmcli", "vscode"]) {
			expect(blockedNames).toContain(name);
		}
	});

	it("Python 技能匯入 → 422 audit_blocked，庫中無記錄", async () => {
		const { status, json } = await post("/api/skills/import", {
			manifest: {
				schemaVersion: 1,
				name: "csv-report-py",
				version: "1.0.0",
				description: "用 Python 生成 CSV 報告",
				author: "hou",
				source: "https://example.com/csv-report-py",
				license: "MIT",
				runtime: "python",
				tags: ["csv"],
				requires: { tools: [], bindings: [], network: [] },
				entry: "main.py",
			},
			content: "#!/usr/bin/env python3\nprint(1)\n",
		});
		expect(status).toBe(422);
		expect(json).toMatchObject({ ok: false, installed: false, code: "audit_blocked" });
		expect(json.details.audit.status).toBe("blocked");
		expect(json.details.audit.reasons.length).toBeGreaterThan(0);
		const list = await api("/api/skills");
		expect((list.json.skills as { name: string }[]).some((skill) => skill.name === "csv-report-py")).toBe(false);
	});

	it("純 JS 匯入 → 200 pass 入庫；Hub installed=1 與 audit 詳情可查", async () => {
		const content = "const now = await tools.now({});\nreturn { now };\n";
		const manifest = {
			schemaVersion: 1,
			name: "pure-js-api",
			version: "1.0.0",
			description: "讀取當前時間",
			author: "hou",
			source: "https://example.com/pure-js-api",
			license: "MIT",
			runtime: "javascript",
			tags: ["utility"],
			requires: { tools: ["now"], bindings: [], network: [] },
			entry: "index.js",
			contentHash: sha256(content),
		};
		const imported = await post("/api/skills/import", { manifest, content });
		expect(imported.status).toBe(200);
		expect(imported.json).toMatchObject({ ok: true, installed: true, changed: true, name: "pure-js-api", audit: { status: "pass" } });

		const repeat = await post("/api/skills/import", { manifest, content });
		expect(repeat.status).toBe(200);
		expect(repeat.json.changed).toBe(false);

		const hub = await api("/api/skills/hub?installed=1");
		const entry = (hub.json.skills as { name: string; installed: boolean }[]).find((skill) => skill.name === "pure-js-api");
		expect(entry?.installed).toBe(true);

		const audit = await api("/api/skills/pure-js-api/audit");
		expect(audit.status).toBe(200);
		expect(audit.json.audit.status).toBe("pass");
		expect(audit.headers.get("cache-control")).toBe("no-store");

		const list = await api("/api/skills");
		const row = (list.json.skills as { name: string; lastInvokedAt: number | null; runtime: string }[]).find(
			(skill) => skill.name === "pure-js-api",
		);
		expect(row).toMatchObject({ runtime: "javascript", lastInvokedAt: null });
	});

	it("目錄技能的審計詳情來自快照（catalog），不存在 → 404", async () => {
		const catalogEntry = await api("/api/skills/meeting-notes/audit");
		expect(catalogEntry.status).toBe(200);
		expect(catalogEntry.json).toMatchObject({ name: "meeting-notes", audit: { auditSource: "catalog" } });
		const missing = await api("/api/skills/no-such-skill/audit");
		expect(missing.status).toBe(404);
		expect(missing.json.code).toBe("not_found");
		const invalid = await api("/api/skills/Bad_Name/audit");
		expect(invalid.status).toBe(400);
	});

	it("社群入口 8 條全部 blocked，不可安裝", async () => {
		const { status, json } = await api("/api/skills/community");
		expect(status).toBe(200);
		expect(json.skills).toHaveLength(8);
		for (const skill of json.skills as { audit_status: string; audit: { status: string; reasons: { rule: string }[] } }[]) {
			expect(skill.audit_status).toBe("blocked");
			expect(skill.audit.status).toBe("blocked");
			expect(skill.audit.reasons[0]!.rule).toBe("M3");
		}
	});

	it("舊 /skills CRUD 保持相容", async () => {
		const created = await post("/api/skills", { name: "manual-one", description: "手寫", content: "# 正文" });
		expect(created.status).toBe(200);
		expect(created.json).toEqual({ ok: true });
		const list = await api("/api/skills");
		const row = (list.json.skills as { name: string; description: string; auditStatus: string; lastInvokedAt: number | null }[]).find(
			(skill) => skill.name === "manual-one",
		);
		expect(row).toMatchObject({ description: "手寫", auditStatus: "pass", lastInvokedAt: null });

		// 同名覆蓋：寫入前審計，GET /skills 與 hub 讀同一份真相。
		const overwritten = await post("/api/skills", {
			name: "manual-one",
			description: "手寫",
			content: "```python\nprint(1)\n```",
		});
		expect(overwritten.status).toBe(200);
		const afterOverwrite = await api("/api/skills");
		const blockedRow = (afterOverwrite.json.skills as { name: string; auditStatus: string }[]).find(
			(skill) => skill.name === "manual-one",
		);
		expect(blockedRow!.auditStatus).toBe("blocked");
		const hub = await api("/api/skills/hub?installed=1");
		const hubRow = (hub.json.skills as { name: string; audit: { status: string } }[]).find((skill) => skill.name === "manual-one");
		expect(hubRow!.audit.status).toBe("blocked");

		// 256 KiB 上限：超限 413，且不覆蓋已存在的行。
		const tooLarge = await post("/api/skills", { name: "manual-big", content: "x".repeat(256 * 1024 + 1) });
		expect(tooLarge.status).toBe(413);

		const deleted = await api("/api/skills?name=manual-one", { method: "DELETE" });
		expect(deleted.json).toEqual({ ok: true });
	});
});

describe("Skill Hub 指標", () => {
	it("開啟 Hub / 被拒匯入 / 成功安裝 → metrics 與 blockedRatio 變化", async () => {
		const before = await api("/api/metrics/skill-hub?days=1");
		expect(before.status).toBe(200);
		expect(before.json).toMatchObject({
			days: 1,
			hubViews: expect.any(Number),
			installOk: expect.any(Number),
			installBlocked: expect.any(Number),
			blockedRatio: expect.any(Number),
			installed: expect.any(Number),
			called7d: expect.any(Number),
		});
		expect(before.json.hubViews).toBeGreaterThanOrEqual(1);
		expect(before.json.installOk).toBeGreaterThanOrEqual(1);
		expect(before.json.installBlocked).toBeGreaterThanOrEqual(1);
		expect(before.json.installed).toBeGreaterThanOrEqual(1);
		expect(before.json.blockedRatio).toBeGreaterThan(0);
		expect(before.json.blockedRatio).toBeLessThanOrEqual(1);

		await api("/api/skills/hub");
		const after = await api("/api/metrics/skill-hub?days=1");
		expect(after.json.hubViews).toBeGreaterThan(before.json.hubViews);
	});
});
