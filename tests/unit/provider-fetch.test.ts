import { describe, expect, it, vi } from "vitest";
import {
	createProviderFetch,
	PROVIDER_FETCH_DEFAULTS,
	ProviderFetchError,
	withProviderFetch,
} from "../../src/worker/lib/provider-fetch";

/**
 * NERE-85 驗收：provider fetch 層重試 + 空閒看門狗。
 * 全部用例都跑真實的 fetch/ReadableStream 語義，只有上游實現是假的。
 */

function body(text: string): Response {
	const bytes = new TextEncoder().encode(text);
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/** 永遠不發位元組的響應：看門狗必須把它砍掉。 */
function neverBytes(): Response {
	return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function networkError(message = "Connection error"): typeof fetch {
	return (async () => {
		throw new TypeError(message);
	}) as typeof fetch;
}

describe("provider fetch 重試與空閒看門狗（NERE-85）", () => {
	it("預設策略：最多 2 次額外嘗試，退避 500ms → 2s，看門狗 60s", () => {
		expect(PROVIDER_FETCH_DEFAULTS).toMatchObject({ maxRetries: 2, backoffMs: [500, 2000], idleTimeoutMs: 60_000 });
	});

	it("首次連線失敗、第二次成功：一輪完成，只有一條結構化 warn（不含金鑰）", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			if (calls === 1) throw new TypeError("Connection error");
			return body("data: hello\n\n");
		}) as typeof fetch;
		const warn = vi.fn();
		const guarded = createProviderFetch({ fetchImpl, backoffMs: [1], warn });

		const res = await guarded("https://api.example/v1/chat/completions", {
			method: "POST",
			headers: { authorization: "Bearer sk-secret" },
		});

		expect(calls).toBe(2);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("data: hello\n\n");
		expect(warn).toHaveBeenCalledTimes(1);
		const line = warn.mock.calls[0]![0] as string;
		expect(line).toMatch(/^\[provider-fetch\] retry attempt=1 errorClass=connect_failed elapsedMs=\d+$/);
		expect(line).not.toContain("sk-secret");
	});

	it("上游一直連不上：3 次嘗試後失敗，總耗時≈退避之和", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			throw new TypeError("fetch failed");
		}) as typeof fetch;
		const warn = vi.fn();
		const guarded = createProviderFetch({ fetchImpl, backoffMs: [20, 40], warn });

		const startedAt = Date.now();
		const error = await guarded("https://api.example/v1/chat/completions").catch((err: unknown) => err);
		const elapsed = Date.now() - startedAt;

		expect(calls).toBe(3);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(error).toBeInstanceOf(ProviderFetchError);
		expect((error as ProviderFetchError).attempts).toBe(3);
		expect((error as Error).name).toBe("ProviderFetchError");
		expect((error as Error).message).toBe("模型供應商請求失敗（3 次嘗試）：connect_failed");
		expect(elapsed).toBeGreaterThanOrEqual(55);
	});

	it("401/403/400 立即失敗，0 次重試", async () => {
		for (const status of [400, 401, 403]) {
			let calls = 0;
			const fetchImpl = (async () => {
				calls += 1;
				return new Response("nope", { status });
			}) as typeof fetch;
			const warn = vi.fn();
			const res = await createProviderFetch({ fetchImpl, backoffMs: [1], warn })("https://api.example/v1/chat/completions");

			expect(res.status).toBe(status);
			expect(await res.text()).toBe("nope");
			expect(calls).toBe(1);
			expect(warn).not.toHaveBeenCalled();
		}
	});

	it("429 / 5xx 視為瞬時：丟棄失敗響應體後重試", async () => {
		for (const [status, errorClass] of [[429, "http_429"], [503, "http_503"]] as const) {
			let calls = 0;
			let cancelled = false;
			const fetchImpl = (async () => {
				calls += 1;
				if (calls > 1) return body("data: recovered\n\n");
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("busy"));
						},
						cancel() {
							cancelled = true;
						},
					}),
					{ status },
				);
			}) as typeof fetch;
			const warn = vi.fn();
			const res = await createProviderFetch({ fetchImpl, backoffMs: [1], warn })("https://api.example/v1/chat/completions");

			expect(await res.text()).toBe("data: recovered\n\n");
			expect(calls).toBe(2);
			expect(cancelled).toBe(true);
			expect(warn.mock.calls[0]?.[0]).toContain(`errorClass=${errorClass}`);
		}
	});

	it("空閒看門狗：60s 無位元組中止本次嘗試並按可重試處理", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			return calls === 1 ? neverBytes() : body("data: late\n\n");
		}) as typeof fetch;
		const warn = vi.fn();
		const guarded = createProviderFetch({ fetchImpl, backoffMs: [1], idleTimeoutMs: 30, warn });

		const startedAt = Date.now();
		const res = await guarded("https://api.example/v1/chat/completions");

		expect(await res.text()).toBe("data: late\n\n");
		expect(calls).toBe(2);
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
		expect(warn.mock.calls[0]?.[0]).toMatch(/errorClass=no_bytes/);
	});

	it("首個位元組之後斷流不重試：SSE 事件不重複", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			const encoder = new TextEncoder();
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode("data: partial\n\n"));
					},
					// 首批位元組交付之後才斷流：必須原樣報錯，不能重放。
					pull(controller) {
						controller.error(new Error("terminated"));
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof fetch;
		const warn = vi.fn();
		const res = await createProviderFetch({ fetchImpl, backoffMs: [1], warn })("https://api.example/v1/chat/completions");

		await expect(res.text()).rejects.toThrow(/terminated/);
		expect(calls).toBe(1);
		expect(warn).not.toHaveBeenCalled();
	});

	it("外部 signal 中止：立即拋 AbortError，不重試", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchImpl = vi.fn(networkError()) as unknown as typeof fetch;
		const warn = vi.fn();

		await expect(
			createProviderFetch({ fetchImpl, backoffMs: [1], warn })("https://api.example/v1/chat/completions", { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it("withProviderFetch：注入 fetch、關閉核心自帶重試、保留 provider 其它能力", () => {
		const seen: Record<string, unknown>[] = [];
		const guarded = createProviderFetch({ fetchImpl: networkError(), backoffMs: [1] });
		const provider = {
			id: "deepseek",
			name: "DeepSeek",
			getModels: () => [{ id: "deepseek-chat" }],
			stream: (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
				seen.push(options ?? {});
				return { kicked: true };
			},
			streamSimple: (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
				seen.push(options ?? {});
				return { simple: true };
			},
			fetchDeferred: (_model: unknown, _handle: unknown, options?: Record<string, unknown>) => {
				seen.push(options ?? {});
				return { deferred: true };
			},
		};

		const wrapped = withProviderFetch(provider, guarded);
		expect(wrapped.id).toBe("deepseek");
		expect(wrapped.getModels()).toEqual([{ id: "deepseek-chat" }]);
		expect(wrapped.stream({}, {})).toEqual({ kicked: true });
		expect(wrapped.streamSimple({}, {}, { signal: "s" })).toEqual({ simple: true });
		expect(wrapped.fetchDeferred({}, {})).toEqual({ deferred: true });

		expect(seen).toHaveLength(3);
		for (const options of seen) {
			expect(options.fetch).toBe(guarded);
			expect(options.maxRetries).toBe(0);
		}
		expect(seen[1]!.signal).toBe("s");
	});
});
