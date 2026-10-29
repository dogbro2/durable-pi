import type { WebFetchResult } from "./kb-service";

/**
 * 網頁抓取介面卡（ADR-0001 §5 的外部介面卡例外）：
 * `web_fetch_page`、`kb_ingest` 與連結匯入共用，不截斷（呼叫方決定長度）。
 *
 * 端點與金鑰全部來自 UI 設定（`toolbox`），程式碼裡沒有任何預設地址；
 * 未配置時直接返回提示，不會向任何第三方發出請求。
 */
export type WebFetchDeps = {
	apiKey: string;
	baseUrl: string;
	fetchImpl?: typeof fetch;
};

export const TOOLBOX_UNSET_MESSAGE =
	"尚未配置工具箱端點。請告訴使用者：在 設定 → 模型與工具服務 裡填寫 Base URL 與 API Key 後即可使用。";

export function createWebFetch({ apiKey, baseUrl, fetchImpl = fetch }: WebFetchDeps) {
	const base = baseUrl.trim().replace(/\/+$/, "");
	return async (url: string): Promise<WebFetchResult> => {
		if (!/^https?:\/\//i.test(url)) return { ok: false, kind: "error", message: "URL 必須以 http(s):// 開頭。" };
		if (!base || !apiKey) return { ok: false, kind: "error", message: TOOLBOX_UNSET_MESSAGE };
		try {
			const resp = await fetchImpl(`${base}/v1/tools/fetch`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({ url }),
			});
			const data = (await resp.json().catch(() => null)) as {
				title?: string;
				content?: string;
				error?: { message?: string };
			} | null;
			if (!resp.ok) {
				const msg = data?.error?.message ?? `HTTP ${resp.status}`;
				return { ok: false, kind: "error", message: `抓取失敗：${msg}` };
			}
			const title = String(data?.title ?? "").trim();
			const content = String(data?.content ?? "").trim();
			if (!content) return { ok: false, kind: "empty", message: "頁面沒有可提取的正文。" };
			return { ok: true, title, content };
		} catch (e) {
			return { ok: false, kind: "error", message: "抓取失敗：" + String(e).slice(0, 200) };
		}
	};
}