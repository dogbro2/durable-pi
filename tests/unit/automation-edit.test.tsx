import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationEditDialog } from "../../src/web/components/AutomationEditDialog";
import { AutomationPanel } from "../../src/web/components/AutomationPanel";
import {
	buildAutomationPatch,
	draftFromJob,
	mergeAutomationUpdate,
	parseAutomationUpdate,
	submitAutomationDraft,
	validateAutomationDraft,
	type AutomationDraft,
} from "../../src/web/lib/automation-edit";
import { automationScheduleLabel, parseAutomationSchedule } from "../../src/web/lib/automation-schedule";
import { parseAutomations } from "../../src/web/lib/collections";
import type { AutomationInfo } from "../../src/web/types";

const noop = () => {};

const JOB: AutomationInfo = {
	id: "a-1",
	name: "每日科技日報",
	prompt: "彙總昨天的科技新聞，按主題分組。",
	scheduleLabel: "每天 08:03",
	enabled: true,
	schedule: { kind: "daily", time: "08:03" },
	sessionId: "2991",
};

const INTERVAL_JOB: AutomationInfo = {
	...JOB,
	id: "a-2",
	name: "巡檢",
	prompt: "檢查服務狀態",
	scheduleLabel: "每隔 5 分鐘",
	schedule: { kind: "interval", minutes: 5 },
};

function draft(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
	return { ...draftFromJob(JOB), ...overrides };
}

describe("排程解析與文案（NERE-65）", () => {
	it("JSON 字串 / 物件都接受，時間補零", () => {
		expect(parseAutomationSchedule('{"kind":"daily","time":"8:03"}')).toEqual({ kind: "daily", time: "08:03" });
		expect(parseAutomationSchedule({ kind: "daily", time: "23:59" })).toEqual({ kind: "daily", time: "23:59" });
	});

	it("損壞 / 缺失 / 非法時間退回每天 09:00", () => {
		expect(parseAutomationSchedule("not json")).toEqual({ kind: "daily", time: "09:00" });
		expect(parseAutomationSchedule(null)).toEqual({ kind: "daily", time: "09:00" });
		expect(parseAutomationSchedule({ kind: "daily", time: "24:00" })).toEqual({ kind: "daily", time: "09:00" });
	});

	it("interval 的 minutes 非法時退回 60", () => {
		expect(parseAutomationSchedule({ kind: "interval", minutes: 5 })).toEqual({ kind: "interval", minutes: 5 });
		expect(parseAutomationSchedule({ kind: "interval", minutes: 0 })).toEqual({ kind: "interval", minutes: 60 });
		expect(parseAutomationSchedule('{"kind":"interval"}')).toEqual({ kind: "interval", minutes: 60 });
	});

	it("文案只有一份實現", () => {
		expect(automationScheduleLabel({ kind: "daily", time: "08:03" })).toBe("每天 08:03");
		expect(automationScheduleLabel({ kind: "interval", minutes: 5 })).toBe("每隔 5 分鐘");
	});
});

describe("列表解析保留編輯所需欄位（NERE-65）", () => {
	it("schedule / session_id 進入領域模型，文案仍由同一函式生成", () => {
		const [job] = parseAutomations({
			automations: [
				{
					id: "a9",
					name: "早報",
					prompt: "總結昨天",
					schedule: '{"kind":"daily","time":"08:03"}',
					session_id: "2991",
					next_run_at: 0,
					enabled: 1,
				},
			],
		});
		expect(job).toMatchObject({
			id: "a9",
			schedule: { kind: "daily", time: "08:03" },
			scheduleLabel: "每天 08:03",
			sessionId: "2991",
			enabled: true,
			nextLabel: undefined,
		});
	});

	it("壞排程不拋錯：退回每天 09:00", () => {
		const [job] = parseAutomations({ automations: [{ id: "a1", name: "x", prompt: "y", schedule: "{oops" }] });
		expect(job?.scheduleLabel).toBe("每天 09:00");
	});

	it("last_session_id / fresh_session 相容 snake_case，缺失不誤讀為關閉（NERE-86）", () => {
		const jobs = parseAutomations({
			automations: [
				{ id: "a1", last_session_id: "4890", fresh_session: true },
				{ id: "a2", lastSessionId: "42", freshSession: false },
				{ id: "a3", fresh_session: 0 },
				{ id: "a4" },
			],
		});
		expect(jobs.map((job) => job.lastSessionId)).toEqual(["4890", "42", undefined, undefined]);
		expect(jobs.map((job) => job.freshSession)).toEqual([true, false, false, undefined]);
	});
});

describe("開啟彈窗回填（NERE-65 驗收 1）", () => {
	it("daily：名稱 / 提示詞 / 時間 / 會話全部回填", () => {
		expect(draftFromJob(JOB)).toEqual({
			name: "每日科技日報",
			prompt: "彙總昨天的科技新聞，按主題分組。",
			kind: "daily",
			time: "08:03",
			minutes: "60",
			sessionId: "2991",
			freshSession: true,
		});
	});

	it("每輪新建會話：存量任務回填服務端當前值，缺失按預設開（NERE-86）", () => {
		expect(draftFromJob({ ...JOB, freshSession: false }).freshSession).toBe(false);
		expect(draftFromJob({ ...JOB, freshSession: undefined }).freshSession).toBe(true);
	});

	it("interval：kind 與 minutes 回填", () => {
		const value = draftFromJob(INTERVAL_JOB);
		expect(value.kind).toBe("interval");
		expect(value.minutes).toBe("5");
	});

	it("任務沒有 sessionId 時用當前會話兜底", () => {
		expect(draftFromJob({ ...JOB, sessionId: undefined }, "session-current").sessionId).toBe("session-current");
	});
});

describe("前端先攔非法輸入（NERE-65 驗收 4）", () => {
	it("空名稱 / 超長名稱", () => {
		expect(validateAutomationDraft(draft({ name: "   " }))).toEqual({ ok: false, field: "name", error: "名稱不能為空。" });
		const long = validateAutomationDraft(draft({ name: "x".repeat(41) }));
		expect(long.ok).toBe(false);
		if (!long.ok) expect(long.error).toContain("40");
	});

	it("空提示詞 / 超長提示詞", () => {
		expect(validateAutomationDraft(draft({ prompt: "" }))).toEqual({
			ok: false,
			field: "prompt",
			error: "提示詞不能為空。",
		});
		const long = validateAutomationDraft(draft({ prompt: "x".repeat(2001) }));
		expect(long.ok).toBe(false);
		if (!long.ok) expect(long.error).toContain("2000");
	});

	it("非法時間：24:00 / 9:5 / 空", () => {
		for (const time of ["24:00", "9:5", "", "12:60"]) {
			const result = validateAutomationDraft(draft({ time }));
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.field).toBe("time");
		}
	});

	it("interval 非法分鐘：0 / 小數 / 空", () => {
		for (const minutes of ["0", "1.5", "", "-3"]) {
			const result = validateAutomationDraft(draft({ kind: "interval", minutes }));
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.field).toBe("minutes");
		}
	});

	it("合法輸入 trim 後通過，載荷形狀與 NERE-64 契約一致", () => {
		const result = validateAutomationDraft(draft({ name: "  新名字  ", prompt: "  新提示  ", sessionId: " 2991 " }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(buildAutomationPatch(JOB, result.value)).toEqual({
			id: "a-1",
			name: "新名字",
			prompt: "新提示",
			schedule: { kind: "daily", time: "08:03" },
			sessionId: "2991",
			enabled: true,
			fresh_session: true,
		});
	});

	it("開關關閉時 PATCH 帶 fresh_session=false（NERE-86 往返）", () => {
		const result = validateAutomationDraft(draft({ freshSession: false }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(buildAutomationPatch(JOB, result.value).fresh_session).toBe(false);
	});

	it("切換為 interval 時載荷只帶 minutes", () => {
		const result = validateAutomationDraft(draft({ kind: "interval", minutes: "15" }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.schedule).toEqual({ kind: "interval", minutes: 15 });
	});
});

describe("儲存流程（NERE-65 驗收 3 / 4）", () => {
	it("非法輸入不發請求，錯誤文案可直接展示", async () => {
		const save = vi.fn(async () => ({ ok: true }));
		const result = await submitAutomationDraft(JOB, draft({ name: "" }), save);
		expect(save).not.toHaveBeenCalled();
		expect(result).toEqual({ ok: false, error: "名稱不能為空。", field: "name" });
	});

	it("合法輸入只發一次 PATCH，載荷是校驗後的值", async () => {
		const save = vi.fn(async () => ({ ok: true }));
		const result = await submitAutomationDraft(JOB, draft({ name: "改名" }), save);
		expect(save).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledWith({
			id: "a-1",
			name: "改名",
			prompt: JOB.prompt,
			schedule: { kind: "daily", time: "08:03" },
			sessionId: "2991",
			enabled: true,
			fresh_session: true,
		});
		expect(result.ok).toBe(true);
	});

	it("後端失敗：返回錯誤文案，輸入由呼叫方保留", async () => {
		const result = await submitAutomationDraft(JOB, draft(), async () => ({ ok: false, error: "prompt 超長" }));
		expect(result).toEqual({ ok: false, error: "prompt 超長" });
	});

	it("後端失敗但沒有文案：給通用兜底", async () => {
		const result = await submitAutomationDraft(JOB, draft(), async () => ({ ok: false }));
		expect(result).toEqual({ ok: false, error: "儲存失敗，請重試。" });
	});
});

describe("PATCH 返回值落地列表（NERE-65 驗收 3）", () => {
	it("寬容解析 snake_case / 字串 schedule", () => {
		expect(
			parseAutomationUpdate({
				id: "a-1",
				name: "新名字",
				prompt: "新提示",
				schedule: '{"kind":"interval","minutes":15}',
				session_id: "7",
				enabled: 0,
				next_run_at: 1761782400000,
			}),
		).toEqual({
			id: "a-1",
			name: "新名字",
			prompt: "新提示",
			schedule: { kind: "interval", minutes: 15 },
			sessionId: "7",
			enabled: false,
			nextRunAt: 1761782400000,
		});
	});

	it("缺少 id 的返回值不參與合併", () => {
		expect(parseAutomationUpdate({ name: "x" })).toBeNull();
		expect(parseAutomationUpdate(null)).toBeNull();
	});

	it("fresh_session / last_session_id 進入增量併合並回列表（NERE-86）", () => {
		const update = parseAutomationUpdate({ id: "a-1", fresh_session: false, last_session_id: "4890" });
		expect(update).toEqual({ id: "a-1", freshSession: false, lastSessionId: "4890" });
		const [merged] = mergeAutomationUpdate([JOB], update!);
		expect(merged.freshSession).toBe(false);
		expect(merged.lastSessionId).toBe("4890");
	});

	it("響應缺少 fresh_session 時不覆蓋列表舊值", () => {
		const update = parseAutomationUpdate({ id: "a-1", name: "新名字" });
		expect(update?.freshSession).toBeUndefined();
		expect(mergeAutomationUpdate([{ ...JOB, freshSession: false }], update!)[0].freshSession).toBe(false);
	});

	it("只更新返回的欄位，順序與其它任務不變", () => {
		const before = [JOB, INTERVAL_JOB];
		const after = mergeAutomationUpdate(before, {
			id: JOB.id,
			name: "每日科技日報（新版）",
			schedule: { kind: "interval", minutes: 30 },
			nextRunAt: 1761782400000,
		});
		expect(after.map((job) => job.id)).toEqual(["a-1", "a-2"]);
		expect(after[0]).toMatchObject({
			name: "每日科技日報（新版）",
			prompt: JOB.prompt,
			enabled: true,
			schedule: { kind: "interval", minutes: 30 },
			scheduleLabel: "每隔 30 分鐘",
			sessionId: "2991",
		});
		expect(after[0]?.nextLabel).toBeTruthy();
		expect(after[1]).toBe(INTERVAL_JOB);
	});

	it("id 不在列表裡時原樣返回，不新增幽靈行", () => {
		const before = [JOB];
		expect(mergeAutomationUpdate(before, { id: "missing", name: "x" })).toBe(before);
	});
});

describe("彈窗 SSR 標記（NERE-65 交付 2）", () => {
	function render(job: AutomationInfo = JOB) {
		return renderToStaticMarkup(
			<AutomationEditDialog job={job} defaultSessionId="2991" onClose={noop} onSave={async () => ({ ok: true })} />,
		);
	}

	it("開啟即回填：名稱 / 提示詞 / 時間 / 會話", () => {
		const html = render();
		expect(html).toContain('role="dialog"');
		expect(html).toContain('data-testid="automation-edit-modal"');
		expect(html).toContain("編輯定時任務");
		expect(html).toContain('value="每日科技日報"');
		expect(html).toContain(JOB.prompt);
		expect(html).toContain('value="08:03"');
		expect(html).toContain('value="2991"');
		expect(html).toContain("取消");
		expect(html).toContain("儲存");
	});

	it("daily 選中「每天」，interval 選中「每隔」並回填分鐘", () => {
		expect(render()).toMatch(/<option value="daily" selected="">每天<\/option>/);
		const interval = render(INTERVAL_JOB);
		expect(interval).toMatch(/<option value="interval" selected="">每隔<\/option>/);
		expect(interval).toContain('value="5"');
	});

	it("欄位上限寫在控制元件上", () => {
		const html = render();
		expect(html).toContain('maxLength="40"');
		expect(html).toContain('maxLength="2000"');
	});

	it("「每次執行用新會話」開關回填當前值，缺失按預設開（NERE-86）", () => {
		const on = render();
		expect(on).toContain('role="switch"');
		expect(on).toContain('aria-label="每次執行用新會話"');
		expect(on).toContain('aria-checked="true"');
		expect(on).toContain("開啟後每輪新建空會話執行");
		expect(render({ ...JOB, freshSession: false })).toContain('aria-checked="false"');
	});
});

describe("列表編輯入口（NERE-65 交付 1）", () => {
	it("每行「編輯」與啟停 / 刪除並列，帶 aria-label", () => {
		const html = renderToStaticMarkup(
			<AutomationPanel
				items={[JOB, INTERVAL_JOB]}
				loading={false}
				error={null}
				onAdd={async () => true}
				onToggle={async () => true}
				onDelete={async () => true}
				onUpdate={async () => ({ ok: true })}
				defaultSessionId="2991"
			/>,
		);
		expect(html).toContain('aria-label="編輯 每日科技日報"');
		expect(html).toContain('aria-label="編輯 巡檢"');
		expect(html).toContain('aria-label="暫停 每日科技日報"');
		expect(html).toContain('aria-label="刪除 巡檢"');
		// 彈窗按任務掛載：預設不開啟，列表頁不出現 dialog。
		expect(html).not.toContain('role="dialog"');
	});
});
