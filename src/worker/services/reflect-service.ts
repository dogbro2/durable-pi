import * as memoryRepo from "../repo/memory-repo";
import type { SqlHandle } from "../db/migrations";

/**
 * reflect：把一段對話裡值得長期記住的事實抽出來入庫（對齊本地 pi memory 外掛的 reflect）。
 * 用一次低成本模型呼叫；解析失敗就跳過，絕不阻塞主流程。
 *
 * 外部 HTTP 介面卡在 Service 層（ADR-0001 §5 允許例外的外部介面卡），SQL 走 repo。
 */
export type ReflectDeps = {
	sql: SqlHandle;
	/** 端點與金鑰來自 UI 的工具箱設定；三者任一為空則不反思（不發任何請求）。 */
	baseUrl: string;
	apiKey: string;
	model: string;
	/** 可注入的 fetch（測試用）；預設全域性 fetch。 */
	fetchImpl?: typeof fetch;
	/** 可注入時鐘；預設當前 ISO 時間。 */
	now?: () => string;
};

export async function reflectConversation(
	{ sql, baseUrl, apiKey, model, fetchImpl = fetch, now = () => new Date().toISOString() }: ReflectDeps,
	conversationId: string,
	transcript: string,
): Promise<number> {
	const base = baseUrl.trim().replace(/\/+$/, "");
	if (!base || !apiKey || !model || transcript.trim().length < 40) return 0;
	try {
		const resp = await fetchImpl(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model,
				temperature: 0.1,
				max_tokens: 400,
				messages: [
					{
						role: "system",
						content:
							"你是記憶抽取器。從對話中抽取值得長期記住的事實（使用者身份/偏好/專案/約定），忽略寒暄與臨時內容。只輸出 JSON 陣列，每項是一句中文事實，最多 3 條；沒有就輸出 []。",
					},
					{ role: "user", content: transcript.slice(-6000) },
				],
			}),
		});
		if (!resp.ok) return 0;
		const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
		const raw = data.choices?.[0]?.message?.content ?? "";
		const match = raw.match(/\[[\s\S]*\]/);
		if (!match) return 0;
		const facts = JSON.parse(match[0]) as unknown;
		if (!Array.isArray(facts)) return 0;
		let saved = 0;
		// 去重：規範化（去空白與標點）後，新事實與已有記憶互為子串即視為重複。
		const norm = (t: string) => t.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
		const existing = memoryRepo
			.listRecentContents(sql)
			.map(norm)
			.filter((t) => t.length >= 6);
		for (const fact of facts) {
			const content = String(fact ?? "").trim().slice(0, 300);
			if (!content) continue;
			const n = norm(content);
			if (n.length < 6) continue;
			if (existing.some((e) => e.includes(n) || n.includes(e))) continue;
			memoryRepo.insertFromReflect(sql, content, now());
			existing.push(n);
			saved++;
		}
		if (saved) console.log(`reflect: ${saved} 條入庫（會話 ${conversationId}）`);
		return saved;
	} catch (err) {
		console.warn("reflect skipped", err);
		return 0;
	}
}
