import type { SessionListItem } from "../types";

export interface SessionTreeNode {
	session: SessionListItem;
	/** 0 = 頂層會話；>0 = 分支層級 */
	depth: number;
}

/**
 * 把扁平會話列表按分支關係排成樹（v0.32.0）。
 * - 父會話不存在（已刪除 / 被過濾）的分支按頂層處理
 * - 父鏈成環時也不會死迴圈：每個會話只輸出一次
 * - 同層保持輸入順序（後端按 updated_at 倒序）
 */
export function flattenSessions(sessions: SessionListItem[]): SessionTreeNode[] {
	const ids = new Set(sessions.map((s) => s.id));
	const children = new Map<string, SessionListItem[]>();
	const roots: SessionListItem[] = [];

	for (const session of sessions) {
		const parent = session.parentId && ids.has(session.parentId) && session.parentId !== session.id ? session.parentId : null;
		if (!parent) {
			roots.push(session);
			continue;
		}
		const list = children.get(parent) ?? [];
		list.push(session);
		children.set(parent, list);
	}

	const out: SessionTreeNode[] = [];
	const seen = new Set<string>();
	const walk = (session: SessionListItem, depth: number) => {
		if (seen.has(session.id)) return;
		seen.add(session.id);
		out.push({ session, depth });
		for (const child of children.get(session.id) ?? []) walk(child, depth + 1);
	};

	for (const root of roots) walk(root, 0);
	// 防禦：父鏈成環導致沒人被當作根時，剩餘項按頂層補上
	for (const session of sessions) if (!seen.has(session.id)) walk(session, 0);
	return out;
}
