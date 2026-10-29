import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { AppError, toResponse } from "../http/errors";
import { createSkillService, SkillApiError, type SkillService } from "../services/skill-service";

/**
 * 技能域路由（NERE-55，契約 §5）：只做引數解析與狀態碼；
 * 目錄合併、審計、入庫、埋點都在 `services/skill-service.ts`，routes 零 SQL。
 */

function service(ctx: RequestContext): SkillService {
	return createSkillService({ sql: ctx.sql(), settings: ctx.settings });
}

/** 匯入保留 `ok` / `installed` 相容欄位（一個版本）；統一欄位由 toResponse 輸出（NERE-79）。 */
function importFailure(err: unknown): Response {
	if (!(err instanceof SkillApiError)) return toResponse(err);
	return toResponse(err, { ok: false, installed: false });
}

/** `/skills/<name>/audit` 是唯一帶路徑引數的路由；name 由路由表斷言過形狀。 */
function pathName(ctx: RequestContext): string {
	return decodeURIComponent(ctx.url.pathname.split("/")[2] ?? "");
}

export const skillRoutes: readonly Route[] = [
	// 市場列表：零抓取（目錄快照 + 已安裝行），含 installed 狀態，禁止 CDN 快取。
	{
		method: "GET",
		path: "/skills/hub",
		needsHarness: false,
		handle: async (ctx) => {
			const params = ctx.url.searchParams;
			const result = await service(ctx).hub({
				q: params.get("q"),
				runtime: params.get("runtime"),
				tag: params.get("tag"),
				audit: params.get("audit"),
				source: params.get("source"),
				origin: params.get("origin"),
				installed: params.get("installed"),
				sort: params.get("sort"),
				limit: params.get("limit"),
				offset: params.get("offset"),
			});
			return Response.json(result, { headers: { "cache-control": "private, max-age=30" } });
		},
	},
	// 舊社群入口收口（追加範圍 C）：8 條固定 blocked，不再裸寫庫。
	{
		method: "GET",
		path: "/skills/community",
		needsHarness: false,
		handle: async (ctx) => Response.json(service(ctx).community()),
	},
	// 匯入：URL 或 manifest+content，先審計再入庫；blocked → 422 且不寫庫。
	{
		method: "POST",
		path: "/skills/import",
		needsHarness: false,
		handle: async (ctx) => {
			try {
				const body = await ctx.req.json().catch(() => null);
				return Response.json(await service(ctx).importSkill(body));
			} catch (err) {
				return importFailure(err);
			}
		},
	},
	// 單技能審計：已安裝本地重審計，僅目錄存在時返回目錄快照。
	{
		method: "GET",
		path: "/skills/:name/audit",
		needsHarness: false,
		handle: async (ctx) =>
			Response.json(await service(ctx).auditFor(pathName(ctx)), { headers: { "cache-control": "no-store" } }),
	},
	// 既有 CRUD 相容（契約 §5.5）：欄位只增不改。
	{
		method: "GET",
		path: "/skills",
		needsHarness: false,
		handle: async (ctx) => Response.json(service(ctx).listCompat()),
	},
	{
		method: "POST",
		path: "/skills",
		needsHarness: false,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { name?: unknown; description?: unknown; content?: unknown };
			const name = String(body.name ?? "").trim().slice(0, 40);
			const content = String(body.content ?? "").trim();
			if (!name || !content) throw new AppError("bad_request", 400, "需要名稱與內容");
			await service(ctx).addManual({ name, description: String(body.description ?? "").trim().slice(0, 120), content });
			return Response.json({ ok: true });
		},
	},
	{
		method: "DELETE",
		path: "/skills",
		needsHarness: false,
		handle: async (ctx) => {
			service(ctx).remove(ctx.url.searchParams.get("name") ?? "");
			return Response.json({ ok: true });
		},
	},
	// 技能域指標（追加範圍 A / NERE-59）：與分享計數完全獨立。
	{
		method: "GET",
		path: "/metrics/skill-hub",
		needsHarness: false,
		handle: async (ctx) => Response.json(service(ctx).metrics(ctx.url.searchParams.get("days"))),
	},
];
