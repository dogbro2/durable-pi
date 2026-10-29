#!/usr/bin/env node
/**
 * pi 核心升級（v0.35.0）
 *
 * 查 npm 上 pi-* 四個包的最新版本 → 安裝 → 構建 → 跑金標 → 打包校驗，
 * 任何一步失敗都回滾 package.json / package-lock.json，避免半升級狀態進倉庫。
 *
 * 用法：
 *   npm run upgrade:pi            # 升級 + 全量校驗
 *   npm run upgrade:pi -- --dry-run  # 只打印將要升級的版本
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** 與 worker.ts 裡的 PI_PACKAGES 保持一致。 */
const PACKAGES = [
	"@earendil-works/pi-durable",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-mcp",
	"@earendil-works/pi-codemode",
];

const dryRun = process.argv.includes("--dry-run");

function run(command) {
	execSync(command, { stdio: "inherit", env: process.env });
}

function runQuiet(command) {
	execSync(command, { stdio: "ignore", env: process.env });
}

async function latestVersion(name) {
	const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, {
		headers: { accept: "application/json" },
	});
	if (!res.ok) throw new Error(`${name}: npm registry HTTP ${res.status}`);
	const data = await res.json();
	if (typeof data.version !== "string") throw new Error(`${name}: 響應裡沒有 version`);
	return data.version;
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const declared = pkg.dependencies ?? {};

const targets = [];
for (const name of PACKAGES) {
	const current = String(declared[name] ?? "").replace(/^[^\d]*/, "");
	const next = await latestVersion(name);
	if (!current) {
		targets.push(`${name}@${next}`);
		continue;
	}
	if (current !== next) targets.push(`${name}@${next}`);
}

if (targets.length === 0) {
	console.log("pi 核心已是最新版本。");
	process.exit(0);
}

console.log("將升級：", targets.join(" "));
if (dryRun) process.exit(0);

const backup = {
	pkg: readFileSync("package.json", "utf8"),
	lock: readFileSync("package-lock.json", "utf8"),
};

try {
	run(`npm install ${targets.join(" ")}`);
	run("npm run build:web");
	run("npm test");
	// 打包校驗：Workers 執行時沒有 Node API，這一步能抓住平臺不相容的升級
	run("npx wrangler deploy --dry-run --outdir .wrangler/upgrade-check");
	console.log("\n✅ pi 核心升級完成，構建 / 金標 / 打包校驗全部通過。");
} catch (error) {
	console.error("\n❌ 升級失敗，回滾 package.json 與 package-lock.json。", error?.message ?? "");
	writeFileSync("package.json", backup.pkg);
	writeFileSync("package-lock.json", backup.lock);
	try {
		runQuiet("npm install --ignore-scripts");
	} catch {
		console.error("回滾後重新安裝失敗，請手動執行 npm ci。");
	}
	process.exit(1);
}
