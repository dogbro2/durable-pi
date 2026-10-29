import type { SqlHandle } from "../db/migrations";

/**
 * 全域性設定倉儲（ADR-0001 §3）：只做 `app_settings` 的 SQL。
 * 語義收口（預設值、審批策略解析、Harness 重建時機）在 services/settings-service.ts。
 */
export function get(sql: SqlHandle, key: string, fallback: string): string {
	try {
		const rows = sql.exec("SELECT value FROM app_settings WHERE key = ?", key).toArray() as { value: string }[];
		return rows[0]?.value ?? fallback;
	} catch {
		return fallback;
	}
}

export function set(sql: SqlHandle, key: string, value: string): void {
	sql.exec(
		"INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		key,
		value,
	);
}

/** 備份條目（`{key, value}`），恢復按 key upsert。 */
export function listAll(sql: SqlHandle): { key: string; value: string }[] {
	return sql.exec("SELECT key, value FROM app_settings").toArray() as { key: string; value: string }[];
}

export function restoreRow(sql: SqlHandle, row: { key: string; value: string }): void {
	set(sql, row.key, row.value);
}
