import { memo, useId, useState } from "react";
import type { KbRef } from "../types";

/** 參考資料按文件聚合後的一項（NERE-41）。 */
export interface KbRefDocGroup {
	docId: number;
	title: string;
	source?: string;
	/** 該文件命中的分塊數。 */
	count: number;
	/** 代表項（首個命中片段），點開文件時傳給頁面層。 */
	ref: KbRef;
}

/** 按 docId 聚合命中片段，保持首次出現順序；同文檔多個 chunk 只留一項。 */
export function groupByDoc(refs: KbRef[]): KbRefDocGroup[] {
	const groups: KbRefDocGroup[] = [];
	const index = new Map<number, KbRefDocGroup>();
	for (const ref of refs) {
		const found = index.get(ref.docId);
		if (found) {
			found.count += 1;
			continue;
		}
		const group: KbRefDocGroup = {
			docId: ref.docId,
			title: ref.title,
			...(ref.source ? { source: ref.source } : {}),
			count: 1,
			ref,
		};
		index.set(ref.docId, group);
		groups.push(group);
	}
	return groups;
}

/**
 * assistant 回覆下方的「參考資料」條（NERE-41）：純展示，資料只從 props 來。
 * 預設收起成一行；沒有引用時什麼都不渲染。
 */
export const KbRefsBar = memo(function KbRefsBar({
	refs,
	onOpen,
}: {
	refs: KbRef[];
	/** 點選某一篇：由頁面層切到知識庫並開啟原文。預設時只展示不可點。 */
	onOpen?: (ref: KbRef) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const listId = useId();
	if (!refs || refs.length === 0) return null;
	const docs = groupByDoc(refs);
	return (
		<div className="w-full rounded-xl border border-slate-800/70 bg-slate-900/40 px-2.5 py-1.5">
			<button
				type="button"
				onClick={() => setExpanded((value) => !value)}
				aria-expanded={expanded}
				aria-controls={listId}
				className="flex w-full items-center gap-1.5 rounded text-left text-[11.5px] text-slate-400 transition-colors hover:text-slate-200"
			>
				<span className="font-medium">參考資料：{docs.length} 篇</span>
				<span aria-hidden className="text-[10px] text-slate-500">{expanded ? "▾" : "▸"}</span>
			</button>
			{expanded && (
				<ul id={listId} className="mt-1 space-y-0.5">
					{docs.map((doc) => {
						const label = `${doc.title}${doc.count > 1 ? ` · ${doc.count} 段` : ""}`;
						const body = (
							<>
								<span className="block truncate" title={doc.title}>{label}</span>
								{doc.source && (
									<span className="block truncate text-[10.5px] text-slate-500" title={doc.source}>
										{doc.source}
									</span>
								)}
							</>
						);
						return (
							<li key={doc.docId}>
								{onOpen ? (
									<button
										type="button"
										onClick={() => onOpen(doc.ref)}
										className="block w-full rounded px-1.5 py-1 text-left text-[12px] text-sky-300 transition-colors hover:bg-slate-800 hover:text-sky-200"
									>
										{body}
									</button>
								) : (
									<div className="block px-1.5 py-1 text-[12px] text-slate-300">{body}</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
});
