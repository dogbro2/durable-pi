import { useState } from "react";
import { automationOutputSessionId } from "../lib/automation-edit";
import { formatLastRunAt } from "../lib/format";
import { AutomationEditDialog } from "./AutomationEditDialog";
import { Icon } from "./Icon";
import { PanelHeader } from "./PanelHeader";
import type { AutomationInfo, AutomationPatch, AutomationRunStatus } from "../types";

/** 上次執行結果徽標（NERE-68 2b）：三種狀態文案 / 色板各不相同，未知狀態不渲染。 */
const RUN_STATUS_META: Record<AutomationRunStatus, { label: string; className: string }> = {
	ok: { label: "成功", className: "bg-emerald-500/10 text-emerald-300" },
	failed: { label: "失敗", className: "bg-rose-500/10 text-rose-300" },
	deferred: { label: "順延", className: "bg-amber-500/10 text-amber-300" },
};

function AutomationStatusBadge({ status }: { status: AutomationRunStatus }) {
	const meta = RUN_STATUS_META[status];
	return (
		<span
			className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] leading-none ${meta.className}`}
			title={`上次執行：${meta.label}`}
		>
			{meta.label}
		</span>
	);
}

/**
 * 定時任務的上次執行（NERE-68）：沒有 `last_run_at` 與 `last_status` 時整行不渲染；
 * 有狀態就渲染徽標（失敗 / 順延警示色），有歸屬會話時附「檢視產出」跳轉入口。
 */
function AutomationLastRun({
	job,
	onOpenSession,
}: {
	job: AutomationInfo;
	onOpenSession?: (sessionId: string) => void;
}) {
	const lastRunLabel = formatLastRunAt(job.lastRunAt);
	const status = job.lastStatus;
	if (!lastRunLabel && !status) return null;
	// NERE-86：跳最近一次執行實際用的會話；老資料回落到繫結會話。
	const sessionId = automationOutputSessionId(job);
	return (
		<>
			<p className="mt-0.5 text-[11px] text-slate-600">
				{lastRunLabel ? `上次 ${lastRunLabel}` : "上次執行"}
				{status && <AutomationStatusBadge status={status} />}
				{lastRunLabel && sessionId && onOpenSession && (
					<>
						{" · "}
						<button
							type="button"
							onClick={() => onOpenSession(sessionId)}
							aria-label={`檢視 ${job.name} 上次執行的產出`}
							className="text-sky-400 hover:text-sky-300 hover:underline"
						>
							檢視產出
						</button>
					</>
				)}
			</p>
			{/* 失敗原因（v1.0.4）：服務端把異常訊息寫進 last_error，失敗時展示給使用者自查。 */}
			{status === "failed" && job.lastError && (
				<p className="mt-0.5 break-all text-[10.5px] leading-relaxed text-rose-400/80" title={job.lastError}>
					{job.lastError.length > 160 ? `${job.lastError.slice(0, 160)}…` : job.lastError}
				</p>
			)}
		</>
	);
}

/** 左欄「定時」：定時任務管理（v0.21.0 從工作臺移入左側工具欄）。 */
export function AutomationPanel({
	items,
	loading,
	error,
	onAdd,
	onToggle,
	onDelete,
	onUpdate,
	onRun,
	defaultSessionId = "",
	onOpenSession,
	onCollapse,
}: {
	items: AutomationInfo[];
	loading: boolean;
	error: string | null;
	onAdd: (name: string, prompt: string, schedule: { kind: string; time?: string; minutes?: number }) => Promise<boolean>;
	onToggle: (id: string, enabled: boolean) => Promise<boolean>;
	onDelete: (id: string) => Promise<boolean>;
	/** 編輯儲存（NERE-65）：走 PATCH，失敗時返回可展示文案。 */
	onUpdate: (patch: AutomationPatch) => Promise<{ ok: boolean; error?: string }>;
	/** 立即執行（v1.0.4）：手動補跑一次；完整 chat 回合可能耗時幾分鐘，由呼叫方重新整理列表。 */
	onRun?: (id: string) => Promise<{ ok: boolean; error?: string }>;
	/** 任務沒有記錄會話時的兜底回填。 */
	defaultSessionId?: string;
	/** 「檢視產出」（NERE-68）：切到該任務上次執行的會話；預設時不渲染入口。 */
	onOpenSession?: (sessionId: string) => void;
	onCollapse?: () => void;
}) {
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [kind, setKind] = useState<"daily" | "interval">("daily");
	const [time, setTime] = useState("09:00");
	const [minutes, setMinutes] = useState("60");
	const [busy, setBusy] = useState(false);
	/** 正在編輯的任務；非空即彈出編輯彈窗（NERE-65）。 */
	const [editing, setEditing] = useState<AutomationInfo | null>(null);
	/** 正在手動執行的任務（v1.0.4）：完整 chat 回合可能幾分鐘，按鈕鎖定到返回。 */
	const [runningId, setRunningId] = useState<string | null>(null);

	const runJob = (job: AutomationInfo) => {
		if (!onRun || runningId) return;
		setRunningId(job.id);
		void (async () => {
			const result = await onRun(job.id);
			if (!result.ok && result.error) window.alert(`立即執行失敗：${result.error}`);
			setRunningId(null);
		})();
	};

	const submit = () => {
		if (!name.trim() || !prompt.trim() || busy) return;
		setBusy(true);
		void (async () => {
			const ok = await onAdd(
				name.trim(),
				prompt.trim(),
				kind === "daily" ? { kind, time } : { kind, minutes: Number(minutes) || 60 },
			);
			if (ok) {
				setName("");
				setPrompt("");
			}
			setBusy(false);
		})();
	};

	return (
		<div className="flex h-full w-full flex-col bg-slate-900/60">
			<PanelHeader title="定時任務" count={items.length} onCollapse={onCollapse} />
			<div className="shrink-0 space-y-1.5 border-b border-slate-800/70 p-3">
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="名稱，如 每日摘要"
					aria-label="定時任務名稱"
					className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
				/>
				<textarea
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					placeholder="到點後發給助手的提示詞"
					aria-label="定時任務提示詞"
					rows={2}
					className="w-full resize-y rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
				/>
				<div className="flex items-center gap-1.5">
					<select
						value={kind}
						onChange={(e) => setKind(e.target.value as "daily" | "interval")}
						aria-label="排程型別"
						className="rounded-md border border-slate-700 bg-slate-800/70 px-1.5 py-1 text-xs text-slate-100"
					>
						<option value="daily">每天</option>
						<option value="interval">每隔</option>
					</select>
					{kind === "daily" ? (
						<input
							type="time"
							value={time}
							onChange={(e) => setTime(e.target.value)}
							aria-label="執行時間"
							className="rounded-md border border-slate-700 bg-slate-800/70 px-1.5 py-1 text-xs text-slate-100"
						/>
					) : (
						<>
							<input
								type="number"
								min={1}
								value={minutes}
								onChange={(e) => setMinutes(e.target.value)}
								aria-label="間隔分鐘"
								className="w-16 rounded-md border border-slate-700 bg-slate-800/70 px-1.5 py-1 text-xs text-slate-100"
							/>
							<span className="text-xs text-slate-500">分鐘</span>
						</>
					)}
					<button
						type="button"
						onClick={submit}
						disabled={busy || !name.trim() || !prompt.trim()}
						className="ml-auto rounded-md bg-sky-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
					>
						{busy ? "建立中…" : "建立"}
					</button>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-2">
				{loading && items.length === 0 && <p className="px-1 py-2 text-xs text-slate-500">正在載入…</p>}
				{error && <p className="px-1 py-2 text-xs text-rose-300">{error}</p>}
				{!loading && items.length === 0 && !error && (
					<p className="px-1 py-2 text-xs text-slate-500">還沒有定時任務。到點後助手會在指定會話裡自動執行。</p>
				)}
				<ul className="space-y-1">
					{items.map((job) => (
						<li key={job.id} className="rounded-lg bg-slate-800/50 px-2.5 py-2">
							<div className="flex items-center gap-2">
								<span aria-hidden className="text-xs">
									{job.enabled ? "⏰" : "⏸"}
								</span>
								<span className="min-w-0 flex-1 truncate text-[13px] text-slate-100">{job.name}</span>
								<button
									type="button"
									title="編輯"
									aria-label={`編輯 ${job.name}`}
									onClick={() => setEditing(job)}
									className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-200"
								>
									<Icon name="edit" className="h-3.5 w-3.5" />
								</button>
								<button
									type="button"
									title={runningId === job.id ? "執行中，完成後重新整理" : "立即執行一次（不走鬧鐘）"}
									aria-label={`立即執行 ${job.name}`}
									disabled={runningId === job.id}
									onClick={() => runJob(job)}
									className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-200 disabled:opacity-50"
								>
									{runningId === job.id ? "執行中…" : "執行"}
								</button>
								<button
									type="button"
									title={job.enabled ? "暫停" : "啟用"}
									aria-label={`${job.enabled ? "暫停" : "啟用"} ${job.name}`}
									onClick={() => void onToggle(job.id, !job.enabled)}
									className="rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-200"
								>
									{job.enabled ? "暫停" : "啟用"}
								</button>
								<button
									type="button"
									title="刪除"
									aria-label={`刪除 ${job.name}`}
									onClick={() => {
										if (window.confirm(`刪除定時任務「${job.name}」？`)) void onDelete(job.id);
									}}
									className="rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300"
								>
									<Icon name="trash" className="h-3.5 w-3.5" />
								</button>
							</div>
							<p className="mt-1 line-clamp-2 text-[11px] text-slate-500">{job.prompt}</p>
							<p className="mt-0.5 text-[11px] text-slate-600">
								{job.scheduleLabel}
								{job.nextLabel ? ` · 下次 ${job.nextLabel}` : ""}
							</p>
							<AutomationLastRun job={job} onOpenSession={onOpenSession} />
						</li>
					))}
				</ul>
			</div>
			{editing && (
				<AutomationEditDialog
					key={editing.id}
					job={editing}
					defaultSessionId={defaultSessionId}
					onClose={() => setEditing(null)}
					onSave={onUpdate}
				/>
			)}
		</div>
	);
}
