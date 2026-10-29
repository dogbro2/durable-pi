/**
 * Harness entry 的只讀取值純函式（ADR-0001 §5 規則 6）。
 * entry 形狀來自 pi-durable 的 `model` 欄位：分享頁與會話上下文估算共用。
 */

/** 從 entry.model 裡取純文本（使用者 / 助手 / 工具結果通用）。 */
export function entryText(model: unknown): string {
	const blocks = Array.isArray(model) ? (model as { content?: unknown }[]) : [];
	for (const block of blocks) {
		const content = block?.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content.map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text?: unknown }).text ?? "") : "")).join("");
		}
	}
	return "";
}

/** 從 assistant entry 裡取本次請求的 token 用量（input + output）。 */
export function entryUsage(model: unknown): number | null {
	const blocks = Array.isArray(model) ? (model as { usage?: unknown }[]) : [];
	for (const block of blocks) {
		const usage = block?.usage as { input?: unknown; output?: unknown } | undefined;
		if (usage && typeof usage === "object") {
			return (Number(usage.input) || 0) + (Number(usage.output) || 0);
		}
	}
	return null;
}
