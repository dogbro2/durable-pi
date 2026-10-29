/** One tool call shown as an expandable pill (summary = truncated brief, full = original text). */
export interface ToolCallInfo {
	name: string;
	summary: string;
	full?: string;
	/** 執行時 id（v0.22.0）：用於把 codemode 的內嵌呼叫掛到父呼叫下。 */
	id?: string;
	/** 父呼叫 id：有值時表示這是 codemode 腳本里發起的巢狀呼叫。 */
	parentId?: string;
	/** 執行狀態。 */
	status?: "running" | "done" | "error";
	/** 工具入參（僅執行中保留，用於渲染計劃等結構化結果）。 */
	args?: unknown;
}

/** 計劃步驟（update_plan 工具，v0.22.0）。 */
export interface PlanStep {
	title: string;
	status: "pending" | "in_progress" | "completed";
}

/** 聊天裡出現的檔案產出（write_file 的副作用，v0.22.0）。 */
export interface FileArtifact {
	name: string;
	/** 內容長度（字元），未知時省略。 */
	size?: number;
}

/** 分享連結（share_file / share_conversation 工具結果，v0.55.0）。 */
export interface ShareLink {
	url: string;
	title: string;
	kind: "file" | "conversation";
	/** 0 = 永久。 */
	expiresAt: number;
	createdAt?: string;
	/** 複用了已有未過期連結。 */
	reused?: boolean;
}

/** 一條知識庫命中（NERE-40）：隨 assistant entry 落庫，用於訊息下方「參考資料」。 */
export interface KbRef {
	docId: number;
	chunkId: number;
	/** 命中的分塊序號（從 0 開始），僅用於標註「第 N 段」，不做正文定位。 */
	chunkSeq: number;
	title: string;
	/** 來源（檔名 / 連結），可預設。 */
	source?: string;
}

/** 從訊息裡的參考資料跳到知識庫（NERE-41）。nonce 讓「重複點同一段」也能再次觸發。 */
export interface KbFocus {
	docId: number;
	chunkSeq?: number;
	nonce: number;
}

/** 一條分享記錄（NERE-42 的 /api/shares/all）。與工具結果裡的 ShareLink 不是同一件事。 */
export interface ShareRecord {
	token: string;
	kind: "file" | "conversation";
	name: string;
	/** epoch 毫秒；0 = 永久有效。 */
	expiresAt: number;
	createdAt: string;
	openCount: number;
	/** epoch 毫秒；0 = 從未開啟。 */
	lastOpenedAt: number;
	sessionId: string;
	/** 相對路徑；渲染前經 lib/format.shareUrlFor 歸一化。 */
	url: string;
}

/** Message list entry. notice = system hint (stopped / reset failed...); tool = orphan tool activity row. */
export type ChatMessage =
	| { id: string; role: "user"; text: string; images?: string[]; /** 後端條目 id（v0.32.0：分支用）。 */ entryId?: number }
	| {
			id: string;
			role: "assistant";
			text: string;
			tools?: ToolCallInfo[];
			/** 思考過程（v0.22.0）：模型開 reasoning 時累積的 thinking 文本。 */
			thinking?: string;
			error?: boolean;
			/** 本輪產出的檔案（由 write_file 工具結果提取）。 */
			files?: FileArtifact[];
			/** 本輪生成的分享連結（v0.55.0）。 */
			shares?: ShareLink[];
			/** 本輪知識庫命中（NERE-40）；預設或空陣列時不渲染任何 UI。 */
			kbRefs?: KbRef[];
	  }
	| { id: string; role: "tool"; tools: ToolCallInfo[] }
	| { id: string; role: "notice"; text: string };

/** Session list item for the left sidebar. */
export interface SessionListItem {
	id: string;
	title: string;
	createdAt: string;
	/** 該會話使用的模型（v6）；舊資料可能為空。 */
	model?: string;
	/** 分支來源會話（v0.32.0）：有值表示這是從某個會話分叉出來的。 */
	parentId?: string;
	/** 分叉點條目 id（v0.32.0）。 */
	forkAt?: number;
}

/** Virtual file produced by the agent's write_file tool. */
export interface FileInfo {
	name: string;
	size: number;
	updatedAt: string;
}

/** Memory library entry. */
export interface MemoryInfo {
	id: number;
	content: string;
	createdAt: string;
	/** manual = 顯式儲存；reflect = 會話末自動抽取。舊資料可能為空。 */
	source?: string;
}

/** An MCP server the agent can call tools from (v5). */
export interface McpServerInfo {
	id: string;
	name: string;
	url: string;
	created_at?: string;
}

/** 定時任務的排程（NERE-65）：daily 用 time，interval 用 minutes。 */
export interface AutomationSchedule {
	kind: "daily" | "interval";
	time?: string;
	minutes?: number;
}

/** 上次執行結果（NERE-68 2b）：成功 / 失敗 / 會話忙順延。 */
export type AutomationRunStatus = "ok" | "failed" | "deferred";

/** A scheduled prompt that runs on its own (v0.8.0). */
export interface AutomationInfo {
	id: string;
	name: string;
	prompt: string;
	/** 人類可讀的排程說明，由解析器生成。 */
	scheduleLabel: string;
	nextLabel?: string;
	enabled: boolean;
	/** 原始排程，供編輯彈窗回填（NERE-65）；解析失敗時由解析器給預設值。 */
	schedule?: AutomationSchedule;
	/** 歸屬會話，供編輯彈窗回填（NERE-65）；「檢視產出」的兜底目標（NERE-86 優先 lastSessionId）。 */
	sessionId?: string;
	/** 上次執行時間（毫秒）；後端寫成功也寫失敗（NERE-68 2a 只展示，不判斷成敗）。缺失 / null 不渲染。 */
	lastRunAt?: number;
	/** 上次執行結果（NERE-68 2b）；NULL / 未知值解析為 undefined（不渲染徽標）。 */
	lastStatus?: AutomationRunStatus;
	/** 上次失敗原因（v1.0.4）；僅 lastStatus = "failed" 時有值。 */
	lastError?: string;
	/** 最近一次執行實際用的會話（NERE-84）；老資料 / 未執行過為 undefined。 */
	lastSessionId?: string;
	/** 每輪新建會話（NERE-84）；缺失時按預設開處理（NERE-86 彈窗回填）。 */
	freshSession?: boolean;
}

/** PATCH /api/automations 的請求體（NERE-64 契約；enabled 原樣帶回，編輯不改啟停）。 */
export interface AutomationPatch {
	id: string;
	name: string;
	prompt: string;
	schedule: AutomationSchedule;
	sessionId: string;
	enabled: boolean;
	/** 每輪新建會話開關（NERE-84）：後端欄位為 snake_case。 */
	fresh_session: boolean;
}

/**
 * 目標（v0.31.0）：繫結一個會話的長期目標。
 * status: active 進行中 / done 已完成 / blocked 受阻 / paused 手動暫停 / exhausted 預算用盡
 */
export interface GoalInfo {
	objective: string;
	status: "active" | "done" | "blocked" | "paused" | "exhausted";
	tokenBudget: number;
	tokensUsed: number;
	turns: number;
	maxTurns: number;
	summary?: string;
	updatedAt?: string;
}

/** ask_user 的一個問題（v0.37.0）。 */
export interface AskItem {
	id: string;
	question: string;
	options?: { label: string; description?: string; recommended?: boolean }[];
	allowText?: boolean;
}

/** 待回答的問題組（v0.37.0）。 */
export interface AskQuestion {
	id: number;
	title?: string;
	questions: AskItem[];
	created_at?: string;
}

/** 自定義工具（v0.36.0）：使用者貼的 JS，沙箱執行後成為模型可呼叫的工具。 */
export interface CustomToolInfo {
	name: string;
	description: string;
	/** 引數 JSON Schema 字串。 */
	parameters: string;
	code: string;
	createdAt?: string;
}

/** 待審批的工具呼叫（v0.33.0）。 */
export interface ApprovalInfo {
	id: number;
	tool: string;
	category: string;
	/** 呼叫引數的 JSON 預覽（截斷）。 */
	args: string;
	created_at: string;
}

/** 提示模板（v0.31.0）：輸入 / 選中後把正文填進輸入框。 */
export interface PromptInfo {
	name: string;
	description: string;
	content: string;
}

/** 規則檔案（v0.31.0）：啟用後每輪注入 instructions。 */
export interface RuleInfo {
	name: string;
	content: string;
	enabled: boolean;
}

/** A named instruction the agent loads on demand (v0.15.0). */
export interface SkillInfo {
	name: string;
	description: string;
	content: string;
	/** 執行時（NERE-59）：prompt / javascript / typescript；預設表示服務端未提供。 */
	runtime?: string;
	/** 審計結論快照（NERE-59）：來自 GET /skills 的 auditStatus。 */
	auditStatus?: SkillAuditStatus;
	/** 安裝時間（NERE-59）：ISO 字串，用於「裝了 7 天還沒用過」的提示。 */
	createdAt?: string;
	/**
	 * 最後一次 load_skill / 顯式呼叫 `/name` 的時間（NERE-59，epoch ms）。
	 * `null` = 從未使用；`undefined` = 服務端沒有埋點資料（整行不渲染）。
	 */
	lastInvokedAt?: number | null;
}

/** Skill Hub 審計結論（NERE-53 契約 §3）：pass 通過 / warn 有風險 / blocked 不可安裝。 */
export type SkillAuditStatus = "pass" | "warn" | "blocked";

/** 審計時檢測到的能力（NERE-53 契約 §3）：執行時、出站域名、依賴工具。 */
export interface SkillAuditDetected {
	runtime: string;
	network: string[];
	tools: string[];
}

/** 審計原因（NERE-53 契約 §4.4）：message 是唯一給使用者看的解釋；rule / evidence 便於定位。 */
export interface SkillAuditReason {
	rule?: string;
	level?: SkillAuditStatus;
	message: string;
	evidence?: string;
}

/** 一條技能的審計報告（NERE-53 契約 §4.4）。 */
export interface SkillAudit {
	status: SkillAuditStatus;
	/** 相容早期 `reasons: string[]`；解析後統一成結構化物件。 */
	reasons: SkillAuditReason[];
	detected: SkillAuditDetected;
	auditedAt?: string;
	/** 本次審計實際計算出的 contentHash。 */
	hash?: string;
	rulesVersion?: number;
	auditSource?: "local" | "catalog";
}

/** Skill Hub 市場條目（NERE-53 契約 §5.2 的 HubSkill）。 */
export interface SkillHubEntry {
	name: string;
	version: string;
	description: string;
	author: string;
	/** 來源 URL（存量技能為 "local"）。 */
	source: string;
	/** 執行時列舉：prompt / javascript / typescript 可安裝；python / shell 等被審計擋下。 */
	runtime: string;
	tags: string[];
	license: string;
	contentHash: string;
	/** 服務端計算的已安裝狀態（比頁面級技能列表更權威）。 */
	installed: boolean;
	/** 同名已安裝但內容不同：前端提示「可更新」。 */
	installedHash?: string;
	audit: SkillAudit;
	/** 直接安裝地址；預設時回退 source（必須是 http(s) URL）。 */
	installUrl?: string;
}

/**
 * 技能安裝結果（NERE-69）：Hub 行內要展示失敗原因，`onInstall` 不能只回布林。
 * `message` 優先取 `details.audit.reasons[0].message`，缺失時回退到介面 `error`。
 */
export type SkillInstallOutcome = { ok: true; name?: string } | { ok: false; message: string };

/** 全部檔案總覽條目（v0.45.0）：檔案 + 所屬會話。 */
export interface AllFileInfo extends FileInfo {
	sessionId: string;
	sessionTitle: string;
}

/** 知識庫文件（v0.45.0）：每個使用者獨立。 */
export interface KbDocInfo {
	id: number;
	title: string;
	source: string;
	tags: string;
	/** 正文字元數。 */
	size: number;
	/** 分塊數（檢索單位）。 */
	chunks: number;
	createdAt: string;
	updatedAt: string;
}

/** 知識庫檢索命中片段（v0.45.0）。 */
export interface KbHit {
	docId: number;
	title: string;
	source: string;
	text: string;
	chunkSeq: number;
	score: number;
}
