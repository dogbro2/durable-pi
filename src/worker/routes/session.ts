import { createSessionService } from "../services/session-service";
import { AppError, errorText } from "../http/errors";
import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";

/** 會話域路由（ADR-0001 §1）：只做解析、校驗與狀態碼，編排交給 session-service。 */
function service(ctx: RequestContext) {
	return createSessionService({ sql: ctx.sql(), runtime: ctx.sessionRuntime });
}

export const sessionRoutes: readonly Route[] = [
	{
		method: "GET",
		path: "/sessions",
		needsHarness: true,
		handle: async (ctx) => Response.json(await service(ctx).list()),
	},
	{
		method: "POST",
		path: "/sessions",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { kind?: string; title?: string; instructions?: string };
			if (body.kind === "project") {
				if (!body.title?.trim()) throw new AppError("bad_request", 400, "專案需要名稱");
				return Response.json(await service(ctx).create({ project: { title: body.title, instructions: body.instructions } }));
			}
			return Response.json(await service(ctx).create());
		},
	},
	{
		method: "PATCH",
		path: "/sessions",
		needsHarness: true,
		handle: async (ctx) => {
			const { id, title, instructions, kind } = (await ctx.req.json()) as {
				id?: string;
				title?: string;
				instructions?: string;
				kind?: string;
			};
			if (!id) throw new AppError("bad_request", 400, "缺少 id");
			const hasProjectPatch = typeof instructions === "string" || kind === "project" || kind === "chat";
			if (!title?.trim() && !hasProjectPatch) throw new AppError("bad_request", 400, "缺少 id 或標題");
			if (title?.trim()) service(ctx).rename(id, title);
			if (hasProjectPatch) {
				service(ctx).updateProject(id, {
					...(kind === "project" || kind === "chat" ? { kind } : {}),
					...(typeof instructions === "string" ? { instructions } : {}),
				});
			}
			return Response.json({ ok: true });
		},
	},
	{
		method: "DELETE",
		path: "/sessions",
		needsHarness: true,
		handle: async (ctx) => {
			const id = ctx.url.searchParams.get("id") ?? "";
			if (!id) throw new AppError("bad_request", 400, "缺少 id");
			return Response.json({ ok: true, deleted: service(ctx).remove(id) });
		},
	},
	{
		method: "POST",
		path: "/branches",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { sessionId?: string; entryId?: number; title?: string };
			const entryId = Math.floor(Number(body.entryId));
			if (!Number.isFinite(entryId) || entryId <= 0) {
				throw new AppError("bad_request", 400, "缺少有效的 entryId");
			}
			try {
				const created = await service(ctx).fork(String(body.sessionId ?? "1"), entryId, body.title);
				return Response.json({ ok: true, ...created });
			} catch (err) {
				// 舊行為：分叉失敗一律 400，並保留「分支建立失敗：」字首與 200 字元截斷。
				throw new AppError("branch_failed", 400, `分支建立失敗：${errorText(err, 200)}`);
			}
		},
	},
	{
		method: "GET",
		path: "/entries",
		needsHarness: true,
		handle: async (ctx) => Response.json(await service(ctx).entries(ctx.url.searchParams.get("sessionId") ?? undefined)),
	},
	{
		method: "GET",
		path: "/session",
		needsHarness: true,
		handle: async () => Response.json({ ok: true, name: "durable-pi" }),
	},
];
