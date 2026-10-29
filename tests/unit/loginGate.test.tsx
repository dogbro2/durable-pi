import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginGate } from "../../src/web/components/LoginGate";

const noop = async () => {};

describe("LoginGate · 公開演示入口（NERE-13）", () => {
	it("配置 demoUrl 時在登入表單下方渲染「看一個真實對話」", () => {
		const html = renderToStaticMarkup(<LoginGate onSubmit={noop} error={null} demoUrl="/s/demo-token" />);
		expect(html).toContain("請輸入訪問密碼或邀請碼");
		expect(html).toContain("看一個真實對話");
		expect(html).toContain("免登入 · 只讀分享頁");
		expect(html).toContain('href="/s/demo-token"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
	});

	it("未配置 demoUrl 時不渲染演示入口，不留死鏈", () => {
		const html = renderToStaticMarkup(<LoginGate onSubmit={noop} error={null} />);
		expect(html).not.toContain("看一個真實對話");
		expect(html).not.toContain("只讀分享頁");
	});
});
