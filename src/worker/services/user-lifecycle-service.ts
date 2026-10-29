import type { SqlHandle } from "../db/migrations";
import { deleteAll as deleteAllShares } from "../repo/shares-repo";
import type { BackupPayload } from "./data-service";

/**
 * 使用者吊銷生命週期（NERE-24）。
 *
 * 產品語義（ADR-0004）：吊銷 = 立即失效訪問，不刪除資料。
 * - `revoke()` 刪除該使用者 DO 內的全部分享，`/s/*` 隨即 404；其餘資料保留。
 * - `purge()` 是顯式、二次確認後的不可逆清空；呼叫前必須能匯出（`backup()`）。
 *
 * 兩個操作都冪等：重複呼叫只返回 0，不報錯。
 */

export type UserDataCounts = {
	sessions: number;
	files: number;
	shares: number;
	kbDocs: number;
	kbChunks: number;
	plans: number;
	approvals: number;
	approvalGrants: number;
	questions: number;
	goals: number;
	automations: number;
	memories: number;
	skills: number;
	customTools: number;
	prompts: number;
	rules: number;
	mcpServers: number;
	providers: number;
	settings: number;
	entryKbRefs: number;
	skillAudits: number;
	skillEvents: number;
	reflectState: number;
};

/** 彙總口徑：全部是 DO 內的業務表；pi-durable 會話條目不在這裡，由 `purge()` 整體清空。 */
const COUNTED_TABLES: readonly (readonly [keyof UserDataCounts, string])[] = [
	["sessions", "sessions_meta"],
	["files", "vfs_v2"],
	["shares", "shares"],
	["kbDocs", "kb_docs"],
	["kbChunks", "kb_chunks"],
	["plans", "plans"],
	["approvals", "approvals"],
	["approvalGrants", "approval_grants"],
	["questions", "questions"],
	["goals", "goals"],
	["automations", "automations"],
	["memories", "pi_mem"],
	["skills", "skills"],
	["customTools", "custom_tools"],
	["prompts", "prompts"],
	["rules", "rules"],
	["mcpServers", "mcp_servers"],
	["providers", "providers"],
	["settings", "app_settings"],
	["entryKbRefs", "entry_kb_refs"],
	["skillAudits", "skill_audits"],
	["skillEvents", "skill_events"],
	["reflectState", "reflect_state"],
];

export function emptyUserDataCounts(): UserDataCounts {
	return Object.fromEntries(COUNTED_TABLES.map(([key]) => [key, 0])) as UserDataCounts;
}

/** 表名來自本檔案的凍結清單，不接受外部輸入。 */
export function countUserData(sql: SqlHandle): UserDataCounts {
	const counts = emptyUserDataCounts();
	for (const [key, table] of COUNTED_TABLES) {
		const rows = sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray() as { n: number }[];
		counts[key] = Number(rows[0]?.n ?? 0);
	}
	return counts;
}

export type RevokeResult = {
	/** 本次實際刪除的分享行數。 */
	shares: number;
	/** 仍保留在該使用者 DO 內的資料（吊銷不刪資料）。 */
	retained: UserDataCounts;
};

export type UserLifecycleDeps = {
	sql: SqlHandle;
	/** 匯出與 `/backup` 同形的載荷；purge 前給 owner 留出可回滾的視窗。 */
	backup: () => BackupPayload;
	/** 關閉 Harness 並清空該 DO 的全部儲存（SQL 與 pi-durable 資料）。 */
	purge: () => Promise<void>;
};

export type UserLifecycleService = {
	revoke(): RevokeResult;
	backup(): BackupPayload;
	purge(): Promise<UserDataCounts>;
};

export function createUserLifecycleService({ sql, backup, purge }: UserLifecycleDeps): UserLifecycleService {
	return {
		revoke() {
			const retained = countUserData(sql);
			const shares = deleteAllShares(sql);
			// 吊銷後該使用者的分享行清零；其餘計數如實反映仍保留的資料。
			retained.shares = 0;
			return { shares, retained };
		},

		backup,

		async purge() {
			const counts = countUserData(sql);
			await purge();
			return counts;
		},
	};
}
