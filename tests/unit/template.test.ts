import { describe, expect, it } from "vitest";
import { expandTemplate, hasPlaceholders } from "../../src/web/lib/template";

describe("expandTemplate", () => {
	it("無佔位符時原樣返回", () => {
		expect(expandTemplate("總結一下這段文字")).toBe("總結一下這段文字");
	});

	it("替換位置引數", () => {
		expect(expandTemplate("比較 $1 和 $2", ["Deno", "Bun"])).toBe("比較 Deno 和 Bun");
	});

	it("$@ 與 $ARGUMENTS 取全部引數", () => {
		expect(expandTemplate("調研 $@", ["A", "B"])).toBe("調研 A B");
		expect(expandTemplate("調研 $ARGUMENTS", ["A", "B"])).toBe("調研 A B");
	});

	it("缺少對應引數時保留佔位符", () => {
		expect(expandTemplate("$1 與 $2", ["只有第一個"])).toBe("只有第一個 與 $2");
	});
});

describe("hasPlaceholders", () => {
	it("識別佔位符", () => {
		expect(hasPlaceholders("$1")).toBe(true);
		expect(hasPlaceholders("$ARGUMENTS")).toBe(true);
		expect(hasPlaceholders("普通文本")).toBe(false);
	});
});
