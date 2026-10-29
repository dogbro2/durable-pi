import { AppError, errorText, toResponse } from "../http/errors";
import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { createKbService, KbIngestError, KB_VECTOR_BATCH, type KbService } from "../services/kb-service";

/** 知識庫路由（ADR-0001 §1）：解析與狀態碼，編排在 kb-service，SQL 在 kb-repo。 */
function service(ctx: RequestContext): KbService {
	return createKbService({
		sql: ctx.sql(),
		env: ctx.env,
		scopeId: ctx.scopeId,
		settings: ctx.settings,
		webFetch: ctx.webFetch,
	});
}

/**
 * ingest 保留 `{ ok:false, code, message }` 相容欄位（一個版本），並新增統一欄位
 * `error` / `details`；狀態碼與舊實現一致（NERE-79）。
 */
function ingestFailure(err: unknown): Response {
	if (!(err instanceof KbIngestError)) throw err;
	return toResponse(err, { ok: false, message: err.message });
}

export const kbRoutes: readonly Route[] = [
	{
		method: "GET",
		path: "/kb",
		needsHarness: false,
		handle: async (ctx) => Response.json({ docs: service(ctx).listDocs() }),
	},
	{
		method: "POST",
		path: "/kb",
		needsHarness: false,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as {
				title?: string;
				content?: string;
				source?: string;
				tags?: string;
			};
			const title = String(body.title ?? "").trim().slice(0, 120);
			const content = String(body.content ?? "").trim();
			if (!title || !content) throw new AppError("bad_request", 400, "標題和正文都不能為空");
			const result = await service(ctx).addIndexed({
				title,
				content,
				source: String(body.source ?? "").trim().slice(0, 300),
				tags: String(body.tags ?? "").trim().slice(0, 120),
			});
			return Response.json({ ok: true, ...result });
		},
	},
	// 知識庫匯入（v0.56.0）：multipart 檔案或 JSON {url}
	{
		method: "POST",
		path: "/kb/ingest",
		needsHarness: false,
		handle: async (ctx) => {
			const contentType = (ctx.req.headers.get("content-type") ?? "").toLowerCase();
			try {
				if (contentType.includes("application/json")) {
					const body = (await ctx.req.json().catch(() => null)) as { url?: unknown } | null;
					return Response.json(await service(ctx).ingestUrl(body?.url));
				}
				if (!contentType.includes("multipart/form-data")) {
					throw new KbIngestError(415, "unsupported_type", "請用 multipart/form-data 上傳檔案，或用 application/json 傳 {url}。");
				}
				let form: FormData;
				try {
					form = await ctx.req.formData();
				} catch {
					throw new KbIngestError(415, "unsupported_type", "上傳內容不是有效的 multipart/form-data。");
				}
				return Response.json(await service(ctx).ingestFile(form.get("file")));
			} catch (err) {
				return ingestFailure(err);
			}
		},
	},
	{
		method: "GET",
		path: "/kb/doc",
		needsHarness: false,
		handle: async (ctx) => {
			const id = Number(ctx.url.searchParams.get("id") ?? 0);
			const doc = service(ctx).getDoc(id);
			if (!doc) throw new AppError("not_found", 404, "文件不存在");
			return Response.json(doc);
		},
	},
	{
		method: "GET",
		path: "/kb/search",
		needsHarness: false,
		handle: async (ctx) => {
			const q = ctx.url.searchParams.get("q") ?? "";
			if (!q.trim()) return Response.json({ hits: [] });
			return Response.json({ hits: await service(ctx).searchAsync(q, Number(ctx.url.searchParams.get("limit") ?? 8)) });
		},
	},
	// 預檢索預覽（v0.46.0）：返回本輪會注入 instructions 的原文，便於排查
	{
		method: "GET",
		path: "/kb/prefetch",
		needsHarness: false,
		handle: async (ctx) => Response.json(await service(ctx).prefetchPreview(ctx.url.searchParams.get("q") ?? "")),
	},
	{
		method: "DELETE",
		path: "/kb",
		needsHarness: false,
		handle: async (ctx) => {
			const id = Number(ctx.url.searchParams.get("id") ?? 0);
			if (!id) throw new AppError("bad_request", 400, "缺少文件 id");
			return Response.json({ ok: await service(ctx).remove(id) });
		},
	},
	{
		method: "GET",
		path: "/kb/status",
		needsHarness: false,
		handle: async (ctx) => Response.json(service(ctx).status()),
	},
	{
		method: "POST",
		path: "/kb/reindex",
		needsHarness: false,
		handle: async (ctx) => {
			const kb = service(ctx);
			if (!kb.vectorAvailable()) {
				throw new AppError("vector_unavailable", 400, "向量檢索未啟用（缺少 AI / KB_VEC 繫結）");
			}
			try {
				const result = await kb.reindex(Number(ctx.url.searchParams.get("limit") ?? KB_VECTOR_BATCH));
				return Response.json({ ok: true, ...result });
			} catch (err) {
				throw new AppError("reindex_failed", 500, errorText(err, 200));
			}
		},
	},
];
