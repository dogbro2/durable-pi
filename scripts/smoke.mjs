#!/usr/bin/env node
/**
 * 線上冒煙測試（v0.37.1）
 *
 * 部署後跑一遍，確認「部署了但功能是壞的」這類問題能被立刻發現
 * （比如審批那次包裝層漏引數，介面都通、codemode 全掛）。
 *
 * 用法：
 *   npm run smoke              # 介面層
 *   npm run smoke -- --deep    # 額外跑一次真實對話，驗證工具執行鏈路
 *
 * 密碼來源：環境變數 PI_PASSWORD，或 macOS 鑰匙串
 *   security find-generic-password -a durable-pi -s durable-pi-access -w
 * 站點：PI_BASE（必填），例：PI_BASE=https://durable-pi.example.workers.dev
 */

import { execSync } from "node:child_process";

const BASE = (process.env.PI_BASE || "").replace(/\/+$/, "");
const DEEP = process.argv.includes("--deep");

if (!/^https?:\/\//.test(BASE)) {
	console.error("請設定站點：PI_BASE=https://<你的 worker 域名> npm run smoke");
	process.exit(2);
}

function readPassword() {
	if (process.env.PI_PASSWORD) return process.env.PI_PASSWORD;
	try {
		return execSync("security find-generic-password -a durable-pi -s durable-pi-access -w", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

const password = readPassword();
if (!password) {
	console.error("找不到密碼：設定 PI_PASSWORD，或在鑰匙串裡存 durable-pi-access。");
	process.exit(2);
}

let cookie = "";
const results = [];

async function call(path, init = {}) {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		// 非 JSON（首頁 HTML）
	}
	return { status: res.status, json, text, headers: res.headers };
}

async function check(name, fn) {
	try {
		const detail = await fn();
		results.push({ name, ok: true, detail });
	} catch (err) {
		results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
	}
}

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

// ---- 登入 ----
{
	const res = await fetch(`${BASE}/api/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password }),
	});
	const setCookie = res.headers.get("set-cookie") ?? "";
	const match = /pi_access=([^;]+)/.exec(setCookie);
	if (!res.ok || !match) {
		console.error(`登入失敗：HTTP ${res.status}。檢查密碼是否正確。`);
		process.exit(1);
	}
	cookie = `pi_access=${match[1]}`;
}

// ---- 介面層 ----
await check("GET /", async () => {
	const res = await call("/");
	expect(res.status === 200, `HTTP ${res.status}`);
	expect(/<html/i.test(res.text), "不是 HTML");
	return "200";
});

await check("GET /api/version", async () => {
	const { json } = await call("/api/version");
	expect(typeof json?.build === "string" && json.build.length >= 7, "缺少 build");
	return json.build.slice(0, 7);
});

await check("GET /api/capabilities", async () => {
	const { json } = await call("/api/capabilities");
	const groups = (json?.groups ?? []).map((g) => g.key);
	expect(groups.join(",") === "builtin,data,protocol", `分組異常：${groups.join(",")}`);
	return `${json.groups.reduce((n, g) => n + g.items.length, 0)} 項`;
});

await check("GET /api/tools", async () => {
	const { json } = await call("/api/tools");
	const names = (json?.tools ?? []).map((t) => t.name);
	for (const required of ["codemode", "write_file", "read_file", "web_search", "update_plan", "dispatch_tasks", "ask_user", "set_goal", "install_skill", "kb_add", "kb_search"]) {
		expect(names.includes(required), `缺少工具 ${required}`);
	}
	return `${names.length} 個工具`;
});

await check("GET /api/kb/prefetch", async () => {
	const { json } = await call(`/api/kb/prefetch?q=${encodeURIComponent("測試")}`);
	expect(typeof json?.enabled === "boolean", "缺少 enabled");
	expect(typeof json?.block === "string", "缺少 block");
	return json.enabled ? "預檢索開啟" : "預檢索關閉";
});

await check("GET /api/kernel", async () => {	const { json } = await call("/api/kernel");
	const packages = Object.keys(json?.current ?? {});
	for (const name of ["@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/pi-mcp", "@earendil-works/pi-codemode"]) {
		expect(packages.includes(name), `缺少 ${name}`);
	}
	return json.updateAvailable ? "有新版本可升" : "已是最新";
});

await check("GET /api/sessions", async () => {
	const { json } = await call("/api/sessions");
	expect(Array.isArray(json?.sessions), "sessions 不是陣列");
	return `${json.sessions.length} 個會話`;
});

await check("GET /api/settings", async () => {
	const { json } = await call("/api/settings");
	expect(json?.compaction && typeof json.compaction.enabled === "boolean", "缺少 compaction");
	expect(json?.approval && typeof json.approval.write === "string", "缺少 approval");
	return `壓縮 ${json.compaction.enabled ? "開" : "關"} / 寫入 ${json.approval.write}`;
});

await check("GET /api/questions", async () => {
	const { json } = await call("/api/questions?sessionId=1");
	expect(Array.isArray(json?.questions), "questions 不是陣列");
	return `${json.questions.length} 個待答`;
});

await check("GET /api/approvals", async () => {
	const { json } = await call("/api/approvals?sessionId=1");
	expect(Array.isArray(json?.approvals), "approvals 不是陣列");
	return `${json.approvals.length} 個待批`;
});

await check("GET /api/custom-tools", async () => {
	const { json } = await call("/api/custom-tools");
	expect(Array.isArray(json?.tools), "tools 不是陣列");
	return `${json.tools.length} 個自定義工具`;
});

// ---- 深度：真實對話驗證工具執行鏈路 ----
let deepSessionId = null;
if (DEEP) {
	await check("POST /api/chat/stream（codemode 實跑）", async () => {
		const created = await call("/api/sessions", { method: "POST" });
		const sessionId = created.json?.id;
		deepSessionId = sessionId;
		expect(sessionId, "建會話失敗");
		const res = await fetch(`${BASE}/api/chat/stream`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ sessionId, message: "用 codemode 算 12*34，只回數字。" }),
			signal: AbortSignal.timeout(180_000),
		});
		const text = await res.text();
		expect(/event: done/.test(text), "沒有 done 事件");
		expect(/Script completed/.test(text), "codemode 沒有正常執行（迴歸？）");
		expect(/408/.test(text), "結果不對（12*34 應為 408）");
		return "codemode 正常";
	});
	// 清掉冒煙用的會話，避免在側欄堆積
	if (deepSessionId) await call(`/api/sessions?id=${deepSessionId}`, { method: "DELETE" }).catch(() => {});
}

// ---- 輸出 ----
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
	console.log(`${r.ok ? "✓" : "✗"} ${r.name.padEnd(width)}  ${r.detail}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過${failed.length ? `，${failed.length} 失敗` : ""}`);
process.exit(failed.length ? 1 : 0);
