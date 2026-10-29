import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { api } from "../lib/api";
import { parseKbDocs, parseKbHits } from "../lib/collections";
import { formatSize, formatTime } from "../lib/format";
import { renderMarkdown } from "../lib/rich";
import type { KbDocInfo, KbFocus, KbHit } from "../types";
import { Icon } from "./Icon";
import { KbImport, type IncomingDrop } from "./KbImport";

/** 模組級 UI 記憶（契約 §6.3）：只保留檢索詞；搜尋結果與草稿關閉即丟棄。 */
const viewMemory = { query: "" };

/**
 * 知識庫面板（v0.45.0，NERE-62 起為彈窗內容）：每個使用者一個獨立庫（後端按使用者 DO 隔離）。
 * 支援檢索、匯入檔案 / 連結、貼上資料入庫、檢視與刪除；模型側對應 kb_search / kb_add。
 *
 * 外殼（標題 / 寬度 / 遮罩 / 關閉）由 ModalShell 提供；本元件只負責面板內容。
 */
export function KnowledgePanel({
	focus,
	onFocusConsumed,
}: {
	onClose: () => void;
	focus?: KbFocus | null;
	/** 定位請求已消費：通知頁面層清空，彈窗重開時不再重放上一篇（NERE-75 P1-1）。 */
	onFocusConsumed?: () => void;
}) {
	const [docs, setDocs] = useState<KbDocInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [query, setQueryState] = useState(viewMemory.query);
	/** 檢索詞寫回模組級記憶，重開彈窗時還在（結果不保留）。 */
	const setQuery = (value: string) => {
		viewMemory.query = value;
		setQueryState(value);
	};
	const [hits, setHits] = useState<KbHit[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [adding, setAdding] = useState(false);
	const [title, setTitle] = useState("");
	const [source, setSource] = useState("");
	const [tags, setTags] = useState("");
	const [content, setContent] = useState("");
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState("");
	const [viewing, setViewing] = useState<{ title: string; content: string; hitSeq?: number } | null>(null);
	const viewingBusy = useRef(false);
	/** 拖拽懸停與待匯入檔案：面板任意位置都能投放，匯入區在「新增」裡。 */
	const [dropActive, setDropActive] = useState(false);
	const [incomingDrop, setIncomingDrop] = useState<IncomingDrop | null>(null);
	const dragDepth = useRef(0);

	const load = useCallback(() => {
		setLoading(true);
		void (async () => {
			try {
				const data = await api.kbDocs();
				setDocs(parseKbDocs(data));
				setError(null);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading(false);
			}
		})();
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const search = () => {
		const q = query.trim();
		if (!q) {
			setHits(null);
			return;
		}
		setSearching(true);
		void (async () => {
			try {
				const data = await api.kbSearch(q);
				setHits(parseKbHits(data));
				setError(null);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setSearching(false);
			}
		})();
	};

	const add = () => {
		if (busy || !title.trim() || !content.trim()) return;
		setBusy(true);
		setNote("");
		void (async () => {
			try {
				const data = await api.kbAdd(title.trim(), content.trim(), source.trim(), tags.trim());
				if (!data.id) throw new Error(data.error || "儲存失敗");
				setNote(`已入庫：${data.chunks ?? 0} 個片段`);
				setTitle("");
				setSource("");
				setTags("");
				setContent("");
				setAdding(false);
				setHits(null);
				setQuery("");
				load();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		})();
	};

	const remove = (doc: KbDocInfo) => {
		if (!window.confirm(`刪除知識庫文件「${doc.title}」？刪除後無法檢索。`)) return;
		void (async () => {
			try {
				await api.kbDelete(doc.id);
				setHits((prev) => prev?.filter((hit) => hit.docId !== doc.id) ?? null);
				load();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		})();
	};

	const view = useCallback((id: number, hitSeq?: number) => {
		if (viewingBusy.current) return;
		viewingBusy.current = true;
		void (async () => {
			try {
				const data = await api.kbDoc(id);
				setViewing({ title: data.title || "未命名文件", content: data.content || "", hitSeq });
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				viewingBusy.current = false;
			}
		})();
	}, []);

	// 從訊息裡的參考資料跳進來（NERE-41）：nonce 變化即開啟對應文件，重複點同一篇也能再次觸發。
	// 開啟後立刻消費掉（NERE-75 P1-1）：否則關閉再重開時元件重新掛載，舊 nonce 會再開啟同一篇。
	const focusNonce = focus?.nonce;
	const focusDocId = focus?.docId;
	const focusSeq = focus?.chunkSeq;
	useEffect(() => {
		if (focusNonce === undefined || focusDocId === undefined) return;
		view(focusDocId, focusSeq);
		onFocusConsumed?.();
	}, [focusNonce, focusDocId, focusSeq, view, onFocusConsumed]);

	/** 匯入成功後回到完整列表：檢索結果裡不會有剛入庫的文件。 */
	const handleImported = useCallback(() => {
		setHits(null);
		setQuery("");
		load();
	}, [load]);

	const handleIncomingConsumed = useCallback(() => setIncomingDrop(null), []);

	const hasFileDrag = (event: DragEvent<HTMLDivElement>) => Array.from(event.dataTransfer.types).includes("Files");

	const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
		if (!hasFileDrag(event)) return;
		event.preventDefault();
		dragDepth.current += 1;
		setDropActive(true);
	};

	const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
		if (!hasFileDrag(event)) return;
		// 不 preventDefault 瀏覽器會直接開啟檔案，覆蓋整個頁面。
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		if (!adding) setAdding(true);
	};

	const handleDragLeave = () => {
		// 不按 types 過濾：部分瀏覽器在 dragleave 時已清空 types，過濾會讓高亮卡住。
		dragDepth.current = Math.max(0, dragDepth.current - 1);
		if (dragDepth.current === 0) setDropActive(false);
	};

	const handleDrop = (event: DragEvent<HTMLDivElement>) => {
		if (!hasFileDrag(event)) return;
		event.preventDefault();
		dragDepth.current = 0;
		setDropActive(false);
		const file = event.dataTransfer.files.item(0);
		if (!file) return;
		setAdding(true);
		setIncomingDrop({ file });
	};

	const inputClass =
		"w-full rounded-md border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500";

	if (viewing) {
		return (
			<div
				className="flex min-h-0 flex-1 flex-col"
				// 閱讀文件時不接收匯入，但也不能讓瀏覽器把拖進來的檔案當導航開啟。
				onDragOver={(event) => event.preventDefault()}
				onDrop={(event) => event.preventDefault()}
			>
				<div className="flex shrink-0 items-center gap-1.5 border-b border-slate-800/70 px-2.5 py-2">
					<button
						type="button"
						onClick={() => setViewing(null)}
						aria-label="返回知識庫"
						title="返回"
						className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
					>
						<Icon name="chevronsLeft" className="h-4 w-4" />
					</button>
					<span className="min-w-0 flex-1">
						<span className="block truncate text-[13px] font-medium text-slate-100" title={viewing.title}>
							{viewing.title}
						</span>
						{viewing.hitSeq !== undefined && (
							<span className="block truncate text-[10.5px] text-slate-500">命中第 {viewing.hitSeq + 1} 段</span>
						)}
					</span>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
					<article className="md-prose break-words text-[13px]">{renderMarkdown(viewing.content)}</article>
				</div>
			</div>
		);
	}

	return (
		<div
			className="relative flex min-h-0 flex-1 flex-col"
			onDragEnter={handleDragEnter}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			<div className="flex shrink-0 items-center justify-between border-b border-slate-800/70 px-3 py-2">
				<span className="text-[12.5px] font-medium text-slate-300">僅你可見</span>
				<span className="flex items-center gap-1.5">
					<span className="rounded-full bg-slate-700/80 px-1.5 text-[10px] tabular-nums text-slate-300">{docs.length}</span>
					<button
						type="button"
						onClick={() => setAdding((value) => !value)}
						aria-pressed={adding}
						title={adding ? "收起新增" : "新增 / 匯入文件"}
						aria-label={adding ? "收起新增" : "新增 / 匯入文件"}
						className="inline-flex items-center justify-center rounded p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
					>
						<Icon name={adding ? "close" : "plus"} className="h-4 w-4" />
					</button>
				</span>
			</div>

			<form
				className="flex shrink-0 gap-1.5 border-b border-slate-800/70 p-2.5"
				onSubmit={(event) => {
					event.preventDefault();
					search();
				}}
			>
				<input
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						if (!event.target.value.trim()) setHits(null);
					}}
					placeholder="檢索知識庫…"
					aria-label="檢索知識庫"
					className={inputClass}
				/>
				<button
					type="submit"
					disabled={searching}
					className="shrink-0 rounded-md bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
				>
					{searching ? "檢索中" : "檢索"}
				</button>
			</form>

			{adding && (
				<div className="max-h-[62vh] shrink-0 space-y-1.5 overflow-y-auto overscroll-contain border-b border-slate-800/70 p-2.5">
					<KbImport
						incoming={incomingDrop}
						onIncomingConsumed={handleIncomingConsumed}
						onImported={handleImported}
						dropActive={dropActive}
					/>
					<p className="flex items-center gap-1.5 pt-0.5 text-[10.5px] text-slate-500">
						<span aria-hidden className="h-px flex-1 bg-slate-800" />
						或手動貼上正文
						<span aria-hidden className="h-px flex-1 bg-slate-800" />
					</p>
					<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="標題（必填）" aria-label="文件標題" className={inputClass} />
					<div className="flex gap-1.5">
						<input value={source} onChange={(event) => setSource(event.target.value)} placeholder="來源（可選）" aria-label="來源" className={inputClass} />
						<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="標籤（可選）" aria-label="標籤" className={inputClass} />
					</div>
					<textarea
						value={content}
						onChange={(event) => setContent(event.target.value)}
						placeholder="貼上正文，支援 Markdown。也可以直接讓 π 用 kb_add 從連結或對話裡存入。"
						aria-label="文件正文"
						rows={6}
						className={`${inputClass} resize-y leading-relaxed`}
					/>
					<button
						type="button"
						onClick={add}
						disabled={busy || !title.trim() || !content.trim()}
						className="w-full rounded-md bg-emerald-600 px-2 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
					>
						{busy ? "寫入並索引中…" : "儲存到知識庫"}
					</button>
					<p className="text-[11px] leading-relaxed text-slate-500">自動按段切塊並建立中文全文索引，儲存後即可用自然語言檢索。</p>
				</div>
			)}

			{note && <p className="mx-2.5 mt-2 rounded-md bg-emerald-950/40 px-2 py-1 text-[11px] text-emerald-300">{note}</p>}
			{error && <p className="mx-2.5 mt-2 rounded-md bg-rose-950/40 px-2 py-1 text-[11px] text-rose-300">{error}</p>}

			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
				{loading && docs.length === 0 && <p className="px-1 py-2 text-xs text-slate-500">正在載入…</p>}

				{hits !== null ? (
					<>
						<p className="px-1 py-1 text-[11px] text-slate-500">{hits.length ? `命中 ${hits.length} 個片段` : "沒有匹配的內容。"}</p>
						<ul className="space-y-1">
							{hits.map((hit, index) => (
								<li key={`${hit.docId}-${hit.chunkSeq}-${index}`} className="rounded-lg bg-slate-800/50 px-2.5 py-2">
									<button type="button" onClick={() => view(hit.docId)} className="block w-full text-left">
										<span className="block truncate text-[12.5px] text-slate-100">{hit.title}</span>
										{hit.source && <span className="block truncate text-[10.5px] text-slate-500">{hit.source}</span>}
										<span className="mt-1 block whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-slate-400">
											{hit.text.length > 220 ? `${hit.text.slice(0, 220)}…` : hit.text}
										</span>
									</button>
								</li>
							))}
						</ul>
					</>
				) : (
					<>
						{!loading && docs.length === 0 && !error && (
							<p className="px-1.5 py-6 text-center text-xs leading-relaxed text-slate-500">
								知識庫還是空的。
								<br />
								拖入 PDF / MD / TXT / DOCX，或貼上網頁連結；
								<br />
								也可以讓 π 用 kb_add 存進來。
							</p>
						)}
						<ul className="space-y-1">
							{docs.map((doc) => (
								<li key={doc.id} className="group flex items-start gap-1 rounded-lg bg-slate-800/50 px-2.5 py-2">
									<button type="button" onClick={() => view(doc.id)} className="min-w-0 flex-1 text-left">
										<span className="block truncate text-[13px] text-slate-100" title={doc.title}>
											{doc.title}
										</span>
										<span className="block truncate text-[11px] text-slate-500">
											{formatSize(doc.size)} · {doc.chunks} 段
											{doc.tags ? ` · ${doc.tags}` : ""}
										</span>
										<span className="block text-[10.5px] text-slate-600">{formatTime(doc.updatedAt)}</span>
									</button>
									<button
										type="button"
										onClick={() => remove(doc)}
										aria-label={`刪除文件 ${doc.title}`}
										title="刪除文件"
										className="shrink-0 rounded p-1 text-slate-500 opacity-0 transition-all hover:bg-red-950/60 hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100"
									>
										<Icon name="trash" className="h-3.5 w-3.5" />
									</button>
								</li>
							))}
						</ul>
					</>
				)}
			</div>

			{dropActive && (
				<div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-sky-500/10 ring-2 ring-inset ring-sky-400">
					<span className="rounded-lg bg-slate-900/90 px-3 py-2 text-xs text-sky-300 ring-1 ring-sky-400/40">
						鬆手匯入到知識庫
					</span>
				</div>
			)}
		</div>
	);
}
