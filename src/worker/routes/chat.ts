import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { AppError, errorText, toResponse } from "../http/errors";
import { createChatService, type ChatEvent } from "../services/chat-service";

/**
 * 對話域路由（ADR-0001 §1 / §5，NERE-33）：只做 JSON 解析、SSE 編碼與狀態碼，
 * 編排放 `chat-service`；`/chat` 與 `/chat/stream` 共用 prepare → submit → finish。
 */
function service(ctx: RequestContext) {
	return createChatService({ sql: ctx.sql(), runtime: ctx.chatRuntime });
}

const SSE_HEADERS = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache, no-transform",
	connection: "keep-alive",
	"x-accel-buffering": "no",
};

export const chatRoutes: readonly Route[] = [
	{
		method: "POST",
		path: "/chat",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json()) as { message?: string; sessionId?: string; images?: string[] };
			// v1.1.0：缺 message 時給 400，不再掉進 500 internal_error
			const message = typeof body.message === "string" ? body.message : "";
			if (!message.trim()) return toResponse(new AppError("invalid_message", 400, "message 不能為空"));
			return Response.json(await service(ctx).chat({ message, sessionId: body.sessionId, images: body.images }));
		},
	},
	{
		method: "POST",
		path: "/chat/stream",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json()) as { message?: string; sessionId?: string; images?: string[] };
			const message = typeof body.message === "string" ? body.message : "";
			if (!message.trim()) return toResponse(new AppError("invalid_message", 400, "message 不能為空"));
			const chat = service(ctx);
			// prepare 失敗走 HTTP 錯誤（含同會話併發的 409 chat_busy）；進入泵之後才走 SSE error 幀。
			const prepared = await chat.prepare({ message: message, sessionId: body.sessionId, images: body.images });
			const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
			const writer = writable.getWriter();
			const encoder = new TextEncoder();
			let closed = false;
			const emit = async (event: ChatEvent) => {
				if (closed) return;
				try {
					await writer.write(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`));
				} catch {
					closed = true;
				}
			};
			const pump = chat.stream(prepared, emit).finally(async () => {
				closed = true;
				await writer.close().catch(() => {});
			});
			ctx.chatRuntime.waitUntil(pump);
			return new Response(readable, { headers: SSE_HEADERS });
		},
	},
	{
		method: "POST",
		path: "/interject",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { sessionId?: string; message?: string };
			const message = String(body.message ?? "").trim();
			if (!message) return toResponse(new AppError("bad_request", 400, "插話內容不能為空"), { ok: false });
			try {
				return Response.json(await service(ctx).interject(message, body.sessionId));
			} catch (err) {
				return toResponse(new AppError("interject_failed", 500, errorText(err)), { ok: false });
			}
		},
	},
	{
		method: "POST",
		path: "/abort",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { sessionId?: string };
			return Response.json(await service(ctx).abort(body.sessionId));
		},
	},
	{
		method: "POST",
		path: "/reset",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { sessionId?: string };
			return Response.json(await service(ctx).reset(body.sessionId));
		},
	},
	{
		method: "POST",
		path: "/compact",
		needsHarness: true,
		handle: async (ctx) => {
			const body = (await ctx.req.json().catch(() => ({}))) as { sessionId?: string; instructions?: string };
			const chat = service(ctx);
			return Response.json(
				await chat.compact(body.sessionId, typeof body.instructions === "string" ? body.instructions : undefined),
			);
		},
	},
];
