import { entryText, entryUsage } from "../lib/entries";

/**
 * 上下文用量（v0.42.0 / ADR-0001 §2）：最近一次模型用量 + 之後新增內容的字元估算。
 * 條目讀取由 DO 經 `entries` 注入，Service 不認識 Harness。
 */
export type ContextUsage = { usedTokens: number; contextWindow: number; percent: number; approximate: boolean };

const CONTEXT_WINDOW = 128_000;

export type ContextServiceDeps = {
	/** 會話條目（倒序返回，與 Harness 一致）。 */
	entries(sessionId?: string): Promise<readonly Record<string, unknown>[]>;
};

export function createContextService({ entries }: ContextServiceDeps) {
	return {
		async usage(sessionId?: string): Promise<ContextUsage> {
			try {
				const items = [...(await entries(sessionId))].reverse(); // 按時間正序
				let base = 0;
				let lastUsage = -1;
				for (let i = items.length - 1; i >= 0; i--) {
					const usage = entryUsage(items[i]!.model);
					if (usage != null) {
						base = usage;
						lastUsage = i;
						break;
					}
				}
				let extra = 0;
				if (lastUsage >= 0) {
					for (let i = lastUsage + 1; i < items.length; i++) extra += Math.ceil(entryText(items[i]!.model).length / 2);
				} else {
					// 還沒有模型用量：整段按字元估算（中文約 2 字元 / token）
					for (const item of items) extra += Math.ceil(entryText(item.model).length / 2);
				}
				const usedTokens = Math.max(0, base + extra);
				return {
					usedTokens,
					contextWindow: CONTEXT_WINDOW,
					percent: Math.min(100, Math.round((usedTokens / CONTEXT_WINDOW) * 100)),
					approximate: lastUsage < 0,
				};
			} catch {
				return { usedTokens: 0, contextWindow: CONTEXT_WINDOW, percent: 0, approximate: true };
			}
		},
	};
}
