import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import {
	createKbService,
	KbIngestError,
	type KbEnv,
	type KbSettings,
	type WebFetchResult,
} from "../../src/worker/services/kb-service";

/** 與 migrations.test.ts 相同的 SqlHandle 包裝：DDL 走 exec，查詢走 prepare().all()。
 *  繫結引數上限 100 與 SQLite-backed DO 對齊（NERE-66）：超出即拋錯，批次路徑必須自己分批。 */
function sqlHandle(db: DatabaseSync): SqlHandle {
	return {
		exec(query, ...bindings) {
			if (bindings.length > 100) throw new Error(`too many SQL variables (max 100, got ${bindings.length})`);
			if (!bindings.length && /^\s*(CREATE|ALTER|DROP)\b/i.test(query)) {
				db.exec(query);
				return { toArray: () => [] };
			}
			const rows = db.prepare(query).all(...(bindings as never[]));
			return { toArray: () => rows };
		},
	};
}

function withDb(run: (sql: SqlHandle) => Promise<void>): () => Promise<void> {
	return async () => {
		const db = new DatabaseSync(":memory:");
		try {
			const sql = sqlHandle(db);
			migrate(sql);
			await run(sql);
		} finally {
			db.close();
		}
	};
}

type FakeAi = { calls: { model: string; texts: string[] }[]; run(model: string, input: unknown): Promise<{ data?: number[][] }> };

function fakeAi(options: { failOnCall?: number } = {}): FakeAi {
	return {
		calls: [],
		async run(model, input) {
			// 計數以「這一批是第幾次 AI 呼叫」為準，用來模擬大批次索引中途失敗。
			if (this.calls.length + 1 === options.failOnCall) throw new Error("AI unavailable");
			const raw = input && typeof input === "object" && "text" in input ? input.text : [];
			const texts = Array.isArray(raw) ? raw.map(String) : [];
			this.calls.push({ model, texts });
			return { data: texts.map((_, index) => [1, index] as number[]) };
		},
	};
}

type VectorRow = { id: string; values: number[]; metadata?: Record<string, string | number> };
type VectorMatch = { id: string; score: number; metadata?: Record<string, string | number> };

type FakeVector = {
	upserts: VectorRow[];
	deleted: string[];
	queries: number;
	matches: VectorMatch[];
	upsert(vectors: VectorRow[]): Promise<unknown>;
	deleteByIds(ids: string[]): Promise<unknown>;
	query(vector: number[], options: Record<string, unknown>): Promise<{ matches?: VectorMatch[] }>;
};

function fakeVector(matches: VectorMatch[] = []): FakeVector {
	return {
		upserts: [],
		deleted: [],
		queries: 0,
		matches,
		async upsert(vectors) {
			this.upserts.push(...vectors);
		},
		async deleteByIds(ids) {
			this.deleted.push(...ids);
		},
		async query() {
			this.queries += 1;
			return { matches: this.matches };
		},
	};
}

const noFetch = async (): Promise<WebFetchResult> => ({ ok: false, kind: "error", message: "stub" });

function service(
	sql: SqlHandle,
	overrides: {
		env?: KbEnv;
		settings?: KbSettings;
		scopeId?: string;
		webFetch?: (url: string) => Promise<WebFetchResult>;
		now?: () => string;
	} = {},
) {
	return createKbService({
		sql,
		env: overrides.env ?? {},
		scopeId: overrides.scopeId ?? "scope-a",
		settings: overrides.settings ?? { get: (_key, fallback) => fallback },
		webFetch: overrides.webFetch ?? noFetch,
		now: overrides.now ?? (() => "2026-01-01T00:00:00.000Z"),
	});
}

const DOC = {
	title: "債券研究筆記",
	content: "信用債研究筆記\n\n久期是衡量利率風險的核心指標。組合久期 3.2 年，AA+ 城投佔比 40%。",
	source: "金標用例",
	tags: "固收",
};

/** 直接造未向量化分塊：reindex 只讀 kb_chunks，不需要文件行。 */
function seedChunks(sql: SqlHandle, count: number): void {
	for (let i = 0; i < count; i++) sql.exec("INSERT INTO kb_chunks (doc_id, seq, text) VALUES (?, ?, ?)", 1, i, `未向量化片段 ${i}`);
}

const hybridSettings: KbSettings = { get: (key, fallback) => (key === "kb_retrieval" ? "hybrid" : fallback) };

describe("kb-service：入庫與全文檢索", () => {
	it(
		"入庫後自動分塊，FTS 命中，刪除後不再命中",
		withDb(async (sql) => {
			const kb = service(sql);
			const added = await kb.add(DOC);
			expect(added.chunks).toBeGreaterThanOrEqual(1);

			const [doc] = kb.listDocs();
			expect(doc).toMatchObject({ id: added.id, title: DOC.title, source: DOC.source, tags: DOC.tags, chunks: added.chunks });
			expect(doc!.size).toBeGreaterThan(0);
			expect(kb.getDoc(added.id)?.content).toContain("久期");

			const hits = kb.search("久期");
			expect(hits[0]).toMatchObject({ docId: added.id, title: DOC.title });
			expect(hits[0]!.text).toContain("久期");

			expect(await kb.remove(added.id)).toBe(true);
			expect(kb.search("久期")).toEqual([]);
			expect(kb.listDocs()).toEqual([]);
			expect(await kb.remove(added.id)).toBe(false);
		}),
	);

	it(
		"預檢索塊受 kb_prefetch 開關控制",
		withDb(async (sql) => {
			await service(sql).add(DOC);
			const on = service(sql);
			expect(await on.prefetchBlock("組合久期怎麼看")).toContain("債券研究筆記");

			const off = service(sql, { settings: { get: (key, fallback) => (key === "kb_prefetch" ? "0" : fallback) } });
			expect(await off.prefetchBlock("組合久期怎麼看")).toBe("");
			expect((await off.prefetchPreview("久期")).block).toBe("");
		}),
	);
});

describe("kb-service：向量埠", () => {
	it(
		"未配置 AI / KB_VEC 時不可用，hybrid 回退 FTS",
		withDb(async (sql) => {
			const kb = service(sql, { settings: hybridSettings });
			expect(kb.vectorAvailable()).toBe(false);
			expect(kb.status()).toMatchObject({ available: false, mode: "hybrid", index: "pi-kb", model: "@cf/baai/bge-m3" });

			const added = await kb.addIndexed(DOC);
			expect(added.vectorized).toBe(0);

			const hits = await kb.searchAsync("久期");
			expect(hits.length).toBeGreaterThan(0);
			expect(hits[0]!.title).toBe("債券研究筆記");
		}),
	);

	it(
		"CF_DISABLE_VECTOR=1 時即使有標定也不建向量，hybrid 走 FTS",
		withDb(async (sql) => {
			const ai = fakeAi();
			const vec = fakeVector();
			const kb = service(sql, { env: { AI: ai, KB_VEC: vec, CF_DISABLE_VECTOR: "1" }, settings: hybridSettings });

			expect(kb.vectorAvailable()).toBe(false);
			const added = await kb.addIndexed(DOC);
			expect(added.vectorized).toBe(0);
			expect(ai.calls).toEqual([]);
			expect(vec.upserts).toEqual([]);

			const hits = await kb.searchAsync("久期");
			expect(hits[0]!.title).toBe("債券研究筆記");
			expect(ai.calls).toEqual([]);
		}),
	);

	it(
		"prefetchPreview 只檢索一次：hybrid 下 1 次 embedding、1 次向量查詢（NERE-82 P2-3）",
		withDb(async (sql) => {
			await service(sql).add(DOC);
			const chunkId = service(sql).search("久期")[0]!.chunkId;
			const ai = fakeAi();
			const vec = fakeVector([{ id: `scope-a:${chunkId}`, score: 0.9, metadata: { scope: "scope-a" } }]);
			const kb = service(sql, { env: { AI: ai, KB_VEC: vec }, settings: hybridSettings });

			const preview = await kb.prefetchPreview("久期");
			expect(preview.enabled).toBe(true);
			expect(preview.hits.length).toBeGreaterThan(0);
			expect(preview.block).toContain("債券研究筆記");
			expect(ai.calls).toHaveLength(1);
			expect(vec.queries).toBe(1);
		}),
	);

	it(
		"scopeId 進入向量 id 字首與 metadata，刪除按同一字首清理",
		withDb(async (sql) => {
			const ai = fakeAi();
			const vec = fakeVector();
			const kb = service(sql, { env: { AI: ai, KB_VEC: vec }, scopeId: "agent-42", settings: hybridSettings });

			expect(kb.vectorAvailable()).toBe(true);
			const added = await kb.addIndexed(DOC);
			expect(added.vectorized).toBeGreaterThan(0);
			expect(vec.upserts).toHaveLength(added.vectorized);
			for (const row of vec.upserts) {
				expect(row.id.startsWith("agent-42:")).toBe(true);
				expect(row.metadata?.scope).toBe("agent-42");
			}
			expect(kb.status()).toMatchObject({ available: true, total: added.chunks, indexed: added.vectorized });

			await kb.remove(added.id);
			expect(vec.deleted.sort()).toEqual(vec.upserts.map((row) => row.id).sort());
		}),
	);
});

describe("kb-service：向量索引重建分批（NERE-66）", () => {
	it(
		"reindex 500 條與預設 200 條批次都不超繫結引數上限，計數同步",
		withDb(async (sql) => {
			const ai = fakeAi();
			const vec = fakeVector();
			const kb = service(sql, { env: { AI: ai, KB_VEC: vec }, settings: hybridSettings });

			seedChunks(sql, 500);
			expect(await kb.reindex(500)).toEqual({ indexed: 500, remaining: 0 });
			expect(vec.upserts).toHaveLength(500);
			expect(kb.status()).toMatchObject({ total: 500, indexed: 500 });

			seedChunks(sql, 200);
			expect(await kb.reindex()).toEqual({ indexed: 200, remaining: 0 });
			expect(vec.upserts).toHaveLength(700);
			expect(kb.status()).toMatchObject({ total: 700, indexed: 700 });
		}),
	);
});

describe("kb-service：入庫向量索引補齊（NERE-78）", () => {
	/** 150 段 851 字正文：每段按 720 步長切成 2 塊，共 300 塊（低於 20 萬字符上限）。 */
	const LONG_CONTENT = Array.from({ length: 150 }, (_, i) => `P${String(i).padStart(3, "0")}${"甲".repeat(847)}`).join("\n\n");

	it(
		"300 段文件 addIndexed 迴圈建完向量，status 不再有 pending",
		withDb(async (sql) => {
			const ai = fakeAi();
			const vec = fakeVector();
			const kb = service(sql, { env: { AI: ai, KB_VEC: vec }, settings: hybridSettings });

			const added = await kb.addIndexed({ title: "長文件", content: LONG_CONTENT, source: "long.txt" });
			expect(added.chunks).toBe(300);
			expect(added.vectorized).toBe(300);
			expect(added.pending).toBe(0);
			expect(vec.upserts).toHaveLength(300);
			expect(kb.status()).toMatchObject({ total: 300, indexed: 300, pending: 0 });
			// 單次 embed 仍按既有批大小切分，逐批迴圈而不是把 300 段塞進一次呼叫。
			expect(Math.max(...ai.calls.map((call) => call.texts.length))).toBeLessThanOrEqual(16);
		}),
	);

	it(
		"中途 AI 失敗：已完成批次保留，響應與 status 的 pending 可輪詢",
		withDb(async (sql) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				// 第一批 200 段用 13 次呼叫；第 15 次（第二批 100 段內）失敗。
				const ai = fakeAi({ failOnCall: 15 });
				const vec = fakeVector();
				const kb = service(sql, { env: { AI: ai, KB_VEC: vec }, settings: hybridSettings });

				const added = await kb.addIndexed({ title: "長文件", content: LONG_CONTENT, source: "long.txt" });
				expect(added.vectorized).toBe(200);
				expect(added.pending).toBe(100);
				expect(vec.upserts).toHaveLength(200);
				expect(kb.status()).toMatchObject({ total: 300, indexed: 200, pending: 100 });
			} finally {
				warn.mockRestore();
			}
		}),
	);
});

describe("kb-service：連結匯入", () => {
	it(
		"抓取成功寫入知識庫，空頁面與非法連結拋領域錯誤",
		withDb(async (sql) => {
			const kb = service(sql, {
				webFetch: async (url) =>
					url.includes("empty")
						? { ok: false, kind: "empty", message: "頁面沒有可提取的正文。" }
						: { ok: true, title: "金標測試頁面", content: DOC.content },
			});

			const result = await kb.ingestUrl("https://example.com/golden");
			expect(result).toMatchObject({ ok: true, title: "金標測試頁面" });
			expect(result.chunks).toBeGreaterThan(0);
			expect(kb.listDocs()).toHaveLength(1);

			await expect(kb.ingestUrl("file:///etc/passwd")).rejects.toMatchObject({ status: 400, code: "invalid_url" });
			await expect(kb.ingestUrl(undefined)).rejects.toMatchObject({ status: 400, code: "invalid_url" });
			await expect(kb.ingestUrl("https://example.com/empty")).rejects.toMatchObject({ status: 422, code: "empty_content" });
		}),
	);

	it(
		"未知異常收斂為 internal_error",
		withDb(async (sql) => {
			const kb = service(sql, {
				webFetch: async () => {
					throw new Error("boom");
				},
			});
			const err = await kb.ingestUrl("https://example.com/boom").catch((e: unknown) => e);
			expect(err).toBeInstanceOf(KbIngestError);
			expect(err).toMatchObject({ status: 500, code: "internal_error", message: "匯入失敗，請稍後重試。" });
		}),
	);
});

describe("kb-service：預檢索引用（NERE-40）", () => {
	it(
		"命中時 refs 與注入塊逐條對應，帶文件定位資訊",
		withDb(async (sql) => {
			const added = await service(sql).add({ ...DOC, content: "久期是衡量利率風險的核心指標。久期越長，價格對利率越敏感。" });
			const result = await service(sql).prefetch("久期怎麼看");

			expect(result.block).toContain("債券研究筆記");
			expect(result.refs.length).toBeGreaterThan(0);
			// 塊裡每條參考資料一條 ref：分隔符數量 + 1
			expect(result.refs).toHaveLength(result.block.split("\n\n---\n\n").length);
			expect(result.refs[0]).toMatchObject({ docId: added.id, title: DOC.title, source: DOC.source });
			expect(result.refs[0]!.chunkSeq).toBeGreaterThanOrEqual(0);
			expect(result.refs[0]!.chunkId).toBeGreaterThan(0);
			for (const ref of result.refs) expect(result.block).toContain(ref.title);
		}),
	);

	it(
		"未命中 / 開關關閉 / 查詢過短都不產生引用",
		withDb(async (sql) => {
			await service(sql).add(DOC);
			expect(await service(sql).prefetch("今天天氣怎麼樣")).toEqual({ block: "", refs: [] });
			expect(await service(sql).prefetch("久")).toEqual({ block: "", refs: [] });

			const off = service(sql, { settings: { get: (key, fallback) => (key === "kb_prefetch" ? "0" : fallback) } });
			expect(await off.prefetch("久期怎麼看")).toEqual({ block: "", refs: [] });
		}),
	);

	it(
		"多文件命中時按 docId:chunkId 去重，refs 不重複",
		withDb(async (sql) => {
			const kb = service(sql);
			await kb.add({ title: "債券研究筆記", content: "久期是衡量利率風險的核心指標。", source: "a.md" });
			await kb.add({ title: "組合管理手冊", content: "組合久期與利率敏感度成正比。", source: "b.md" });
			const result = await kb.prefetch("久期");

			const keys = result.refs.map((ref) => `${ref.docId}:${ref.chunkId}`);
			expect(new Set(keys).size).toBe(keys.length);
			expect(result.refs.map((ref) => ref.title).sort()).toEqual(["債券研究筆記", "組合管理手冊"]);
		}),
	);
});

describe("kb-service：來源去重與版本替換（NERE-47）", () => {
	const OLD = { title: "匯入驗收", source: "report.pdf", tags: "驗收", content: "第一版正文。舊版本專用詞甲。\n\n結尾說明。" };
	const NEW = { ...OLD, content: "第二版正文。新版本專用詞乙。\n\n結尾說明。" };

	it(
		"同來源同正文重複入庫：複用 docId、chunk 不變、updated:false",
		withDb(async (sql) => {
			const kb = service(sql);
			const first = await kb.add(OLD);
			expect(first.updated).toBe(true);

			const second = await kb.add({ ...OLD, title: "改個標題也不該重複" });
			expect(second).toMatchObject({ id: first.id, chunks: first.chunks, updated: false });
			expect(kb.listDocs()).toHaveLength(1);
			expect(kb.listDocs()[0]!.chunks).toBe(first.chunks);
			// 命中已存在的文件時不改寫標題 / 時間
			expect(kb.getDoc(first.id)?.title).toBe(OLD.title);
		}),
	);

	it(
		"同來源不同正文：保留 docId、重建分塊，舊句子不再命中",
		withDb(async (sql) => {
			let tick = 0;
			const kb = service(sql, { now: () => `2026-01-0${++tick}T00:00:00.000Z` });
			const first = await kb.add(OLD);
			expect(kb.search("舊版本專用詞")).not.toEqual([]);

			const second = await kb.add(NEW);
			expect(second).toMatchObject({ id: first.id, updated: true });
			expect(kb.listDocs()).toHaveLength(1);
			expect(kb.getDoc(first.id)?.content).not.toContain("舊版本專用詞");
			expect(kb.search("舊版")).toEqual([]);
			expect(kb.search("舊版本專用詞").every((hit) => !hit.text.includes("舊版本專用詞"))).toBe(true);
			expect(kb.search("新版本專用詞").length).toBeGreaterThan(0);
			expect(kb.listDocs()[0]!.updatedAt > "2026-01-01T00:00:00.000Z").toBe(true);
		}),
	);

	it(
		"不同來源同正文各存一篇；無來源的貼上不去重",
		withDb(async (sql) => {
			const kb = service(sql);
			const a = await kb.add({ ...OLD, source: "a.pdf" });
			const b = await kb.add({ ...OLD, source: "b.pdf" });
			expect(b.id).not.toBe(a.id);

			const paste1 = await kb.add({ title: "貼上", content: "同一段貼上正文" });
			const paste2 = await kb.add({ title: "貼上", content: "同一段貼上正文" });
			expect(paste2.id).not.toBe(paste1.id);
			expect(kb.listDocs()).toHaveLength(4);
		}),
	);

	it(
		"版本替換刪除舊向量並按新分塊重建",
		withDb(async (sql) => {
			const ai = fakeAi();
			const vec = fakeVector();
			const kb = service(sql, { env: { AI: ai, KB_VEC: vec }, settings: hybridSettings });

			const first = await kb.addIndexed(OLD);
			const oldVectorIds = vec.upserts.map((row) => row.id);
			expect(oldVectorIds.length).toBeGreaterThan(0);

			const second = await kb.addIndexed(NEW);
			expect(second).toMatchObject({ id: first.id, updated: true });
			expect(vec.deleted.sort()).toEqual([...oldVectorIds].sort());

			const newVectors = vec.upserts.slice(oldVectorIds.length);
			expect(newVectors).toHaveLength(second.chunks);
			expect(newVectors.every((row) => !oldVectorIds.includes(row.id))).toBe(true);
		}),
	);
});
