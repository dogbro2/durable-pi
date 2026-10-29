import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { KbRefsBar, groupByDoc } from "../../src/web/components/KbRefsBar";
import { parseEntries, parseKbRefs } from "../../src/web/lib/entries";
import { PANEL_IDLE, isSettingsOpen, panelOf, reducePanel } from "../../src/web/lib/panels";
import type { KbRef } from "../../src/web/types";

const REFS: KbRef[] = [
	{ docId: 7, chunkId: 128, chunkSeq: 2, title: "久期的含義", source: "A.md" },
	{ docId: 7, chunkId: 131, chunkSeq: 5, title: "久期的含義", source: "A.md" },
	{ docId: 9, chunkId: 12, chunkSeq: 0, title: "裝修預算清單" },
];

describe("parseKbRefs · 寬容解析（NERE-41）", () => {
	it("預設 / 非陣列 → []（老會話不報錯）", () => {
		expect(parseKbRefs(undefined)).toEqual([]);
		expect(parseKbRefs(null)).toEqual([]);
		expect(parseKbRefs([])).toEqual([]);
		expect(parseKbRefs("kbRefs")).toEqual([]);
		expect(parseKbRefs({ docId: 7 })).toEqual([]);
	});

	it("丟棄 docId 非法的項，按 docId:chunkId 去重並保持原序", () => {
		const parsed = parseKbRefs([
			{ docId: 7, chunkId: 128, chunkSeq: 2, title: "久期的含義", source: "A.md" },
			{ docId: "7", chunkId: 129, chunkSeq: 4, title: "錯型別" },
			null,
			{ docId: 7, chunkId: 128, chunkSeq: 2, title: "久期的含義" },
			42,
		]);
		expect(parsed).toEqual([{ docId: 7, chunkId: 128, chunkSeq: 2, title: "久期的含義", source: "A.md" }]);
	});

	it("parseEntries 把頂層 kbRefs 掛到 assistant 訊息；預設時不落欄位", () => {
		const [hit] = parseEntries([
			{ id: 2, kind: "pi.assistant", model: [{ content: [{ type: "text", text: "久期衡量…" }] }], kbRefs: [REFS[0]] },
		]);
		expect(hit).toMatchObject({ role: "assistant", kbRefs: [REFS[0]] });

		const [plain] = parseEntries([
			{ id: 1, kind: "pi.assistant", model: [{ content: [{ type: "text", text: "今天晴。" }] }] },
		]);
		expect(plain).not.toHaveProperty("kbRefs");
	});
});

describe("groupByDoc · 按文件聚合（NERE-41）", () => {
	it("同一 docId 的多個 chunk 只留一項，保持首次出現順序", () => {
		const groups = groupByDoc(REFS);
		expect(groups.map((group) => [group.docId, group.title, group.count])).toEqual([
			[7, "久期的含義", 2],
			[9, "裝修預算清單", 1],
		]);
		// 代表項是該文件的首個命中片段
		expect(groups[0]!.ref.chunkSeq).toBe(2);
	});
});

describe("KbRefsBar · 參考資料條（NERE-41）", () => {
	it("預設或空陣列時不渲染任何 UI", () => {
		expect(renderToStaticMarkup(<KbRefsBar refs={[]} />)).toBe("");
		expect(renderToStaticMarkup(<KbRefsBar refs={[]} onOpen={() => {}} />)).toBe("");
	});

	it("預設收起為一行「參考資料：N 篇」，N 為去重後的文件數", () => {
		const html = renderToStaticMarkup(<KbRefsBar refs={REFS} onOpen={() => {}} />);
		expect(html).toContain("參考資料：2 篇");
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("aria-controls=");
		// 收起態不渲染列表，也不偽造連結
		expect(html).not.toContain("<ul");
		expect(html).not.toContain("<a ");
	});
});

describe("知識庫定位生命週期 · 重開彈窗不重放（NERE-75 P1-1）", () => {
	const focus = { docId: 7, chunkSeq: 2, nonce: 1 };

	it("點參考資料 A → Esc → 點 Rail「知識庫」：停在列表", () => {
		const opened = reducePanel(PANEL_IDLE, { type: "kb-ref", focus });
		expect(opened).toEqual({ overlay: { kind: "panel", id: "kb" }, kbFocus: focus });
		expect(panelOf(opened)).toBe("kb");
		expect(isSettingsOpen(opened)).toBe(false);

		const closed = reducePanel(opened, { type: "close" });
		expect(closed).toEqual(PANEL_IDLE);

		const reopened = reducePanel(closed, { type: "toggle", panel: "kb" });
		expect(panelOf(reopened)).toBe("kb");
		expect(reopened.kbFocus).toBeNull();
	});

	it("消費後立即清空：即使沒有經過 close，重開也不會用舊 nonce 再開啟一次", () => {
		const opened = reducePanel(PANEL_IDLE, { type: "kb-ref", focus });
		const consumed = reducePanel(opened, { type: "kb-focus-consumed" });
		expect(consumed).toEqual({ overlay: { kind: "panel", id: "kb" }, kbFocus: null });

		expect(reducePanel(consumed, { type: "toggle", panel: "kb" })).toEqual(PANEL_IDLE);
		expect(reducePanel(consumed, { type: "close" })).toEqual(PANEL_IDLE);
	});

	it("切到別的彈窗 / 開啟設定同樣丟棄未消費的定位", () => {
		const opened = reducePanel(PANEL_IDLE, { type: "kb-ref", focus });
		expect(reducePanel(opened, { type: "toggle", panel: "mcp" })).toEqual({
			overlay: { kind: "panel", id: "mcp" },
			kbFocus: null,
		});
		expect(reducePanel(opened, { type: "settings" })).toEqual({ overlay: { kind: "settings" }, kbFocus: null });
	});

	it("設定與面板互斥（NERE-81）：定位知識庫會關掉設定，開啟設定也會關掉面板", () => {
		const settings = reducePanel(PANEL_IDLE, { type: "settings" });
		expect(isSettingsOpen(settings)).toBe(true);
		expect(panelOf(settings)).toBeNull();

		const focused = reducePanel(settings, { type: "kb-ref", focus });
		expect(isSettingsOpen(focused)).toBe(false);
		expect(panelOf(focused)).toBe("kb");

		const backToSettings = reducePanel(focused, { type: "settings" });
		expect(isSettingsOpen(backToSettings)).toBe(true);
		expect(panelOf(backToSettings)).toBeNull();
		expect(backToSettings.kbFocus).toBeNull();
	});
});
