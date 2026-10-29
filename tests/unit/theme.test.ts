import { describe, expect, it } from "vitest";
import { THEMES, applyTheme, isThemeId, readTheme } from "../../src/web/lib/theme";

describe("主題登錄檔", () => {
	it("四套主題齊全且 id 唯一", () => {
		expect(THEMES.map((t) => t.id)).toEqual(["dark", "light", "sepia", "midnight"]);
		expect(new Set(THEMES.map((t) => t.id)).size).toBe(4);
	});

	it("每套主題都有標籤、色塊與狀態列色", () => {
		for (const theme of THEMES) {
			expect(theme.label.length).toBeGreaterThan(0);
			expect(theme.swatch).toMatch(/^#[0-9a-f]{6}$/i);
			expect(theme.color).toMatch(/^#[0-9a-f]{6}$/i);
			expect(["dark", "light"]).toContain(theme.scheme);
		}
	});

	it("isThemeId 只認已註冊的 id", () => {
		expect(isThemeId("sepia")).toBe(true);
		expect(isThemeId("dracula")).toBe(false);
	});
});

describe("主題讀寫（無 DOM 時安全降級）", () => {
	it("無法訪問 localStorage 時回落到淺色", () => {
		expect(readTheme()).toBe("light");
	});

	it("applyTheme 在無 DOM 環境不拋錯", () => {
		expect(() => applyTheme("midnight")).not.toThrow();
	});
});
