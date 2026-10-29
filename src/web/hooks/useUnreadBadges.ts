/**
 * useUnreadBadges（NERE-74）：Rail 上分享 / 定時兩個入口的未讀圓點。
 *
 * 水位存 localStorage（見 lib/unread.ts 的判定規則），這裡只做三件事：
 * - 資料到手時種子化 / 推進水位（面板開啟時 force=true，「看過即清零」）；
 * - 面板自己拉到新資料時經 `observeShares` 推進，避免水位落後於面板；
 * - 監聽 `storage` 事件，另一個標籤頁點了面板，本標籤頁的圓點同步消失。
 *
 * 取數不在這裡做：分享清單由 useSharesSnapshot 負責（切回標籤頁會重拉），
 * 定時任務沿用 bootstrap 的資料（App 在切回標籤頁時用 panelTick 觸發重新整理）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	automationWatermark,
	browserUnreadStorage,
	countUnreadAutomations,
	countUnreadShares,
	nextWatermark,
	readWatermarks,
	shareWatermark,
	unreadKey,
	writeWatermark,
	type UnreadKind,
	type UnreadWatermarks,
} from "../lib/unread";
import type { AutomationInfo, ShareRecord } from "../types";

/** 一路未讀訊號：`ready` = 資料至少成功落地過一次（未就緒時不做種子，避免把歷史當新訊息）。 */
export interface UnreadSignal<T> {
	ready: boolean;
	items: readonly T[];
	/** 對應面板當前是否開啟：開啟時推進水位並清零。 */
	active: boolean;
}

export interface UnreadBadgesInput {
	/** 使用者作用域字首，見 lib/unread.unreadScope。 */
	scope: string;
	shares: UnreadSignal<ShareRecord>;
	automations: UnreadSignal<AutomationInfo>;
}

export interface UnreadBadges {
	shares: number;
	automations: number;
	/** 分享面板拉到資料後回撥：把水位推進到這批記錄（面板開啟時的重新整理也用）。 */
	observeShares: (items: readonly ShareRecord[]) => void;
}

export function useUnreadBadges({ scope, shares, automations }: UnreadBadgesInput): UnreadBadges {
	const storage = useMemo(browserUnreadStorage, []);
	const keys = useMemo(
		() => ({ shares: unreadKey("shares", scope), automations: unreadKey("automations", scope) }),
		[scope],
	);
	const [watermarks, setWatermarks] = useState<UnreadWatermarks>(() => readWatermarks(storage, scope));
	/** 同一幀內可能連續推進兩次（資料落地 + 面板回撥），用 ref 拿最新值。 */
	const watermarksRef = useRef(watermarks);
	watermarksRef.current = watermarks;
	/** 只在水位所屬使用者作用域變化時重讀，首次掛載不重複讀。 */
	const scopeRef = useRef(scope);

	useEffect(() => {
		if (scopeRef.current === scope) return;
		scopeRef.current = scope;
		setWatermarks(readWatermarks(storage, scope));
	}, [storage, scope]);

	/**
	 * 推進水位：沒有水位時用當前最大值做種子；有水位時只在 `force`（面板開著）且更大時前移。
	 */
	const advance = useCallback(
		(kind: UnreadKind, latest: number, force: boolean) => {
			const current = watermarksRef.current[kind];
			const next = nextWatermark(current, latest);
			if (next == null || (current != null && !force)) return;
			writeWatermark(storage, keys[kind], next);
			const updated = { ...watermarksRef.current, [kind]: next };
			watermarksRef.current = updated;
			setWatermarks(updated);
		},
		[storage, keys],
	);

	useEffect(() => {
		if (!shares.ready) return;
		advance("shares", shareWatermark(shares.items), shares.active);
	}, [advance, shares.ready, shares.items, shares.active]);

	useEffect(() => {
		if (!automations.ready) return;
		advance("automations", automationWatermark(automations.items), automations.active);
	}, [advance, automations.ready, automations.items, automations.active]);

	const observeShares = useCallback(
		(items: readonly ShareRecord[]) => {
			advance("shares", shareWatermark(items), true);
		},
		[advance],
	);

	// 多標籤頁：另一個標籤頁打開面板寫了水位 → 本頁同步清零（storage 事件只在其它標籤頁觸發）。
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onStorage = (event: StorageEvent) => {
			if (event.key !== null && event.key !== keys.shares && event.key !== keys.automations) return;
			const synced = readWatermarks(storage, scope);
			watermarksRef.current = synced;
			setWatermarks(synced);
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [storage, scope, keys]);

	return {
		// 面板正開著就不再顯示圓點：水位推進是下一幀的事，這裡先直接歸零。
		shares: shares.active ? 0 : countUnreadShares(shares.items, watermarks.shares),
		automations: automations.active ? 0 : countUnreadAutomations(automations.items, watermarks.automations),
		observeShares,
	};
}
