import type { RailPanel } from "../components/Rail";
import type { KbFocus } from "../types";

/**
 * 互斥彈窗狀態（NERE-62 / NERE-81）：頁面上同一時刻最多一個浮層。
 *
 * `overlay` 把「設定」與知識庫 / MCP / 技能三個面板收進一個聯合型別，避免兩個布林量
 * 各自維護、出現設定和麵板同時開啟；`kbFocus` 是知識庫定位請求（NERE-41）。
 *
 * 定位請求的生命週期必須嚴格繫結在「這一次開啟」上：ModalShell 在關閉時直接返回 null，
 * 知識庫面板會解除安裝，但 App 裡的 kbFocus 不會自己消失；重開時元件重新掛載、effect 拿到
 * 同一個舊 nonce，就會把上一次的文件再開啟一遍（NERE-75 P1-1）。
 */
export type Overlay = { kind: "panel"; id: RailPanel } | { kind: "settings" } | null;

export interface PanelState {
	overlay: Overlay;
	/** 待消費的定位請求；null = 沒有。 */
	kbFocus: KbFocus | null;
}

export const PANEL_IDLE: PanelState = { overlay: null, kbFocus: null };

/** 當前開啟的左欄面板（設定 / 沒有任何浮層時為 null）。 */
export function panelOf(state: PanelState): RailPanel | null {
	return state.overlay?.kind === "panel" ? state.overlay.id : null;
}

/** 設定彈窗是否開啟。 */
export function isSettingsOpen(state: PanelState): boolean {
	return state.overlay?.kind === "settings";
}

export type PanelEvent =
	/** 點 Rail 彈窗入口：同一個入口再點一次 = 關閉。 */
	| { type: "toggle"; panel: RailPanel }
	/** Esc / 關閉按鈕 / 開啟別的彈窗。 */
	| { type: "close" }
	/** 開啟設定彈窗（與面板彈窗互斥）。 */
	| { type: "settings" }
	/** 從訊息裡的參考資料跳進知識庫（同樣會關掉設定）。 */
	| { type: "kb-ref"; focus: KbFocus }
	/** 知識庫面板已經按定位請求開啟過文件：消費掉，避免重放。 */
	| { type: "kb-focus-consumed" };

/**
 * 彈窗狀態機：任何開啟 / 關閉都會丟棄未消費的定位；只有 `kb-ref` 會寫入定位。
 * 因此「點參考資料 A → Esc → 點 Rail 知識庫」只會停在列表，而不是又開啟文件 A。
 */
export function reducePanel(state: PanelState, event: PanelEvent): PanelState {
	switch (event.type) {
		case "toggle":
			return {
				overlay:
					state.overlay?.kind === "panel" && state.overlay.id === event.panel
						? null
						: { kind: "panel", id: event.panel },
				kbFocus: null,
			};
		case "close":
			return PANEL_IDLE;
		case "settings":
			return { overlay: { kind: "settings" }, kbFocus: null };
		case "kb-ref":
			return { overlay: { kind: "panel", id: "kb" }, kbFocus: event.focus };
		case "kb-focus-consumed":
			return state.kbFocus === null ? state : { ...state, kbFocus: null };
	}
}
