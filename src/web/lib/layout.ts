import type { RailView } from "../components/Rail";

/** 左欄展開偏好（桌面端）。值用 saveBool 的 "1" / "0" 編碼。 */
// localStorage 鍵沿用舊名前綴：改了會讓既有使用者的面板狀態被重置。
export const LEFT_OPEN_KEY = "pi-harness.left-open";

/**
 * 點 Rail 的左欄內容入口（NERE-75 P1-3）。
 *
 * 桌面端：收起狀態下點「定時 / 檔案 / 分享」這些內容入口，說明使用者想看左欄，
 * 必須同時把 leftOpen 置 true 並寫回偏好，否則點了沒有任何反饋。
 * 移動端：Rail 不渲染，直接忽略。
 */
export function selectRailView(
	isDesktop: boolean,
	openLeft: (open: boolean) => void,
	save: (key: string, value: boolean) => void,
): void {
	if (!isDesktop) return;
	openLeft(true);
	save(LEFT_OPEN_KEY, true);
}

/**
 * 生效的左欄檢視（NERE-81）：邀請使用者看不到「使用者」面板，分享介面未上線時「分享」也不成立，
 * 兩種情況都回落到會話列表。Rail、未讀圓點與左欄寬度都必須讀這個值，而不是 `railView`。
 */
export function effectiveRailView(
	view: RailView,
	options: { owner: boolean; sharesAvailable: boolean },
): RailView {
	if (view === "users" && !options.owner) return "sessions";
	if (view === "shares" && !options.sharesAvailable) return "sessions";
	return view;
}

/** 左欄寬度（NERE-81）：會話列表按使用者拖拽值；其它面板內容更寬，至少 300px。 */
export function leftPaneWidth(view: RailView, width: number): number {
	return view === "sessions" ? width : Math.max(width, 300);
}
