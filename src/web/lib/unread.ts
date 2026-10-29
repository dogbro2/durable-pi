/**
 * 未讀水位（NERE-74）：分享被開啟 / 定時任務跑完之後，Rail 圖示上的圓點提醒。
 *
 * 判定只比較「服務端時間戳」與「上次看過的水位」：
 * - 分享看 `lastOpenedAt`，定時任務看 `lastRunAt`；
 * - 嚴格大於水位才算未讀 —— 同一個分享再被開啟一次也能提示；
 * - 沒有水位（這臺瀏覽器第一次用）時用當前資料的最大值做種子，不補報歷史，
 *   避免一上線就常駐一個點不掉的假紅點；
 * - 打開面板即把水位推進到當前最大值並落盤，重新整理後不再出現。
 *
 * 所有讀寫都走注入的 storage，測試用假儲存 / 假時間戳即可，不依賴真實 localStorage。
 */

import type { AutomationInfo, ShareRecord } from "../types";

export type UnreadKind = "shares" | "automations";

/** localStorage 的最小讀寫子集：注入 fake 即可測，私密模式下傳 null。 */
export interface UnreadStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** 儲存鍵字首：`pi-unread:<使用者作用域>:<型別>`。 */
export const UNREAD_KEY_PREFIX = "pi-unread";

/**
 * 使用者作用域（NERE-74）：`/api/auth` 只回 owner 布林、不暴露使用者 id，且本單隻動前端，
 * 所以先按「主人 / 邀請使用者」區分。後端將來回 userId 時只改 App 裡取 scope 的那一行。
 */
export function unreadScope(isOwner: boolean | undefined): string {
	return isOwner ? "owner" : "member";
}

export function unreadKey(kind: UnreadKind, scope: string): string {
	return `${UNREAD_KEY_PREFIX}:${scope || "local"}:${kind}`;
}

/** 讀水位：缺失 / 空串 / 非數字 / 儲存不可用 → null（= 從未看過，呼叫方做種子）。 */
export function readWatermark(storage: UnreadStorage | null | undefined, key: string): number | null {
	try {
		const raw = storage?.getItem(key);
		if (raw == null || raw === "") return null;
		const value = Number(raw);
		return Number.isFinite(value) ? value : null;
	} catch {
		return null;
	}
}

/** 寫水位：私密模式 / 儲存被停用時靜默失敗（本次會話內仍然按記憶體態生效）。 */
export function writeWatermark(storage: UnreadStorage | null | undefined, key: string, value: number): void {
	try {
		storage?.setItem(key, String(value));
	} catch {
		// storage unavailable — 未讀只在本次會話內生效
	}
}

/** 一個使用者作用域下的兩路水位；null = 從未看過。 */
export interface UnreadWatermarks {
	shares: number | null;
	automations: number | null;
}

/** 一次讀出兩路水位（掛載 / 換賬號 / 其它標籤頁寫水位後同步）。 */
export function readWatermarks(storage: UnreadStorage | null | undefined, scope: string): UnreadWatermarks {
	return {
		shares: readWatermark(storage, unreadKey("shares", scope)),
		automations: readWatermark(storage, unreadKey("automations", scope)),
	};
}

/** 瀏覽器 localStorage；訪問被拒（隱私模式 / 無 window）時返回 null。 */
export function browserUnreadStorage(): UnreadStorage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

/** 分享側的最新時間戳 = 所有記錄裡最大的 `lastOpenedAt`（從未開啟為 0）。 */
export function shareWatermark(items: readonly ShareRecord[]): number {
	let latest = 0;
	for (const item of items) {
		if (Number.isFinite(item.lastOpenedAt) && item.lastOpenedAt > latest) latest = item.lastOpenedAt;
	}
	return latest;
}

/** 定時任務側的最新時間戳 = 所有任務裡最大的 `lastRunAt`（從未執行為 0）。 */
export function automationWatermark(items: readonly AutomationInfo[]): number {
	let latest = 0;
	for (const item of items) {
		if (typeof item.lastRunAt === "number" && Number.isFinite(item.lastRunAt) && item.lastRunAt > latest) latest = item.lastRunAt;
	}
	return latest;
}

/**
 * 推進水位：沒有水位時先用當前最大值做種子；有水位時只增不減。
 * 返回 null 表示「這次不需要寫」。
 */
export function nextWatermark(current: number | null, latest: number): number | null {
	if (current == null) return latest;
	return latest > current ? latest : null;
}

/** 未讀分享條數：`lastOpenedAt` 嚴格大於水位。水位未知時返回 0（先種子，不補報歷史）。 */
export function countUnreadShares(items: readonly ShareRecord[], watermark: number | null): number {
	if (watermark == null) return 0;
	return items.filter((item) => Number.isFinite(item.lastOpenedAt) && item.lastOpenedAt > watermark).length;
}

/** 未讀定時任務條數：`lastRunAt` 嚴格大於水位。 */
export function countUnreadAutomations(items: readonly AutomationInfo[], watermark: number | null): number {
	if (watermark == null) return 0;
	return items.filter((item) => typeof item.lastRunAt === "number" && Number.isFinite(item.lastRunAt) && item.lastRunAt > watermark)
		.length;
}
