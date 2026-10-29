import type { SqlHandle } from "../db/migrations";

/** `sessions_meta` 的型別化記錄（ADR-0001 §3）：只做 SQL，不做 HTTP 或許可權判斷。 */
export type SessionMetaRow = {
	id: string;
	title: string;
	created_at: string;
	updated_at: string;
	model?: string;
	parent_id?: string | null;
	fork_at?: number | null;
};

/** 會話列表只返回未刪除、未隱藏的後設資料，按更新時間倒序（與舊 listSessions 一致）。 */
export function listVisible(sql: SqlHandle): SessionMetaRow[] {
	return sql
		.exec(
			"SELECT id, title, created_at, updated_at, model, parent_id, fork_at FROM sessions_meta WHERE deleted = 0 AND hidden = 0 ORDER BY updated_at DESC",
		)
		.toArray() as SessionMetaRow[];
}

export function get(sql: SqlHandle, id: string): { id: string; title: string } | undefined {
	const rows = sql.exec("SELECT id, title FROM sessions_meta WHERE id = ?", id).toArray() as { id: string; title: string }[];
	return rows[0];
}

export function getModel(sql: SqlHandle, id: string): string | undefined {
	const rows = sql.exec("SELECT model FROM sessions_meta WHERE id = ?", id).toArray() as { model?: string }[];
	return rows[0]?.model;
}

/** 已存在的行（含 deleted/hidden）用於判定儲存裡補出來的 id 是否已被刪除/隱藏。 */
export function listKnownIds(sql: SqlHandle): string[] {
	return (sql.exec("SELECT id FROM sessions_meta").toArray() as { id: string }[]).map((row) => row.id);
}

export function insertIfAbsent(sql: SqlHandle, id: string, title: string, now: string): void {
	sql.exec(
		"INSERT INTO sessions_meta (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
		id,
		title,
		now,
		now,
	);
}

export function insertFork(
	sql: SqlHandle,
	fork: { id: string; title: string; now: string; model: string; parentId: string; forkAt: number },
): void {
	sql.exec(
		`INSERT INTO sessions_meta (id, title, created_at, updated_at, model, parent_id, fork_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET title = excluded.title, parent_id = excluded.parent_id, fork_at = excluded.fork_at, updated_at = excluded.updated_at`,
		fork.id,
		fork.title,
		fork.now,
		fork.now,
		fork.model,
		fork.parentId,
		fork.forkAt,
	);
}

export function rename(sql: SqlHandle, id: string, title: string, now: string): void {
	sql.exec("UPDATE sessions_meta SET title = ?, updated_at = ? WHERE id = ?", title, now, id);
}

export function markDeleted(sql: SqlHandle, id: string, now: string): void {
	sql.exec("UPDATE sessions_meta SET deleted = 1, updated_at = ? WHERE id = ?", now, id);
}

export function setModel(sql: SqlHandle, id: string, model: string): void {
	sql.exec("UPDATE sessions_meta SET model = ? WHERE id = ?", model, id);
}

/** `POST /model`：會話行不存在時補建（舊端點行為，標題固定「新會話」）。 */
export function upsertModel(sql: SqlHandle, id: string, model: string, now: string): void {
	sql.exec(
		"INSERT INTO sessions_meta (id, title, created_at, updated_at, model) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET model = excluded.model",
		id,
		"新會話",
		now,
		now,
		model,
	);
}

/** 子代理會話在側欄不可見：審批閘門據此直接放行。 */
export function isHidden(sql: SqlHandle, id: string): boolean {
	try {
		const rows = sql.exec("SELECT hidden FROM sessions_meta WHERE id = ?", id).toArray() as { hidden?: number }[];
		return Number(rows[0]?.hidden ?? 0) === 1;
	} catch {
		return false;
	}
}

/** 首輪對話寫入標題（行不存在時補建）：標題策略在 chat-service，倉儲只做 SQL。 */
export function upsertTitle(sql: SqlHandle, id: string, title: string, now: string): void {
	sql.exec(
		"INSERT INTO sessions_meta (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
		id,
		title,
		now,
		now,
	);
}

/** 已命名會話只重新整理 updated_at。 */
export function touchUpdatedAt(sql: SqlHandle, id: string, now: string): void {
	sql.exec("UPDATE sessions_meta SET updated_at = ? WHERE id = ?", now, id);
}

/** 備份：未刪除會話的後設資料（不含 deleted/hidden）。 */
export function listForBackup(
	sql: SqlHandle,
): { id: string; title: string; created_at: string; updated_at: string; model: string }[] {
	return sql
		.exec("SELECT id, title, created_at, updated_at, model FROM sessions_meta WHERE deleted = 0")
		.toArray() as { id: string; title: string; created_at: string; updated_at: string; model: string }[];
}

/** 恢復：按 id upsert 標題與模型（舊 restore 只更新這兩列）。 */
export function restoreRow(
	sql: SqlHandle,
	row: { id: string; title: string; created_at: string; updated_at: string; model: string },
): void {
	sql.exec(
		"INSERT INTO sessions_meta (id, title, created_at, updated_at, model) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, model = excluded.model",
		row.id,
		row.title,
		row.created_at,
		row.updated_at,
		row.model,
	);
}

/** 子代理會話（dispatch_tasks）：隱藏、不覆蓋已有行。 */
export function insertHiddenIfAbsent(sql: SqlHandle, id: string, title: string, now: string): void {
	sql.exec(
		"INSERT INTO sessions_meta (id, title, created_at, updated_at, hidden) VALUES (?, ?, ?, ?, 1) ON CONFLICT(id) DO NOTHING",
		id,
		title,
		now,
		now,
	);
}
