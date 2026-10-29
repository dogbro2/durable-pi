import { describe, expect, it } from "vitest";
import { demoShareToken, markdownToHtml, sharePage } from "../../src/worker/lib/share-render";

/**
 * 階段 3：`sharePage` 遷入 lib/share-render.ts 後，PR #27/#29 的三塊 DOM/CSS 必須原樣保留。
 * 這裡只釘渲染契約；API 側的行為由 tests/api/api.test.ts 的分享用例覆蓋。
 */

const META = { author: "Durable Pi", createdAt: "2026-10-22T05:00:00.000Z" };

describe("sharePage", () => {
	it("保留列印按鈕與 @media print 規則（NERE-39）", () => {
		const html = sharePage("標題", "<article class=\"article\">正文</article>", 0, "dark", "", META);
		expect(html).toContain('class="print-btn"');
		expect(html).toContain('onclick="window.print()"');
		expect(html).toContain("列印 / 存為 PDF");
		expect(html).toContain("@media print");
		expect(html).toContain(".print-btn{display:none}");
		expect(html).toContain("thead{display:table-header-group}");
		expect(html).toContain("header{position:sticky");
	});

	it("頁尾推廣出口只在配置 REPO_URL 時出現（NERE-46）", () => {
		const html = sharePage("標題", "正文", 0, "dark", "", META, false, "https://github.com/me/durable-pi");
		expect(html).toContain('class="share-cta"');
		expect(html).toContain('href="https://github.com/me/durable-pi?utm_source=share"');
		expect(html).toContain("用同樣的方式做一個");
		expect(html).toContain(".share-cta,.demo-note{display:none}");

		// 自架例項沒填 REPO_URL：不掛任何外部倉庫連結。
		const plain = sharePage("標題", "正文", 0, "dark", "", META);
		expect(plain).not.toContain('class="share-cta"');
		expect(plain).not.toContain("github.com");
	});

	it("只讀樣例橫條只給 demo token（NERE-46）", () => {
		const plain = sharePage("標題", "正文", 0, "dark", "", META);
		expect(plain).not.toContain('class="demo-note"');

		const demo = sharePage("標題", "正文", 0, "dark", "", META, true);
		expect(demo).toContain('class="demo-note"');
		expect(demo).toContain("<strong>這是隻讀樣例</strong>");
	});
});

describe("demoShareToken", () => {
	it("只認站內 /s/<token> 與 https 絕對地址", () => {
		expect(demoShareToken("/s/demo-demo-demo")).toBe("demo-demo-demo");
		expect(demoShareToken("https://pi.example.com/s/abc123")).toBe("abc123");
		expect(demoShareToken("/s/")).toBe("");
		expect(demoShareToken("javascript:alert(1)")).toBe("");
		expect(demoShareToken(undefined)).toBe("");
	});
});

describe("markdownToHtml", () => {
	it("標題收集錨點、正文轉義", () => {
		const headings: { level: number; text: string; id: string }[] = [];
		const html = markdownToHtml("# 總覽\n\n## 重複\n\n## 重複\n\n<script>x</script>", { headings });
		expect(html).toContain('<h1 id="總覽">總覽</h1>');
		expect(html).toContain('<h2 id="重複">重複</h2>');
		expect(html).toContain('<h2 id="重複-2">重複</h2>');
		expect(html).not.toContain("<script>");
		expect(headings).toHaveLength(3);
	});
});
