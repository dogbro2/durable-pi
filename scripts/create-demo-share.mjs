#!/usr/bin/env node
/**
 * 生成公開演示用的只讀分享連結（NERE-13）。
 *
 * 只調用現有的 POST /api/share（kind=conversation / kind=file，ttlSeconds=0 表示永久），
 * 不做任何匿名寫介面，也不改鑑權模型。生成後把輸出的 /s/<token> 填到
 * wrangler.jsonc 的 DEMO_SHARE_URL，登入頁就會出現「看一個真實對話」入口。
 *
 * 用法：
 *   node scripts/create-demo-share.mjs --session 722 --file 週報-2026-10-19.md
 *   PI_BASE=https://你的域名 PI_PASSWORD=... node scripts/create-demo-share.mjs ...
 *
 * 密碼來源與 smoke 指令碼一致：環境變數 PI_PASSWORD，或 macOS 鑰匙串
 *   security find-generic-password -a durable-pi -s durable-pi-access -w
 *
 * 注意：ttlSeconds=0 會生成永久連結。執行前確認已經拿到公開演示的人工放行。
 */

import { execSync } from "node:child_process";

const BASE = (process.env.PI_BASE || "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(BASE)) {
	console.error("請設定站點：PI_BASE=https://<你的 worker 域名> node scripts/create-demo-share.mjs");
	process.exit(2);
}
const args = process.argv.slice(2);

function arg(name, fallback = "") {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function allArgs(name) {
	const out = [];
	args.forEach((value, index) => {
		if (value === `--${name}` && args[index + 1]) out.push(args[index + 1]);
	});
	return out;
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

const sessionId = arg("session");
if (!sessionId) {
	console.error("缺少 --session <會話 id>（可在 /api/sessions 裡查）");
	process.exit(2);
}
const theme = arg("theme", "light");
const files = allArgs("file");

const password = readPassword();
if (!password) {
	console.error("找不到密碼：設定 PI_PASSWORD，或在鑰匙串裡存 durable-pi-access。");
	process.exit(2);
}

let cookie = "";

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
		// 非 JSON
	}
	return { status: res.status, json, text, headers: res.headers };
}

const login = await fetch(`${BASE}/api/login`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ password }),
});
if (!login.ok) {
	console.error(`登入失敗：HTTP ${login.status}`);
	process.exit(1);
}
const setCookie = login.headers.get("set-cookie") ?? "";
if (!/pi_access=/.test(setCookie)) {
	console.error("登入成功但沒有拿到 pi_access cookie");
	process.exit(1);
}
cookie = setCookie.split(";")[0];
console.log(`已登入 ${BASE}`);

async function createShare(kind, name) {
	const res = await call("/api/share", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId, kind, ...(name ? { name } : {}), ttlSeconds: 0, theme }),
	});
	if (res.status !== 200 || !res.json?.url) {
		throw new Error(`${kind}${name ? ` ${name}` : ""} 生成失敗：${res.status} ${res.json?.error ?? res.text.slice(0, 120)}`);
	}
	return res.json;
}

const conversation = await createShare("conversation");
console.log(`對話分享：${conversation.url}`);

const fileShares = [];
for (const name of files) {
	const share = await createShare("file", name);
	fileShares.push({ name, url: share.url });
	console.log(`檔案分享：${share.url}（${name}）`);
}

const demoPath = new URL(conversation.url).pathname;
console.log("");
console.log("把下面這行寫進 wrangler.jsonc 的 vars（或部署時用 --var 傳入）：");
console.log(`  "DEMO_SHARE_URL": "${demoPath}"`);
console.log("");
console.log("提示：分享頁是 noindex、只讀快照；連結永久有效（ttlSeconds=0）。");
console.log(
	JSON.stringify(
		{ conversationUrl: conversation.url, demoShareUrl: demoPath, fileUrls: fileShares, expiresAt: conversation.expiresAt },
		null,
		2,
	),
);
