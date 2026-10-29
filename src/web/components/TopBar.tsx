import { Icon } from "./Icon";

interface TopBarProps {
	online: boolean;
	sessionLabel: string;
	onOpenDrawer: () => void;
	/** 開啟設定彈窗（v0.20.0：主題/分享/匯出/備份/恢復/面板開關全部移入設定）。 */
	onOpenSettings: () => void;
}

export function TopBar({ online, sessionLabel, onOpenDrawer, onOpenSettings }: TopBarProps) {
	return (
		<header className="z-20 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/80 px-3 backdrop-blur">
			<div className="flex min-w-0 items-center gap-2.5">
				<button
					type="button"
					onClick={onOpenDrawer}
					aria-label="開啟會話列表"
					className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-slate-800 hover:text-white md:hidden"
				>
					<Icon name="menu" className="h-5 w-5" />
				</button>
				<span
					aria-hidden
					className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-base font-semibold text-sky-400"
				>
					π
				</span>
				<h1 className="shrink-0 text-[15px] font-semibold tracking-tight text-slate-100">Free Web Pi</h1>
				<span className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-700/70 px-2 py-0.5 text-xs text-slate-400">
					<span
						aria-hidden
						className={`h-1.5 w-1.5 rounded-full ${online ? "animate-pulse bg-emerald-400" : "bg-red-400"}`}
					/>
					{online ? "線上" : "離線"}
				</span>
				{sessionLabel && <span className="hidden min-w-0 truncate text-xs text-slate-500 lg:inline">{sessionLabel}</span>}
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<button
					type="button"
					onClick={onOpenSettings}
					title="設定"
					aria-label="開啟設定"
					className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
				>
					<Icon name="settings" className="h-4 w-4" />
				</button>
			</div>
		</header>
	);
}
