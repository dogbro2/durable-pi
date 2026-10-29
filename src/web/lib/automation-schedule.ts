/**
 * 定時任務排程（NERE-65）：解析與文案的唯一實現。
 *
 * 後端 `automations.schedule` 存 JSON 字串（`{"kind":"daily","time":"09:00"}`），
 * 列表 / PATCH 返回可能給字串或物件——這裡統一寬容成領域模型。
 * 只做純函式，不認識元件與介面呼叫。
 */

import type { AutomationSchedule } from "../types";

export const DEFAULT_SCHEDULE: AutomationSchedule = { kind: "daily", time: "09:00" };

/** 後端建立時的兜底間隔（automation-service 的 `minutes ?? 60`）。 */
const DEFAULT_INTERVAL = 60;

const DAILY_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 編輯彈窗接受的時間：嚴格 24 小時 `HH:MM`。 */
export function isDailyTime(value: string): boolean {
	return DAILY_TIME.test(value);
}

function normalizeTime(raw: string): string | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 23 || minute > 59) return null;
	return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

/** 寬容解析：任何損壞的輸入都退回「每天 09:00」，不拋錯。 */
export function parseAutomationSchedule(raw: unknown): AutomationSchedule {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return { ...DEFAULT_SCHEDULE };
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_SCHEDULE };

	const entry = value as Record<string, unknown>;
	if (entry.kind === "interval") {
		const minutes = Math.floor(Number(entry.minutes ?? DEFAULT_INTERVAL));
		return { kind: "interval", minutes: Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_INTERVAL };
	}
	const time = typeof entry.time === "string" ? normalizeTime(entry.time) : null;
	return { kind: "daily", time: time ?? DEFAULT_SCHEDULE.time };
}

/** 列表行的人讀文案：`每天 08:03` / `每隔 5 分鐘`。 */
export function automationScheduleLabel(schedule: AutomationSchedule): string {
	return schedule.kind === "interval"
		? `每隔 ${schedule.minutes ?? DEFAULT_INTERVAL} 分鐘`
		: `每天 ${schedule.time ?? DEFAULT_SCHEDULE.time}`;
}
