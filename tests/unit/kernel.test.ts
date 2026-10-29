import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
};

/** 與 src/worker.ts 的 PI_PACKAGES、scripts/upgrade-pi.mjs 的 PACKAGES 保持一致。 */
const PI_PACKAGES = [
	"@earendil-works/pi-durable",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-mcp",
	"@earendil-works/pi-codemode",
];

describe("pi 核心版本（v0.35.0）", () => {
	it("四個核心包都顯式聲明瞭依賴", () => {
		for (const name of PI_PACKAGES) {
			expect(pkg.dependencies?.[name], `${name} 應出現在 dependencies`).toBeTruthy();
		}
	});

	it("核心包版本保持鎖步（同進同退）", () => {
		const versions = PI_PACKAGES.map((name) => pkg.dependencies?.[name]);
		expect(new Set(versions).size, `版本不一致：${PI_PACKAGES.map((n) => `${n}=${pkg.dependencies?.[n]}`).join(", ")}`).toBe(1);
	});

	it("提供 upgrade:pi 手動升級入口", () => {
		expect(pkg.scripts?.["upgrade:pi"]).toBeTruthy();
	});

	it("升級指令碼與自動升級工作流都在", () => {
		expect(existsSync(join(ROOT, "scripts/upgrade-pi.mjs"))).toBe(true);
		expect(existsSync(join(ROOT, ".github/workflows/pi-upgrade.yml"))).toBe(true);
	});
});
