/**
 * useShares（NERE-43）：分享清單的唯一讀取者。
 *
 * - 掛載時只發一次 `api.sharesAll()`；切換會話、panelTick 變化都不重取，只有 reload() 再發。
 * - 撤銷是樂觀更新：先移出清單，失敗按原索引插回；404 視為成功，403 / 網路錯誤給行級文案。
 * - 不做輪詢：開啟次數是快照，重新整理由面板頭部的手動按鈕觸發。
 * - 能力門禁（NERE-56）：useSharesAvailable 探測 `/api/shares/all`，失敗即視為未上線，入口不渲染。
 * - 未讀訊號（NERE-74）：App 改用 useSharesSnapshot，同一次請求兼做能力探測與未讀計算。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { parseShareRecords } from "../lib/collections";
import type { ShareRecord } from "../types";

export interface SharesState {
	items: ShareRecord[];
	status: "idle" | "loading" | "ready" | "error";
	/** 整體載入失敗文案（面板級）。 */
	error: string | null;
	/** 行級動作反饋：撤銷失敗時給具體原因。 */
	actionError: string | null;
	/** 正在撤銷的 token，用於停用按鈕 + aria-busy。 */
	revoking: ReadonlySet<string>;
	reload: () => void;
	revoke: (token: string) => Promise<void>;
	/** 關掉行級錯誤提示（面板上的 ×）。 */
	clearActionError: () => void;
}

/** 撤銷失敗文案：403 單獨給許可權提示，其餘帶上傳輸層原因。 */
export function revokeErrorMessage(err: unknown): string {
	if (err instanceof ApiError && err.status === 403) return "沒有許可權撤銷這條連結（可能不屬於當前賬號）";
	const detail = err instanceof Error && err.message ? err.message : "未知錯誤";
	return `撤銷失敗：${detail}`;
}

/** 404 說明連結本來就不在了，按成功處理。 */
export function isAlreadyRevoked(err: unknown): boolean {
	return err instanceof ApiError && err.status === 404;
}

/** 按原索引插回一行（撤銷失敗回滾）：索引越界時落在末尾。 */
export function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
	return [...list.slice(0, index), item, ...list.slice(index)];
}

/**
 * 分享能力探測（NERE-56）：`/api/shares/all` 成功（含空清單）才算已上線。
 * 404 / 非 JSON / 網路錯誤一律返回 false —— 這類失敗是「能力還沒釋出」，不是清單載入失敗，
 * 不能走到面板的 error 態文案。
 */
export async function probeSharesAvailability(load: () => Promise<unknown> = () => api.sharesAll()): Promise<boolean> {
	try {
		await load();
		return true;
	} catch {
		return false;
	}
}

/**
 * 分享入口的能力門禁（NERE-56）：只探測一次，結果落地前保持 false（入口不渲染）。
 * enabled 用來等登入態確定後再發請求；StrictMode 重跑 effect 也複用同一次探測。
 */
export function useSharesAvailable(enabled: boolean): boolean {
	const [available, setAvailable] = useState(false);
	/** 探測 promise：同一掛載週期只發一次請求。 */
	const probeRef = useRef<Promise<boolean> | null>(null);

	useEffect(() => {
		if (!enabled) return;
		let live = true;
		probeRef.current ??= probeSharesAvailability();
		void probeRef.current.then((ok) => {
			if (live) setAvailable(ok);
		});
		return () => {
			live = false;
		};
	}, [enabled]);

	return available;
}

/** 分享清單快照（NERE-74）：Rail 未讀圓點用的輕量讀數，面板本身仍走 useShares。 */
export interface SharesSnapshot {
	/** NERE-56 能力門禁：`/api/shares/all` 成功過就是 true，之後失敗也不收回。 */
	available: boolean;
	/** 最近一次成功拉到的清單；失敗時保留上一份。 */
	items: ShareRecord[];
	/** 是否至少成功拉取過一次：未就緒時不做未讀水位種子，避免把歷史當成新開啟。 */
	ready: boolean;
}

/**
 * 分享清單快照（NERE-74）：一次請求同時充當 NERE-56 的能力探測，省掉啟動時的重複呼叫。
 *
 * - 登入態確定後拉一次；
 * - 切回標籤頁 / 視窗重新聚焦時再拉一次 —— 無痕窗口裡開啟自己的分享後，
 *   回到應用就能立刻看到新的未讀（也是「下次切回標籤時重新整理」的落點）；
 * - 後續拉取失敗不清空上一份，入口也不會因為一次網路錯誤消失。
 */
export function useSharesSnapshot(enabled: boolean): SharesSnapshot {
	const [state, setState] = useState<SharesSnapshot>({ available: false, items: [], ready: false });
	/** 請求序號：只有最後一次請求能落地。 */
	const requestRef = useRef(0);
	/** StrictMode 會把 effect 跑兩遍：同一登入週期只允許首發一次。 */
	const startedRef = useRef(false);

	const load = useCallback(async () => {
		const request = ++requestRef.current;
		try {
			const records = parseShareRecords(await api.sharesAll());
			if (request !== requestRef.current) return;
			setState({ available: true, items: records, ready: true });
		} catch {
			if (request !== requestRef.current) return;
			// 第一次失敗 = 介面未上線（入口不渲染）；之後的失敗保留上一份資料。
			setState((prev) => (prev.available ? prev : { ...prev, ready: false }));
		}
	}, []);

	useEffect(() => {
		if (!enabled) {
			startedRef.current = false;
			return;
		}
		if (!startedRef.current) {
			startedRef.current = true;
			void load();
		}
		const onVisible = () => {
			if (document.visibilityState === "visible") void load();
		};
		document.addEventListener("visibilitychange", onVisible);
		window.addEventListener("focus", onVisible);
		return () => {
			document.removeEventListener("visibilitychange", onVisible);
			window.removeEventListener("focus", onVisible);
		};
	}, [enabled, load]);

	return state;
}

export function useShares(): SharesState {
	const [items, setItemsState] = useState<ShareRecord[]>([]);
	const [status, setStatus] = useState<SharesState["status"]>("idle");
	const [error, setError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [revoking, setRevoking] = useState<ReadonlySet<string>>(() => new Set());
	/** items 的同步副本：撤銷回滾要按原索引插回，等不到下一幀 state。 */
	const itemsRef = useRef<ShareRecord[]>([]);
	/** 請求序號：只有最後一次請求能落地。 */
	const requestRef = useRef(0);
	/** StrictMode 會把 effect 跑兩遍：同一掛載週期只允許首發一次請求。 */
	const startedRef = useRef(false);

	const commit = useCallback((next: ShareRecord[]) => {
		itemsRef.current = next;
		setItemsState(next);
	}, []);

	const load = useCallback(async () => {
		const request = ++requestRef.current;
		setStatus("loading");
		setError(null);
		try {
			const records = parseShareRecords(await api.sharesAll());
			if (request !== requestRef.current) return;
			commit(records);
			setStatus("ready");
		} catch (err) {
			if (request !== requestRef.current) return;
			setError(err instanceof Error && err.message ? err.message : "未知錯誤");
			setStatus("error");
		}
	}, [commit]);

	const reload = useCallback(() => {
		void load();
	}, [load]);

	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;
		void load();
	}, [load]);

	const revoke = useCallback(
		async (token: string) => {
			const index = itemsRef.current.findIndex((item) => item.token === token);
			if (index < 0) return;
			const removed = itemsRef.current[index]!;
			setActionError(null);
			commit([...itemsRef.current.slice(0, index), ...itemsRef.current.slice(index + 1)]);
			setRevoking((prev) => new Set(prev).add(token));
			try {
				await api.revokeShare(token);
			} catch (err) {
				if (isAlreadyRevoked(err)) return;
				if (!itemsRef.current.some((item) => item.token === token)) {
					commit(insertAt(itemsRef.current, index, removed));
				}
				setActionError(revokeErrorMessage(err));
			} finally {
				setRevoking((prev) => {
					const next = new Set(prev);
					next.delete(token);
					return next;
				});
			}
		},
		[commit],
	);

	const clearActionError = useCallback(() => setActionError(null), []);

	return { items, status, error, actionError, revoking, reload, revoke, clearActionError };
}
