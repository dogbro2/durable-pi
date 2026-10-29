import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { GoalInfo } from "../types";

/** 目標狀態的中文標籤。 */
const STATUS_LABEL: Record<GoalInfo["status"], string> = {
	active: "進行中",
	done: "已完成",
	blocked: "受阻",
	paused: "已暫停",
	exhausted: "已達上限",
};

/** 進度條顏色：進行中琥珀、完成綠、受阻/上限紅、暫停灰。 */
function barTone(status: GoalInfo["status"]): string {
	if (status === "done") return "bg-emerald-500";
	if (status === "blocked" || status === "exhausted") return "bg-rose-500";
	if (status === "paused") return "bg-slate-500";
	return "bg-amber-500";
}

interface GoalBarProps {
	goal: GoalInfo;
	/** 停止自動續轉（v0.31.0）。 */
	onStop: () => void;
	/** 重新設定目標。 */
	onNew: () => void;
}

/** 輸入框上方的目標條：目標、狀態、輪次、token 預算進度。 */
export function GoalBar({ goal, onStop, onNew }: GoalBarProps) {
	const pct = Math.min(100, Math.round((goal.tokensUsed / Math.max(1, goal.tokenBudget)) * 100));
	const active = goal.status === "active";
	return (
		<div className="shrink-0 border-t border-slate-800/70 bg-slate-900/50 px-4 py-2" aria-label="目標狀態">
			<div className="mx-auto flex max-w-3xl items-start gap-3">
				<Icon name="goal" className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
						<span className={active ? "font-medium text-amber-300" : "font-medium text-slate-300"}>
							目標 · {STATUS_LABEL[goal.status]}
						</span>
						<span className="text-slate-500">
							第 {goal.turns}/{goal.maxTurns} 輪 · {goal.tokensUsed.toLocaleString()} /{" "}
							{goal.tokenBudget.toLocaleString()} tokens
						</span>
					</div>
					<p className="mt-0.5 truncate text-sm text-slate-200" title={goal.objective}>
						{goal.objective}
					</p>
					{goal.summary && <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{goal.summary}</p>}
					<div
						className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-700/60 ring-1 ring-inset ring-slate-700/80"
						role="progressbar"
						aria-valuenow={pct}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-label="目標預算使用進度"
					>
						<div className={`h-full rounded-full transition-[width] ${barTone(goal.status)}`} style={{ width: `${pct}%` }} />
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{active && (
						<button
							type="button"
							onClick={onStop}
							className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 transition-colors hover:border-rose-500/50 hover:text-rose-300"
						>
							停止
						</button>
					)}
					<button
						type="button"
						onClick={onNew}
						className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-300 transition-colors hover:bg-amber-500/20"
					>
						新目標
					</button>
				</div>
			</div>
		</div>
	);
}

interface GoalDialogProps {
	open: boolean;
	onClose: () => void;
	/** 提交後由 App 建立目標併發出第一輪訊息。 */
	onSubmit: (objective: string, tokenBudget: number, maxTurns: number) => Promise<boolean>;
}

/** 建立目標的彈窗：目標描述 + token 預算 + 最大輪次。 */
export function GoalDialog({ open, onClose, onSubmit }: GoalDialogProps) {
	const [objective, setObjective] = useState("");
	const [budget, setBudget] = useState(200000);
	const [turns, setTurns] = useState(12);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			setObjective("");
			setError(null);
			setBusy(false);
		}
	}, [open]);

	if (!open) return null;

	const submit = async () => {
		const text = objective.trim();
		if (!text) {
			setError("先寫清楚要達成的目標。");
			return;
		}
		setBusy(true);
		setError(null);
		const ok = await onSubmit(text, budget, turns);
		setBusy(false);
		if (ok) onClose();
		else setError("建立目標失敗，請重試。");
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="設定目標"
				className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			>
				<h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-100">
					<Icon name="goal" className="h-4 w-4 text-amber-400" />
					設定目標
				</h2>
				<p className="mt-1 text-xs leading-relaxed text-slate-500">
					設定後模型會自己一輪輪推進，直到完成（需給出驗證證據）、預算用盡或報告受阻。每一輪都可以在聊天裡看到。
				</p>
				<label className="mt-4 block text-xs text-slate-400">
					目標
					<textarea
						value={objective}
						onChange={(e) => setObjective(e.target.value)}
						rows={3}
						placeholder="例如：調研 3 家雲廠商的 Durable Objects 計費並寫一份對比報告到 report.md"
						className="mt-1 w-full resize-none rounded-md border border-slate-700 bg-slate-800/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500/60"
					/>
				</label>
				<div className="mt-3 grid grid-cols-2 gap-2">
					<label className="text-xs text-slate-400">
						token 預算
						<input
							type="number"
							min={10000}
							step={10000}
							value={budget}
							onChange={(e) => setBudget(Number(e.target.value))}
							className="mt-1 w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100"
						/>
					</label>
					<label className="text-xs text-slate-400">
						最多自動續轉輪次
						<input
							type="number"
							min={1}
							max={50}
							value={turns}
							onChange={(e) => setTurns(Number(e.target.value))}
							className="mt-1 w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100"
						/>
					</label>
				</div>
				{error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						onClick={onClose}
						className="rounded-md px-3 py-1.5 text-sm text-slate-400 transition-colors hover:text-slate-200"
					>
						取消
					</button>
					<button
						type="button"
						onClick={() => void submit()}
						disabled={busy}
						className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-50"
					>
						{busy ? "啟動中…" : "開始"}
					</button>
				</div>
			</div>
		</div>
	);
}
