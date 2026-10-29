import { describe, expect, it } from "vitest";
import { renderMarkdown, renderRichText } from "../../src/web/lib/rich";
import { findAll, tags, textOf } from "../helpers/reactText";

describe("renderMarkdown · 標題", () => {
	it("各級標題輸出語義標籤", () => {
		const out = renderMarkdown("# 一級\n\n## 二級\n\n### 三級\n\n#### 四級");
		expect(tags(out, "h1").length).toBe(1);
		expect(tags(out, "h2").length).toBe(1);
		expect(tags(out, "h3").length).toBe(1);
		expect(tags(out, "h4").length).toBe(1);
		expect(textOf(tags(out, "h2")[0])).toBe("二級");
	});
});

describe("renderMarkdown · 表格", () => {
	const md = ["| 名稱 | 數量 |", "| --- | ---: |", "| 甲 | 1 |", "| 乙 | 2 |"].join("\n");

	it("分隔行不會被當成資料行", () => {
		const out = renderMarkdown(md);
		const text = textOf(out);
		expect(text).not.toContain("---");
		expect(text).toContain("甲");
		expect(text).toContain("乙");
	});

	it("表頭與資料行數量正確", () => {
		const out = renderMarkdown(md);
		expect(tags(out, "th").length).toBe(2);
		expect(tags(out, "td").length).toBe(4);
	});

	it("右對齊標記對映為 text-align", () => {
		const out = renderMarkdown(md);
		const tds = tags(out, "td");
		expect(tds[1]?.props.style).toMatchObject({ textAlign: "right" });
	});
});

describe("renderMarkdown · 列表", () => {
	it("任務列表渲染成勾選框", () => {
		const out = renderMarkdown("- [ ] 待辦\n- [x] 已完成");
		const icons = findAll(
			out,
			(el) => typeof el.type === "function" && (el.props?.name === "checkboxOn" || el.props?.name === "checkboxOff"),
		);
		expect(icons.map((el) => el.props.name)).toEqual(["checkboxOff", "checkboxOn"]);
		expect(textOf(out)).toContain("待辦");
	});

	it("巢狀列表掛到父項下", () => {
		const out = renderMarkdown("- 外層\n  - 內層");
		expect(tags(out, "ul").length).toBe(2);
	});

	it("有序列表使用 ol", () => {
		const out = renderMarkdown("1. 第一\n2. 第二");
		expect(tags(out, "ol").length).toBe(1);
		expect(tags(out, "li").length).toBe(2);
	});
});

describe("renderMarkdown · 程式碼塊", () => {
	// CodeBlock 是函式元件，未渲染時讀不到內部文本，斷言它收到的 props
	const codeBlocks = (out: unknown[]) =>
		findAll(out, (el) => typeof el.type === "function" && typeof el.props.code === "string");

	it("攜帶語言與程式碼內容", () => {
		const out = renderMarkdown("```js\nconst a = 1;\n```");
		const blocks = codeBlocks(out);
		expect(blocks.length).toBe(1);
		expect(blocks[0]!.props.lang).toBe("js");
		expect(blocks[0]!.props.code).toBe("const a = 1;");
	});

	it("無語言時 lang 為空串（元件內回落為 text）", () => {
		const out = renderMarkdown("```\nplain\n```");
		const blocks = codeBlocks(out);
		expect(blocks.length).toBe(1);
		expect(blocks[0]!.props.lang).toBe("");
		expect(blocks[0]!.props.code).toBe("plain");
	});
});

describe("renderMarkdown · 安全", () => {
	it("HTML 標籤按純文本輸出，不產生元素", () => {
		const out = renderMarkdown('<script>alert(1)</script>');
		expect(textOf(out)).toContain("<script>");
		expect(tags(out, "script").length).toBe(0);
	});

	it("危險協議的連結不生成 a 標籤", () => {
		const out = renderRichText("[點我](javascript:alert(1))");
		expect(tags(out, "a").length).toBe(0);
		expect(textOf(out)).toContain("點我");
	});

	it("https 連結生成 a 標籤", () => {
		const out = renderRichText("[官網](https://example.com)");
		const a = tags(out, "a")[0];
		expect(a?.props.href).toBe("https://example.com");
		expect(a?.props.rel).toContain("noopener");
	});
});

describe("renderRichText · 行內", () => {
	it("粗體 / 斜體 / 刪除線 / 行內程式碼", () => {
		const out = renderRichText("**粗** *斜* ~~刪~~ `碼`");
		expect(tags(out, "strong").length).toBe(1);
		expect(tags(out, "em").length).toBe(1);
		expect(tags(out, "code").length).toBe(1);
		expect(textOf(out)).toContain("刪");
	});
});
