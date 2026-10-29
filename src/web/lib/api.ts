/**
 * Same-origin API client: relative paths only (deployed alongside the Worker, no CORS needed).
 * /api/chat is non-streaming and may take 10-60s — no client timeout, only AbortSignal to stop waiting.
 * All list endpoints are parsed tolerantly on the caller side (see lib/collections.ts).
 */

import type { AutomationPatch, GoalInfo, SkillAuditStatus } from "../types";
import { ingestNetworkFailure, parseIngestResponse, type IngestResult } from "./ingest";

export type { GoalInfo };

/* ---------------- 首屏聚合（NERE-23 / NERE-26） ---------------- */

/** 與後端 `src/worker/bootstrap.ts` 的 BOOTSTRAP_KEYS 保持一致；tests/unit/bootstrap-web.test.ts 會斷言兩份清單相同。 */
export const BOOTSTRAP_KEYS = [
	"session",
	"entries",
	"sessions",
	"files",
	"memories",
	"approvals",
	"settings",
	"plan",
	"goal",
	"questions",
	"prompts",
	"rules",
	"customTools",
	"skills",
	"automations",
	"mcpServers",
	"models",
] as const;

export type BootstrapKey = (typeof BOOTSTRAP_KEYS)[number];

/** GET /api/settings 的響應體（設定彈窗與 bootstrap.settings 共用同一份型別）。 */
export interface SettingsView {
	webSearch?: boolean;
	/** 工具箱（v1.1.0）：搜尋 / 網頁抓取 / 自動記憶的端點，只在 UI 設定。 */
	toolbox?: { baseUrl?: string; hasKey?: boolean; keyHint?: string; model?: string };
	/** 知識庫預檢索（v0.46.0）：每輪自動把命中的資料注入系統提示。 */
	kbPrefetch?: boolean;
	/** 知識庫檢索模式（v0.53.0）：fts / vector / hybrid。 */
	kbRetrieval?: string;
	kbVector?: { available?: boolean; index?: string };
	thinkingLevel?: string;
	/** 分享頁署名（v0.55.0）。 */
	displayName?: string;
	/** 分享預設有效期（秒，0 = 永久，v0.55.0）。 */
	shareTtlSeconds?: number;
	compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number };
	approval?: { read: string; write: string; exec: string };
}

/** GET /api/models 的響應體（Composer / bootstrap.models 共用）。 */
export interface ModelsView {
	models?: string[];
	default?: string;
	provider?: string;
}

/**
 * GET /api/bootstrap?sessionId= 的響應體（NERE-23）。
 *
 * 欄位與單端點一一對應，但陣列面板失敗時後端會回退成 `[]`、其它面板回退成 `null`，
 * 失敗原因寫進 `errors`（鍵為面板名，值截斷到 200 字），HTTP 仍是 200。
 * 這裡用 `unknown` 接收列表，交給 lib/bootstrap.ts 寬容解析，避免後端欄位漂移時整頁崩。
 */
export interface BootstrapResponse {
	session: { ok?: boolean; name?: string } | null;
	entries: unknown;
	sessions: unknown;
	files: unknown;
	memories: unknown;
	approvals: unknown;
	settings: SettingsView | null;
	plan: unknown;
	goal: unknown;
	questions: unknown;
	prompts: unknown;
	rules: unknown;
	customTools: unknown;
	skills: unknown;
	automations: unknown;
	mcpServers: unknown;
	models: ModelsView | null;
	errors?: Partial<Record<BootstrapKey, string>>;
}

export interface ChatResult {
	answer: string;
	tools: { name?: string; summary?: string }[];
	error?: string;
}

/** 已生成的分享連結（v0.40.0）：開啟分享彈窗時直接複用。 */
export interface ShareLinkInfo {
	token: string;
	url: string;
	kind: string;
	name: string;
	expiresAt: number;
	theme: string;
	createdAt: string;
}

/** GET /api/shares/all 的一條記錄（NERE-42）；領域模型是 types.ts 的 ShareRecord。 */
export interface ShareRecordDto {
	token: string;
	kind: "file" | "conversation";
	name: string;
	expiresAt: number;
	theme: string;
	createdAt: string;
	openCount: number;
	lastOpenedAt: number;
	sessionId: string;
	url: string;
}

export interface SharesAllResponse {
	shares?: ShareRecordDto[];
}

/** 分享清單預設只取有效連結（NERE-42）：服務端與前端預設值必須一致，只在這裡寫一次。 */
export const SHARES_DEFAULT_STATUS = "active" as const;

/** GET /api/skills/hub 的一條傳輸 DTO（NERE-53 契約 §5.2）；領域模型是 types.ts 的 SkillHubEntry。 */
export interface SkillHubItemDto {
	name?: string;
	version?: string;
	description?: string;
	author?: string;
	/** 來源 URL；存量技能為 "local"。 */
	source?: string;
	runtime?: string;
	tags?: string[];
	license?: string;
	requires?: { tools?: string[]; bindings?: string[]; network?: string[] };
	audit?: {
		status?: string;
		/** 契約是結構化物件；早期 `string[]` 仍相容。 */
		reasons?: (string | { rule?: string; level?: string; message?: string; evidence?: string })[];
		detected?: { runtime?: string; network?: string[]; tools?: string[] };
		auditedAt?: string;
		hash?: string;
		rulesVersion?: number;
		auditSource?: string;
	};
	installUrl?: string;
	/** 正文雜湊（manifest 頂層欄位）。 */
	contentHash?: string;
	installed?: boolean;
	/** 同名已安裝但內容不同 → 前端提示「可更新」。 */
	installedHash?: string;
}

export interface SkillHubResponse {
	skills?: SkillHubItemDto[];
	total?: number;
	nextOffset?: number | null;
	catalog?: {
		source?: string;
		fetchedAt?: string | null;
		/** 遠端重新整理失敗：列表仍可用，前端展示「目錄可能過期」。 */
		stale?: boolean;
		count?: number;
	};
	filters?: {
		runtimes?: string[];
		tags?: string[];
		/** host（不是完整 URL）。 */
		sources?: string[];
	};
}

/** 市場篩選維度（NERE-53 契約 §5.2）：空值由 withQuery 省略。 */
export interface SkillHubQuery {
	q?: string;
	runtime?: string;
	tag?: string;
	audit?: string;
	/** host 子串。 */
	source?: string;
	origin?: "bundled" | "remote";
	installed?: "0" | "1";
	sort?: "audit" | "name" | "updated";
	limit?: number;
	offset?: number;
}

/** POST /api/skills/import 的歸一化結果：422 audit_blocked 也要帶出審計原因。 */
export interface ImportSkillResult {
	ok?: boolean;
	name?: string;
	error?: string;
	installed?: boolean;
	changed?: boolean;
	code?: string;
	auditStatus?: SkillAuditStatus;
	/** 來自 `details.audit.reasons[].message`，已展平成使用者可讀文本。 */
	reasons?: string[];
}

/** 邀請使用者（v0.43.0）。 */
export interface UserInfo {
	id: string;
	name: string;
	codeHint: string;
	createdAt: string;
	lastUsedAt: string | null;
}

export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
	let res: Response;
	try {
		res = await fetch(path, init);
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") throw err;
		throw new ApiError(0, "網路請求失敗，請檢查服務是否在執行。");
	}

	let data: unknown = null;
	try {
		data = await res.json();
	} catch {
		// Response body is not JSON: keep data = null, handle by HTTP status
	}

	if (!res.ok) {
		const detail =
			data !== null && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
				? ((data as { error: string }).error)
				: "";
		throw new ApiError(res.status, detail || `請求失敗（HTTP ${res.status}）`);
	}
	if (data === null || typeof data !== "object") {
		throw new ApiError(res.status, "響應不是有效的 JSON 物件");
	}
	return data as T;
}

/** Append query params, skipping empty values. */
function withQuery(path: string, params: Record<string, string>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value) search.set(key, value);
	}
	const qs = search.toString();
	return qs ? `${path}?${qs}` : path;
}

function jsonPost(body: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};
}

/* ---------------- 知識庫匯入（v0.54.3） ---------------- */

/**
 * 檔案匯入走 XHR 而不是 fetch：只有 XHR 能區分「上傳中」與「服務端解析中」，
 * 也才能在 25MB 檔案上傳時給出真實進度。響應統一交給 parseIngestResponse 歸一化。
 */
function ingestFileRequest(
	file: File,
	handlers?: { onProgress?: (percent: number) => void; onUploaded?: () => void },
): Promise<IngestResult> {
	if (typeof XMLHttpRequest === "undefined") {
		return Promise.resolve(ingestNetworkFailure());
	}
	return new Promise((resolve) => {
		const form = new FormData();
		form.append("file", file, file.name);
		const xhr = new XMLHttpRequest();
		let settled = false;
		const settle = (result: IngestResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		xhr.open("POST", "/api/kb/ingest");
		// 25MB PDF 的解析可能超過一分鐘；超時也要落到可讀錯誤，不能一直卡在「上傳中」。
		xhr.timeout = 180_000;
		xhr.upload.onprogress = (event) => {
			if (!event.lengthComputable || event.total <= 0) return;
			handlers?.onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
		};
		xhr.upload.onload = () => handlers?.onUploaded?.();
		xhr.onload = () => {
			let data: unknown = null;
			try {
				data = JSON.parse(xhr.responseText) as unknown;
			} catch {
				// 非 JSON（閘道器錯誤頁等）：按 HTTP 狀態碼判定
			}
			settle(parseIngestResponse(data, xhr.status));
		};
		xhr.onerror = () => settle(ingestNetworkFailure());
		xhr.ontimeout = () =>
			settle({ ok: false, code: "network", message: "解析超時（180 秒），請換小一點的檔案或稍後重試。" });
		xhr.onabort = () => settle({ ok: false, code: "network", message: "匯入已取消。" });
		xhr.send(form);
	});
}

async function ingestUrlRequest(url: string): Promise<IngestResult> {
	let res: Response;
	try {
		res = await fetch("/api/kb/ingest", jsonPost({ url }));
	} catch {
		return ingestNetworkFailure();
	}
	let data: unknown = null;
	try {
		data = await res.json();
	} catch {
		// 非 JSON 響應體由狀態碼兜底
	}
	return parseIngestResponse(data, res.status);
}

/* ---------------- 技能匯入（NERE-53 / NERE-54） ---------------- */

/** 422 `details.audit.reasons` 可能是物件陣列，也可能是早期字串陣列；統一成文案。 */
function importReasonTexts(value: unknown): string[] {
	if (typeof value === "string") return value.trim() ? [value.trim()] : [];
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (typeof item === "string") return item.trim() ? [item.trim()] : [];
		if (item !== null && typeof item === "object") {
			const message = (item as { message?: unknown }).message;
			if (typeof message === "string" && message.trim()) return [message.trim()];
		}
		return [];
	});
}

/**
 * POST /api/skills/import。
 * 不走 requestJson：422 的 `details.audit.reasons` 是安裝失敗的主要 UI 文案，不能被 HTTP 狀態吞掉。
 */
async function importSkillRequest(url: string): Promise<ImportSkillResult> {
	let res: Response;
	try {
		res = await fetch("/api/skills/import", jsonPost({ url }));
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") throw err;
		throw new ApiError(0, "網路請求失敗，請檢查服務是否在執行。");
	}
	let data: unknown = null;
	try {
		data = await res.json();
	} catch {
		// 非 JSON 響應體由狀態碼兜底
	}
	const body = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
	const details = body.details !== null && typeof body.details === "object" ? (body.details as Record<string, unknown>) : {};
	const audit = details.audit !== null && typeof details.audit === "object" ? (details.audit as Record<string, unknown>) : {};
	const error = typeof body.error === "string" ? body.error : "";
	const statusRaw = typeof audit.status === "string" ? audit.status.toLowerCase() : "";
	const auditStatus: SkillAuditStatus | undefined =
		statusRaw === "pass"
			? "pass"
			: statusRaw === "warn" || statusRaw === "warning"
				? "warn"
				: statusRaw === "blocked" || statusRaw === "rejected"
					? "blocked"
					: undefined;
	const reasons = importReasonTexts(audit.reasons);
	const extras = {
		...(auditStatus ? { auditStatus } : {}),
		...(reasons.length > 0 ? { reasons } : {}),
	};
	if (res.status === 422) {
		return {
			ok: false,
			installed: false,
			code: typeof body.code === "string" ? body.code : "audit_blocked",
			error: error || "審計未通過，技能未安裝",
			...extras,
		};
	}
	if (!res.ok) throw new ApiError(res.status, error || `請求失敗（HTTP ${res.status}）`);
	return {
		ok: typeof body.ok === "boolean" ? body.ok : true,
		...(typeof body.name === "string" ? { name: body.name } : {}),
		...(typeof body.installed === "boolean" ? { installed: body.installed } : {}),
		...(typeof body.changed === "boolean" ? { changed: body.changed } : {}),
		...(error ? { error } : {}),
		...extras,
	};
}

export const api = {
	/**
	 * 首屏聚合（NERE-26）：一次拉取 17 個只讀面板，替代原先 17 個單端點請求。
	 * 失敗面板不拋錯：欄位回退空值並寫進 `errors`，由 lib/bootstrap.ts 解析成空態。
	 */
	bootstrap: (sessionId: string) => requestJson<BootstrapResponse>(withQuery("/api/bootstrap", { sessionId })),

	/** POST /api/sessions — create a new conversation and return its id. */
	createSession: () => requestJson<{ id?: string; title?: string }>("/api/sessions", { method: "POST" }),

	/** POST /api/branches — 從某條歷史訊息分叉出新會話（v0.32.0）。 */
	branch: (sessionId: string, entryId: number, title?: string) =>
		requestJson<{ ok?: boolean; id?: string; title?: string; error?: string }>(
			"/api/branches",
			jsonPost({ sessionId, entryId, title }),
		),

	/**
	 * POST /api/chat/stream — SSE。事件：
	 * thinking_start / thinking{delta}（思考過程）
	 * text{delta} / tool_start{name,id,parentId,args} / tool_end{name,id,parentId,summary}
	 * done{answer,tools} / error{message}
	 */
	streamChat: async (
		message: string,
		sessionId: string,
		images: string[],
		onEvent: (event: { type: string; [key: string]: unknown }) => void,
		signal?: AbortSignal,
	): Promise<void> => {
		const resp = await fetch("/api/chat/stream", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message, sessionId, ...(images.length ? { images } : {}) }),
			signal,
		});
		if (!resp.ok || !resp.body) throw new Error(`流式請求失敗（HTTP ${resp.status}）`);
		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			// SSE frames are separated by a blank line.
			let cut = buffer.indexOf("\n\n");
			while (cut >= 0) {
				const frame = buffer.slice(0, cut);
				buffer = buffer.slice(cut + 2);
				// 事件名在 "event: xxx" 行；data 行是 JSON。
				const eventLine = frame.split("\n").find((l) => l.startsWith("event:"));
				const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
				if (dataLine) {
					try {
						const payload = JSON.parse(dataLine.slice(5).trim()) as { type?: string; [key: string]: unknown };
						onEvent({ type: eventLine ? eventLine.slice(6).trim() : (payload.type ?? "message"), ...payload });
					} catch {
						// Ignore malformed frames; the terminal done event still arrives.
					}
				}
				cut = buffer.indexOf("\n\n");
			}
		}
	},

	chat: (message: string, sessionId: string, signal?: AbortSignal) =>
		requestJson<ChatResult>("/api/chat", { ...jsonPost({ message, sessionId }), signal }),

	/** 後端返回條目陣列本身（不是 { entries } 包裝），由呼叫方寬容解析。 */
	fileContent: (sessionId: string, name: string) =>
		requestJson<{ name?: string; content?: string }>(withQuery("/api/files/content", { sessionId, name })),

	deleteFile: (sessionId: string, name: string) =>
		requestJson<{ ok: boolean }>(withQuery("/api/files", { sessionId, name }), { method: "DELETE" }),

	/** 當前使用者所有會話產出的檔案（v0.45.0）。 */
	filesAll: (q?: string) => requestJson<{ files?: unknown[] }>(withQuery("/api/files/all", { q: q ?? "" })),

	/** 使用者知識庫（v0.45.0）：每人獨立，介面自動落在當前使用者 DO。 */
	kbDocs: () => requestJson<{ docs?: unknown[] }>("/api/kb"),
	kbAdd: (title: string, content: string, source?: string, tags?: string) =>
		requestJson<{ ok?: boolean; id?: number; chunks?: number; error?: string }>(
			"/api/kb",
			jsonPost({ title, content, source: source ?? "", tags: tags ?? "" }),
		),
	/**
	 * 知識庫匯入（v0.54.3）：multipart 檔案，或 JSON `{url}`。
	 * 不走 requestJson —— 失敗響應裡的 `code` 是 UI 文案的分支依據，不能被 HTTP 狀態吞掉。
	 */
	kbIngestFile: (file: File, handlers?: { onProgress?: (percent: number) => void; onUploaded?: () => void }) =>
		ingestFileRequest(file, handlers),
	kbIngestUrl: (url: string) => ingestUrlRequest(url),
	kbSearch: (q: string) => requestJson<{ hits?: unknown[] }>(withQuery("/api/kb/search", { q })),
	kbDoc: (id: number) =>
		requestJson<{ id?: number; title?: string; content?: string; error?: string }>(withQuery("/api/kb/doc", { id: String(id) })),
	kbDelete: (id: number) => requestJson<{ ok?: boolean }>(withQuery("/api/kb", { id: String(id) }), { method: "DELETE" }),
	kbStatus: () =>
		requestJson<{ mode?: string; available?: boolean; index?: string; model?: string; total?: number; indexed?: number }>("/api/kb/status"),
	kbReindex: (limit?: number) =>
		requestJson<{ ok?: boolean; indexed?: number; remaining?: number; error?: string }>(
			withQuery("/api/kb/reindex", { limit: limit ? String(limit) : "" }),
			{ method: "POST" },
		),
	/** 當前部署構建號（/api/version 轉發到既有 DO 路由）。 */
	version: () => requestJson<{ build?: string; images?: boolean; search?: boolean }>("/api/version"),

	auth: () => requestJson<{ required?: boolean; authenticated?: boolean; owner?: boolean; demoUrl?: string }>("/api/auth"),

	login: (password: string) =>
		requestJson<{ ok?: boolean; owner?: boolean; name?: string; error?: string }>("/api/login", jsonPost({ password })),

	logout: () => requestJson<{ ok?: boolean }>("/api/logout", { method: "POST" }),

	/** 使用者管理（v0.43.0，僅主人）：邀請碼只在建立/重置時返回一次。 */
	users: () => requestJson<{ users?: UserInfo[] }>("/api/users"),

	addUser: (name: string) =>
		requestJson<{ ok?: boolean; user?: UserInfo; code?: string; error?: string }>("/api/users", jsonPost({ name })),

	resetUserCode: (id: string) =>
		requestJson<{ ok?: boolean; code?: string; hint?: string; error?: string }>("/api/users/reset", jsonPost({ id })),

	deleteUser: (id: string) => requestJson<{ ok?: boolean }>(withQuery("/api/users", { id }), { method: "DELETE" }),

	abort: (sessionId: string) => requestJson<{ ok?: boolean }>("/api/abort", jsonPost({ sessionId })),

	/** 提示模板寫入（v0.31.0）；讀取由 api.bootstrap() 提供。 */
	addPrompt: (name: string, description: string, content: string) =>
		requestJson<{ ok?: boolean; error?: string }>("/api/prompts", jsonPost({ name, description, content })),
	deletePrompt: (name: string) => requestJson<{ ok?: boolean }>(withQuery("/api/prompts", { name }), { method: "DELETE" }),

	/** 規則寫入（v0.31.0）；讀取由 api.bootstrap() 提供。 */
	addRule: (name: string, content: string, enabled = true) =>
		requestJson<{ ok?: boolean; error?: string }>("/api/rules", jsonPost({ name, content, enabled })),
	toggleRule: (name: string, enabled: boolean) =>
		requestJson<{ ok?: boolean }>("/api/rules", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name, enabled }),
		}),
	deleteRule: (name: string) => requestJson<{ ok?: boolean }>(withQuery("/api/rules", { name }), { method: "DELETE" }),

	/** 能力登錄檔（v0.31.0）：內建 / 資料 / 協議三類彙總。 */
	capabilities: () =>
		requestJson<{
			groups?: { key: string; label: string; items: { id: string; name: string; description: string; enabled: boolean; count?: number; detail?: string }[] }[];
		}>("/api/capabilities"),

	/** 手動壓縮當前會話（v0.30.0）。 */
	compact: (sessionId: string, instructions?: string) =>
		requestJson<{ ok?: boolean; taskId?: string; error?: string }>("/api/compact", jsonPost({ sessionId, instructions })),

	/** 上下文佔用估算（v0.42.0）：最近一次模型用量 + 新增內容估算。 */
	context: (sessionId: string) =>
		requestJson<{ usedTokens: number; contextWindow: number; percent: number; approximate?: boolean }>(
			withQuery("/api/context", { sessionId }),
		),

	communitySkills: () =>
		requestJson<{ source?: string; skills?: { name: string; description: string; needsLocal?: boolean; url: string }[] }>(
			"/api/skills/community",
		),

	importSkill: (url: string) => importSkillRequest(url),

	/** Skill Hub 市場列表（NERE-53 契約 §5.2）：篩選引數空值由 withQuery 省略。 */
	skillHub: (params: SkillHubQuery = {}) =>
		requestJson<SkillHubResponse>(
			withQuery("/api/skills/hub", {
				q: params.q ?? "",
				runtime: params.runtime ?? "",
				tag: params.tag ?? "",
				audit: params.audit ?? "",
				source: params.source ?? "",
				origin: params.origin ?? "",
				installed: params.installed ?? "",
				sort: params.sort ?? "",
				limit: params.limit ? String(params.limit) : "",
				offset: params.offset ? String(params.offset) : "",
			}),
		),

	addSkill: (name: string, description: string, content: string) =>
		requestJson<{ ok?: boolean }>("/api/skills", jsonPost({ name, description, content })),

	deleteSkill: (name: string) => requestJson<{ ok?: boolean }>(withQuery("/api/skills", { name }), { method: "DELETE" }),

	backup: () => requestJson<unknown>("/api/backup"),

	restore: (payload: unknown) =>
		requestJson<{ ok?: boolean; counts?: Record<string, number>; error?: string }>("/api/restore", jsonPost(payload)),

	/** 首屏由 api.bootstrap() 提供；這裡只用於設定彈窗的獨立讀取（ADR-0002 記錄的既有偏差）。 */
	models: () => requestJson<ModelsView>("/api/models"),

	/** LLM 供應商（v0.27.0，CCswitch 式）。 */
	providers: () =>
		requestJson<{
			active?: string;
			providers?: { id: string; name: string; baseUrl: string; models: string[]; hasKey?: boolean; keyHint?: string; active?: boolean }[];
		}>("/api/providers"),

	saveProvider: (body: { id?: string; name: string; baseUrl: string; apiKey?: string; models: string }) =>
		requestJson<{ ok?: boolean; id?: string; models?: string[]; error?: string }>("/api/providers", jsonPost(body)),

	deleteProvider: (id: string) =>
		requestJson<{ ok?: boolean }>(withQuery("/api/providers", { id }), { method: "DELETE" }),

	activateProvider: (id: string) =>
		requestJson<{ ok?: boolean; active?: string; models?: string[]; error?: string }>(
			"/api/providers/activate",
			jsonPost({ id }),
		),

	setModel: (sessionId: string, modelId: string) =>
		requestJson<{ ok?: boolean }>("/api/model", jsonPost({ sessionId, modelId })),

	/**
	 * 全域性設定（v0.20.0 網頁搜尋；v0.22.0 思考檔位；v0.33.0 工具審批）。
	 * 首屏由 api.bootstrap().settings 提供；這裡只用於設定彈窗的獨立讀取。
	 */
	settings: () => requestJson<SettingsView>("/api/settings"),

	setSettings: (patch: {
		webSearch?: boolean;
		toolbox?: { baseUrl?: string; apiKey?: string; model?: string; clearKey?: boolean };
		kbPrefetch?: boolean;
		kbRetrieval?: string;
		thinkingLevel?: string;
		displayName?: string;
		shareTtlSeconds?: number;
		compaction?: Partial<{ enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number }>;
		approval?: Partial<{ read: string; write: string; exec: string }>;
		approvalTools?: Record<string, string>;
	}) => requestJson<{ ok?: boolean }>("/api/settings", jsonPost(patch)),

	/** 待回答的問題（v0.37.0）：首屏由 bootstrap 提供，這裡只用於輪次內的增量重新整理。 */
	questions: (sessionId: string) =>
		requestJson<{ questions?: unknown[] }>(withQuery("/api/questions", { sessionId })),

	answerQuestion: (id: number, answers: { id: string; choice?: string; text?: string }[]) =>
		requestJson<{ ok?: boolean; id?: number; resume?: string; error?: string }>("/api/questions", jsonPost({ id, answers })),

	/** 自定義工具寫入（v0.36.0）；讀取由 api.bootstrap() 提供。 */
	addCustomTool: (body: { name: string; description: string; parameters: string; code: string }) =>
		requestJson<{ ok?: boolean; name?: string; tools?: number; error?: string }>("/api/custom-tools", jsonPost(body)),

	deleteCustomTool: (name: string) =>
		requestJson<{ ok?: boolean; tools?: number }>(withQuery("/api/custom-tools", { name }), { method: "DELETE" }),

	/** pi 核心版本（v0.35.0）：當前宣告版本 + npm 最新版本。 */
	kernel: (refresh = false) =>
		requestJson<{
			current?: Record<string, string>;
			latest?: Record<string, string>;
			checkedAt?: string;
			updateAvailable?: boolean;
			outdated?: string[];
			upgrade?: { manual?: string; auto?: string };
		}>(refresh ? "/api/kernel?refresh=1" : "/api/kernel"),

	/** 工具清單與生效策略（v0.33.0）。 */
	tools: () =>
		requestJson<{
			approval?: { read: string; write: string; exec: string };
			tools?: { name: string; category: string; policy: string; override: string }[];
		}>("/api/tools"),

	/** 生成中插話（v0.34.0）：訊息進入正在進行的這一輪。 */
	interject: (sessionId: string, message: string) =>
		requestJson<{ ok?: boolean; id?: string; error?: string }>("/api/interject", jsonPost({ sessionId, message })),

	/** 待審批的工具呼叫（v0.33.0）：首屏由 bootstrap 提供，這裡只用於輪次內的增量重新整理。 */
	approvals: (sessionId: string) =>
		requestJson<{
			approvals?: { id: number; tool: string; category: string; args: string; created_at: string }[];
		}>(withQuery("/api/approvals", { sessionId })),

	decideApproval: (id: number, action: "once" | "always" | "deny") =>
		requestJson<{ ok?: boolean; tool?: string; action?: string; resume?: string; error?: string }>(
			"/api/approvals",
			jsonPost({ id, action }),
		),

	/** 當前會話的分步計劃（v0.22.0）。 */
	/** 目標寫入（v0.31.0）：讀取由 api.bootstrap() 提供。 */
	setGoal: (body: { sessionId: string; objective: string; tokenBudget?: number; maxTurns?: number }) =>
		requestJson<{ ok?: boolean; goal?: GoalInfo | null; error?: string }>("/api/goal", jsonPost(body)),

	stopGoal: (sessionId: string) =>
		requestJson<{ ok?: boolean; goal?: GoalInfo | null }>(withQuery("/api/goal", { sessionId }), { method: "DELETE" }),

	share: (sessionId: string, theme?: string) =>
		requestJson<{ ok?: boolean; token?: string; url?: string; expiresAt?: number }>(
			"/api/share",
			jsonPost({ sessionId, kind: "conversation", theme }),
		),

	/** 分享工作臺檔案（v0.38.0）：md 渲染成分享頁，html 原樣輸出；ttlSeconds=0 永久。 */
	shareFile: (sessionId: string, name: string, ttlSeconds: number, theme?: string) =>
		requestJson<{ ok?: boolean; token?: string; url?: string; expiresAt?: number; error?: string }>(
			"/api/share",
			jsonPost({ sessionId, kind: "file", name, ttlSeconds, theme }),
		),

	/** 列出未過期的分享連結（v0.40.0）：用於複用已生成的連結。 */
	shares: (sessionId: string, kind: "conversation" | "file", name?: string) =>
		requestJson<{ shares?: ShareLinkInfo[] }>(
			withQuery("/api/shares", { sessionId, kind, ...(name ? { name } : {}) }),
		),

	/** 全部有效分享連結（NERE-42）：預設只看 active，避免把過期記錄畫進面板。 */
	sharesAll: (status: "active" | "expired" | "all" = SHARES_DEFAULT_STATUS) =>
		requestJson<SharesAllResponse>(withQuery("/api/shares/all", { status })),

	/** 撤銷一條分享（NERE-42）：立即失效。 */
	revokeShare: (token: string) =>
		requestJson<{ ok?: boolean }>(`/api/shares/${encodeURIComponent(token)}`, { method: "DELETE" }),

	/** 定時任務寫入。 */
	addAutomation: (name: string, prompt: string, sessionId: string, schedule: { kind: string; time?: string; minutes?: number }) =>
		requestJson<{ ok?: boolean; id?: string }>("/api/automations", jsonPost({ name, prompt, sessionId, schedule })),

	toggleAutomation: (id: string, enabled: boolean) =>
		requestJson<{ ok?: boolean }>("/api/automations", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id, enabled }),
		}),

	/** 編輯任務（NERE-65 / NERE-64）：返回更新後的任務，呼叫方合併進列表。 */
	updateAutomation: (patch: AutomationPatch) =>
		requestJson<{ ok?: boolean; automation?: unknown }>("/api/automations", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(patch),
		}),

	deleteAutomation: (id: string) => requestJson<{ ok?: boolean }>(withQuery("/api/automations", { id }), { method: "DELETE" }),

	/** 立即執行（v1.0.4）：手動執行一次定時任務；走完整 chat 回合，可能需要幾分鐘。 */
	runAutomation: (id: string) =>
		requestJson<{ ok?: boolean; answer?: string }>("/api/automations/run", jsonPost({ id })),

	/** MCP 寫入。 */
	addMcp: (name: string, url: string, headers?: Record<string, string>) =>
		requestJson<{ ok?: boolean; tools?: number; error?: string }>("/api/mcp", jsonPost({ name, url, headers })),

	deleteMcp: (id: string) => requestJson<{ ok: boolean }>(withQuery("/api/mcp", { id }), { method: "DELETE" }),

	/** 記憶庫寫入；讀取由 api.bootstrap() 提供。 */
	deleteMemory: (id: number) => requestJson<{ ok: boolean }>(withQuery("/api/memories", { id: String(id) }), { method: "DELETE" }),

	/** 一鍵清空記憶庫（v0.26.0）。 */
	clearMemories: () => requestJson<{ ok: boolean; deleted?: number }>("/api/memories?all=1", { method: "DELETE" }),

	reset: (sessionId: string) => requestJson<{ ok: boolean }>("/api/reset", jsonPost({ sessionId })),

	renameSession: (id: string, title: string) =>
		requestJson<{ ok: boolean }>("/api/sessions", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title }) }),

	deleteSession: (id: string) =>
		requestJson<{ ok: boolean }>(withQuery("/api/sessions", { id }), { method: "DELETE" }),
};
