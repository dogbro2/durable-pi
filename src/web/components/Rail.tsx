import { Icon, type IconName } from "./Icon";

/** 左欄內容（不是彈窗）。 */
export type RailView = "sessions" | "files" | "shares" | "automations" | "users";
/** 走彈窗的三個入口（NERE-62）。與 RailView 不是同一維度，不要合併。 */
export type RailPanel = "kb" | "mcp" | "skills";

interface RailProps {
	view: RailView;
	/** 當前開啟的彈窗；同一時刻最多一個。 */
	panel: RailPanel | null;
	onSelectView: (view: RailView) => void;
	/** 再點一次同一入口 = 關閉（冪等）。 */
	onTogglePanel: (panel: RailPanel) => void;
	onNewSession: () => void;
	newSessionDisabled?: boolean;
	onOpenSettings: () => void;
	/** 只有主人能看到使用者管理（v0.43.0）。 */
	isOwner?: boolean;
	/** 分享清單介面是否已上線（NERE-56）：未上線時不渲染入口。 */
	sharesAvailable?: boolean;
	/** 分享未讀數（NERE-74）：>0 時圖示右上角顯示圓點，讀數只進 aria-label。 */
	sharesUnread?: number;
	/** 定時任務未讀數（NERE-74）：成功 / 失敗共用同一點位，狀態由面板內的徽標區分。 */
	automationsUnread?: number;
}

const railButton =
	"flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 aria-pressed:bg-sky-500/15 aria-pressed:text-sky-300 aria-expanded:bg-sky-500/15 aria-expanded:text-sky-300";

/** 最左側固定工具欄（v0.21.0）：新會話 + 會話/檔案/分享/定時/使用者 + 三個彈窗入口 + 設定。 */
export function Rail({ view, panel, onSelectView, onTogglePanel, onNewSession, newSessionDisabled, onOpenSettings, isOwner, sharesAvailable, sharesUnread = 0, automationsUnread = 0 }: RailProps) {
	/**
	 * 左欄內容入口。未讀圓點（NERE-74）只是按鈕裡的一個裝飾性 span：
	 * 不參與 tab 順序、不進無障礙樹，未讀數通過 aria-label 播報。
	 */
	const item = (value: RailView, label: string, icon: IconName, unread = 0) => {
		const badge = unread > 0;
		return (
			<button
				key={value}
				type="button"
				onClick={() => onSelectView(value)}
				aria-pressed={view === value}
				title={badge ? `${label}（${unread} 條未讀）` : label}
				aria-label={badge ? `${label}，${unread} 條未讀` : label}
				className={`${railButton} relative`}
			>
				<Icon name={icon} className="h-[18px] w-[18px]" />
				{badge && (
					<span
						aria-hidden
						data-unread-dot={value}
						className="pointer-events-none absolute right-1 top-1 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-slate-950"
					/>
				)}
			</button>
		);
	};

	/** 彈窗入口：語義從「切換左欄」變成「開啟對話方塊」（契約 §1.2）。 */
	const modalItem = (value: RailPanel, label: string, icon: IconName) => (
		<button
			key={value}
			type="button"
			onClick={() => onTogglePanel(value)}
			aria-haspopup="dialog"
			aria-expanded={panel === value}
			data-modal-trigger={value}
			title={label}
			aria-label={label}
			className={railButton}
		>
			<Icon name={icon} className="h-[18px] w-[18px]" />
		</button>
	);

	return (
		<nav
			aria-label="主導航"
			className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-slate-800/70 bg-slate-950/40 py-2"
		>
			<button
				type="button"
				onClick={onNewSession}
				disabled={newSessionDisabled}
				title="新會話"
				aria-label="新建會話"
				className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-600/90 text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
			>
				<Icon name="plus" className="h-5 w-5" />
			</button>
			<div aria-hidden className="my-1 h-px w-6 bg-slate-800" />
			{item("sessions", "會話", "sessions")}
			{item("files", "全部檔案", "folder")}
			{modalItem("kb", "知識庫", "kb")}
			{sharesAvailable && item("shares", "分享", "share", sharesUnread)}
			{modalItem("mcp", "連線", "connection")}
			{item("automations", "定時", "clock", automationsUnread)}
			{modalItem("skills", "能力", "skills")}
			{isOwner && item("users", "使用者", "users")}
			<div aria-hidden className="flex-1" />
			<button type="button" onClick={onOpenSettings} title="設定" aria-label="開啟設定" className={railButton}>
				<Icon name="settings" className="h-[18px] w-[18px]" />
			</button>
		</nav>
	);
}
