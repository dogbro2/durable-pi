/**
 * 已安裝技能的「上次使用」口徑（NERE-59）。
 *
 * 資料來自 NERE-55 的 `skill_events`：`GET /skills` 每條帶 `lastInvokedAt`（epoch ms）。
 * 三態必須區分：
 * - `undefined`：服務端沒有這個欄位 = 沒有埋點資料 → 整行不渲染（不顯示 0、不顯示「從未」）；
 * - `null`：欄位存在但沒記錄 = 裝了但從沒呼叫過 → 顯示「從未」；
 * - 數字：顯示相對時間。
 *
 * 純函式，時間由呼叫方傳入，便於單測。
 */

import type { SkillInfo } from "../types";

/** 「從未使用」超過這個天數就提示可以刪掉。 */
export const NEVER_TRIED_DAYS = 7;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 執行時徽標的短標籤：卡片窄，沿用 issue 裡的「提示詞 / JS / TS」寫法。 */
export function skillRuntimeLabel(runtime: string | undefined): string | null {
	const key = (runtime ?? "").trim().toLowerCase();
	if (!key) return null;
	if (key === "prompt") return "提示詞";
	if (key === "javascript" || key === "js") return "JS";
	if (key === "typescript" || key === "ts") return "TS";
	return runtime!.trim();
}

/**
 * 上次使用文案：`剛剛 / N 分鐘前 / N 小時前 / N 天前 / 從未`。
 * 返回 `null` 表示「沒有埋點資料」，呼叫方據此整行不渲染。
 */
export function lastUsedLabel(lastInvokedAt: number | null | undefined, now = Date.now()): string | null {
	if (lastInvokedAt === undefined) return null;
	if (lastInvokedAt === null) return "從未";
	if (!Number.isFinite(lastInvokedAt)) return null;
	const delta = now - lastInvokedAt;
	if (delta < MINUTE) return "剛剛";
	if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分鐘前`;
	if (delta < DAY) return `${Math.floor(delta / HOUR)} 小時前`;
	return `${Math.floor(delta / DAY)} 天前`;
}

/** 從未使用且已安裝滿 7 天：底部灰字提示「試試試用，或刪掉」。 */
export function shouldSuggestRemoval(
	skill: Pick<SkillInfo, "lastInvokedAt" | "createdAt">,
	now = Date.now(),
): boolean {
	if (skill.lastInvokedAt !== null) return false;
	const installedAt = Date.parse(skill.createdAt ?? "");
	if (!Number.isFinite(installedAt)) return false;
	return now - installedAt >= NEVER_TRIED_DAYS * DAY;
}
