import type { ChatMessage, KbRef, ShareLink, ToolCallInfo } from "../types";

/** 工具活動條摘要的最大長度（字）。 */
export const TOOL_SUMMARY_MAX = 60;

/** 壓縮空白並把字串截斷到 max 字（超出加省略號）。 */
export function truncateOneLine(text: string, max: number): string {
	const s = text.replace(/\s+/g, " ").trim();
	return s.length > max ? s.slice(0, Math.max(1, max - 1)) + "…" : s;
}

/**
 * 寬容提取任意條目裡的文本：
 * - string 原樣返回
 * - 陣列：遞迴拼接各部分（pi 的 content 常是 [{type:"text",text:"..."}]）
 * - 物件：優先 text / content / output / result 欄位
 */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.filter((part) => !(part && typeof part === "object" && (part as { type?: unknown }).type === "image"))
			.map((part) => textOf(part))
			.join("");
	}
	if (value !== null && typeof value === "object") {
		const o = value as Record<string, unknown>;
		for (const key of ["text", "content", "output", "result", "summary", "message"]) {
			if (o[key] !== undefined && o[key] !== null) return textOf(o[key]);
		}
	}
	return "";
}

/** 從條目內容塊裡收集圖片，轉成可直接渲染的 data URL。 */
function imagesOf(value: unknown): string[] {
	const found: string[] = [];
	const walk = (node: unknown) => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (!node || typeof node !== "object") return;
		const o = node as Record<string, unknown>;
		if (o.type === "image" && typeof o.data === "string") {
			found.push(`data:${typeof o.mimeType === "string" ? o.mimeType : "image/png"};base64,${o.data}`);
			return;
		}
		for (const key of ["content", "model", "message", "parts"]) {
			if (o[key] !== undefined) walk(o[key]);
		}
	};
	walk(value);
	return found;
}

/** 從條目內容塊裡收集思考過程（v0.22.0）：pi-ai 的 {type:"thinking", thinking:"..."}。 */
function thinkingOf(value: unknown): string {
	const parts: string[] = [];
	const walk = (node: unknown) => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (!node || typeof node !== "object") return;
		const o = node as Record<string, unknown>;
		if (o.type === "thinking" && typeof o.thinking === "string") {
			parts.push(o.thinking);
			return;
		}
		for (const key of ["content", "model", "message", "parts"]) {
			if (o[key] !== undefined) walk(o[key]);
		}
	};
	walk(value);
	return parts.join("");
}

/** 從 write_file 的工具結果文本里提取產出檔名與大小（v0.22.0）。 */
function artifactsOf(toolName: string, text: string): { name: string; size?: number }[] {
	if (toolName !== "write_file") return [];
	const m = /已寫入\s+(.+?)（(\d+)\s*字元）/.exec(text);
	if (!m) return [];
	const size = Number(m[2]);
	return [{ name: m[1]!.trim(), ...(Number.isFinite(size) ? { size } : {}) }];
}

/** 從 share_file / share_conversation 的 details（優先）或結果文本里提取連結卡資料（v0.55.0）。 */
function shareOf(toolName: string, details: unknown, text: string): ShareLink | null {
	if (toolName !== "share_file" && toolName !== "share_conversation") return null;
	if (details && typeof details === "object" && "share" in details) {
		const share = details.share;
		if (share && typeof share === "object" && "url" in share && typeof share.url === "string") {
			const kind = "kind" in share && share.kind === "conversation" ? "conversation" : "file";
			const name = "name" in share && typeof share.name === "string" ? share.name : "";
			return {
				url: share.url,
				title: name || (kind === "conversation" ? "對話分享" : "檔案分享"),
				kind,
				expiresAt: "expiresAt" in share && typeof share.expiresAt === "number" ? share.expiresAt : 0,
				createdAt: "createdAt" in share && typeof share.createdAt === "string" ? share.createdAt : undefined,
				reused: "reused" in share && share.reused === true,
			};
		}
	}
	// 舊記錄/裁剪後的詳情：退回從「分享連結：<url>」裡取
	const m = /分享連結：([^\s（）]+)/.exec(text);
	if (!m) return null;
	const kind = toolName === "share_conversation" ? "conversation" : "file";
	return {
		url: m[1]!,
		title: kind === "conversation" ? "對話分享" : "檔案分享",
		kind,
		expiresAt: 0,
	};
}

function pickString(o: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const v = o[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return "";
}

/**
 * 判斷條目是否按 id 倒序（後端 /api/entries 的返回順序）。
 * 只看首尾兩個帶數字 id 的條目，缺失/相等時按正序處理。
 */
function isDescending(list: unknown[]): boolean {
	const ids: number[] = [];
	for (const item of list) {
		if (item && typeof item === "object") {
			const id = (item as { id?: unknown }).id;
			if (typeof id === "number" && Number.isFinite(id)) ids.push(id);
		}
		if (ids.length >= 2) break;
	}
	if (ids.length < 2) return false;
	// 取最後一個 id 對比（列表可能有尾部空項）
	for (let i = list.length - 1; i >= 0; i--) {
		const item = list[i];
		if (!item || typeof item !== "object") continue;
		const id = (item as { id?: unknown }).id;
		if (typeof id === "number" && Number.isFinite(id)) return ids[0]! > id;
	}
	return false;
}

/**
 * 寬容解析 entry.kbRefs：預設/非陣列 → []；丟棄 docId 非法的項；
 * 按 docId:chunkId 去重並保持原序（NERE-40 / NERE-41）。
 */
export function parseKbRefs(value: unknown): KbRef[] {
	if (!Array.isArray(value)) return [];
	const refs: KbRef[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		if (typeof o.docId !== "number" || !Number.isFinite(o.docId)) continue;
		const chunkId = typeof o.chunkId === "number" && Number.isFinite(o.chunkId) ? o.chunkId : 0;
		const key = `${o.docId}:${chunkId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const source = pickString(o, ["source"]);
		refs.push({
			docId: o.docId,
			chunkId,
			chunkSeq: typeof o.chunkSeq === "number" && Number.isFinite(o.chunkSeq) ? o.chunkSeq : 0,
			title: pickString(o, ["title"]) || "未命名文件",
			...(source ? { source } : {}),
		});
	}
	return refs;
}

/**
 * 把 GET /api/entries 的歷史條目寬容解析為訊息列表。
 * - user：取 content 文本 → 右側氣泡
 * - assistant：取文本 → 左側氣泡；此前累積的 tool-result 作為其上方的工具活動條
 * - tool-result：顯示為一行摘要（🔧 名稱 · 摘要，截斷 60 字）
 * - 未知 kind：跳過
 */
export function parseEntries(entries: unknown): ChatMessage[] {
	const raw = Array.isArray(entries) ? entries : [];
	// 後端按 id 倒序返回（新→舊），聊天要按時間正序顯示；順帶修正工具結果歸屬。
	const list = isDescending(raw) ? [...raw].reverse() : raw;
	const messages: ChatMessage[] = [];
	let pendingTools: ToolCallInfo[] = [];
	/** 待掛到下一條助手訊息的檔案產出。 */
	let pendingFiles: { name: string; size?: number }[] = [];
	/** 待掛到下一條助手訊息的分享連結。 */
	let pendingShares: ShareLink[] = [];
	let seq = 0;

	const flushStandaloneTools = () => {
		if (pendingTools.length === 0) return;
		messages.push({ id: `t${seq++}`, role: "tool", tools: pendingTools });
		pendingTools = [];
	};

	for (const raw of list) {
		if (raw === null || typeof raw !== "object") continue;
		const entry = raw as Record<string, unknown>;
		// 後端條目 kind 形如 pi.user / pi.assistant / pi.tool-result，這裡統一去掉字首。
		const kind = pickString(entry, ["kind", "type"]).replace(/^pi\./, "");

		if (kind === "user") {
			const body = entry.model ?? entry.content ?? entry.text;
			const text = textOf(body).trim();
			const images = imagesOf(body);
			if (!text && images.length === 0) continue;
			flushStandaloneTools();
			const entryId = typeof entry.id === "number" ? entry.id : undefined;
			messages.push({
				id: `u${seq++}`,
				role: "user",
				text: text || "（圖片）",
				...(images.length ? { images } : {}),
				// 分支（v0.32.0）：保留真實條目 id，供「從這裡分支」使用
				...(entryId !== undefined ? { entryId } : {}),
			});
		} else if (kind === "assistant") {
			const text = textOf(entry.model ?? entry.content ?? entry.text).trim();
			const thinking = thinkingOf(entry.model ?? entry.content ?? entry.text).trim();
			const tools = pendingTools;
			pendingTools = [];
			if (!text && tools.length === 0 && !thinking) continue;
			const files = pendingFiles;
			pendingFiles = [];
			const shares = pendingShares;
			pendingShares = [];
			const kbRefs = parseKbRefs(entry.kbRefs);
			messages.push({
				id: `a${seq++}`,
				role: "assistant",
				text,
				tools: tools.length ? tools : undefined,
				thinking: thinking || undefined,
				files: files.length ? files : undefined,
				shares: shares.length ? shares : undefined,
				...(kbRefs.length ? { kbRefs } : {}),
			});
		} else if (kind === "compaction") {
			// pi.compaction：早期對話被摘要成一條記錄（v0.31.0），聊天裡顯示為一條系統提示
			flushStandaloneTools();
			messages.push({ id: `c${seq++}`, role: "notice", text: "上下文已壓縮：更早的對話被摘要為一條記錄，最近的內容保持原文。" });
		} else if (kind === "tool-result" || kind === "tool_result" || kind === "toolResult") {
			// 後端把工具結果放在 model[0]：{ toolName, content: [{type:"text",text}] }
			const firstModel = Array.isArray(entry.model) ? (entry.model[0] as Record<string, unknown> | undefined) : undefined;
			const name =
				pickString(entry, ["name", "toolName", "tool", "tool_name"]) ||
				(firstModel ? pickString(firstModel, ["toolName", "name"]) : "") ||
				"工具";
			const rawSummary = textOf(
				entry.summary ??
					entry.output ??
					entry.content ??
					entry.result ??
					entry.text ??
					firstModel?.content ??
					firstModel?.output,
			);
			const failed = entry.isError === true || entry.is_error === true || entry.error === true;
			const prefix = failed ? "失敗：" : "";
			const summary = truncateOneLine(rawSummary, TOOL_SUMMARY_MAX);
			// dispatch_tasks：歷史回放時沒有 args，從結果首部的「1. 標題 — 完成 · 2.8s」反解子任務
			let args: unknown;
			if (name === "dispatch_tasks") {
				const titles = [...rawSummary.matchAll(/^\d+\.\s+(.+?)\s+—\s+/gm)].map((m) => ({ title: m[1] ?? "" }));
				if (titles.length) args = { tasks: titles };
			}
			// Keep the untruncated original so the pill can expand to the full output
			pendingTools.push({ name, summary: prefix + summary, full: prefix + rawSummary, ...(args ? { args } : {}) });
			// 檔案產出：留到下一條助手訊息一起渲染（v0.25.2 修正歸屬）
			pendingFiles.push(...artifactsOf(name, rawSummary));
			// 分享連結：details 優先，缺 details 時從文本取（v0.55.0）
			const details = firstModel?.details;
			const share = shareOf(name, details, rawSummary);
			if (share) pendingShares.push(share);
		}
		// 其他 kind：寬容跳過
	}
	flushStandaloneTools();
	return messages;
}
