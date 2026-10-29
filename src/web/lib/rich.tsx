import { useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";

/**
 * 輕量 Markdown 渲染（v0.22.0 增強）：標題 1–6、有序/無序/**巢狀**列表、
 * 任務列表、程式碼塊（帶語言與複製）、引用、分隔線、管道表格（含對齊）、
 * 圖片，行內支援 **粗體** / *斜體* / ~~刪除線~~ / `程式碼` / [連結]。
 * 刻意不引第三方庫：輸出的是 React 元素，天然轉義，沒有 XSS 面。
 */

const SAFE_HREF = /^(https?:\/\/|\/|#)/i;
const SAFE_SRC = /^(https?:\/\/|data:image\/)/i;

/** 行內富文本。 */
export function renderRichText(text: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	const re =
		/(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(~~([^~]+)~~)|(`([^`]+)`)|(!\[([^\]]*)\]\(([^)\s]+)\))|(\[([^\]]+)\]\(([^)\s]+)\))/g;
	let last = 0;
	let key = 0;
	let match: RegExpExecArray | null;

	while ((match = re.exec(text)) !== null) {
		if (match.index > last) nodes.push(text.slice(last, match.index));
		if (match[2] !== undefined) {
			nodes.push(
				<strong key={key++} className="font-semibold text-white">
					{match[2]}
				</strong>,
			);
		} else if (match[4] !== undefined) {
			nodes.push(
				<em key={key++} className="italic">
					{match[4]}
				</em>,
			);
		} else if (match[6] !== undefined) {
			nodes.push(
				<span key={key++} className="line-through opacity-70">
					{match[6]}
				</span>,
			);
		} else if (match[8] !== undefined) {
			nodes.push(
				<code key={key++} className="rounded bg-slate-950/70 px-1 py-0.5 font-mono text-[0.92em] text-slate-200">
					{match[8]}
				</code>,
			);
		} else if (match[10] !== undefined) {
			const src = match[11] ?? "";
			if (SAFE_SRC.test(src)) {
				nodes.push(
					<img
						key={key++}
						src={src}
						alt={match[10] || "圖片"}
						className="my-1.5 max-h-72 max-w-full rounded-lg border border-slate-700 object-contain"
					/>,
				);
			} else {
				nodes.push(<span key={key++}>{match[10]}</span>);
			}
		} else if (match[13] !== undefined) {
			const href = match[14] ?? "#";
			nodes.push(
				SAFE_HREF.test(href) ? (
					<a key={key++} href={href} target="_blank" rel="noreferrer noopener" className="text-sky-400 underline">
						{match[13]}
					</a>
				) : (
					<span key={key++}>{match[13]}</span>
				),
			);
		}
		last = match.index + match[0].length;
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
}

/** 程式碼塊：語言標籤 + 複製按鈕。 */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
	const [copied, setCopied] = useState(false);
	const copy = () => {
		void navigator.clipboard?.writeText(code).then(
			() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1400);
			},
			() => {},
		);
	};
	return (
		<div className="my-2 overflow-hidden rounded-lg border border-slate-700 bg-slate-950/70">
			<div className="flex items-center justify-between border-b border-slate-800 px-3 py-1">
				<span className="md-code-label font-mono uppercase tracking-wide text-slate-500">{lang || "text"}</span>
				<button
					type="button"
					onClick={copy}
					className="rounded px-1.5 py-0.5 text-[0.78em] text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
				>
					{copied ? "已複製" : "複製"}
				</button>
			</div>
			<pre className="overflow-x-auto p-3 text-[0.9em] leading-relaxed">
				<code className="font-mono text-slate-200">{code}</code>
			</pre>
		</div>
	);
}

type ListItem = { text: string; indent: number; task?: boolean; checked?: boolean };

/** 把收集到的列表項（含縮排）渲染成巢狀列表。 */
function renderList(items: ListItem[], ordered: boolean, keyBase: string): ReactNode {
	// 按縮排建樹：只處理一層巢狀，更深的摺疊到同層（Markdown 常見 2 空格/4 空格）
	const roots: { item: ListItem; children: ListItem[] }[] = [];
	for (const item of items) {
		if (item.indent === 0 || roots.length === 0) roots.push({ item, children: [] });
		else roots[roots.length - 1]!.children.push(item);
	}

	const renderItemMarker = (item: ListItem) =>
		item.task === true ? (
			<span aria-hidden className={`mr-1 inline-flex align-middle ${item.checked ? "text-emerald-400" : "text-slate-500"}`}>
				<Icon name={item.checked ? "checkboxOn" : "checkboxOff"} className="h-3.5 w-3.5" />
			</span>
		) : null;

	const ListTag = ordered ? "ol" : "ul";
	return (
		<ListTag key={keyBase}>
			{roots.map(({ item, children }, index) => (
				<li key={index} className={item.task ? "list-none" : undefined}>
					{renderItemMarker(item)}
					{renderRichText(item.text)}
					{children.length > 0 && renderList(children, ordered, `${keyBase}-${index}`)}
				</li>
			))}
		</ListTag>
	);
}

/** 分隔行單元格：`---` / `:---` / `:---:` / `---:`。 */
function isSeparatorCell(cell: string): boolean {
	return /^:?-{2,}:?$/.test(cell.trim());
}

/** 表格對齊：`:---` 左、`:---:` 中、`---:` 右；無冒號按預設（不設 text-align）。 */
function parseAlign(cell: string): "left" | "center" | "right" | undefined {
	const t = cell.trim();
	if (!isSeparatorCell(t)) return undefined;
	const l = t.startsWith(":");
	const r = t.endsWith(":");
	return l && r ? "center" : r ? "right" : l ? "left" : undefined;
}

export function renderMarkdown(text: string): ReactNode[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const nodes: ReactNode[] = [];
	let list: ListItem[] = [];
	let listOrdered = false;
	let table: string[] = [];
	let quote: string[] = [];
	let key = 0;

	const flushList = () => {
		if (!list.length) return;
		const items = list;
		const ordered = listOrdered;
		list = [];
		nodes.push(renderList(items, ordered, `l${key++}`));
	};
	const flushQuote = () => {
		if (!quote.length) return;
		const items = quote;
		quote = [];
		nodes.push(
			<blockquote key={key++}>
				{items.map((item, index) => (
					<p key={index}>{renderRichText(item)}</p>
				))}
			</blockquote>,
		);
	};
	const flushTable = () => {
		if (!table.length) return;
		const rows = table.map((row) =>
			row
				.replace(/^\||\|$/g, "")
				.split("|")
				.map((cell) => cell.trim()),
		);
		table = [];
		const header = rows[0] ?? [];
		const aligns = (rows[1] ?? []).map(parseAlign);
		const body = rows.filter((row, index) => index > 0 && !row.every(isSeparatorCell));
		nodes.push(
			<div key={key++} className="md-table-wrap">
				<table>
					<thead>
						<tr>
							{header.map((cell, index) => (
								<th key={index} style={{ textAlign: aligns[index] }}>
									{renderRichText(cell)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{body.map((row, rIndex) => (
							<tr key={rIndex}>
								{row.map((cell, cIndex) => (
									<td key={cIndex} style={{ textAlign: aligns[cIndex] }}>
										{renderRichText(cell)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>,
		);
	};
	const flushAll = () => {
		flushList();
		flushQuote();
		flushTable();
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.replace(/\s+$/, "");

		// 程式碼塊
		const fence = /^\s*```(\S*)\s*$/.exec(line);
		if (fence) {
			flushAll();
			const lang = fence[1] ?? "";
			const body: string[] = [];
			i++;
			while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
				body.push(lines[i]!);
				i++;
			}
			nodes.push(<CodeBlock key={key++} code={body.join("\n")} lang={lang} />);
			continue;
		}

		if (!line.trim()) {
			flushAll();
			continue;
		}

		// 分隔線
		if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
			flushAll();
			nodes.push(<hr key={key++} />);
			continue;
		}

		// 標題
		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		if (heading) {
			flushAll();
			const level = Math.min(6, heading[1]?.length ?? 1);
			const content = heading[2] ?? "";
			const tags = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
			const Tag = tags[level - 1]!;
			nodes.push(<Tag key={key++}>{renderRichText(content)}</Tag>);
			continue;
		}

		// 管道表格
		if (/^\s*\|.*\|\s*$/.test(line)) {
			flushList();
			flushQuote();
			table.push(line);
			continue;
		}
		flushTable();

		// 引用
		const quoteLine = /^>\s?(.*)$/.exec(line);
		if (quoteLine) {
			flushList();
			quote.push(quoteLine[1] ?? "");
			continue;
		}
		flushQuote();

		// 列表（支援縮排巢狀與任務列表）
		const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
		const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
		if (bullet || numbered) {
			const m = (bullet ?? numbered)!;
			const indent = Math.floor((m[1] ?? "").length / 2);
			let body = m[2] ?? "";
			let task: boolean | undefined;
			let checked: boolean | undefined;
			const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(body);
			if (taskMatch) {
				task = true;
				checked = taskMatch[1]!.toLowerCase() === "x";
				body = taskMatch[2] ?? "";
			}
			const ordered = Boolean(numbered);
			if (list.length > 0 && ordered !== listOrdered) flushList();
			listOrdered = ordered;
			list.push({ text: body, indent: Math.min(indent, 3), task, checked });
			continue;
		}

		flushAll();
		nodes.push(<p key={key++}>{renderRichText(line)}</p>);
	}
	flushAll();
	return nodes;
}

/**
 * Markdown 渲染快取（NERE-75 P1-2）：長會話裡同一段文本會被反覆渲染——流式期間每個 delta
 * 都會更新訊息列表，`elapsed` 每秒還會再觸發一次渲染；不快取的話每條 assistant 訊息都要
 * 全量重解析 Markdown。按原文快取渲染結果，文本沒變就複用同一份 React 節點
 * （元素不可變，可安全地在多次渲染 / 多個位置複用）。
 */
const MARKDOWN_CACHE_LIMIT = 1000;
const markdownCache = new Map<string, ReactNode[]>();

/** 測試用：實際解析次數與命中次數。 */
export const markdownCacheStats = { parses: 0, hits: 0 };

/** 測試用：清空快取與計數。 */
export function clearMarkdownCache(): void {
	markdownCache.clear();
	resetMarkdownCacheStats();
}

/** 測試用：只重置計數，保留已快取的解析結果。 */
export function resetMarkdownCacheStats(): void {
	markdownCacheStats.parses = 0;
	markdownCacheStats.hits = 0;
}

/** 帶快取的 renderMarkdown：同一段文本只解析一次。 */
export function renderMarkdownCached(text: string): ReactNode[] {
	const cached = markdownCache.get(text);
	if (cached) {
		markdownCacheStats.hits += 1;
		return cached;
	}
	markdownCacheStats.parses += 1;
	const nodes = renderMarkdown(text);
	// 簡單 FIFO 上限：長會話 + 流式增量不會無限吃記憶體。
	if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) {
		const oldest = markdownCache.keys().next().value;
		if (oldest !== undefined) markdownCache.delete(oldest);
	}
	markdownCache.set(text, nodes);
	return nodes;
}
