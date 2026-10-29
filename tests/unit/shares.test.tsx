import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ShareRow } from "../../src/web/components/ShareRow";
import { SharesPanel } from "../../src/web/components/SharesPanel";
import { Rail } from "../../src/web/components/Rail";
import { insertAt, isAlreadyRevoked, probeSharesAvailability, revokeErrorMessage } from "../../src/web/hooks/useShares";
import { ApiError, api } from "../../src/web/lib/api";
import { parseShareRecords } from "../../src/web/lib/collections";
import { formatExpiry, formatOpenedAt } from "../../src/web/lib/format";
import type { ShareRecord } from "../../src/web/types";

/** 與契約 §2.1 一致的三條示例（2 檔案 + 1 會話）。 */
const RECORDS = [
	{
		token: "f7kqm3x9ab2c",
		kind: "file",
		name: "週報-2026-W42.md",
		expiresAt: 1761782400000,
		theme: "dark",
		createdAt: "2026-10-22T03:11:09.402Z",
		openCount: 3,
		lastOpenedAt: 1761196800000,
		sessionId: "c-9f3a1e",
		url: "/s/f7kqm3x9ab2c",
	},
	{
		token: "s2mz8qp1de4f",
		kind: "conversation",
		name: "久期是什麼",
		expiresAt: 0,
		theme: "dark",
		createdAt: "2026-10-21T22:04:51.118Z",
		openCount: 0,
		lastOpenedAt: 0,
		sessionId: "c-9f3a1e",
		url: "/s/s2mz8qp1de4f",
	},
	{
		token: "a1b2c3d4e5f6",
		kind: "file",
		name: "筆記.md",
		expiresAt: 0,
		theme: "light",
		createdAt: "2026-10-20T01:00:00.000Z",
		openCount: 1,
		lastOpenedAt: 1761100000000,
		sessionId: "c-other",
		url: "/s/a1b2c3d4e5f6",
	},
];

const FIRST: ShareRecord = parseShareRecords({ shares: [RECORDS[0]] })[0]!;
const SECOND: ShareRecord = parseShareRecords({ shares: [RECORDS[1]] })[0]!;

describe("parseShareRecords", () => {
	it("保序對映三條記錄（驗收 1）", () => {
		const records = parseShareRecords({ shares: RECORDS });
		expect(records.map((item) => item.token)).toEqual(["f7kqm3x9ab2c", "s2mz8qp1de4f", "a1b2c3d4e5f6"]);
		expect(records[0]).toMatchObject({
			kind: "file",
			name: "週報-2026-W42.md",
			expiresAt: 1761782400000,
			openCount: 3,
			lastOpenedAt: 1761196800000,
			sessionId: "c-9f3a1e",
			url: "/s/f7kqm3x9ab2c",
		});
	});

	it("非陣列 / 缺 shares 包裝 → 空陣列", () => {
		expect(parseShareRecords(null)).toEqual([]);
		expect(parseShareRecords("oops")).toEqual([]);
		expect(parseShareRecords({})).toEqual([]);
	});

	it("丟棄 token 缺失或 kind 非法的項", () => {
		const records = parseShareRecords({
			shares: [
				{ kind: "file", name: "無 token" },
				{ token: "t1", kind: "unknown" },
				{ token: "t2", kind: "file" },
			],
		});
		expect(records.map((item) => item.token)).toEqual(["t2"]);
	});

	it("name / 數字欄位 / url 缺失時給預設值", () => {
		const [record] = parseShareRecords({ shares: [{ token: "t3", kind: "conversation" }] });
		expect(record).toEqual({
			token: "t3",
			kind: "conversation",
			name: "（未命名）",
			expiresAt: 0,
			createdAt: "",
			openCount: 0,
			lastOpenedAt: 0,
			sessionId: "",
			url: "/s/t3",
		});
	});
});

describe("formatExpiry", () => {
	const NOW = 1_760_000_000_000;

	it("0 → 永久，過去 → 已過期", () => {
		expect(formatExpiry(0, NOW)).toBe("永久");
		expect(formatExpiry(NOW - 1, NOW)).toBe("已過期");
	});

	it("24 小時內按小時取整", () => {
		expect(formatExpiry(NOW + 2 * 3_600_000, NOW)).toBe("剩餘 2 小時");
		expect(formatExpiry(NOW + 30 * 60_000, NOW)).toBe("剩餘 1 小時");
	});

	it("超過 24 小時按天取整", () => {
		expect(formatExpiry(NOW + 47 * 3_600_000, NOW)).toBe("剩餘 2 天");
		expect(formatExpiry(NOW + 49 * 3_600_000, NOW)).toBe("剩餘 3 天");
	});
});

describe("formatOpenedAt", () => {
	it("0 → 從未開啟", () => {
		expect(formatOpenedAt(0)).toBe("從未開啟");
	});

	it("epoch 毫秒複用 formatTime 的展示格式", () => {
		expect(formatOpenedAt(1_761_196_800_000)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
	});
});

describe("撤銷錯誤文案", () => {
	it("403 給許可權提示", () => {
		expect(revokeErrorMessage(new ApiError(403, "forbidden"))).toBe("沒有許可權撤銷這條連結（可能不屬於當前賬號）");
	});

	it("404 視為已經撤銷", () => {
		expect(isAlreadyRevoked(new ApiError(404, "gone"))).toBe(true);
		expect(isAlreadyRevoked(new ApiError(403, "forbidden"))).toBe(false);
	});

	it("網路 / 5xx 帶上傳輸層原因", () => {
		expect(revokeErrorMessage(new ApiError(0, "網路請求失敗，請檢查服務是否在執行。"))).toBe(
			"撤銷失敗：網路請求失敗，請檢查服務是否在執行。",
		);
		expect(revokeErrorMessage(new ApiError(500, "伺服器錯誤"))).toBe("撤銷失敗：伺服器錯誤");
		expect(revokeErrorMessage(new Error("boom"))).toBe("撤銷失敗：boom");
	});
});

describe("insertAt（撤銷失敗按原索引回滾）", () => {
	it("插回原位置，保持原順序", () => {
		expect(insertAt(["a", "c"], 1, "b")).toEqual(["a", "b", "c"]);
	});

	it("索引越界時落在末尾", () => {
		expect(insertAt(["a"], 9, "b")).toEqual(["a", "b"]);
	});
});

describe("api.sharesAll / api.revokeShare", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("預設只取 active，路徑不搬進元件", async () => {
		const calls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ shares: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch);

		await api.sharesAll();
		await api.sharesAll("all");
		expect(calls).toEqual(["/api/shares/all?status=active", "/api/shares/all?status=all"]);
	});

	it("撤銷走 DELETE 並編碼 token", async () => {
		const calls: { url: string; method?: string }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), method: init?.method });
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch);

		await api.revokeShare("a/b c");
		expect(calls).toEqual([{ url: "/api/shares/a%2Fb%20c", method: "DELETE" }]);
	});
});

describe("ShareRow", () => {
	it("展示型別 / 名稱 / 開啟次數 / 最近開啟，並帶可訪問標籤", () => {
		const html = renderToStaticMarkup(
			<ShareRow record={SECOND} revoking={false} onRevoke={() => {}} />,
		);
		expect(html).toContain("會話");
		expect(html).toContain("久期是什麼");
		expect(html).toContain("永久");
		expect(html).toContain("開啟 0 次");
		expect(html).toContain("從未開啟");
		expect(html).toContain("複製分享連結 久期是什麼");
		expect(html).toContain("撤銷分享 久期是什麼");
		expect(html).not.toContain("aria-busy");
		expect(html).not.toContain('disabled=""');
	});

	it("撤銷中按鈕停用並標記 aria-busy", () => {
		const html = renderToStaticMarkup(<ShareRow record={FIRST} revoking onRevoke={() => {}} />);
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("disabled");
		expect(html).toContain("撤銷中…");
	});
});

describe("SharesPanel 三態", () => {
	it("首次渲染是 loading：3 行骨架 + aria-busy，不顯示空態", () => {
		const html = renderToStaticMarkup(<SharesPanel />);
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("重新整理分享清單");
		expect((html.match(/animate-pulse/g) ?? []).length).toBe(3);
		expect(html).not.toContain("還沒有分享連結");
	});
});

describe("分享入口能力門禁（NERE-56）", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const railHtml = (sharesAvailable: boolean) =>
		renderToStaticMarkup(
			<Rail
				view="sessions"
				panel={null}
				onSelectView={() => {}}
				onTogglePanel={() => {}}
				onNewSession={() => {}}
				onOpenSettings={() => {}}
				sharesAvailable={sharesAvailable}
			/>,
		);

	it("探測失敗（404 / 非 JSON / 網路錯誤）→ 入口不渲染", async () => {
		const failures: (() => Response | Promise<Response>)[] = [
			async () => new Response("not found", { status: 404 }),
			async () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }),
			async () => Promise.reject(new TypeError("Failed to fetch")),
		];
		for (const failure of failures) {
			vi.spyOn(globalThis, "fetch").mockImplementation(failure as typeof fetch);
			const available = await probeSharesAvailability();
			expect(available).toBe(false);
			const html = railHtml(available);
			expect(html).not.toContain("分享");
			expect(html).not.toContain("清單載入失敗");
			vi.restoreAllMocks();
		}
	});

	it("探測成功（含空清單）→ 入口渲染", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ shares: [] }), { status: 200, headers: { "content-type": "application/json" } }),
		);
		const available = await probeSharesAvailability();
		expect(available).toBe(true);
		expect(railHtml(available)).toContain("分享");
	});
});
