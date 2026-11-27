// 版本化遷移器（ADR-0001 §9.4）：DDL 只在 DO 首次 open()/alarm() 時執行一次，
// 請求路徑不再執行 DDL。每條遷移必須自身冪等——SqlHandle 沒有事務入口。
export type SqlHandle = { exec(q: string, ...b: unknown[]): { toArray(): unknown[] } };

export type Migration = { version: number; name: string; up(sql: SqlHandle): void };

/**
 * ALTER TABLE ... ADD COLUMN 的冪等包裝：只吞 `duplicate column name`（老庫補列），
 * 表不存在等其它錯誤必須丟擲，避免把真正的 schema 缺陷靜默掉。
 */
export function ensureColumn(sql: SqlHandle, table: string, definition: string): void {
	try {
		sql.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
	} catch (err) {
		if (!/duplicate column name/i.test(String(err))) throw err;
	}
}

/** v1：現行 20 張業務表。先 CREATE 後 ALTER，空庫首啟一次得到完整 schema。 */
const initialSchema: Migration = {
	version: 1,
	name: "initial-schema",
	up(sql) {
		sql.exec(`CREATE TABLE IF NOT EXISTS pi_mem (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS vfs_v2 (conversation_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (conversation_id, name))`);
		sql.exec(`CREATE TABLE IF NOT EXISTS sessions_meta (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS skills (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, created_at TEXT NOT NULL)`);
		// 只讀分享（v0.9.0）；v0.38.0 起支援過期時間，v0.39.1 起記錄分享時的主題，
		// NERE-42 起記錄開啟次數 / 最近開啟時間 / 最近計入開啟的 IP 雜湊（不存原始 IP）
		sql.exec(`CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL DEFAULT 0, theme TEXT NOT NULL DEFAULT 'dark', created_at TEXT NOT NULL, open_count INTEGER NOT NULL DEFAULT 0, last_opened_at INTEGER NOT NULL DEFAULT 0, opened_ip_hash TEXT NOT NULL DEFAULT '')`);
		sql.exec(`CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', schedule TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_run_at INTEGER, next_run_at INTEGER NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, headers TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS reflect_state (conversation_id TEXT PRIMARY KEY, last_entry_id INTEGER NOT NULL, updated_at TEXT NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		// 分步計劃（update_plan 工具寫入）：每個會話一份最新計劃（v0.22.0）
		sql.exec(`CREATE TABLE IF NOT EXISTS plans (conversation_id TEXT PRIMARY KEY, steps TEXT NOT NULL, updated_at TEXT NOT NULL)`);
		// 提示模板與規則檔案（v0.31.0）：純資料能力，執行時載入
		sql.exec(`CREATE TABLE IF NOT EXISTS prompts (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, created_at TEXT NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS rules (name TEXT PRIMARY KEY, content TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`);
		// 使用者知識庫（v0.45.0）：每個使用者一個獨立 DO，文件、分塊與 FTS5 索引都落在自己的庫
		sql.exec(`CREATE TABLE IF NOT EXISTS kb_docs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS kb_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL)`);
		sql.exec(`CREATE INDEX IF NOT EXISTS kb_chunks_doc ON kb_chunks(doc_id)`);
		// rowid 複用 kb_chunks.id；標題與正文分列，bm25 可分別加權
		sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(title_tokens, body_tokens)`);
		// 目標模式（v0.31.0）：一個會話一個目標，active 時按 token 預算與輪次自動續轉
		sql.exec(`CREATE TABLE IF NOT EXISTS goals (session_id TEXT PRIMARY KEY, objective TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', token_budget INTEGER NOT NULL DEFAULT 200000, baseline_tokens INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, max_turns INTEGER NOT NULL DEFAULT 12, summary TEXT NOT NULL DEFAULT '', next_run_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
		// 互動式問答（v0.37.0）：ask_user 工具提出的問題，等使用者點選後帶回模型
		sql.exec(`CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, answered_at TEXT)`);
		// 自定義工具（v0.36.0）：使用者貼一段 JS，沙箱執行後成為模型可呼叫的工具
		sql.exec(`CREATE TABLE IF NOT EXISTS custom_tools (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', parameters TEXT NOT NULL DEFAULT '{}', code TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`);
		// 工具審批（v0.33.0）：待審批請求 + 已授予的放行許可
		sql.exec(`CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool TEXT NOT NULL, category TEXT NOT NULL, args TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT)`);
		sql.exec(`CREATE TABLE IF NOT EXISTS approval_grants (session_id TEXT NOT NULL, tool TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, PRIMARY KEY (session_id, tool))`);
		// LLM 供應商（v0.27.0）：CCswitch 式自定義 OpenAI 相容端點
		sql.exec(`CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL, models TEXT NOT NULL, created_at TEXT NOT NULL)`);
		// 老庫補列：sessions_meta 的五列曾因 ALTER 跑在 CREATE 之前被靜默吞掉。
		ensureColumn(sql, "sessions_meta", `deleted INTEGER NOT NULL DEFAULT 0`);
		ensureColumn(sql, "sessions_meta", `model TEXT NOT NULL DEFAULT 'deepseek-flash'`);
		// v0.29.0：子代理會話不出現在側欄
		ensureColumn(sql, "sessions_meta", `hidden INTEGER NOT NULL DEFAULT 0`);
		// v0.32.0：會話分支——記錄分叉來源與分叉點條目
		ensureColumn(sql, "sessions_meta", `parent_id TEXT`);
		ensureColumn(sql, "sessions_meta", `fork_at INTEGER`);
		// 老庫補列（SHARES 建表語句已含兩列）
		ensureColumn(sql, "shares", `expires_at INTEGER NOT NULL DEFAULT 0`);
		ensureColumn(sql, "shares", `theme TEXT NOT NULL DEFAULT 'dark'`);
		// 向量索引狀態（v0.53.0）：1 = 已寫入 Vectorize
		ensureColumn(sql, "kb_chunks", `vectorized INTEGER NOT NULL DEFAULT 0`);
		// pi_mem.source: manual（使用者/工具顯式儲存）或 reflect（會話末自動抽取）。老庫補列。
		ensureColumn(sql, "pi_mem", `source TEXT NOT NULL DEFAULT 'manual'`);
	},
};

/** v2：舊版全域性檔案表 → 遷到 v2 的根會話（'1'），然後丟棄舊錶。 */
const vfsRootConversation: Migration = {
	version: 2,
	name: "vfs-files-to-root-conversation",
	up(sql) {
		const legacy = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='vfs_files'").toArray() as { name: string }[];
		if (!legacy.length) return;
		sql.exec(`INSERT OR IGNORE INTO vfs_v2 (conversation_id, name, content, updated_at) SELECT '1', name, content, updated_at FROM vfs_files`);
		sql.exec(`DROP TABLE IF EXISTS vfs_files`);
	},
};

/**
 * v3：assistant entry 的知識庫命中旁路表（NERE-40）。
 * Harness 的 `Entry<never>` 不承載自定義欄位，命中按 (conversation_id, entry_id) 另存，
 * `/entries` 序列化時再合併；刪除會話/會話歷史時行會失去引用，讀取側按 entry 存在與否過濾即可。
 */
const entryKbRefs: Migration = {
	version: 3,
	name: "entry-kb-refs",
	up(sql) {
		sql.exec(
			`CREATE TABLE IF NOT EXISTS entry_kb_refs (
				conversation_id TEXT NOT NULL,
				entry_id INTEGER NOT NULL,
				refs TEXT NOT NULL,
				created_at TEXT NOT NULL,
				PRIMARY KEY (conversation_id, entry_id)
			)`,
		);
	},
};

/**
 * v4：知識庫匯入按 source 查重（NERE-47）。只給來源列建索引，
 * 不新增表、不改現有行；歷史重複文件不做破壞性清理。
 */
const kbSourceIndex: Migration = {
	version: 4,
	name: "kb-docs-source-index",
	up(sql) {
		sql.exec(`CREATE INDEX IF NOT EXISTS kb_docs_source ON kb_docs(source)`);
	},
};

/**
 * v5：分享開啟記錄（NERE-42）。老庫補三列，新庫由 v1 建表語句直接帶上；
 * 冪等靠 ensureColumn（重跑或賬本丟失都不會失敗）。
 */
const shareOpenTracking: Migration = {
	version: 5,
	name: "share-open-tracking",
	up(sql) {
		ensureColumn(sql, "shares", `open_count INTEGER NOT NULL DEFAULT 0`);
		ensureColumn(sql, "shares", `last_opened_at INTEGER NOT NULL DEFAULT 0`);
		// 最近一次計入開啟數的客戶端 IP 的雜湊；原始 IP 不落庫
		ensureColumn(sql, "shares", `opened_ip_hash TEXT NOT NULL DEFAULT ''`);
	},
};

/**
 * v6：Skill Hub 目錄索引與審計（NERE-55 / 契約 §5.6）。
 * skills 增量列全部帶預設值，老庫升級即完成回填：runtime=prompt、audit_status=pass、source=local、version=0.0.0。
 * 不重寫 content、不改既有審計狀態；`updated_at` 用 created_at 補。
 */
const skillHubColumns: Migration = {
	version: 6,
	name: "skill-hub-columns",
	up(sql) {
		ensureColumn(sql, "skills", `version TEXT NOT NULL DEFAULT '0.0.0'`);
		ensureColumn(sql, "skills", `source TEXT NOT NULL DEFAULT 'local'`);
		ensureColumn(sql, "skills", `author TEXT NOT NULL DEFAULT ''`);
		ensureColumn(sql, "skills", `license TEXT NOT NULL DEFAULT 'UNLICENSED'`);
		ensureColumn(sql, "skills", `runtime TEXT NOT NULL DEFAULT 'prompt'`);
		ensureColumn(sql, "skills", `tags TEXT NOT NULL DEFAULT '[]'`);
		ensureColumn(sql, "skills", `content_hash TEXT NOT NULL DEFAULT ''`);
		ensureColumn(sql, "skills", `audit_status TEXT NOT NULL DEFAULT 'pass'`);
		ensureColumn(sql, "skills", `audit_report TEXT NOT NULL DEFAULT '{}'`);
		ensureColumn(sql, "skills", `manifest TEXT`);
		ensureColumn(sql, "skills", `updated_at TEXT NOT NULL DEFAULT ''`);
		sql.exec(`UPDATE skills SET updated_at = created_at WHERE updated_at = ''`);
		sql.exec(
			`CREATE TABLE IF NOT EXISTS skill_audits (
				content_hash TEXT NOT NULL,
				rules_version INTEGER NOT NULL,
				status TEXT NOT NULL,
				report TEXT NOT NULL,
				audited_at TEXT NOT NULL,
				PRIMARY KEY (content_hash, rules_version)
			)`,
		);
	},
};

/**
 * v7：技能域埋點（NERE-55 追加範圍 A / NERE-59 解鎖要求）。
 * 與 NERE-42 的分享計數完全獨立：單獨建表，不引用 shares、不共用口徑。
 */
const skillEvents: Migration = {
	version: 7,
	name: "skill-events",
	up(sql) {
		sql.exec(
			`CREATE TABLE IF NOT EXISTS skill_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				type TEXT NOT NULL,
				source TEXT NOT NULL DEFAULT '',
				at INTEGER NOT NULL,
				meta TEXT NOT NULL DEFAULT ''
			)`,
		);
		sql.exec(`CREATE INDEX IF NOT EXISTS skill_events_type_at ON skill_events(type, at)`);
		sql.exec(`CREATE INDEX IF NOT EXISTS skill_events_name_type ON skill_events(name, type)`);
	},
};

/**
 * v8：定時任務上次執行結果（NERE-68）。`ok|failed|deferred`；老資料為 NULL。
 * 順延只寫 `deferred`，不動 `last_run_at`——順延不算一次已執行。
 */
const automationLastStatus: Migration = {
	version: 8,
	name: "automation-last-status",
	up(sql) {
		ensureColumn(sql, "automations", "last_status TEXT");
	},
};

/** v1.0.4：失敗原因落庫（08:03 日報失敗時只有 console.warn，事後無法回溯）。 */
const automationLastError: Migration = {
	version: 9,
	name: "automation-last-error",
	up(sql) {
		ensureColumn(sql, "automations", "last_error TEXT");
	},
};

/**
 * v10：定時任務執行隔離（NERE-84）。`fresh_session = 1` 的任務每輪新建會話，
 * 避免把全部歷史塞進單輪上下文；`last_session_id` 記錄最近一次執行實際用的會話。
 * 存量任務預設 1：0803 日報失敗過兩次，升級後下一次執行就從空會話開始。
 */
const automationFreshSession: Migration = {
	version: 10,
	name: "automation-fresh-session",
	up(sql) {
		ensureColumn(sql, "automations", "fresh_session INTEGER NOT NULL DEFAULT 1");
		ensureColumn(sql, "automations", "last_session_id TEXT");
	},
};

/**
 * v11：專案（一個專案 = 一個長期會話，帶自己的資料夾與專案指令）。
 * `kind` 為 chat / project；`instructions` 只對專案生效，每輪注入。
 */
const projectSessions: Migration = {
	version: 11,
	name: "project-sessions",
	up(sql) {
		ensureColumn(sql, "sessions_meta", "kind TEXT NOT NULL DEFAULT 'chat'");
		ensureColumn(sql, "sessions_meta", "instructions TEXT NOT NULL DEFAULT ''");
	},
};

export const MIGRATIONS: readonly Migration[] = [
	initialSchema,
	vfsRootConversation,
	entryKbRefs,
	kbSourceIndex,
	shareOpenTracking,
	skillHubColumns,
	skillEvents,
	automationLastStatus,
	automationLastError,
	automationFreshSession,
	projectSessions,
];

// 版本號是賬本的唯一真源：重複或亂序會被 INSERT OR IGNORE 靜默跳過，模組載入時就暴露。
const migrationVersions = MIGRATIONS.map((migration) => migration.version);
if (migrationVersions.some((version, i) => i > 0 && version <= migrationVersions[i - 1])) {
	throw new Error("MIGRATIONS 必須按 version 嚴格遞增且不重複");
}

/** 按 version 升序執行未應用的遷移，成功後寫賬本；返回本次應用條數。 */
export function migrate(sql: SqlHandle, now: () => string = () => new Date().toISOString()): number {
	sql.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
	const applied = new Set(
		(sql.exec("SELECT version FROM schema_migrations").toArray() as { version: number }[]).map((row) => Number(row.version)),
	);
	let count = 0;
	for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
		if (applied.has(migration.version)) continue;
		migration.up(sql);
		sql.exec(
			"INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
			migration.version,
			migration.name,
			now(),
		);
		count += 1;
	}
	return count;
}

/* ---------------- UserRegistry（獨立 DO 庫） ---------------- */

/**
 * 登錄檔自己的庫只存 `users`。DDL 同樣留在遷移器裡（階段 6），
 * `UserRegistry.fetch` 不再內聯 `CREATE TABLE`。
 */
export const REGISTRY_MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "users-schema",
		up(sql) {
			sql.exec(
				`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', code_hash TEXT NOT NULL UNIQUE, code_hint TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_used_at TEXT)`,
			);
		},
	},
	{
		// v1.1.0：登入失敗計數（按來源 IP），用於限制爆破。
		version: 2,
		name: "login-failures",
		up(sql) {
			sql.exec(
				`CREATE TABLE IF NOT EXISTS login_failures (ip TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start TEXT NOT NULL, blocked_until TEXT)`,
			);
		},
	},
];

/** 登錄檔遷移：與業務庫同一賬本協議，互不引用。 */
export function migrateRegistry(sql: SqlHandle, now: () => string = () => new Date().toISOString()): number {
	sql.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
	const applied = new Set(
		(sql.exec("SELECT version FROM schema_migrations").toArray() as { version: number }[]).map((row) => Number(row.version)),
	);
	let count = 0;
	for (const migration of [...REGISTRY_MIGRATIONS].sort((a, b) => a.version - b.version)) {
		if (applied.has(migration.version)) continue;
		migration.up(sql);
		sql.exec(
			"INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
			migration.version,
			migration.name,
			now(),
		);
		count += 1;
	}
	return count;
}
