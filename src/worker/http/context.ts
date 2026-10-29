import type { Harness } from "@earendil-works/pi-durable";
import type { SqlHandle } from "../db/migrations";
import type { WebFetchResult } from "../services/kb-service";
import type { SessionRuntime } from "../services/session-service";
import type {
	AlarmRuntime,
	ChatRuntime,
	ContextRuntime,
	CustomToolsRuntime,
	DataRuntime,
	DebugRuntime,
	GoalRuntime,
	McpRuntime,
	SettingsPort,
	SettingsRuntime,
	ShareRuntime,
	ToolRuntime,
	UserLifecycleRuntime,
} from "./ports";

/** Worker 繫結（ADR-0001 §9.2）；只在 Http 層按需讀取，不落庫。 */
export type AppEnv = {
	ACCESS_PASSWORD?: string;
	/** 未設定 ACCESS_PASSWORD 時必須顯式設為 "1" 才允許開放模式（僅本機開發）。 */
	PI_ALLOW_OPEN?: string;
	/** 可選：Workers AI 繫結（只在自建 PDF/DOCX 解析時用；預設不綁）。 */
	AI?: unknown;
	/** 可選：Vectorize 繫結（預設不綁，知識庫走 FTS5）。 */
	KB_VEC?: unknown;
	CF_DISABLE_VECTOR?: string;
	BUILD?: string;
	/** 登入頁「看一個真實對話」入口：站內 /s/<token> 或 https 絕對地址。 */
	DEMO_SHARE_URL?: string;
	/** 分享頁頁尾的專案連結；留空則不顯示該出口。 */
	REPO_URL?: string;
	/** 測試專用（wrangler.test.jsonc）：開啟 /debug/harness 觀測端點。 */
	TEST_HARNESS_STATS?: string;
	SpikeAgent: DurableObjectNamespace;
	UserRegistry: DurableObjectNamespace;
};

/** 一次請求的顯式依賴：Route/Service 不再讀模組級 agentScope。 */
export type RequestContext = {
	readonly req: Request;
	readonly url: URL;
	readonly env: AppEnv;
	readonly scopeId: string;
	readonly userKey: string;
	readonly origin: string;
	/** 已執行遷移的 SQL 控制代碼；migrate 由 ready() 保證先跑完。 */
	sql(): SqlHandle;
	/** 觸發一次（冪等的）遷移；dispatch 在呼叫 handler 前 await。 */
	ready(): Promise<void>;
	/** 惰性 open()；只有 needsHarness 的路由呼叫。 */
	harness(): Promise<Harness>;
	/** 會話域的 Harness 埠（open/重試/模型配置在 DO 組合根）；由路由注入 session-service。 */
	readonly sessionRuntime: SessionRuntime;
	/** 分享域的 Harness 埠（階段 3）：只有會話分享真正讀條目時才 open()。 */
	readonly shareRuntime: ShareRuntime;
	/** 使用者資料清空埠（NERE-24）：僅內部 purge 端點使用。 */
	readonly userLifecycleRuntime: UserLifecycleRuntime;
	/** 設定讀取埠（DO 用既有 getSetting 實現），供服務替代模組級 getSetting。 */
	readonly settings: SettingsPort;
	/** 設定寫入（`/kernel` 的版本快取）；寫入口徑在 `repo/settings-repo`。 */
	setSetting(key: string, value: string): void;
	/** 設定域：壓縮策略 / 當前供應商變更後重建 Harness。 */
	readonly settingsRuntime: SettingsRuntime;
	/** 自動化域：任務或目標排程變更後重排 alarm。 */
	readonly alarmRuntime: AlarmRuntime;
	/** 上下文用量埠（GET /context）。 */
	readonly contextRuntime: ContextRuntime;
	/** 目標域：POST /goal 需要會話累計 token 基線。 */
	readonly goalRuntime: GoalRuntime;
	/** 能力域：GET /tools 需要當前已安裝擴充套件的工具名與自定義工具集合。 */
	readonly toolRuntime: ToolRuntime;
	/** MCP 域：配置變更後重建擴充套件。 */
	readonly mcpRuntime: McpRuntime;
	/** 對話域（階段 5）：prepare/submit 的 Harness 埠 + 併發閘門。 */
	readonly chatRuntime: ChatRuntime;
	/** 資料域（階段 6）：匯出/反思/恢復後重建 MCP；Harness 相關部分留在 DO。 */
	readonly dataRuntime: DataRuntime;
	/** 系統域（階段 6）：`/debug/agent` 的登錄檔快照。 */
	readonly debugRuntime: DebugRuntime;
	/** 自定義工具寫操作（階段 6）：更新 DO 的擴充套件與登錄檔。 */
	readonly customToolsRuntime: CustomToolsRuntime;
	/** DeepSeek 網頁抓取埠（web_fetch_page 與連結 ingest 共用介面卡）。 */
	webFetch(url: string): Promise<WebFetchResult>;
};

export type BuildContextInput = {
	req: Request;
	env: AppEnv;
	scopeId: string;
	userKey: string;
	origin: string;
	sql: SqlHandle;
	ensureMigrated(): Promise<void>;
	open(): Promise<Harness>;
	sessionRuntime: SessionRuntime;
	shareRuntime: ShareRuntime;
	userLifecycleRuntime: UserLifecycleRuntime;
	settings: SettingsPort;
	setSetting(key: string, value: string): void;
	settingsRuntime: SettingsRuntime;
	alarmRuntime: AlarmRuntime;
	contextRuntime: ContextRuntime;
	goalRuntime: GoalRuntime;
	toolRuntime: ToolRuntime;
	mcpRuntime: McpRuntime;
	chatRuntime: ChatRuntime;
	dataRuntime: DataRuntime;
	debugRuntime: DebugRuntime;
	customToolsRuntime: CustomToolsRuntime;
	webFetch(url: string): Promise<WebFetchResult>;
};

/**
 * 請求級設定快取（NERE-82 P2-2）：第一次讀取時用 `snapshot` 一次拉全表，
 * 之後同一請求內所有 get 都命中 Map；`/bootstrap` 的 13 條設定查詢因此合成 1 條。
 * 只有 `get` 的極簡埠保持逐鍵讀取（結果仍按 key 快取）。
 */
export function requestSettings(port: SettingsPort): SettingsPort & { invalidate(key: string): void } {
	const cache = new Map<string, string>();
	let bulkLoaded = false;
	let bulkOk = false;
	const load = () => {
		if (bulkLoaded || !port.snapshot) return;
		bulkLoaded = true;
		try {
			for (const [key, value] of Object.entries(port.snapshot())) cache.set(key, value);
			bulkOk = true;
		} catch {
			// 全表讀取失敗：回落到逐鍵 get（repo.get 自己有兜底）。
		}
	};
	return {
		get(key, fallback) {
			load();
			if (!cache.has(key)) cache.set(key, bulkOk ? fallback : port.get(key, fallback));
			return cache.get(key) ?? fallback;
		},
		snapshot() {
			load();
			return Object.fromEntries(cache);
		},
		invalidate(key) {
			cache.delete(key);
			// 表已變：之後的未命中鍵回到逐鍵讀取，避免把舊快照的“預設”當真。
			bulkOk = false;
		},
	};
}

export function buildContext(input: BuildContextInput): RequestContext {
	const settings = requestSettings(input.settings);
	return {
		req: input.req,
		url: new URL(input.req.url),
		env: input.env,
		scopeId: input.scopeId,
		userKey: input.userKey,
		origin: input.origin,
		sql: () => input.sql,
		ready: () => input.ensureMigrated(),
		harness: () => input.open(),
		sessionRuntime: input.sessionRuntime,
		shareRuntime: input.shareRuntime,
		userLifecycleRuntime: input.userLifecycleRuntime,
		settings,
		setSetting: (key, value) => {
			input.setSetting(key, value);
			// 同一請求裡先寫後讀（`/kernel`）必須看到新值。
			settings.invalidate(key);
		},
		settingsRuntime: input.settingsRuntime,
		alarmRuntime: input.alarmRuntime,
		contextRuntime: input.contextRuntime,
		goalRuntime: input.goalRuntime,
		toolRuntime: input.toolRuntime,
		mcpRuntime: input.mcpRuntime,
		chatRuntime: input.chatRuntime,
		dataRuntime: input.dataRuntime,
		debugRuntime: input.debugRuntime,
		customToolsRuntime: input.customToolsRuntime,
		webFetch: (url: string) => input.webFetch(url),
	};
}
