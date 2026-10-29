import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import { RULES_VERSION } from "../../src/worker/lib/skill-audit";
import { upsertSkill } from "../../src/worker/repo/skills-repo";
import { buildInstructions } from "../../src/worker/services/instructions-service";
import { createSkillService } from "../../src/worker/services/skill-service";

/**
 * NERE-82 P2-1 驗收：`/skills/hub` 與提示詞技能索引只讀後設資料列，
 * 100 個技能時讀取位元組數應與正文體積無關（一個量級下降）。
 */

type SqlStats = { selects: number; bytes: number; queries: string[] };

/** 與其它單測相同的 SqlHandle 包裝，另外統計 SELECT 的返回位元組。 */
function measuringSql(db: DatabaseSync): { sql: SqlHandle; stats: SqlStats } {
	const stats: SqlStats = { selects: 0, bytes: 0, queries: [] };
	return {
		stats,
		sql: {
			exec(query, ...bindings) {
				if (!bindings.length && /^\s*(CREATE|ALTER|DROP)\b/i.test(query)) {
					db.exec(query);
					return { toArray: () => [] };
				}
				const rows = db.prepare(query).all(...(bindings as never[]));
				if (/^\s*SELECT\b/i.test(query)) {
					stats.selects += 1;
					stats.bytes += JSON.stringify(rows).length;
					stats.queries.push(query);
				}
				return { toArray: () => rows };
			},
		},
	};
}

const CONTENT = "正文用於說明技能步驟。".repeat(1200); // ~13 KB
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;

function auditReport() {
	return JSON.stringify({
		status: "pass",
		reasons: [],
		detected: { runtime: "prompt", network: [], tools: [] },
		auditedAt: "2026-10-22T00:00:00Z",
		hash: CONTENT_HASH,
		rulesVersion: RULES_VERSION,
		auditSource: "local",
	});
}

function seed(sql: SqlHandle, count: number): void {
	for (let i = 0; i < count; i++) {
		upsertSkill(sql, {
			name: `skill-${String(i).padStart(3, "0")}`,
			description: `技能 ${i} 的用途說明`,
			content: CONTENT,
			version: "1.0.0",
			source: "local",
			author: "hou",
			license: "MIT",
			runtime: "prompt",
			tags: ["utility"],
			contentHash: CONTENT_HASH,
			auditStatus: "pass",
			auditReport: auditReport(),
			manifest: JSON.stringify({ name: `skill-${i}`, version: "1.0.0", runtime: "prompt", requires: { tools: [], bindings: [], network: [] } }),
			createdAt: "2026-10-22T00:00:00Z",
			updatedAt: "2026-10-22T00:00:00Z",
		});
	}
}

function reset(stats: SqlStats): void {
	stats.selects = 0;
	stats.bytes = 0;
	stats.queries = [];
}

describe("技能投影（NERE-82 P2-1）", () => {
	it("hub 只讀後設資料：100 個技能時讀取位元組數比全量行小一個量級以上", async () => {
		const db = new DatabaseSync(":memory:");
		const { sql, stats } = measuringSql(db);
		migrate(sql);
		seed(sql, 100);
		const service = createSkillService({ sql, settings: { get: (_key, fallback) => fallback } });
		const fullBytes = JSON.stringify(db.prepare("SELECT * FROM skills").all()).length;

		reset(stats);
		const hub = await service.hub({ installed: "1", limit: "100" });
		expect(hub.skills).toHaveLength(100);
		expect(stats.queries.some((query) => query.includes("FROM skills") && query.includes(", content,"))).toBe(false);
		expect(stats.bytes * 10).toBeLessThan(fullBytes);
		db.close();
	});

	it("提示詞技能索引只讀後設資料", async () => {
		const db = new DatabaseSync(":memory:");
		const { sql, stats } = measuringSql(db);
		migrate(sql);
		seed(sql, 100);
		const kb = { prefetch: async () => ({ block: "", refs: [] }) };
		const fullBytes = JSON.stringify(db.prepare("SELECT * FROM skills").all()).length;

		reset(stats);
		const result = await buildInstructions({ sql, settings: { get: (_key, fallback) => fallback }, kb: kb as never }, null);
		expect(result.instructions).toContain("skill-000");
		expect(stats.queries.some((query) => query.includes("FROM skills") && query.includes(", content,"))).toBe(false);
		expect(stats.bytes * 10).toBeLessThan(fullBytes);
		db.close();
	});
});
