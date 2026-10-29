/**
 * HTTP 語義錯誤（ADR-0001 §9.3）：Route/Service 拋 AppError，由 dispatch 統一對映為
 * `{ error, code, details?, retryable? }`（NERE-79）；未知異常保持 500 + 截斷原文。
 * 相容欄位（`/kb/ingest` 的 ok/message、`/skills/import` 的 installed）由 `toResponse` 的
 * 第二個引數附加，不另寫響應體對映。
 */
export class AppError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
		readonly retryable = false,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "AppError";
	}
}

/** 只帶 HTTP 狀態的老式端點錯誤：沒有顯式 code 時按狀態補一個穩定碼。 */
export function defaultErrorCode(status: number): string {
	switch (status) {
		case 400:
			return "bad_request";
		case 404:
			return "not_found";
		case 409:
			return "conflict";
		case 413:
			return "too_large";
		case 415:
			return "unsupported_type";
		case 422:
			return "unprocessable";
		case 429:
			return "rate_limited";
		default:
			return status >= 500 ? "internal_error" : "bad_request";
	}
}

/** 未知異常的可回傳文案：優先 message，避免把 `Error: ` 字首和堆疊帶進響應體。 */
export function errorText(err: unknown, max = 200): string {
	const text = err instanceof Error ? err.message || err.name : String(err);
	return text.slice(0, max);
}

/**
 * 統一錯誤響應：AppError → 自身 status + `{ error, code }`（retryable/details 有則帶）；
 * 未知異常 → 500 + `{ error, code: "internal_error" }`。
 * `extra` 只用於契約相容欄位，核心欄位始終以錯誤物件為準。
 */
export function toResponse(err: unknown, extra?: Record<string, unknown>): Response {
	if (!(err instanceof AppError)) {
		return Response.json({ ...extra, error: errorText(err, 500), code: "internal_error" }, { status: 500 });
	}
	const body: Record<string, unknown> = { ...extra, error: err.message, code: err.code };
	if (err.retryable) body.retryable = true;
	if (err.details) body.details = err.details;
	return Response.json(body, { status: err.status });
}
