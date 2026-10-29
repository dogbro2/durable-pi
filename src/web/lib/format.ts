/** 工作臺與設定共用的格式化函式。 */

export function formatSize(size: number): string {
	if (!Number.isFinite(size) || size <= 0) return "—";
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(iso: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace("T", " ");
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 分享連結的剩餘有效期（NERE-43）：0 = 永久；已過期 → 「已過期」；其餘按天 / 小時取整。
 * 只此一份文案實現，元件不得另寫 toLocaleString 拼接。
 */
export function formatExpiry(expiresAt: number, now: number = Date.now()): string {
	if (!Number.isFinite(expiresAt) || expiresAt === 0) return "永久";
	const remaining = expiresAt - now;
	if (remaining <= 0) return "已過期";
	const hour = 3_600_000;
	if (remaining < 24 * hour) return `剩餘 ${Math.ceil(remaining / hour)} 小時`;
	return `剩餘 ${Math.ceil(remaining / (24 * hour))} 天`;
}

/** 最近一次開啟時間（NERE-43）：0 = 從未開啟；其餘複用 formatTime。 */
export function formatOpenedAt(lastOpenedAt: number): string {
	if (!Number.isFinite(lastOpenedAt) || lastOpenedAt <= 0) return "從未開啟";
	return formatTime(new Date(lastOpenedAt).toISOString());
}

/**
 * 定時任務的下次執行時間（NERE-65）：0 / 非法值不顯示。
 * 列表與 PATCH 返回值共用，避免兩處 toLocaleString 文案漂移。
 */
export function formatNextRunAt(next: number | undefined): string | undefined {
	if (typeof next !== "number" || !Number.isFinite(next) || next <= 0) return undefined;
	return new Date(next).toLocaleString("zh-TW", { hour12: false });
}

/**
 * 定時任務的上次執行時間（NERE-68）：缺失 / 非法 / 非正數一律 undefined，
 * 列表據此整行不渲染（不顯示佔位 0 或假時間）。
 */
export function formatLastRunAt(lastRunAt: number | undefined): string | undefined {
	if (typeof lastRunAt !== "number" || !Number.isFinite(lastRunAt) || lastRunAt <= 0) return undefined;
	return formatTime(new Date(lastRunAt).toISOString());
}

/**
 * 分享連結歸一化：只保留路徑，域名換成當前頁面的 origin。
 * pages.dev 反代到 Worker 時，服務端 request.url 是 workers.dev 地址，
 * 直接使用它拼連結在國內打不開（v0.38.1）。
 */
/**
 * 分享連結歸一化：只保留路徑，域名換成當前頁面的 origin。
 * pages.dev 反代到 Worker 時，服務端 request.url 是 workers.dev 地址，
 * 直接使用它拼連結在國內打不開（v0.38.1）。
 * 傳 theme 時追加 ?theme=，讓文件開啟就是當前配色（v0.44.1）。
 */
export function shareUrlFor(raw: string, origin: string, theme?: string): string {
	try {
		const url = new URL(raw, origin);
		if (theme) url.searchParams.set("theme", theme);
		return `${origin}${url.pathname}${url.search}`;
	} catch {
		return raw;
	}
}
