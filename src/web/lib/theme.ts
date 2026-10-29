/**
 * 主題（v0.25.0）：深色 / 淺色 / 米黃 / 午夜藍。
 * 調色盤取自 Arco Design（字節跳動開源設計系統）：灰階 gray-1..10 + 品牌藍 #165DFF。
 * 全部靠 CSS 變數覆蓋實現，元件無需感知。
 */

export type ThemeId = "dark" | "light" | "sepia" | "midnight";

export interface ThemeMeta {
	id: ThemeId;
	label: string;
	scheme: "dark" | "light";
	/** 瀏覽器位址列 / 狀態列顏色。 */
	color: string;
	/** 外觀選擇器裡的預覽色塊。 */
	swatch: string;
}

export const THEMES: ThemeMeta[] = [
	{ id: "dark", label: "深色", scheme: "dark", color: "#17171a", swatch: "#232324" },
	{ id: "light", label: "淺色", scheme: "light", color: "#f7f8fa", swatch: "#f7f8fa" },
	{ id: "sepia", label: "米黃", scheme: "light", color: "#fcf8ec", swatch: "#f7efd9" },
	{ id: "midnight", label: "午夜藍", scheme: "dark", color: "#0b1220", swatch: "#1a2440" },
];

export const THEME_KEY = "pi-theme";
const THEME_CLASSES = ["theme-light", "theme-sepia", "theme-midnight"];

export function isThemeId(value: string): value is ThemeId {
	return THEMES.some((t) => t.id === value);
}

/** 讀當前主題：URL 引數 > localStorage > 淺色（首次進入預設，v0.43.1）；system 按媒體查詢解析。 */
export function readTheme(): ThemeId {
	try {
		const raw = new URLSearchParams(window.location.search).get("theme") ?? localStorage.getItem(THEME_KEY) ?? "light";
		if (raw === "system") return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
		return isThemeId(raw) ? raw : "light";
	} catch {
		return "light";
	}
}

/** 應用主題：切換 html 上的 theme-* 類 + 更新 meta + 記住選擇。 */
export function applyTheme(id: ThemeId): void {
	const meta = THEMES.find((t) => t.id === id) ?? THEMES[0]!;
	try {
		const root = document.documentElement;
		for (const cls of THEME_CLASSES) root.classList.remove(cls);
		if (meta.id !== "dark") root.classList.add(`theme-${meta.id}`);
		document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", meta.scheme);
		document.querySelector('meta[name="theme-color"]')?.setAttribute("content", meta.color);
	} catch {
		// 無 DOM（測試 / SSR）時只跳過視覺部分
	}
	try {
		localStorage.setItem(THEME_KEY, meta.id);
	} catch {
		// 無 localStorage 時僅本次會話生效
	}
}
