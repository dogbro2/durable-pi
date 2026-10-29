import type { SqlHandle } from "../db/migrations";

/**
 * 分享倉儲（ADR-0001 §3）：只做 `shares` 表的 SQL，返回型別化記錄。
 * token 生成、TTL 解析、主題回落都在 services/share-service.ts。
 */
export type ShareKind = "conversation" | "file";

/** 清單過濾口徑：active = 未過期（含永久），expired = 已過期，all = 全部。 */
export type ShareStatus = "active" | "expired" | "all";

export type ShareRow = {
	token: string;
	kind: string;
	sessionId: string;
	name: string;
	expiresAt: number;
	theme: string;
	createdAt: string;
	openCount: number;
	lastOpenedAt: number;
};

/** 新建分享要落庫的欄位（已解析 TTL / 主題 / token）。 */
export type NewShareRow = {
	token: string;
	kind: ShareKind;
	sessionId: string;
	name: string;
	expiresAt: number;
	theme: string;
	createdAt: string;
};

/** 同一 IP 的開啟計數視窗：1 小時內只計 1 次（NERE-42）。 */
export const OPEN_DEDUPE_MS = 60 * 60 * 1000;

const SELECT =
	"SELECT token, kind, session_id AS sessionId, name, expires_at AS expiresAt, theme, created_at AS createdAt, open_count AS openCount, last_opened_at AS lastOpenedAt FROM shares";

/** 未過期的分享連結（新→舊）。 */
export function listUnexpired(sql: SqlHandle, sessionId: string, kind: ShareKind, name: string, now: number): ShareRow[] {
	return (
		kind === "file"
			? sql
					.exec(
						`${SELECT} WHERE kind = 'file' AND session_id = ? AND name = ? AND (expires_at = 0 OR expires_at > ?) ORDER BY created_at DESC`,
						sessionId,
						name,
						now,
					)
					.toArray()
			: sql
					.exec(
						`${SELECT} WHERE kind = 'conversation' AND session_id = ? AND (expires_at = 0 OR expires_at > ?) ORDER BY created_at DESC`,
						sessionId,
						now,
					)
					.toArray()
	) as ShareRow[];
}

/** 全量清單（NERE-42）：預設不呼叫方自己定型，SQL 只負責按狀態過濾。 */
export function listAll(sql: SqlHandle, status: ShareStatus, now: number): ShareRow[] {
	const where =
		status === "active"
			? " WHERE expires_at = 0 OR expires_at > ?"
			: status === "expired"
				? " WHERE expires_at > 0 AND expires_at <= ?"
				: "";
	const bindings = status === "all" ? [] : [now];
	return sql
		.exec(`${SELECT}${where} ORDER BY created_at DESC`, ...bindings)
		.toArray() as ShareRow[];
}

/** 按 token 取分享（含已過期：呼叫方負責 410）。 */
export function getByToken(sql: SqlHandle, token: string): ShareRow | undefined {
	const rows = sql
		.exec(`${SELECT} WHERE token = ?`, token)
		.toArray() as ShareRow[];
	return rows[0];
}

/**
 * 記一次開啟（NERE-42）。同一 IP 雜湊在視窗內重複開啟不改任何行（`open_count` 與
 * `last_opened_at` 都保持首次計入的值），因此 `last_opened_at` 的口徑是「最近一次計入開啟」。
 */
export function recordOpen(sql: SqlHandle, token: string, ipHash: string, at: number): void {
	sql.exec(
		`UPDATE shares SET open_count = open_count + 1, last_opened_at = ?, opened_ip_hash = ?
		WHERE token = ? AND NOT (opened_ip_hash = ? AND last_opened_at > ?)`,
		at,
		ipHash,
		token,
		ipHash,
		at - OPEN_DEDUPE_MS,
	);
}

/** 同一檔案最近一條未過期分享（會話分享頁裡的檔案卡用它給出口）。 */
export function latestTokenForFile(sql: SqlHandle, sessionId: string, name: string, now: number): string | undefined {
	const rows = sql
		.exec(
			"SELECT token FROM shares WHERE kind = 'file' AND session_id = ? AND name = ? AND (expires_at = 0 OR expires_at > ?) ORDER BY created_at DESC LIMIT 1",
			sessionId,
			name,
			now,
		)
		.toArray() as { token: string }[];
	return rows[0]?.token;
}

export function insert(sql: SqlHandle, row: NewShareRow): void {
	sql.exec(
		"INSERT INTO shares (token, kind, session_id, name, expires_at, theme, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		row.token,
		row.kind,
		row.sessionId,
		row.name,
		row.expiresAt,
		row.theme,
		row.createdAt,
	);
}

/** 撤銷分享（NERE-42）：命中返回 true，不存在返回 false。
 * `RETURNING` 讓「有沒有刪到」在一次往返里確定，避免再查一遍。 */
export function deleteByToken(sql: SqlHandle, token: string): boolean {
	const rows = sql.exec("DELETE FROM shares WHERE token = ? RETURNING token", token).toArray();
	return rows.length > 0;
}

/** 刪除某個會話的全部分享（會話級聯，NERE-24）：返回實際刪除行數。 */
export function deleteBySession(sql: SqlHandle, sessionId: string): number {
	return sql.exec("DELETE FROM shares WHERE session_id = ? RETURNING token", sessionId).toArray().length;
}

/** 刪除該 DO 的全部分享（使用者吊銷，NERE-24）：返回實際刪除行數，重複呼叫為 0。 */
export function deleteAll(sql: SqlHandle): number {
	const rows = sql.exec("SELECT COUNT(*) AS n FROM shares").toArray() as { n: number }[];
	sql.exec("DELETE FROM shares");
	return Number(rows[0]?.n ?? 0);
}

/** 清掉已過期的分享，避免表無限增長。 */
export function purgeExpired(sql: SqlHandle, now: number): void {
	sql.exec("DELETE FROM shares WHERE expires_at > 0 AND expires_at <= ?", now);
}

/** 備份：分享記錄全量（恢復不還原 shares，保持舊 /restore 語義）。 */
export function listForBackup(sql: SqlHandle): Record<string, unknown>[] {
	return sql
		.exec("SELECT token, kind, session_id, name, expires_at, theme, created_at FROM shares")
		.toArray() as Record<string, unknown>[];
}
