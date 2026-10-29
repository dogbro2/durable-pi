import { Icon } from "./Icon";

interface ChatHeaderProps {
	sessionId: string;
	sessionTitle: string;
	pending: boolean;
	/** 目標模式（v0.31.0）：開啟設定目標彈窗。 */
	onOpenGoal?: () => void;
	/** 當前會話目標是否進行中（按鈕高亮）。 */
	goalActive?: boolean;
	/** 左欄/右欄收起時在聊天欄兩端提供展開按鈕（v0.32.0）。 */
	leftCollapsed?: boolean;
	rightCollapsed?: boolean;
	onToggleLeft?: () => void;
	onToggleRight?: () => void;
}

/** Slim status strip on top of the chat column: current model + session id. */
export function ChatHeader({
	sessionId,
	sessionTitle,
	pending,
	onOpenGoal,
	goalActive,
	leftCollapsed,
	rightCollapsed,
	onToggleLeft,
	onToggleRight,
}: ChatHeaderProps) {
	return (
		<div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-slate-800/70 bg-slate-900/40 px-4 text-xs">
			<div className="flex shrink-0 items-center gap-2">
				{leftCollapsed && onToggleLeft && (
					<button
						type="button"
						onClick={onToggleLeft}
						title="展開會話欄"
						aria-label="展開會話欄"
						className="inline-flex items-center justify-center rounded-md border border-slate-700 px-1.5 py-0.5 text-slate-400 transition-colors hover:border-sky-500/40 hover:text-sky-300"
					>
						<Icon name="chevronsRight" className="h-3.5 w-3.5" />
					</button>
				)}
				{onOpenGoal && (
					<button
						type="button"
						onClick={onOpenGoal}
						title="設定目標：讓模型自己一輪輪推進直到完成"
						className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 transition-colors ${
							goalActive
								? "border-amber-500/50 bg-amber-500/15 text-amber-300"
								: "border-slate-700 text-slate-400 hover:border-amber-500/40 hover:text-amber-300"
						}`}
					>
						<Icon name="goal" className="h-3.5 w-3.5" />
						目標
					</button>
				)}
			</div>
			<div className="flex min-w-0 items-center gap-2 text-slate-400">
				{pending && <span className="shrink-0 text-amber-300/80">生成中…</span>}
				<span className="min-w-0 truncate">
					會話 #{sessionId}
					{sessionTitle ? ` · ${sessionTitle}` : ""}
				</span>
				{rightCollapsed && onToggleRight && (
					<button
						type="button"
						onClick={onToggleRight}
						title="展開工作臺"
						aria-label="展開工作臺"
						className="inline-flex shrink-0 items-center justify-center rounded-md border border-slate-700 px-1.5 py-0.5 text-slate-400 transition-colors hover:border-sky-500/40 hover:text-sky-300"
					>
						<Icon name="chevronsLeft" className="h-3.5 w-3.5" />
					</button>
				)}
			</div>
		</div>
	);
}
