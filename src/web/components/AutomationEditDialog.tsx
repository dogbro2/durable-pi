/**
 * 定時任務編輯彈窗（NERE-65）：名稱 / 提示詞 / 執行時間 / 會話。
 *
 * 開啟即回填當前值；前端先校驗，儲存走 PATCH（NERE-64），失敗保留輸入並顯示文案。
 * 外殼複用 ModalShell（NERE-62），本元件不直接發請求，儲存由頁面層注入。
 */

import { useId, useState } from "react";
import {
	AUTOMATION_NAME_MAX,
	AUTOMATION_PROMPT_MAX,
	draftFromJob,
	submitAutomationDraft,
	type AutomationDraft,
	type AutomationDraftField,
} from "../lib/automation-edit";
import type { AutomationInfo, AutomationPatch } from "../types";
import { ModalShell } from "./ModalShell";

export interface AutomationEditDialogProps {
	/** 要編輯的任務；彈窗只在有值時掛載，天然每次開啟都重新回填。 */
	job: AutomationInfo;
	/** 當前會話：任務沒有記錄會話時的兜底回填。 */
	defaultSessionId?: string;
	onClose: () => void;
	/** 返回 `ok=false` 時保留輸入並展示 `error`。 */
	onSave: (patch: AutomationPatch) => Promise<{ ok: boolean; error?: string }>;
}

const inputClass =
	"w-full rounded-md border border-slate-700 bg-slate-800/70 px-2.5 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none";

/** 開關（NERE-86）：與設定頁同形的輕量 switch，本彈窗自持一份，避免跨面板耦合。 */
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

export function AutomationEditDialog({ job, defaultSessionId = "", onClose, onSave }: AutomationEditDialogProps) {
	const [draft, setDraft] = useState<AutomationDraft>(() => draftFromJob(job, defaultSessionId));
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<{ error: string; field?: AutomationDraftField } | null>(null);
	const fieldId = useId();

	const update = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) => {
		setDraft((prev) => ({ ...prev, [key]: value }));
		setFailure(null);
	};

	const submit = () => {
		if (busy) return;
		setBusy(true);
		setFailure(null);
		void submitAutomationDraft(job, draft, onSave).then((result) => {
			if (result.ok) {
				onClose();
				return;
			}
			setFailure({ error: result.error, field: result.field });
			setBusy(false);
		});
	};

	const invalid = (field: AutomationDraftField) => (failure?.field === field ? true : undefined);
	const nameId = `${fieldId}-name`;
	const promptId = `${fieldId}-prompt`;
	const timeId = `${fieldId}-time`;
	const minutesId = `${fieldId}-minutes`;
	const sessionId = `${fieldId}-session`;

	return (
		<ModalShell
			open
			title="編輯定時任務"
			size="md"
			onClose={busy ? () => undefined : onClose}
			closeOnScrim={!busy}
			testId="automation-edit-modal"
			footer={
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="text-[11px] text-slate-500">儲存後按新排程重算下次執行時間。</span>
					<span className="flex items-center gap-2">
						<button
							type="button"
							onClick={onClose}
							disabled={busy}
							className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-200 transition-colors hover:bg-slate-800 disabled:opacity-40"
						>
							取消
						</button>
						<button
							type="button"
							onClick={submit}
							disabled={busy}
							className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
						>
							{busy ? "儲存中…" : "儲存"}
						</button>
					</span>
				</div>
			}
		>
			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-5">
				<div className="space-y-1.5">
					<div className="flex items-baseline justify-between">
						<label htmlFor={nameId} className="text-xs font-medium text-slate-300">
							名稱
						</label>
						<span className={`text-[11px] tabular-nums ${draft.name.length > AUTOMATION_NAME_MAX ? "text-rose-300" : "text-slate-500"}`}>
							{draft.name.length}/{AUTOMATION_NAME_MAX}
						</span>
					</div>
					<input
						id={nameId}
						value={draft.name}
						onChange={(e) => update("name", e.target.value)}
						maxLength={AUTOMATION_NAME_MAX}
						placeholder="如 每日科技日報"
						aria-label="任務名稱"
						aria-invalid={invalid("name")}
						className={inputClass}
					/>
				</div>

				<div className="space-y-1.5">
					<div className="flex items-baseline justify-between">
						<label htmlFor={promptId} className="text-xs font-medium text-slate-300">
							提示詞
						</label>
						<span className={`text-[11px] tabular-nums ${draft.prompt.length > AUTOMATION_PROMPT_MAX ? "text-rose-300" : "text-slate-500"}`}>
							{draft.prompt.length}/{AUTOMATION_PROMPT_MAX}
						</span>
					</div>
					<textarea
						id={promptId}
						value={draft.prompt}
						onChange={(e) => update("prompt", e.target.value)}
						maxLength={AUTOMATION_PROMPT_MAX}
						rows={6}
						placeholder="到點後發給助手的提示詞"
						aria-label="任務提示詞"
						aria-invalid={invalid("prompt")}
						className={`${inputClass} resize-y`}
					/>
				</div>

				<div className="space-y-1.5">
					<span className="block text-xs font-medium text-slate-300">執行時間</span>
					<div className="flex flex-wrap items-center gap-2">
						<select
							value={draft.kind}
							onChange={(e) => update("kind", e.target.value as AutomationDraft["kind"])}
							aria-label="排程型別"
							className="rounded-md border border-slate-700 bg-slate-800/70 px-2 py-2 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
						>
							<option value="daily">每天</option>
							<option value="interval">每隔</option>
						</select>
						{draft.kind === "daily" ? (
							<input
								id={timeId}
								type="time"
								value={draft.time}
								onChange={(e) => update("time", e.target.value)}
								aria-label="執行時間"
								aria-invalid={invalid("time")}
								className="rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
							/>
						) : (
							<>
								<input
									id={minutesId}
									type="number"
									min={1}
									step={1}
									value={draft.minutes}
									onChange={(e) => update("minutes", e.target.value)}
									aria-label="間隔分鐘"
									aria-invalid={invalid("minutes")}
									className="w-24 rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 focus:border-sky-500 focus:outline-none"
								/>
								<span className="text-xs text-slate-500">分鐘</span>
							</>
						)}
					</div>
					<p className="text-[11px] text-slate-500">daily 按北京時間（UTC+8）執行；interval 從儲存時刻起算。</p>
				</div>

				<div className="space-y-1.5">
					<div className="flex items-center justify-between gap-3">
						<span className="text-xs font-medium text-slate-300">每次執行用新會話</span>
						<Switch
							checked={draft.freshSession}
							onChange={(next) => update("freshSession", next)}
							label="每次執行用新會話"
						/>
					</div>
					<p className="text-[11px] text-slate-500">
						開啟後每輪新建空會話執行，歷史不再跨輪累積（推薦）；關閉則固定使用下面的會話 ID。
					</p>
				</div>

				<div className="space-y-1.5">
					<label htmlFor={sessionId} className="text-xs font-medium text-slate-300">
						會話 ID <span className="font-normal text-slate-500">（可選）</span>
					</label>
					<input
						id={sessionId}
						value={draft.sessionId}
						onChange={(e) => update("sessionId", e.target.value)}
						placeholder="可留空；留空時到點寫入預設會話"
						aria-label="會話 ID"
						className={`${inputClass} font-mono`}
					/>
				</div>

				{failure && (
					<p role="alert" className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
						{failure.error}
					</p>
				)}
			</div>
		</ModalShell>
	);
}
