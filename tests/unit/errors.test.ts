import { describe, expect, it } from "vitest";
import { AppError, defaultErrorCode, errorText, toResponse } from "../../src/worker/http/errors";

describe("toResponse", () => {
	it("入參校驗失敗 400 + code + 原中文文案", async () => {
		const res = toResponse(new AppError("bad_request", 400, "引數錯誤"));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "引數錯誤", code: "bad_request" });
	});

	it("資源不存在 404 帶穩定 code", async () => {
		const res = toResponse(new AppError("not_found", 404, "not found"));
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "not found", code: "not_found" });
	});

	it("上游超時 504 帶 retryable", async () => {
		const res = toResponse(new AppError("upstream_timeout", 504, "上游超時", true));
		expect(res.status).toBe(504);
		expect(await res.json()).toEqual({ error: "上游超時", code: "upstream_timeout", retryable: true });
	});

	it("details 原樣回傳（技能審計 422）", async () => {
		const details = { audit: { status: "blocked", reasons: [{ message: "shell" }] } };
		const res = toResponse(new AppError("audit_blocked", 422, "審計未通過", false, details));
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({ error: "審計未通過", code: "audit_blocked", details });
	});

	it("相容欄位與統一欄位共存，核心欄位不被覆蓋", async () => {
		const res = toResponse(new AppError("unsupported_type", 415, "只支援 PDF"), { ok: false, error: "偽造" });
		expect(res.status).toBe(415);
		expect(await res.json()).toEqual({ ok: false, error: "只支援 PDF", code: "unsupported_type" });
	});

	it("未知異常 500 + internal_error，不把 Error 字首帶出", async () => {
		const long = "x".repeat(600);
		const err = new Error(long);
		const res = toResponse(err);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: long.slice(0, 500), code: "internal_error" });
	});
});

describe("errorText / defaultErrorCode", () => {
	it("取 message，不帶 Error: 字首，並按上限截斷", () => {
		expect(errorText(new Error("boom"), 200)).toBe("boom");
		expect(errorText(new Error("x".repeat(10)), 4)).toBe("xxxx");
		expect(errorText("plain")).toBe("plain");
	});

	it("老式端點錯誤按狀態補穩定碼", () => {
		expect(defaultErrorCode(400)).toBe("bad_request");
		expect(defaultErrorCode(404)).toBe("not_found");
		expect(defaultErrorCode(409)).toBe("conflict");
		expect(defaultErrorCode(500)).toBe("internal_error");
	});
});
