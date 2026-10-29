import type { SqlHandle } from "../db/migrations";

/**
 * 只讀面板輔助倉儲（ADR-0001 §3）：`/capabilities` 需要 prompts / rules 的條目數。
 * 這兩個表的完整 CRUD 屬於其它域，本檔案只提供計數，避免 capabilities 服務內聯 SQL。
 */
export function countPrompts(sql: SqlHandle): number {
	return Number((sql.exec("SELECT COUNT(*) AS n FROM prompts").toArray() as { n: number }[])[0]?.n ?? 0);
}

export function countEnabledRules(sql: SqlHandle): number {
	return Number(
		(sql.exec("SELECT COUNT(*) AS n FROM rules WHERE enabled = 1").toArray() as { n: number }[])[0]?.n ?? 0,
	);
}
