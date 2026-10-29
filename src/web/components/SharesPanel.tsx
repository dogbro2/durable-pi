import { useEffect } from "react";
import { useShares } from "../hooks/useShares";
import { Icon } from "./Icon";
import { PanelHeader } from "./PanelHeader";
import { ShareRow } from "./ShareRow";
import type { ShareRecord } from "../types";

const refreshButton =
	"inline-flex items-center justify-center rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200";

/**
 * 左欄「分享」面板（NERE-43，L2）：取數只經 useShares，不直接碰傳輸層。
 * 三態（loading / error / empty）+ 有資料清單；行級撤銷失敗文案顯示在清單頂部。
 * `onLoaded`（NERE-74）：清單每次落地時把資料交給上層推進未讀水位，面板行為本身不變。
 */
export function SharesPanel({
	onCollapse,
	onLoaded,
}: {
	onCollapse?: () => void;
	onLoaded?: (items: ShareRecord[]) => void;
}) {
	const { items, status, error, actionError, revoking, reload, revoke, clearActionError } = useShares();
	const loading = status === "idle" || status === "loading";

	useEffect(() => {
		if (status === "ready") onLoaded?.(items);
	}, [status, items, onLoaded]);

	return (
		<div className="flex h-full w-full flex-col bg-slate-900/60">
			<PanelHeader
				title="分享"
				count={status === "ready" ? items.length : undefined}
				onCollapse={onCollapse}
				actions={
					<button type="button" onClick={reload} title="重新整理分享清單" aria-label="重新整理分享清單" className={refreshButton}>
						<Icon name="restore" className="h-4 w-4" />
					</button>
				}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto" aria-busy={loading || undefined}>
				{actionError && (
					<div
						role="alert"
						className="mx-2 mt-2 flex items-start gap-1.5 rounded-md border border-rose-500/30 bg-rose-950/30 px-2 py-1.5 text-[11px] text-rose-200"
					>
						<span className="min-w-0 flex-1">{actionError}</span>
						<button
							type="button"
							onClick={clearActionError}
							aria-label="關閉錯誤提示"
							title="關閉"
							className="shrink-0 rounded p-0.5 text-rose-300 transition-colors hover:bg-rose-900/50"
						>
							<Icon name="close" className="h-3.5 w-3.5" />
						</button>
					</div>
				)}

				{loading ? (
					<div className="space-y-2 p-3" aria-hidden>
						{[0, 1, 2].map((row) => (
							<div key={row} className="h-[68px] animate-pulse rounded-lg bg-slate-800/50" />
						))}
					</div>
				) : status === "error" ? (
					<div className="p-3">
						<p className="text-xs text-rose-300">清單載入失敗：{error}</p>
						<button
							type="button"
							onClick={reload}
							className="mt-2 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 transition-colors hover:bg-slate-800"
						>
							重試
						</button>
					</div>
				) : items.length === 0 ? (
					<p className="p-3 text-xs leading-relaxed text-slate-500">
						還沒有分享連結。在會話或檔案上點分享後，連結會出現在這裡。
					</p>
				) : (
					<ul className="space-y-1.5 p-2">
						{items.map((record) => (
							<ShareRow
								key={record.token}
								record={record}
								revoking={revoking.has(record.token)}
								onRevoke={revoke}
							/>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
