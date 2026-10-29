import { describe, expect, it } from "vitest";
import {
	MAX_INGEST_BYTES,
	checkIngestFile,
	checkIngestUrl,
	ingestErrorMessage,
	ingestFileKind,
	isTextKind,
	parseIngestResponse,
	titleFromFileName,
	titleFromUrl,
} from "../../src/web/lib/ingest";

describe("ingestFileKind", () => {
	it("識別四種支援格式，大小寫不敏感", () => {
		expect(ingestFileKind("手冊.pdf")).toBe("pdf");
		expect(ingestFileKind("NOTES.MD")).toBe("md");
		expect(ingestFileKind("readme.markdown")).toBe("md");
		expect(ingestFileKind("a.b.txt")).toBe("txt");
		expect(ingestFileKind("spec.DOCX")).toBe("docx");
	});

	it("壓縮包 / 無副檔名 / 只有點返回 null", () => {
		expect(ingestFileKind("archive.zip")).toBeNull();
		expect(ingestFileKind("photo.png")).toBeNull();
		expect(ingestFileKind("README")).toBeNull();
		expect(ingestFileKind("trailing.")).toBeNull();
	});

	it("只有 md / txt 能在介面未上線時走本地文本兜底", () => {
		expect(isTextKind("md")).toBe(true);
		expect(isTextKind("txt")).toBe(true);
		expect(isTextKind("pdf")).toBe(false);
		expect(isTextKind("docx")).toBe(false);
	});
});

describe("checkIngestFile", () => {
	it("接受 25MB 以內的 PDF / MD / TXT / DOCX", () => {
		expect(checkIngestFile({ name: "a.pdf", size: 10 })).toEqual({ ok: true, kind: "pdf" });
		expect(checkIngestFile({ name: "a.md", size: MAX_INGEST_BYTES })).toEqual({ ok: true, kind: "md" });
	});

	it("不支援的格式給出格式名，且不發請求（本地就返回失敗）", () => {
		const result = checkIngestFile({ name: "archive.zip", size: 1024 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("unsupported_type");
		expect(result.message).toContain(".zip");
		expect(result.message).toContain("PDF");
	});

	it("超過 25MB 時明確說超限並帶上實際大小", () => {
		const result = checkIngestFile({ name: "big.pdf", size: MAX_INGEST_BYTES + 1 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("too_large");
		expect(result.message).toContain("超過 25MB");
		expect(result.message).toContain("25.0 MB");
	});

	it("0 位元組檔案按空正文處理", () => {
		const result = checkIngestFile({ name: "empty.txt", size: 0 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("empty_content");
		expect(result.message).toContain("空的");
	});
});

describe("checkIngestUrl", () => {
	it("接受 http(s) 並去掉首尾空格", () => {
		expect(checkIngestUrl("  https://example.com/a?b=1  ")).toEqual({
			ok: true,
			url: "https://example.com/a?b=1",
		});
		expect(checkIngestUrl("http://example.com").ok).toBe(true);
	});

	it("空輸入 / 無協議 / 非 http 協議都給出可讀文案", () => {
		expect(checkIngestUrl("").ok).toBe(false);
		expect(checkIngestUrl("example.com").ok).toBe(false);
		const ftp = checkIngestUrl("ftp://example.com/file");
		expect(ftp.ok).toBe(false);
		if (!ftp.ok) expect(ftp.message).toContain("http(s)");
	});
});

describe("parseIngestResponse", () => {
	it("解析成功響應", () => {
		const result = parseIngestResponse({ ok: true, docId: "d_1", title: "季度報告", chunks: 12, chars: 48210 });
		expect(result).toEqual({ ok: true, docId: "d_1", title: "季度報告", chunks: 12, chars: 48210 });
	});

	it("容忍 ok 欄位缺失的 2xx 響應", () => {
		const result = parseIngestResponse({ doc_id: 7, title: "舊後端", chunks: "3" }, 200);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.docId).toBe("7");
		expect(result.chunks).toBe(3);
	});

	it("把契約裡的四種 code 原樣帶回，並保留服務端文案", () => {
		const result = parseIngestResponse({ ok: false, code: "too_large", message: "檔案太大啦" }, 200);
		expect(result).toEqual({ ok: false, code: "too_large", message: "檔案太大啦", unavailable: false });
	});

	it("服務端沒給 message 時按 code 補一句人話", () => {
		const result = parseIngestResponse({ ok: false, code: "empty_content" }, 200);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toBe(ingestErrorMessage("empty_content"));
		expect(result.message.length).toBeGreaterThan(0);
	});

	it("404 / 501 標記為介面未上線，交給上層決定兜底", () => {
		for (const status of [404, 405, 501]) {
			const result = parseIngestResponse({ error: "not found" }, status);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.unavailable).toBe(true);
			expect(result.code).toBe("unavailable");
		}
	});

	it("非 JSON 的 5xx 響應落到服務端錯誤，不卡在進度態", () => {
		const result = parseIngestResponse(null, 502);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("server");
		expect(result.message).toBe(ingestErrorMessage("server"));
	});

	it("相容既有的 {error} 失敗響應", () => {
		const result = parseIngestResponse({ error: "未登入" }, 401);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toBe("未登入");
		expect(result.unavailable).toBe(false);
	});
});

describe("標題兜底", () => {
	it("檔名去掉副檔名", () => {
		expect(titleFromFileName("季度報告.pdf")).toBe("季度報告");
		expect(titleFromFileName("a.b.md")).toBe("a.b");
		expect(titleFromFileName(".pdf")).toBe("未命名文件");
	});

	it("連結用域名 + 路徑兜底", () => {
		expect(titleFromUrl("https://example.com/docs/guide/")).toBe("example.com/docs/guide");
		expect(titleFromUrl("不是連結")).toBe("連結匯入");
	});
});

describe("ingestErrorMessage", () => {
	it("三種必給文案彼此不同且可指導下一步", () => {
		const messages = [ingestErrorMessage("too_large"), ingestErrorMessage("unsupported_type"), ingestErrorMessage("empty_content")];
		expect(new Set(messages).size).toBe(3);
		for (const message of messages) expect(message.length).toBeGreaterThan(8);
		expect(messages[0]).toContain("25MB");
		expect(messages[1]).toContain("PDF");
	});
});
