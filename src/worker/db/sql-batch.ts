/**
 * SQLite-backed Durable Object 每條查詢最多 100 個繫結引數，超了直接拋錯。
 * 拼 `IN (?,…)` 時按 90 個一批切，給其它佔位符（doc_id、limit 等）留餘量。
 */
export const ID_BIND_LIMIT = 90;

/** 去重後按 `size` 切批；空輸入返回空陣列，呼叫方不需要額外判空。 */
export function chunkIds(ids: readonly number[], size = ID_BIND_LIMIT): number[][] {
	const unique = [...new Set(ids)];
	const batches: number[][] = [];
	for (let start = 0; start < unique.length; start += size) batches.push(unique.slice(start, start + size));
	return batches;
}
