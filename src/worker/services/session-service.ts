import type { SqlHandle } from "../db/migrations";
import type { KbRef } from "../lib/kb";
import {
	getMany as getEntryKbRefs,
	removeConversation as removeEntryKbRefs,
	upsert as upsertEntryKbRefs,
} from "../repo/entry-kb-refs-repo";
import { get, insertFork, insertIfAbsent, listKnownIds, listVisible, markDeleted, rename } from "../repo/sessions-repo";
import type { SessionMetaRow } from "../repo/sessions-repo";
import { removeSession as removeSessionFiles } from "../repo/files-repo";
import { removeForSession as removeApprovals } from "../repo/approvals-repo";
import { removeForSession as removeQuestions } from "../repo/questions-repo";
import { remove as removePlan } from "../repo/plans-repo";
import { deleteBySession as removeShares } from "../repo/shares-repo";

/**
 * 會話域用例（ADR-0001 §2）：`sessions_meta` 與 Harness 的唯一協調點。
 *
 * Harness 的 open/重試/模型與擴充套件配置留在 DO 組合根，通過 `runtime` 埠注入；
 * Service 只負責後設資料讀寫、標題策略與刪除編排，邏輯與舊 `worker.ts` 方法逐字一致。
 */
export type SessionRuntime = {
	/** 會話 id 與實際條目；Service 用它合併 entry 旁路後設資料（NERE-40）。 */
	entries(sessionId?: string): Promise<{ conversationId: string; items: readonly unknown[] }>;
	createConversation(): Promise<string>;
	/** 在 `entryId` 之前分叉，返回新會話 id、父會話 id 與實際分叉點。 */
	forkBefore(sessionId: string, entryId: number): Promise<{ id: string; parentId: string; at: number }>;
	rootId(): Promise<string>;
	scanConversationIds(): Promise<readonly string[]>;
	modelFor(sessionId?: string): string;
	/** 目標隨會話停止（goals 域由 DO 的既有 helper 實現）。 */
	pauseGoal(sessionId: string): void;
};

export type SessionServiceDeps = {
	sql: SqlHandle;
	runtime: SessionRuntime;
};

export type SessionList = {
	sessions: {
		id: string;
		title: string;
		created_at: string;
		updated_at: string;
		model?: string;
		parent_id?: string | null;
		fork_at?: number | null;
	}[];
};

/** 會話刪除的實際清理計數（NERE-24）：每一步都冪等，重複刪除返回 0。 */
export type SessionDeleteCounts = {
	shares: number;
	files: number;
	plans: number;
	approvals: number;
	approvalGrants: number;
	questions: number;
	kbRefs: number;
};

export interface SessionService {
	/** 後設資料表為準，儲存裡存在但後設資料缺失的會話補齊（已刪除/隱藏的不復活）。 */
	list(): Promise<SessionList>;
	create(): Promise<{ id: string; title: string }>;
	fork(sessionId: string, entryId: number, title?: string): Promise<{ id: string; title: string }>;
	rename(id: string, title: string): void;
	/** 刪除會級聯清理該會話的分享、檔案、計劃、審批/許可、問題與 KB 旁路行（NERE-24）。 */
	remove(id: string): SessionDeleteCounts;
	entries(sessionId?: string): Promise<readonly unknown[]>;
	/** 記下一條 assistant entry 本輪注入的知識庫命中（NERE-40）；空命中不寫。 */
	saveEntryKbRefs(conversationId: string, entryId: number, refs: readonly KbRef[]): void;
}

const ASSISTANT_KIND = "pi.assistant";

/**
 * 把旁路表裡的命中合併到 assistant entry（NERE-40）。
 * 只新增 `kbRefs` 欄位，其它 entry 原樣返回；老會話沒有行時結果與遷移前完全一致。
 */
function withKbRefs(sql: SqlHandle, conversationId: string, items: readonly unknown[]): readonly unknown[] {
	const assistantIds: number[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const row = item as { id?: unknown; kind?: unknown };
		if (row.kind !== ASSISTANT_KIND) continue;
		const id = Number(row.id);
		if (Number.isFinite(id) && id > 0) assistantIds.push(id);
	}
	if (!assistantIds.length) return items;
	const found = getEntryKbRefs(sql, conversationId, assistantIds);
	if (!found.size) return items;
	return items.map((item) => {
		if (!item || typeof item !== "object") return item;
		const row = item as { id?: unknown; kind?: unknown };
		if (row.kind !== ASSISTANT_KIND) return item;
		const refs = found.get(Number(row.id));
		return refs ? { ...(item as Record<string, unknown>), kbRefs: refs } : item;
	});
}

export function createSessionService({ sql, runtime }: SessionServiceDeps): SessionService {
	return {
		async list() {
			const rootId = await runtime.rootId();
			const rows: SessionMetaRow[] = listVisible(sql);
			const visible = new Set(rows.map((row) => row.id));
			const known = new Set(listKnownIds(sql));
			const now = new Date().toISOString();
			for (const id of await runtime.scanConversationIds()) {
				if (visible.has(id) || known.has(id)) continue;
				const title = id === rootId ? "預設會話" : `會話 ${id}`;
				insertIfAbsent(sql, id, title, now);
				rows.push({ id, title, created_at: now, updated_at: now });
			}
			return { sessions: rows };
		},

		async create() {
			const id = await runtime.createConversation();
			insertIfAbsent(sql, id, "新會話", new Date().toISOString());
			return { id, title: "新會話" };
		},

		async fork(sessionId, entryId, title) {
			const forked = await runtime.forkBefore(sessionId, entryId);
			const parent = get(sql, forked.parentId);
			const now = new Date().toISOString();
			const fallback = `⑂ ${parent?.title || `會話 ${forked.parentId}`}`;
			const finalTitle = (title ?? "").trim().slice(0, 60) || fallback;
			insertFork(sql, {
				id: forked.id,
				title: finalTitle,
				now,
				model: runtime.modelFor(sessionId),
				parentId: forked.parentId,
				forkAt: forked.at,
			});
			return { id: forked.id, title: finalTitle };
		},

		rename(id, title) {
			rename(sql, id, title.trim().slice(0, 60), new Date().toISOString());
		},

		remove(id) {
			// 先刪分享，讓連結在後續清理期間就失效；每步都可重入。
			const shares = removeShares(sql, id);
			const files = removeSessionFiles(sql, id);
			const plans = removePlan(sql, id);
			const { approvals, grants } = removeApprovals(sql, id);
			const questions = removeQuestions(sql, id);
			// 旁路後設資料不隨 Harness 條目級聯，刪除會話時一併清掉，避免長期留存（NERE-40 review）。
			const kbRefs = removeEntryKbRefs(sql, id);
			markDeleted(sql, id, new Date().toISOString());
			runtime.pauseGoal(id);
			return { shares, files, plans, approvals, approvalGrants: grants, questions, kbRefs };
		},

		async entries(sessionId) {
			const { conversationId, items } = await runtime.entries(sessionId);
			return withKbRefs(sql, conversationId, items);
		},

		saveEntryKbRefs(conversationId, entryId, refs) {
			if (!refs.length) return;
			const id = Number(entryId);
			if (!Number.isFinite(id) || id <= 0) return;
			upsertEntryKbRefs(sql, conversationId, id, refs, new Date().toISOString());
		},
	};
}
