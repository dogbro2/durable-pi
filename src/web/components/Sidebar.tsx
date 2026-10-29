import { Icon } from "./Icon";
import type { SessionListItem } from "../types";
import { flattenSessions } from "../lib/sessionTree";

interface SidebarProps {
	sessions: SessionListItem[];
	currentId: string;
	query: string;
	sessionsLoading: boolean;
	onQueryChange: (query: string) => void;
	onSelect: (id: string) => void;
	onRename: (id: string, title: string) => void;
	onDelete: (id: string) => void;
	/** 收起會話欄（v0.32.0）。 */
	onCollapse?: () => void;
}

function formatSessionTime(iso: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
	return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Left column content: search + session list (current highlighted).
 * 新會話按鈕在左側 Rail 上（v0.21.0）；記憶庫入口在設定彈窗裡。
 */
export function Sidebar({
	sessions,
	currentId,
	query,
	sessionsLoading,
	onQueryChange,
	onSelect,
	onRename,
	onDelete,
	onCollapse,
}: SidebarProps) {
	const keyword = query.trim().toLowerCase();
	const filtered = keyword ? sessions.filter((s) => s.title.toLowerCase().includes(keyword) || s.id.includes(keyword)) : sessions;
	const tree = flattenSessions(filtered);

	return (
		<div className="flex h-full w-full flex-col bg-slate-900/60">
			<div className="shrink-0 border-b border-slate-800/70 p-3">
				<div className="mb-2 flex items-center justify-between">
					<span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">會話</span>
					{onCollapse && (
						<button
							type="button"
							onClick={onCollapse}
							title="收起會話欄"
							aria-label="收起會話欄"
							className="inline-flex items-center justify-center rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
						>
							<Icon name="chevronsLeft" className="h-4 w-4" />
						</button>
					)}
				</div>
				<input
					type="search"
					value={query}
					onChange={(event) => onQueryChange(event.target.value)}
					placeholder="搜尋會話…"
					aria-label="搜尋會話"
					className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-500 focus:border-sky-500/70 focus:ring-1 focus:ring-sky-500/40"
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
				{sessionsLoading && filtered.length === 0 && (
					<p className="px-1.5 py-2 text-xs text-slate-500">正在載入會話…</p>
				)}
				{!sessionsLoading && filtered.length === 0 && (
					<p className="px-1.5 py-2 text-xs text-slate-500">{keyword ? "沒有匹配的會話。" : "暫無會話。"}</p>
				)}
				<ul className="space-y-0.5">
					{tree.map(({ session, depth }) => {
						const current = session.id === currentId;
						return (
							<li key={session.id} className="group relative">
								<button
									type="button"
									onClick={() => onSelect(session.id)}
									aria-current={current ? "true" : undefined}
									style={depth > 0 ? { paddingLeft: 10 + depth * 14 } : undefined}
									className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 pr-12 text-left transition-colors ${
										current
											? "border-sky-500/40 bg-sky-500/15 text-white"
											: "border-transparent text-slate-300 hover:bg-slate-800 hover:text-slate-100"
									}`}
								>
									<span
										aria-hidden
										className={`shrink-0 ${
											depth > 0 ? "text-violet-300/80" : current ? "text-sky-300" : "text-slate-500"
										}`}
										title={depth > 0 ? `分支：來自會話 ${session.parentId}` : undefined}
									>
										<Icon name={depth > 0 ? "branch" : "chat"} className="h-3.5 w-3.5" />
									</span>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm">{session.title}</span>
										{session.createdAt && (
											<span className="block text-[11px] text-slate-500">{formatSessionTime(session.createdAt)}</span>
										)}
									</span>
								</button>
								<span className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 gap-0.5 group-hover:flex group-focus-within:flex">
									<button
										type="button"
										title="重新命名"
										aria-label={`重新命名 ${session.title}`}
										onClick={(e) => {
											e.stopPropagation();
											const next = window.prompt("新的會話名稱", session.title);
											if (next && next.trim() && next.trim() !== session.title) onRename(session.id, next.trim());
										}}
										className="rounded p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-100"
									>
										<Icon name="edit" className="h-3.5 w-3.5" />
									</button>
									<button
										type="button"
										title="刪除"
										aria-label={`刪除 ${session.title}`}
										onClick={(e) => {
											e.stopPropagation();
											if (window.confirm(`刪除會話「${session.title}」？該會話的檔案也會一併刪除。`)) onDelete(session.id);
										}}
										className="rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
									>
										<Icon name="trash" className="h-3.5 w-3.5" />
									</button>
								</span>
							</li>
						);
					})}
				</ul>
			</div>
		</div>
	);
}
