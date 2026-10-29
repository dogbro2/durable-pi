import type { SqlHandle } from "../db/migrations";
import * as memoryRepo from "../repo/memory-repo";

/**
 * 記憶域用例（ADR-0001 §2）：`pi_mem` 的讀寫。
 * 直接 SQL 在 `repo/memory-repo.ts`；LLM 抽取在 `services/reflect-service.ts`。
 */
export type MemoryService = {
	list(): memoryRepo.MemoryRow[];
	remove(id: number): void;
	clearAll(): number;
};

export function createMemoryService(sql: SqlHandle): MemoryService {
	return {
		list: () => memoryRepo.list(sql),
		// 舊端點對未命中 id 靜默成功；這裡保持同樣語義。
		remove: (id) => memoryRepo.remove(sql, id),
		clearAll: () => {
			const before = memoryRepo.count(sql);
			memoryRepo.removeAll(sql);
			return before;
		},
	};
}
