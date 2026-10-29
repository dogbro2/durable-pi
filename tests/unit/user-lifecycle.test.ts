import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import { createSessionService, type SessionRuntime } from "../../src/worker/services/session-service";
import { createUserLifecycleService } from "../../src/worker/services/user-lifecycle-service";

/** 與 migrations.test.ts 相同的 SqlHandle 包裝：DDL 走 exec，查詢走 prepare().all()。 */
function sqlHandle(db: DatabaseSync): SqlHandle {
	return {
		exec(query, ...bindings) {
			if (!bindings.length && /^\s*(CREATE|ALTER|DROP)\b/i.test(query)) {
				db.exec(query);
				return { toArray: () => [] };
			}
			const rows = db.prepare(query).all(...(bindings as never[]));
			return { toArray: () => rows };
		},
	};
}

const NOW = "2026-10-22T08:00:00Z";

function insertSessionRows(sql: SqlHandle, sessionId: string): void {
	sql.exec(
		"INSERT INTO sessions_meta (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
		sessionId,
		"待刪會話",
		NOW,
		NOW,
	);
	sql.exec("INSERT INTO vfs_v2 (conversation_id, name, content, updated_at) VALUES (?, 'a.md', '# a', ?)", sessionId, NOW);
	sql.exec(
		"INSERT INTO shares (token, kind, session_id, name, expires_at, theme, created_at) VALUES (?, 'conversation', ?, '', 0, 'dark', ?)",
		`${sessionId}-one`,
		sessionId,
		NOW,
	);
	sql.exec(
		"INSERT INTO shares (token, kind, session_id, name, expires_at, theme, created_at) VALUES (?, 'file', ?, 'a.md', 0, 'dark', ?)",
		`${sessionId}-two`,
		sessionId,
		NOW,
	);
	sql.exec("INSERT INTO plans (conversation_id, steps, updated_at) VALUES (?, '[]', ?)", sessionId, NOW);
	sql.exec(
		"INSERT INTO approvals (session_id, tool, category, status, created_at) VALUES (?, 'write_file', 'write', 'pending', ?)",
		sessionId,
		NOW,
	);
	sql.exec("INSERT INTO approval_grants (session_id, tool, uses, created_at) VALUES (?, 'write_file', 1, ?)", sessionId, NOW);
	sql.exec(
		"INSERT INTO questions (session_id, payload, status, created_at) VALUES (?, '{}', 'pending', ?)",
		sessionId,
		NOW,
	);
	sql.exec(
		"INSERT INTO entry_kb_refs (conversation_id, entry_id, refs, created_at) VALUES (?, 1, '[]', ?)",
		sessionId,
		NOW,
	);
}

function sessionRuntime(): SessionRuntime {
	return {
		entries: vi.fn(),
		createConversation: vi.fn(),
		forkBefore: vi.fn(),
		rootId: vi.fn(),
		scanConversationIds: vi.fn(),
		modelFor: vi.fn(),
		pauseGoal: vi.fn(),
	} as unknown as SessionRuntime;
}

describe("會話刪除級聯（NERE-24）", () => {
	it("清掉該會話的分享、檔案、計劃、審批/許可、問題與 KB 旁路行，並返回實際計數", () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			migrate(sql);
			insertSessionRows(sql, "7");
			insertSessionRows(sql, "8");
			const runtime = sessionRuntime();

			const counts = createSessionService({ sql, runtime }).remove("7");

			expect(counts).toEqual({
				shares: 2,
				files: 1,
				plans: 1,
				approvals: 1,
				approvalGrants: 1,
				questions: 1,
				kbRefs: 1,
			});
			expect(runtime.pauseGoal).toHaveBeenCalledWith("7");
			expect(db.prepare("SELECT deleted FROM sessions_meta WHERE id = '7'").all()).toEqual([{ deleted: 1 }]);

			for (const [table, column] of [
				["vfs_v2", "conversation_id"],
				["shares", "session_id"],
				["plans", "conversation_id"],
				["approvals", "session_id"],
				["approval_grants", "session_id"],
				["questions", "session_id"],
				["entry_kb_refs", "conversation_id"],
			] as const) {
				expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = '7'`).all(), table).toEqual([{ n: 0 }]);
			}

			// 另一個會話的資料不受影響。
			expect(db.prepare("SELECT COUNT(*) AS n FROM shares WHERE session_id = '8'").all()).toEqual([{ n: 2 }]);
			expect(db.prepare("SELECT COUNT(*) AS n FROM vfs_v2 WHERE conversation_id = '8'").all()).toEqual([{ n: 1 }]);

			// 重複刪除冪等：計數為 0，不拋錯。
			expect(createSessionService({ sql, runtime }).remove("7")).toEqual({
				shares: 0,
				files: 0,
				plans: 0,
				approvals: 0,
				approvalGrants: 0,
				questions: 0,
				kbRefs: 0,
			});
		} finally {
			db.close();
		}
	});
});

describe("使用者吊銷生命週期（NERE-24）", () => {
	it("吊銷刪除全部分享、保留資料並返回兩邊的計數；重複吊銷為 0", () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			migrate(sql);
			insertSessionRows(sql, "7");
			insertSessionRows(sql, "8");
			const purge = vi.fn();
			const service = createUserLifecycleService({
				sql,
				backup: () => ({ version: 1, exportedAt: NOW, data: { sessions: [] } }),
				purge,
			});

			const first = service.revoke();
			expect(first.shares).toBe(4);
			expect(first.retained).toMatchObject({ sessions: 2, files: 2, plans: 2, shares: 0 });
			expect(db.prepare("SELECT COUNT(*) AS n FROM shares").all()).toEqual([{ n: 0 }]);
			// 資料仍在，吊銷不等於刪除。
			expect(db.prepare("SELECT COUNT(*) AS n FROM vfs_v2").all()).toEqual([{ n: 2 }]);
			expect(purge).not.toHaveBeenCalled();

			expect(service.revoke()).toMatchObject({ shares: 0 });
		} finally {
			db.close();
		}
	});

	it("purge 先取計數再清空，匯出走同一個 backup 載荷", async () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			migrate(sql);
			insertSessionRows(sql, "7");
			const cleared: string[] = [];
			const payload = { version: 1, exportedAt: NOW, data: { kbDocs: [] } };
			const service = createUserLifecycleService({
				sql,
				backup: () => payload,
				purge: async () => {
					cleared.push("purged");
					db.exec("DELETE FROM shares");
					db.exec("DELETE FROM vfs_v2");
				},
			});

			expect(service.backup()).toBe(payload);
			const counts = await service.purge();
			expect(counts).toMatchObject({ sessions: 1, files: 1, shares: 2 });
			expect(cleared).toEqual(["purged"]);
			expect(db.prepare("SELECT COUNT(*) AS n FROM vfs_v2").all()).toEqual([{ n: 0 }]);
		} finally {
			db.close();
		}
	});
});
