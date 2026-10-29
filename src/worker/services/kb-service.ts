import type { SqlHandle } from "../db/migrations";
import { AppError } from "../http/errors";
import {
	KB_MAX_CHUNKS,
	KB_MAX_CONTENT,
	KB_PREFETCH_CHARS,
	KB_PREFETCH_TOP,
	kbChunkText,
	kbFtsQuery,
	kbRrfMerge,
	kbTokens,
	type KbHit,
	type KbRef,
} from "../lib/kb";
import {
	chunksByIds,
	countChunks,
	countChunksForDoc,
	countUnvectorized,
	countUnvectorizedForDoc,
	countVectorized,
	deleteChunks,
	deleteDoc,
	deleteFts,
	docExists,
	docExistsByContent,
	findDocBySource,
	getDoc,
	insertChunk,
	insertDoc,
	insertFts,
	listChunkIds,
	listBackupDocs,
	listDocs,
	listUnvectorized,
	markVectorized,
	searchFts,
	searchLike,
	updateDoc,
	type KbDocDetail,
	type KbDocRow,
	type KbBackupDoc,
} from "../repo/kb-repo";

/* ---------------- 埠（ADR-0001 §2：顯式注入，服務不讀模組級請求作用域） ----------------
 * env 提供 AI / Vectorize / 開關繫結；scopeId 由 RequestContext 傳入（向量 id 字首與過濾）；
 * settings 替代 getSetting；webFetch 是工具箱端點提供的抓取介面卡（ingest 連結用）。
 */
export type KbEnv = { AI?: unknown; KB_VEC?: unknown; CF_DISABLE_VECTOR?: string };
export type KbSettings = { get(key: string, fallback: string): string };
export type WebFetchResult = { ok: true; title: string; content: string } | { ok: false; kind: "empty" | "error"; message: string };

export type KbRetrievalMode = "fts" | "vector" | "hybrid";
type KbVectorMatch = { id: string; score: number; metadata?: { docId?: number; chunkSeq?: number; scope?: string } };
type KbVectorBindings = {
	ai: { run(model: string, input: unknown): Promise<{ data?: number[][] }> };
	vec: {
		upsert(vectors: { id: string; values: number[]; metadata?: Record<string, string | number> }[]): Promise<unknown>;
		deleteByIds(ids: string[]): Promise<unknown>;
		query(vector: number[], options: Record<string, unknown>): Promise<{ matches?: KbVectorMatch[] }>;
	};
};

export const KB_VECTOR_DEFAULT_INDEX = "pi-kb";
const KB_EMBED_MODEL = "@cf/baai/bge-m3";
const KB_EMBED_BATCH = 16;
export const KB_VECTOR_BATCH = 200;

/* ---------------- 匯入（v0.56.0） ----------------
 * 檔案：MD / TXT 直接讀文本；PDF / DOCX 走 Workers AI 的 toMarkdown，不引解析庫。
 * 連結：複用 web_fetch_page 的 /v1/tools/fetch，標題取頁面 title。
 * 失敗一律拋 KbIngestError，由 Route 對映為 { ok:false, code, message }，不靜默。
 */
const KB_INGEST_MAX_BYTES = 25 * 1024 * 1024;
const KB_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type KbIngestErrorCode =
	| "too_large"
	| "unsupported_type"
	| "empty_content"
	| "ai_unavailable"
	// 契約之外的擴充套件碼：連結不合法 / 抓取服務失敗 / 其它內部錯誤
	| "invalid_url"
	| "fetch_failed"
	| "internal_error";

export class KbIngestError extends AppError {
	declare readonly code: KbIngestErrorCode;
	constructor(status: number, code: KbIngestErrorCode, message: string) {
		super(code, status, message);
		this.name = "KbIngestError";
	}
}

type KbIngestFileKind = "pdf" | "docx" | "text";
type KbMarkdownConversion = { format?: string; data?: string; error?: string };
type KbMarkdownAi = { toMarkdown(input: { name: string; blob: Blob }): Promise<KbMarkdownConversion | KbMarkdownConversion[]> };

export type KbAddInput = { title: string; content: string; source?: string; tags?: string };
/** updated=false 只表示「同來源同正文已存在」，本次未寫庫；新建與版本替換都是 true。 */
export type KbAddResult = { id: number; chunks: number; updated: boolean };
export type KbIngestOk = {
	ok: true;
	docId: string;
	title: string;
	chunks: number;
	chars: number;
	updated: boolean;
	/** 本次入庫後已建向量的分塊數；向量未啟用時為 0。 */
	vectorized: number;
	/** 該文件仍未建向量的分塊數；可用 `/kb/status` 輪詢，或 `/kb/reindex` 續建。 */
	pending: number;
};
export type KbStatus = {
	mode: KbRetrievalMode;
	available: boolean;
	index: string;
	model: string;
	total: number;
	indexed: number;
	pending: number;
};
export type KbPrefetchPreview = { enabled: boolean; hits: KbHit[]; block: string };
/** 本輪預檢索結果：注入 instructions 的塊 + 與之逐條對應的結構化引用（NERE-40）。 */
export type KbPrefetch = { block: string; refs: KbRef[] };

export type KbServiceDeps = {
	sql: SqlHandle;
	env: KbEnv;
	scopeId: string;
	settings: KbSettings;
	/** 外部抓取介面卡：返回結構化結果，不拋 HTTP 語義錯誤。 */
	webFetch(url: string): Promise<WebFetchResult>;
	/** 可注入時鐘，便於測試；預設取當前 ISO 時間。 */
	now?: () => string;
};

export interface KbService {
	listDocs(): KbDocRow[];
	getDoc(id: number): KbDocDetail | undefined;
	/** 備份匯出用的全量文件（含正文，snake_case 列名）。 */
	backupDocs(): KbBackupDoc[];
	/** 恢復備份用的同標題同正文判定。 */
	hasDoc(title: string, content: string): boolean;
	/** 純入庫 / 版本替換（恢復備份走這條，不建向量）。 */
	add(input: KbAddInput): Promise<KbAddResult>;
	/** 入庫並按當前檢索模式增量建向量。 */
	addIndexed(input: KbAddInput): Promise<KbAddResult & { vectorized: number; pending: number }>;
	/** 刪除文件、分塊、FTS 行與已寫入的向量；文件不存在返回 false。 */
	remove(id: number): Promise<boolean>;
	search(query: string, limit?: number): KbHit[];
	searchAsync(query: string, limit?: number, modeOverride?: KbRetrievalMode): Promise<KbHit[]>;
	retrievalMode(): KbRetrievalMode;
	vectorAvailable(): boolean;
	status(): KbStatus;
	reindex(limit?: number): Promise<{ indexed: number; remaining: number }>;
	prefetchEnabled(): boolean;
	/** 預檢索塊與結構化引用；refs 只包含實際寫進 block 的片段，逐條對應。 */
	prefetch(message: string): Promise<KbPrefetch>;
	prefetchBlock(message: string): Promise<string>;
	prefetchPreview(query: string): Promise<KbPrefetchPreview>;
	ingestUrl(rawUrl: unknown): Promise<KbIngestOk>;
	ingestFile(rawFile: unknown): Promise<KbIngestOk>;
}

/** 檔案型別判定：副檔名兜底，相容瀏覽器給出的空 MIME。 */
function ingestFileKind(file: File): KbIngestFileKind | null {
	const name = String(file.name ?? "").toLowerCase();
	const mime = String(file.type ?? "").toLowerCase();
	const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
	if (mime === "application/pdf" || ext === "pdf") return "pdf";
	if (mime === KB_DOCX_MIME || ext === "docx") return "docx";
	if (mime === "text/markdown" || mime === "text/plain" || mime === "text/x-markdown" || ext === "md" || ext === "markdown" || ext === "txt") {
		return "text";
	}
	return null;
}

function ingestTitle(name: string): string {
	const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
	return (stem || "未命名文件").slice(0, 120);
}

export function createKbService(deps: KbServiceDeps): KbService {
	const { sql, env, scopeId, settings, webFetch, now: clock = () => new Date().toISOString() } = deps;

	/** 生產環境用 AI / KB_VEC 繫結；測試與本地可用 CF_DISABLE_VECTOR=1 強制關閉。 */
	function bindings(): KbVectorBindings | null {
		if (env.CF_DISABLE_VECTOR === "1") return null;
		if (!env.AI || !env.KB_VEC) return null;
		return { ai: env.AI as KbVectorBindings["ai"], vec: env.KB_VEC as KbVectorBindings["vec"] };
	}

	function retrievalMode(): KbRetrievalMode {
		const value = settings.get("kb_retrieval", "fts");
		return value === "vector" || value === "hybrid" ? value : "fts";
	}

	function markdownAi(): KbMarkdownAi | null {
		const ai = env.AI;
		if (!ai || typeof ai !== "object" || !("toMarkdown" in ai) || typeof ai.toMarkdown !== "function") return null;
		// env.AI 是 unknown（生產是 Workers AI 繫結，測試可注入同形物件）。
		return ai as unknown as KbMarkdownAi;
	}

	async function embedTexts(texts: string[]): Promise<number[][]> {
		const current = bindings();
		if (!current) throw new Error("未配置向量檢索");
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += KB_EMBED_BATCH) {
			const batch = texts.slice(i, i + KB_EMBED_BATCH);
			const result = await current.ai.run(KB_EMBED_MODEL, { text: batch });
			const vectors = result?.data;
			if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error("embedding 返回格式不正確");
			out.push(...vectors);
		}
		return out;
	}

	async function vectorUpsert(rows: { id: string; values: number[]; metadata: Record<string, string | number> }[]): Promise<void> {
		if (!rows.length) return;
		const current = bindings();
		if (!current) throw new Error("未配置向量檢索");
		await current.vec.upsert(rows);
	}

	async function vectorDelete(ids: string[]): Promise<void> {
		if (!ids.length) return;
		const current = bindings();
		if (!current) throw new Error("未配置向量檢索");
		await current.vec.deleteByIds(ids);
	}

	async function vectorQuery(values: number[], topK: number): Promise<KbVectorMatch[]> {
		const current = bindings();
		if (!current) throw new Error("未配置向量檢索");
		// 先按 scope 過濾；後設資料索引尚未生效時退化為無過濾查詢，再在 Worker 側按 scope 過濾。
		const filtered = await current.vec.query(values, {
			topK,
			returnMetadata: "all",
			filter: { scope: { $eq: scopeId } },
		});
		if ((filtered.matches ?? []).length) return filtered.matches ?? [];
		const loose = await current.vec.query(values, { topK: Math.min(topK * 5, 50), returnMetadata: "all" });
		return (loose.matches ?? []).filter((match) => match.metadata?.scope === scopeId);
	}

	type KbIndexProgress = { vectorized: number; pending: number };

	/** 該文件已建 / 未建向量的分塊數；失敗後也用它回報真實進度，而不是本次處理數。 */
	function indexProgress(docId: number): KbIndexProgress {
		const pending = countUnvectorizedForDoc(sql, docId);
		return { vectorized: Math.max(0, countChunksForDoc(sql, docId) - pending), pending };
	}

	/**
	 * 把該文件所有未建向量的分塊寫入 Vectorize，按 KB_VECTOR_BATCH 迴圈到沒有剩餘。
	 * 單篇正文上限 20 萬字符（約 280 段），迴圈次數有界；只建前一批會讓長文件尾部永遠無法召回（NERE-78）。
	 */
	async function indexDoc(docId: number): Promise<void> {
		if (!bindings()) return;
		for (;;) {
			const rows = listUnvectorized(sql, KB_VECTOR_BATCH, docId);
			if (!rows.length) return;
			const vectors = await embedTexts(rows.map((row) => row.text));
			await vectorUpsert(
				rows.map((row, index) => ({
					id: `${scopeId}:${row.id}`,
					values: vectors[index]!,
					metadata: { scope: scopeId, docId, chunkSeq: row.seq },
				})),
			);
			// 每批成功就落庫，後續批次失敗時已完成的部分仍可召回。
			markVectorized(sql, rows.map((row) => row.id));
		}
	}

	/** 當前檢索模式需要向量時增量建索引；失敗只記日誌，不影響 FTS 入庫，剩餘量由 pending 回報。 */
	async function indexIfEnabled(docId: number): Promise<KbIndexProgress> {
		if (retrievalMode() === "fts" || !bindings()) return { vectorized: 0, pending: 0 };
		try {
			await indexDoc(docId);
		} catch (err) {
			console.warn("kb vector index failed", String(err).slice(0, 160));
		}
		return indexProgress(docId);
	}

	function writeChunks(docId: number, title: string, source: string, tags: string, chunks: string[]): number {
		const titleTokens = [...new Set(kbTokens(`${title} ${source} ${tags}`))].join(" ");
		for (let seq = 0; seq < chunks.length; seq++) {
			const text = chunks[seq]!;
			const chunkId = insertChunk(sql, docId, seq, text);
			if (!chunkId) continue;
			insertFts(sql, chunkId, titleTokens, [...new Set(kbTokens(text))].join(" "));
		}
		return chunks.length;
	}

	/** 刪除某篇文件已寫入的向量；失敗只記日誌，DB 側仍繼續替換。 */
	async function deleteDocVectors(docId: number): Promise<void> {
		const chunkIds = listChunkIds(sql, docId);
		if (!chunkIds.length || !bindings()) return;
		try {
			await vectorDelete(chunkIds.map((chunkId) => `${scopeId}:${chunkId}`));
		} catch (err) {
			console.warn("kb vector delete failed", String(err).slice(0, 160));
		}
	}

	/**
	 * 入庫（NERE-47）：非空 source 是文件身份。
	 * - 同來源同正文：不寫庫，複用原 id，返回 updated:false；
	 * - 同來源不同正文：保留 id，清掉舊分塊 / FTS / 向量後重建，返回 updated:true；
	 * - 無來源（貼上、工具未帶 source）：沒有穩定身份，按新文件插入。
	 * 最終查重與寫入之間不能有 await，否則同一 DO 的併發匯入會各寫一篇。
	 */
	async function add({ title, content, source = "", tags = "" }: KbAddInput): Promise<KbAddResult> {
		const clean = content.replace(/\r\n/g, "\n").trim().slice(0, KB_MAX_CONTENT);
		const chunked = () => kbChunkText(clean).slice(0, KB_MAX_CHUNKS);
		const key = source.trim();
		if (!key) {
			const id = insertDoc(sql, { title, source: "", tags, content: clean, now: clock() });
			if (!id) throw new Error("知識庫寫入失敗");
			return { id, chunks: writeChunks(id, title, "", tags, chunked()), updated: true };
		}

		const existing = findDocBySource(sql, key);
		if (existing?.content === clean) {
			return { id: existing.id, chunks: countChunksForDoc(sql, existing.id), updated: false };
		}
		if (existing) {
			// 刪向量是唯一的外部呼叫；它完成後重新確認目標，再同步替換，避免併發匯入各寫一篇。
			await deleteDocVectors(existing.id);
			const target = findDocBySource(sql, key);
			if (target?.content === clean) {
				return { id: target.id, chunks: countChunksForDoc(sql, target.id), updated: false };
			}
			if (target) {
				for (const chunkId of listChunkIds(sql, target.id)) deleteFts(sql, chunkId);
				deleteChunks(sql, target.id);
				updateDoc(sql, target.id, { title, source: key, tags, content: clean, now: clock() });
				return { id: target.id, chunks: writeChunks(target.id, title, key, tags, chunked()), updated: true };
			}
		}

		const id = insertDoc(sql, { title, source: key, tags, content: clean, now: clock() });
		if (!id) throw new Error("知識庫寫入失敗");
		return { id, chunks: writeChunks(id, title, key, tags, chunked()), updated: true };
	}

	function search(query: string, limit = 6): KbHit[] {
		const q = query.trim().slice(0, 200);
		if (!q) return [];
		const capped = Math.max(1, Math.min(Number(limit) || 6, 20));
		const match = kbFtsQuery(q);
		if (match) {
			try {
				const rows = searchFts(sql, match, capped);
				if (rows.length) return rows;
				// 自然語言問句裡會出現「期怎」「麼看」這類跨詞二元組，AND 可能全空：
				// 退化為 OR，由 bm25 的 IDF 把真正相關的片段排到前面。
				const loose = kbFtsQuery(q, "or");
				if (loose && loose !== match) {
					const looseRows = searchFts(sql, loose, capped);
					if (looseRows.length) return looseRows;
				}
			} catch (err) {
				console.warn("kb fts search failed", String(err).slice(0, 120));
			}
		}
		return searchLike(sql, `%${q.replace(/[%_]/g, "")}%`, capped);
	}

	function hitsFromMatches(matches: KbVectorMatch[]): KbHit[] {
		const ids: number[] = [];
		for (const match of matches) {
			const chunkId = Number(String(match.id).split(":").pop());
			if (Number.isFinite(chunkId) && chunkId > 0) ids.push(chunkId);
		}
		if (!ids.length) return [];
		const rows = chunksByIds(sql, ids);
		const byChunk = new Map(rows.map((row) => [Number(row.chunkId), row]));
		return matches
			.map((match) => {
				const row = byChunk.get(Number(String(match.id).split(":").pop()));
				return row ? { ...row, score: match.score } : null;
			})
			.filter((hit): hit is KbHit => hit !== null);
	}

	/** 統一檢索入口：fts / vector / hybrid；向量不可用或失敗時回退 FTS。 */
	async function searchAsync(query: string, limit = 6, modeOverride?: KbRetrievalMode): Promise<KbHit[]> {
		const mode = modeOverride ?? retrievalMode();
		const capped = Math.max(1, Math.min(Number(limit) || 6, 20));
		if (mode === "fts" || !bindings()) return search(query, capped);
		const candidateLimit = Math.min(capped * 3, 30);
		const keyword = search(query, candidateLimit);
		let vector: KbHit[] = [];
		try {
			const [embedding] = await embedTexts([query]);
			if (!embedding) return keyword.slice(0, capped);
			vector = hitsFromMatches(await vectorQuery(embedding, candidateLimit));
		} catch (err) {
			console.warn("kb vector search failed", String(err).slice(0, 160));
			return keyword.slice(0, capped);
		}
		if (mode === "vector") return vector.slice(0, capped);
		return kbRrfMerge(keyword, vector, capped);
	}

	async function fileToMarkdown(file: File, kind: "pdf" | "docx"): Promise<string> {
		const ai = markdownAi();
		if (!ai) {
			throw new KbIngestError(501, "ai_unavailable", "當前環境不支援 PDF / DOCX 解析，請上傳 Markdown / TXT 或直接貼上正文。");
		}
		let result: KbMarkdownConversion | KbMarkdownConversion[];
		try {
			// File 不能跨 RPC / 部分繫結傳輸，轉成等長 Blob（slice 不復制內容）。
			result = await ai.toMarkdown({ name: file.name || `document.${kind}`, blob: file.slice(0, file.size, file.type) });
		} catch (err) {
			throw new KbIngestError(422, "empty_content", `文件解析失敗：${String(err).slice(0, 200)}`);
		}
		const item = Array.isArray(result) ? result[0] : result;
		if (item?.format === "error") {
			throw new KbIngestError(422, "empty_content", `文件解析失敗：${String(item.error || "").slice(0, 200) || "未知原因"}`);
		}
		const data = String(item?.data ?? "").trim();
		if (!data) throw new KbIngestError(422, "empty_content", "文件裡沒有可提取的正文。");
		return data;
	}

	/** 入庫 + 可選向量索引；chars 是實際落庫的字元數（add 會按上限截斷）。 */
	async function ingestDoc(title: string, content: string, source: string): Promise<KbIngestOk> {
		const stored = content.replace(/\r\n/g, "\n").trim().slice(0, KB_MAX_CONTENT);
		const { id, chunks, updated } = await add({ title, content: stored, source: source.slice(0, 300) });
		const progress = await indexIfEnabled(id);
		return { ok: true as const, docId: String(id), title, chunks, chars: stored.length, updated, ...progress };
	}

	/** 未知異常統一收斂為 internal_error；KbIngestError 原樣上拋給 Route 對映狀態碼。 */
	async function ingest(run: () => Promise<KbIngestOk>): Promise<KbIngestOk> {
		try {
			return await run();
		} catch (err) {
			if (err instanceof KbIngestError) throw err;
			console.warn("kb ingest failed", String(err).slice(0, 200));
			throw new KbIngestError(500, "internal_error", "匯入失敗，請稍後重試。");
		}
	}

	type PrefetchResult = KbPrefetch & { enabled: boolean; hits: KbHit[] };

	/**
	 * 本輪預檢索：一個檢索結果同時產出注入塊與結構化引用。
	 * 引用只覆蓋真正寫進塊的片段（去重與截斷規則與舊 prefetchBlock 一致），
	 * 保證「注入過哪些資料」與「entry 上記了哪些資料」逐條對得上。
	 *
	 * 一次檢索同時產出預覽命中、注入塊與引用（NERE-82 P2-3）：
	 * `/kb/prefetch` 不再先 searchAsync、再經 prefetch 二次檢索。
	 */
	async function retrieveForPrefetch(message: string): Promise<PrefetchResult> {
		const enabled = settings.get("kb_prefetch", "1") === "1";
		const empty: PrefetchResult = { enabled, hits: [], block: "", refs: [] };
		if (!enabled) return empty;
		const query = message.trim().slice(0, 200);
		if (query.length < 2) return empty;
		const hits = await searchAsync(query, KB_PREFETCH_TOP);
		if (!hits.length) return empty;
		const seen = new Set<number>();
		const entries: { line: string; ref: KbRef }[] = [];
		for (const hit of hits) {
			if (hit.chunkId) {
				if (seen.has(hit.chunkId)) continue;
				seen.add(hit.chunkId);
			}
			const text = String(hit.text ?? "").slice(0, KB_PREFETCH_CHARS);
			if (!text.trim()) continue;
			const ref: KbRef = {
				docId: Number(hit.docId),
				chunkId: Number(hit.chunkId),
				chunkSeq: Number(hit.chunkSeq),
				title: String(hit.title ?? ""),
			};
			if (hit.source) ref.source = String(hit.source);
			entries.push({
				line: `[${entries.length + 1}] ${hit.title}${hit.source ? `（${hit.source}）` : ""} · 片段 ${Number(hit.chunkSeq) + 1}\n${text}`,
				ref,
			});
		}
		if (!entries.length) return { ...empty, hits };
		return {
			enabled,
			hits,
			block: `\n\n## 知識庫參考資料（按當前問題自動檢索，可能相關；不相關就忽略）\n${entries.map((entry) => entry.line).join("\n\n---\n\n")}\n\n需要更多內容時呼叫 kb_search 繼續檢索；引用資料時註明文件標題。`,
			refs: entries.map((entry) => entry.ref),
		};
	}

	async function prefetch(message: string): Promise<KbPrefetch> {
		const { block, refs } = await retrieveForPrefetch(message);
		return { block, refs };
	}

	return {
		listDocs: () => listDocs(sql),
		getDoc: (id) => getDoc(sql, id),
		backupDocs: () => listBackupDocs(sql),
		hasDoc: (title, content) => docExistsByContent(sql, title, content),

		add,

		async addIndexed(input) {
			const result = await add(input);
			const progress = await indexIfEnabled(result.id);
			return { ...result, ...progress };
		},

		async remove(id) {
			if (!docExists(sql, id)) return false;
			const chunkIds = listChunkIds(sql, id);
			await deleteDocVectors(id);
			for (const chunkId of chunkIds) deleteFts(sql, chunkId);
			deleteChunks(sql, id);
			deleteDoc(sql, id);
			return true;
		},

		search,
		searchAsync,
		retrievalMode,
		vectorAvailable: () => bindings() !== null,

		status() {
			return {
				mode: retrievalMode(),
				available: bindings() !== null,
				index: KB_VECTOR_DEFAULT_INDEX,
				model: KB_EMBED_MODEL,
				total: countChunks(sql),
				indexed: countVectorized(sql),
				pending: countUnvectorized(sql),
			};
		},

		async reindex(limit = KB_VECTOR_BATCH) {
			if (!bindings()) throw new Error("向量檢索未啟用（缺少 AI / KB_VEC 繫結）");
			const capped = Math.max(1, Math.min(Number(limit) || KB_VECTOR_BATCH, 500));
			const rows = listUnvectorized(sql, capped);
			if (!rows.length) return { indexed: 0, remaining: 0 };
			const vectors = await embedTexts(rows.map((row) => row.text));
			await vectorUpsert(
				rows.map((row, index) => ({
					id: `${scopeId}:${row.id}`,
					values: vectors[index]!,
					metadata: { scope: scopeId, docId: row.doc_id, chunkSeq: row.seq },
				})),
			);
			markVectorized(sql, rows.map((row) => row.id));
			return { indexed: rows.length, remaining: countUnvectorized(sql) };
		},

		prefetchEnabled: () => settings.get("kb_prefetch", "1") === "1",

		prefetch,

		prefetchBlock: async (message) => (await prefetch(message)).block,

		async prefetchPreview(query) {
			const { enabled, hits, block } = await retrieveForPrefetch(query);
			return { enabled, hits, block };
		},

		ingestUrl: (rawUrl) =>
			ingest(async () => {
				const target = typeof rawUrl === "string" ? rawUrl.trim() : "";
				if (!target) throw new KbIngestError(400, "invalid_url", "缺少 url 欄位，或 url 不是字串。");
				if (!/^https?:\/\//i.test(target)) throw new KbIngestError(400, "invalid_url", "連結必須以 http(s):// 開頭。");
				const page = await webFetch(target);
				if (!page.ok) {
					throw page.kind === "empty"
						? new KbIngestError(422, "empty_content", page.message)
						: new KbIngestError(502, "fetch_failed", page.message);
				}
				let fallbackTitle = "未命名文件";
				try {
					fallbackTitle = new URL(target).hostname || fallbackTitle;
				} catch {
					// 校驗只保證協議字首，保留兜底標題即可
				}
				const title = (page.title || fallbackTitle).slice(0, 120);
				return ingestDoc(title, page.content, target);
			}),

		ingestFile: (rawFile) =>
			ingest(async () => {
				if (!(rawFile instanceof File)) throw new KbIngestError(415, "unsupported_type", "缺少 file 欄位。");
				const file = rawFile;
				if (file.size > KB_INGEST_MAX_BYTES) throw new KbIngestError(413, "too_large", "檔案超過 25MB，請壓縮後再試。");
				const kind = ingestFileKind(file);
				if (!kind) throw new KbIngestError(415, "unsupported_type", "只支援 PDF / DOCX / Markdown / TXT 檔案。");
				let content: string;
				if (kind === "text") {
					content = (await file.text()).trim();
					if (!content) throw new KbIngestError(422, "empty_content", "檔案裡沒有可提取的正文。");
				} else {
					content = await fileToMarkdown(file, kind);
				}
				return ingestDoc(ingestTitle(file.name), content, String(file.name ?? ""));
			}),
	};
}
