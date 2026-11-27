import { useEffect, useState } from "react";
import { ModalShell } from "./ModalShell";

/** 專案的新建 / 編輯：名稱 + 專案指令（每輪注入給模型）。 */
export function ProjectDialog({
	open,
	initial,
	onClose,
	onSubmit,
}: {
	open: boolean;
	/** 有值即為編輯。 */
	initial?: { title: string; instructions: string };
	onClose: () => void;
	onSubmit: (value: { title: string; instructions: string }) => void;
}) {
	const [title, setTitle] = useState("");
	const [instructions, setInstructions] = useState("");
	useEffect(() => {
		if (!open) return;
		setTitle(initial?.title ?? "");
		setInstructions(initial?.instructions ?? "");
	}, [open, initial?.title, initial?.instructions]);

	return (
		<ModalShell open={open} title={initial ? "專案設定" : "新建專案"} size="md" onClose={onClose} testId="project-dialog">
			<form
				className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5"
				onSubmit={(event) => {
					event.preventDefault();
					if (!title.trim()) return;
					onSubmit({ title: title.trim(), instructions });
				}}
			>
				<p className="text-xs text-slate-400">
					一個專案就是一個長期會話：所有相關對話都在這裡進行，工作臺檔案就是專案資料夾，專案指令每輪都會帶給模型。
				</p>
				<label className="block space-y-1">
					<span className="text-xs text-slate-400">名稱</span>
					<input
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="如 論文改寫、家裡裝修"
						aria-label="專案名稱"
						maxLength={60}
						className="w-full rounded-md border border-slate-700 bg-slate-800/70 px-2.5 py-2 text-sm text-slate-100 placeholder:text-slate-500"
					/>
				</label>
				<label className="block min-h-0 flex-1 space-y-1">
					<span className="text-xs text-slate-400">專案指令（可留空）</span>
					<textarea
						value={instructions}
						onChange={(e) => setInstructions(e.target.value)}
						placeholder="背景、目標、輸出格式、要遵守的約定…"
						aria-label="專案指令"
						rows={8}
						maxLength={8000}
						className="w-full resize-y rounded-md border border-slate-700 bg-slate-800/70 px-2.5 py-2 text-sm text-slate-100 placeholder:text-slate-500"
					/>
				</label>
				<div className="flex justify-end gap-2">
					<button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
						取消
					</button>
					<button
						type="submit"
						disabled={!title.trim()}
						className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
					>
						{initial ? "儲存" : "建立"}
					</button>
				</div>
			</form>
		</ModalShell>
	);
}
