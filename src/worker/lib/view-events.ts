import type { ChatWatchEvent } from "../http/ports";

/**
 * Pi 1.5 起 `watchEvents()` 移除，改由 `Conversation.watch()` 推送會話狀態（ConversationView）。
 * 這裡把相鄰兩次狀態的差異還原成舊的事件形狀，讓 chat-service 的 SSE 對映與前端協議不變。
 * 純函式 + 少量游標，不 import pi-durable（只讀結構子集）。
 */

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
type Message = { content?: unknown; details?: unknown };
type Slot = {
	callId?: string;
	name?: string;
	status?: string;
	details?: unknown;
	entry?: number;
	parentCallId?: string;
	arguments?: unknown;
};
type Live = {
	generation?: { attempt?: number; message?: { content?: unknown } };
	tools?: readonly Slot[];
	nestedTools?: readonly Slot[];
	compactions?: readonly unknown[];
};
export type ViewLike = {
	entries?: readonly { id?: number; model?: readonly Message[] }[];
	docs?: Readonly<Record<string, unknown>>;
};

function blocks(content: unknown): Block[] {
	return Array.isArray(content) ? (content.filter((b) => b && typeof b === "object") as Block[]) : [];
}

/** 從視窗內的 assistant 條目或當前生成裡找模型發出的工具呼叫引數。 */
function findArgs(view: ViewLike, live: Live, callId: string): unknown {
	for (const b of blocks(live.generation?.message?.content)) {
		if (b.type === "toolCall" && b.id === callId) return b.arguments;
	}
	const entries = view.entries ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		for (const m of entries[i]?.model ?? []) {
			for (const b of blocks(m.content)) if (b.type === "toolCall" && b.id === callId) return b.arguments;
		}
	}
	return undefined;
}

export function createViewEventTracker() {
	let genKey = "";
	/** 每個內容塊已推送的字元數（按塊索引）。 */
	let sent: number[] = [];
	let compacting = false;
	const started = new Set<string>();
	const ended = new Set<string>();
	/** 已開始未結束的呼叫（巢狀呼叫結算後其 slot 會被移除，需補 end）。 */
	const open = new Map<string, Slot>();

	return {
		/** 第一次呼叫用 watch 的初始值建立基線：已存在的內容不重放。 */
		next(view: ViewLike, baseline = false): ChatWatchEvent[] {
			const out: ChatWatchEvent[] = [];
			const live = ((view.docs ?? {})["pi.live"] ?? {}) as Live;

			// 串流文字與思考。
			const gen = live.generation;
			const content = blocks(gen?.message?.content);
			const key = gen?.message ? `a${gen.attempt ?? 0}` : "";
			if (key !== genKey) {
				genKey = key;
				sent = [];
			}
			const changes: { type: string; delta?: string }[] = [];
			content.forEach((b, i) => {
				const prev = sent[i];
				if (b.type === "text" && typeof b.text === "string") {
					if (b.text.length > (prev ?? 0)) changes.push({ type: "text_delta", delta: b.text.slice(prev ?? 0) });
					sent[i] = b.text.length;
				} else if (b.type === "thinking" && typeof b.thinking === "string") {
					if (prev === undefined) changes.push({ type: "thinking_start" });
					if (b.thinking.length > (prev ?? 0)) changes.push({ type: "thinking_delta", delta: b.thinking.slice(prev ?? 0) });
					sent[i] = b.thinking.length;
				}
			});
			if (!baseline && changes.length) out.push({ type: "message_update", changes });

			// 壓縮。
			const nowCompacting = (live.compactions?.length ?? 0) > 0;
			if (nowCompacting !== compacting) {
				compacting = nowCompacting;
				if (!baseline) out.push({ type: nowCompacting ? "compaction_start" : "compaction_end" });
			}

			// 工具：模型發出的與巢狀呼叫。
			const entries = view.entries ?? [];
			const slots: Slot[] = [...(live.tools ?? []), ...(live.nestedTools ?? [])];
			for (const s of slots) {
				const id = s.callId;
				if (!id) continue;
				if (!started.has(id)) {
					started.add(id);
					open.set(id, s);
					if (baseline && s.status === "done") ended.add(id);
					if (baseline) open.delete(id);
					if (!baseline) {
						out.push({
							type: "tool_execution_start",
							toolName: s.name,
							toolCallId: id,
							parentToolCallId: s.parentCallId,
							args: s.arguments ?? findArgs(view, live, id),
						});
					}
				}
				if (s.status === "done" && !ended.has(id)) {
					ended.add(id);
					open.delete(id);
					const entry = s.entry === undefined ? undefined : entries.find((e) => e.id === s.entry);
					if (!baseline) {
						out.push({
							type: "tool_execution_end",
							toolName: s.name,
							toolCallId: id,
							parentToolCallId: s.parentCallId,
							entry: entry ? { model: entry.model } : undefined,
							result: { details: s.details },
						});
					}
				}
			}
			const present = new Set(slots.map((s) => s.callId));
			for (const [id, s] of open) {
				if (present.has(id)) continue;
				open.delete(id);
				ended.add(id);
				if (!baseline) {
					out.push({ type: "tool_execution_end", toolName: s.name, toolCallId: id, parentToolCallId: s.parentCallId });
				}
			}
			return out;
		},
	};
}
