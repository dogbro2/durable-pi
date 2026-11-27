import { Suspense, lazy, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { TopBar } from "./components/TopBar";
import { ChatHeader } from "./components/ChatHeader";
import { MessageList } from "./components/MessageList";
import { Composer } from "./components/Composer";
import { Sidebar } from "./components/Sidebar";
import { Workbench } from "./components/Workbench";
import { Rail, type RailPanel, type RailView } from "./components/Rail";
import { AutomationPanel } from "./components/AutomationPanel";
import { ModalShell } from "./components/ModalShell";
import { GoalBar, GoalDialog } from "./components/GoalBar";
import { ApprovalBar } from "./components/ApprovalBar";
import { AskUserCard } from "./components/AskUserCard";
import { UsersPanel } from "./components/UsersPanel";
import { FilesPanel } from "./components/FilesPanel";
import { SharesPanel } from "./components/SharesPanel";
import { LoginGate } from "./components/LoginGate";
import { Icon } from "./components/Icon";
import { api, ApiError, type BootstrapKey } from "./lib/api";
import { mergeAutomationUpdate, parseAutomationUpdate } from "./lib/automation-edit";
import { installFailureMessage } from "./lib/skill-hub";
import { useBootstrap } from "./hooks/useBootstrap";
import { useSharesSnapshot } from "./hooks/useShares";
import { useUnreadBadges } from "./hooks/useUnreadBadges";
import { unreadScope } from "./lib/unread";
import { shareUrlFor } from "./lib/format";
import { parseEntries, parseKbRefs, truncateOneLine } from "./lib/entries";
import { loadBoolOrNull, saveBool } from "./lib/localStore";
import { LEFT_OPEN_KEY, effectiveRailView, leftPaneWidth, selectRailView } from "./lib/layout";
import { PANEL_IDLE, isSettingsOpen, panelOf, reducePanel } from "./lib/panels";
import { applyTheme, readTheme, type ThemeId } from "./lib/theme";
import { useMediaQuery } from "./lib/useMediaQuery";
import { useBackToClose } from "./lib/useBackToClose";
import type { ApprovalInfo, AskQuestion, AutomationInfo, AutomationPatch, ChatMessage, CustomToolInfo, FileArtifact, FileInfo, GoalInfo, KbRef, McpServerInfo, MemoryInfo, PlanStep, PromptInfo, RuleInfo, SessionListItem, ShareLink, SkillInfo, SkillInstallOutcome, ToolCallInfo } from "./types";

/**
 * 彈窗按需載入（NERE-81）：設定 / 知識庫 + MCP / 技能都不在首屏路徑上，走動態 import 分包。
 * 知識庫與 MCP 共用一個 chunk（同一時刻只會開一個），技能與設定各自一個。
 */
const loadPanelDialogs = () => import("./components/PanelDialogs");
const LazyKnowledgePanel = lazy(async () => ({ default: (await loadPanelDialogs()).KnowledgePanel }));
const LazyMcpPanel = lazy(async () => ({ default: (await loadPanelDialogs()).McpPanel }));
const LazySkillPanel = lazy(async () => ({ default: (await import("./components/SkillPanel")).SkillPanel }));
const LazySettingsDialog = lazy(async () => ({ default: (await import("./components/SettingsDialog")).SettingsDialog }));

/** 彈窗內容 chunk 到達前的佔位：只在第一次開啟對應彈窗時出現。 */
function PanelLoading() {
	return <p className="flex flex-1 items-center justify-center p-6 text-xs text-slate-500">正在載入…</p>;
}

const TOOL_SUMMARY_MAX = 60;
const DESKTOP_QUERY = "(min-width: 768px)";
const RIGHT_OPEN_KEY = "pi-harness.right-open";

/** 工具結果 details → 分享連結卡資料（v0.55.0）。寬容解析，缺欄位就返回 null。 */
function shareFromToolDetails(details: unknown): ShareLink | null {
	if (!details || typeof details !== "object" || !("share" in details)) return null;
	const share = details.share;
	if (!share || typeof share !== "object" || !("url" in share) || typeof share.url !== "string") return null;
	const kind = "kind" in share && share.kind === "conversation" ? "conversation" : "file";
	const name = "name" in share && typeof share.name === "string" ? share.name : "";
	return {
		url: share.url,
		title: name || (kind === "conversation" ? "對話分享" : "檔案分享"),
		kind,
		expiresAt: "expiresAt" in share && typeof share.expiresAt === "number" ? share.expiresAt : 0,
		createdAt: "createdAt" in share && typeof share.createdAt === "string" ? share.createdAt : undefined,
		reused: "reused" in share && share.reused === true,
	};
}

/** 歷史回放裡的分享連結：域名統一換成當前頁面的 origin。 */
function withAbsoluteShareLinks(messages: ChatMessage[]): ChatMessage[] {
	return messages.map((message) =>
		message.role === "assistant" && message.shares?.length
			? {
					...message,
					shares: message.shares.map((link) => ({
						...link,
						url: shareUrlFor(link.url, window.location.origin, readTheme()),
					})),
				}
			: message,
	);
}
type PanelState = "loading" | "ready" | "error";
type MobileTab = "chat" | "files";

export default function App() {
	const isDesktop = useMediaQuery(DESKTOP_QUERY);

	// Layout: persisted panel toggles (desktop), mobile tab + drawer
	// 自動擴充套件（v0.15.0）：首次進入按視口寬度決定兩欄預設展開；
	// 使用者手動切換後寫入 localStorage，此後以使用者選擇為準。
	const [leftOpen, setLeftOpen] = useState(() => {
		const saved = loadBoolOrNull(LEFT_OPEN_KEY);
		if (saved !== null) return saved;
		return typeof window === "undefined" ? true : window.innerWidth >= 1024;
	});
	const [rightOpen, setRightOpen] = useState(() => {
		const saved = loadBoolOrNull(RIGHT_OPEN_KEY);
		if (saved !== null) return saved;
		return typeof window === "undefined" ? true : window.innerWidth >= 1280;
	});
	const [mobileTab, setMobileTab] = useState<MobileTab>("chat");
	const [drawerOpen, setDrawerOpen] = useState(false);
	// 手機抽屜：返回手勢關抽屜（與彈窗共用一條歷史記錄）。
	useBackToClose(drawerOpen && !isDesktop, () => setDrawerOpen(false));
	// 左側 Rail 當前展示的面板（v0.21.0）：會話 / 定時 / 使用者等左欄內容
	const [railView, setRailView] = useState<RailView>("sessions");
	// 知識庫 / MCP / 技能三個彈窗（NERE-62）+ 知識庫定位（NERE-41）。
	// 狀態機保證定位請求只屬於這一次開啟：關閉 / 重開都會清空，不會重放上一篇（NERE-75 P1-1）。
	const [panel, dispatchPanel] = useReducer(reducePanel, PANEL_IDLE);
	const activePanel = panelOf(panel);
	const settingsOpen = isSettingsOpen(panel);
	/** 設定彈窗第一次開啟前不載入它的 chunk；開啟過就保持掛載，關閉再開不丟區域性狀態。 */
	const [settingsMounted, setSettingsMounted] = useState(false);
	useEffect(() => {
		if (settingsOpen) setSettingsMounted(true);
	}, [settingsOpen]);
	const kbFocus = panel.kbFocus;
	const kbFocusSeq = useRef(0);
	// 右欄寬度（v0.16.0）：可拖拽分隔條、開啟文件時自動加寬、可最大化閱讀
	const [rightWidth, setRightWidth] = useState(() => {
		const saved = typeof window === "undefined" ? null : Number(localStorage.getItem("pi-right-width") ?? "");
		return Number.isFinite(saved) && saved && saved >= 260 ? saved : 340;
	});
	const [workbenchWide, setWorkbenchWide] = useState(false);
	const rightWidthRef = useRef(rightWidth);
	rightWidthRef.current = rightWidth;
	// 左欄寬度（v0.32.0）：可拖拽
	const [leftWidth, setLeftWidth] = useState(() => {
		const saved = typeof window === "undefined" ? null : Number(localStorage.getItem("pi-left-width") ?? "");
		return Number.isFinite(saved) && saved && saved >= 200 ? saved : 240;
	});
	/** 開啟檔案前的右欄寬度：關閉檔案時還原（null = 無需還原）。 */
	const widthBeforeFileRef = useRef<number | null>(null);

	// Session list
	const [sessionId, setSessionId] = useState("1");
	const [sessions, setSessions] = useState<SessionListItem[]>([]);
	const [theme, setTheme] = useState<ThemeId>(() => readTheme());
	const [auth, setAuth] = useState<{ required: boolean; authenticated: boolean; owner?: boolean; demoUrl?: string } | null>(null);
	const [loginError, setLoginError] = useState<string | null>(null);
	// 分享入口能力門禁（NERE-56）+ 未讀訊號（NERE-74）：登入態確定後拉一次 /api/shares/all，
	// 同一次請求既當能力探測、又給 Rail 算未讀；切回標籤頁會重拉。
	const sharesSnapshot = useSharesSnapshot(!!auth?.authenticated);
	const sharesAvailable = sharesSnapshot.available;
	const [models, setModels] = useState<string[]>([]);
	/** 供應商變更後重新拉取模型列表（v0.27.0）。 */
	const [modelsTick, setModelsTick] = useState(0);
	const [model, setModel] = useState("");
	// 網頁搜尋開關（v0.20.0）：null 表示尚未讀到後端設定
	const [webSearch, setWebSearch] = useState<boolean | null>(null);
	// 知識庫預檢索開關（v0.46.0）：null = 尚未讀取
	const [kbPrefetch, setKbPrefetch] = useState<boolean | null>(null);
	// 工具箱端點（v1.1.0）：搜尋 / 抓取 / 自動記憶，全部由 UI 配置
	const [toolbox, setToolbox] = useState<{ baseUrl: string; hasKey: boolean; keyHint: string; model: string }>({
		baseUrl: "",
		hasKey: false,
		keyHint: "",
		model: "",
	});
	// 知識庫檢索模式（v0.53.0）：fts / vector / hybrid
	const [kbRetrieval, setKbRetrieval] = useState("fts");
	// 思考檔位（v0.22.0）：off / low / high
	const [thinkingLevel, setThinkingLevel] = useState<string>("low");
	// 分享頁署名與預設有效期（v0.55.0）
	const [displayName, setDisplayName] = useState("");
	const [shareTtlSeconds, setShareTtlSeconds] = useState(604800);
	// 上下文壓縮策略（v0.30.0）
	const [compaction, setCompaction] = useState<{
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
		backgroundTokens: number;
	} | null>(null);
	// 當前會話的分步計劃（v0.22.0）
	const [plan, setPlan] = useState<PlanStep[]>([]);
	// 上下文佔用重新整理訊號（v0.42.0）：每輪結束 / 壓縮完成 +1
	const [contextTick, setContextTick] = useState(0);
	// 目標模式（v0.31.0）
	const [goal, setGoal] = useState<GoalInfo | null>(null);
	const [goalDialogOpen, setGoalDialogOpen] = useState(false);
	// 工具審批（v0.33.0）
	const [approvals, setApprovals] = useState<ApprovalInfo[]>([]);
	const [approvalBusy, setApprovalBusy] = useState(false);
	const [approvalSettings, setApprovalSettings] = useState<{ read: string; write: string; exec: string } | null>(null);
	// 互動式問答（v0.37.0）
	const [askQuestions, setAskQuestions] = useState<AskQuestion[]>([]);
	const [askBusy, setAskBusy] = useState(false);
	/** 從聊天裡的檔案卡開啟右欄預覽（v0.22.0）。 */
	const [fileRequest, setFileRequest] = useState<{ name: string; tick: number } | null>(null);
	const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
	const [skills, setSkills] = useState<SkillInfo[]>([]);
	// 提示模板與規則（v0.31.0）
	const [prompts, setPrompts] = useState<PromptInfo[]>([]);
	const [customTools, setCustomTools] = useState<CustomToolInfo[]>([]);
	const [rules, setRules] = useState<RuleInfo[]>([]);
	const [skillsLoading, setSkillsLoading] = useState(true);
	const [skillsError, setSkillsError] = useState<string | null>(null);
	const [automations, setAutomations] = useState<AutomationInfo[]>([]);
	const [automationsLoading, setAutomationsLoading] = useState(true);
	const [automationsError, setAutomationsError] = useState<string | null>(null);
	const [mcpLoading, setMcpLoading] = useState(true);
	const [mcpError, setMcpError] = useState<string | null>(null);
	const [sessionsLoading, setSessionsLoading] = useState(true);
	const [sessionQuery, setSessionQuery] = useState("");

	// Workbench data
	const [files, setFiles] = useState<FileInfo[]>([]);
	/** files 陣列對應的會話：跨會話開啟檔案時避免被「檔案不存在」守衛誤關（v0.45.0）。 */
	const [filesForSession, setFilesForSession] = useState(sessionId);
	const [filesState, setFilesState] = useState<PanelState>("loading");
	const [filesError, setFilesError] = useState<string | null>(null);
	const [memories, setMemories] = useState<MemoryInfo[]>([]);
	const [memoriesState, setMemoriesState] = useState<PanelState>("loading");
	const [memoriesError, setMemoriesError] = useState<string | null>(null);
	const [panelTick, setPanelTick] = useState(0);

	// Rail 未讀圓點（NERE-74）：分享看 lastOpenedAt、定時任務看 lastRunAt，水位存 localStorage。
	// 先算出生效檢視：邀請使用者的「使用者」入口、分享介面未上線時的「分享」入口都不算開啟；
	// 桌面端左欄收起了（或移動端抽屜沒開）也不算看到內容，不能白白清掉圓點。
	const activeRailView = effectiveRailView(railView, { owner: !!auth?.owner, sharesAvailable });
	const leftPanelVisible = isDesktop ? leftOpen : drawerOpen;
	const unread = useUnreadBadges({
		scope: unreadScope(auth?.owner),
		shares: {
			ready: sharesSnapshot.ready,
			items: sharesSnapshot.items,
			active: leftPanelVisible && activeRailView === "shares",
		},
		automations: {
			ready: !automationsLoading,
			items: automations,
			active: leftPanelVisible && activeRailView === "automations",
		},
	});

	/**
	 * 切回標籤頁時重新整理一次面板資料（NERE-74）：定時任務在後臺跑完後 bootstrap 不會自己重取，
	 * 沒有這一步就永遠等不到新的 `last_run_at`，圓點也就不會亮。分享清單的重拉在
	 * useSharesSnapshot 裡自己監聽 visibilitychange / focus。
	 */
	useEffect(() => {
		if (typeof document === "undefined") return;
		const onVisible = () => {
			if (document.visibilityState === "visible") setPanelTick((tick) => tick + 1);
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, []);

	// Chat state
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	/** 空會話起步卡 / 「試用」寫入 Composer 的草稿。 */
	const [starterDraft, setStarterDraft] = useState<string | null>(null);
	/** 每次寫草稿 +1：連點同一個技能也要重新寫入並把游標移到末尾（NERE-59）。 */
	const [draftNonce, setDraftNonce] = useState(0);
	const [pending, setPending] = useState(false);
	const [elapsed, setElapsed] = useState(0);
	const [online, setOnline] = useState(true);
	const [sessionName, setSessionName] = useState("");
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [resetting, setResetting] = useState(false);
	const [reloadKey, setReloadKey] = useState(0);

	/** In-flight /api/chat request, aborted by the 停止 button. */
	const abortRef = useRef<AbortController | null>(null);
	/** Session generation: bumped on 新會話 / switch so stale responses are dropped. */
	const generationRef = useRef(0);
	const idRef = useRef(0);
	const nextId = useCallback(() => `m${++idRef.current}-${Date.now().toString(36)}`, []);

	// 首屏聚合（NERE-26）：17 個只讀面板走一次 /api/bootstrap。
	// panelTick = 面板增刪後重新整理；reloadKey = 使用者點重試；modelsTick = 設定彈窗裡換了供應商。
	const bootstrap = useBootstrap(sessionId, `${reloadKey}:${panelTick}:${modelsTick}`);
	/** 當前會話還沒有可用的 bootstrap 資料：面板顯示載入態（後臺重新整理時不閃）。 */
	const bootstrapPending = bootstrap.loading && (bootstrap.dataSessionId !== sessionId || !bootstrap.data);
	/** 已經整份落地過的 (會話, 重試, 模型變更) 組合：只有它變化時才覆蓋訊息 / 設定 / 計劃等會與本地狀態競爭的資料。 */
	const bootstrapHydratedRef = useRef<{ sessionId: string; reloadKey: number; modelsTick: number } | null>(null);

	// While waiting for a reply, tick the elapsed counter every second
	useEffect(() => {
		if (!pending) return;
		const timer = window.setInterval(() => setElapsed((s) => s + 1), 1000);
		return () => window.clearInterval(timer);
	}, [pending]);

	/**
	 * 首屏聚合落地（NERE-26）：一次 bootstrap 覆蓋 17 個只讀面板。
	 *
	 * 分兩檔寫狀態：
	 * - 面板資料（會話列表 / 檔案 / 記憶 / 技能 / 模板 / 規則 / MCP / 定時任務）每次成功都跟隨服務端，
	 *   等價於原先 panelTick 的逐端點重新整理；
	 * - 會話、訊息、設定、計劃、目標、審批、問答只在「整份資料首次落地 / 使用者重試 / 換供應商」時覆蓋，
	 *   避免每輪結束後的重新整理把流式訊息、本地提示和樂觀更新沖掉。
	 * 單個面板失敗只把對應狀態置空並給出該面板的錯誤文案，其它面板照常渲染。
	 */
	useEffect(() => {
		const data = bootstrap.data;
		if (!data || bootstrap.dataSessionId !== sessionId) return;
		const failures = data.errors;
		const panelError = (key: BootstrapKey, label: string) =>
			failures[key] ? `${label}載入失敗：${failures[key]}` : null;

		// 會話列表：失敗時保留上一份；首次失敗用當前會話兜底，側欄結構不塌。
		if (!failures.sessions) setSessions(data.sessions);
		else setSessions((prev) => (prev.length > 0 ? prev : [{ id: sessionId, title: "當前會話", createdAt: "" }]));
		setSessionsLoading(false);

		// 工作臺檔案 + 記憶庫。
		setFiles(data.files);
		setFilesForSession(sessionId);
		setFilesError(panelError("files", "檔案"));
		setFilesState(failures.files ? "error" : "ready");
		setMemories(data.memories);
		setMemoriesError(panelError("memories", "記憶"));
		setMemoriesState(failures.memories ? "error" : "ready");

		// 左側面板：技能 / 模板 / 規則 / 自定義工具 / MCP / 定時任務。
		setPrompts(data.prompts);
		setRules(data.rules);
		setCustomTools(data.customTools);
		setSkills(data.skills);
		setSkillsError(panelError("skills", "技能"));
		setSkillsLoading(false);
		setAutomations(data.automations);
		setAutomationsError(panelError("automations", "定時任務"));
		setAutomationsLoading(false);
		setMcpServers(data.mcpServers);
		setMcpError(panelError("mcpServers", "MCP"));
		setMcpLoading(false);

		const last = bootstrapHydratedRef.current;
		const full = last?.sessionId !== sessionId || last?.reloadKey !== reloadKey || last?.modelsTick !== modelsTick;
		if (!full) return;
		bootstrapHydratedRef.current = { sessionId, reloadKey, modelsTick };

		setOnline(data.session.ok);
		setSessionName(data.session.name);
		setLoading(false);
		setLoadError(panelError("entries", "會話記錄"));
		setMessages(withAbsoluteShareLinks(parseEntries(data.entries)));

		const settings = data.settings;
		if (settings) {
			setWebSearch(settings.webSearch !== false);
			if (typeof settings.kbPrefetch === "boolean") setKbPrefetch(settings.kbPrefetch);
			if (typeof settings.kbRetrieval === "string") setKbRetrieval(settings.kbRetrieval);
			if (typeof settings.thinkingLevel === "string") setThinkingLevel(settings.thinkingLevel);
			if (typeof settings.displayName === "string") setDisplayName(settings.displayName);
			if (typeof settings.shareTtlSeconds === "number") setShareTtlSeconds(settings.shareTtlSeconds);
			if (settings.compaction) setCompaction(settings.compaction);
			if (settings.approval) setApprovalSettings(settings.approval);
			if (settings.toolbox) {
				setToolbox({
					baseUrl: settings.toolbox.baseUrl ?? "",
					hasKey: Boolean(settings.toolbox.hasKey),
					keyHint: settings.toolbox.keyHint ?? "",
					model: settings.toolbox.model ?? "",
				});
			}
		} else {
			// 設定面板失敗時沿用原 api.settings 失敗分支的預設值
			setWebSearch(true);
		}

		if (!failures.models) {
			if (data.models.models.length > 0) setModels(data.models.models);
			if (data.models.default) setModel(data.models.default);
		}

		setPlan(data.plan);
		setGoal(data.goal);
		setApprovals(data.approvals);
		setAskQuestions(data.questions);
	}, [bootstrap.data, bootstrap.dataSessionId, sessionId, reloadKey, modelsTick]);

	/**
	 * 整份 bootstrap 失敗（網路 / 401 / 5xx）：只有當前會話還沒有可用資料時才降級成錯誤態；
	 * 同一會話的後臺重新整理失敗保留上一份面板，不打斷正在看的內容。
	 */
	useEffect(() => {
		if (!bootstrap.error) return;
		if (bootstrap.dataSessionId === sessionId && bootstrap.data) return;
		const detail = bootstrap.error;
		setOnline(false);
		setLoading(false);
		setLoadError(detail);
		setSessionsLoading(false);
		setFilesState("error");
		setFilesError(detail);
		setMemoriesState("error");
		setMemoriesError(detail);
		setSkillsLoading(false);
		setSkillsError("載入技能失敗。");
		setAutomationsLoading(false);
		setAutomationsError("載入定時任務失敗。");
		setMcpLoading(false);
		setMcpError("載入 MCP 伺服器失敗。");
	}, [bootstrap.error, bootstrap.dataSessionId, bootstrap.data, sessionId]);

	/** 拉取待審批列表（工具被攔下後呼叫）。 */
	const refreshApprovals = useCallback(async () => {
		try {
			const data = await api.approvals(sessionId);
			setApprovals(data.approvals ?? []);
		} catch {
			// 忽略：下一次事件會再拉
		}
	}, [sessionId]);

	/** Send one message (event handler, not an effect). */
	const handleSend = useCallback(
		(text: string, images: string[] = []) => {
			if (pending) return;
			const generation = generationRef.current;
			const controller = new AbortController();
			abortRef.current = controller;

			setMessages((prev) => [...prev, { id: nextId(), role: "user", text: text || "（圖片）", images: images.length ? images : undefined }]);
			setPending(true);
			setElapsed(0);

			void (async () => {
				// Streaming bubble: created on first delta / tool event so an empty wait shows nothing.
				let bubbleId = nextId();
				let bubbleShown = false;
				let buffered = "";
				let thinkingBuf = "";
				const tools: ToolCallInfo[] = [];
				const artifacts: FileArtifact[] = [];
				const shareLinks: ShareLink[] = [];
				/** 壓縮提示（v0.31.0）：start 時插一條 notice，end 時把它改成完成態。 */
				let compactionNoticeId: string | null = null;
				const ensureBubble = () => {
					if (bubbleShown) return;
					bubbleShown = true;
					setMessages((prev) => [...prev, { id: bubbleId, role: "assistant", text: "", tools: [] }]);
				};
				const syncBubble = () => {
					setMessages((prev) =>
						prev.map((m) =>
							m.id === bubbleId
								? {
										...m,
										text: buffered || " ",
										thinking: thinkingBuf || undefined,
										tools: tools.length ? tools.map((t) => ({ ...t })) : [],
										files: artifacts.length ? [...artifacts] : undefined,
										shares: shareLinks.length ? [...shareLinks] : undefined,
									}
								: m,
						),
					);
				};
				// 目標續轉（v0.31.0）：新一輪從一條空氣泡重新開始，上一輪的內容保持不動
				const startNewRound = (label: string) => {
					bubbleShown = false;
					bubbleId = nextId();
					buffered = "";
					thinkingBuf = "";
					tools.length = 0;
					artifacts.length = 0;
					shareLinks.length = 0;
					setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: label }]);
				};
				// update_plan 的入參就是最新計劃：聊天裡實時渲染，不用等工具結果
				const applyPlan = (args: unknown) => {
					const steps = (args as { steps?: unknown })?.steps;
					if (!Array.isArray(steps)) return;
					const parsed: PlanStep[] = [];
					for (const item of steps) {
						const o = (item ?? {}) as { title?: unknown; status?: unknown };
						const title = String(o.title ?? "").trim();
						if (!title) continue;
						const s = String(o.status ?? "pending");
						parsed.push({ title, status: s === "completed" || s === "in_progress" ? s : "pending" });
					}
					if (parsed.length) setPlan(parsed);
				};
				try {
					await api.streamChat(
						text,
						sessionId,
						images,
						(event) => {
							if (generationRef.current !== generation) return;
							if (event.type === "thinking") {
								thinkingBuf += typeof event.delta === "string" ? event.delta : "";
								ensureBubble();
								syncBubble();
							} else if (event.type === "thinking_start") {
								ensureBubble();
							} else if (event.type === "text") {
								buffered += typeof event.delta === "string" ? event.delta : "";
								ensureBubble();
								syncBubble();
							} else if (event.type === "compaction") {
								// 上下文壓縮（v0.31.0）：開始 → 插提示；結束 → 改成完成態
								const status = typeof event.status === "string" ? event.status : "";
								if (status === "start") {
									const id = nextId();
									compactionNoticeId = id;
									setMessages((prev) => [...prev, { id, role: "notice", text: "上下文較長，正在壓縮更早的內容…" }]);
								} else if (status === "end") {
									const id = compactionNoticeId;
									setMessages((prev) =>
										prev.map((m) =>
											id && m.id === id ? { ...m, text: "上下文已壓縮：更早的對話被摘要為一條記錄。" } : m,
										),
									);
									setContextTick((tick) => tick + 1);
								}
							} else if (event.type === "goal") {
								// 目標狀態（v0.31.0）：更新目標條；續轉時開新一輪氣泡
								const next = (event.goal ?? null) as GoalInfo | null;
								if (next) setGoal(next);
								if (event.continuing) {
									startNewRound(`繼續推進目標（第 ${Number(event.round ?? 0) + 1} 輪）`);
								} else if (event.finished) {
									setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "目標已結束。" }]);
								} else if (event.paused) {
									setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "目標已暫停：等你回答問題後繼續。" }]);
								} else if (event.scheduled) {
									setMessages((prev) => [
										...prev,
										{ id: nextId(), role: "notice", text: "本輪自動續轉結束，目標仍在進行：稍後會自動接著跑。" },
									]);
								}
							} else if (event.type === "tool_start") {
								const name = typeof event.name === "string" ? event.name : "tool";
								tools.push({
									name,
									summary: "執行中…",
									id: typeof event.id === "string" ? event.id : undefined,
									parentId: typeof event.parentId === "string" ? event.parentId : undefined,
									status: "running",
									args: event.args,
								});
								if (name === "update_plan") applyPlan(event.args);
								// write_file 的入參裡就有檔名 → 直接出檔案卡
								const fileName = (event.args as { name?: unknown } | undefined)?.name;
								if (name === "write_file" && typeof fileName === "string" && fileName.trim()) {
									if (!artifacts.some((f) => f.name === fileName)) artifacts.push({ name: fileName });
								}
								ensureBubble();
								syncBubble();
							} else if (event.type === "tool_end") {
								const id = typeof event.id === "string" ? event.id : undefined;
								const name = typeof event.name === "string" ? event.name : "tool";
								const target = id
									? tools.find((t) => t.id === id)
									: [...tools].reverse().find((t) => t.name === name && t.status === "running");
								// 工具被審批攔下時會在摘要裡說明：立刻重新整理待審批列表
								if (typeof event.summary === "string" && event.summary.includes("待審批")) void refreshApprovals();
								if (typeof event.summary === "string" && event.summary.includes("等待回答")) void refreshQuestions();
								if (target) {
									target.status = event.error ? "error" : "done";
									target.summary =
										typeof event.summary === "string" && event.summary
											? truncateOneLine(event.summary, TOOL_SUMMARY_MAX)
											: "完成";
								}
								// 分享工具：details 裡帶連結 → 直接渲染連結卡（v0.55.0）
								const share = shareFromToolDetails(event.details);
								if (share) {
									const url = shareUrlFor(share.url, window.location.origin, readTheme());
									if (!shareLinks.some((link) => link.url === url)) shareLinks.push({ ...share, url });
								}
								syncBubble();
							} else if (event.type === "done") {
								void refreshApprovals();
								void refreshQuestions();
								setContextTick((tick) => tick + 1);
								const answer = typeof event.answer === "string" ? event.answer : "";
								// 流式補齊（NERE-41）：done 事件與 entry 同一份 kbRefs；預設不追請求
								const kbRefs = parseKbRefs(event.kbRefs ?? []);
								if (!bubbleShown) ensureBubble();
								setMessages((prev) => {
									const next = prev.map((m) =>
										m.id === bubbleId
											? {
													...m,
													text: answer || "（空回覆）",
													thinking: thinkingBuf || undefined,
													tools: tools.length ? tools.map((t) => ({ ...t, status: (t.status === "running" ? "done" : t.status) as ToolCallInfo["status"] })) : [],
													files: artifacts.length ? [...artifacts] : undefined,
													shares: shareLinks.length ? [...shareLinks] : undefined,
													kbRefs: kbRefs.length ? kbRefs : undefined,
												}
											: m,
									);
									return next;
								});
							} else if (event.type === "error") {
								ensureBubble();
								setMessages((prev) =>
									prev.map((m) =>
										m.id === bubbleId
											? { ...m, text: `出錯了：${String(event.message ?? "未知錯誤")}`, error: true }
											: m,
									),
								);
							}
						},
						controller.signal,
					);
				} catch (err) {
					if (generationRef.current !== generation) return; // invalidated by 新會話 / session switch
					if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
						setMessages((prev) => [
							...prev,
							{ id: nextId(), role: "notice", text: "已停止等待本次回覆（服務端可能仍在處理）。" },
						]);
					} else {
						const detail = err instanceof Error ? err.message : String(err);
						setMessages((prev) => [...prev, { id: nextId(), role: "assistant", text: `請求失敗：${detail}`, error: true }]);
					}
				} finally {
					if (abortRef.current === controller) abortRef.current = null;
					if (generationRef.current === generation) {
						setPending(false);
						// New files / memories may have been produced by this round — refresh the workbench
						setPanelTick((tick) => tick + 1);
					}
				}
			})();
		},
		[pending, nextId, sessionId],
	);

	/** 建立目標並立刻發出第一輪（v0.31.0）。 */
	const handleCreateGoal = useCallback(
		async (objective: string, tokenBudget: number, maxTurns: number): Promise<boolean> => {
			try {
				const res = await api.setGoal({ sessionId, objective, tokenBudget, maxTurns });
				if (!res.goal) return false;
				setGoal(res.goal);
				handleSend(objective, []);
				return true;
			} catch {
				return false;
			}
		},
		[sessionId, handleSend],
	);

	/** 從某條使用者訊息分叉出新會話（v0.32.0）。 */
	const handleBranch = useCallback(
		(entryId: number) => {
			if (resetting || pending) return;
			abortRef.current?.abort();
			generationRef.current += 1;
			void (async () => {
				try {
					const res = await api.branch(sessionId, entryId);
					if (!res.id) throw new Error(res.error || "分支建立失敗");
					setSessionId(res.id);
					setMessages([]);
					setPending(false);
					setElapsed(0);
					setPanelTick((tick) => tick + 1);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `分支出錯：${detail}` }]);
				}
			})();
		},
		[sessionId, resetting, pending, nextId],
	);

	/** 審批決定（v0.33.0）：允許後自動讓模型繼續，拒絕則讓它改方案。 */
	const handleDecideApproval = useCallback(
		(id: number, action: "once" | "always" | "deny") => {
			setApprovalBusy(true);
			void (async () => {
				try {
					const res = await api.decideApproval(id, action);
					setApprovals((prev) => prev.filter((a) => a.id !== id));
					if (res.resume) handleSend(res.resume, []);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `審批失敗：${detail}` }]);
				} finally {
					setApprovalBusy(false);
				}
			})();
		},
		[sessionId, handleSend, nextId],
	);

	/** 拉取待回答問題（ask_user 觸發後呼叫）。 */
	const refreshQuestions = useCallback(async () => {
		try {
			const data = await api.questions(sessionId);
			setAskQuestions((data.questions ?? []) as AskQuestion[]);
		} catch {
			// 忽略：下一次事件會再拉
		}
	}, [sessionId]);

	/** 提交問答卡片的回答（v0.37.0）：把答案發回給模型繼續。 */
	const handleAnswerQuestion = useCallback(
		(id: number, answers: { id: string; choice?: string; text?: string }[]) => {
			setAskBusy(true);
			void (async () => {
				try {
					const res = await api.answerQuestion(id, answers);
					setAskQuestions((prev) => prev.filter((q) => q.id !== id));
					if (res.resume) handleSend(res.resume, []);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `提交回答失敗：${detail}` }]);
				} finally {
					setAskBusy(false);
				}
			})();
		},
		[sessionId, handleSend, nextId],
	);

	/** 生成中插話（v0.34.0）：訊息進入當前這輪，不打斷。 */
	const handleInterject = useCallback(
		(text: string) => {
			if (!text.trim()) return;
			setMessages((prev) => [...prev, { id: nextId(), role: "user", text }]);
			void (async () => {
				try {
					await api.interject(sessionId, text);
					setMessages((prev) => [
						...prev,
						{ id: nextId(), role: "notice", text: "已插入本輪：模型會在下一次工具呼叫後看到。" },
					]);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `插話失敗：${detail}` }]);
				}
			})();
		},
		[sessionId, nextId],
	);

	/** 審批策略（v0.33.0）：分級或逐工具覆蓋。 */
	const handleChangeApproval = useCallback(
		(patch: Partial<{ read: string; write: string; exec: string }>) => {
			setApprovalSettings((prev) => ({ read: "allow", write: "allow", exec: "allow", ...(prev ?? {}), ...patch }));
			void api.setSettings({ approval: patch }).catch(() => {
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "審批策略儲存失敗。" }]);
			});
		},
		[nextId],
	);

	const handleChangeApprovalTool = useCallback(
		(name: string, policy: string) => {
			void api.setSettings({ approvalTools: { [name]: policy } }).catch(() => {
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "逐工具策略儲存失敗。" }]);
			});
		},
		[nextId],
	);

	/** 停止目標的自動續轉（保留記錄）。 */
	/** 自定義工具（v0.36.0）：增刪後重新整理能力面板。 */
	const handleAddCustomTool = useCallback(
		async (name: string, description: string, parameters: string, code: string) => {
			try {
				await api.addCustomTool({ name, description, parameters, code });
				setPanelTick((tick) => tick + 1);
				return true;
			} catch {
				return false;
			}
		},
		[],
	);

	const handleDeleteCustomTool = useCallback(async (name: string) => {
		try {
			await api.deleteCustomTool(name);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleStopGoal = useCallback(async () => {
		try {
			const res = await api.stopGoal(sessionId);
			setGoal(res.goal ?? null);
			setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "已停止目標的自動續轉。" }]);
		} catch {
			setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "停止目標失敗，請重試。" }]);
		}
	}, [sessionId, nextId]);

	/** 停止：先讓服務端真正中止生成（省 token），再斷開本地流（v0.19.0）。 */
	const handleStop = useCallback(() => {
		abortRef.current?.abort();
		void api.abort(sessionId).catch(() => {});
	}, [sessionId]);

	// 訪問控制（一次）
	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const data = await api.auth();
				if (alive) setAuth({ required: !!data.required, authenticated: !!data.authenticated, owner: !!data.owner, demoUrl: data.demoUrl });
			} catch {
				if (alive) setAuth({ required: false, authenticated: true, owner: true });
			}
		})();
		return () => {
			alive = false;
		};
	}, []);

	const handleLogin = useCallback(async (password: string) => {
		setLoginError(null);
		try {
			const result = await api.login(password);
			if (result.ok === false) {
				setLoginError(result.error ?? "密碼不正確");
				return;
			}
			setAuth({ required: true, authenticated: true, owner: !!result.owner });
			// 登入前頁面已在無 cookie 狀態拉過面板資料，直接過載清掉 401 快取（v0.43.2）
			window.location.reload();
		} catch {
			setLoginError("密碼不正確");
		}
	}, []);

	// 切換會話時，從會話列表帶出該會話的模型（若無則預設）
	useEffect(() => {
		const listed = sessions.find((s) => s.id === sessionId);
		if (listed?.model) setModel(listed.model);
	}, [sessions, sessionId]);

	const handleModelChange = useCallback(
		(next: string) => {
			setModel(next);
			void api.setModel(sessionId, next).catch(() => {});
		},
		[sessionId],
	);

	const handleAddSkill = useCallback(async (name: string, description: string, content: string) => {
		try {
			await api.addSkill(name, description, content);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			setSkillsError("儲存技能失敗。");
			return false;
		}
	}, []);

	/**
	 * 技能匯入（NERE-53 / NERE-69）：結果回給呼叫方做行內反饋，不再往聊天流寫 notice。
	 * 彈窗蓋住聊天區，寫在下面的 notice 使用者看不見；Hub 行內直接展示成功 / 失敗原因。
	 */
	const handleImportSkill = useCallback(async (url: string): Promise<SkillInstallOutcome> => {
		try {
			const result = await api.importSkill(url);
			if (result.ok) {
				setPanelTick((tick) => tick + 1);
				return { ok: true, ...(result.name ? { name: result.name } : {}) };
			}
			return { ok: false, message: installFailureMessage(result) };
		} catch (err) {
			const detail = err instanceof Error && err.message ? err.message : String(err);
			return { ok: false, message: detail };
		}
	}, []);

	/** 起步卡與「試用」共用：寫草稿 + 遞增 nonce，讓重複點同一個技能也會重新聚焦。 */
	const applyComposerDraft = useCallback((text: string) => {
		setStarterDraft(text);
		setDraftNonce((nonce) => nonce + 1);
	}, []);

	/**
	 * 「試用」（NERE-59 / NERE-69）：把 `/技能名 ` 寫進輸入框並聚焦，不自動傳送。
	 * 先關掉技能彈窗：ModalShell 開啟時 #root 是 inert，不關的話輸入框既看不見也拿不到焦點。
	 * 手機端左欄是抽屜，點完要回到聊天頁才看得到輸入框。
	 */
	const handleTrySkill = useCallback(
		(name: string) => {
			dispatchPanel({ type: "close" });
			applyComposerDraft(`/${name} `);
			if (!isDesktop) {
				setDrawerOpen(false);
				setMobileTab("chat");
			}
		},
		[applyComposerDraft, isDesktop],
	);

	const handleAddPrompt = useCallback(async (name: string, description: string, content: string) => {
		try {
			await api.addPrompt(name, description, content);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleDeletePrompt = useCallback(async (name: string) => {
		try {
			await api.deletePrompt(name);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleAddRule = useCallback(async (name: string, content: string) => {
		try {
			await api.addRule(name, content);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleToggleRule = useCallback(async (name: string, enabled: boolean) => {
		try {
			await api.toggleRule(name, enabled);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleDeleteRule = useCallback(async (name: string) => {
		try {
			await api.deleteRule(name);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleDeleteSkill = useCallback(async (name: string) => {
		try {
			await api.deleteSkill(name);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleAddAutomation = useCallback(
		async (name: string, prompt: string, schedule: { kind: string; time?: string; minutes?: number }) => {
			try {
				await api.addAutomation(name, prompt, sessionId, schedule);
				setPanelTick((tick) => tick + 1);
				return true;
			} catch {
				setAutomationsError("建立失敗。");
				return false;
			}
		},
		[sessionId],
	);

	const handleToggleAutomation = useCallback(async (id: string, enabled: boolean) => {
		try {
			await api.toggleAutomation(id, enabled);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	const handleDeleteAutomation = useCallback(async (id: string) => {
		try {
			await api.deleteAutomation(id);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	/** 立即執行（v1.0.4）：手動補跑一次；服務端記 last_run_at / last_status / last_error，完成後重新整理列表。 */
	const handleRunAutomation = useCallback(async (id: string) => {
		try {
			await api.runAutomation(id);
			setPanelTick((tick) => tick + 1);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof ApiError ? err.message : "執行失敗，請重試。" };
		}
	}, []);

	/** 編輯儲存（NERE-65）：按 NERE-64 契約，返回值含更新後欄位與 next_run_at，就地更新列表。 */
	const handleUpdateAutomation = useCallback(async (patch: AutomationPatch) => {
		try {
			const data = await api.updateAutomation(patch);
			const update = parseAutomationUpdate(data.automation) ?? {
				id: patch.id,
				name: patch.name,
				prompt: patch.prompt,
				schedule: patch.schedule,
				sessionId: patch.sessionId,
				freshSession: patch.fresh_session,
			};
			setAutomations((prev) => mergeAutomationUpdate(prev, update));
			return { ok: true };
		} catch (err) {
			return { ok: false, error: err instanceof ApiError ? err.message : "儲存失敗，請重試。" };
		}
	}, []);

	const handleAddMcp = useCallback(async (name: string, url: string, headers?: Record<string, string>) => {
		try {
			const result = await api.addMcp(name, url, headers);
			setPanelTick((tick) => tick + 1);
			setMessages((prev) => [
				...prev,
				{ id: nextId(), role: "notice", text: `已連線 MCP「${name}」：${result.tools ?? 0} 個工具` },
			]);
			return true;
		} catch {
			setMcpError("新增失敗，請檢查地址或金鑰。");
			return false;
		}
	}, [nextId]);

	const handleDeleteMcp = useCallback(async (id: string) => {
		try {
			await api.deleteMcp(id);
			setPanelTick((tick) => tick + 1);
			return true;
		} catch {
			return false;
		}
	}, []);

	/** 新會話：abort in-flight wait → POST /api/sessions → switch to the new conversation. */
	const handleNewSession = useCallback(() => {
		if (resetting) return;
		abortRef.current?.abort();
		generationRef.current += 1;
		setResetting(true);

		void (async () => {
			let created: { id?: string } | null = null;
			try {
				created = await api.createSession();
			} catch {
				created = null;
			}
			setResetting(false);
			const id = created?.id;
			if (!id) {
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "新建會話失敗，請重試。" }]);
				return;
			}
			setSessionId(id);
			setMessages([]);
			setPending(false);
			setElapsed(0);
			setPanelTick((tick) => tick + 1); // refresh the session list
		})();
	}, [resetting, nextId]);

	/** Switch to another session from the sidebar (v3). */
	const handleSelectSession = useCallback(
		(id: string) => {
			setDrawerOpen(false);
			if (id === sessionId) return;
			abortRef.current?.abort();
			generationRef.current += 1;
			setSessionId(id);
			setMessages([]);
			setPending(false);
			setElapsed(0);
			setLoading(true);
			setLoadError(null);
		},
		[sessionId],
	);

	/** 主題切換（v0.24.0）：深色/淺色/米黃/午夜藍，寫入 localStorage 供首屏指令碼使用。 */
	const handleThemeChange = useCallback((next: ThemeId) => {
		setTheme(next);
		applyTheme(next);
	}, []);

	/** 從聊天裡的檔案卡開啟右欄預覽。 */
	const handleOpenFileFromChat = useCallback((name: string) => {
		if (!name) return;
		setFileRequest((prev) => ({ name, tick: (prev?.tick ?? 0) + 1 }));
		setWorkbenchWide(false);
		setRightOpen(true);
		saveBool(RIGHT_OPEN_KEY, true);
	}, []);

	/** 從「全部檔案」跨會話開啟：先切會話，再請求右欄開啟（v0.45.0）。 */
	const handleOpenFileAcrossSessions = useCallback(
		(targetSession: string, name: string) => {
			if (!name) return;
			if (targetSession && targetSession !== sessionId) handleSelectSession(targetSession);
			setFileRequest((prev) => ({ name, tick: (prev?.tick ?? 0) + 1 }));
			setWorkbenchWide(false);
			setRightOpen(true);
			saveBool(RIGHT_OPEN_KEY, true);
			if (!isDesktop) setMobileTab("files");
		},
		[sessionId, handleSelectSession, isDesktop],
	);

	/** 開啟 / 關閉面板彈窗；同一入口再點一次 = 關閉。移動端先收起抽屜，避免兩層遮罩（契約 §5）。 */
	const togglePanel = useCallback(
		(panel: RailPanel) => {
			dispatchPanel({ type: "toggle", panel });
			if (!isDesktop) setDrawerOpen(false);
		},
		[isDesktop],
	);
	const closePanel = useCallback(() => dispatchPanel({ type: "close" }), []);
	const openSettings = useCallback(() => {
		if (!isDesktop) setDrawerOpen(false);
		dispatchPanel({ type: "settings" });
	}, [isDesktop]);
	const closeSettings = useCallback(() => dispatchPanel({ type: "close" }), []);

	/** 知識庫面板按定位請求開啟過文件後呼叫：消費掉 nonce，重開彈窗不再重放（NERE-75 P1-1）。 */
	const handleKbFocusConsumed = useCallback(() => dispatchPanel({ type: "kb-focus-consumed" }), []);

	/** 從訊息裡的參考資料跳到知識庫（NERE-41）：開啟知識庫彈窗並定位原文；手機端先收起抽屜。 */
	const handleOpenKbRef = useCallback(
		(ref: KbRef) => {
			kbFocusSeq.current += 1;
			if (!isDesktop) setDrawerOpen(false);
			dispatchPanel({
				type: "kb-ref",
				focus: { docId: ref.docId, chunkSeq: ref.chunkSeq, nonce: kbFocusSeq.current },
			});
		},
		[isDesktop],
	);

	/** 拖拽分隔條調整右欄寬度（限制在 260px ~ 視口 65%）。 */
	const handleRightResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = rightWidth;
		let current = startWidth;
		const onMove = (e: PointerEvent) => {
			current = Math.min(Math.max(260, startWidth - (e.clientX - startX)), Math.round(window.innerWidth * 0.65));
			setRightWidth(current);
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			// 使用者手動調過寬度：關閉檔案時不要再還原成開啟前的值
			widthBeforeFileRef.current = null;
			try {
				localStorage.setItem("pi-right-width", String(current));
			} catch {
				// 忽略儲存失敗
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, [rightWidth]);

	/** 拖拽分隔條調整左欄寬度（限制在 200px ~ 視口 45%）。 */
	const handleLeftResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = leftWidth;
		let current = startWidth;
		const onMove = (e: PointerEvent) => {
			current = Math.min(Math.max(200, startWidth + (e.clientX - startX)), Math.round(window.innerWidth * 0.45));
			setLeftWidth(current);
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			try {
				localStorage.setItem("pi-left-width", String(current));
			} catch {
				// 忽略儲存失敗
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, [leftWidth]);

	/**
	 * 開啟檔案時自動加寬，保證文件可讀（v0.16.0）；
	 * 關閉檔案時還原到開啟前的寬度並退出全寬閱讀（v0.22.1 修復「關掉標籤頁後右欄沒恢復」）。
	 */
	const handleFileOpenChange = useCallback((open: boolean) => {
		if (open) {
			if (widthBeforeFileRef.current === null) widthBeforeFileRef.current = rightWidthRef.current;
			setRightWidth((w) => (w < 560 ? 560 : w));
			return;
		}
		const before = widthBeforeFileRef.current;
		widthBeforeFileRef.current = null;
		if (before !== null) setRightWidth(before);
		setWorkbenchWide(false);
	}, []);

	/** 備份：下載全量 JSON。 */
	const handleBackup = useCallback(() => {
		const link = document.createElement("a");
		link.href = "/api/backup";
		link.download = `durable-pi-backup-${new Date().toISOString().slice(0, 10)}.json`;
		document.body.appendChild(link);
		link.click();
		link.remove();
	}, []);

	/** 恢復：讀取上傳的 JSON 並回傳後端。 */
	const handleRestore = useCallback((file: File) => {
		void (async () => {
			try {
				const payload = JSON.parse(await file.text()) as unknown;
				const result = await api.restore(payload);
				const counts = result.counts ?? {};
				const text = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join("，");
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `恢復完成：${text || "無新增"}` }]);
				setPanelTick((tick) => tick + 1);
			} catch {
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "恢復失敗，檔案格式不正確。" }]);
			}
		})();
	}, [nextId]);

	/** 分享：生成只讀連結並複製到剪貼簿。 */
	const handleShare = useCallback(() => {
		void (async () => {
			try {
				// 已有未過期的會話分享連結就直接複用（v0.40.0）
				const existing = await api.shares(sessionId, "conversation").catch(() => null);
				const reused = existing?.shares?.[0];
				let url = reused?.url ?? "";
				if (!url) {
					const data = await api.share(sessionId, readTheme());
					url = data.url ?? "";
				}
				if (!url) throw new Error("no url");
				// 域名一律用當前頁面：pages.dev 反代下服務端看到的是 workers.dev 地址
				const absolute = shareUrlFor(url, window.location.origin, readTheme());
				try {
					await navigator.clipboard.writeText(absolute);
					setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `只讀分享連結已複製：${absolute}` }]);
				} catch {
					setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `只讀分享連結：${absolute}` }]);
				}
			} catch {
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "生成分享連結失敗。" }]);
			}
		})();
	}, [sessionId, nextId]);

	/** 匯出當前會話：直接下載 Markdown 檔案。 */
	const handleExport = useCallback(() => {
		const url = `/api/export?format=md&sessionId=${encodeURIComponent(sessionId)}`;
		const link = document.createElement("a");
		link.href = url;
		link.download = `session-${sessionId}.md`;
		document.body.appendChild(link);
		link.click();
		link.remove();
	}, [sessionId]);

	/** 重新命名會話：樂觀更新側欄，失敗回滾由下一次重新整理兜底。 */
	const handleRenameSession = useCallback(
		(id: string, title: string) => {
			setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
			void api.renameSession(id, title).catch(() => setPanelTick((tick) => tick + 1));
		},
		[],
	);

	/** 刪除會話：刪掉後若刪的是當前會話，切到第一個剩餘會話（沒有就新建）。 */
	const handleDeleteSession = useCallback(
		(id: string) => {
			void (async () => {
				try {
					await api.deleteSession(id);
				} catch {
					setPanelTick((tick) => tick + 1);
					return;
				}
				const rest = sessions.filter((s) => s.id !== id);
				setSessions(rest);
				if (id === sessionId) {
					const next = rest[0]?.id;
					if (next) {
						abortRef.current?.abort();
						generationRef.current += 1;
						setSessionId(next);
						setMessages([]);
						setLoading(true);
					} else {
						setMessages([]);
						setPanelTick((tick) => tick + 1);
					}
				}
			})();
		},
		[sessions, sessionId],
	);

	const handleRetry = useCallback(() => {
		setLoading(true);
		setLoadError(null);
		setReloadKey((key) => key + 1);
	}, []);

	const toggleLeft = useCallback(() => {
		// 手機端左欄是抽屜：「收起左欄」就是關抽屜，不去動桌面端的持久化開關。
		if (!isDesktop) {
			setDrawerOpen(false);
			return;
		}
		setLeftOpen((prev) => {
			const next = !prev;
			saveBool(LEFT_OPEN_KEY, next);
			return next;
		});
	}, [isDesktop]);

	const toggleRight = useCallback(() => {
		setRightOpen((prev) => {
			const next = !prev;
			saveBool(RIGHT_OPEN_KEY, next);
			return next;
		});
	}, []);

	/** 網頁搜尋開關：樂觀更新，失敗回滾並提示。 */
	const handleToggleWebSearch = useCallback(
		(next: boolean) => {
			setWebSearch(next);
			void api.setSettings({ webSearch: next }).catch(() => {
				setWebSearch(!next);
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "網頁搜尋設定儲存失敗。" }]);
			});
		},
		[nextId],
	);

	/** 工具箱設定（v1.1.0）：端點只在 UI 配置；金鑰不回顯明文。 */
	const handleSaveToolbox = useCallback(
		(patch: { baseUrl?: string; apiKey?: string; model?: string; clearKey?: boolean }) => {
			void api.setSettings({ toolbox: patch }).catch(() => {
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "工具服務設定儲存失敗。" }]);
			});
			setToolbox((prev) => ({
				baseUrl: patch.baseUrl !== undefined ? patch.baseUrl.trim().replace(/\/+$/, "") : prev.baseUrl,
				model: patch.model !== undefined ? patch.model.trim() : prev.model,
				hasKey: patch.clearKey ? false : patch.apiKey ? true : prev.hasKey,
				keyHint: patch.clearKey ? "" : patch.apiKey ? "••••" + patch.apiKey.slice(-4) : prev.keyHint,
			}));
		},
		[nextId],
	);

	/** 知識庫預檢索開關（v0.46.0）：樂觀更新，失敗回滾。 */
	const handleToggleKbPrefetch = useCallback(
		(next: boolean) => {
			setKbPrefetch(next);
			void api.setSettings({ kbPrefetch: next }).catch(() => {
				setKbPrefetch(!next);
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "知識庫預檢索設定儲存失敗。" }]);
			});
		},
		[nextId],
	);

	/** 分享頁署名（v0.55.0）：失焦儲存，失敗回滾並提示。 */
	const handleSaveDisplayName = useCallback(
		(next: string) => {
			const previous = displayName;
			const value = next.trim().slice(0, 40);
			setDisplayName(value);
			void api.setSettings({ displayName: value }).catch(() => {
				setDisplayName(previous);
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "分享署名儲存失敗。" }]);
			});
		},
		[displayName, nextId],
	);

	/** 分享預設有效期（v0.55.0）：tool 不傳 ttlSeconds 時使用。 */
	const handleChangeShareTtl = useCallback(
		(next: number) => {
			const previous = shareTtlSeconds;
			setShareTtlSeconds(next);
			void api.setSettings({ shareTtlSeconds: next }).catch(() => {
				setShareTtlSeconds(previous);
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "分享有效期設定儲存失敗。" }]);
			});
		},
		[shareTtlSeconds, nextId],
	);

	/** 知識庫檢索模式（v0.53.0）：樂觀更新，失敗回滾。 */
	const handleChangeKbRetrieval = useCallback(
		(next: string) => {
			const previous = kbRetrieval;
			setKbRetrieval(next);
			void api.setSettings({ kbRetrieval: next }).catch(() => {
				setKbRetrieval(previous);
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "知識庫檢索模式儲存失敗。" }]);
			});
		},
		[kbRetrieval, nextId],
	);

	/** 思考檔位（v0.22.0）：off/低/高，後端在下一次對話生效。 */
	const handleChangeThinkingLevel = useCallback((next: string) => {
		const prev = thinkingLevel;
		setThinkingLevel(next);
		void api.setSettings({ thinkingLevel: next }).catch(() => {
			setThinkingLevel(prev);
			setMessages((m) => [...m, { id: nextId(), role: "notice", text: "思考檔位儲存失敗。" }]);
		});
	}, [thinkingLevel, nextId]);

	/** 一鍵清空記憶庫（v0.26.0）。 */
	const handleClearMemories = useCallback(async (): Promise<number | null> => {
		try {
			const result = await api.clearMemories();
			setPanelTick((tick) => tick + 1);
			setMessages((prev) => [
				...prev,
				{ id: nextId(), role: "notice", text: `已清空記憶庫（${result.deleted ?? 0} 條）。` },
			]);
			return result.deleted ?? 0;
		} catch {
			setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: "清空記憶庫失敗。" }]);
			return null;
		}
	}, [nextId]);

	/** 壓縮策略（v0.30.0）：改動後後端會重建 Harness，下一輪生效。 */
	const handleChangeCompaction = useCallback(
		(patch: Partial<{ enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number }>) => {
			setCompaction((prev) => ({
				enabled: patch.enabled ?? prev?.enabled ?? true,
				reserveTokens: patch.reserveTokens ?? prev?.reserveTokens ?? 16384,
				keepRecentTokens: patch.keepRecentTokens ?? prev?.keepRecentTokens ?? 20000,
				backgroundTokens: patch.backgroundTokens ?? prev?.backgroundTokens ?? 32768,
			}));
			void api.setSettings({ compaction: patch }).catch(() => {
				setMessages((m) => [...m, { id: nextId(), role: "notice", text: "壓縮設定儲存失敗。" }]);
			});
		},
		[nextId],
	);

	/** 退出登入：清 cookie 並回到登入閘門。 */
	const handleLogout = useCallback(() => {
		dispatchPanel({ type: "close" });
		void (async () => {
			try {
				await api.logout();
			} catch {
				// 忽略網路錯誤，本地同樣回到登入頁
			}
			setAuth({ required: true, authenticated: false });
		})();
	}, []);

	/** Sidebar 記憶庫入口已移除（v0.21.0）：記憶列表在設定彈窗裡。 */

	// 視窗尺寸跨越斷點時自動展開/收起（使用者手動設定過則不干預）
	useEffect(() => {
		const onResize = () => {
			if (loadBoolOrNull(LEFT_OPEN_KEY) === null) setLeftOpen(window.innerWidth >= 1024);
			if (loadBoolOrNull(RIGHT_OPEN_KEY) === null) setRightOpen(window.innerWidth >= 1280);
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const handleDeleteFile = useCallback(
		async (name: string): Promise<boolean> => {
			try {
				await api.deleteFile(sessionId, name);
				setPanelTick((tick) => tick + 1);
				return true;
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `刪除檔案失敗：${detail}` }]);
				return false;
			}
		},
		[sessionId, nextId],
	);

	const handleDeleteMemory = useCallback(
		async (id: number): Promise<boolean> => {
			try {
				await api.deleteMemory(id);
				setPanelTick((tick) => tick + 1);
				return true;
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				setMessages((prev) => [...prev, { id: nextId(), role: "notice", text: `刪除記憶失敗：${detail}` }]);
				return false;
			}
		},
		[sessionId, nextId],
	);

	/**
	 * 點 Rail 的左欄內容入口（NERE-75 P1-3）：桌面端收起左欄後點「定時」等入口，
	 * 必須重新展開左欄並寫回偏好，否則點了沒有任何反饋。
	 */
	const handleSelectRailView = useCallback(
		(view: RailView) => {
			setRailView(view);
			selectRailView(isDesktop, setLeftOpen, saveBool);
		},
		[isDesktop],
	);

	// 未登入：整屏登入閘門（登入成功後同一組件繼續渲染）
	if (auth && auth.required && !auth.authenticated) {
		return <LoginGate onSubmit={handleLogin} error={loginError} demoUrl={auth.demoUrl} />;
	}
	if (!auth) {
		return (
			<div className="flex h-dvh items-center justify-center bg-slate-950 text-sm text-slate-500">正在檢查訪問許可權…</div>
		);
	}

	const currentSession = sessions.find((s) => s.id === sessionId);
	const sessionLabel = sessionName || (currentSession ? currentSession.title : "");
	// Rail 常駐（v0.21.0），leftOpen 只控制左側內容欄
	const showLeftContent = isDesktop && leftOpen;
	// 全寬閱讀時讓文件獨佔（v0.16.0）：桌面上隱藏聊天欄，避免被擠成窄條
	const showChat = isDesktop ? !workbenchWide : mobileTab === "chat";
	const showWorkbench = isDesktop ? rightOpen : mobileTab === "files";

	/** 左側內容：隨 Rail 切換（會話 / 連線 / 定時 / 技能）。 */
	const sidebar = (
		<Sidebar
			sessions={sessions}
			currentId={sessionId}
			query={sessionQuery}
			sessionsLoading={sessionsLoading}
			onQueryChange={setSessionQuery}
			onSelect={handleSelectSession}
			onRename={handleRenameSession}
			onDelete={handleDeleteSession}
			onCollapse={toggleLeft}
		/>
	);

	const leftContent =
		activeRailView === "sessions" ? (
			sidebar
		) : activeRailView === "files" ? (
			<FilesPanel
				refreshTick={panelTick}
				onOpen={handleOpenFileAcrossSessions}
				onChanged={() => setPanelTick((tick) => tick + 1)}
				onCollapse={toggleLeft}
			/>
		) : activeRailView === "shares" ? (
			<SharesPanel onCollapse={toggleLeft} onLoaded={unread.observeShares} />
		) : activeRailView === "automations" ? (
			<AutomationPanel
				items={automations}
				loading={automationsLoading}
				error={automationsError}
				onAdd={handleAddAutomation}
				onToggle={handleToggleAutomation}
				onDelete={handleDeleteAutomation}
				onUpdate={handleUpdateAutomation}
				onRun={handleRunAutomation}
				defaultSessionId={sessionId}
				onOpenSession={handleSelectSession}
				onCollapse={toggleLeft}
			/>
		) : (
			<UsersPanel onCollapse={toggleLeft} />
		);

	const rail = (
		<Rail
			view={activeRailView}
			panel={activePanel}
			onSelectView={handleSelectRailView}
			onTogglePanel={togglePanel}
			onNewSession={handleNewSession}
			newSessionDisabled={resetting}
			onOpenSettings={openSettings}
			isOwner={!!auth?.owner}
			sharesAvailable={sharesAvailable}
			sharesUnread={unread.shares}
			automationsUnread={unread.automations}
		/>
	);

	return (
		<div className="relative flex h-dvh flex-col bg-slate-950 text-slate-100">
			<TopBar
				online={online}
				sessionLabel={sessionLabel}
				onOpenDrawer={() => setDrawerOpen(true)}
				onOpenSettings={openSettings}
			/>

			<div className="flex min-h-0 flex-1">
				{isDesktop && rail}
				{showLeftContent && (
					<>
						<div
							className="min-w-0 shrink-0"
							style={{ width: leftPaneWidth(activeRailView, leftWidth) }}
						>
							{leftContent}
						</div>
						<div
							role="separator"
							aria-orientation="vertical"
							aria-label="調整會話欄寬度"
							onPointerDown={handleLeftResizeStart}
							className="w-1 shrink-0 cursor-col-resize bg-slate-800/40 transition-colors hover:bg-sky-500/50"
						/>
					</>
				)}

				{showChat && (
					<section className="flex min-w-0 flex-1 flex-col" aria-label="聊天">
						<ChatHeader
							sessionId={sessionId}
							sessionTitle={currentSession?.title ?? ""}
							pending={pending}
							onOpenGoal={() => setGoalDialogOpen(true)}
							goalActive={goal?.status === "active"}
							leftCollapsed={!leftOpen}
							rightCollapsed={!rightOpen}
							onToggleLeft={toggleLeft}
							onToggleRight={toggleRight}
						/>
						<MessageList
							messages={messages}
							pending={pending}
							elapsed={elapsed}
							loading={loading}
							loadError={loadError}
							onRetry={handleRetry}
							plan={plan}
							files={files}
							onOpenFile={handleOpenFileFromChat}
							onBranch={handleBranch}
							onOpenKbRef={handleOpenKbRef}
							onStartPrompt={applyComposerDraft}
						/>
						{goal && <GoalBar goal={goal} onStop={() => void handleStopGoal()} onNew={() => setGoalDialogOpen(true)} />}
						<ApprovalBar approvals={approvals} busy={approvalBusy || pending} onDecide={handleDecideApproval} />
						{askQuestions.slice(0, 1).map((q) => (
							<AskUserCard key={q.id} question={q} busy={askBusy || pending} onSubmit={handleAnswerQuestion} />
						))}
						<Composer
							pending={pending}
							onSend={handleSend}
							onStop={handleStop}
							onInterject={handleInterject}
							skills={skills}
							prompts={prompts}
							sessionId={sessionId}
							models={models}
							model={model}
							onModelChange={handleModelChange}
							thinkingLevel={thinkingLevel}
							onThinkingLevelChange={handleChangeThinkingLevel}
							contextTick={contextTick}
							draft={starterDraft}
							draftNonce={draftNonce}
						/>
					</section>
				)}

				{showWorkbench && isDesktop && (
					<div
						role="separator"
						aria-orientation="vertical"
						aria-label="調整工作臺寬度"
						onPointerDown={handleRightResizeStart}
						className="w-1 shrink-0 cursor-col-resize bg-slate-800/40 transition-colors hover:bg-sky-500/50"
					/>
				)}
				{showWorkbench && (
					<div
						className={
							isDesktop
								? workbenchWide
									? "min-w-0 flex-1 border-l border-slate-800"
									: "shrink-0 border-l border-slate-800"
								: "min-w-0 flex-1"
						}
						style={isDesktop && !workbenchWide ? { width: rightWidth } : undefined}
					>
						<Workbench
							sessionId={sessionId}
							files={files}
							filesForSession={filesForSession}
							filesLoading={filesState === "loading" || bootstrapPending}
							filesError={filesError}
							wide={workbenchWide}
							onToggleWide={() => setWorkbenchWide((v) => !v)}
							onFileOpenChange={handleFileOpenChange}
							refreshTick={panelTick}
							onDeleteFile={handleDeleteFile}
							openRequest={fileRequest}
							onCollapse={toggleRight}
						/>
					</div>
				)}
			</div>

			{/* 目標彈窗（v0.31.0） */}
			<GoalDialog open={goalDialogOpen} onClose={() => setGoalDialogOpen(false)} onSubmit={handleCreateGoal} />

			{/* 設定彈窗（v0.20.0）：頂欄選單收納於此 */}
			{settingsMounted && (
				<Suspense fallback={null}>
					<LazySettingsDialog
						open={settingsOpen}
						onClose={closeSettings}
						theme={theme}
						onThemeChange={handleThemeChange}
						leftOpen={leftOpen}
						rightOpen={rightOpen}
						onToggleLeft={toggleLeft}
						onToggleRight={toggleRight}
						onExport={handleExport}
						onShare={handleShare}
						onBackup={handleBackup}
						onRestore={handleRestore}
						webSearch={webSearch}
						onToggleWebSearch={handleToggleWebSearch}
						kbPrefetch={kbPrefetch}
						onToggleKbPrefetch={handleToggleKbPrefetch}
						toolbox={toolbox}
						onSaveToolbox={handleSaveToolbox}
						kbRetrieval={kbRetrieval}
						onChangeKbRetrieval={handleChangeKbRetrieval}
						thinkingLevel={thinkingLevel}
						onChangeThinkingLevel={handleChangeThinkingLevel}
						displayName={displayName}
						onSaveDisplayName={handleSaveDisplayName}
						shareTtlSeconds={shareTtlSeconds}
						onChangeShareTtl={handleChangeShareTtl}
						compaction={compaction}
						onChangeCompaction={handleChangeCompaction}
						sessionId={sessionId}
						approval={approvalSettings}
						onChangeApproval={handleChangeApproval}
						onChangeApprovalTool={handleChangeApprovalTool}
						memories={memories}
						memoriesLoading={memoriesState === "loading" || bootstrapPending}
						memoriesError={memoriesError}
						onDeleteMemory={handleDeleteMemory}
						onClearMemories={handleClearMemories}
						onModelsChanged={() => setModelsTick((t) => t + 1)}
						authRequired={!!auth?.required}
						onLogout={handleLogout}
					/>
				</Suspense>
			)}

			{/* 知識庫 / MCP / 技能三個互斥彈窗（NERE-62）：外殼由 ModalShell 統一提供 */}
			<ModalShell open={activePanel === "kb"} title="知識庫" size="lg" onClose={closePanel} testId="kb-modal" triggerKey="kb">
				<Suspense fallback={<PanelLoading />}>
					<LazyKnowledgePanel onClose={closePanel} focus={kbFocus} onFocusConsumed={handleKbFocusConsumed} />
				</Suspense>
			</ModalShell>
			<ModalShell open={activePanel === "mcp"} title="連線 · MCP" size="md" onClose={closePanel} testId="mcp-modal" triggerKey="mcp">
				<Suspense fallback={<PanelLoading />}>
					<LazyMcpPanel
						servers={mcpServers}
						loading={mcpLoading}
						error={mcpError}
						onAdd={handleAddMcp}
						onDelete={handleDeleteMcp}
						onClose={closePanel}
					/>
				</Suspense>
			</ModalShell>
			<ModalShell open={activePanel === "skills"} title="技能" size="xl" onClose={closePanel} testId="skills-modal" triggerKey="skills">
				<Suspense fallback={<PanelLoading />}>
					<LazySkillPanel
						items={skills}
						loading={skillsLoading}
						error={skillsError}
						onAdd={handleAddSkill}
						onDelete={handleDeleteSkill}
						onImport={handleImportSkill}
						onTry={handleTrySkill}
						prompts={prompts}
						rules={rules}
						onAddPrompt={handleAddPrompt}
						onDeletePrompt={handleDeletePrompt}
						onAddRule={handleAddRule}
						onToggleRule={handleToggleRule}
						onDeleteRule={handleDeleteRule}
						customTools={customTools}
						onAddCustomTool={handleAddCustomTool}
						onDeleteCustomTool={handleDeleteCustomTool}
						onClose={closePanel}
					/>
				</Suspense>
			</ModalShell>

			{/* Mobile drawer: the session sidebar slides over the chat */}
			{!isDesktop && drawerOpen && (
				<div className="absolute inset-0 z-30 md:hidden">
					<button
						type="button"
						aria-label="關閉會話列表"
						onClick={() => setDrawerOpen(false)}
						className="absolute inset-0 bg-black/60"
					/>
					<div className="absolute inset-y-0 left-0 flex w-80 max-w-[85vw] border-r border-slate-800 bg-slate-900 shadow-xl">
						{rail}
						<div className="min-w-0 flex-1">{leftContent}</div>
					</div>
				</div>
			)}

			{/* Mobile bottom tab bar: chat / files / memories */}
			{!isDesktop && (
				<nav
					aria-label="底部導航"
					className="z-20 grid shrink-0 grid-cols-3 border-t border-slate-800 bg-slate-900/95 pb-[env(safe-area-inset-bottom)]"
				>
					{(
						[
							{ key: "chat", label: "聊天", icon: "chat" },
							{ key: "files", label: "檔案", icon: "file" },
						] as const
					).map(({ key, label, icon }) => (
						<button
							key={key}
							type="button"
							onClick={() => setMobileTab(key)}
							aria-current={mobileTab === key ? "page" : undefined}
							className={`flex flex-col items-center gap-0.5 py-2 text-[11px] transition-colors ${
								mobileTab === key ? "text-sky-300" : "text-slate-400 hover:text-slate-200"
							}`}
						>
							<span aria-hidden className="leading-none">
								<Icon name={icon} className="h-5 w-5" />
							</span>
							{label}
						</button>
					))}
					<button
						type="button"
						onClick={openSettings}
						className="flex flex-col items-center gap-0.5 py-2 text-[11px] text-slate-400 transition-colors hover:text-slate-200"
					>
						<span aria-hidden className="leading-none">
							<Icon name="settings" className="h-5 w-5" />
						</span>
						設定
					</button>
				</nav>
			)}
		</div>
	);
}
