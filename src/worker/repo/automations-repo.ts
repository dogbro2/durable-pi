import type { SqlHandle } from "../db/migrations";

/**
 * 定時任務倉儲（ADR-0001 §3）：只做 `automations` 的 SQL。
 * 排程計算（下一次執行時間、忙時順延）在 services/automation-service.ts。
 */
export type AutomationRow = {
	id: string;
	name: string;
	prompt: string;
	session_id: string;
	schedule: string;
	enabled: number;
	last_run_at: number | null;
	last_status: string | null;
	last_error: string | null;
	/** 每輪新建會話（NERE-84）：1 = 不繼承歷史，0 = 固定使用 `session_id`。 */
	fresh_session: number;
	/** 最近一次執行實際用的會話（NERE-84）。 */
	last_session_id: string | null;
	next_run_at: number;
};

export type AutomationDueRow = {
	id: string;
	prompt: string;
	session_id: string;
	schedule: string;
	fresh_session: number;
};

/** 上次執行結果（NERE-68）：成功 / 異常 / 會話忙順延。 */
export type AutomationLastStatus = "ok" | "failed" | "deferred";

const LAST_STATUSES: readonly AutomationLastStatus[] = ["ok", "failed", "deferred"];

/** 只透出三種已知值；老庫 NULL 與髒值都按 null（前端不渲染徽標）。 */
export function parseLastStatus(raw: unknown): AutomationLastStatus | null {
	return LAST_STATUSES.includes(raw as AutomationLastStatus) ? (raw as AutomationLastStatus) : null;
}

const SELECT =
	"SELECT id, name, prompt, session_id, schedule, enabled, last_run_at, last_status, last_error, fresh_session, last_session_id, next_run_at FROM automations";

export function list(sql: SqlHandle): AutomationRow[] {
	return sql.exec(`${SELECT} ORDER BY created_at DESC`).toArray() as AutomationRow[];
}

export function insert(
	sql: SqlHandle,
	row: { id: string; name: string; prompt: string; sessionId: string; schedule: string; nextRunAt: number; createdAt: string },
): void {
	sql.exec(
		"INSERT INTO automations (id, name, prompt, session_id, schedule, enabled, created_at, next_run_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
		row.id,
		row.name,
		row.prompt,
		row.sessionId,
		row.schedule,
		row.createdAt,
		row.nextRunAt,
	);
}

export function get(sql: SqlHandle, id: string): AutomationRow | null {
	const rows = sql.exec(`${SELECT} WHERE id = ?`, id).toArray() as AutomationRow[];
	return rows[0] ?? null;
}

/** 編輯（NERE-64）：只寫傳入的欄位；`nextRunAt` 由 service 決定後一併寫入。 */
export type AutomationUpdate = {
	name?: string;
	prompt?: string;
	sessionId?: string;
	schedule?: string;
	enabled?: boolean;
	/** `fresh_session`（NERE-84）：每輪新建會話開關。 */
	freshSession?: boolean;
	nextRunAt?: number;
};

export function update(sql: SqlHandle, id: string, patch: AutomationUpdate): void {
	const sets: string[] = [];
	const values: unknown[] = [];
	if (patch.name !== undefined) {
		sets.push("name = ?");
		values.push(patch.name);
	}
	if (patch.prompt !== undefined) {
		sets.push("prompt = ?");
		values.push(patch.prompt);
	}
	if (patch.sessionId !== undefined) {
		sets.push("session_id = ?");
		values.push(patch.sessionId);
	}
	if (patch.schedule !== undefined) {
		sets.push("schedule = ?");
		values.push(patch.schedule);
	}
	if (patch.enabled !== undefined) {
		sets.push("enabled = ?");
		values.push(patch.enabled ? 1 : 0);
	}
	if (patch.freshSession !== undefined) {
		sets.push("fresh_session = ?");
		values.push(patch.freshSession ? 1 : 0);
	}
	if (patch.nextRunAt !== undefined) {
		sets.push("next_run_at = ?");
		values.push(patch.nextRunAt);
	}
	if (!sets.length) return;
	sql.exec(`UPDATE automations SET ${sets.join(", ")} WHERE id = ?`, ...values, id);
}

export function remove(sql: SqlHandle, id: string): void {
	sql.exec("DELETE FROM automations WHERE id = ?", id);
}

/** 到點且啟用的任務（alarm 第一輪）。 */
export function listDue(sql: SqlHandle, now: number): AutomationDueRow[] {
	return sql
		.exec("SELECT id, prompt, session_id, schedule, fresh_session FROM automations WHERE enabled = 1 AND next_run_at <= ?", now)
		.toArray() as AutomationDueRow[];
}

/** 會話忙：只推 next_run_at 並記 deferred，不動 last_run_at。 */
export function markDeferred(sql: SqlHandle, id: string, nextRunAt: number): void {
	sql.exec("UPDATE automations SET next_run_at = ?, last_status = 'deferred' WHERE id = ?", nextRunAt, id);
}

/**
 * 把任務指向一個具體會話（NERE-84）：`fresh_session = 1` 每輪執行前呼叫，
 * `session_id` 與 `last_session_id` 一起更新，下一次執行從空會話開始。
 */
export function bindSession(sql: SqlHandle, id: string, sessionId: string): void {
	sql.exec("UPDATE automations SET session_id = ?, last_session_id = ? WHERE id = ?", sessionId, sessionId, id);
}

/**
 * 執行完一輪：寫 last_run_at、last_status（ok / failed）、last_session_id 與下一次 next_run_at；
 * 失敗時附原因（v1.0.4）。`last_session_id` 傳 null 時保留舊值（會話建立前就失敗的場景）。
 */
export function markRun(
	sql: SqlHandle,
	id: string,
	lastRunAt: number,
	nextRunAt: number,
	status: Exclude<AutomationLastStatus, "deferred">,
	error?: string | null,
	sessionId?: string | null,
): void {
	sql.exec(
		"UPDATE automations SET last_run_at = ?, last_status = ?, last_error = ?, next_run_at = ?, last_session_id = COALESCE(?, last_session_id) WHERE id = ?",
		lastRunAt,
		status,
		error ?? null,
		nextRunAt,
		sessionId ?? null,
		id,
	);
}

/** 全部順延（舊邏輯：本輪處理過任務時把所有仍在過去的 next_run_at 推到 now+60s）。 */
export function rescheduleOverdue(sql: SqlHandle, now: number, nextRunAt: number): void {
	sql.exec("UPDATE automations SET next_run_at = ? WHERE enabled = 1 AND next_run_at <= ?", nextRunAt, now);
}

/** 已啟用任務裡最早的下一次執行時間；沒有返回 null。 */
export function nextScheduledAt(sql: SqlHandle): number | null {
	const rows = sql
		.exec("SELECT MIN(next_run_at) AS next FROM automations WHERE enabled = 1 AND next_run_at > 0")
		.toArray() as { next: number | null }[];
	return typeof rows[0]?.next === "number" ? rows[0]!.next : null;
}

export function listForBackup(sql: SqlHandle): Record<string, unknown>[] {
	return sql
		.exec("SELECT id, name, prompt, session_id, schedule, enabled, next_run_at FROM automations")
		.toArray() as Record<string, unknown>[];
}

/** 恢復：按主鍵 upsert，保留既有 next_run_at（舊行為）。 */
export function restoreRow(
	sql: SqlHandle,
	row: { id: string; name: string; prompt: string; session_id: string; schedule: string; enabled: number; next_run_at: number },
	createdAt: string,
): void {
	sql.exec(
		"INSERT INTO automations (id, name, prompt, session_id, schedule, enabled, created_at, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, schedule = excluded.schedule, enabled = excluded.enabled",
		row.id,
		row.name,
		row.prompt,
		row.session_id,
		row.schedule,
		row.enabled,
		createdAt,
		row.next_run_at,
	);
}
