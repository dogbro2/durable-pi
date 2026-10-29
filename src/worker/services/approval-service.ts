import type { SqlHandle } from "../db/migrations";
import { AppError, defaultErrorCode } from "../http/errors";
import * as approvalsRepo from "../repo/approvals-repo";
import { isHidden } from "../repo/sessions-repo";
import { approvalSettings as readApprovalSettings, type ApprovalPolicy, type GetSetting } from "./settings-service";

/**
 * 工具審批用例（ADR-0001 §2）：分級策略、閘門讀取、待審批決定。
 *
 * - 閘門在工具邊界呼叫（`withApproval`），Service 不感知 HTTP；
 * - 扣許可仍是 `approvalsRepo.consumeGrant` 一條讀-寫路徑，不引入讀-改-寫競態；
 * - `/tools` 與 `/approvals` 共用同一份策略解析。
 */
export type ApprovalCategory = approvalsRepo.ApprovalCategory;

export const APPROVAL_LABEL: Record<ApprovalCategory, string> = { read: "讀取", write: "寫入", exec: "執行" };

/** 已知工具的預設分級。MCP 工具按寫操作、未知工具按讀取處理。 */
export const TOOL_CATEGORY: Record<string, ApprovalCategory> = {
	now: "read",
	recall: "read",
	list_skills: "read",
	load_skill: "read",
	install_skill: "write",
	read_file: "read",
	list_files: "read",
	kb_search: "read",
	kb_list: "read",
	kb_add: "write",
	kb_delete: "write",
	web_search: "read",
	web_fetch_page: "read",
	http_fetch: "read",
	tool_search: "read",
	update_plan: "read",
	set_goal: "read",
	complete_goal: "read",
	report_goal: "read",
	write_file: "write",
	share_file: "write",
	share_conversation: "write",
	remember: "write",
	codemode: "exec",
	dispatch_tasks: "exec",
};

/** 自定義工具統一按 exec 級處理；集合由呼叫方傳入（DO 例項欄位，R5）。 */
export function toolCategory(name: string, customToolNames?: ReadonlySet<string>): ApprovalCategory {
	const known = TOOL_CATEGORY[name];
	if (known) return known;
	if (customToolNames?.has(name)) return "exec";
	if (name.startsWith("mcp__")) return "write";
	return "read";
}

/**
 * 自帶預設「詢問」的工具（v1.1.0）：http_fetch 可以把任意 URL 變成外傳通道，
 * 未經同意不應自動發出。使用者可在 設定 → 對話 → 逐工具審批 裡改回「放行」。
 */
export const TOOL_POLICY_DEFAULT: Record<string, ApprovalPolicy> = {
	http_fetch: "ask",
};

/** 生效策略：逐工具覆蓋 > 內建預設 > 分級策略 > 預設放行。 */
export function toolPolicy(
	get: GetSetting,
	name: string,
	customToolNames?: ReadonlySet<string>,
): ApprovalPolicy {
	const override = get(`approval_tool_${name}`, "follow");
	if (override === "follow" && TOOL_POLICY_DEFAULT[name]) return TOOL_POLICY_DEFAULT[name];
	if (override === "allow" || override === "ask" || override === "deny") return override;
	const level = get(`approval_${toolCategory(name, customToolNames)}`, "allow");
	return level === "ask" || level === "deny" ? level : "allow";
}

export function approvalSettings(get: GetSetting) {
	return readApprovalSettings(get);
}

export function listPending(sql: SqlHandle, sessionId: string) {
	return approvalsRepo.listPending(sql, sessionId);
}

/** 記錄一條待審批；同一會話同一工具已有待審批時不重複插入。失敗不阻塞工具。 */
export function recordApproval(
	sql: SqlHandle,
	sessionId: string,
	tool: string,
	category: ApprovalCategory,
	args: unknown,
): number | null {
	try {
		const existing = approvalsRepo.findPendingId(sql, sessionId, tool);
		if (existing != null) return existing;
		const preview = (() => {
			try {
				return JSON.stringify(args ?? {}).slice(0, 800);
			} catch {
				return "";
			}
		})();
		return approvalsRepo.insertPending(sql, {
			sessionId,
			tool,
			category,
			args: preview,
			now: new Date().toISOString(),
		});
	} catch {
		return null;
	}
}

/** 給工具套上審批閘門：放行 / 詢問（無許可時記一條待審批並讓模型等待）/ 禁止。 */
export type ToolGateDeps = {
	/** 延遲解析當前請求的 SQL（模組級擴充套件在 execute 時才需要）。 */
	sql(): SqlHandle;
	get: GetSetting;
};

export function withApproval<T extends { name: string; execute?: (...args: never[]) => unknown }>(
	tool: T,
	deps: ToolGateDeps,
	customToolNames?: ReadonlySet<string>,
): T {
	const original = tool.execute;
	if (typeof original !== "function") return tool;
	return {
		...tool,
		// 必須把 execute 的全部引數（args, api, context）原樣轉發：codemode 等工具依賴第三個 context.abortSignal
		execute: async (...rest: never[]) => {
			const policy = toolPolicy(deps.get, tool.name, customToolNames);
			const run = () => (original as (...a: never[]) => unknown)(...rest);
			const args = rest[0];
			const api = rest[1];
			if (policy === "allow") return run();
			const sid = String((api as unknown as { conversationId?: unknown })?.conversationId ?? "1");
			if (isHidden(deps.sql(), sid)) return run();
			const category = toolCategory(tool.name, customToolNames);
			if (policy === "deny") {
				return {
					output: [{
						type: "text",
						text: `「${tool.name}」屬於${APPROVAL_LABEL[category]}級操作，當前策略為禁止。請告訴使用者：可在 設定 → 工具審批 中調整。`,
					}],
				};
			}
			if (approvalsRepo.consumeGrant(deps.sql(), sid, tool.name)) return run();
			const id = recordApproval(deps.sql(), sid, tool.name, category, args);
			return {
				output: [{
					type: "text",
					text: `「${tool.name}」屬於${APPROVAL_LABEL[category]}級操作，需要使用者確認後才能執行。已提交待審批${id ? `（#${id}）` : ""}：不要重複呼叫本工具，等使用者批准後再繼續。`,
				}],
			};
		},
	} as T;
}

export class ApprovalApiError extends AppError {
	constructor(status: number, message: string, code = defaultErrorCode(status)) {
		super(code, status, message);
		this.name = "ApprovalApiError";
	}
}

export type ApprovalAction = "once" | "always" | "deny";
export type ApprovalDecision = { ok: true; id: number; action: ApprovalAction; tool: string; resume: string };

/** POST /approvals：once / always / deny；已 decided 的條目只返回 resume（與舊行為一致）。 */
export function decide(sql: SqlHandle, rawId: unknown, action: unknown): ApprovalDecision {
	const id = Math.floor(Number(rawId));
	if (!Number.isFinite(id) || id <= 0) throw new ApprovalApiError(400, "缺少待審批 id");
	if (action !== "once" && action !== "always" && action !== "deny") {
		throw new ApprovalApiError(400, "action 必須是 once / always / deny");
	}
	const row = approvalsRepo.get(sql, id);
	if (!row) throw new ApprovalApiError(404, "待審批不存在");
	if (row.status === "pending") {
		const now = new Date().toISOString();
		if (action === "deny") {
			approvalsRepo.markDecided(sql, id, "denied", now);
			approvalsRepo.deleteGrant(sql, row.session_id, row.tool);
		} else {
			approvalsRepo.markDecided(sql, id, "approved", now);
			approvalsRepo.upsertGrant(sql, {
				sessionId: row.session_id,
				tool: row.tool,
				uses: action === "always" ? -1 : 1,
				now,
			});
		}
	}
	const resume =
		action === "deny"
			? row.tool === "share_file" || row.tool === "share_conversation"
				? `使用者拒絕了對工具「${row.tool}」的呼叫，本次分享已取消：不要聲稱連結已生成，簡短回覆「已取消分享」即可。`
				: `使用者拒絕了對工具「${row.tool}」的呼叫，請不要再用它，改換方案或向用戶說明。`
			: `已批准工具「${row.tool}」（${action === "always" ? "以後允許" : "本次"}），請繼續剛才的操作。`;
	return { ok: true, id, action, tool: row.tool, resume };
}
