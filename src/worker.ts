// Spike: pi-durable harness inside a Cloudflare Durable Object (MemoryStorage round).
import { DurableObject } from "cloudflare:workers";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry, Harness, UsageDoc } from "@earendil-works/pi-durable";
import { createViewEventTracker, type ViewLike } from "./worker/lib/view-events";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { demoShareToken, demoShareUrl } from "./worker/lib/share-render";
import { createProviderFetch, withProviderFetch } from "./worker/lib/provider-fetch";
import { userContent } from "./worker/lib/chat-content";
import { migrate, migrateRegistry, type SqlHandle } from "./worker/db/migrations";
import { buildContext, type AppEnv } from "./worker/http/context";
import { AppError, toResponse } from "./worker/http/errors";
import {
	createChatGate,
	USER_ID_RE,
	type AlarmRuntime,
	type ChatEntry,
	type ChatHandle,
	type ChatRuntime,
	type ChatSettled,
	type ChatSubmission,
	type ChatWatchEvent,
	type ContextRuntime,
	type CustomToolsRuntime,
	type DataRuntime,
	type DebugRuntime,
	type GoalRuntime,
	type McpRuntime,
	type SettingsPort,
	type SettingsRuntime,
	type ShareRuntime,
	type ToolRuntime,
} from "./worker/http/ports";
import { getModel } from "./worker/repo/sessions-repo";
import * as providersRepo from "./worker/repo/providers-repo";
import * as sessionsRepo from "./worker/repo/sessions-repo";
import * as settingsRepo from "./worker/repo/settings-repo";
import { createAutomationService, runDueAutomations, type AutomationService } from "./worker/services/automation-service";
import { createChatService, type ChatService } from "./worker/services/chat-service";
import { createContextService } from "./worker/services/context-service";
import {
	buildExtension as buildCustomToolsExtension,
	removeTool as removeCustomTool,
	saveTool as saveCustomTool,
} from "./worker/services/custom-tool-service";
import { createFileService, type FileService } from "./worker/services/file-service";
import { readGoal, writeGoal } from "./worker/services/goal-service";
import { buildInstructions } from "./worker/services/instructions-service";
import { createKbService, type KbService } from "./worker/services/kb-service";
import { buildExtension as buildMcpExtension, type McpCache } from "./worker/services/mcp-service";
import { reflectConversation } from "./worker/services/reflect-service";
import { createSessionService, type SessionRuntime } from "./worker/services/session-service";
import { createShareService, type ShareService } from "./worker/services/share-service";
import { parseSkillInvocation } from "./worker/services/skill-service";
import {
	activeModelIds,
	compactionSettings,
	effectiveProviderId,
	resolveProvider,
	splitModels,
	thinkingLevel,
	toolboxSettings,
} from "./worker/services/settings-service";
import { createWebFetch } from "./worker/services/web-fetch";
import { createUserAdminService } from "./worker/services/user-admin-service";
import type { BackupPayload } from "./worker/services/data-service";
import type { RevokeResult, UserDataCounts } from "./worker/services/user-lifecycle-service";
import { createAgentExtensions, type AgentExtensions, type HarnessLike } from "./worker/tools/spike-tools";
import { dispatch } from "./worker/routes";
import { internalRoutes } from "./worker/routes/internal";

/** pi-durable 的 Harness 呼叫上下文。 */
const ctx = BACKGROUND_CONTEXT;

/**
 * DO 組合根（ADR-0001 §4）：Harness 生命週期、按請求裝配埠、alarm。
 *
 * 階段 6 起本檔案不再持有隱式儲存/請求作用域：
 * - SQL 一律 `this.ctx.storage.sql`（或經 `db()`）；
 * - 工具擴充套件按請求由 `createAgentExtensions()` 構造，origin/userKey/toolbox 顯式傳入；
 * - 業務 SQL 在 repo、編排在 service、HTTP 在 routes。
 */

/** 一次請求的顯式依賴；alarm 用 origin="" / userKey=""。 */
type RequestDeps = {
	sql: SqlHandle;
	env: AppEnv;
	scopeId: string;
	origin: string;
	userKey: string;
};

/**
 * pi-durable conversation 的結構子集。Service 只拿到不透明控制代碼（`ChatHandle`），
 * 真正的 Harness 呼叫由 DO 的埠實現完成；邊界處一次斷言，內部全部走命名型別。
 */
type ChatConversationLike = {
	id: unknown;
	configure(options: unknown, context: unknown): Promise<void>;
	agent(context: unknown): Promise<{ tools: readonly { name?: string }[] }>;
	entries(query: object, limit: number, cursor: undefined, context: unknown): Promise<{ items: readonly ChatEntry[] }>;
	submit(draft: unknown, context: unknown): Promise<{ id?: unknown; wait(context: unknown): Promise<unknown> }>;
	commit(build: (tx: { entry(kind: unknown, answer: unknown): unknown }) => unknown, context: unknown): Promise<ChatEntry | null>;
	abort(context: unknown): Promise<void>;
	reset(instructions: undefined, context: unknown): Promise<void>;
	compact(instructions: string | undefined, context: unknown): Promise<unknown>;
};

type ChatSubmissionLike = { wait(context: unknown): Promise<unknown> };

function conversationOf(handle: ChatHandle): ChatConversationLike {
	return handle as unknown as ChatConversationLike;
}

export class SpikeAgent extends DurableObject {
	/** 正在跑對話的會話 id（NERE-33：閘門狀態物件由 DO 持有，開合時機在 chat-service）。 */
	private chatGate = createChatGate();
	/** MCP 擴充套件：構建一次後常駐，避免每輪重連造成工具列表抖動。 */
	private mcpExt: { name: string; tools?: unknown[] } | null = null;
	/** 自定義工具擴充套件（v0.36.0）：增刪後重建並重新 install。 */
	private customExt: { name: string; tools?: unknown[] } | null = null;
	/** R5：已載入的自定義工具名，按 DO 例項隔離（同 isolate 多使用者不串用）。 */
	private customToolNames = new Set<string>();
	/** R5：MCP 客戶端快取，按 DO 例項隔離；配置變更時清空。 */
	private mcpCache: McpCache = new Map();
	/** 登錄檔引用：MCP/自定義工具擴充套件在執行時安裝（install 按名替換）。 */
	private registryRef: { install(ext: unknown): void; snapshot(): { installed(): readonly { name: string }[] } } | null = null;
	private storageRef: { scanConversations(q: object, limit: number, cursor: undefined, context: unknown): Promise<unknown> } | null = null;
	/** open() 時裝配的內建擴充套件（工具名清單與 tool-search 目錄用；請求級擴充套件同名替換）。 */
	private baseExt: AgentExtensions | null = null;

	private harness: Harness | null = null;
	/** 測試觀測點（TEST_HARNESS_STATS=1）：本例項真正 open() 的次數；/s/ 零初始化靠它斷言。 */
	private harnessOpens = 0;
	/** DDL 遷移只跑一次：併發的 open()/alarm() 共享同一個 Promise。 */
	private migrated: Promise<void> | null = null;

	private db(): SqlHandle {
		return this.ctx.storage.sql as unknown as SqlHandle;
	}

	private scopeId(): string {
		return (this.ctx.id as { name?: string }).name ?? this.ctx.id.toString();
	}

	private ensureMigrated(): Promise<void> {
		this.migrated ??= Promise.resolve()
			.then(() => {
				migrate(this.db());
			})
			.catch((err) => {
				// 遷移拋錯不能封死這個 DO：清掉 memo，下次 open()/alarm() 重試（遷移自身可重入）。
				this.migrated = null;
				throw err;
			});
		return this.migrated;
	}

	private settingsPort(deps: RequestDeps): SettingsPort {
		return {
			get: (key, fallback) => settingsRepo.get(deps.sql, key, fallback),
			snapshot: () => Object.fromEntries(settingsRepo.listAll(deps.sql).map((row) => [row.key, row.value])),
		};
	}

	private deps(input: { origin: string; userKey: string; env?: AppEnv; scopeId?: string }): RequestDeps {
		const env = input.env ?? (this.env as unknown as AppEnv);
		return {
			sql: this.db(),
			env,
			scopeId: input.scopeId ?? this.scopeId(),
			origin: input.origin,
			userKey: input.userKey,
		};
	}

	/** 工具箱端點：搜尋 / 抓取 / 反思統一從 UI 設定讀取，程式碼裡沒有預設地址。 */
	private toolbox(deps: RequestDeps) {
		return toolboxSettings((key, fallback) => settingsRepo.get(deps.sql, key, fallback));
	}

	private webFetch(deps: RequestDeps) {
		const { baseUrl, apiKey } = this.toolbox(deps);
		return createWebFetch({ apiKey, baseUrl });
	}

	private kbService(deps: RequestDeps): KbService {
		return createKbService({
			sql: deps.sql,
			env: deps.env,
			scopeId: deps.scopeId,
			settings: this.settingsPort(deps),
			webFetch: this.webFetch(deps),
		});
	}

	private fileService(deps: RequestDeps): FileService {
		return createFileService({ sql: deps.sql });
	}

	/** 按請求裝配分享服務：工具與 HTTP 端點共用，origin/userKey 顯式傳入。 */
	private shareService(deps: RequestDeps): ShareService {
		return createShareService({
			sql: deps.sql,
			settings: this.settingsPort(deps),
			// 工具在 alarm 觸發時沒有請求 Origin：回落到 share_origin 設定（與舊 shareUrlForToken 一致）。
			origin: deps.origin || settingsRepo.get(deps.sql, "share_origin", ""),
			userKey: deps.userKey,
			demoToken: demoShareToken(deps.env.DEMO_SHARE_URL),
			repoUrl: deps.env.REPO_URL,
		});
	}

	/**
	 * 本輪擴充套件：內建工具按請求構造（share 工具需要當前 Origin/userKey），
	 * MCP 與自定義工具沿用例項級擴充套件（R5：快取與集合都按 DO 隔離）。
	 */
	private agentExtensions(deps: RequestDeps): unknown[] {
		const ext = createAgentExtensions({
			sql: deps.sql,
			settings: this.settingsPort(deps),
			files: this.fileService(deps),
			kb: this.kbService(deps),
			shares: this.shareService(deps),
			harness: () => this.harness as unknown as HarnessLike | null,
			toolbox: this.toolbox(deps),
			webFetch: this.webFetch(deps),
		});
		// pi-durable 按副檔名從登錄檔解析工具（configure 只存名字），因此請求級擴充套件必須
		// 先 install 覆蓋同名內建擴充套件，share 工具才能拿到本次請求的 Origin。
		if (this.registryRef) {
			for (const extension of [ext.spike, ext.codemode, ext.toolSearch]) {
				this.registryRef.install(extension as never);
			}
		}
		const list: unknown[] = [ext.spike, ext.codemode, ext.toolSearch];
		if (this.mcpExt && (this.mcpExt.tools?.length ?? 0) > 0) list.push(this.mcpExt);
		if (this.customExt && (this.customExt.tools?.length ?? 0) > 0) list.push(this.customExt);
		return list;
	}

	private async open(): Promise<Harness> {
		if (!this.harness) {
			await this.ensureMigrated();
			const deps = this.deps({ origin: "", userKey: "" });
			const models = createModels();
			// v1.1.0：模型端點只來自 UI（providers 表），沒有內建供應商、不讀環境變數。
			const providerRow = resolveProvider(deps.sql);
			// NERE-85：模型請求統一走帶重試 + 空閒看門狗的 fetch；上游一次斷流不再報廢整輪。
			const providerFetch = createProviderFetch();
			if (providerRow) {
				models.setProvider(withProviderFetch(this.buildCustomProvider(providerRow), providerFetch) as never);
			}
			const registry = createRegistry();
			this.registryRef = registry as unknown as typeof this.registryRef;
			this.baseExt = createAgentExtensions({
				sql: deps.sql,
				settings: this.settingsPort(deps),
				files: this.fileService(deps),
				kb: this.kbService(deps),
				shares: this.shareService(deps),
				harness: () => this.harness as unknown as HarnessLike | null,
				toolbox: this.toolbox(deps),
				webFetch: this.webFetch(deps),
			});
			registry.install(this.baseExt.spike as never);
			// Code mode：模型寫 JS 調 tools.<name>()，QuickJS WASM 沙箱內執行（workerd 原生支援）。
			registry.install(this.baseExt.codemode as never);
			registry.install(this.baseExt.toolSearch as never);
			// Durable Object SQLite: conversations survive DO restarts and redeploys.
			const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
			this.storageRef = storage;
			// MCP 擴充套件在表就緒後構建並安裝；之後由 /api/mcp 變更時重建（快取按例項傳入，R5）。
			this.mcpExt = (await buildMcpExtension(deps.sql, this.mcpCache)) as never;
			if (this.mcpExt) registry.install(this.mcpExt);
			// 自定義工具（v0.36.0）：同樣必須在 Harness.open 之前 install
			this.customExt = buildCustomToolsExtension(deps.sql, this.customToolNames) as never;
			if (this.customExt) registry.install(this.customExt as never);
			this.harness = await Harness.open(
				storage,
				{
					models,
					registry,
					settings: {
						compaction: compactionSettings(this.settingsPort(deps).get),
						// NERE-85：瞬時失敗的重試收斂到 provider fetch 層（3 次嘗試 + 退避），
						// 關掉核心按錯誤文本再重試整輪生成，否則一次斷流會放大成 3×4 次請求、重複計費。
						retry: { enabled: false },
					},
				},
				ctx,
			);
			this.harnessOpens++;
			this.harness.resume();
		}
		return this.harness;
	}

	/** 把一條供應商記錄構造成 pi-ai 的 Provider（OpenAI 相容端點）。 */
	private buildCustomProvider(row: providersRepo.ProviderRow): object {
		const modelIds = splitModels(row.models);
		return createProvider({
			id: row.id,
			name: row.name,
			baseUrl: row.base_url,
			auth: {
				apiKey: {
					name: `${row.name} API key`,
					resolve: async () => ({ auth: { apiKey: row.api_key }, source: "已儲存的金鑰" }),
				},
			},
			// 只填最少必要欄位：成本置零、上下文按 128k 估、多模態保守關閉
			models: modelIds.map((mid) => ({
				id: mid,
				name: mid,
				api: "openai-completions",
				provider: row.id,
				baseUrl: row.base_url,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: false,
				contextWindow: 128_000,
				maxTokens: 16_384,
			})),
			api: openAICompletionsApi(),
		} as never);
	}

	/** 對話域服務（NERE-33）：流式與非流式共用 prepare → submit → finish。 */
	private chatService(deps: RequestDeps): ChatService {
		return createChatService({ sql: deps.sql, runtime: this.chatRuntime(deps) });
	}

	/** 對話域的 Harness 埠：open/重試、會話、擴充套件裝配與事件泵留在 DO 組合根（ADR-0001 §4）。 */
	private chatRuntime(deps: RequestDeps): ChatRuntime {
		return {
			gate: this.chatGate,
			conversation: async (sessionId) => this.conversationFor(await this.open(), deps, sessionId),
			configure: async (handle, input) => {
				this.requireModel(deps);
				const conversation = conversationOf(handle);
				await conversation.configure(
					{
						model: { provider: this.providerId(deps), modelId: this.modelFor(deps, input.sessionId) },
						// 思考檔位（v0.22.0）：off 時不產生 thinking 事件，前端自然不顯示思考塊。
						thinkingLevel: thinkingLevel(this.settingsPort(deps).get),
						extensions: this.agentExtensions(deps) as never,
						instructions: input.instructions,
					},
					ctx,
				);
			},
			instructions: (input) =>
				buildInstructions(
					{ sql: deps.sql, settings: this.settingsPort(deps), kb: this.kbService(deps) },
					input.inv,
					input.sessionId,
					input.message,
				),
			skillInvocation: (message) => parseSkillInvocation(deps.sql, message),
			toolNames: async (handle) => {
				const agent = await conversationOf(handle).agent(ctx);
				return agent.tools.map((tool) => tool.name).filter((name): name is string => Boolean(name));
			},
			lastEntryId: async (handle) => {
				const page = await conversationOf(handle).entries({}, 1, undefined, ctx);
				return Number(page.items[0]?.id ?? 0);
			},
			submit: async (handle, input) => {
				const conversation = conversationOf(handle);
				const submission = await conversation.submit(
					{
						type: "input",
						content: userContent(input.message, input.images) as never,
						...(input.whenBusy ? { whenBusy: input.whenBusy } : {}),
					},
					ctx,
				);
				return { id: String(submission.id ?? ""), raw: submission } satisfies ChatSubmission;
			},
			wait: async (submission) => {
				const raw = submission.raw as ChatSubmissionLike;
				return (await raw.wait(ctx)) as ChatSettled;
			},
			commit: async (handle, answer) =>
				conversationOf(handle).commit((tx) => tx.entry(AssistantEntry, answer), ctx),
			entries: async (handle, opts) => {
				const query = opts?.order ? { order: opts.order } : {};
				const page = await conversationOf(handle).entries(query, opts?.limit ?? 60, undefined, ctx);
				return page.items;
			},
			watch: async (handle, onEvents) => {
				// Pi 1.5+：watchEvents() 已移除，改看會話狀態，由 tracker 還原成舊事件形狀。
				const stream = await (handle as unknown as {
					watch(context: unknown): Promise<{
						value: unknown;
						start(listener: (call: { kind: string; value?: unknown }) => Promise<void>): void;
						stop(): Promise<unknown>;
					}>;
				}).watch(ctx);
				const tracker = createViewEventTracker();
				tracker.next(stream.value as ViewLike, true);
				stream.start(async (call) => {
					if (call.kind !== "value") return;
					const events = tracker.next(call.value as ViewLike);
					if (events.length) await onEvents(events);
				});
				return {
					stop: async () => {
						await stream.stop();
					},
				};
			},
			abort: async (handle) => {
				await conversationOf(handle).abort(ctx);
			},
			reset: async (handle) => {
				await conversationOf(handle).reset(undefined, ctx);
			},
			compact: async (handle, instructions) => String(await conversationOf(handle).compact(instructions, ctx)),
			reflect: (conversationId, transcript) =>
				reflectConversation({ sql: deps.sql, ...this.toolbox(deps) }, conversationId, transcript),
			usageTokens: async (handle) => this.goalTokens(await this.open(), handle.id),
			recover: () => this.recoverSession(),
			scheduleAlarm: () => this.scheduleNextAlarm(),
			waitUntil: (promise) => {
				this.ctx.waitUntil(promise);
			},
		};
	}

	/** 會話當前供應商 / 模型（全部來自 UI 的 providers 表）。 */
	private providerId(deps: RequestDeps): string {
		return effectiveProviderId(deps.sql);
	}

	private defaultModelId(deps: RequestDeps): string {
		return activeModelIds(deps.sql)[0] ?? "";
	}

	/** 沒有可用供應商時給出可操作的報錯，而不是把請求發到任何預設地址。 */
	private requireModel(deps: RequestDeps): void {
		if (activeModelIds(deps.sql).length > 0 && this.providerId(deps)) return;
		throw new AppError(
			"model_not_configured",
			400,
			"尚未配置模型供應商。請到 設定 → 模型與工具服務 新增一個 OpenAI 相容端點（Base URL、API Key、模型 ID）。",
		);
	}

	private modelFor(deps: RequestDeps, sessionId?: string): string {
		const available = activeModelIds(deps.sql);
		const fallback = available[0] ?? "";
		if (!sessionId) return fallback;
		try {
			const model = getModel(deps.sql, sessionId);
			return model && available.includes(model) ? model : fallback;
		} catch {
			return fallback;
		}
	}

	/** pi-durable 在儲存錯誤後會把會話標記為 SessionFailed：必須 close + reopen 再重試一次（v0.46.1）。 */
	private async retryOnSessionError<T>(harness: Harness, run: (h: Harness) => Promise<T>): Promise<T> {
		try {
			return await run(harness);
		} catch (err) {
			if (!/SessionFailed|storage error/i.test(String(err))) throw err;
			await this.recoverSession();
			return run(await this.open());
		}
	}

	private async conversationFor(harness: Harness, deps: RequestDeps, sessionId?: string) {
		return this.retryOnSessionError(harness, (h) => this.findConversation(h, deps, sessionId));
	}

	private async findConversation(harness: Harness, deps: RequestDeps, sessionId?: string) {
		const agentChange = {
			model: { provider: this.providerId(deps), modelId: this.modelFor(deps, sessionId) },
			extensions: this.agentExtensions(deps) as never,
		};
		if (sessionId) {
			const numeric = Number(sessionId);
			if (Number.isFinite(numeric) && numeric > 0) {
				const existing = await harness.conversation(numeric as never, ctx);
				if (existing) return existing;
			}
		}
		return harness.root(ctx, { agent: agentChange });
	}

	/** 會話域的 Harness 埠：open/重試/模型與擴充套件配置留在 DO，Service 只做編排。 */
	private sessionRuntime(deps: RequestDeps): SessionRuntime {
		return {
			entries: async (sessionId) => {
				const harness = await this.open();
				const conversation = await this.conversationFor(harness, deps, sessionId);
				const page = await conversation.entries({}, 200, undefined, ctx);
				return { conversationId: String(conversation.id), items: page.items };
			},
			createConversation: async () => {
				const harness = await this.open();
				const conversation = await this.retryOnSessionError(harness, (h) =>
					h.createConversation(
						{
							ownership: { kind: "ownerless" },
							agent: {
								model: { provider: this.providerId(deps), modelId: this.defaultModelId(deps) },
								extensions: this.agentExtensions(deps) as never,
							},
						},
						ctx,
					),
				);
				return String(conversation.id);
			},
			forkBefore: async (sessionId, entryId) => {
				const harness = await this.open();
				const parent = await this.conversationFor(harness, deps, sessionId);
				const typed = parent as unknown as {
					id: number;
					entries(query: object, limit: number, cursor: undefined, c: unknown): Promise<{ items: readonly { id?: unknown }[] }>;
					fork(at: number, options: { ownership: { kind: string } }, c: unknown): Promise<{ id: unknown }>;
				};
				// 取「這條訊息之前的最新一條」作為分叉點，新會話歷史停在上一條（v0.32.0）。
				const before = await typed.entries({ maxEntryId: entryId - 1 }, 1, undefined, ctx);
				const at = Number((before.items[0] as { id?: unknown } | undefined)?.id);
				if (!Number.isFinite(at) || at <= 0) throw new Error("這條訊息之前沒有歷史，無法分叉");
				const fork = await typed.fork(at, { ownership: { kind: "ownerless" } }, ctx);
				return { id: String(fork.id), parentId: String(typed.id), at };
			},
			rootId: async () => {
				const harness = await this.open();
				const root = await this.retryOnSessionError(harness, (h) => h.root(ctx));
				return String(root.id);
			},
			scanConversationIds: async () => {
				await this.open();
				const scan = (await this.storageRef!.scanConversations({}, 100, undefined, ctx)) as {
					items: readonly { id: unknown }[];
				};
				return scan.items.map((item) => String(item.id));
			},
			modelFor: (sessionId) => this.modelFor(deps, sessionId),
			pauseGoal: (sessionId) => {
				try {
					writeGoal(deps.sql, sessionId, { status: "paused", next_run_at: 0 });
				} catch {
					// 沒有目標時忽略
				}
			},
		};
	}

	/**
	 * 分享域的 Harness 埠：只有會話分享真正要讀條目時才會走到這裡。
	 * 檔案分享、失效 token、過期 token 由 share-service 在 open() 之前短路。
	 */
	private shareRuntime(): ShareRuntime {
		return {
			conversationId: async (sessionId) =>
				String((await this.conversationFor(await this.open(), this.deps({ origin: "", userKey: "" }), sessionId)).id),
			entries: async (sessionId) => {
				const conversation = await (await this.open()).conversation(Number(sessionId) as never, ctx);
				if (!conversation) return [];
				const page = await conversation.entries({}, 500, undefined, ctx);
				return page.items;
			},
		};
	}

	private automationService(): AutomationService {
		return createAutomationService(this.db());
	}

	private settingsRuntime(): SettingsRuntime {
		return { recover: () => this.recoverSession() };
	}

	private alarmRuntime(): AlarmRuntime {
		return { schedule: () => this.scheduleNextAlarm() };
	}

	private contextRuntime(deps: RequestDeps): ContextRuntime {
		return {
			usage: async (sessionId) => {
				const service = createContextService({
					entries: async (id) => {
						const harness = await this.open();
						const conversation = await this.conversationFor(harness, deps, id);
						const page = await conversation.entries({}, 500, undefined, ctx);
						return page.items as readonly Record<string, unknown>[];
					},
				});
				return service.usage(sessionId);
			},
		};
	}

	private goalRuntime(deps: RequestDeps): GoalRuntime {
		return {
			baselineTokens: async (sessionId) => {
				const harness = await this.open();
				const conversation = await this.conversationFor(harness, deps, sessionId);
				return this.goalTokens(harness, conversation.id);
			},
		};
	}

	/** R5：工具清單與自定義工具名都按例項取，不讀模組級集合。 */
	private toolRuntime(): ToolRuntime {
		return {
			names: () => {
				const names = new Set<string>();
				for (const ext of [
					this.baseExt?.spike,
					this.baseExt?.codemode,
					this.baseExt?.toolSearch,
					this.mcpExt,
					this.customExt,
				] as unknown as { tools?: { name?: string }[] }[]) {
					for (const tool of ext?.tools ?? []) if (tool.name) names.add(tool.name);
				}
				return [...names];
			},
			customNames: () => [...this.customToolNames],
		};
	}

	private mcpRuntime(deps: RequestDeps): McpRuntime {
		return {
			rebuild: async () => {
				this.mcpCache.clear();
				const rebuilt = await buildMcpExtension(deps.sql, this.mcpCache);
				if (rebuilt) {
					this.mcpExt = rebuilt as never;
					if (this.registryRef) this.registryRef.install(rebuilt);
				}
				return rebuilt?.tools?.length ?? 0;
			},
		};
	}

	/** 資料域埠：匯出/反思讀 Harness；恢復後清 MCP 快取並重建擴充套件。 */
	private dataRuntime(deps: RequestDeps): DataRuntime {
		return {
			exportSnapshot: async (sessionId) => {
				const harness = await this.open();
				const conversation = await this.conversationFor(harness, deps, sessionId);
				const page = (await conversation.entries({}, 1000, undefined, ctx)) as {
					items: readonly Record<string, unknown>[];
				};
				const id = String(conversation.id);
				let title = `會話 ${id}`;
				try {
					const row = sessionsRepo.get(deps.sql, id);
					if (row?.title) title = row.title;
				} catch {
					// 後設資料缺失時用預設標題
				}
				return { sessionId: id, title, entries: page.items };
			},
			reflect: async (sessionId) => {
				const harness = await this.open();
				const conversation = await this.conversationFor(harness, deps, sessionId);
				const page = (await conversation.entries({}, 1, undefined, ctx)) as { items: readonly { id?: number }[] };
				return this.chatService(deps).maybeReflect(conversation as never, Number(page.items[0]?.id ?? 0));
			},
			afterRestore: async () => {
				this.mcpCache.clear();
				const rebuilt = await buildMcpExtension(deps.sql, this.mcpCache);
				if (rebuilt) {
					this.mcpExt = rebuilt as never;
					if (this.registryRef) this.registryRef.install(rebuilt);
				}
			},
		};
	}

	/** 系統域埠：`/debug/agent` 的登錄檔快照（可附帶本輪 instructions）。 */
	private debugRuntime(deps: RequestDeps): DebugRuntime {
		return {
			inspect: async ({ message, sessionId }) => {
				const harness = await this.open();
				const root = await this.retryOnSessionError(harness, (h) => h.root(ctx));
				const mcpExtDbg = await buildMcpExtension(deps.sql, this.mcpCache);
				if (mcpExtDbg && this.registryRef) this.registryRef.install(mcpExtDbg);
				if (!this.customExt) this.customExt = buildCustomToolsExtension(deps.sql, this.customToolNames) as never;
				await (root as unknown as { configure(options: unknown, c: unknown): Promise<void> }).configure(
					{ extensions: this.agentExtensions(deps) as never },
					ctx,
				);
				const agent = await root.agent(ctx);
				const a = agent as unknown as {
					tools?: readonly { name?: string }[];
					callable?: readonly { name?: string }[];
					deferred?: readonly { name?: string }[];
					extensions?: readonly { name?: string }[];
					sections?: readonly { key?: string }[];
				};
				const names = (x?: readonly { name?: string }[]) => (x ?? []).map((t) => t.name);
				return {
					tools: names(a.tools),
					callable: names(a.callable),
					deferred: names(a.deferred),
					extensions: names(a.extensions),
					sections: (a.sections ?? []).map((x) => x.key),
					mcpToolCount: mcpExtDbg ? (mcpExtDbg.tools?.length ?? 0) : 0,
					customToolCount: (this.customExt as { tools?: unknown[] } | null)?.tools?.length ?? 0,
					installed: this.registryRef?.snapshot().installed().map((e) => e.name) ?? null,
					// 傳 message 時返回本輪 instructions，用於確認技能 / 知識庫預檢索的注入（v0.46.0）
					instructions:
						message
							? (
									await buildInstructions(
										{ sql: deps.sql, settings: this.settingsPort(deps), kb: this.kbService(deps) },
										null,
										sessionId,
										message,
									)
								).instructions
							: undefined,
				};
			},
		};
	}

	private customToolsRuntime(deps: RequestDeps): CustomToolsRuntime {
		return {
			save: (body) => {
				const saved = saveCustomTool(deps.sql, body as never, this.customToolNames);
				this.customExt = saved.extension as never;
				if (this.registryRef) this.registryRef.install(this.customExt as never);
				return { name: saved.name, tools: saved.extension.tools?.length ?? 0 };
			},
			remove: (name) => {
				const removed = removeCustomTool(deps.sql, name, this.customToolNames);
				this.customExt = removed.extension as never;
				if (this.registryRef) this.registryRef.install(this.customExt as never);
				return { tools: removed.extension.tools?.length ?? 0 };
			},
		};
	}

	/** 會話儲存出錯後重建 Harness（pi-durable 要求 close + reopen）。 */
	async recoverSession(): Promise<void> {
		try {
			if (this.harness) await this.harness.close(ctx).catch(() => {});
		} catch {
			// 關閉失敗也繼續重建
		}
		this.harness = null;
	}

	/**
	 * 清空該 DO 的全部儲存（NERE-24 purge）：先關 Harness，再刪 SQL/條目/鬧鐘。
	 * 遷移備忘一起清掉，下一次任何請求（包括舊分享連結）會重建空 schema。
	 */
	private async purgeStorage(): Promise<void> {
		await this.recoverSession();
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm().catch(() => {});
		this.migrated = null;
		this.storageRef = null;
		this.registryRef = null;
		this.baseExt = null;
		this.mcpExt = null;
		this.customExt = null;
		this.customToolNames.clear();
		this.mcpCache.clear();
	}

	/** 下一次鬧鐘時間：定時任務與待續轉目標裡最早的一個（判斷在 automation-service）。 */
	private async scheduleNextAlarm(): Promise<void> {
		try {
			const next = this.automationService().nextAlarmAt();
			if (next !== null) {
				const at = Math.max(Date.now() + 5_000, next);
				await this.ctx.storage.setAlarm(at);
			} else {
				await this.ctx.storage.deleteAlarm();
			}
		} catch (err) {
			console.warn("scheduleNextAlarm failed", err);
		}
	}

	/** DO alarm：執行到點的定時任務。 */
	async alarm(): Promise<void> {
		// 先遷移再看 app_settings（share_origin），失敗交給平臺重試 alarm。
		await this.ensureMigrated();
		return this.handleAlarm();
	}

	private async handleAlarm(): Promise<void> {
		try {
			await this.open();
			const deps = this.deps({ origin: settingsRepo.get(this.db(), "share_origin", ""), userKey: "" });
			const now = Date.now();
			const automations = this.automationService();
			const due = automations.due(now);
			const chat = this.chatService(deps);
			// 每輪建新會話（NERE-84）：複用 `/sessions` 的建立路徑，後設資料與預設模型一致。
			const sessions = createSessionService({ sql: deps.sql, runtime: this.sessionRuntime(deps) });
			await runDueAutomations(due, now, automations, {
				createSession: async () => (await sessions.create()).id,
				hasActive: (sessionId) => chat.hasActive(sessionId),
				run: async (job) => {
					await chat.chat({ message: job.prompt, sessionId: job.session_id || undefined });
				},
				recover: () => this.recoverSession(),
			});
			if (due.length) automations.rescheduleOverdue(now);

			// 目標自動續轉（v0.31.0）：到點的目標推進一輪
			for (const sessionId of automations.dueGoals(now)) {
				if (chat.hasActive(sessionId)) {
					automations.deferGoal(sessionId, now);
					continue;
				}
				try {
					await chat.goalTick(sessionId);
				} catch (err) {
					console.warn(`goal ${sessionId} tick failed`, String(err).slice(0, 200));
					await this.recoverSession();
					automations.deferGoal(sessionId, now);
				}
			}
		} catch (err) {
			console.warn("alarm failed", err);
		}
		await this.scheduleNextAlarm();
	}

	/** 估算當前上下文佔用（v0.42.0）：最近一次模型用量 + 之後新增內容的字元估算。 */
	private async goalTokens(harness: Harness, conversationId: unknown): Promise<number> {
		try {
			const usage = await (harness as unknown as {
				snapshot(
					token: unknown,
					id: unknown,
					c: unknown,
				): Promise<{
					models?: Record<string, { totalTokens?: number }>;
					tools?: Record<string, { totalTokens?: number }>;
				} | undefined>;
			}).snapshot(UsageDoc, conversationId, ctx);
			let total = 0;
			for (const bucket of [usage?.models, usage?.tools]) {
				if (!bucket) continue;
				for (const u of Object.values(bucket)) total += Number(u?.totalTokens ?? 0);
			}
			return total;
		} catch {
			return 0;
		}
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const env = this.env as unknown as AppEnv;
		// 測試觀測點：Harness 真正 open() 的次數。放在路由之前，自身不觸發 open()（NERE-22 驗收）。
		if (url.pathname === "/debug/harness" && request.method === "GET") {
			if (env.TEST_HARNESS_STATS !== "1") return Response.json({ error: "not found" }, { status: 404 });
			return Response.json({ opens: this.harnessOpens });
		}
		// 跨 DO 內部協議（NERE-24）：只有 Worker 主動發起的請求帶這個頭，客戶端偽造會在 Worker 層被剝離。
		const internal = url.pathname.startsWith("/internal/");
		if (internal && request.headers.get("x-pi-internal") !== "1") {
			return Response.json({ error: "not found" }, { status: 404 });
		}
		const deps = this.deps({
			env,
			origin: url.origin,
			userKey: request.headers.get("x-pi-user") ?? "",
			scopeId: this.scopeId(),
		});
		// 每個請求繫結自己的 SQL / Harness / 埠，避免同一 isolate 裡的其它 DO 串資料（不再有 ALS）。
		const context = buildContext({
			req: request,
			env,
			scopeId: deps.scopeId,
			userKey: deps.userKey,
			origin: deps.origin,
			sql: deps.sql,
			ensureMigrated: () => this.ensureMigrated(),
			open: () => this.open(),
			sessionRuntime: this.sessionRuntime(deps),
			shareRuntime: this.shareRuntime(),
			userLifecycleRuntime: { purge: () => this.purgeStorage() },
			settings: this.settingsPort(deps),
			setSetting: (key, value) => settingsRepo.set(deps.sql, key, value),
			settingsRuntime: this.settingsRuntime(),
			alarmRuntime: this.alarmRuntime(),
			contextRuntime: this.contextRuntime(deps),
			goalRuntime: this.goalRuntime(deps),
			toolRuntime: this.toolRuntime(),
			mcpRuntime: this.mcpRuntime(deps),
			chatRuntime: this.chatRuntime(deps),
			dataRuntime: this.dataRuntime(deps),
			debugRuntime: this.debugRuntime(deps),
			customToolsRuntime: this.customToolsRuntime(deps),
			webFetch: this.webFetch(deps),
		});
		return dispatch(context, internal ? internalRoutes : undefined);
	}
}

/* ---------------- 訪問控制（v0.10.0） ---------------- */

const SESSION_COOKIE = "pi_access";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
/** 主人（沿用舊版單一 token）與邀請使用者（u_ 字首）的區分（v0.43.0）。 */
const OWNER_ID = "owner";

/** 舊版主人令牌 = HMAC(ACCESS_PASSWORD, 固定串)，改密碼即全體失效。 */
async function accessToken(password: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	// 標籤刻意保留舊名：它是簽名輸入的一部分，改了會讓所有既有登入 Cookie 失效。
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("pi-harness-access-v1")));
	return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 使用者令牌簽名 = HMAC(ACCESS_PASSWORD, "pi-harness-access-v2:<userId>")。 */
async function userAccessSig(password: string, userId: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`pi-harness-access-v2:${userId}`)),
	);
	return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualStr(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function cookieValue(request: Request, name: string): string | null {
	const header = request.headers.get("cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return decodeURIComponent(rest.join("="));
	}
	return null;
}

/** 邀請使用者狀態查詢次數（僅測試配置 TEST_REGISTRY_STATS=1 時暴露，用於驗收 NERE-23 的請求放大）。 */
let registryLookups = 0;

/** 邀請使用者是否仍然存在（每次請求查登錄檔，吊銷立即生效）。 */
async function userEnabled(env: { UserRegistry: DurableObjectNamespace }, userId: string): Promise<boolean> {
	registryLookups++;
	try {
		const registry = env.UserRegistry.get(env.UserRegistry.idFromName("registry"));
		const res = await registry.fetch(
			new Request(`https://registry/internal/user-status?userId=${encodeURIComponent(userId)}`),
		);
		if (!res.ok) return false;
		const data = (await res.json()) as { ok?: boolean };
		return Boolean(data.ok);
	} catch {
		return false;
	}
}

/** 登入限速引數（v1.1.0）：10 分鐘內失敗 5 次封 15 分鐘。 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

type LoginGuardResult = { blocked: boolean; retryAfter: number };

/** 登入限速：計數放在 UserRegistry DO（跨 isolate 一致），不依賴記憶體。 */
async function loginGuard(
	env: { UserRegistry: DurableObjectNamespace },
	ip: string,
	phase: "check" | "fail" | "reset",
): Promise<LoginGuardResult> {
	try {
		const registry = env.UserRegistry.get(env.UserRegistry.idFromName("registry"));
		const res = await registry.fetch(
			new Request("https://registry/internal/login-guard", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ip, phase }),
			}),
		);
		if (!res.ok) return { blocked: false, retryAfter: 0 };
		return (await res.json()) as LoginGuardResult;
	} catch {
		// 登錄檔不可用時放行，登入本身還會做密碼校驗
		return { blocked: false, retryAfter: 0 };
	}
}

/** 請求來源 IP（Cloudflare 注入；本地開發回落到 unknown）。 */
function clientIp(request: Request): string {
	return (request.headers.get("cf-connecting-ip") ?? "").trim() || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/**
 * 解析登入態（v0.43.0）：
 * - 舊版 64 位 token → 主人；
 * - `<userId>.<sig>` → 對應邀請使用者（每次都確認使用者未被刪除）；
 * - 未配置 ACCESS_PASSWORD → 主人（本地開發/開放模式）。
 */
async function authorizedUser(
	request: Request,
	password: string,
	env: { UserRegistry: DurableObjectNamespace } | null,
): Promise<string | null> {
	if (!password) return OWNER_ID;
	const token = cookieValue(request, SESSION_COOKIE);
	if (!token) return null;
	if (token.length === 64 && timingSafeEqualStr(token, await accessToken(password))) return OWNER_ID;
	const dot = token.lastIndexOf(".");
	if (dot <= 0) return null;
	const userId = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	if (userId !== OWNER_ID && !USER_ID_RE.test(userId)) return null;
	if (!timingSafeEqualStr(sig, await userAccessSig(password, userId))) return null;
	if (userId === OWNER_ID) return OWNER_ID;
	if (!env) return null;
	return (await userEnabled(env, userId)) ? userId : null;
}

/* ---------------- 使用者登錄檔（v0.43.0） ---------------- */

const INVITE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** 無歧義隨機串（去掉 0/1/l/o）。 */
function randomInvite(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return [...bytes].map((b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");
}

/** 邀請碼雜湊：碼本身高熵，SHA-256 足夠；庫裡不存明文。 */
async function hashCode(code: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`pi-harness-invite-v1:${code}`));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 獨立的小 DO：只存 users 表，負責邀請碼校驗與使用者 CRUD。
 * 不載入 Durable Pi 的 Harness，所以每次鑑權查詢都很輕。
 */
export class UserRegistry extends DurableObject {
	/** 登錄檔 DDL 只在首次 fetch 執行一次；SQL 在 db/migrations.ts（階段 6）。 */
	private migrated: Promise<void> | null = null;

	private ensureMigrated(): Promise<void> {
		this.migrated ??= Promise.resolve()
			.then(() => {
				migrateRegistry(this.ctx.storage.sql as unknown as SqlHandle);
			})
			.catch((err) => {
				this.migrated = null;
				throw err;
			});
		return this.migrated;
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		await this.ensureMigrated();
		const db = this.ctx.storage.sql as unknown as SqlHandle;
		try {
			if (url.pathname === "/internal/verify-code" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as { code?: string };
				const code = String(body.code ?? "").trim().toLowerCase();
				if (!code) return Response.json({ ok: false });
				const rows = db
					.exec("SELECT id, name FROM users WHERE code_hash = ?", await hashCode(code))
					.toArray() as { id: string; name: string }[];
				if (!rows[0]) return Response.json({ ok: false });
				db.exec("UPDATE users SET last_used_at = ? WHERE id = ?", new Date().toISOString(), rows[0].id);
				return Response.json({ ok: true, userId: rows[0].id, name: rows[0].name });
			}
			if (url.pathname === "/internal/login-guard" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as { ip?: string; phase?: string };
				const ip = String(body.ip ?? "").slice(0, 64) || "unknown";
				const phase = body.phase === "fail" || body.phase === "reset" ? body.phase : "check";
				const nowMs = Date.now();
				const nowIso = new Date(nowMs).toISOString();
				const row = (
					db.exec("SELECT count, window_start, blocked_until FROM login_failures WHERE ip = ?", ip).toArray() as {
						count: number;
						window_start: string;
						blocked_until: string | null;
					}[]
				)[0];
				if (phase === "reset") {
					db.exec("DELETE FROM login_failures WHERE ip = ?", ip);
					return Response.json({ blocked: false, retryAfter: 0 });
				}
				if (phase === "fail") {
					const fresh = !row || nowMs - Date.parse(row.window_start) > LOGIN_WINDOW_MS;
					const count = fresh ? 1 : row.count + 1;
					const windowStart = fresh ? nowIso : row.window_start;
					const blockedUntil =
						count >= LOGIN_MAX_FAILURES ? new Date(nowMs + LOGIN_BLOCK_MS).toISOString() : (row?.blocked_until ?? null);
					db.exec(
						"INSERT INTO login_failures (ip, count, window_start, blocked_until) VALUES (?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET count = excluded.count, window_start = excluded.window_start, blocked_until = excluded.blocked_until",
						ip,
						count,
						windowStart,
						blockedUntil,
					);
					const blocked = blockedUntil !== null && Date.parse(blockedUntil) > nowMs;
					return Response.json({ blocked, retryAfter: blocked ? Math.ceil((Date.parse(blockedUntil!) - nowMs) / 1000) : 0 });
				}
				const blockedUntil = row?.blocked_until ?? null;
				if (blockedUntil && Date.parse(blockedUntil) > nowMs) {
					return Response.json({ blocked: true, retryAfter: Math.ceil((Date.parse(blockedUntil) - nowMs) / 1000) });
				}
				if (row && nowMs - Date.parse(row.window_start) > LOGIN_WINDOW_MS) {
					db.exec("DELETE FROM login_failures WHERE ip = ?", ip);
				}
				return Response.json({ blocked: false, retryAfter: 0 });
			}
			if (url.pathname === "/internal/user-status" && request.method === "GET") {
				const userId = url.searchParams.get("userId") ?? "";
				return Response.json({ ok: db.exec("SELECT id FROM users WHERE id = ?", userId).toArray().length > 0 });
			}
			if (url.pathname === "/users" && request.method === "GET") {
				const rows = db
					.exec("SELECT id, name, code_hint, created_at, last_used_at FROM users ORDER BY created_at DESC")
					.toArray() as { id: string; name: string; code_hint: string; created_at: string; last_used_at: string | null }[];
				return Response.json({
					users: rows.map((row) => ({
						id: row.id,
						name: row.name,
						codeHint: row.code_hint,
						createdAt: row.created_at,
						lastUsedAt: row.last_used_at,
					})),
				});
			}
			if (url.pathname === "/users" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as { name?: string };
				const name = String(body.name ?? "").trim().slice(0, 40);
				const id = `u_${randomInvite(8)}`;
				const code = randomInvite(16);
				const now = new Date().toISOString();
				db.exec(
					"INSERT INTO users (id, name, code_hash, code_hint, created_at) VALUES (?, ?, ?, ?, ?)",
					id, name, await hashCode(code), code.slice(-4), now,
				);
				return Response.json({
					ok: true,
					user: { id, name, codeHint: code.slice(-4), createdAt: now, lastUsedAt: null },
					code,
				});
			}
			if (url.pathname === "/users/reset" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as { id?: string };
				const id = String(body.id ?? "");
				if (!db.exec("SELECT id FROM users WHERE id = ?", id).toArray().length) {
					return Response.json({ ok: false, error: "使用者不存在" }, { status: 404 });
				}
				const code = randomInvite(16);
				db.exec("UPDATE users SET code_hash = ?, code_hint = ? WHERE id = ?", await hashCode(code), code.slice(-4), id);
				return Response.json({ ok: true, code, hint: code.slice(-4) });
			}
			if (url.pathname === "/users" && request.method === "DELETE") {
				const id = (url.searchParams.get("id") ?? "").trim();
				const rows = id ? db.exec("DELETE FROM users WHERE id = ? RETURNING id", id).toArray() : [];
				return Response.json({ ok: true, id, deleted: rows.length > 0 });
			}
			return Response.json({ error: "not found" }, { status: 404 });
		} catch (err) {
			return Response.json({ error: String(err).slice(0, 200) }, { status: 500 });
		}
	}
}

/** 登入成功：寫 cookie。 */
function sessionResponse(token: string, payload: Record<string, unknown>): Response {
	return new Response(JSON.stringify(payload), {
		headers: {
			"content-type": "application/json",
			"set-cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`,
		},
	});
}

/* ---------------- 使用者吊銷 / 資料處置（NERE-24） ---------------- */

/** 使用者 DO 的顯式內部呼叫：只在 Worker 側構造，帶內部頭，客戶端同名頭在轉發前被剝離。 */
async function callUserData<T>(
	env: Pick<AppEnv, "SpikeAgent">,
	userId: string,
	path: string,
	method: "GET" | "POST",
): Promise<T> {
	const stub = env.SpikeAgent.get(env.SpikeAgent.idFromName(`user:${userId}`));
	const res = await stub.fetch(
		new Request(`https://user${path}`, { method, headers: { "x-pi-internal": "1" } }),
	);
	const data = (await res.json().catch(() => ({}))) as { error?: string };
	if (!res.ok) {
		throw new AppError("cleanup_failed", 502, `使用者資料處置失敗：${data.error ?? res.status}`, true);
	}
	return data as T;
}

async function callRegistry<T>(
	env: Pick<AppEnv, "UserRegistry">,
	path: string,
	method: "GET" | "DELETE",
): Promise<T> {
	const registry = env.UserRegistry.get(env.UserRegistry.idFromName("registry"));
	const res = await registry.fetch(
		new Request(`https://registry${path}`, { method, headers: { "x-pi-internal": "1" } }),
	);
	const data = (await res.json().catch(() => ({}))) as { error?: string };
	if (!res.ok) {
		throw new AppError("registry_failed", 502, `登錄檔操作失敗：${data.error ?? res.status}`, true);
	}
	return data as T;
}

function userAdmin(env: AppEnv) {
	return createUserAdminService({
		deleteRegistryUser: async (id) => {
			const data = await callRegistry<{ deleted?: boolean }>(
				env,
				`/users?id=${encodeURIComponent(id)}`,
				"DELETE",
			);
			return { deleted: Boolean(data.deleted) };
		},
		registryHas: async (id) => {
			const data = await callRegistry<{ ok?: boolean }>(
				env,
				`/internal/user-status?userId=${encodeURIComponent(id)}`,
				"GET",
			);
			return Boolean(data.ok);
		},
		revoke: (id) => callUserData<RevokeResult>(env, id, "/internal/revoke-user", "POST"),
		backup: (id) => callUserData<BackupPayload>(env, id, "/internal/user-backup", "GET"),
		purge: async (id) => {
			const data = await callUserData<{ purged: UserDataCounts }>(env, id, "/internal/purge-user", "POST");
			return data.purged;
		},
	});
}

/** 統一安全頭（v1.1.0）：CSP 與靜態資產 `_headers` 保持一致；分享頁的 HTML 也走這裡。 */
const SECURITY_HEADERS: Record<string, string> = {
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
	"referrer-policy": "no-referrer",
	"permissions-policy": "geolocation=(), microphone=(), camera=(), payment=()",
	"cross-origin-opener-policy": "same-origin",
	"content-security-policy":
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function withSecurityHeaders(res: Response): Response {
	const headers = new Headers(res.headers);
	for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
		if (!headers.has(key)) headers.set(key, value);
	}
	const body = res.status === 204 || res.status === 304 ? null : res.body;
	return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

export default {
	async fetch(request: Request, env: Parameters<typeof handleRequest>[1]): Promise<Response> {
		return withSecurityHeaders(await handleRequest(request, env));
	},
};

/** 真正的請求處理（拆出來只為統一套安全頭）。 */
async function handleRequest(
	request: Request,
		env: {
			SpikeAgent: DurableObjectNamespace;
			UserRegistry: DurableObjectNamespace;
			ACCESS_PASSWORD?: string;
			/** 顯式允許無密碼開放模式（僅本地開發）；不設定時缺少 ACCESS_PASSWORD 直接拒絕服務。 */
			PI_ALLOW_OPEN?: string;
			TEST_REGISTRY_STATS?: string;
			/** 登入頁「看一個真實對話」入口：站內 /s/<token> 或 https 絕對地址。 */
			DEMO_SHARE_URL?: string;
		},
	): Promise<Response> {
		const url = new URL(request.url);
		const password = (env.ACCESS_PASSWORD ?? "").trim();
		// v1.1.0：沒有密碼又沒顯式同意開放模式時，整站拒絕服務，避免誤部署成公開例項。
		if (!password && env.PI_ALLOW_OPEN !== "1") {
			return new Response(
				[
					"durable-pi: 未配置 ACCESS_PASSWORD，已拒絕服務。",
					"",
					"生產部署：npx wrangler secret put ACCESS_PASSWORD（建議 20 位以上隨機串）",
					"本地開發：在 .dev.vars 裡寫 PI_ALLOW_OPEN=1（僅限本機除錯）",
				].join("\n"),
				{ status: 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "3600" } },
			);
		}
		const protect = Boolean(password);
		const userId = await authorizedUser(request, password, env);

		// 測試專用計數端點：只有測試配置顯式開啟且請求者是主人時才存在。
		if (url.pathname === "/api/debug/registry" && request.method === "GET") {
			if (env.TEST_REGISTRY_STATS !== "1" || userId !== OWNER_ID) {
				return Response.json({ error: "not found" }, { status: 404 });
			}
			return Response.json({ lookups: registryLookups });
		}

		// 登入/登出/狀態：不需要已登入。
		if (url.pathname === "/api/auth" && request.method === "GET") {
			const demo = demoShareUrl(env.DEMO_SHARE_URL);
			return Response.json({
				required: protect,
				authenticated: protect ? Boolean(userId) : true,
				owner: !protect || userId === OWNER_ID,
				...(demo ? { demoUrl: demo } : {}),
			});
		}
		if (url.pathname === "/api/login" && request.method === "POST") {
			if (!protect) return Response.json({ ok: true, required: false, owner: true });
			const ip = clientIp(request);
			const guard = await loginGuard(env, ip, "check");
			if (guard.blocked) {
				return Response.json(
					{ error: `嘗試次數過多，請 ${guard.retryAfter} 秒後再試` },
					{ status: 429, headers: { "retry-after": String(guard.retryAfter) } },
				);
			}
			const body = (await request.json().catch(() => ({}))) as { password?: string; code?: string };
			const input = String(body.password ?? body.code ?? "").trim();
			if (!input) return Response.json({ error: "請輸入密碼或邀請碼" }, { status: 400 });
			// 先當主人密碼，再當邀請碼
			if (timingSafeEqualStr(input, password)) {
				await loginGuard(env, ip, "reset");
				return sessionResponse(await accessToken(password), { ok: true, owner: true });
			}
			try {
				const registry = env.UserRegistry.get(env.UserRegistry.idFromName("registry"));
				const res = await registry.fetch(
					new Request("https://registry/internal/verify-code", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ code: input }),
					}),
				);
				const data = (await res.json()) as { ok?: boolean; userId?: string; name?: string };
				if (data.ok && data.userId && USER_ID_RE.test(data.userId)) {
					await loginGuard(env, ip, "reset");
					const token = `${data.userId}.${await userAccessSig(password, data.userId)}`;
					return sessionResponse(token, { ok: true, owner: false, name: data.name ?? "" });
				}
			} catch {
				// 登錄檔不可用時按登入失敗處理
			}
			const after = await loginGuard(env, ip, "fail");
			if (after.blocked) {
				return Response.json(
					{ error: `嘗試次數過多，請 ${after.retryAfter} 秒後再試` },
					{ status: 429, headers: { "retry-after": String(after.retryAfter) } },
				);
			}
			return Response.json({ error: "密碼或邀請碼不正確" }, { status: 401 });
		}
		if (url.pathname === "/api/logout" && request.method === "POST") {
			return new Response(JSON.stringify({ ok: true }), {
				headers: {
					"content-type": "application/json",
					"set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
				},
			});
		}

		// 使用者管理：僅主人；登錄檔 CRUD 轉發到輕量 DO，吊銷/匯出/清空走顯式跨 DO 協議（NERE-24）。
		const userPath =
			url.pathname === "/api/users" ||
			url.pathname === "/api/users/reset" ||
			url.pathname === "/api/users/export" ||
			url.pathname === "/api/users/data";
		if (userPath && (request.method === "GET" || request.method === "POST" || request.method === "DELETE")) {
			if (protect && !userId) return Response.json({ error: "未登入" }, { status: 401 });
			if (protect && userId !== OWNER_ID) return Response.json({ error: "只有主人可以管理使用者" }, { status: 403 });
			try {
				const admin = userAdmin(env);
				const id = (url.searchParams.get("id") ?? "").trim();
				if (url.pathname === "/api/users/export" && request.method === "GET") {
					const backup = await admin.exportData(id);
					return new Response(JSON.stringify(backup), {
						headers: {
							"content-type": "application/json; charset=utf-8",
							"content-disposition": `attachment; filename="user-${id || "unknown"}-backup.json"`,
						},
					});
				}
				if (url.pathname === "/api/users/data" && request.method === "DELETE") {
					const purged = await admin.purge(id, url.searchParams.get("confirm"));
					return Response.json({ ok: true, id, purged });
				}
				if (url.pathname === "/api/users" && request.method === "DELETE") {
					return Response.json(await admin.remove(id));
				}

				const registry = env.UserRegistry.get(env.UserRegistry.idFromName("registry"));
				const inner = new URL(request.url);
				inner.pathname = url.pathname.replace(/^\/api/, "");
				const headers = new Headers(request.headers);
				headers.delete("x-pi-user");
				headers.delete("x-pi-internal");
				const method: string = request.method;
				const init: RequestInit = { method, headers };
				if (method !== "GET" && method !== "HEAD") init.body = request.body;
				return registry.fetch(new Request(inner, init));
			} catch (err) {
				return toResponse(err);
			}
		}

		// 分享頁保持公開：只讀、只含被打包的內容。
		const isShare = url.pathname.startsWith("/s/");
		if (protect && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/agent/")) && !userId) {
			return Response.json({ error: "未登入" }, { status: 401 });
		}

		if (isShare) {
			// 新分享 token 形如 u_ab12cd34.xxxx：按字首路由到對應使用者的 DO；舊連結留在主人 DO。
			const shareUser = /^\/s\/(u_[a-z0-9]{6,16})\./.exec(url.pathname)?.[1];
			const stub = env.SpikeAgent.get(env.SpikeAgent.idFromName(shareUser ? `user:${shareUser}` : "spike"));
			const headers = new Headers(request.headers);
			headers.delete("x-pi-internal");
			headers.set("x-pi-user", shareUser ?? "");
			return stub.fetch(new Request(new URL(request.url), { method: request.method, headers }));
		}

		if (url.pathname.startsWith("/agent/") || url.pathname.startsWith("/api/")) {
			// 每個使用者一個獨立 DO；主人沿用歷史資料所在的 "spike"
			const who = userId ?? OWNER_ID;
			const stub = env.SpikeAgent.get(env.SpikeAgent.idFromName(who === OWNER_ID ? "spike" : `user:${who}`));
			const inner = new URL(request.url);
			inner.pathname = url.pathname.replace(/^\/(agent|api)/, "") || "/";
			const headers = new Headers(request.headers);
			headers.delete("x-pi-internal");
			headers.set("x-pi-user", who);
			const init: RequestInit = { method: request.method, headers };
			if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
			return stub.fetch(new Request(inner, init));
		}
	return Response.json({ ok: true, name: "durable-pi" });
}
