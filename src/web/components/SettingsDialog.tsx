import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSettingsData, type CheckState, type DeploymentCheckRow, type SettingsTab } from "../hooks/useSettingsData";
import { formatTime } from "../lib/format";
import { PROVIDER_BASE_URL_PLACEHOLDER } from "../lib/provider";
import { THEMES, type ThemeId } from "../lib/theme";
import { Icon, type IconName } from "./Icon";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useBackToClose } from "../lib/useBackToClose";
import type { MemoryInfo } from "../types";

interface SettingsDialogProps {
	open: boolean;
	onClose: () => void;
	/** 當前主題（v0.24.0：深色/淺色/米黃/午夜藍）。 */
	theme: ThemeId;
	onThemeChange: (next: ThemeId) => void;
	leftOpen: boolean;
	rightOpen: boolean;
	onToggleLeft: () => void;
	onToggleRight: () => void;
	onExport: () => void;
	onShare: () => void;
	onBackup: () => void;
	onRestore: (file: File) => void;
	/** 網頁搜尋開關（null = 尚未讀到後端設定）。 */
	webSearch: boolean | null;
	onToggleWebSearch: (next: boolean) => void;
	/** 知識庫預檢索開關（v0.46.0，null = 尚未讀取）。 */
	kbPrefetch: boolean | null;
	onToggleKbPrefetch: (next: boolean) => void;
	/** 工具箱端點（v1.1.0）：搜尋 / 抓取 / 自動記憶，全部由 UI 配置。 */
	toolbox: { baseUrl: string; hasKey: boolean; keyHint: string; model: string };
	onSaveToolbox: (patch: { baseUrl?: string; apiKey?: string; model?: string; clearKey?: boolean }) => void;
	/** 知識庫檢索模式（v0.53.0）：fts / vector / hybrid。 */
	kbRetrieval: string;
	onChangeKbRetrieval: (next: string) => void;
	/** 思考檔位（v0.22.0）：off / low / high。 */
	thinkingLevel: string;
	onChangeThinkingLevel: (next: string) => void;
	/** 分享頁署名與預設有效期（v0.55.0）。 */
	displayName: string;
	onSaveDisplayName: (next: string) => void;
	shareTtlSeconds: number;
	onChangeShareTtl: (next: number) => void;
	/** 上下文壓縮策略（v0.30.0）。 */
	compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number } | null;
	onChangeCompaction: (patch: Partial<{ enabled: boolean; reserveTokens: number; keepRecentTokens: number; backgroundTokens: number }>) => void;
	/** 手動壓縮的目標會話（v0.31.0）。 */
	sessionId: string;
	/** 工具審批策略（v0.33.0）。 */
	approval: { read: string; write: string; exec: string } | null;
	onChangeApproval: (patch: Partial<{ read: string; write: string; exec: string }>) => void;
	onChangeApprovalTool: (name: string, policy: string) => void;
	/** 記憶庫（v0.21.0 從工作臺移入設定）。 */
	memories: MemoryInfo[];
	memoriesLoading: boolean;
	memoriesError: string | null;
	onDeleteMemory: (id: number) => Promise<boolean>;
	/** 一鍵清空記憶庫（v0.26.0）。 */
	onClearMemories: () => Promise<number | null>;
	/** 供應商變更後重新整理模型列表（v0.27.0）。 */
	onModelsChanged?: () => void;
	/** 設定了訪問密碼才顯示登出。 */
	authRequired: boolean;
	onLogout: () => void;
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			onClick={() => onChange(!checked)}
			className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${checked ? "bg-sky-600" : "bg-slate-600"}`}
		>
			<span
				aria-hidden
				className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm ring-1 ring-black/10 transition-all ${checked ? "left-[18px]" : "left-0.5"}`}
			/>
		</button>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="border-b border-slate-700/70 py-4 first:pt-0 last:border-b-0 last:pb-0">
			<h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
			{children}
		</section>
	);
}

/** 部署自檢（NERE-81：取數在 useSettingsData 裡，這裡只渲染）。 */
function DeploymentCheck({ rows, checking, onRecheck }: { rows: DeploymentCheckRow[]; checking: boolean; onRecheck: () => void }) {
	const icon = (state: CheckState) => (state === "ok" ? "✅" : state === "loading" ? "…" : "⚠️");
	return (
		<Section title="部署自檢">
			<p className="mb-3 text-xs leading-relaxed text-slate-500">檢查當前瀏覽器可訪問的既有介面；不會發送聊天請求，也不會暴露金鑰。</p>
			<ul className="space-y-2" aria-live="polite">
				{rows.map((row) => (
					<li key={row.label} className="rounded-lg border border-slate-700/80 bg-slate-800/40 px-3 py-2 text-xs">
						<div className="flex items-start gap-2">
							<span aria-hidden>{icon(row.state)}</span>
							<div className="min-w-0">
								<p className="font-medium text-slate-200">{row.label}</p>
								<p className="mt-0.5 leading-relaxed text-slate-400">{row.detail}</p>
								{row.fix && <code className="mt-1 block break-all rounded bg-slate-950/60 px-1.5 py-1 text-[11px] text-sky-300">{row.fix}</code>}
							</div>
						</div>
					</li>
				))}
			</ul>
			<button type="button" onClick={onRecheck} disabled={checking} className="mt-3 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 transition-colors hover:bg-sky-500/20 disabled:opacity-50">
				{checking ? "檢查中…" : "重新檢查"}
			</button>
		</Section>
	);
}

const actionButton =
	"inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-200 shadow-sm transition-colors hover:bg-slate-700/60 hover:text-white";

const TABS: { key: SettingsTab; label: string; icon: IconName }[] = [
	{ key: "general", label: "通用", icon: "settings" },
	{ key: "chat", label: "對話", icon: "chat" },
	{ key: "model", label: "模型", icon: "model" },
	{ key: "memory", label: "記憶", icon: "memory" },
	{ key: "data", label: "資料", icon: "data" },
];

/** 主題圖示（v0.39.0：統一線性圖示）。 */
const THEME_ICONS: Record<ThemeId, IconName> = {
	dark: "themeDark",
	light: "themeLight",
	sepia: "themeSepia",
	midnight: "themeMidnight",
};

/** 設定彈窗（v0.26.0：按子功能分 tab）。 */
export function SettingsDialog({
	open,
	onClose,
	theme,
	onThemeChange,
	leftOpen,
	rightOpen,
	onToggleLeft,
	onToggleRight,
	onExport,
	onShare,
	onBackup,
	onRestore,
	webSearch,
	onToggleWebSearch,
	kbPrefetch,
	onToggleKbPrefetch,
	toolbox,
	onSaveToolbox,
	kbRetrieval,
	onChangeKbRetrieval,
	thinkingLevel,
	onChangeThinkingLevel,
	displayName,
	onSaveDisplayName,
	shareTtlSeconds,
	onChangeShareTtl,
	compaction,
	onChangeCompaction,
	sessionId,
	approval,
	onChangeApproval,
	onChangeApprovalTool,
	memories,
	memoriesLoading,
	memoriesError,
	onDeleteMemory,
	onClearMemories,
	onModelsChanged,
	authRequired,
	onLogout,
}: SettingsDialogProps) {
	const restoreRef = useRef<HTMLInputElement>(null);
	const [tab, setTab] = useState<SettingsTab>("general");
	/** 分享署名草稿（v0.55.0）：失焦時儲存，避免每敲一個字發一次請求。 */
	const [nameDraft, setNameDraft] = useState(displayName);
	const [clearing, setClearing] = useState(false);
	/** 工具清單（v0.33.0）：開啟「對話」tab 時讀取，用於逐工具覆蓋。 */
	const {
		deployment,
		kernel: kernelData,
		compaction: compact,
		kbIndex,
		tools,
		providers: providerData,
	} = useSettingsData({
		open,
		tab,
		sessionId,
		kbRetrieval,
		onModelsChanged,
	});
	const { rows: checkRows, checking, recheck } = deployment;
	const { kernel, kernelBusy, loadKernel } = kernelData;
	const { compactState, compactMessage, compactNow } = compact;
	const { kbStatus, kbReindexBusy, kbReindexMessage, reindexKb } = kbIndex;
	const { toolList, setToolList } = tools;
	const {
		providers,
		activeProvider,
		providersLoading,
		providerError,
		providerBusy,
		form,
		setForm,
		activateProvider,
		saveProvider,
		removeProvider,
	} = providerData;
	/** 工具箱草稿（v1.1.0）：key 留空表示保持原值。 */
	const [toolboxDraft, setToolboxDraft] = useState({ baseUrl: "", apiKey: "", model: "" });
	useEffect(() => {
		setToolboxDraft({ baseUrl: toolbox.baseUrl, apiKey: "", model: toolbox.model });
	}, [toolbox.baseUrl, toolbox.model, toolbox.hasKey]);

	// 手機返回手勢關閉設定。
	const isNarrow = useMediaQuery("(max-width: 720px)");
	useBackToClose(open, onClose, isNarrow);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			// 上層（如 ModalShell）已處理 Esc 時不再重複關閉（NERE-62 契約 §4.1）
			if (e.defaultPrevented) return;
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	// 每次打開回到第一個 tab
	useEffect(() => {
		if (open) setTab("general");
	}, [open]);

	useEffect(() => {
		if (open) setNameDraft(displayName);
	}, [open, displayName]);

	const handleClear = () => {
		if (clearing || memories.length === 0) return;
		if (!window.confirm(`確定清空全部 ${memories.length} 條記憶？此操作不可撤銷。`)) return;
		setClearing(true);
		void onClearMemories().finally(() => setClearing(false));
	};

	if (!open) return null;

	return (
		<div className="absolute inset-0 z-40">
			<button type="button" aria-label="關閉設定" onClick={onClose} className="dialog-scrim absolute inset-0" />
			<div
				role="dialog"
				aria-modal="true"
				aria-label="設定"
				className="absolute left-1/2 top-1/2 flex max-h-[86vh] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl ring-1 ring-black/5"
			>
				{/* 標題 */}
				<div className="flex shrink-0 items-center justify-between px-5 pb-2 pt-4">
					<h1 className="text-base font-semibold text-slate-100">設定</h1>
					<button
						type="button"
						onClick={onClose}
						aria-label="關閉"
						className="inline-flex h-8 w-8 items-center justify-center rounded-lg max-[720px]:h-11 max-[720px]:w-11 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
					>
						<Icon name="close" className="h-4 w-4" />
					</button>
				</div>

				{/* 分類 tab */}
				<div role="tablist" aria-label="設定分類" className="flex shrink-0 gap-1 px-4">
					{TABS.map((item) => (
						<button
							key={item.key}
							type="button"
							role="tab"
							aria-selected={tab === item.key}
							onClick={() => setTab(item.key)}
							className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-t-lg border-b-2 px-2 py-2 text-[13px] font-medium transition-colors ${
								tab === item.key
									? "border-sky-500 text-sky-300"
									: "border-transparent text-slate-400 hover:border-slate-700 hover:text-slate-200"
							}`}
						>
						<Icon name={item.icon} className="h-3.5 w-3.5 shrink-0 max-[480px]:hidden" />
							{item.label}
						</button>
					))}
				</div>

				{/* 內容區 */}
				<div className="min-h-0 flex-1 overflow-y-auto border-t border-slate-800 px-5 py-4">
					{tab === "general" && (
						<>
							<Section title="外觀">
								<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
									{THEMES.map((option) => (
										<button
											key={option.id}
											type="button"
											onClick={() => onThemeChange(option.id)}
											aria-pressed={theme === option.id}
											className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 text-xs transition-colors ${
												theme === option.id
													? "border-sky-500/70 bg-sky-500/10 text-slate-100"
													: "border-slate-700 text-slate-300 hover:border-slate-600 hover:text-white"
											}`}
										>
											<span
												aria-hidden
												className="h-6 w-full rounded border border-slate-600/60"
												style={{ backgroundColor: option.swatch }}
											/>
											<span className="flex items-center gap-1">
												<Icon name={THEME_ICONS[option.id]} className="h-3.5 w-3.5" />
												{option.label}
											</span>
										</button>
									))}
								</div>
							</Section>

							<Section title="佈局">
								<div className="flex flex-col gap-3">
									<div className="flex items-center justify-between">
										<span className="text-sm text-slate-200">會話欄（左側）</span>
										<Switch checked={leftOpen} onChange={onToggleLeft} label="顯示/收起會話欄" />
									</div>
									<div className="flex items-center justify-between">
										<span className="text-sm text-slate-200">工作臺（右側）</span>
										<Switch checked={rightOpen} onChange={onToggleRight} label="顯示/收起工作臺" />
									</div>
								</div>
							</Section>

							<DeploymentCheck rows={checkRows} checking={checking} onRecheck={() => void recheck()} />

							{authRequired && (
								<Section title="賬號">
									<button
										type="button"
										onClick={onLogout}
										className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-300 transition-colors hover:bg-rose-500/20"
									>
										退出登入
									</button>
								</Section>
							)}
						</>
					)}

					{tab === "general" && (
						<Section title="pi 核心">
							<p className="mb-2 text-xs leading-relaxed text-slate-500">
								核心是 pi-durable / pi-ai / pi-mcp / pi-codemode 四個包。升級後構建、金標與打包校驗全部通過才會部署。
							</p>
							<ul className="space-y-0.5 text-xs">
								{Object.entries(kernel?.current ?? {}).map(([name, version]) => {
									const latest = kernel?.latest?.[name];
									const outdated = kernel?.outdated?.includes(name);
									return (
										<li key={name} className="flex items-center justify-between gap-2">
											<span className="truncate text-slate-300">{name.replace("@earendil-works/", "")}</span>
											<span className={outdated ? "text-amber-300" : "text-slate-500"}>
												{version}
												{outdated && latest ? ` → ${latest}` : ""}
											</span>
										</li>
									);
								})}
								{!kernel && <li className="text-slate-500">正在讀取版本…</li>}
							</ul>
							<div className="mt-3 flex flex-wrap items-center gap-2">
								<button
									type="button"
									onClick={() => void loadKernel(true)}
									disabled={kernelBusy}
									className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 transition-colors hover:bg-sky-500/20 disabled:opacity-50"
								>
									{kernelBusy ? "檢查中…" : "檢查更新"}
								</button>
								{kernel?.checkedAt && (
									<span className="text-[11px] text-slate-500">
										上次檢查：{new Date(kernel.checkedAt).toLocaleString("zh-TW", { hour12: false })}
									</span>
								)}
							</div>
							{kernel?.updateAvailable ? (
								<div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200">
									<p>發現新版本：{(kernel.outdated ?? []).join("、")}</p>
									<p className="mt-1 text-amber-200/80">手動：{kernel.upgrade?.manual ?? "npm run upgrade:pi"}</p>
									<p className="mt-0.5 text-amber-200/80">自動：{kernel.upgrade?.auto ?? "每週自動開 PR"}</p>
								</div>
							) : (
								kernel && !kernel.updateAvailable && <p className="mt-2 text-xs text-emerald-300">已是最新版本。</p>
							)}
						</Section>
					)}

					{tab === "chat" && (
						<>
							<Section title="思考過程">
								<p className="mb-2 text-xs leading-relaxed text-slate-500">
									開啟後模型先思考再回答，聊天裡會出現可展開的「思考過程」塊。檔位越高越慢、越費 token。
								</p>
								<div className="inline-flex rounded-lg border border-slate-700 p-0.5">
									{[
										{ value: "off", label: "關閉" },
										{ value: "low", label: "低" },
										{ value: "high", label: "高" },
									].map((option) => (
										<button
											key={option.value}
											type="button"
											onClick={() => onChangeThinkingLevel(option.value)}
											aria-pressed={thinkingLevel === option.value}
											className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
												thinkingLevel === option.value ? "bg-violet-600 text-white" : "text-slate-300 hover:text-white"
											}`}
										>
											{option.label}
										</button>
									))}
								</div>
							</Section>

							<Section title="上下文壓縮">
								<div className="flex items-start justify-between gap-4">
									<div className="min-w-0">
										<p className="text-sm text-slate-200">自動壓縮長對話</p>
										<p className="mt-1 text-xs leading-relaxed text-slate-500">
											接近上下文上限時，把較早的內容摘要成一條記錄，保留最近 {compaction?.keepRecentTokens ?? 20000} tokens 原文。
										</p>
									</div>
									<Switch
										checked={compaction?.enabled !== false}
										onChange={(next) => onChangeCompaction({ enabled: next })}
										label="啟用自動壓縮"
									/>
								</div>
								<div className="mt-3 grid grid-cols-2 gap-2">
									<label className="text-xs text-slate-400">
										保留原文 tokens
										<input
											type="number"
											min={0}
											step={1000}
											value={compaction?.keepRecentTokens ?? 20000}
											onChange={(e) => onChangeCompaction({ keepRecentTokens: Number(e.target.value) })}
											className="mt-1 w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100"
										/>
									</label>
									<label className="text-xs text-slate-400">
										預留回答 tokens
										<input
											type="number"
											min={1024}
											step={1024}
											value={compaction?.reserveTokens ?? 16384}
											onChange={(e) => onChangeCompaction({ reserveTokens: Number(e.target.value) })}
											className="mt-1 w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100"
										/>
									</label>
								</div>
								<div className="mt-3 flex flex-wrap items-center gap-2">
									<button
										type="button"
										onClick={() => void compactNow()}
										disabled={compactState === "running"}
										className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 transition-colors hover:bg-sky-500/20 disabled:opacity-50"
									>
										{compactState === "running" ? "壓縮中…" : "立即壓縮當前會話"}
									</button>
									{compactMessage && (
										<span className={`text-xs ${compactState === "error" ? "text-rose-300" : "text-emerald-300"}`}>
											{compactMessage}
										</span>
									)}
								</div>
							</Section>


							<Section title="工具審批">
								<p className="mb-2 text-xs leading-relaxed text-slate-500">
									按 read / write / exec 三檔控制工具：放行 = 直接執行；詢問 = 聊天裡出現待審批條，點允許後才執行；禁止 = 直接拒絕。
								</p>
								<div className="grid grid-cols-3 gap-2">
									{([
										["read", "讀取"],
										["write", "寫入"],
										["exec", "執行"],
									] as const).map(([level, label]) => (
										<label key={level} className="text-xs text-slate-400">
											{label}
											<select
												value={approval?.[level] ?? "allow"}
												onChange={(e) => onChangeApproval({ [level]: e.target.value })}
												className="mt-1 w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100"
											>
												<option value="allow">放行</option>
												<option value="ask">詢問</option>
												<option value="deny">禁止</option>
											</select>
										</label>
									))}
								</div>
								<details className="mt-3 rounded-md border border-slate-800 p-2">
									<summary className="cursor-pointer text-xs text-slate-400">
										逐工具覆蓋（{toolList.length} 個工具）
									</summary>
									<ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
										{toolList.map((tool) => (
											<li key={tool.name} className="flex items-center justify-between gap-2 text-xs">
												<span className="min-w-0 truncate text-slate-300" title={`${tool.name} · ${tool.category}`}>
													{tool.name}
													<span className="ml-1 text-[10px] text-slate-500">{tool.category}</span>
												</span>
												<select
													value={tool.override}
													onChange={(e) => {
														const next = e.target.value;
														onChangeApprovalTool(tool.name, next);
														setToolList((prev) => prev.map((t) => (t.name === tool.name ? { ...t, override: next } : t)));
													}}
													aria-label={`${tool.name} 的審批策略`}
													className="w-24 shrink-0 rounded-md border border-slate-700 bg-slate-800/70 px-1 py-1 text-[11px] text-slate-100"
												>
													<option value="follow">跟隨分級</option>
													<option value="allow">放行</option>
													<option value="ask">詢問</option>
													<option value="deny">禁止</option>
												</select>
											</li>
										))}
									</ul>
								</details>
							</Section>
							<Section title="知識庫預檢索">
								<div className="flex items-start justify-between gap-4">
									<div className="min-w-0">
										<p className="text-sm text-slate-200">每輪自動檢索知識庫</p>
										<p className="mt-1 text-xs leading-relaxed text-slate-500">
											傳送訊息時先用它檢索知識庫，命中就把前 3 段（最多約 1.8k 字）放進本輪系統提示；沒命中不增加內容。關閉後模型仍可主動呼叫 kb_search。
										</p>
									</div>
									<Switch checked={kbPrefetch !== false} onChange={onToggleKbPrefetch} label="啟用知識庫預檢索" />
								</div>
								{kbPrefetch === null && <p className="mt-2 text-xs text-slate-500">正在讀取設定…</p>}
							</Section>
							<Section title="知識庫檢索">
								<p className="mb-2 text-xs leading-relaxed text-slate-500">
									當前部署只用關鍵詞檢索（SQLite FTS5，零依賴、零外部呼叫）。向量 / 混合模式需要自行加回 Workers AI 與
									Vectorize 繫結，未繫結時按鈕不可用。
								</p>
								<div className="inline-flex rounded-lg border border-slate-700 p-0.5">
									{[
										{ value: "fts", label: "關鍵詞" },
										{ value: "vector", label: "向量" },
										{ value: "hybrid", label: "混合" },
									].map((option) => (
										<button
											key={option.value}
											type="button"
											onClick={() => onChangeKbRetrieval(option.value)}
											disabled={option.value !== "fts" && !kbStatus?.available}
											aria-pressed={kbRetrieval === option.value}
											className={`rounded-md px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
												kbRetrieval === option.value ? "bg-sky-600 text-white" : "text-slate-300 hover:text-white"
											}`}
										>
											{option.label}
										</button>
									))}
								</div>
								<div className="mt-3 flex flex-wrap items-center gap-2">
									<span className={`text-xs ${kbStatus?.available ? "text-slate-400" : "text-amber-300/90"}`}>
										{kbStatus?.available
											? `已索引 ${kbStatus.indexed ?? 0} / ${kbStatus.total ?? 0} 段 · ${kbStatus.index ?? "pi-kb"}`
											: "未繫結 Workers AI / Vectorize，向量檢索不可用。"}
									</span>
									{kbStatus?.available && (
										<button
											type="button"
											onClick={reindexKb}
											disabled={kbReindexBusy}
											className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-xs font-medium text-sky-300 transition-colors hover:bg-sky-500/20 disabled:opacity-50"
										>
											{kbReindexBusy ? "索引中…" : "重建向量索引"}
										</button>
									)}
								</div>
								{kbReindexMessage && <p className="mt-2 text-xs text-emerald-300">{kbReindexMessage}</p>}
							</Section>
							<Section title="網頁搜尋">
								<div className="flex items-start justify-between gap-4">
									<div className="min-w-0">
										<p className="text-sm text-slate-200">啟用聯網搜尋</p>
										<p className="mt-1 text-xs leading-relaxed text-slate-500">
											開啟後模型可用 web_search 搜尋、web_fetch_page 抓取正文。請求會發往「模型」頁裡填寫的工具服務端點；未填寫則不可用。
										</p>
									</div>
									<Switch checked={webSearch === true} onChange={onToggleWebSearch} label="啟用網頁搜尋" />
								</div>
								{webSearch === null && <p className="mt-2 text-xs text-slate-500">正在讀取設定…</p>}
							</Section>
							<Section title="分享連結">
								<label className="block text-sm text-slate-200" htmlFor="share-display-name">
									分享頁署名
								</label>
								<input
									id="share-display-name"
									value={nameDraft}
									onChange={(event) => setNameDraft(event.target.value)}
									onBlur={() => {
										if (nameDraft.trim() !== displayName) onSaveDisplayName(nameDraft);
									}}
									maxLength={40}
									placeholder="未設定時顯示 Durable Pi"
									className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-sky-500/60"
								/>
								<p className="mt-1 text-xs leading-relaxed text-slate-500">顯示在分享頁頁尾，和生成時間一起出現。</p>
								<p className="mt-3 text-sm text-slate-200">模型分享時的預設有效期</p>
								<div className="mt-1.5 flex flex-wrap gap-1.5">
									{[
										{ label: "1 小時", seconds: 3600 },
										{ label: "1 天", seconds: 86400 },
										{ label: "7 天", seconds: 604800 },
										{ label: "30 天", seconds: 2592000 },
										{ label: "永久", seconds: 0 },
									].map((option) => (
										<button
											key={option.seconds}
											type="button"
											onClick={() => onChangeShareTtl(option.seconds)}
											aria-pressed={shareTtlSeconds === option.seconds}
											className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
												shareTtlSeconds === option.seconds
													? "border-sky-500 bg-sky-500/20 text-sky-100"
													: "border-slate-700 text-slate-300 hover:bg-slate-800"
											}`}
										>
											{option.label}
										</button>
									))}
								</div>
								<p className="mt-1.5 text-xs leading-relaxed text-slate-500">
									share_file / share_conversation 不傳 ttlSeconds 時使用；手動分享彈窗仍可選。
								</p>
							</Section>
						</>
					)}

					{tab === "model" && (
						<>
							<Section title="LLM 供應商">
								<p className="mb-2 text-xs leading-relaxed text-slate-500">
									任意 OpenAI 相容端點都可接入。切換後對<strong>新對話</strong>生效；已開會話需要重新選模型。
								</p>
								{providerError && <p className="mb-2 text-xs text-rose-300">{providerError}</p>}
								<ul className="space-y-2">
									{providers.length === 0 && !providersLoading && (
										<li className="rounded-lg border border-dashed border-slate-600 px-3 py-2 text-xs text-slate-400">
											還沒有供應商。新增一個 OpenAI 相容端點後才能開始對話（Base URL、API Key、模型 ID 都必填）。
										</li>
									)}

									{providers.map((item) => (
										<li
											key={item.id}
											className={`rounded-lg border px-3 py-2 ${
												item.active ? "border-sky-500/60 bg-sky-500/10" : "border-slate-700 bg-slate-800/40"
											}`}
										>
											<div className="flex items-center gap-2">
												<Icon name="puzzle" className="h-4 w-4 shrink-0 text-sky-400" />
												<span className="min-w-0 flex-1">
													<span className="block truncate text-[13px] font-medium text-slate-100">
														{item.name}
														{item.active && <span className="ml-1.5 text-[11px] text-sky-300">使用中</span>}
													</span>
													<span className="block truncate text-[11px] text-slate-500">
														{item.baseUrl.replace(/^https?:\/\//, "")}
														{item.keyHint ? ` · ${item.keyHint}` : ""} · {item.models.join(" / ")}
													</span>
												</span>
												{!item.active && (
													<button
														type="button"
														onClick={() => void activateProvider(item.id)}
														disabled={providerBusy}
														className="shrink-0 rounded-md border border-slate-600 px-2 py-1 text-[11px] text-slate-200 hover:border-sky-500/60 hover:text-sky-300 disabled:opacity-40"
													>
														啟用
													</button>
												)}
												<button
													type="button"
													onClick={() =>
														setForm({
															id: item.id,
															name: item.name,
															baseUrl: item.baseUrl,
															apiKey: "",
															models: item.models.join(", "),
														})
													}
													className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-slate-400 hover:bg-slate-700 hover:text-slate-100"
												>
													編輯
												</button>
												<button
													type="button"
													onClick={() => void removeProvider(item.id, item.name)}
													disabled={providerBusy}
													className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-slate-400 hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-40"
												>
													刪除
												</button>
											</div>
										</li>
									))}
								</ul>
								{providersLoading && <p className="mt-2 text-xs text-slate-500">正在載入…</p>}

								{form ? (
									<div className="mt-3 space-y-1.5 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
										<p className="text-xs font-medium text-slate-300">{form.id ? "編輯供應商" : "新增供應商"}</p>
										<input
											value={form.name}
											onChange={(e) => setForm({ ...form, name: e.target.value })}
											placeholder="名稱，如 月之暗面"
											className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
										/>
										<input
											value={form.baseUrl}
											onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
											placeholder={PROVIDER_BASE_URL_PLACEHOLDER}
											className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
										/>
										<input
											value={form.apiKey}
											onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
											placeholder={form.id ? "API Key（留空則保持不變）" : "API Key"}
											type="password"
											className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
										/>
										<input
											value={form.models}
											onChange={(e) => setForm({ ...form, models: e.target.value })}
											placeholder="模型 ID，逗號分隔，如 kimi-k2, kimi-k1.5"
											className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
										/>
										<div className="flex gap-1.5 pt-0.5">
											<button
												type="button"
												onClick={() => void saveProvider()}
												disabled={providerBusy || !form.name.trim() || !form.baseUrl.trim() || !form.models.trim()}
												className="rounded-md bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40"
											>
												{providerBusy ? "儲存中…" : "儲存"}
											</button>
											<button
												type="button"
												onClick={() => setForm(null)}
												className="rounded-md border border-slate-600 px-2.5 py-1.5 text-xs text-slate-300"
											>
												取消
											</button>
										</div>
									</div>
								) : (
									<button
										type="button"
										onClick={() => setForm({ name: "", baseUrl: "", apiKey: "", models: "" })}
										className="mt-3 w-full rounded-lg border border-dashed border-slate-600 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-sky-500/60 hover:text-sky-300"
									>
										＋ 新增供應商
									</button>
								)}
							</Section>

							<Section title="工具服務（搜尋 / 網頁抓取 / 自動記憶）">
								<p className="mb-2 text-xs leading-relaxed text-slate-500">
									只有這三類功能會用到這裡填的端點：留空即完全關閉，不會向任何第三方發請求。端點需提供
									<code className="mx-1 rounded bg-slate-800 px-1">/v1/tools/search</code>、
									<code className="mx-1 rounded bg-slate-800 px-1">/v1/tools/fetch</code> 與 OpenAI 相容的
									<code className="mx-1 rounded bg-slate-800 px-1">/v1/chat/completions</code>。
								</p>
								<div className="space-y-1.5">
									<input
										value={toolboxDraft.baseUrl}
										onChange={(e) => setToolboxDraft({ ...toolboxDraft, baseUrl: e.target.value })}
										placeholder="Base URL，如 https://llm.example.com"
										className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
									/>
									<input
										value={toolboxDraft.apiKey}
										onChange={(e) => setToolboxDraft({ ...toolboxDraft, apiKey: e.target.value })}
										placeholder={toolbox.hasKey ? `API Key（已儲存 ${toolbox.keyHint}，留空不變）` : "API Key"}
										type="password"
										className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
									/>
									<input
										value={toolboxDraft.model}
										onChange={(e) => setToolboxDraft({ ...toolboxDraft, model: e.target.value })}
										placeholder="自動記憶用的模型 ID（留空 = 關閉自動記憶）"
										className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
									/>
									<div className="flex items-center gap-1.5 pt-0.5">
										<button
											type="button"
											onClick={() => {
												onSaveToolbox({
													baseUrl: toolboxDraft.baseUrl,
													apiKey: toolboxDraft.apiKey,
													model: toolboxDraft.model,
												});
												setToolboxDraft({ ...toolboxDraft, apiKey: "" });
											}}
											className="rounded-md bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-40"
										>
											儲存
										</button>
										{toolbox.hasKey && (
											<button
												type="button"
												onClick={() => onSaveToolbox({ clearKey: true })}
												className="rounded-md border border-slate-600 px-2.5 py-1.5 text-xs text-slate-300"
											>
												清除金鑰
											</button>
										)}
									</div>
								</div>
							</Section>
						</>
					)}

					{tab === "memory" && (
						<Section title={`記憶庫${memories.length ? `（${memories.length}）` : ""}`}>
							<div className="mb-2 flex items-center justify-between gap-2">
								<p className="text-xs leading-relaxed text-slate-500">
									對 π 說「記住…」可儲存；每輪對話結束也會自動抽取。
								</p>
								<button
									type="button"
									onClick={handleClear}
									disabled={clearing || memories.length === 0}
									className="shrink-0 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-300 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
								>
									{clearing ? "清空中…" : "清空全部"}
								</button>
							</div>
							<div className="max-h-[46vh] overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/40 p-1.5">
								{memoriesError && <p className="px-1.5 py-1.5 text-xs text-rose-300">{memoriesError}</p>}
								{memoriesLoading && memories.length === 0 && (
									<p className="px-1.5 py-1.5 text-xs text-slate-500">正在載入…</p>
								)}
								{!memoriesLoading && !memoriesError && memories.length === 0 && (
									<p className="px-1.5 py-2 text-xs leading-relaxed text-slate-500">記憶庫還是空的。</p>
								)}
								<ul className="space-y-1">
									{memories.map((memory) => (
										<li key={memory.id} className="rounded-lg bg-slate-800/50 px-2.5 py-2">
											<p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-200">
												{memory.content}
											</p>
											<div className="mt-1.5 flex items-center justify-between gap-2">
												<span className="min-w-0 truncate text-[11px] text-slate-500">
													{memory.source === "reflect" ? "自動抽取 · " : ""}
													{formatTime(memory.createdAt)}
												</span>
												{memory.id > 0 && (
													<button
														type="button"
														onClick={() => void onDeleteMemory(memory.id)}
														className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-slate-500 transition-colors hover:bg-red-950/60 hover:text-red-300"
													>
														刪除
													</button>
												)}
											</div>
										</li>
									))}
								</ul>
							</div>
						</Section>
					)}

					{tab === "data" && (
						<Section title="資料">
							<div className="grid grid-cols-2 gap-2">
								<button type="button" onClick={onShare} className={actionButton}>
									<Icon name="share" className="h-4 w-4" />
									分享當前會話
								</button>
								<button type="button" onClick={onExport} className={actionButton}>
									<Icon name="download" className="h-4 w-4" />
									匯出 Markdown
								</button>
								<button type="button" onClick={onBackup} className={actionButton}>
									<Icon name="backup" className="h-4 w-4" />
									備份資料
								</button>
								<button type="button" onClick={() => restoreRef.current?.click()} className={actionButton}>
									<Icon name="restore" className="h-4 w-4" />
									恢復備份
								</button>
							</div>
							<input
								ref={restoreRef}
								type="file"
								accept="application/json,.json"
								hidden
								onChange={(event) => {
									const file = event.target.files?.[0];
									if (file) onRestore(file);
									event.target.value = "";
								}}
							/>
							<p className="mt-2 text-xs leading-relaxed text-slate-500">
								備份含 MCP 金鑰，請妥善保管；恢復為合併式，不刪除現有資料。
							</p>
						</Section>
					)}
				</div>
			</div>
		</div>
	);
}
