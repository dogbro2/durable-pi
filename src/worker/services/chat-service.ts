import type { SqlHandle } from "../db/migrations";
import { AppError } from "../http/errors";
import type {
	ChatEntry,
	ChatHandle,
	ChatRuntime,
	ChatSettled,
	ChatToolSummary,
	ChatWatchEvent,
} from "../http/ports";
import type { KbRef } from "../lib/kb";
import { upsert as upsertEntryKbRefs } from "../repo/entry-kb-refs-repo";
import * as reflectRepo from "../repo/reflect-repo";
import * as sessionsRepo from "../repo/sessions-repo";
import {
	GOAL_ROUNDS_PER_REQUEST,
	goalContinuePrompt,
	goalInfo,
	readGoal,
	writeGoal,
	type GoalRow,
	type GoalStatus,
} from "./goal-service";
import { readPending as readPendingQuestion } from "./question-service";

/**
 * 對話域用例（ADR-0001 §2 / architecture-map R11，NERE-33）。
 *
 * `POST /chat` 與 `POST /chat/stream` 共用同一條提交路徑：
 *   prepare（技能解析 → instructions → configure → beforeId）
 *   → submit（submit → wait → commit → kbRefs）
 *   → finish（標題 → 工具摘要）；流式只額外負責把 Harness 事件泵成 SSE。
 *
 * Harness 的 open/重試/coversation/擴充套件裝配留在 DO 組合根（`ChatRuntime`）；
 * 目標續轉、併發閘門、reflection 節流與標題策略在這裡，保證兩條路徑不再各寫一份。
 */

/** SSE 事件：名稱與 data 形狀與舊 `runChatStream` 逐字一致。 */
export type ChatEvent =
	| { type: "thinking_start"; data: Record<string, never> }
	| { type: "thinking"; data: { delta: string } }
	| { type: "text"; data: { delta: string } }
	| { type: "compaction"; data: { status: "start" | "end" } }
	| { type: "tool_start"; data: { name: string; id?: string; parentId?: string; args?: unknown } }
	| {
			type: "tool_end";
			data: {
				name: string;
				id?: string;
				parentId?: string;
				summary?: string;
				details?: unknown;
			};
	  }
	| { type: "goal"; data: Record<string, unknown> }
	| { type: "error"; data: { message: string } }
	| {
			type: "done";
			data: { answer: string; tools: ChatToolSummary[]; kbRefs?: readonly KbRef[] };
	  };

export type ChatInput = { message: string; sessionId?: string; images?: string[] };

export type PreparedChat = {
	root: ChatHandle;
	/** 實際會話 id（預設時為根會話）。 */
	sessionId: string;
	input: ChatInput;
	effectiveMessage: string;
	kbRefs: readonly KbRef[];
	beforeId: number;
};

/** 單輪結果：`ok:false` 保留舊實現的兩種錯誤文案所需原始 JSON。 */
export type SubmitOutcome =
	| { ok: true; answer: string; entry: ChatEntry | null }
	| { ok: false; reason: string; raw: string };

export type ChatServiceDeps = { sql: SqlHandle; runtime: ChatRuntime };

export interface ChatService {
	/** 技能解析 → instructions → configure → beforeId；進入併發閘門。 */
	prepare(input: ChatInput): Promise<PreparedChat>;
	/** 一輪：submit → wait → commit（AssistantEntry）→ 記錄 kbRefs。 */
	submit(prepared: PreparedChat, input: { message: string; images?: string[] }): Promise<SubmitOutcome>;
	/** 標題與工具摘要；返回時順帶給出最近條目 id（reflection 用）。 */
	finish(prepared: PreparedChat): Promise<{ tools: ChatToolSummary[]; lastId: number }>;
	/** 非流式完整流程；異常時按舊行為重建 Harness 後丟擲。 */
	chat(input: ChatInput): Promise<{ answer: string; tools: ChatToolSummary[] }>;
	/** 流式：呼叫方傳入已 prepared 的會話與 SSE emit。 */
	stream(prepared: PreparedChat, emit: (event: ChatEvent) => Promise<void>): Promise<void>;
	maybeReflect(root: ChatHandle, uptoId: number): Promise<number>;
	goalTick(sessionId: string): Promise<void>;
	interject(message: string, sessionId?: string): Promise<{ ok: true; id: string }>;
	abort(sessionId?: string): Promise<{ ok: true }>;
	reset(sessionId?: string): Promise<{ ok: true }>;
	compact(sessionId?: string, instructions?: string): Promise<{ ok: true; taskId: string }>;
	/** alarm 用：該會話是否正在跑對話（原 `activeChats.has`）。 */
	hasActive(sessionId?: string): boolean;
}

const SESSION_ERROR = /SessionFailed|storage error/i;
const DEFAULT_TITLE = "新會話";
/** 根會話在 list() 掃描補建時的標題（session-service）。 */
const ROOT_DEFAULT_TITLE = "預設會話";
const GENERATED_TITLE = /^會話 \d+$/;

/** 可被首輪標題取代的預設標題：新建會話、根會話與掃描補建的編號標題。 */
function isDefaultTitle(title: string): boolean {
	return title === DEFAULT_TITLE || title === ROOT_DEFAULT_TITLE || GENERATED_TITLE.test(title);
}

/** assistant entry 的可見文本：字串 content 或文本塊陣列。 */
function answerText(entry: ChatEntry | null): string {
	const model: unknown = entry?.model;
	if (!Array.isArray(model)) return "";
	const first: unknown = model[0];
	if (!first || typeof first !== "object" || !("content" in first)) return "";
	const content = first.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => {
			return Boolean(b) && typeof b === "object" && "type" in b && b.type === "text" && "text" in b && typeof b.text === "string";
		})
		.map((b) => b.text)
		.join("");
}

/** 本輪工具活動：只取 `beforeId` 之後新增的 `pi.tool-result`，最多 6 條。 */
function toolSummary(items: readonly ChatEntry[], beforeId: number): ChatToolSummary[] {
	const tools: ChatToolSummary[] = [];
	for (const entry of items) {
		if (entry.kind !== "pi.tool-result") continue;
		if (Number(entry.id ?? 0) <= beforeId) continue;
		const model: unknown = entry.model;
		if (!Array.isArray(model)) continue;
		const first: unknown = model[0];
		if (!first || typeof first !== "object") continue;
		const name = "toolName" in first && typeof first.toolName === "string" ? first.toolName : "tool";
		const content = "content" in first && Array.isArray(first.content) ? first.content : [];
		const text = content
			.map((b) => (b && typeof b === "object" && "text" in b && typeof b.text === "string" ? b.text : ""))
			.join("");
		tools.push({ name, summary: text.slice(0, 80) });
	}
	return tools.slice(-6);
}

export function createChatService({ sql, runtime }: ChatServiceDeps): ChatService {
	const gate = runtime.gate;

	function maybeRecover(err: unknown): void {
		if (!SESSION_ERROR.test(String(err))) return;
		// 與原 chat()/chatStream() 包裝一致：重建 Harness 但不重試本輪。
		void runtime.recover();
	}

	/** 標題策略（v0.22.0）：首輪取 effectiveMessage 前 24 字，之後只重新整理時間；使用者自訂標題不覆寫。 */
	function updateTitle(conversationId: string, effectiveMessage: string): void {
		try {
			const now = new Date().toISOString();
			const existing = sessionsRepo.get(sql, conversationId)?.title;
			if (!existing || isDefaultTitle(existing)) {
				const title = effectiveMessage.slice(0, 24);
				if (title.trim()) sessionsRepo.upsertTitle(sql, conversationId, title, now);
				else sessionsRepo.touchUpdatedAt(sql, conversationId, now);
			} else {
				sessionsRepo.touchUpdatedAt(sql, conversationId, now);
			}
		} catch (err) {
			console.warn("session meta update failed", err);
		}
	}

	/** 每輪結束後把會話累計 token 折算成目標消耗（原 DO 的 syncGoalProgress）。 */
	async function syncGoalProgress(handle: ChatHandle, sessionId: string, incrementTurn: boolean): Promise<GoalRow | null> {
		const row = readGoal(sql, sessionId);
		if (!row) return null;
		const total = await runtime.usageTokens(handle);
		// baseline = -1 表示目標由模型在對話中途建立：第一次同步以當前累計值為起點，不計之前的花費。
		const baseline = row.baseline_tokens < 0 ? total : row.baseline_tokens;
		const used = total > 0 ? Math.max(0, total - baseline) : row.tokens_used;
		const turns = row.turns + (incrementTurn ? 1 : 0);
		if (row.status !== "active") {
			// 已經結束的目標只補記本輪消耗，不再改變狀態。
			writeGoal(sql, sessionId, { baseline_tokens: baseline, tokens_used: used, turns });
			return { ...row, baseline_tokens: baseline, tokens_used: used, turns };
		}
		let status: GoalStatus = row.status;
		if (used >= row.token_budget || turns >= row.max_turns) status = "exhausted";
		const nextRunAt = status === "active" ? row.next_run_at : 0;
		writeGoal(sql, sessionId, { baseline_tokens: baseline, tokens_used: used, turns, status, next_run_at: nextRunAt });
		return { ...row, baseline_tokens: baseline, tokens_used: used, turns, status, next_run_at: nextRunAt };
	}

	async function submit(
		prepared: PreparedChat,
		input: { message: string; images?: string[] },
	): Promise<SubmitOutcome> {
		const submission = await runtime.submit(prepared.root, input);
		const settled: ChatSettled = await runtime.wait(submission);
		if (settled.status !== "done" || settled.type !== "input") {
			const raw = JSON.stringify(settled).slice(0, 300);
			return { ok: false, reason: `執行未完成：${JSON.stringify(settled).slice(0, 200)}`, raw };
		}
		const entry = await runtime.commit(prepared.root, settled.answer);
		// 目標續轉不重算 instructions：同一請求裡的每一輪都記同一份 kbRefs（NERE-40/41）。
		if (entry && prepared.kbRefs.length) {
			const entryId = Number(entry.id ?? 0);
			if (Number.isFinite(entryId) && entryId > 0) {
				upsertEntryKbRefs(sql, prepared.sessionId, entryId, prepared.kbRefs, new Date().toISOString());
			}
		}
		return { ok: true, answer: answerText(entry), entry };
	}

	async function finish(prepared: PreparedChat): Promise<{ tools: ChatToolSummary[]; lastId: number }> {
		updateTitle(prepared.sessionId, prepared.effectiveMessage);
		const page = await runtime.entries(prepared.root, { limit: 60 });
		const lastId = Number(page[0]?.id ?? 0);
		return { tools: toolSummary(page, prepared.beforeId), lastId };
	}

	/** watchEvents → SSE 事件對映（事件名與順序與階段 4 之前一致）。 */
	async function pumpEvents(events: readonly ChatWatchEvent[], emit: (event: ChatEvent) => Promise<void>): Promise<void> {
		for (const e of events) {
			if (e.type === "message_update") {
				for (const change of e.changes ?? []) {
					// 思考過程（v0.22.0）：模型開 reasoning 時逐字推送。
					if (change.type === "thinking_delta" && change.delta) await emit({ type: "thinking", data: { delta: change.delta } });
					else if (change.type === "thinking_start") await emit({ type: "thinking_start", data: {} });
					else if (change.type === "text_delta" && change.delta) await emit({ type: "text", data: { delta: change.delta } });
				}
			} else if (e.type === "compaction_start") {
				await emit({ type: "compaction", data: { status: "start" } });
			} else if (e.type === "compaction_end") {
				await emit({ type: "compaction", data: { status: "end" } });
			} else if (e.type === "tool_execution_start") {
				await emit({
					type: "tool_start",
					data: {
						name: e.toolName ?? "tool",
						id: e.toolCallId,
						parentId: e.parentToolCallId,
						args: e.args,
					},
				});
			} else if (e.type === "tool_execution_end") {
				const message = e.entry?.model?.[0];
				let summary: string | undefined;
				if (message && Array.isArray(message.content)) {
					summary =
						message.content
							.filter((b): b is { type: "text"; text: string } => {
								return Boolean(b) && typeof b === "object" && "type" in b && b.type === "text" && "text" in b && typeof b.text === "string";
							})
							.map((b) => b.text)
							.join("")
							.trim() || undefined;
				}
				await emit({
					type: "tool_end",
					data: {
						name: e.toolName ?? "tool",
						id: e.toolCallId,
						parentId: e.parentToolCallId,
						summary,
						details: e.result?.details ?? message?.details,
					},
				});
			}
		}
	}

	/** 閘門由呼叫方持有；這裡只做 prepare 本身。 */
	async function prepareInner(input: ChatInput): Promise<PreparedChat> {
		const root = await runtime.conversation(input.sessionId);
		// 顯式技能呼叫（v0.23.0）：`/技能名` 命中後把技能正文注入本輪 instructions。
		const inv = runtime.skillInvocation(input.message);
		const effectiveMessage = inv ? inv.rest || `請按技能「${inv.name}」執行。` : input.message;
		// 會話首次建立後 agent 選擇會固化在 pi.agent 文件裡；冪等重設，保證新擴充套件開關對老會話也生效。
		const turn = await runtime.instructions({ inv, sessionId: input.sessionId, message: effectiveMessage });
		await runtime.configure(root, { sessionId: input.sessionId, instructions: turn.instructions });
		const tools = await runtime.toolNames(root);
		console.debug("CHAT_TOOLS", tools.length);
		// 記錄本輪起點：之後只把新增條目裡的工具結果算作本輪工具活動。
		const beforeId = await runtime.lastEntryId(root);
		return {
			root,
			sessionId: String(root.id),
			input,
			effectiveMessage,
			kbRefs: turn.kbRefs,
			beforeId,
		};
	}

	/** 呼叫方已持有閘門的一輪完整提交（`/chat` 與 goalTick 共用）。 */
	async function runChat(input: ChatInput): Promise<{ answer: string; tools: ChatToolSummary[] }> {
		const prepared = await prepareInner(input);
		const outcome = await submit(prepared, { message: input.message, images: input.images });
		if (!outcome.ok) throw new Error(`run failed: ${outcome.raw}`);
		const final = await finish(prepared);
		// 與原 runChat 一致：反思在後臺跑，不阻塞本輪返回。
		runtime.waitUntil(service.maybeReflect(prepared.root, final.lastId));
		return { answer: outcome.answer || "(empty)", tools: final.tools };
	}

	const service: ChatService = {
		async prepare(input) {
			const key = input.sessionId || "1";
			if (!gate.tryEnter(key)) throw new AppError("chat_busy", 409, "該會話已有正在進行的對話，請等待完成或先中止。", true);
			try {
				return await prepareInner(input);
			} catch (err) {
				gate.exit(key);
				// 舊 chatStream 包裝會在 prepare 階段重建 Harness；保持同樣的錯誤恢復語義。
				if (SESSION_ERROR.test(String(err))) await runtime.recover();
				throw err;
			}
		},

		submit,

		finish,

		async chat(input) {
			const key = input.sessionId || "1";
			if (!gate.tryEnter(key)) throw new AppError("chat_busy", 409, "該會話已有正在進行的對話，請等待完成或先中止。", true);
			try {
				return await runChat(input);
			} catch (err) {
				maybeRecover(err);
				throw err;
			} finally {
				gate.exit(key);
			}
		},

		async stream(prepared, emit) {
			const key = prepared.input.sessionId || "1";
			try {
				const watch = await runtime.watch(prepared.root, (events) => pumpEvents(events, emit));
				try {
					let answer = "";
					let prompt = prepared.input.message;
					let images = prepared.input.images;
					let round = 0;
					// 目標模式（v0.31.0）：一輪結束且目標仍在進行時自動續轉，最多 3 輪/請求，其餘交給 alarm。
					for (;;) {
						const outcome = await submit(prepared, { message: prompt, images });
						if (!outcome.ok) {
							await emit({ type: "error", data: { message: outcome.reason } });
							break;
						}
						answer = outcome.answer;
						round++;
						const goal = readGoal(sql, prepared.sessionId);
						if (!goal) break;
						const updated = await syncGoalProgress(prepared.root, prepared.sessionId, true);
						if (!updated) break;
						if (updated.status !== "active") {
							await emit({ type: "goal", data: { goal: goalInfo(updated), finished: true } });
							break;
						}
						// 有待回答的問題：暫停自動續轉，等使用者答完再說（v0.37.0）。
						const pendingQuestion = readPendingQuestion(sql, prepared.sessionId);
						if (pendingQuestion) {
							writeGoal(sql, prepared.sessionId, { next_run_at: 0 });
							await emit({
								type: "goal",
								data: { goal: goalInfo(updated), paused: true, questionId: pendingQuestion.id },
							});
							break;
						}
						if (round >= GOAL_ROUNDS_PER_REQUEST) {
							writeGoal(sql, prepared.sessionId, { next_run_at: Date.now() + 15_000 });
							await runtime.scheduleAlarm();
							await emit({
								type: "goal",
								data: { goal: goalInfo(readGoal(sql, prepared.sessionId)), scheduled: true },
							});
							break;
						}
						await emit({ type: "goal", data: { goal: goalInfo(updated), continuing: true, round } });
						prompt = goalContinuePrompt(updated);
						images = undefined;
					}
					const final = await finish(prepared);
					// kbRefs 與 entry 同一份：命中才帶欄位，未命中保持舊事件形狀（NERE-40/41）。
					await emit({
						type: "done",
						data: {
							answer,
							tools: final.tools,
							...(prepared.kbRefs.length ? { kbRefs: prepared.kbRefs } : {}),
						},
					});
					runtime.waitUntil(service.maybeReflect(prepared.root, final.lastId));
				} catch (err) {
					await emit({ type: "error", data: { message: String(err).slice(0, 300) } });
				} finally {
					await watch.stop().catch(() => {});
				}
			} catch (err) {
				maybeRecover(err);
				await emit({ type: "error", data: { message: String(err).slice(0, 300) } });
			} finally {
				gate.exit(key);
			}
		},

		async maybeReflect(root, uptoId) {
			try {
				const conversationId = String(root.id);
				const since = reflectRepo.getLastEntryId(sql, conversationId);
				if (uptoId - since < 6) return 0;
				const page = await runtime.entries(root, { limit: 40, order: "descending" });
				const lines: string[] = [];
				for (const entry of [...page].reverse()) {
					const kind = String(entry.kind ?? "");
					const text = JSON.stringify(entry.model ?? entry.data ?? "").slice(0, 800);
					if (kind === "pi.user") lines.push(`使用者：${text}`);
					else if (kind === "pi.assistant") lines.push(`助手：${text}`);
				}
				const saved = await runtime.reflect(conversationId, lines.join("\n"));
				reflectRepo.setLastEntryId(sql, conversationId, uptoId, new Date().toISOString());
				return saved;
			} catch (err) {
				console.warn("maybeReflect skipped", err);
				return 0;
			}
		},

		async goalTick(sessionId) {
			const row = readGoal(sql, sessionId);
			if (!row || row.status !== "active") return;
			// 使用者還沒回答問題：暫停續轉（v0.37.0）。
			if (readPendingQuestion(sql, sessionId)) {
				writeGoal(sql, sessionId, { next_run_at: 0 });
				return;
			}
			writeGoal(sql, sessionId, { next_run_at: 0 });
			// 已有對話在跑就不搶：alarm 下一輪再看（閘門現在會拒絕，而不是覆蓋）。
			if (!gate.tryEnter(sessionId)) return;
			try {
				const conversation = await runtime.conversation(sessionId);
				await runChat({ message: goalContinuePrompt(row), sessionId });
				const updated = await syncGoalProgress(conversation, sessionId, true);
				if (updated?.status === "active") {
					writeGoal(sql, sessionId, { next_run_at: Date.now() + 15_000 });
				}
			} finally {
				gate.exit(sessionId);
			}
		},

		async interject(message, sessionId) {
			const text = message.trim();
			if (!text) throw new Error("插話內容不能為空");
			const handle = await runtime.conversation(sessionId);
			const submission = await runtime.submit(handle, { message: text, whenBusy: "steer" });
			return { ok: true, id: submission.id };
		},

		async abort(sessionId) {
			const handle = await runtime.conversation(sessionId);
			await runtime.abort(handle);
			return { ok: true };
		},

		async reset(sessionId) {
			const handle = await runtime.conversation(sessionId);
			await runtime.reset(handle);
			if (sessionId) sessionsRepo.rename(sql, sessionId, DEFAULT_TITLE, new Date().toISOString());
			return { ok: true };
		},

		async compact(sessionId, instructions) {
			const handle = await runtime.conversation(sessionId);
			const taskId = await runtime.compact(handle, instructions);
			return { ok: true, taskId };
		},

		hasActive(sessionId) {
			return gate.has(sessionId || "1");
		},
	};

	return service;
}
