import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Rail } from "../../src/web/components/Rail";
import {
	automationWatermark,
	countUnreadAutomations,
	countUnreadShares,
	nextWatermark,
	readWatermark,
	readWatermarks,
	shareWatermark,
	unreadKey,
	unreadScope,
	writeWatermark,
	type UnreadStorage,
} from "../../src/web/lib/unread";
import type { AutomationInfo, ShareRecord } from "../../src/web/types";

/** 假儲存：替代真實 localStorage，測試裡可以放心注入時間戳。 */
function memoryStorage(seed: Record<string, string> = {}): UnreadStorage & { data: Map<string, string> } {
	const data = new Map(Object.entries(seed));
	return {
		data,
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => {
			data.set(key, value);
		},
	};
}

const MINUTE = 60_000;
const T0 = 1_761_196_800_000; // 2025-10-23T00:00:00Z，按毫秒時間戳用

function share(token: string, lastOpenedAt: number, openCount = 1): ShareRecord {
	return {
		token,
		kind: "file",
		name: `${token}.md`,
		expiresAt: 0,
		createdAt: new Date(T0).toISOString(),
		openCount,
		lastOpenedAt,
		sessionId: "c-1",
		url: `/s/${token}`,
	};
}

function job(id: string, lastRunAt?: number): AutomationInfo {
	return { id, name: id, prompt: "p", scheduleLabel: "每天 09:00", enabled: true, lastRunAt };
}

describe("未讀水位：鍵與使用者作用域（NERE-74）", () => {
	it("按作用域 + 型別分鍵，字首固定", () => {
		expect(unreadKey("shares", "owner")).toBe("pi-unread:owner:shares");
		expect(unreadKey("automations", "member")).toBe("pi-unread:member:automations");
		expect(unreadKey("shares", "owner")).not.toBe(unreadKey("shares", "member"));
		expect(unreadKey("shares", "")).toBe("pi-unread:local:shares");
	});

	it("主人 / 邀請使用者落到不同作用域", () => {
		expect(unreadScope(true)).toBe("owner");
		expect(unreadScope(false)).toBe("member");
		expect(unreadScope(undefined)).toBe("member");
	});
});

describe("未讀水位：讀寫容錯", () => {
	it("寫入後讀回數字；缺失 / 空串 / 非法值一律 null", () => {
		const storage = memoryStorage();
		const key = unreadKey("shares", "owner");
		expect(readWatermark(storage, key)).toBeNull();
		writeWatermark(storage, key, T0 + MINUTE);
		expect(readWatermark(storage, key)).toBe(T0 + MINUTE);
		storage.setItem(key, "not-a-number");
		expect(readWatermark(storage, key)).toBeNull();
		storage.setItem(key, "");
		expect(readWatermark(storage, key)).toBeNull();
	});

	it("儲存不可用（私密模式 / 拋異常）時讀寫都不崩", () => {
		const broken: UnreadStorage = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		};
		expect(readWatermark(broken, "k")).toBeNull();
		expect(() => writeWatermark(broken, "k", T0)).not.toThrow();
		expect(readWatermark(null, "k")).toBeNull();
		expect(() => writeWatermark(null, "k", T0)).not.toThrow();
	});

	it("一次讀出兩路水位", () => {
		const storage = memoryStorage({
			[unreadKey("shares", "owner")]: String(T0),
			[unreadKey("automations", "owner")]: String(T0 + MINUTE),
		});
		expect(readWatermarks(storage, "owner")).toEqual({ shares: T0, automations: T0 + MINUTE });
		expect(readWatermarks(storage, "member")).toEqual({ shares: null, automations: null });
	});
});

describe("分享未讀：lastOpenedAt 嚴格大於水位", () => {
	it("水位取所有記錄裡最大的 lastOpenedAt（0 = 從未開啟）", () => {
		expect(shareWatermark([share("a", 0, 0), share("b", T0), share("c", T0 - MINUTE)])).toBe(T0);
		expect(shareWatermark([])).toBe(0);
	});

	it("新開啟的分享計數；等於水位的不算（點開面板後重新整理不再出現）", () => {
		const items = [share("a", T0), share("b", T0 - MINUTE), share("c", 0, 0)];
		expect(countUnreadShares(items, T0 - MINUTE * 2)).toBe(2);
		expect(countUnreadShares(items, T0)).toBe(0);
	});

	it("水位未知（首次使用）不補報歷史", () => {
		expect(countUnreadShares([share("a", T0)], null)).toBe(0);
	});

	it("驗收集：首次種子化 → 無痕開啟一條 → 圓點出現 → 打開面板寫水位 → 重新整理後不再出現", () => {
		const storage = memoryStorage();
		const key = unreadKey("shares", "owner");
		const before = [share("a", T0), share("b", T0 - MINUTE * 5)];

		// 第一次載入：沒有水位 → 用當前最大值做種子，不顯示圓點。
		const seeded = nextWatermark(readWatermark(storage, key), shareWatermark(before));
		expect(seeded).toBe(T0);
		writeWatermark(storage, key, seeded!);
		let items = before;
		expect(countUnreadShares(items, readWatermark(storage, key))).toBe(0);

		// 無痕視窗打開了自己的分享 → 服務端把 lastOpenedAt 推到 T0 + 1 分鐘。
		items = [share("a", T0 + MINUTE, 2), share("b", T0 - MINUTE * 5)];
		let watermark = readWatermark(storage, key);
		expect(countUnreadShares(items, watermark)).toBe(1);

		// 打開面板：水位前移到最新值並落盤（模擬重新整理後重新讀 localStorage）。
		const advanced = nextWatermark(watermark, shareWatermark(items));
		expect(advanced).toBe(T0 + MINUTE);
		writeWatermark(storage, key, advanced!);

		const afterReload = readWatermark(storage, key);
		expect(countUnreadShares(items, afterReload)).toBe(0);
	});

	it("沒有分享 / 從未被開啟：永遠不亮假紅點", () => {
		const storage = memoryStorage();
		expect(countUnreadShares([], readWatermark(storage, unreadKey("shares", "owner")))).toBe(0);
		expect(countUnreadShares([share("a", 0, 0)], 0)).toBe(0);
	});
});

describe("定時未讀：lastRunAt 嚴格大於水位", () => {
	it("水位取最大的 lastRunAt，缺失的不參與", () => {
		expect(automationWatermark([job("a"), job("b", T0), job("c", T0 - MINUTE)])).toBe(T0);
		expect(automationWatermark([job("a")])).toBe(0);
	});

	it("跑過的任務計數；等於水位的不算", () => {
		const items = [job("a", T0), job("b", T0 - MINUTE), job("c")];
		expect(countUnreadAutomations(items, T0 - MINUTE * 2)).toBe(2);
		expect(countUnreadAutomations(items, T0)).toBe(0);
		expect(countUnreadAutomations(items, null)).toBe(0);
	});

	it("同一點位覆蓋成功與失敗：只看時間推進", () => {
		const items = [{ ...job("a", T0 + MINUTE), lastStatus: "failed" as const }];
		expect(countUnreadAutomations(items, T0)).toBe(1);
	});
});

describe("水位推進", () => {
	it("沒有水位 → 用當前最大值做種子（可以是 0）", () => {
		expect(nextWatermark(null, T0)).toBe(T0);
		expect(nextWatermark(null, 0)).toBe(0);
	});

	it("只增不減：沒有新資料不寫", () => {
		expect(nextWatermark(T0, T0)).toBeNull();
		expect(nextWatermark(T0, T0 - MINUTE)).toBeNull();
		expect(nextWatermark(T0, T0 + MINUTE)).toBe(T0 + MINUTE);
	});
});

describe("Rail 未讀圓點（NERE-74）", () => {
	const railHtml = (props: { sharesUnread?: number; automationsUnread?: number; sharesAvailable?: boolean } = {}) =>
		renderToStaticMarkup(
			<Rail
				view="sessions"
				panel={null}
				onSelectView={() => {}}
				onTogglePanel={() => {}}
				onNewSession={() => {}}
				onOpenSettings={() => {}}
				sharesAvailable={props.sharesAvailable ?? true}
				sharesUnread={props.sharesUnread}
				automationsUnread={props.automationsUnread}
			/>,
		);

	it("沒有未讀時不渲染任何圓點，aria-label 保持原樣", () => {
		const html = railHtml();
		expect(html).not.toContain("data-unread-dot");
		expect(html).toContain('aria-label="分享"');
		expect(html).toContain('aria-label="定時"');
	});

	it("有未讀時渲染圓點，aria-label / title 帶上條數", () => {
		const html = railHtml({ sharesUnread: 1, automationsUnread: 2 });
		expect(html).toContain('data-unread-dot="shares"');
		expect(html).toContain('data-unread-dot="automations"');
		expect(html).toContain('aria-label="分享，1 條未讀"');
		expect(html).toContain('aria-label="定時，2 條未讀"');
		expect(html).toContain('title="分享（1 條未讀）"');
	});

	it("圓點不參與 tab 順序：沒有 tabindex，且對無障礙樹隱藏", () => {
		const html = railHtml({ sharesUnread: 3, automationsUnread: 1 });
		const dot = html.slice(html.indexOf('data-unread-dot="shares"') - 200, html.indexOf('data-unread-dot="shares"') + 50);
		expect(dot).toContain('aria-hidden="true"');
		expect(html).not.toMatch(/tabindex/i);
		// 按鈕順序保持不變：分享仍在連線之前、定時在連線之後。
		expect(html.indexOf('aria-label="知識庫"')).toBeLessThan(html.indexOf('aria-label="分享，3 條未讀"'));
		expect(html.indexOf('aria-label="分享，3 條未讀"')).toBeLessThan(html.indexOf('aria-label="連線"'));
		expect(html.indexOf('aria-label="連線"')).toBeLessThan(html.indexOf('aria-label="定時，1 條未讀"'));
	});

	it("分享介面未上線時不渲染入口，也不會漏出圓點", () => {
		const html = railHtml({ sharesUnread: 5, sharesAvailable: false });
		expect(html).not.toContain("data-unread-dot=\"shares\"");
		expect(html).not.toContain("分享");
	});
});
