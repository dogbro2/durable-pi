/**
 * 知識庫匯入（v0.54.3）：檔案 / 連結 → 後端解析、切塊、入庫。
 *
 * 前端只做能在本地判斷的校驗（副檔名、25MB 上限、空檔案、URL 形態），
 * 真正的格式解析與切塊交給 `POST /api/kb/ingest`；服務端返回的 code 決定失敗文案。
 * 純函式集中在這裡，元件只負責狀態機與渲染。
 */
import { formatSize } from "./format";

/** 與需求約定一致：超過 25MB 直接攔在前端，不浪費一次上傳。 */
export const MAX_INGEST_BYTES = 25 * 1024 * 1024;

/** 檔案選擇器 / 拖拽提示裡展示的可用格式。 */
export const INGEST_ACCEPT = ".pdf,.md,.markdown,.txt,.docx";
export const INGEST_FORMAT_HINT = "PDF / MD / TXT / DOCX";

/** 匯入介面未上線（404/405/501）時，純文本可以退回既有的 `POST /api/kb`。 */
export const LOCAL_TEXT_FALLBACK_CHARS = 200_000;

export type IngestFileKind = "pdf" | "md" | "txt" | "docx";

/** 契約裡的四種失敗 + 傳輸層補充的三種（網路 / 服務端 / 介面未上線）。 */
export type IngestErrorCode =
	| "too_large"
	| "unsupported_type"
	| "empty_content"
	| "ai_unavailable"
	| "unavailable"
	| "network"
	| "server"
	| "unknown";

export interface IngestSuccess {
	ok: true;
	docId: string;
	title: string;
	chunks: number;
	chars: number;
}

export interface IngestFailure {
	ok: false;
	code: IngestErrorCode;
	message: string;
	/** 介面本身沒上線：可以嘗試本地文本兜底，而不是把它當成檔案的問題。 */
	unavailable?: boolean;
}

export type IngestResult = IngestSuccess | IngestFailure;

/** 副檔名 → 支援的類別；大小寫不敏感。 */
const EXTENSIONS: Record<string, IngestFileKind> = {
	pdf: "pdf",
	md: "md",
	markdown: "md",
	txt: "txt",
	docx: "docx",
};

/** 純文本檔案在前端就能讀，介面未上線時可以走本地兜底。 */
export function isTextKind(kind: IngestFileKind): boolean {
	return kind === "md" || kind === "txt";
}

export function ingestFileKind(name: string): IngestFileKind | null {
	const base = name.trim().toLowerCase();
	const dot = base.lastIndexOf(".");
	if (dot < 0 || dot === base.length - 1) return null;
	return EXTENSIONS[base.slice(dot + 1)] ?? null;
}

/** 用於報錯文案：`.zip`，沒有副檔名時給空串。 */
export function ingestFileExtension(name: string): string {
	const base = name.trim();
	const dot = base.lastIndexOf(".");
	return dot > 0 && dot < base.length - 1 ? `.${base.slice(dot + 1).toLowerCase()}` : "";
}

/** 檔名去掉副檔名當標題，和「貼上正文」時的標題語義一致。 */
export function titleFromFileName(name: string): string {
	const base = name.trim().replace(/^.*[\\/]/, "");
	const dot = base.lastIndexOf(".");
	// ".pdf" 這種只有副檔名的檔案沒有可用標題
	const title = (dot > 0 ? base.slice(0, dot) : base.startsWith(".") ? "" : base).trim();
	return title.slice(0, 120) || "未命名文件";
}

/** 後端沒回標題時的兜底：域名 + 路徑，比空白更容易認出來源。 */
export function titleFromUrl(raw: string): string {
	try {
		const url = new URL(raw);
		const path = url.pathname.replace(/\/+$/, "");
		return `${url.hostname}${path}`.slice(0, 120) || url.hostname || "連結匯入";
	} catch {
		return "連結匯入";
	}
}

export interface IngestFileLike {
	name: string;
	size: number;
}

export type IngestFileCheck =
	| { ok: true; kind: IngestFileKind }
	| { ok: false; code: "too_large" | "unsupported_type" | "empty_content"; message: string };

/** 本地校驗：順序與需求一致 —— 格式 → 體積 → 空檔案。失敗時絕不發請求。 */
export function checkIngestFile(file: IngestFileLike): IngestFileCheck {
	const kind = ingestFileKind(file.name);
	if (!kind) {
		const ext = ingestFileExtension(file.name);
		return {
			ok: false,
			code: "unsupported_type",
			message: `不支援${ext ? ` ${ext} ` : "這個"}格式，只能匯入 ${INGEST_FORMAT_HINT}。`,
		};
	}
	if (file.size > MAX_INGEST_BYTES) {
		return {
			ok: false,
			code: "too_large",
			message: `檔案超過 25MB（${formatSize(file.size)}），請壓縮或拆分後再匯入。`,
		};
	}
	if (file.size <= 0) {
		return { ok: false, code: "empty_content", message: "這個檔案是空的，沒有可匯入的正文。" };
	}
	return { ok: true, kind };
}

export type IngestUrlCheck = { ok: true; url: string } | { ok: false; message: string };

/** 連結只接受 http(s)：別的協議後端也抓不到。 */
export function checkIngestUrl(input: string): IngestUrlCheck {
	const value = input.trim();
	if (!value) return { ok: false, message: "請先貼上要匯入的網頁連結。" };
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { ok: false, message: "連結格式不對，需要以 http:// 或 https:// 開頭。" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, message: "只支援 http(s) 連結。" };
	}
	return { ok: true, url: url.toString() };
}

const CONTRACT_CODES = new Set<IngestErrorCode>(["too_large", "unsupported_type", "empty_content", "ai_unavailable"]);

/** 契約 code 缺失或不認識時，退化成服務端錯誤，但保留後端給的人話 message。 */
function normalizeCode(raw: unknown): IngestErrorCode | null {
	if (typeof raw !== "string") return null;
	const code = raw.trim().toLowerCase() as IngestErrorCode;
	return CONTRACT_CODES.has(code) || code === "unavailable" || code === "network" || code === "server" ? code : null;
}

/** 每種失敗都給一句能指導下一步的中文文案；服務端 message 優先。 */
export function ingestErrorMessage(code: IngestErrorCode, detail?: string): string {
	switch (code) {
		case "too_large":
			return `檔案超過 25MB，請壓縮或拆分後再匯入。`;
		case "unsupported_type":
			return `不支援這種格式，只能匯入 ${INGEST_FORMAT_HINT}。`;
		case "empty_content":
			return "沒有解析出正文，請檢查檔案或連結內容後重試。";
		case "ai_unavailable":
			return "解析服務暫時不可用，請稍後重試。";
		case "unavailable":
			return "匯入介面還沒上線（/api/kb/ingest），PDF / DOCX 暫時無法解析。可以先匯入 Markdown / TXT，或等後端合併。";
		case "network":
			return "網路請求失敗，請檢查網路後重試。";
		case "server":
			return detail?.trim() || "匯入失敗，服務返回異常，請稍後重試。";
		default:
			return detail?.trim() || "匯入失敗，請稍後重試。";
	}
}

export function ingestNetworkFailure(): IngestFailure {
	return { ok: false, code: "network", message: ingestErrorMessage("network") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toCount(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * 寬容解析 `POST /api/kb/ingest` 的響應：
 * - `{ok:true, docId, title, chunks, chars}`
 * - `{ok:false, code, message}`（HTTP 200 或 4xx 都可能）
 * - 既有的 `{error}` 風格，以及 404/405/501 的「路由不存在」
 */
export function parseIngestResponse(raw: unknown, status = 200): IngestResult {
	const unavailable = status === 404 || status === 405 || status === 501;
	if (!isRecord(raw)) {
		if (unavailable) return { ok: false, code: "unavailable", message: ingestErrorMessage("unavailable"), unavailable: true };
		if (status >= 500) return { ok: false, code: "server", message: ingestErrorMessage("server") };
		return { ok: false, code: "unknown", message: ingestErrorMessage("unknown") };
	}

	const serverMessage = typeof raw.message === "string" ? raw.message.trim() : "";

	if (raw.ok === false || (raw.ok === undefined && typeof raw.error === "string")) {
		const code = normalizeCode(raw.code) ?? (unavailable ? "unavailable" : "server");
		const fallback = typeof raw.error === "string" && raw.error.trim() ? raw.error.trim() : "";
		return {
			ok: false,
			code,
			message: serverMessage || (code === "server" ? ingestErrorMessage("server", fallback) : ingestErrorMessage(code)),
			unavailable,
		};
	}

	const docIdRaw = raw.docId ?? raw.doc_id ?? raw.id;
	const docId = typeof docIdRaw === "string" || typeof docIdRaw === "number" ? String(docIdRaw).trim() : "";
	const title = typeof raw.title === "string" ? raw.title.trim() : "";

	// 2xx 且沒有明確失敗標記：容忍 ok 欄位缺失（後端版本可能領先/落後於契約）。
	if (status >= 200 && status < 300) {
		return { ok: true, docId, title, chunks: toCount(raw.chunks), chars: toCount(raw.chars) };
	}

	if (unavailable) return { ok: false, code: "unavailable", message: ingestErrorMessage("unavailable"), unavailable: true };
	return {
		ok: false,
		code: status >= 500 ? "server" : "unknown",
		message: serverMessage || ingestErrorMessage(status >= 500 ? "server" : "unknown"),
	};
}
