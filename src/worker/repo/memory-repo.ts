import type { SqlHandle } from "../db/migrations";

/** `pi_mem` 的型別化記錄（ADR-0001 §3）：記憶庫的讀寫入口。 */
export type MemoryRow = { id: number; content: string; created_at: string; source?: string };

/** 只讀面板：最近 200 條，按寫入倒序。 */
export function list(sql: SqlHandle): MemoryRow[] {
	return sql
		.exec("SELECT id, content, created_at, source FROM pi_mem ORDER BY id DESC LIMIT 200")
		.toArray() as MemoryRow[];
}

/** `recall` 工具：最近 500 條內容（打分在工具裡做）。 */
export function listContents(sql: SqlHandle, limit = 500): string[] {
	return (sql.exec("SELECT content FROM pi_mem ORDER BY id DESC LIMIT ?", limit).toArray() as { content: string }[]).map(
		(row) => row.content,
	);
}

/** 去重視窗：最新 300 條內容（reflect 用）。 */
export function listRecentContents(sql: SqlHandle, limit = 300): string[] {
	return (sql.exec("SELECT content FROM pi_mem ORDER BY id DESC LIMIT ?", limit).toArray() as { content: string }[]).map(
		(row) => row.content,
	);
}

/** 備份：全量，按 id 升序。 */
export function listForBackup(sql: SqlHandle): MemoryRow[] {
	return sql.exec("SELECT id, content, created_at, source FROM pi_mem ORDER BY id").toArray() as MemoryRow[];
}

/** 工具 / 使用者顯式儲存：`source` 走庫預設值（manual）。 */
export function insert(sql: SqlHandle, content: string, createdAt: string): void {
	sql.exec("INSERT INTO pi_mem (content, created_at) VALUES (?, ?)", content, createdAt);
}

/** reflect 抽取入庫：顯式標記來源。 */
export function insertFromReflect(sql: SqlHandle, content: string, createdAt: string): void {
	sql.exec("INSERT INTO pi_mem (content, created_at, source) VALUES (?, ?, 'reflect')", content, createdAt);
}

/** 恢復：按內容去重（與舊 restore 一致），來源預設 manual。 */
export function insertRestored(
	sql: SqlHandle,
	row: { content: string; createdAt: string; source: string },
): void {
	sql.exec(
		"INSERT INTO pi_mem (content, created_at, source) VALUES (?, ?, ?)",
		row.content,
		row.createdAt,
		row.source,
	);
}

export function existsByContent(sql: SqlHandle, content: string): boolean {
	return sql.exec("SELECT id FROM pi_mem WHERE content = ?", content).toArray().length > 0;
}

export function remove(sql: SqlHandle, id: number): void {
	sql.exec("DELETE FROM pi_mem WHERE id = ?", id);
}

export function count(sql: SqlHandle): number {
	const rows = sql.exec("SELECT COUNT(*) AS n FROM pi_mem").toArray() as { n: number }[];
	return Number(rows[0]?.n ?? 0);
}

export function removeAll(sql: SqlHandle): void {
	sql.exec("DELETE FROM pi_mem");
}
