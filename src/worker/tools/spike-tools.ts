import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
import type { SqlHandle } from "../db/migrations";
import type { SettingsPort } from "../http/ports";
import { withApproval, type ToolGateDeps } from "../services/approval-service";
import type { FileService } from "../services/file-service";
import {
	GOAL_MAX_TURNS_DEFAULT,
	GOAL_TOKEN_BUDGET_DEFAULT,
	readGoal,
	startGoal,
	writeGoal,
} from "../services/goal-service";
import type { KbService, WebFetchResult } from "../services/kb-service";
import { normalizeSkillUrl } from "../lib/skill-import";
import { readPlan, savePlan } from "../services/plan-service";
import { record as recordQuestion, type AskItem, type AskOption } from "../services/question-service";
import type { ShareService } from "../services/share-service";
import { createSkillService, SkillApiError, trackSkillCall } from "../services/skill-service";
import { activeModelIds, effectiveProviderId } from "../services/settings-service";
import * as memoryRepo from "../repo/memory-repo";
import * as sessionsRepo from "../repo/sessions-repo";
import * as skillsRepo from "../repo/skills-repo";
import { shareExpiryLabel } from "../lib/share-render";

/**
 * 模型工具擴充套件（ADR-0001 §5.5）：只依賴顯式注入的 Service / Repository。
 *
 * 這裡沒有隱式儲存代理，也不讀請求作用域：SQL、設定、檔案/KB/分享服務與 Harness
 * 都由 DO 組合根按請求構造後傳入。擴充套件按請求建立，`share_file` 的 Origin / userKey
 * 因此不需要隱式作用域也能拿到當前請求的值。
 */
export type HarnessLike = {
	createConversation(
		options: unknown,
		context: unknown,
	): Promise<{
		id: unknown;
		submit(input: unknown, context: unknown): Promise<{ wait(context: unknown): Promise<{ status: string; type?: string; answer?: unknown }> }>;
		entries(
			query: object,
			limit: number,
			cursor: undefined,
			context: unknown,
		): Promise<{ items: readonly unknown[] }>;
	}>;
	conversation(
		id: unknown,
		context: unknown,
	): Promise<{ agent(context: unknown): Promise<{ model?: { provider: string; modelId: string } }> } | null>;
};

export type SpikeToolDeps = {
	sql: SqlHandle;
	settings: SettingsPort;
	files: FileService;
	kb: KbService;
	shares: ShareService;
	/** 當前 DO 的 Harness；open() 之前或不可用時返回 null。 */
	harness(): HarnessLike | null;
	/** 搜尋 / 抓取 / 反思共用的工具箱端點（UI 設定；空值表示未配置）。 */
	toolbox: { baseUrl: string; apiKey: string; model: string };
	webFetch(url: string): Promise<WebFetchResult>;
};

export type AgentExtensions = {
	spike: { name: string; tools?: { name: string }[] };
	codemode: { name: string; tools?: { name: string }[] };
	toolSearch: { name: string; tools?: { name: string }[] };
};

const stripHtml = (html: string) =>
	html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 6000);

/** 當前請求的 Harness 上下文（pi-durable 的 BACKGROUND_CONTEXT）。 */
const harnessContext = BACKGROUND_CONTEXT;

export function createAgentExtensions(deps: SpikeToolDeps): AgentExtensions {
	const { sql, settings, files, kb, shares } = deps;
	const gate: ToolGateDeps = { sql: () => sql, get: settings.get };
	const now = () => new Date().toISOString();

	const base = defineExtension({
		name: "spike",
		tools: [
			defineTool({
				name: "now",
				description: "獲取當前伺服器時間（UTC）",
				parameters: Type.Object({}),
				execute: async () => ({ output: [{ type: "text", text: "伺服器當前時間：" + new Date().toISOString() }] }),
			}),
			defineTool({
				name: "remember",
				description: "把一條需要長期記住的事實/偏好儲存到記憶庫（使用者明確說「記住…」時呼叫）",
				parameters: Type.Object({ content: Type.String({ description: "要記住的事實，一句話" }) }),
				execute: async (args) => {
					const content = String((args as { content?: unknown }).content ?? "").trim();
					if (!content) return { output: [{ type: "text", text: "內容為空，未儲存。" }] };
					memoryRepo.insert(sql, content, now());
					return { output: [{ type: "text", text: "已儲存到記憶庫。" }] };
				},
			}),
			defineTool({
				name: "recall",
				description: "按關鍵詞檢索記憶庫",
				parameters: Type.Object({ query: Type.String({ description: "關鍵詞（空格分隔多個）" }) }),
				execute: async (args) => {
					const q = String((args as { query?: unknown }).query ?? "").trim();
					const rows = memoryRepo.listContents(sql).map((content) => ({ content }));
					const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
					const scored = rows
						.map((r) => ({ r, s: terms.reduce((n, t) => n + (r.content.toLowerCase().includes(t) ? 1 : 0), 0) }))
						.filter((x) => x.s > 0)
						.sort((a, b) => b.s - a.s)
						.slice(0, 8);
					const text = scored.length
						? scored.map((x) => "· " + x.r.content).join("\n")
						: rows.length
							? "沒有匹配的記憶。最近幾條：\n" + rows.slice(0, 5).map((r) => "· " + r.content).join("\n")
							: "記憶庫還是空的。";
					return { output: [{ type: "text", text }] };
				},
			}),
			defineTool({
				name: "list_skills",
				description: "列出已安裝的技能（名稱與用途）",
				parameters: Type.Object({}),
				execute: async () => {
					const rows = skillsRepo.listSkillMeta(sql).filter((row) => row.auditStatus !== "blocked");
					const text = rows.length
						? rows.map((r) => `- ${r.name}：${r.description || "（無描述）"}`).join("\n")
						: "還沒有安裝任何技能。";
					return { output: [{ type: "text", text }] };
				},
			}),
			defineTool({
				name: "load_skill",
				description: "讀取某個技能的完整說明（步驟/模板/約束），按說明完成任務",
				parameters: Type.Object({ name: Type.String({ description: "技能名稱" }) }),
				execute: async (args) => {
					const name = String((args as { name?: unknown }).name ?? "").trim();
					const row = skillsRepo.getSkillRow(sql, name);
					if (!row) return { output: [{ type: "text", text: `技能「${name}」不存在，可用 list_skills 檢視。` }] };
					if (row.auditStatus === "blocked") {
						// 准入：blocked 行即使因歷史原因存在也不可載入（契約 §5.5）
						let reason = "";
						try {
							const report = JSON.parse(row.auditReport || "{}") as { reasons?: { message?: string }[] };
							reason = report.reasons?.[0]?.message ?? "";
						} catch {
							// 報告損壞時只給通用原因
						}
						return { output: [{ type: "text", text: `技能「${name}」未通過安全審計，不能載入。${reason}` }] };
					}
					trackSkillCall(sql, name, "loaded");
					return { output: [{ type: "text", text: row.content }] };
				},
			}),
			defineTool({
				name: "install_skill",
				description: "從 SKILL.md 連結安裝技能到當前使用者（寫操作）：抓取正文、解析 frontmatter、按名稱寫入或覆蓋技能庫",
				parameters: Type.Object({
					url: Type.String({ description: "SKILL.md 的 http(s) 連結；GitHub blob 連結會自動轉 raw" }),
					name: Type.Optional(Type.String({ description: "覆蓋技能名（預設取 frontmatter 的 name）" })),
				}),
				execute: async (args) => {
					const raw = String((args as { url?: unknown }).url ?? "");
					const url = normalizeSkillUrl(raw);
					if (!url) return { output: [{ type: "text", text: "需要一個 http(s) 的 SKILL.md 連結。" }] };
					const name = String((args as { name?: unknown }).name ?? "").trim();
					try {
						// 與 Hub/API 同一匯入通道：先審計再入庫，blocked 不寫庫（NERE-55）。
						const result = await createSkillService({ sql, settings }).importSkill({
							url,
							...(name ? { name } : {}),
						});
						const warn =
							result.audit.status === "warn"
								? `（審計告警：${result.audit.reasons.map((r) => r.message).join("；")}）`
								: "";
						return {
							output: [
								{
									type: "text",
									text: `技能已安裝：${result.name}${warn}。現在可以呼叫 load_skill("${result.name}") 讀取；下一輪起會出現在技能索引裡。`,
								},
							],
						};
					} catch (err) {
						const message = err instanceof SkillApiError ? err.message : `抓取失敗：${String(err).slice(0, 120)}`;
						return { output: [{ type: "text", text: `安裝失敗：${message}` }] };
					}
				},
			}),
			defineTool({
				name: "http_fetch",
				description: "抓取一個網頁並返回其正文文本（已去除標籤，截斷至 6000 字）",
				parameters: Type.Object({ url: Type.String({ description: "完整的 http(s) URL" }) }),
				execute: async (args) => {
					const url = String((args as { url?: unknown }).url ?? "");
					if (!/^https?:\/\//.test(url)) return { output: [{ type: "text", text: "URL 必須以 http(s):// 開頭。" }] };
					try {
						const resp = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (durable-pi)" }, redirect: "follow" });
						if (!resp.ok) return { output: [{ type: "text", text: `HTTP ${resp.status}` }] };
						return { output: [{ type: "text", text: stripHtml(await resp.text()) || "(空頁面)" }] };
					} catch (e) {
						return { output: [{ type: "text", text: "抓取失敗：" + String(e).slice(0, 200) }] };
					}
				},
			}),
			defineTool({
				name: "update_plan",
				description:
					"維護當前任務的分步計劃（Codex 式 todo 列表）。多步任務開始前先列出完整步驟（3–7 步），之後每完成一步就再次呼叫本工具提交**完整的**步驟列表並更新狀態。使用者能在聊天介面即時看到這份計劃，所以只列真正要做的步驟。",
				parameters: Type.Object({
					explanation: Type.Optional(Type.String({ description: "一句話說明為什麼更新計劃（可選）" })),
					steps: Type.Array(
						Type.Object({
							title: Type.String({ description: "這一步做什麼，動詞開頭，一句話" }),
							status: Type.String({ description: "pending | in_progress | completed" }),
						}),
						{ description: "完整的步驟列表（每次都提交全量，不是增量）" },
					),
				}),
				execute: async (args, api) => {
					const raw = (args as { steps?: unknown }).steps;
					const list = Array.isArray(raw) ? raw : [];
					const steps: { title: string; status: "pending" | "in_progress" | "completed" }[] = [];
					for (const item of list.slice(0, 20)) {
						const o = (item ?? {}) as { title?: unknown; status?: unknown };
						const title = String(o.title ?? "").trim().slice(0, 120);
						if (!title) continue;
						const s = String(o.status ?? "pending");
						steps.push({ title, status: s === "completed" || s === "in_progress" ? s : "pending" });
					}
					if (!steps.length) return { output: [{ type: "text", text: "計劃為空，未儲存。" }] };
					savePlan(sql, String(api.conversationId), steps);
					const done = steps.filter((s) => s.status === "completed").length;
					const current = steps.find((s) => s.status === "in_progress");
					return {
						output: [{
							type: "text",
							text: `計劃已更新：${steps.length} 步，完成 ${done} 步${current ? `，當前：${current.title}` : ""}。`,
						}],
					};
				},
			}),
			defineTool({
				name: "set_goal",
				description:
					"為使用者的長程目標開啟目標模式：繫結目標 + token 預算 + 最大輪次。開啟後你會在每輪結束後被自動要求繼續推進，直到呼叫 complete_goal、預算用盡或報告受阻。只在使用者給出一個需要多輪才能完成的大目標時使用；普通問題不要用。",
				parameters: Type.Object({
					objective: Type.String({ description: "要達成的目標，一句話，可驗收" }),
					tokenBudget: Type.Optional(Type.Number({ description: "token 預算，預設 200000" })),
					maxTurns: Type.Optional(Type.Number({ description: "最多自動續轉輪次，預設 12" })),
				}),
				execute: async (args, api) => {
					const a = args as { objective?: unknown; tokenBudget?: unknown; maxTurns?: unknown };
					const objective = String(a.objective ?? "").trim().slice(0, 300);
					if (!objective) return { output: [{ type: "text", text: "目標不能為空。" }] };
					const sid = String(api.conversationId);
					const existing = readGoal(sql, sid);
					if (existing?.status === "active") {
						return { output: [{ type: "text", text: `當前會話已有進行中的目標「${existing.objective}」，先完成或停止它。` }] };
					}
					const budget = Math.max(10_000, Math.floor(Number(a.tokenBudget ?? GOAL_TOKEN_BUDGET_DEFAULT) || GOAL_TOKEN_BUDGET_DEFAULT));
					const turns = Math.min(50, Math.max(1, Math.floor(Number(a.maxTurns ?? GOAL_MAX_TURNS_DEFAULT) || GOAL_MAX_TURNS_DEFAULT)));
					// baseline = -1：目標由模型在對話中途建立，真實基線在下一輪同步時以當時累計值為準
					startGoal(sql, { sessionId: sid, objective, tokenBudget: budget, maxTurns: turns, baseline: -1 });
					return {
						output: [{
							type: "text",
							text: `目標已開啟：${objective}（預算 ${budget} tokens，最多 ${turns} 輪）。完成後必須呼叫 complete_goal 並給出驗證證據。`,
						}],
					};
				},
			}),
			defineTool({
				name: "complete_goal",
				description:
					"聲明當前目標已完成並關閉目標模式。必須給出可核對的完成證據；如果計劃裡還有未完成步驟會被拒絕。",
				parameters: Type.Object({
					summary: Type.String({ description: "完成情況，一段話" }),
					evidence: Type.String({ description: "完成證據：做了什麼、怎麼驗證的（檔案、數值、測試輸出、連結）" }),
				}),
				execute: async (args, api) => {
					const a = args as { summary?: unknown; evidence?: unknown };
					const sid = String(api.conversationId);
					const row = readGoal(sql, sid);
					if (!row || row.status !== "active") {
						return { output: [{ type: "text", text: "當前會話沒有進行中的目標。" }] };
					}
					const evidence = String(a.evidence ?? "").trim();
					if (evidence.length < 10) {
						return { output: [{ type: "text", text: "證據太短（至少 10 字）。請說明你實際做了什麼、用什麼方式驗證的，再呼叫本工具。" }] };
					}
					// 完成硬校驗：計劃裡不能還有沒做完的步驟
					const steps = readPlan(sql, sid);
					const open = steps.filter((s) => s.status !== "completed");
					if (steps.length && open.length) {
						return {
							output: [{
								type: "text",
								text: `計劃還有 ${open.length} 步未完成（${open.slice(0, 5).map((s) => s.title).join("；")}）。先完成它們並把計劃更新為全部 completed，再呼叫 complete_goal。`,
							}],
						};
					}
					const summary = String(a.summary ?? "").trim().slice(0, 800);
					writeGoal(sql, sid, { status: "done", summary: `${summary}\n\n證據：${evidence.slice(0, 400)}`, next_run_at: 0 });
					return { output: [{ type: "text", text: `目標已完成並關閉。\n${summary}` }] };
				},
			}),
			defineTool({
				name: "report_goal",
				description: "報告目標推進受阻（缺少許可權、資訊不足、外部依賴不可用等），並結束自動續轉。",
				parameters: Type.Object({
					reason: Type.String({ description: "受阻原因，具體說明缺什麼" }),
				}),
				execute: async (args, api) => {
					const sid = String(api.conversationId);
					const row = readGoal(sql, sid);
					if (!row || row.status !== "active") return { output: [{ type: "text", text: "當前會話沒有進行中的目標。" }] };
					const reason = String((args as { reason?: unknown }).reason ?? "").trim().slice(0, 500) || "未說明";
					writeGoal(sql, sid, { status: "blocked", summary: reason, next_run_at: 0 });
					return { output: [{ type: "text", text: `目標已標記為受阻並停止續轉：${reason}` }] };
				},
			}),
			defineTool({
				name: "ask_user",
				description:
					"向用戶提問並等待回答（渲染成問答卡片，可選項 + 自由輸入）。需要使用者做決策、補充偏好或確認方向時使用；一次可以問 1–6 個問題，每個問題給出推薦項（recommended: true）。使用者回答後你會自動收到答案並繼續。普通對話不要用。",
				parameters: Type.Object({
					title: Type.Optional(Type.String({ description: "這一輪的問題標題，一句話" })),
					questions: Type.Array(
						Type.Object({
							id: Type.String({ description: "問題 id，如 q1" }),
							question: Type.String({ description: "問題正文" }),
							options: Type.Optional(
								Type.Array(
									Type.Object({
										label: Type.String({ description: "選項文案（簡短）" }),
										description: Type.Optional(Type.String({ description: "選項補充說明" })),
										recommended: Type.Optional(Type.Boolean({ description: "是否推薦項" })),
									}),
									{ description: "可選項；留空則只收自由文本" },
								),
							),
							allowText: Type.Optional(Type.Boolean({ description: "是否允許自由輸入（預設 true）" })),
						}),
						{ description: "問題列表，1–6 個", minItems: 1, maxItems: 6 },
					),
				}),
				execute: async (args, api) => {
					const a = args as { title?: unknown; questions?: unknown };
					const list = Array.isArray(a.questions) ? a.questions : [];
					const questions: AskItem[] = [];
					for (const raw of list.slice(0, 6)) {
						const o = (raw ?? {}) as { id?: unknown; question?: unknown; options?: unknown; allowText?: unknown };
						const question = String(o.question ?? "").trim();
						if (!question) continue;
						const options = (Array.isArray(o.options) ? o.options : [])
							.slice(0, 8)
							.map((item) => {
								const opt = (item ?? {}) as { label?: unknown; description?: unknown; recommended?: unknown };
								const label = String(opt.label ?? "").trim();
								if (!label) return null;
								return {
									label: label.slice(0, 80),
									...(opt.description ? { description: String(opt.description).slice(0, 200) } : {}),
									...(opt.recommended === true ? { recommended: true } : {}),
								};
							})
							.filter((opt): opt is AskOption => opt !== null);
						questions.push({
							id: String(o.id ?? `q${questions.length + 1}`).slice(0, 20),
							question: question.slice(0, 500),
							...(options.length ? { options } : {}),
							allowText: o.allowText !== false,
						});
					}
					if (!questions.length) return { output: [{ type: "text", text: "沒有有效問題，未提交。" }] };
					const sid = String(api.conversationId);
					const id = recordQuestion(sql, sid, {
						...(a.title ? { title: String(a.title).slice(0, 120) } : {}),
						questions,
					});
					return {
						output: [{
							type: "text",
							text: `已向用戶提出 ${questions.length} 個問題${id ? `（#${id}）` : ""}，正在等待回答。不要重複提問，也不要自己替使用者作答；使用者回答後你會收到答案。`,
						}],
					};
				},
			}),
			defineTool({
				name: "dispatch_tasks",
				description:
					"把若干**互不依賴**的子任務並行分派給子代理，各自獨立完成後彙總。適合「同時調研 N 個物件」「對比 M 個方案」這類可並行的活。每個子代理看不到主對話，prompt 必須自包含。",
				parameters: Type.Object({
					tasks: Type.Array(
						Type.Object({
							title: Type.String({ description: "子任務標題，用於彙總展示（10 字以內）" }),
							prompt: Type.String({ description: "交給子代理的完整指令，自包含，不依賴主對話上下文" }),
						}),
						{ description: "子任務列表，1–4 個", minItems: 1, maxItems: 4 },
					),
				}),
				execute: async (args, api) => {
					const harness = deps.harness();
					if (!harness) return { output: [{ type: "text", text: "子代理不可用：harness 未就緒。" }] };

					const list = Array.isArray((args as { tasks?: unknown }).tasks) ? ((args as { tasks: unknown[] }).tasks) : [];
					const tasks = list
						.slice(0, 4)
						.map((t) => {
							const o = (t ?? {}) as { title?: unknown; prompt?: unknown };
							return { title: String(o.title ?? "").trim().slice(0, 40), prompt: String(o.prompt ?? "").trim() };
						})
						.filter((t) => t.prompt);
					if (!tasks.length) return { output: [{ type: "text", text: "沒有有效的子任務。" }] };

					// 沿用父會話的模型；取不到就用當前供應商的第一個模型
					let model = {
						provider: effectiveProviderId(sql),
						modelId: activeModelIds(sql)[0] ?? "",
					};
					try {
						const parent = await harness.conversation(api.conversationId, harnessContext);
						const agent = parent ? await parent.agent(harnessContext) : null;
						if (agent?.model) model = { provider: agent.model.provider, modelId: agent.model.modelId };
					} catch {
						// 取不到就用預設
					}

					// 子代理只給只讀類工具，避免併發寫檔案/記憶
					const allTools = [
						...((spikeDefinition.tools ?? []) as unknown as { name: string }[]),
						...((extensions.codemode.tools ?? []) as unknown as { name: string }[]),
					];
					const allowedNames: Record<string, true> = {
						now: true,
						recall: true,
						read_file: true,
						list_files: true,
						http_fetch: true,
						web_search: true,
						web_fetch_page: true,
						codemode: true,
					};
					const modelTools = allTools.filter((t) => allowedNames[t.name]);
					const instructions =
						"你是被主代理分派的子代理，只負責完成分配給你的那一個任務。\n" +
						"- 直接給結果，不要寒暄、不要複述任務。\n" +
						"- 需要檢索就用 web_search / web_fetch_page；需要計算就用 codemode。\n" +
						"- 結果控制在 800 字以內，結論先行。\n" +
						"- 完成後不要再呼叫工具。";

					const runOne = async (task: { title: string; prompt: string }, index: number) => {
						const started = Date.now();
						try {
							const conv = await harness.createConversation(
								{
									ownership: { kind: "ownerless" },
									agent: {
										model,
										extensions: [spikeDefinition, extensions.codemode],
										instructions,
										modelTools,
									},
								},
								harnessContext,
							);
							// 子代理會話標記為隱藏，不出現在側欄
							sessionsRepo.insertHiddenIfAbsent(
								sql,
								String(conv.id),
								`子代理 ${index + 1}：${task.title || "未命名"}`,
								now(),
							);
							const submission = await conv.submit({ type: "input", content: task.prompt }, harnessContext);
							const settled = await submission.wait(harnessContext);
							if (settled.status !== "done" || settled.type !== "input") {
								return { title: task.title, ok: false, text: `（子任務未完成：${settled.status}）`, ms: Date.now() - started };
							}
							// settled.answer 可能只是這一輪的工具呼叫訊息；改為讀會話裡最新一條含文本的助手條目
							let text = "";
							try {
								const page = await conv.entries({}, 20, undefined, harnessContext);
								for (const raw of page.items as Record<string, unknown>[]) {
									if (raw.kind !== "pi.assistant") continue;
									const blocks = (raw.model as { content?: unknown }[] | undefined)?.[0]?.content;
									const joined = Array.isArray(blocks)
										? blocks
												.filter((b): b is { type: string; text?: string } => Boolean(b) && typeof b === "object")
												.filter((b) => b.type === "text")
												.map((b) => b.text ?? "")
												.join("")
												.trim()
										: typeof blocks === "string"
											? blocks.trim()
											: "";
									if (joined) {
										text = joined;
										break;
									}
								}
							} catch {
								// 讀條目失敗就退回 settled.answer
								const blocks = (settled.answer as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [];
								text = blocks
									.filter((b) => b.type === "text")
									.map((b) => b.text ?? "")
									.join("")
									.trim();
							}
							return { title: task.title, ok: true, text: text.slice(0, 4000), ms: Date.now() - started };
						} catch (err) {
							return { title: task.title, ok: false, text: `（失敗：${String(err).slice(0, 160)}）`, ms: Date.now() - started };
						}
					};

					const results = await Promise.all(tasks.map(runOne));
					const parts = results.map(
						(r, i) => `## 子任務 ${i + 1}：${r.title || "未命名"}${r.ok ? "" : "（失敗）"}\n\n${r.text || "（空）"}`,
					);
					const summary = results
						.map((r, i) => `${i + 1}. ${r.title} — ${r.ok ? "完成" : "失敗"} · ${(r.ms / 1000).toFixed(1)}s`)
						.join("\n");
					return {
						output: [{
							type: "text",
							text: `已並行完成 ${results.filter((r) => r.ok).length}/${results.length} 個子任務：\n${summary}\n\n${parts.join("\n\n")}`,
						}],
					};
				},
			}),
			defineTool({
				name: "web_search",
				description:
					"聯網搜尋（工具箱端點提供的 /v1/tools/search）。返回「標題+連結+摘要」列表；需要即時資訊、事實核查、最新動態時使用。結果裡的 URL 可再配合 web_fetch_page 抓取正文。",
				parameters: Type.Object({
					query: Type.String({ description: '搜尋關鍵詞（1–128 字元），支援 site:、"..."、lang:、after:、before: 等語法' }),
					count: Type.Optional(Type.Number({ description: "返回條數 1–50，預設 8" })),
				}),
				execute: async (args) => {
					const a = args as { query?: unknown; count?: unknown };
					const query = String(a.query ?? "").trim().slice(0, 128);
					if (!query) return { output: [{ type: "text", text: "搜尋關鍵詞不能為空。" }] };
					if (settings.get("web_search", "1") !== "1") {
						return { output: [{ type: "text", text: "網頁搜尋當前未開啟。請告訴使用者：在 設定 → 網頁搜尋 中開啟後即可聯網搜尋。" }] };
					}
					const { baseUrl, apiKey } = deps.toolbox;
					if (!baseUrl || !apiKey) {
						return {
							output: [{
								type: "text",
								text: "尚未配置工具箱端點。請告訴使用者：在 設定 → 模型與工具服務 裡填寫 Base URL 與 API Key 後即可聯網搜尋。",
							}],
						};
					}
					const count = Math.min(50, Math.max(1, Math.floor(Number(a.count ?? 8) || 8)));
					try {
						const resp = await fetch(`${baseUrl}/v1/tools/search`, {
							method: "POST",
							headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
							body: JSON.stringify({ query, count, need_content: false }),
						});
						const data = (await resp.json().catch(() => null)) as {
							results?: unknown;
							error?: { message?: string };
						} | null;
						if (!resp.ok) {
							const msg = data?.error?.message ?? `HTTP ${resp.status}`;
							return { output: [{ type: "text", text: `搜尋失敗：${msg}` }] };
						}
						const results = Array.isArray(data?.results) ? (data!.results as Record<string, unknown>[]) : [];
						if (!results.length) return { output: [{ type: "text", text: "沒有搜尋結果，試試換關鍵詞。" }] };
						const lines = results.map((r, i) => {
							const title = String(r.title ?? "").trim() || "(無標題)";
							const url2 = String(r.url ?? "");
							const snippet = String(r.summary || r.snippet || "").trim().slice(0, 400);
							const date = typeof r.date === "string" ? ` · ${r.date.slice(0, 10)}` : "";
							return `${i + 1}. ${title}${date}\n   ${url2}\n   ${snippet}`;
						});
						return { output: [{ type: "text", text: lines.join("\n\n") }] };
					} catch (e) {
						return { output: [{ type: "text", text: "搜尋失敗：" + String(e).slice(0, 200) }] };
					}
				},
			}),
			defineTool({
				name: "web_fetch_page",
				description:
					"抓取網頁並返回乾淨的 Markdown 正文（工具箱端點提供的 /v1/tools/fetch，可處理部分反爬站點）。http_fetch 抓到的是 HTML 亂碼或空內容時改用本工具。",
				parameters: Type.Object({ url: Type.String({ description: "完整的 http(s) URL" }) }),
				execute: async (args) => {
					const url = String((args as { url?: unknown }).url ?? "").trim();
					if (!/^https?:\/\//i.test(url)) return { output: [{ type: "text", text: "URL 必須以 http(s):// 開頭。" }] };
					if (settings.get("web_search", "1") !== "1") {
						return { output: [{ type: "text", text: "網頁搜尋當前未開啟。請告訴使用者：在 設定 → 網頁搜尋 中開啟後即可抓取網頁。" }] };
					}
					const page = await deps.webFetch(url);
					if (!page.ok) return { output: [{ type: "text", text: page.message }] };
					return {
						output: [{ type: "text", text: (page.title ? `# ${page.title}\n\n` : "") + page.content.slice(0, 8000) }],
					};
				},
			}),
			defineTool({
				name: "write_file",
				description:
					"把內容寫入工作臺檔案（覆蓋同名）；適合報告、筆記、程式碼、資料。檔案會出現在右側工作臺面板，需要發給他人時可用 share_file 生成分享連結",
				parameters: Type.Object({
					name: Type.String({ description: "檔名，如 report.md / notes.txt / main.js" }),
					content: Type.String({ description: "完整檔案內容" }),
				}),
				execute: async (args, api) => {
					const a = args as { name?: unknown; content?: unknown };
					const name = String(a.name ?? "").trim().replace(/^[/.]+/, "").slice(0, 120);
					if (!name) return { output: [{ type: "text", text: "檔名不能為空。" }] };
					const content = String(a.content ?? "");
					files.write(String(api.conversationId), name, content);
					return {
						output: [{ type: "text", text: `已寫入 ${name}（${content.length} 字元）。需要發給他人時可用 share_file 生成分享連結。` }],
					};
				},
			}),
			defineTool({
				name: "read_file",
				description: "讀取工作臺檔案內容",
				parameters: Type.Object({ name: Type.String({ description: "檔名" }) }),
				execute: async (args, api) => {
					const name = String((args as { name?: unknown }).name ?? "").replace(/^[/.]+/, "");
					const rows = files.read(String(api.conversationId), name);
					return { output: [{ type: "text", text: rows?.content ?? `檔案 ${name} 不存在。` }] };
				},
			}),
			defineTool({
				name: "list_files",
				description: "列出工作臺全部檔案",
				parameters: Type.Object({}),
				execute: async (_args, api) => {
					const rows = files.list(String(api.conversationId));
					const text = rows.length
						? rows.map((r) => `${r.name} · ${r.size} 字元 · ${r.updated_at.slice(0, 16).replace("T", " ")}`).join("\n")
						: "工作臺還沒有檔案。";
					return { output: [{ type: "text", text }] };
				},
			}),
			defineTool({
				name: "share_file",
				description:
					"把工作臺檔案生成公開只讀分享連結（寫操作）。使用者說「分享」「發我個連結」「轉給同事」時直接呼叫；同一檔案已有未過期連結會複用，不重複生成。ttlSeconds 不傳時用設定裡的預設有效期。",
				parameters: Type.Object({
					name: Type.String({ description: "工作臺檔名，如 report.md" }),
					ttlSeconds: Type.Optional(Type.Number({ description: "有效期（秒），0 = 永久；不傳沿用設定預設" })),
				}),
				execute: async (args, api) => {
					const a = args as { name?: unknown; ttlSeconds?: unknown };
					const name = String(a.name ?? "").trim().replace(/^[/.]+/, "").slice(0, 120);
					if (!name) return { output: [{ type: "text", text: "檔名不能為空。請先用 write_file 生成檔案再分享。" }] };
					try {
						const { share, reused } = shares.shareForTool("file", String(api.conversationId), name, a.ttlSeconds);
						const url = shares.urlFor(share.token);
						const expiry = shareExpiryLabel(share.expiresAt);
						return {
							output: [{
								type: "text",
								text: `${reused ? "已複用未過期的分享連結" : "已生成分享連結"}：${url}（${expiry}）。請在回覆裡原樣給出這個完整連結。`,
							}],
							details: {
								share: {
									kind: "file",
									name,
									url,
									expiresAt: share.expiresAt,
									createdAt: share.createdAt,
									reused,
								},
							},
						};
					} catch (err) {
						return {
							output: [{
								type: "text",
								text: `分享失敗：${err instanceof Error ? err.message : String(err)}。先用 write_file 寫入檔案再呼叫 share_file。`,
							}],
						};
					}
				},
			}),
			defineTool({
				name: "share_conversation",
				description:
					"把當前對話生成公開只讀分享連結（寫操作）。使用者要把這段對話發給別人時呼叫；已有未過期連結會複用。ttlSeconds 不傳時用設定裡的預設有效期。",
				parameters: Type.Object({
					ttlSeconds: Type.Optional(Type.Number({ description: "有效期（秒），0 = 永久；不傳沿用設定預設" })),
				}),
				execute: async (args, api) => {
					const a = args as { ttlSeconds?: unknown };
					const conversationId = String(api.conversationId);
					try {
						const { share, reused } = shares.shareForTool("conversation", conversationId, "", a.ttlSeconds);
						const url = shares.urlFor(share.token);
						const expiry = shareExpiryLabel(share.expiresAt);
						const title = shares.sessionTitle(conversationId);
						return {
							output: [{
								type: "text",
								text: `${reused ? "已複用未過期的對話分享連結" : "已生成對話分享連結"}：${url}（${expiry}）。請在回覆裡原樣給出這個完整連結。`,
							}],
							details: {
								share: {
									kind: "conversation",
									name: title,
									url,
									expiresAt: share.expiresAt,
									createdAt: share.createdAt,
									reused,
								},
							},
						};
					} catch (err) {
						return {
							output: [{ type: "text", text: `分享失敗：${err instanceof Error ? err.message : String(err)}。` }],
						};
					}
				},
			}),
			defineTool({
				name: "kb_search",
				description:
					"檢索當前使用者的知識庫（使用者上傳的資料、長期參考文件）。回答涉及使用者私人資料或歷史資料時先檢索；返回命中的片段與文件名。",
				parameters: Type.Object({
					query: Type.String({ description: "檢索詞，用使用者問題裡的關鍵詞" }),
					limit: Type.Optional(Type.Number({ description: "返回片段數，預設 6，最多 20" })),
				}),
				execute: async (args) => {
					const a = args as { query?: unknown; limit?: unknown };
					const query = String(a.query ?? "").trim();
					if (!query) return { output: [{ type: "text", text: "檢索詞不能為空。" }] };
					const hits = await kb.searchAsync(query, Number(a.limit) || 6);
					if (!hits.length) {
						return { output: [{ type: "text", text: `知識庫裡沒有匹配「${query}」的內容。可用 kb_list 檢視已有哪些文件。` }] };
					}
					const lines = hits.map(
						(hit, i) =>
							`[${i + 1}] ${hit.title}${hit.source ? `（${hit.source}）` : ""} · 片段 ${hit.chunkSeq + 1}\n${String(hit.text).slice(0, 900)}`,
					);
					return { output: [{ type: "text", text: `命中 ${hits.length} 段：\n\n${lines.join("\n\n---\n\n")}` }] };
				},
			}),
			defineTool({
				name: "kb_add",
				description:
					"把資料儲存進當前使用者的知識庫（寫操作）：自動分塊、建立中文全文索引，之後可用 kb_search 檢索。適合使用者貼的資料、報告、長期參考；工作臺檔案不會被檢索。",
				parameters: Type.Object({
					title: Type.String({ description: "文件標題" }),
					content: Type.String({ description: "文件正文（純文本或 Markdown）" }),
					source: Type.Optional(Type.String({ description: "來源，如 URL 或檔名" })),
					tags: Type.Optional(Type.String({ description: "標籤，逗號分隔" })),
				}),
				execute: async (args) => {
					const a = args as { title?: unknown; content?: unknown; source?: unknown; tags?: unknown };
					const title = String(a.title ?? "").trim().slice(0, 120);
					const content = String(a.content ?? "").trim();
					if (!title || !content) return { output: [{ type: "text", text: "標題和正文都不能為空。" }] };
					const { id, chunks, vectorized, updated } = await kb.addIndexed({
						title,
						content,
						source: String(a.source ?? "").trim().slice(0, 300),
						tags: String(a.tags ?? "").trim().slice(0, 120),
					});
					return {
						output: [
							{
								type: "text",
								text: updated
									? `已存入知識庫：${title}（id=${id}，${chunks} 個片段，${content.length} 字元${vectorized ? `，已建向量 ${vectorized} 段` : ""}）。`
									: `知識庫已有相同內容：${title}（id=${id}，${chunks} 個片段），未重複入庫。`,
							},
						],
					};
				},
			}),
			defineTool({
				name: "kb_list",
				description: "列出當前使用者知識庫裡的文件",
				parameters: Type.Object({}),
				execute: async () => {
					const docs = kb.listDocs();
					const text = docs.length
						? docs.map((doc) => `- [${doc.id}] ${doc.title}${doc.source ? ` · ${doc.source}` : ""} · ${doc.chunks} 段 · ${doc.size} 字元`).join("\n")
						: "知識庫還是空的。使用者貼資料時可以呼叫 kb_add 儲存。";
					return { output: [{ type: "text", text }] };
				},
			}),
			defineTool({
				name: "kb_delete",
				description: "從當前使用者的知識庫刪除一篇文件（寫操作，不可撤銷）",
				parameters: Type.Object({ id: Type.Number({ description: "文件 id（來自 kb_list）" }) }),
				execute: async (args) => {
					const id = Number((args as { id?: unknown }).id ?? 0);
					if (!id) return { output: [{ type: "text", text: "需要一個有效的文件 id。" }] };
					return { output: [{ type: "text", text: (await kb.remove(id)) ? `已刪除文件 ${id}。` : `文件 ${id} 不存在。` }] };
				},
			}),
		],
	});

	const spikeDefinition = {
		...base,
		tools: (base.tools ?? []).map((tool) => withApproval(tool as never, gate)),
	};

	const baseToolSearch = createToolSearchExtension();
	const toolSearch = {
		...baseToolSearch,
		tools: (baseToolSearch.tools ?? []).map((tool) => withApproval(tool as never, gate)),
	};

	const baseCodemode = createCodemodeExtension({
		sandbox: createInlineCodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 }),
		models: false,
	});
	const codemode = {
		...baseCodemode,
		tools: (baseCodemode.tools ?? []).map((tool) => withApproval(tool as never, gate)),
	};

	// dispatch_tasks 的閉包在擴充套件構造後才執行，因此可以引用最終物件。
	const extensions = { spike: spikeDefinition, codemode, toolSearch };
	return extensions;
}
