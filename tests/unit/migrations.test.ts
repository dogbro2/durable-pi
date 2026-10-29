import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, ensureColumn, migrate, type SqlHandle } from "../../src/worker/db/migrations";

/** 按 SqlHandle 形狀包一層 node:sqlite：DDL 走 db.exec，查詢走 prepare().all()。 */
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

const ledgerCount = (db: DatabaseSync): number =>
	(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").all() as { n: number }[])[0].n;

const columnsOf = (db: DatabaseSync, table: string): string[] =>
	(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);

describe("migrate", () => {
	it("空庫一次遷移後 sessions_meta 同時含五個補列", () => {
		const db = new DatabaseSync(":memory:");
		try {
			const applied = migrate(sqlHandle(db));
			expect(applied).toBe(MIGRATIONS.length);
			expect(columnsOf(db, "sessions_meta")).toEqual(
				expect.arrayContaining(["deleted", "model", "hidden", "parent_id", "fork_at"]),
			);
		} finally {
			db.close();
		}
	});

	it("再次遷移返回 0，賬本行數不變", () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			migrate(sql);
			const before = ledgerCount(db);
			expect(migrate(sql)).toBe(0);
			expect(ledgerCount(db)).toBe(before);
		} finally {
			db.close();
		}
	});

	it("賬本記錄全部遷移且 version 升序", () => {
		const db = new DatabaseSync(":memory:");
		try {
			migrate(sqlHandle(db));
			const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map(
				(row) => row.version,
			);
			expect(ledgerCount(db)).toBe(MIGRATIONS.length);
			expect(versions).toEqual([...MIGRATIONS].map((migration) => migration.version).sort((a, b) => a - b));
		} finally {
			db.close();
		}
	});

	it("舊 vfs_files 資料遷入 vfs_v2 根會話，舊錶消失", () => {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec(
				"CREATE TABLE vfs_files (name TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL)",
			);
			db.exec("INSERT INTO vfs_files (name, content, updated_at) VALUES ('a.txt', 'hello', '2026-01-01T00:00:00Z')");
			migrate(sqlHandle(db));
			expect(db.prepare("SELECT conversation_id, name, content FROM vfs_v2").all()).toEqual([
				{ conversation_id: "1", name: "a.txt", content: "hello" },
			]);
			const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vfs_files'").all();
			expect(legacy).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("ensureColumn 只吞重複列，其它錯誤丟擲", () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			migrate(sql);
			// 列已存在（migrate 剛加過）→ 不拋
			expect(() => ensureColumn(sql, "sessions_meta", "model TEXT NOT NULL DEFAULT 'deepseek-flash'")).not.toThrow();
			// 表不存在 → 必須丟擲，不能靜默吞掉
			expect(() => ensureColumn(sql, "missing_table", "x TEXT")).toThrow(/no such table/i);
		} finally {
			db.close();
		}
	});

	it("老庫補列：9 箇舊表列補齊且舊行保留", () => {
		const db = new DatabaseSync(":memory:");
		try {
			// 線上老庫：四張表都是補列前的形狀，且沒有 schema_migrations
			db.exec("CREATE TABLE sessions_meta (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
			db.exec("CREATE TABLE shares (token TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
			db.exec("CREATE TABLE kb_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL)");
			db.exec("CREATE TABLE pi_mem (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT NOT NULL)");
			db.exec("INSERT INTO sessions_meta (id, title, created_at, updated_at) VALUES ('legacy', '舊會話', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
			db.exec("INSERT INTO pi_mem (content, created_at) VALUES ('舊記憶', '2026-01-01T00:00:00Z')");

			migrate(sqlHandle(db));

			expect(columnsOf(db, "sessions_meta")).toEqual(
				expect.arrayContaining(["deleted", "model", "hidden", "parent_id", "fork_at"]),
			);
			expect(columnsOf(db, "shares")).toEqual(expect.arrayContaining(["expires_at", "theme"]));
			expect(columnsOf(db, "kb_chunks")).toContain("vectorized");
			expect(columnsOf(db, "pi_mem")).toContain("source");
			expect(db.prepare("SELECT title, deleted, model, hidden FROM sessions_meta WHERE id = 'legacy'").all()).toEqual([
				{ title: "舊會話", deleted: 0, model: "deepseek-flash", hidden: 0 },
			]);
			expect(db.prepare("SELECT content, source FROM pi_mem").all()).toEqual([{ content: "舊記憶", source: "manual" }]);
		} finally {
			db.close();
		}
	});

	it("遷移中途失敗後重跑可恢復，賬本不重複", () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			let failed = false;
			const flaky: SqlHandle = {
				exec(query, ...bindings) {
					if (!failed && query.startsWith("ALTER TABLE sessions_meta ADD COLUMN model")) {
						failed = true;
						throw new Error("transient storage error");
					}
					return sql.exec(query, ...(bindings as never[]));
				},
			};
			// v1 跑到一半失敗：賬本不寫，但已執行的 DDL 留在庫裡
			expect(() => migrate(flaky)).toThrow(/transient storage error/);
			expect(ledgerCount(db)).toBe(0);
			// 重跑：v1 冪等補齊剩餘列，再寫賬本
			expect(migrate(sql)).toBe(MIGRATIONS.length);
			expect(columnsOf(db, "sessions_meta")).toEqual(
				expect.arrayContaining(["deleted", "model", "hidden", "parent_id", "fork_at"]),
			);
			expect(ledgerCount(db)).toBe(MIGRATIONS.length);
		} finally {
			db.close();
		}
	});

	it("賬本丟失後重跑全部遷移，已有資料不丟", () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			migrate(sql);
			db.exec("INSERT INTO app_settings (key, value) VALUES ('legacy_key', 'kept')");
			db.exec("DELETE FROM schema_migrations");

			expect(migrate(sql)).toBe(MIGRATIONS.length);
			expect(ledgerCount(db)).toBe(MIGRATIONS.length);
			expect(db.prepare("SELECT value FROM app_settings WHERE key = 'legacy_key'").all()).toEqual([{ value: "kept" }]);
		} finally {
			db.close();
		}
	});

	it("v1 覆蓋 kb_chunks_doc 索引與 kb_fts 虛擬表", () => {
		const db = new DatabaseSync(":memory:");
		try {
			migrate(sqlHandle(db));
			const indexes = (db.prepare("PRAGMA index_list(kb_chunks)").all() as { name: string }[]).map((row) => row.name);
			expect(indexes).toContain("kb_chunks_doc");
			db.exec("INSERT INTO kb_fts (title_tokens, body_tokens) VALUES ('migrator', 'versioned schema')");
			expect(db.prepare("SELECT rowid FROM kb_fts WHERE kb_fts MATCH 'migrator'").all()).toHaveLength(1);
		} finally {
			db.close();
		}
	});

	it("v3 建立 entry_kb_refs 旁路表，老庫補跑只應用一次", () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			migrate(sql);
			expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entry_kb_refs'").all()).toHaveLength(1);
			const pk = (db.prepare("PRAGMA table_info(entry_kb_refs)").all() as { name: string; pk: number }[])
				.filter((column) => column.pk > 0)
				.map((column) => column.name);
			expect(pk).toEqual(["conversation_id", "entry_id"]);

			db.exec("DELETE FROM schema_migrations WHERE version = 3");
			expect(migrate(sql)).toBe(1);
			expect(ledgerCount(db)).toBe(MIGRATIONS.length);
		} finally {
			db.close();
		}
	});

	it("v5 給老庫 shares 補開啟計數字段，舊行取預設值且重跑冪等", () => {
		const db = new DatabaseSync(":memory:");
		try {
			// 補列前的最小 shares 形狀（連 expires_at/theme 都沒有）
			db.exec(
				"CREATE TABLE shares (token TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)",
			);
			db.exec(
				"INSERT INTO shares (token, kind, session_id, name, created_at) VALUES ('old', 'file', '1', 'a.md', '2026-01-01T00:00:00Z')",
			);
			const sql = sqlHandle(db);
			migrate(sql);
			expect(columnsOf(db, "shares")).toEqual(
				expect.arrayContaining(["open_count", "last_opened_at", "opened_ip_hash"]),
			);
			expect(db.prepare("SELECT open_count, last_opened_at, opened_ip_hash FROM shares WHERE token = 'old'").all()).toEqual([
				{ open_count: 0, last_opened_at: 0, opened_ip_hash: "" },
			]);

			// 賬本丟失 / 重跑：ensureColumn 冪等，不拋也不重複計數
			expect(migrate(sql)).toBe(0);
			db.exec("DELETE FROM schema_migrations WHERE version = 5");
			expect(migrate(sql)).toBe(1);
			expect(db.prepare("SELECT open_count FROM shares WHERE token = 'old'").all()).toEqual([{ open_count: 0 }]);
		} finally {
			db.close();
		}
	});

	it("v6/v7 給老庫補技能 Hub 列與事件表，舊技能回填後仍可呼叫", () => {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec("CREATE TABLE skills (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, created_at TEXT NOT NULL)");
			db.exec(
				"INSERT INTO skills (name, description, content, created_at) VALUES ('legacy-skill', '舊技能', '# 正文', '2026-01-01T00:00:00Z')",
			);
			const sql = sqlHandle(db);
			migrate(sql);
			expect(columnsOf(db, "skills")).toEqual(
				expect.arrayContaining([
					"version",
					"source",
					"author",
					"license",
					"runtime",
					"tags",
					"content_hash",
					"audit_status",
					"audit_report",
					"manifest",
					"updated_at",
				]),
			);
			// 老資料回填：可呼叫、不被誤傷
			expect(
				db
					.prepare(
						"SELECT version, source, runtime, audit_status, tags, content_hash, updated_at FROM skills WHERE name = 'legacy-skill'",
					)
					.all(),
			).toEqual([
				{
					version: "0.0.0",
					source: "local",
					runtime: "prompt",
					audit_status: "pass",
					tags: "[]",
					content_hash: "",
					updated_at: "2026-01-01T00:00:00Z",
				},
			]);
			// 審計快取與事件表
			expect(db.prepare("PRAGMA table_info(skill_audits)").all()).toEqual(
				expect.arrayContaining([expect.objectContaining({ name: "content_hash" }), expect.objectContaining({ name: "rules_version" })]),
			);
			expect(columnsOf(db, "skill_events")).toEqual(
				expect.arrayContaining(["id", "name", "type", "source", "at", "meta"]),
			);
			// 冪等
			expect(migrate(sql)).toBe(0);
			db.exec("DELETE FROM schema_migrations WHERE version IN (6, 7)");
			expect(migrate(sql)).toBe(2);
		} finally {
			db.close();
		}
	});

	it("v8 給老庫 automations 補 last_status，舊行為 NULL 且重跑冪等", () => {
		const db = new DatabaseSync(":memory:");
		try {
			// 補列前的 automations 形狀
			db.exec(
				"CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', schedule TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_run_at INTEGER, next_run_at INTEGER NOT NULL)",
			);
			db.exec(
				`INSERT INTO automations (id, name, prompt, schedule, created_at, last_run_at, next_run_at) VALUES ('old', '早報', '跑', '{"kind":"daily","time":"09:00"}', '2026-01-01T00:00:00Z', 100, 200)`,
			);
			const sql = sqlHandle(db);
			migrate(sql);
			expect(columnsOf(db, "automations")).toEqual(expect.arrayContaining(["last_status"]));
			expect(db.prepare("SELECT last_status, last_run_at FROM automations WHERE id = 'old'").all()).toEqual([
				{ last_status: null, last_run_at: 100 },
			]);

			// 賬本丟失 / 重跑：ensureColumn 冪等
			expect(migrate(sql)).toBe(0);
			db.exec("DELETE FROM schema_migrations WHERE version = 8");
			expect(migrate(sql)).toBe(1);
		} finally {
			db.close();
		}
	});

	it("v10 給老庫 automations 補 fresh_session / last_session_id，存量任務預設每輪新會話", () => {
		const db = new DatabaseSync(":memory:");
		try {
			db.exec(
				"CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', schedule TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_run_at INTEGER, next_run_at INTEGER NOT NULL)",
			);
			db.exec(
				`INSERT INTO automations (id, name, prompt, session_id, schedule, created_at, last_run_at, next_run_at) VALUES ('old', '日報', '跑', '2991', '{"kind":"daily","time":"08:03"}', '2026-01-01T00:00:00Z', 100, 200)`,
			);
			const sql = sqlHandle(db);
			migrate(sql);
			expect(columnsOf(db, "automations")).toEqual(
				expect.arrayContaining(["fresh_session", "last_session_id"]),
			);
			// 存量任務：升級後預設新會話，舊的 2991 只作為最後一次執行的記錄保留在 session_id 上。
			expect(db.prepare("SELECT fresh_session, session_id, last_session_id FROM automations WHERE id = 'old'").all()).toEqual([
				{ fresh_session: 1, session_id: "2991", last_session_id: null },
			]);

			expect(migrate(sql)).toBe(0);
			db.exec("DELETE FROM schema_migrations WHERE version = 10");
			expect(migrate(sql)).toBe(1);
		} finally {
			db.close();
		}
	});

});
