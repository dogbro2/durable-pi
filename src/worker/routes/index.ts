import type { RequestContext } from "../http/context";
import { AppError, toResponse } from "../http/errors";
import { matchRoute, type Route } from "../http/router";
import { approvalRoutes } from "./approvals";
import { automationRoutes } from "./automations";
import { capabilityRoutes } from "./capabilities";
import { dataRoutes } from "./data";
import { chatRoutes } from "./chat";
import { fileRoutes } from "./files";
import { kbRoutes } from "./kb";
import { promptRoutes } from "./prompts";
import { sessionRoutes } from "./session";
import { settingsRoutes } from "./settings";
import { shareRoutes } from "./share";
import { skillRoutes } from "./skills";
import { systemRoutes } from "./system";

/**
 * 路由表（ADR-0001 §9.1）：所有端點都在這裡登記（階段 6 起沒有 legacy 兜底）。
 * 階段 1：會話與檔案域。階段 2：知識庫域。階段 3：分享域（/s/ 不啟 Harness）。
 * 階段 4：技能域（NERE-55，hub 需排在 `/skills` 之前）；設定/自動化/審批/能力域（NERE-32）。
 * 階段 5：對話域（NERE-33），`/chat` 與 `/chat/stream` 共用 chat-service。
 * 階段 6（NERE-34）：系統/資料/提示模板域；`handleLegacyFetch` 全部刪除，未命中直接 404。
 */
export const ROUTES: readonly Route[] = [
	...sessionRoutes,
	...fileRoutes,
	...kbRoutes,
	...shareRoutes,
	...skillRoutes,
	// 階段 4（NERE-32）：設定/供應商/模型、自動化/目標/計劃、審批/問答、能力/工具/MCP。
	...settingsRoutes,
	...automationRoutes,
	...approvalRoutes,
	...capabilityRoutes,
	// 階段 5（NERE-33）：對話 / 插話 / 中止 / 重置 / 壓縮。
	...chatRoutes,
	// 階段 6（NERE-34）：系統、資料、提示模板 / 規則 / 自定義工具。
	...systemRoutes,
	...dataRoutes,
	...promptRoutes,
];

export async function dispatch(ctx: RequestContext, routes: readonly Route[] = ROUTES): Promise<Response> {
	const route = matchRoute(routes, ctx.req.method, ctx.url.pathname);
	// 階段 6：沒有 legacy 兜底；未知路徑不觸發遷移/ Harness，錯誤體統一經 toResponse。
	if (!route) return toResponse(new AppError("not_found", 404, "not found"));
	try {
		await ctx.ready();
		if (route.needsHarness) await ctx.harness();
		return await route.handle(ctx);
	} catch (err) {
		// AppError 走 §9.3 對映；未知異常仍是 500 + String(e).slice(0, 500)。
		return toResponse(err);
	}
}
