/**
 * 首屏聚合（NERE-23）：把 17 個只讀面板合併成一次響應。
 *
 * 這裡只做編排與容錯，不碰 SQL / Harness：
 * - 各面板的讀取函式由 SpikeAgent 傳入，與對應單端點共用同一實現；
 * - 單個面板拋錯隻影響自己的欄位（陣列 → []，其它 → null），其餘照常返回；
 * - `errors` 只放穩定碼（NERE-78），原文只進 `console.warn`，避免表名 / SQL 洩漏到響應。
 */

import { AppError } from "./http/errors";

export const BOOTSTRAP_KEYS = [
	"session",
	"entries",
	"sessions",
	"files",
	"memories",
	"approvals",
	"settings",
	"plan",
	"goal",
	"questions",
	"prompts",
	"rules",
	"customTools",
	"skills",
	"automations",
	"mcpServers",
	"models",
] as const;

export type BootstrapKey = (typeof BOOTSTRAP_KEYS)[number];

/** 陣列欄位失敗時回退空陣列；其餘欄位回退 null，前端已有的容錯解析會兜住。 */
const ARRAY_FALLBACK: Partial<Record<BootstrapKey, true>> = {
	entries: true,
	sessions: true,
	files: true,
	memories: true,
	approvals: true,
	plan: true,
	questions: true,
	prompts: true,
	rules: true,
	customTools: true,
	skills: true,
	automations: true,
	mcpServers: true,
};

export type BootstrapLoaders = { [K in BootstrapKey]: () => unknown };

/** `errors` 只暴露穩定碼；異常原文（可能帶表名 / SQL）只進服務端日誌。 */
export type BootstrapErrorCode = "internal_error" | "unavailable";

export type BootstrapPayload = { [K in BootstrapKey]: unknown } & {
	errors: Partial<Record<BootstrapKey, BootstrapErrorCode>>;
};

/** Harness 會話 / 儲存請求失敗意味著依賴暫時不可用；其餘歸為內部錯誤。 */
const UNAVAILABLE_NAMES: Record<string, true> = {
	SessionFailed: true,
	StorageRequestError: true,
};

function errorCode(err: unknown): BootstrapErrorCode {
	if (err instanceof Error && UNAVAILABLE_NAMES[err.name] === true) return "unavailable";
	if (err instanceof AppError && (err.status === 503 || err.code === "unavailable")) return "unavailable";
	return "internal_error";
}

function warnFailure(key: BootstrapKey, err: unknown): void {
	console.warn(`bootstrap panel failed: ${key}`, err);
}

export async function collectBootstrap(loaders: BootstrapLoaders): Promise<BootstrapPayload> {
	const settled = await Promise.all(
		BOOTSTRAP_KEYS.map(async (key) => {
			try {
				return { key, value: await loaders[key]() };
			} catch (err) {
				warnFailure(key, err);
				return { key, value: ARRAY_FALLBACK[key] ? [] : null, error: errorCode(err) };
			}
		}),
	);

	const payload = {} as BootstrapPayload;
	const errors: Partial<Record<BootstrapKey, BootstrapErrorCode>> = {};
	// 按固定欄位順序賦值，響應體欄位順序穩定，便於快照/體積對比。
	for (const item of settled) {
		payload[item.key] = item.value;
		if ("error" in item) errors[item.key] = item.error;
	}
	payload.errors = errors;
	return payload;
}
