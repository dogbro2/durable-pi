/**
 * Route ↔ DO 組合根之間的埠（ADR-0001 §9.2「埠增長規則」）。
 * http 層只依賴這裡的形狀；Service 向下依賴埠，避免 http → services → http 的環。
 */

import type { KbRef } from "../lib/kb";

/**
 * `app_settings` 讀取埠（階段 2 的 KbSettings 同形，階段 6 統一收口）。
 * `snapshot` 供 HTTP 請求級快取一次讀全表；測試/極簡實現可只給 `get`。
 */
export type SettingsPort = { get(key: string, fallback: string): string; snapshot?(): Record<string, string> };

/** 邀請使用者 id 形如 u_ab12cd34；新分享 token 以 `<userId>.` 字首路由到該使用者的 DO。 */
export const USER_ID_RE = /^u_[a-z0-9]{6,16}$/;

/** 使用者分享 token 字首；主人（owner）不加字首，保持舊連結形態。 */
export function shareTokenPrefix(userKey: string): string {
	return USER_ID_RE.test(userKey) ? `${userKey}.` : "";
}

/** 從 token 解出所屬邀請使用者 id；主人 / 舊連結（無字首）返回 undefined。 */
export function shareTokenOwner(token: string): string | undefined {
	const dot = token.indexOf(".");
	if (dot < 0) return undefined;
	const candidate = token.slice(0, dot);
	return USER_ID_RE.test(candidate) ? candidate : undefined;
}

/**
 * 分享域的 Harness 埠（階段 3）：由 DO 組合根實現。
 * 只有確實要讀會話條目時才會 open()；檔案分享、失效/過期 token 不碰它。
 */
export type ShareRuntime = {
	/** 會話 id 解析（預設回落根會話）；POST /share 與 GET /shares 用它取真實會話 id。 */
	conversationId(sessionId?: string): Promise<string>;
	/** 會話條目；會話不存在時返回空陣列（與舊 renderShare 一致）。 */
	entries(sessionId: string): Promise<readonly unknown[]>;
};

/* ---------------- NERE-24：使用者資料處置 ---------------- */

/** 使用者 DO 的儲存清空埠；只由 owner 觸發的顯式 purge 呼叫。 */
export type UserLifecycleRuntime = { purge(): Promise<void> };

/* ---------------- 階段 4：設定 / 自動化 / 上下文 / 能力 / MCP ---------------- */

/** 設定域：壓縮策略或當前供應商變更後重建 Harness（先寫庫後重建）。 */
export type SettingsRuntime = { recover(): Promise<void> };

/** 自動化域：`/automations`、`/goal` 改變排程後重排 alarm。 */
export type AlarmRuntime = { schedule(): Promise<void> };

export type ContextUsage = { usedTokens: number; contextWindow: number; percent: number; approximate: boolean };

/** 上下文用量埠：`GET /context` 需要 Harness 條目，留在 DO。 */
export type ContextRuntime = { usage(sessionId?: string): Promise<ContextUsage> };

/** 目標域：建立目標前需要會話累計 token 基線（Harness 用量快照）。 */
export type GoalRuntime = { baselineTokens(sessionId: string): Promise<number> };

/** 能力域：`/tools` 需要當前已安裝擴充套件的工具名，自定義工具集合來自 DO 例項（R5）。 */
export type ToolRuntime = { names(): string[]; customNames(): string[] };

/** MCP 域：配置變更後清空本 DO 的連線快取並重建擴充套件，返回最新工具數。 */
export type McpRuntime = { rebuild(): Promise<number> };

/* ---------------- 階段 5：對話域（NERE-33） ---------------- */

/**
 * 併發閘門（原 DO 的 `activeChats`）：同一 DO 內同一會話同時只跑一次提交。
 * 狀態由 DO 組合根持有（`createChatGate()` 一次），Service 負責 enter/exit 時機。
 * `tryEnter` 是原子的搶佔：已在跑時返回 false（第二個 `/chat` 據此回 409）。
 */
export type ChatGate = { has(key: string): boolean; tryEnter(key: string): boolean; exit(key: string): void };

export function createChatGate(): ChatGate {
	const active = new Set<string>();
	return {
		has: (key) => active.has(key),
		tryEnter: (key) => {
			if (active.has(key)) return false;
			active.add(key);
			return true;
		},
		exit: (key) => {
			active.delete(key);
		},
	};
}

/** 顯式技能呼叫（`/技能名`）：正文注入本輪 instructions，原文留在轉錄。 */
export type ChatSkillInvocation = { name: string; content: string; rest: string };

/** 會話控制代碼：pi-durable conversation 的結構子集；Service 不 import pi-durable。 */
export type ChatHandle = { readonly id: unknown };
/** 轉錄條目（pi-durable 的 entry）：Service 只讀 id/kind/model，不解釋內部結構。 */
export type ChatEntry = Record<string, unknown> & { id?: number };
export type ChatSubmission = { readonly id: string; readonly raw: unknown };
export type ChatSettled = { readonly status?: string; readonly type?: string; readonly answer?: unknown };
export type ChatToolSummary = { name: string; summary: string };

/** watchEvents 的事件形狀（Service 只做 SSE 對映，不接觸 Harness）。 */
export type ChatWatchEvent = {
	type: string;
	changes?: readonly { type?: string; delta?: string }[];
	toolName?: string;
	toolCallId?: string;
	parentToolCallId?: string;
	args?: unknown;
	entry?: { model?: readonly { content?: unknown; details?: unknown }[] };
	result?: { details?: unknown };
};

/**
 * 對話域的 Harness 埠：open/重試/conversation/擴充套件裝配都在 DO 組合根。
 * Service 只編排順序（prepare → submit → 標題/反思/目標續轉），不接觸 pi-durable 型別。
 */
export type ChatRuntime = {
	/** 本 DO 例項的併發閘門（原 `activeChats`）。 */
	readonly gate: ChatGate;
	/** 取/建會話（含 SessionFailed 重試）。 */
	conversation(sessionId?: string): Promise<ChatHandle>;
	/** 配置本輪 agent：模型/思考檔位/擴充套件 + instructions。 */
	configure(handle: ChatHandle, input: { sessionId?: string; instructions: string }): Promise<void>;
	/** 組裝本輪 instructions 與知識庫引用（技能索引、目標、預檢索）。 */
	instructions(input: {
		inv: ChatSkillInvocation | null;
		sessionId?: string;
		message: string;
	}): Promise<{ instructions: string; kbRefs: readonly KbRef[] }>;
	/** 解析 `/技能名`；未命中返回 null。 */
	skillInvocation(message: string): ChatSkillInvocation | null;
	toolNames(handle: ChatHandle): Promise<string[]>;
	/** 最近一條條目的 id（本輪 tools 的起點）。 */
	lastEntryId(handle: ChatHandle): Promise<number>;
	submit(
		handle: ChatHandle,
		input: { message: string; images?: string[]; whenBusy?: "steer" },
	): Promise<ChatSubmission>;
	wait(submission: ChatSubmission): Promise<ChatSettled>;
	commit(handle: ChatHandle, answer: unknown): Promise<ChatEntry | null>;
	entries(
		handle: ChatHandle,
		opts?: { limit?: number; order?: "descending" },
	): Promise<readonly ChatEntry[]>;
	watch(
		handle: ChatHandle,
		onEvents: (events: readonly ChatWatchEvent[]) => Promise<void> | void,
	): Promise<{ stop(): Promise<void> }>;
	abort(handle: ChatHandle): Promise<void>;
	reset(handle: ChatHandle): Promise<void>;
	compact(handle: ChatHandle, instructions?: string): Promise<string>;
	/** reflect：一次低成本模型呼叫抽取長期事實，返回入庫條數。 */
	reflect(conversationId: string, transcript: string): Promise<number>;
	/** 會話累計 token（pi.usage 快照）。 */
	usageTokens(handle: ChatHandle): Promise<number>;
	/** SessionFailed 後重建 Harness。 */
	recover(): Promise<void>;
	scheduleAlarm(): Promise<void>;
	waitUntil(promise: Promise<unknown>): void;
};

/* ---------------- 階段 6：資料 / 系統 / 提示模板域 ---------------- */

/** 匯出快照（`/export` 用）：Service 渲染 Markdown，DO 只負責讀 Harness 與標題。 */
export type ExportSnapshot = {
	sessionId: string;
	title: string;
	entries: readonly Record<string, unknown>[];
};

/**
 * 資料域埠（`/backup`、`/restore`、`/export`、`/reflect`）：
 * 匯出與反思需要 Harness；恢復後要清 MCP 快取並重排 alarm。
 */
export type DataRuntime = {
	exportSnapshot(sessionId?: string): Promise<ExportSnapshot>;
	reflect(sessionId?: string): Promise<number>;
	afterRestore(): Promise<void>;
};

/** 系統域埠（`/debug/agent`）：讀取當前登錄檔的工具/擴充套件清單，可選返回本輪 instructions。 */
export type DebugRuntime = {
	inspect(input: { message: string | null; sessionId: string }): Promise<unknown>;
};

/** 自定義工具寫操作（`/custom-tools` POST/DELETE）：同時更新 DO 的擴充套件與登錄檔。 */
export type CustomToolsRuntime = {
	save(body: unknown): { name: string; tools: number };
	remove(name: string): { tools: number };
};
