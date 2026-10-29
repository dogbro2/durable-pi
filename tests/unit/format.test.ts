import { describe, expect, it } from "vitest";
import { formatSize, formatTime, shareUrlFor } from "../../src/web/lib/format";

describe("formatSize", () => {
	it("小於 1KB 顯示 B", () => {
		expect(formatSize(512)).toBe("512 B");
	});
	it("KB / MB 換算", () => {
		expect(formatSize(2048)).toBe("2.0 KB");
		expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
	});
	it("非法值顯示佔位符", () => {
		expect(formatSize(0)).toBe("—");
		expect(formatSize(Number.NaN)).toBe("—");
	});
});

describe("formatTime", () => {
	it("ISO 時間格式化為 MM-DD HH:mm", () => {
		expect(formatTime("2026-10-19T09:11:37.280Z")).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
	});
	it("空值返回空串", () => {
		expect(formatTime("")).toBe("");
	});
});

describe("shareUrlFor", () => {
	it("服務端返回 workers.dev 地址時改用當前域名", () => {
		expect(shareUrlFor("https://durable-pi.example.workers.dev/s/abc", "https://pi.example.com")).toBe(
			"https://pi.example.com/s/abc",
		);
	});
	it("相對路徑也能拼成絕對地址", () => {
		expect(shareUrlFor("/s/abc", "http://127.0.0.1:8797")).toBe("http://127.0.0.1:8797/s/abc");
	});
	it("帶上主題引數", () => {
		expect(shareUrlFor("/s/abc", "https://pi.example.com", "light")).toBe(
			"https://pi.example.com/s/abc?theme=light",
		);
	});
});
