/**
 * 定時任務編輯（NERE-65）：表單草稿、校驗、PATCH 載荷與返回值合併。
 *
 * 全部是純函式，元件只負責渲染與狀態；這樣「回填 / 非法輸入 / 儲存載荷 / 取消不改」
 * 都能在 node 環境直接單測（倉庫沒有 DOM 測試環境）。
 * 介面契約見 NERE-64：PATCH /api/automations 欄位均可選，非法 → 400 `{error}`。
 */

import type { AutomationInfo, AutomationPatch, AutomationSchedule } from "../types";
import { DEFAULT_SCHEDULE, automationScheduleLabel, isDailyTime, parseAutomationSchedule } from "./automation-schedule";
import { isObject, pickFreshSession, pickString } from "./collections";
import { formatNextRunAt } from "./format";

/** 與後端 create 一致：name 1–40、prompt 1–2000（按 UTF-16 長度截斷）。 */
export const AUTOMATION_NAME_MAX = 40;
export const AUTOMATION_PROMPT_MAX = 2000;

export type AutomationDraft = {
	name: string;
	prompt: string;
	kind: "daily" | "interval";
	/** daily 的 `HH:MM`；切換 kind 時保留，切回來不丟。 */
	time: string;
	/** interval 的分鐘數，輸入框保持字串。 */
	minutes: string;
	sessionId: string;
	/** 每輪新建會話（NERE-84）：開關預設開，避免歷史上下文越滾越大。 */
	freshSession: boolean;
};

export type AutomationDraftField = "name" | "prompt" | "time" | "minutes";

/** 校驗後的可提交值（已 trim）。 */
export type AutomationDraftValue = {
	name: string;
	prompt: string;
	schedule: AutomationSchedule;
	sessionId: string;
	freshSession: boolean;
};

export type DraftValidation =
	| { ok: true; value: AutomationDraftValue }
	| { ok: false; field: AutomationDraftField; error: string };

/** 從列表行生成草稿（開啟彈窗即回填當前值）。 */
export function draftFromJob(job: AutomationInfo, fallbackSessionId = ""): AutomationDraft {
	const schedule = job.schedule ?? DEFAULT_SCHEDULE;
	return {
		name: job.name,
		prompt: job.prompt,
		kind: schedule.kind,
		time: schedule.kind === "daily" ? (schedule.time ?? "09:00") : "09:00",
		minutes: String(schedule.kind === "interval" ? (schedule.minutes ?? 60) : 60),
		sessionId: job.sessionId ?? fallbackSessionId,
		// NERE-86：存量任務顯示服務端當前值；老服務端沒有該欄位時按產品預設「開」。
		freshSession: job.freshSession ?? true,
	};
}

/** 前端先攔：空名稱 / 空提示詞 / 非法時間 / 非法間隔，文案直接可展示。 */
export function validateAutomationDraft(draft: AutomationDraft): DraftValidation {
	const name = draft.name.trim();
	if (!name) return { ok: false, field: "name", error: "名稱不能為空。" };
	if (name.length > AUTOMATION_NAME_MAX) {
		return { ok: false, field: "name", error: `名稱不能超過 ${AUTOMATION_NAME_MAX} 個字元。` };
	}

	const prompt = draft.prompt.trim();
	if (!prompt) return { ok: false, field: "prompt", error: "提示詞不能為空。" };
	if (prompt.length > AUTOMATION_PROMPT_MAX) {
		return { ok: false, field: "prompt", error: `提示詞不能超過 ${AUTOMATION_PROMPT_MAX} 個字元。` };
	}

	const sessionId = draft.sessionId.trim();
	if (draft.kind === "interval") {
		const minutes = Number(draft.minutes);
		if (!Number.isInteger(minutes) || minutes < 1) {
			return { ok: false, field: "minutes", error: "間隔分鐘需為不小於 1 的整數。" };
		}
		return {
			ok: true,
			value: { name, prompt, sessionId, freshSession: draft.freshSession, schedule: { kind: "interval", minutes } },
		};
	}

	const time = draft.time.trim();
	if (!isDailyTime(time)) return { ok: false, field: "time", error: "執行時間需為 HH:MM（00:00–23:59）。" };
	return {
		ok: true,
		value: { name, prompt, sessionId, freshSession: draft.freshSession, schedule: { kind: "daily", time } },
	};
}

/** 組裝 PATCH 載荷。enabled 原樣帶回：編輯不改啟停，也避免舊後端把預設值當 false。 */
export function buildAutomationPatch(
	job: Pick<AutomationInfo, "id" | "enabled">,
	value: AutomationDraftValue,
): AutomationPatch {
	return {
		id: job.id,
		name: value.name,
		prompt: value.prompt,
		schedule: value.schedule,
		sessionId: value.sessionId,
		enabled: job.enabled,
		// NERE-86：後端契約欄位是 snake_case，整表單每次全量提交，開關也隨之往返。
		fresh_session: value.freshSession,
	};
}

export type SaveAutomationResult =
	| { ok: true; patch: AutomationPatch }
	| { ok: false; error: string; field?: AutomationDraftField };

/**
 * 儲存流程：先校驗（不合法不發請求），再調 `save`。
 * 失敗時返回可直接展示的文案，呼叫方保留輸入。
 */
export async function submitAutomationDraft(
	job: Pick<AutomationInfo, "id" | "enabled">,
	draft: AutomationDraft,
	save: (patch: AutomationPatch) => Promise<{ ok: boolean; error?: string }>,
): Promise<SaveAutomationResult> {
	const validation = validateAutomationDraft(draft);
	if (!validation.ok) return { ok: false, error: validation.error, field: validation.field };
	const patch = buildAutomationPatch(job, validation.value);
	const result = await save(patch);
	return result.ok ? { ok: true, patch } : { ok: false, error: result.error?.trim() || "儲存失敗，請重試。" };
}

/** PATCH 返回的 `automation`：欄位可能只給更新過的部分，解析成可合併的增量。 */
export type AutomationUpdate = {
	id: string;
	name?: string;
	prompt?: string;
	schedule?: AutomationSchedule;
	sessionId?: string;
	enabled?: boolean;
	nextRunAt?: number;
	/** 每輪新建會話（NERE-86）：PATCH 返回後即時回填，不必等下次重新整理。 */
	freshSession?: boolean;
	/** 最近一次執行會話（NERE-86）：服務端隨 automation 檢視返回。 */
	lastSessionId?: string;
};

/** 寬容解析 PATCH 返回值（含 NERE-86 的 fresh_session / last_session_id）。 */
export function parseAutomationUpdate(raw: unknown): AutomationUpdate | null {
	if (!isObject(raw)) return null;
	const id = pickString(raw, ["id"]);
	if (!id) return null;

	const update: AutomationUpdate = { id };
	const name = pickString(raw, ["name"]);
	if (name) update.name = name;
	if (typeof raw.prompt === "string") update.prompt = raw.prompt;
	if (raw.schedule !== undefined && raw.schedule !== null) update.schedule = parseAutomationSchedule(raw.schedule);
	const sessionId = pickString(raw, ["session_id", "sessionId"]);
	if (sessionId) update.sessionId = sessionId;
	if (typeof raw.enabled === "boolean") update.enabled = raw.enabled;
	else if (typeof raw.enabled === "number") update.enabled = raw.enabled !== 0;
	const next = typeof raw.next_run_at === "number" ? raw.next_run_at : raw.nextRunAt;
	if (typeof next === "number") update.nextRunAt = next;
	const freshSession = pickFreshSession(raw);
	if (freshSession !== undefined) update.freshSession = freshSession;
	const lastSessionId = pickString(raw, ["last_session_id", "lastSessionId"]);
	if (lastSessionId) update.lastSessionId = lastSessionId;
	return update;
}

/** 把 PATCH 返回值落到列表項：保持順序，未返回的欄位沿用舊值。 */
export function mergeAutomationUpdate(items: AutomationInfo[], update: AutomationUpdate): AutomationInfo[] {
	let matched = false;
	const next = items.map((item) => {
		if (item.id !== update.id) return item;
		matched = true;
		return {
			...item,
			...(update.name !== undefined ? { name: update.name } : {}),
			...(update.prompt !== undefined ? { prompt: update.prompt } : {}),
			...(update.sessionId !== undefined ? { sessionId: update.sessionId } : {}),
			...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
			...(update.schedule !== undefined
				? { schedule: update.schedule, scheduleLabel: automationScheduleLabel(update.schedule) }
				: {}),
			...(update.nextRunAt !== undefined ? { nextLabel: formatNextRunAt(update.nextRunAt) } : {}),
			...(update.freshSession !== undefined ? { freshSession: update.freshSession } : {}),
			...(update.lastSessionId !== undefined ? { lastSessionId: update.lastSessionId } : {}),
		};
	});
	return matched ? next : items;
}

/**
 * 「檢視產出」的跳轉目標（NERE-86）：優先最近一次執行實際用的會話 `last_session_id`，
 * 老資料 / 尚未執行過時回落到任務繫結的 `session_id`（向後相容）。
 */
export function automationOutputSessionId(
	job: Pick<AutomationInfo, "lastSessionId" | "sessionId">,
): string | undefined {
	return job.lastSessionId || job.sessionId || undefined;
}
