import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AutomationPanel } from "../../src/web/components/AutomationPanel";
import { automationOutputSessionId } from "../../src/web/lib/automation-edit";
import { parseAutomations } from "../../src/web/lib/collections";
import { formatLastRunAt } from "../../src/web/lib/format";
import type { AutomationInfo } from "../../src/web/types";

/** NERE-68 2a：列表「上次執行」只讀 last_run_at，不判斷成敗（last_status 是 2b）。 */
describe("parseAutomations · 上次執行", () => {
	it("解析 last_run_at / session_id", () => {
		const [job] = parseAutomations({
			automations: [
				{
					id: "a1",
					name: "早報",
					prompt: "總結昨天",
					schedule: '{"kind":"daily","time":"09:00"}',
					enabled: 1,
					last_run_at: 1761111000000,
					session_id: "42",
				},
			],
		});
		expect(job.lastRunAt).toBe(1761111000000);
		expect(job.sessionId).toBe("42");
	});

	it("缺失 / null / 0 / 非法值都解析為 undefined —— 列表據此整行不渲染", () => {
		const jobs = parseAutomations({
			automations: [
				{ id: "a1", name: "缺失", prompt: "p", schedule: '{"kind":"daily","time":"09:00"}', enabled: 1 },
				{ id: "a2", name: "null", prompt: "p", schedule: '{"kind":"daily","time":"09:00"}', enabled: 1, last_run_at: null },
				{ id: "a3", name: "零", prompt: "p", schedule: '{"kind":"daily","time":"09:00"}', enabled: 1, last_run_at: 0 },
				{ id: "a4", name: "非法", prompt: "p", schedule: '{"kind":"daily","time":"09:00"}', enabled: 1, last_run_at: "not-a-time" },
			],
		});
		expect(jobs.map((job) => job.lastRunAt)).toEqual([undefined, undefined, undefined, undefined]);
	});

	it("字串形式的毫秒時間也接受", () => {
		const [job] = parseAutomations({
			automations: [
				{ id: "a1", name: "早報", prompt: "p", schedule: '{"kind":"daily","time":"09:00"}', enabled: 1, last_run_at: "1761111000000" },
			],
		});
		expect(job.lastRunAt).toBe(1761111000000);
	});

	it("解析 last_status 三值；NULL / 未知 / 缺失一律 undefined（不猜狀態）", () => {
		const jobs = parseAutomations({
			automations: [
				{ id: "a1", last_status: "ok" },
				{ id: "a2", last_status: "failed" },
				{ id: "a3", last_status: "deferred" },
				{ id: "a4", last_status: null },
				{ id: "a5", last_status: "weird" },
				{ id: "a6" },
			],
		});
		expect(jobs.map((job) => job.lastStatus)).toEqual(["ok", "failed", "deferred", undefined, undefined, undefined]);
	});
});

describe("formatLastRunAt", () => {
	it("格式化為 MM-DD HH:mm", () => {
		const at = new Date(2026, 9, 22, 9, 0).getTime();
		expect(formatLastRunAt(at)).toBe("10-22 09:00");
	});

	it("缺失 / 0 / 非法值不返回文案", () => {
		expect(formatLastRunAt(undefined)).toBeUndefined();
		expect(formatLastRunAt(0)).toBeUndefined();
		expect(formatLastRunAt(Number.NaN)).toBeUndefined();
	});
});

const LAST_RUN = new Date(2026, 9, 22, 9, 0).getTime();

function job(overrides: Partial<AutomationInfo> & { id: string }): AutomationInfo {
	return { name: "任務", prompt: "提示詞", scheduleLabel: "每天 09:00", enabled: true, ...overrides };
}

function render(items: AutomationInfo[], onOpenSession?: (sessionId: string) => void): string {
	return renderToStaticMarkup(
		<AutomationPanel
			items={items}
			loading={false}
			error={null}
			onAdd={async () => true}
			onToggle={async () => true}
			onDelete={async () => true}
			onUpdate={async () => ({ ok: true })}
			onOpenSession={onOpenSession}
		/>,
	);
}

describe("AutomationPanel · 上次執行行", () => {
	it("有 last_run_at + session_id：顯示時間與「檢視產出」", () => {
		const html = render([job({ id: "a1", name: "早報", lastRunAt: LAST_RUN, sessionId: "42" })], () => {});
		expect(html).toContain("上次 10-22 09:00");
		expect(html).toContain("檢視產出");
		expect(html).toContain('aria-label="檢視 早報 上次執行的產出"');
	});

	it("沒有 last_run_at：整行不渲染", () => {
		const html = render([job({ id: "a1", name: "早報", sessionId: "42" })], () => {});
		expect(html).not.toContain("上次");
		expect(html).not.toContain("檢視產出");
	});

	it("有 last_run_at 但沒有 session_id：只顯示時間，不渲染跳轉", () => {
		const html = render([job({ id: "a1", name: "早報", lastRunAt: LAST_RUN })], () => {});
		expect(html).toContain("上次 10-22 09:00");
		expect(html).not.toContain("檢視產出");
	});

	it("沒有跳轉回調時不渲染「檢視產出」", () => {
		const html = render([job({ id: "a1", name: "早報", lastRunAt: LAST_RUN, sessionId: "42" })]);
		expect(html).toContain("上次 10-22 09:00");
		expect(html).not.toContain("檢視產出");
	});

	it("三種 last_status 的徽標文案與色板各不相同", () => {
		const ok = render([job({ id: "a1", name: "早報", lastRunAt: LAST_RUN, lastStatus: "ok" })]);
		const failed = render([job({ id: "a1", name: "早報", lastRunAt: LAST_RUN, lastStatus: "failed" })]);
		const deferred = render([job({ id: "a1", name: "早報", lastRunAt: LAST_RUN, lastStatus: "deferred" })]);
		expect(ok).toContain("成功");
		expect(ok).toContain("text-emerald-300");
		expect(failed).toContain("失敗");
		expect(failed).toContain("text-rose-300");
		expect(deferred).toContain("順延");
		expect(deferred).toContain("text-amber-300");
		expect(new Set([ok, failed, deferred]).size).toBe(3);
	});

	it("last_status 缺失 / 未知：不渲染徽標", () => {
		const html = render([job({ id: "a1", name: "早報", lastRunAt: LAST_RUN })]);
		expect(html).not.toContain("成功");
		expect(html).not.toContain("失敗");
		expect(html).not.toContain("順延");
	});

	it("順延不改 last_run_at：顯示上一次時間 + 順延徽標", () => {
		const html = render([job({ id: "a1", name: "早報", lastRunAt: LAST_RUN, lastStatus: "deferred", sessionId: "42" })], () => {});
		expect(html).toContain("上次 10-22 09:00");
		expect(html).toContain("順延");
		expect(html).toContain("檢視產出");
	});

	it("尚未執行但本輪順延：沒有時間也渲染順延徽標", () => {
		const html = render([job({ id: "a1", name: "早報", lastStatus: "deferred", sessionId: "42" })], () => {});
		expect(html).toContain("上次執行");
		expect(html).toContain("順延");
		expect(html).not.toContain("檢視產出");
	});
});

describe("失敗原因摘要（NERE-86 驗收 1）", () => {
	it("failed + last_error：顯示截斷摘要，title 保留全文", () => {
		const error = `reason:model_error / detail: Connection error ${"x".repeat(200)}`;
		const html = render([job({ id: "a1", name: "早報", lastRunAt: LAST_RUN, lastStatus: "failed", lastError: error })]);
		expect(html).toContain("reason:model_error");
		expect(html).toContain("…");
		expect(html).toContain(`title="${error}"`);
	});

	it("成功：即使帶了 last_error 也不顯示", () => {
		const html = render([job({ id: "a1", name: "早報", lastRunAt: LAST_RUN, lastStatus: "ok", lastError: "boom" })]);
		expect(html).not.toContain("boom");
	});

	it("failed 但沒有 last_error：只有徽標，不渲染空摘要", () => {
		const html = render([job({ id: "a1", name: "早報", lastRunAt: LAST_RUN, lastStatus: "failed" })]);
		expect(html).toContain("失敗");
		expect(html).not.toContain("text-rose-400/80");
	});
});

describe("檢視產出目標（NERE-86 驗收 2）", () => {
	it("優先 last_session_id（最近一次執行實際用的會話）", () => {
		expect(automationOutputSessionId({ lastSessionId: "4890", sessionId: "2991" })).toBe("4890");
	});

	it("老資料回落到 session_id", () => {
		expect(automationOutputSessionId({ sessionId: "2991" })).toBe("2991");
	});

	it("都沒有時返回 undefined", () => {
		expect(automationOutputSessionId({})).toBeUndefined();
	});

	it("只有 last_session_id 的任務也渲染「檢視產出」", () => {
		const html = render([job({ id: "a1", name: "早報", lastRunAt: LAST_RUN, lastSessionId: "4890" })], () => {});
		expect(html).toContain("檢視產出");
	});
});
