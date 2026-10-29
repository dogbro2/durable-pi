/**
 * 模型供應商 fetch 包裝層（NERE-85，ADR-0001 §5.6 共享純函式）。
 *
 * pi-ai 的 openai-completions 介面卡把 `options.fetch` 直接交給 OpenAI SDK，
 * 因此這裡只需包裝 `fetch` 就能覆蓋一輪模型請求的全部 HTTP 嘗試，不用改核心：
 * - 瞬時錯誤（連線失敗、首個位元組前的流中斷、408/429/5xx、空閒超時）自動重試，
 *   最多 2 次額外嘗試，退避 500ms → 2s；
 * - 不可重試（401/403/400 等其它 4xx）原樣返回響應，由 SDK 立即報錯，不浪費配額；
 * - 空閒看門狗：從發起請求到收到首個響應位元組期間，60s 無任何位元組即中止本次嘗試，
 *   按可重試處理；
 * - 重試只發生在返回首個位元組之前，SSE 事件不會重複（NERE-85 驗收）。
 *
 * 拿到首個位元組之後的中斷不再重試：模型輸出已經進入事件流，重放會產生重複內容，
 * 這類失敗交給 runner 記為 model_error。
 */

/** 預設策略（單測按這些常量斷言）。 */
export const PROVIDER_FETCH_DEFAULTS = {
	/** 額外嘗試次數：最多 3 次嘗試。 */
	maxRetries: 2,
	/** 每次重試前的退避（毫秒），超出長度後沿用最後一項。 */
	backoffMs: [500, 2000] as readonly number[],
	/** 首個響應位元組前的空閒上限（毫秒）。 */
	idleTimeoutMs: 60_000,
} as const;

export type ProviderFetchOptions = {
	/** 實際發起請求的實現；預設全域性 `fetch`。 */
	fetchImpl?: typeof fetch;
	maxRetries?: number;
	backoffMs?: readonly number[];
	idleTimeoutMs?: number;
	/** 診斷輸出；預設 `console.warn`（一行結構化，不含金鑰）。 */
	warn?: (line: string) => void;
	/** 計時器，單測可注入。 */
	now?: () => number;
};

/**
 * 最終失敗：重試已耗盡，屬於終態錯誤。
 *
 * OpenAI SDK 會把 fetch 丟擲的異常統一包成 `APIConnectionError`，
 * 所以沒有狀態碼時 runner 的 `last_error` 裡是 SDK 的 "Connection error."；
 * 本類的分類與嘗試次數以 `console.warn` 的結構化診斷為準。
 */
export class ProviderFetchError extends Error {
	readonly attempts: number;
	readonly errorClass: string;

	constructor(attempts: number, errorClass: string) {
		super(`模型供應商請求失敗（${attempts} 次嘗試）：${errorClass}`);
		this.name = "ProviderFetchError";
		this.attempts = attempts;
		this.errorClass = errorClass;
	}
}

/** 一次嘗試的失敗分類；`errorClass` 進診斷日誌與最終錯誤。 */
class AttemptFailure extends Error {
	constructor(readonly errorClass: string) {
		super(errorClass);
		this.name = "AttemptFailure";
	}
}

class IdleTimeout extends Error {
	constructor() {
		super("idle timeout");
		this.name = "IdleTimeout";
	}
}

function abortError(signal: AbortSignal): Error {
	const err = new Error("Request aborted");
	err.name = "AbortError";
	err.cause = signal.reason;
	return err;
}

function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError(signal));
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onAbort = () => {
		clearTimeout(timer);
		reject(abortError(signal!));
	};
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, Math.max(0, ms));
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

/** 把已讀出的首個分塊接回響應體，其餘位元組繼續從原 reader 泵出。 */
function spliceFirstChunk(response: Response, reader: ReadableStreamDefaultReader<Uint8Array>, first: ReadableStreamReadResult<Uint8Array>): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			if (first.done) controller.close();
			else controller.enqueue(first.value);
		},
		async pull(controller) {
			const next = await reader.read();
			if (next.done) controller.close();
			else controller.enqueue(next.value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * 包裝一次 HTTP 嘗試：看門狗覆蓋「發起請求 → 首個響應位元組」；
 * 瞬時狀態碼丟棄響應體後拋可重試錯誤。
 */
async function attemptFetch(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	fetchImpl: typeof fetch,
	idleTimeoutMs: number,
): Promise<Response> {
	const parent = init?.signal ?? null;
	if (parent?.aborted) throw abortError(parent);
	const controller = new AbortController();
	const onAbort = () => controller.abort(parent?.reason);
	parent?.addEventListener("abort", onAbort, { once: true });

	let timedOut = false;
	const idle = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		timedOut = true;
		idle.reject(new IdleTimeout());
		controller.abort(new IdleTimeout());
	}, idleTimeoutMs);
	const cleanup = () => {
		clearTimeout(timer);
		parent?.removeEventListener("abort", onAbort);
	};

	try {
		const response = await Promise.race([
			fetchImpl(input, { ...init, signal: controller.signal }),
			idle.promise,
		]);
		if (response.status === 408 || response.status === 429 || response.status >= 500) {
			await response.body?.cancel().catch(() => {});
			throw new AttemptFailure(`http_${response.status}`);
		}
		// 無響應體或不可攜帶響應體的狀態碼：沒有位元組可等，直接交給 SDK。
		if (!response.body || response.status === 204 || response.status === 205 || response.status === 304) {
			return response;
		}
		const reader = response.body.getReader();
		let first: ReadableStreamReadResult<Uint8Array>;
		try {
			first = await Promise.race([reader.read(), idle.promise]);
		} catch (err) {
			if (err instanceof IdleTimeout || timedOut) {
				await reader.cancel().catch(() => {});
				throw new AttemptFailure("no_bytes");
			}
			if (parent?.aborted) throw abortError(parent);
			throw new AttemptFailure("stream_broken");
		}
		// 首個位元組已到：撤掉看門狗（後續停頓沿用 SDK 的預設超時語義）。
		cleanup();
		return spliceFirstChunk(response, reader, first);
	} catch (err) {
		if (parent?.aborted) throw abortError(parent);
		if (err instanceof AttemptFailure) throw err;
		if (err instanceof IdleTimeout || timedOut) {
			throw new AttemptFailure("no_bytes");
		}
		throw new AttemptFailure("connect_failed");
	} finally {
		cleanup();
	}
}

/**
 * 構造帶重試與空閒看門狗的 fetch。
 * 返回值可直接作為 pi-ai 的 `options.fetch` 注入（見 `withProviderFetch`）。
 */
export function createProviderFetch(options: ProviderFetchOptions = {}): typeof fetch {
	const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
	const maxRetries = Math.max(0, options.maxRetries ?? PROVIDER_FETCH_DEFAULTS.maxRetries);
	const backoffMs = options.backoffMs?.length ? options.backoffMs : PROVIDER_FETCH_DEFAULTS.backoffMs;
	const idleTimeoutMs = options.idleTimeoutMs ?? PROVIDER_FETCH_DEFAULTS.idleTimeoutMs;
	const warn = options.warn ?? ((line: string) => console.warn(line));
	const now = options.now ?? (() => Date.now());

	return async function providerFetch(input, init) {
		const parent = init?.signal ?? null;
		for (let attempt = 0; ; attempt++) {
			const startedAt = now();
			try {
				return await attemptFetch(input, init, fetchImpl, idleTimeoutMs);
			} catch (err) {
				if (parent?.aborted) throw abortError(parent);
				const failure = err instanceof AttemptFailure ? err : new AttemptFailure("connect_failed");
				if (attempt >= maxRetries) {
					throw new ProviderFetchError(attempt + 1, failure.errorClass);
				}
				warn(
					`[provider-fetch] retry attempt=${attempt + 1} errorClass=${failure.errorClass} elapsedMs=${Math.max(0, now() - startedAt)}`,
				);
				await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)]!, parent);
			}
		}
	};
}

/** pi-ai Provider 中與本包裝相關的方法（結構型別，不 import 核心型別）。 */
type ProviderStreams = {
	stream?: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
	streamSimple?: (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;
	fetchDeferred?: (model: unknown, handle: unknown, options?: Record<string, unknown>) => unknown;
};

/**
 * 給 pi-ai Provider 注入供應商 fetch（所有自定義供應商共用）。
 *
 * `maxRetries: 0` 顯式關掉 pi-ai 自帶的同層重試（預設已是 0），
 * 保證「最多 2 次額外嘗試」只有這一處實現，重試節奏可測。
 */
export function withProviderFetch<T extends object>(provider: T, fetchImpl: typeof fetch): T {
	const source = provider as T & ProviderStreams;
	const inject = (options: unknown): Record<string, unknown> => ({
		...((options as Record<string, unknown> | undefined) ?? {}),
		fetch: fetchImpl,
		maxRetries: 0,
	});
	const wrapped: ProviderStreams = { ...source };
	if (typeof source.stream === "function") {
		wrapped.stream = (model, context, options) => source.stream!(model, context, inject(options));
	}
	if (typeof source.streamSimple === "function") {
		wrapped.streamSimple = (model, context, options) => source.streamSimple!(model, context, inject(options));
	}
	if (typeof source.fetchDeferred === "function") {
		wrapped.fetchDeferred = (model, handle, options) => source.fetchDeferred!(model, handle, inject(options));
	}
	return wrapped as T;
}
