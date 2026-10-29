import type { RequestContext } from "../http/context";
import type { Route } from "../http/router";
import { listBackupDocs } from "../repo/kb-repo";
import { buildBackup } from "../services/data-service";
import { createKbService } from "../services/kb-service";
import { createUserLifecycleService } from "../services/user-lifecycle-service";

/**
 * 內部跨 DO 協議（NERE-24）：只由 Worker 用 `x-pi-internal: 1` 呼叫，
 * 不進入公開路由表；`SpikeAgent.fetch` 在分發前校驗並拒絕其它請求。
 *
 * 協議只做資料處置，不理解登錄檔：刪登錄檔行由 Worker 側完成。
 */
function service(ctx: RequestContext) {
	return createUserLifecycleService({
		sql: ctx.sql(),
		backup: () => buildBackup({ sql: ctx.sql(), kbDocs: listBackupDocs(ctx.sql()) }),
		purge: async () => {
			// 知識庫向量是全域性索引裡的派生資料；逐文件刪除（失敗不阻塞 DO 清空）。
			const kb = createKbService({
				sql: ctx.sql(),
				env: ctx.env,
				scopeId: ctx.scopeId,
				settings: ctx.settings,
				webFetch: ctx.webFetch,
			});
			for (const doc of kb.listDocs()) {
				await kb.remove(doc.id).catch(() => {});
			}
			await ctx.userLifecycleRuntime.purge();
		},
	});
}

export const internalRoutes: readonly Route[] = [
	{
		// 吊銷：刪除該使用者 DO 的全部分享，返回實際刪除數與保留的其它資料規模。
		method: "POST",
		path: "/internal/revoke-user",
		needsHarness: false,
		handle: async (ctx) => Response.json({ ok: true, ...service(ctx).revoke() }),
	},
	{
		// 匯出：與 `/api/backup` 同形，供 owner 在 purge 前留檔。
		method: "GET",
		path: "/internal/user-backup",
		needsHarness: false,
		handle: async (ctx) => Response.json(service(ctx).backup()),
	},
	{
		// 清空：不可逆。呼叫方必須先完成確認與登錄檔刪除。
		method: "POST",
		path: "/internal/purge-user",
		needsHarness: false,
		handle: async (ctx) => Response.json({ ok: true, purged: await service(ctx).purge() }),
	},
];
