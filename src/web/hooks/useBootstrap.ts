/**
 * useBootstrap（NERE-26）：首屏聚合的唯一讀取者。
 *
 * 按 ADR-0002 的目標分層，hooks 層擁有一個服務端資源的「讀 / 寫 / 重新整理」：
 * - 只在這裡呼叫 `api.bootstrap()`，頁面層拿到的是領域模型 + 面板錯誤；
 * - `sessionId` 變化自動重取；`refreshKey`（面板重新整理 / 重試 / 模型變更）變化也重取；
 * - 同一時刻只有最後一次請求能落地，會話切換時舊響應不會覆蓋新會話；
 * - 整體請求失敗時保留同一會話的上一份資料，只有跨會話才清空。
 */

import { useEffect, useRef, useState } from "react";
import { api, type BootstrapKey } from "../lib/api";
import { parseBootstrap, type BootstrapPanels } from "../lib/bootstrap";

export interface BootstrapState {
	/** `data` 所屬的會話；請求失敗或切換會話後、新資料到達前保持舊值。 */
	dataSessionId: string | null;
	data: BootstrapPanels | null;
	/** 後端返回的逐面板失敗摘要（鍵為面板名）。 */
	errors: Partial<Record<BootstrapKey, string>>;
	loading: boolean;
	/** 整體請求失敗（網路 / 401 / 5xx）；與逐面板錯誤分開處理。 */
	error: string | null;
}

const INITIAL_STATE: BootstrapState = {
	dataSessionId: null,
	data: null,
	errors: {},
	loading: true,
	error: null,
};

export function useBootstrap(sessionId: string, refreshKey: string | number = ""): BootstrapState {
	const [state, setState] = useState<BootstrapState>(INITIAL_STATE);
	/** 請求序號：只有最後一次發出的請求可以落地。 */
	const requestRef = useRef(0);

	useEffect(() => {
		const request = ++requestRef.current;
		let alive = true;
		setState((prev) => (prev.loading ? prev : { ...prev, loading: true }));
		void (async () => {
			try {
				const raw = await api.bootstrap(sessionId);
				if (!alive || request !== requestRef.current) return;
				const data = parseBootstrap(raw);
				setState({ dataSessionId: sessionId, data, errors: data.errors, loading: false, error: null });
			} catch (err) {
				if (!alive || request !== requestRef.current) return;
				const detail = err instanceof Error ? err.message : String(err);
				setState((prev) => ({
					...prev,
					// 同一會話的重新整理失敗保留上一份資料；跨會話失敗則清空，避免展示別的會話。
					data: prev.dataSessionId === sessionId ? prev.data : null,
					errors: {},
					loading: false,
					error: detail,
				}));
			}
		})();
		return () => {
			alive = false;
		};
	}, [sessionId, refreshKey]);

	return state;
}
