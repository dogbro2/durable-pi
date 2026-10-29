import type { SqlHandle } from "../db/migrations";
import type { KbRef } from "../lib/kb";

/** `entry_kb_refs` 的型別化記錄（NERE-40）：assistant entry 的知識庫命中旁路儲存。 */
export type EntryKbRefsRow = { conversation_id: string; entry_id: number; refs: string; created_at: string };

/** 寬容解析落庫的 JSON：壞行按「無命中」處理，不讓一條髒資料拖垮整個 /entries。 */
export function parseKbRefs(raw: string | null | undefined): KbRef[] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const refs: KbRef[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== "object") continue;
		const row = item as Record<string, unknown>;
		const docId = Number(row.docId);
		const chunkId = Number(row.chunkId);
		const chunkSeq = Number(row.chunkSeq);
		if (!Number.isFinite(docId) || !Number.isFinite(chunkId) || !Number.isFinite(chunkSeq)) continue;
		if (typeof row.title !== "string") continue;
		const ref: KbRef = { docId, chunkId, chunkSeq, title: row.title };
		if (typeof row.source === "string" && row.source) ref.source = row.source;
		refs.push(ref);
	}
	return refs;
}

/** 覆蓋寫一條 entry 的命中；呼叫方保證 refs 非空。 */
export function upsert(sql: SqlHandle, conversationId: string, entryId: number, refs: readonly KbRef[], now: string): void {
	sql.exec(
		`INSERT INTO entry_kb_refs (conversation_id, entry_id, refs, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(conversation_id, entry_id) DO UPDATE SET refs = excluded.refs, created_at = excluded.created_at`,
		conversationId,
		entryId,
		JSON.stringify(refs),
		now,
	);
}

/**
 * 批次讀一個會話裡若干 entry 的命中，返回 entryId → refs（空命中不建鍵）。
 *
 * 用 `entry_id BETWEEN min AND max` 而不是 `IN (?,…)`：SQLite-backed DO 每條查詢最多
 * 100 個繫結引數，而 `/entries` 的一頁是 200 條，assistant 條目 ≥100 時 `IN` 列表會直接
 * 讓請求 500。entry id 全域性遞增，區間裡的空洞由 `requested` 過濾，繫結引數恆為 3 個。
 */
export function getMany(sql: SqlHandle, conversationId: string, entryIds: readonly number[]): Map<number, KbRef[]> {
	const found = new Map<number, KbRef[]>();
	if (!entryIds.length) return found;
	const requested = new Set<number>();
	let min = Infinity;
	let max = -Infinity;
	for (const raw of entryIds) {
		const id = Number(raw);
		if (!Number.isFinite(id)) continue;
		requested.add(id);
		if (id < min) min = id;
		if (id > max) max = id;
	}
	if (!requested.size) return found;
	const rows = sql
		.exec(
			"SELECT entry_id, refs FROM entry_kb_refs WHERE conversation_id = ? AND entry_id BETWEEN ? AND ?",
			conversationId,
			min,
			max,
		)
		.toArray() as { entry_id: number; refs: string }[];
	for (const row of rows) {
		const id = Number(row.entry_id);
		if (!requested.has(id)) continue;
		const refs = parseKbRefs(row.refs);
		if (refs.length) found.set(id, refs);
	}
	return found;
}

/** 刪除會話時清掉該會話的旁路行（與 `vfs_v2` 同一處呼叫）。 */
export function removeConversation(sql: SqlHandle, conversationId: string): number {
	return sql.exec("DELETE FROM entry_kb_refs WHERE conversation_id = ? RETURNING entry_id", conversationId).toArray().length;
}
