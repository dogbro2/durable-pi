import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { renderMarkdown } from "../lib/rich";
import { formatSize, formatTime } from "../lib/format";
import { ShareDialog } from "./ShareDialog";
import { Icon } from "./Icon";
import type { FileInfo } from "../types";

interface WorkbenchProps {
	sessionId: string;
	files: FileInfo[];
	/** files 對應的會話（v0.45.0）：跨會話開啟時等新列表載入完再判斷檔案是否存在。 */
	filesForSession?: string;
	filesLoading: boolean;
	filesError: string | null;
	/** 最大化閱讀（v0.16.0）。 */
	wide: boolean;
	onToggleWide: () => void;
	/** 開啟/關閉檔案時通知外層（用於自動加寬）。 */
	onFileOpenChange: (open: boolean) => void;
	/** Bumped after each chat round / deletion so an open file re-fetches fresh content. */
	refreshTick: number;
	onDeleteFile: (name: string) => Promise<boolean>;
	/** 從聊天裡的檔案卡請求開啟某個檔案（v0.22.0）。 */
	openRequest?: { name: string; tick: number } | null;
	/** 收起工作臺（v0.32.0）。 */
	onCollapse?: () => void;
}

/** The file list: virtual files produced by the agent's write_file tool. */
function FileList({
	files,
	loading,
	error,
	onOpen,
	onDelete,
}: {
	files: FileInfo[];
	loading: boolean;
	error: string | null;
	onOpen: (name: string) => void;
	onDelete: (name: string) => void;
}) {
	return (
		<div className="min-h-0 flex-1 overflow-y-auto p-2">
			{error && (
				<p className="mx-1 mb-2 rounded-lg border border-amber-500/30 bg-amber-950/30 px-2.5 py-1.5 text-xs text-amber-300/90">
					檔案列表載入失敗：{error}
				</p>
			)}
			{!loading && !error && files.length === 0 && (
				<p className="px-1.5 py-6 text-center text-xs leading-relaxed text-slate-500">
					工作臺還沒有檔案。
					<br />
					讓 π 用 write_file 寫報告、筆記後會出現在這裡。
				</p>
			)}
			<ul className="space-y-0.5">
				{files.map((file) => (
					<li
						key={file.name}
						className="group flex items-center gap-1 rounded-lg border border-transparent px-2 py-1.5 transition-colors hover:border-slate-700/70 hover:bg-slate-800"
					>
						<button
							type="button"
							onClick={() => onOpen(file.name)}
							className="flex min-w-0 flex-1 items-center gap-2 text-left"
						>
							<span aria-hidden className="shrink-0 text-slate-400">
								<Icon name="file" className="h-4 w-4" />
							</span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[13px] text-slate-100">{file.name}</span>
								<span className="block text-[11px] text-slate-500">
									{formatSize(file.size)}
									{file.updatedAt ? ` · ${formatTime(file.updatedAt)}` : ""}
								</span>
							</span>
						</button>
						<button
							type="button"
							onClick={() => onDelete(file.name)}
							aria-label={`刪除檔案 ${file.name}`}
							title={`刪除 ${file.name}`}
							className="shrink-0 rounded-md px-1.5 py-1 text-slate-500 opacity-0 transition-all hover:bg-red-950/60 hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100"
						>
							<Icon name="trash" className="h-3.5 w-3.5" />
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

type ContentState = "loading" | "ready" | "error";

/** Full-width file view: header + preview/source toggle. */
function FileView({
	sessionId,
	name,
	refreshTick,
	onClose,
	onDelete,
	wide,
	onToggleWide,
	dockRight,
	onCollapse,
}: {
	sessionId: string;
	name: string;
	refreshTick: number;
	onClose: () => void;
	onDelete: (name: string) => void;
	wide: boolean;
	onToggleWide: () => void;
	dockRight: boolean;
	onCollapse?: () => void;
}) {
	const [mode, setMode] = useState<"preview" | "source">("preview");
	// HTML 檔案用 sandbox iframe 渲染，其餘走 Markdown（v0.15.0）
	const isHtml = /\.html?$/i.test(name);
	// 可分享的檔案型別（v0.38.0）：Markdown 渲染成分享頁，HTML 原樣輸出
	const canShare = /\.(md|markdown|html?)$/i.test(name);
	const [shareOpen, setShareOpen] = useState(false);
	const [content, setContent] = useState("");
	const [state, setState] = useState<ContentState>("loading");
	const [error, setError] = useState("");

	// Fetch file content on open / refresh; alive guard for the async continuation
	useEffect(() => {
		let alive = true;
		setState("loading");
		setError("");
		void (async () => {
			try {
				const data = await api.fileContent(sessionId, name);
				if (!alive) return;
				setContent(typeof data.content === "string" ? data.content : "");
				setState("ready");
			} catch (err) {
				if (!alive) return;
				setState("error");
				setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			alive = false;
		};
	}, [sessionId, name, refreshTick]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-slate-800/70 px-2.5 py-2">
				<button
					type="button"
					onClick={onClose}
					aria-label="關閉檔案檢視"
					title="關閉"
					className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
				>
					<Icon name="close" className="h-4 w-4" />
				</button>
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-100">{name}</span>
				<div className="flex shrink-0 overflow-hidden rounded-lg border border-slate-700">
					{(["preview", "source"] as const).map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => setMode(value)}
							aria-pressed={mode === value}
							className={`px-2.5 py-1 text-xs transition-colors ${
								mode === value ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
							}`}
						>
							{value === "preview" ? "預覽" : "原始碼"}
						</button>
					))}
				</div>
				{onCollapse && (
					<button
						type="button"
						onClick={onCollapse}
						aria-label="收起工作臺"
						title="收起工作臺"
						className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
					>
						<Icon name="chevronsRight" className="h-4 w-4" />
					</button>
				)}
				<button
					type="button"
					onClick={onToggleWide}
					aria-pressed={wide}
					aria-label={wide ? "退出全寬閱讀" : "全寬閱讀"}
					title={wide ? "退出全寬閱讀" : "全寬閱讀"}
					className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
				>
					<Icon name={wide ? "restoreSize" : "maximize"} className="h-4 w-4" />
				</button>
				{canShare && (
					<button
						type="button"
						onClick={() => setShareOpen(true)}
						aria-label={`分享 ${name}`}
						title="分享連結"
						className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
					>
						<Icon name="share" className="h-4 w-4" />
					</button>
				)}
				<button
					type="button"
					onClick={() => onDelete(name)}
					aria-label={`刪除檔案 ${name}`}
					title="刪除檔案"
					className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-red-950/60 hover:text-red-300"
				>
					<Icon name="trash" className="h-4 w-4" />
				</button>
			</div>
			<div className={`min-h-0 flex-1 overflow-y-auto p-3 ${dockRight ? "md:px-8" : ""}`}>
				{/* HTML 預覽要撐滿可用高度：百分比高度需要父級有確定高度，否則 iframe 只佔預設高度（v0.31.1） */}
				<div
					className={`${dockRight ? "mx-auto w-full max-w-4xl" : ""} ${
						state === "ready" && mode === "preview" && isHtml ? "h-full" : ""
					}`}
				>
					{state === "loading" && <p className="text-xs text-slate-500">正在載入檔案內容…</p>}
					{state === "error" && <p className="text-xs text-red-300/90">載入失敗：{error}</p>}
					{state === "ready" && mode === "preview" && isHtml && (
						<iframe
							title={`${name} 預覽`}
							sandbox="allow-scripts"
							srcDoc={content}
							className="h-full min-h-[420px] w-full rounded-lg border border-slate-700 bg-white"
						/>
					)}
					{state === "ready" && mode === "preview" && !isHtml && (
						<article className="md-prose text-[14px] sm:text-[15px] xl:text-[16px]">{renderMarkdown(content)}</article>
					)}
					{state === "ready" && mode === "source" && (
						<pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-300">{content}</pre>
					)}
				</div>
			</div>
			{shareOpen && <ShareDialog sessionId={sessionId} name={name} onClose={() => setShareOpen(false)} />}
		</div>
	);
}

/** 右欄：檔案預覽（v0.21.0 起 —— 連線/定時/技能移到左側工具欄，記憶移到設定）。 */
export function Workbench({
	sessionId,
	files,
	filesForSession,
	filesLoading,
	filesError,
	wide,
	onToggleWide,
	onFileOpenChange,
	refreshTick,
	onDeleteFile,
	openRequest,
	onCollapse,
}: WorkbenchProps) {
	const [openName, setOpenName] = useState<string | null>(null);

	// 聊天裡的檔案卡 → 直接開啟（v0.22.0）
	useEffect(() => {
		if (!openRequest?.name) return;
		setOpenName(openRequest.name);
		onFileOpenChange(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [openRequest?.tick]);

	// If the open file disappears from the list (deleted elsewhere / reset), fall back to the list.
	// 列表還在載入時不要關，否則剛開啟的檔案會被誤關。
	useEffect(() => {
		if (filesLoading) return;
		// 剛切換會話、新列表還沒到時不要判斷，否則跨會話開啟的剛開啟的檔案會被誤關（v0.45.0）
		if (filesForSession && filesForSession !== sessionId) return;
		if (openName && !files.some((file) => file.name === openName)) {
			setOpenName(null);
			onFileOpenChange(false); // 同步通知外層還原寬度 / 退出全寬
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [files, openName, filesLoading, filesForSession, sessionId]);

	const handleOpenFile = (name: string) => {
		setOpenName(name);
		onFileOpenChange(true);
	};

	const handleDeleteFile = (name: string) => {
		if (!window.confirm(`確認刪除檔案「${name}」？此操作不可撤銷。`)) return;
		void (async () => {
			const ok = await onDeleteFile(name);
			if (ok && name === openName) {
				setOpenName(null);
				onFileOpenChange(false); // 刪掉正在看的檔案同樣還原佈局
			}
		})();
	};

	return (
		<aside className="flex h-full w-full flex-col bg-slate-900/60" aria-label="檔案預覽">
			{openName ? (
				<FileView
					sessionId={sessionId}
					name={openName}
					refreshTick={refreshTick}
					onClose={() => {
						setOpenName(null);
						onFileOpenChange(false);
					}}
					onDelete={handleDeleteFile}
					wide={wide}
					onToggleWide={onToggleWide}
					dockRight={wide}
					onCollapse={onCollapse}
				/>
			) : (
				<>
					<div className="flex shrink-0 items-center justify-between border-b border-slate-800/70 px-3 py-2">
						<span className="text-[12.5px] font-medium text-slate-300">檔案</span>
						<span className="flex items-center gap-1.5">
							<span className="rounded-full bg-slate-700/80 px-1.5 text-[10px] tabular-nums text-slate-300">{files.length}</span>
							{onCollapse && (
								<button
									type="button"
									onClick={onCollapse}
									aria-label="收起工作臺"
									title="收起工作臺"
									className="inline-flex items-center justify-center rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
								>
									<Icon name="chevronsRight" className="h-4 w-4" />
								</button>
							)}
						</span>
					</div>
					<FileList files={files} loading={filesLoading} error={filesError} onOpen={handleOpenFile} onDelete={handleDeleteFile} />
				</>
			)}
		</aside>
	);
}
