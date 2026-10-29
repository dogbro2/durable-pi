import type { SqlHandle } from "../db/migrations";
import type { AlarmRuntime, DataRuntime } from "../http/ports";
import type { KbService } from "./kb-service";
import * as automationsRepo from "../repo/automations-repo";
import * as filesRepo from "../repo/files-repo";
import * as goalsRepo from "../repo/goals-repo";
import * as mcpRepo from "../repo/mcp-repo";
import * as memoryRepo from "../repo/memory-repo";
import * as plansRepo from "../repo/plans-repo";
import * as promptsRepo from "../repo/prompts-repo";
import * as providersRepo from "../repo/providers-repo";
import * as sessionsRepo from "../repo/sessions-repo";
import * as settingsRepo from "../repo/settings-repo";
import * as sharesRepo from "../repo/shares-repo";
import * as skillsRepo from "../repo/skills-repo";
import { GOAL_MAX_TURNS_DEFAULT, GOAL_TOKEN_BUDGET_DEFAULT } from "./goal-service";
import { renderExportMarkdown } from "../lib/export-markdown";

/**
 * 資料域用例（ADR-0001 §2 / R8）：備份、恢復、匯出、記憶。
 *
 * 備份/恢復只做編排，SQL 全部經 repo；Harness 相關（匯出條目、reflect、恢復後重建 MCP）
 * 由 DO 通過 `DataRuntime` 埠注入，因此 Service 可以脫離 DO 單測。
 * `/backup`、`/restore` 的 JSON 結構與冪等語義逐字保持不變（R8 不在本階段修）。
 */

export type DataServiceDeps = {
	sql: SqlHandle;
	kb: KbService;
	runtime: DataRuntime;
	/** 恢復完成後重排 alarm（舊 restore 的最後一步）。 */
	alarm: AlarmRuntime;
	now?: () => string;
};

export type BackupPayload = {
	version: number;
	exportedAt: string;
	/** v1.1.0：true = 備份裡的金鑰已摘除（恢復時留空項沿用庫裡原值）。 */
	secretsOmitted?: boolean;
	data: Record<string, unknown>;
};

/**
 * 備份載荷（NERE-24 起也供使用者資料匯出複用）：純 SQL 彙總，不讀 Harness、不寫庫。
 * `kbDocs` 由呼叫方傳入，避免本函式依賴 KbService 的檢索/向量能力。
 */
/** 備份裡必須摘掉的金鑰類設定（v1.1.0）。 */
const SECRET_SETTING_KEYS = new Set(["tool_api_key"]);
/** MCP 頭裡按名字判定為機密的鍵。 */
const SECRET_HEADER = /authorization|cookie|token|api[-_]?key|secret/i;
/** 摘除後的佔位值；恢復時遇到它保留庫裡的原值。 */
export const REDACTED = "***";

/** 把 MCP headers 裡的機密值替換成佔位符，其餘原樣保留。 */
function redactHeaders(raw: string): string {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object") return raw;
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(parsed)) {
			out[key] = SECRET_HEADER.test(key) ? REDACTED : value;
		}
		return JSON.stringify(out);
	} catch {
		return raw;
	}
}

export function buildBackup(input: {
	sql: SqlHandle;
	kbDocs: readonly unknown[];
	now?: () => string;
}): BackupPayload {
	const { sql, kbDocs, now = () => new Date().toISOString() } = input;
	return {
		version: 1,
		exportedAt: now(),
		// v1.1.0：備份檔案會被隨手轉發，因此不落金鑰明文；恢復時留空的項沿用庫裡的值。
		secretsOmitted: true,
		data: {
			memories: memoryRepo.listForBackup(sql),
			files: filesRepo.listForBackup(sql),
			automations: automationsRepo.listForBackup(sql),
			mcpServers: mcpRepo
				.listForBackup(sql)
				.map((row) => ({ ...row, headers: redactHeaders(String(row.headers ?? "{}")) })),
			sessions: sessionsRepo.listForBackup(sql),
			shares: sharesRepo.listForBackup(sql),
			skills: skillsRepo.listForBackup(sql),
			settings: settingsRepo.listAll(sql).filter((row) => !SECRET_SETTING_KEYS.has(row.key)),
			plans: plansRepo.listForBackup(sql),
			providers: providersRepo.listForBackup(sql).map((row) => ({ ...row, api_key: "" })),
			prompts: promptsRepo.listPromptsForBackup(sql),
			rules: promptsRepo.listRulesForBackup(sql),
			goals: goalsRepo.listForBackup(sql),
			kbDocs,
		},
	};
}

export type DataService = {
	backup(): BackupPayload;
	restore(payload: unknown): Promise<Record<string, number>>;
	exportMarkdown(sessionId?: string): Promise<{ markdown: string; title: string; sessionId: string }>;
	reflect(sessionId?: string): Promise<{ ok: true; saved: number }>;
};

/** 恢復 MCP headers：佔位符沿用庫裡原值，其它以備份為準。 */
function mergeHeaders(incoming: string, existingRaw: string | undefined): string {
	let next: Record<string, unknown>;
	try {
		next = JSON.parse(incoming) as Record<string, unknown>;
	} catch {
		return incoming;
	}
	if (!next || typeof next !== "object") return incoming;
	let previous: Record<string, unknown> = {};
	try {
		previous = JSON.parse(existingRaw || "{}") as Record<string, unknown>;
	} catch {
		previous = {};
	}
	for (const [key, value] of Object.entries(next)) {
		if (value === REDACTED && typeof previous[key] === "string") next[key] = previous[key];
	}
	return JSON.stringify(next);
}

function str(value: unknown): string {
	return typeof value === "string" ? value : String(value ?? "");
}

function num(value: unknown): number {
	return typeof value === "number" ? value : Number(value ?? 0) || 0;
}

/** 外部 JSON 的陣列欄位：只保留物件元素，逐欄位讀取時再窄化。 */
function rows(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
	);
}

export function createDataService({ sql, kb, runtime, alarm, now = () => new Date().toISOString() }: DataServiceDeps): DataService {
	return {
		backup: () => buildBackup({ sql, kbDocs: kb.backupDocs(), now }),

		/** 從備份恢復：按主鍵 upsert，不刪除現有資料。返回各類寫入條數。 */
		restore: async (payload) => {
			// 外部 JSON 邊界：只宣告要讀的 data 欄位，欄位內部仍逐項窄化。
			const data = (payload as { data?: unknown } | null)?.data;
			if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("備份格式不正確");
			const backup = data as Record<string, unknown>;
			const counts: Record<string, number> = {};
			const list = (key: string) => rows(backup[key]);

			for (const m of list("memories")) {
				const content = str(m.content).trim();
				if (!content) continue;
				if (memoryRepo.existsByContent(sql, content)) continue;
				memoryRepo.insertRestored(sql, {
					content,
					createdAt: str(m.created_at) || now(),
					source: str(m.source) || "manual",
				});
				counts.memories = (counts.memories ?? 0) + 1;
			}
			for (const f of list("files")) {
				const name = str(f.name).trim();
				if (!name) continue;
				filesRepo.restoreRow(sql, {
					conversation_id: str(f.conversation_id) || "1",
					name,
					content: str(f.content),
					updated_at: str(f.updated_at) || now(),
				});
				counts.files = (counts.files ?? 0) + 1;
			}
			for (const a of list("automations")) {
				const id = str(a.id);
				if (!id) continue;
				automationsRepo.restoreRow(
					sql,
					{
						id,
						name: str(a.name),
						prompt: str(a.prompt),
						session_id: str(a.session_id),
						schedule: str(a.schedule) || '{"kind":"daily","time":"09:00"}',
						enabled: num(a.enabled) ? 1 : 0,
						next_run_at: num(a.next_run_at) || Date.now() + 60_000,
					},
					now(),
				);
				counts.automations = (counts.automations ?? 0) + 1;
			}
			for (const k of list("skills")) {
				const name = str(k.name).trim();
				if (!name) continue;
				skillsRepo.restoreRow(sql, { name, description: str(k.description), content: str(k.content) }, now());
				counts.skills = (counts.skills ?? 0) + 1;
			}
			// 知識庫只備份文件正文；恢復時分塊並重建 FTS 索引（v0.45.0）
			for (const doc of list("kbDocs")) {
				const title = str(doc.title).trim();
				const content = str(doc.content).trim();
				if (!title || !content) continue;
				if (kb.hasDoc(title, content)) continue;
				const restored = await kb.add({ title, content, source: str(doc.source), tags: str(doc.tags) });
				if (restored.updated) counts.kbDocs = (counts.kbDocs ?? 0) + 1;
			}
			for (const s of list("mcpServers")) {
				const id = str(s.id);
				if (!id) continue;
				const incoming = str(s.headers) || "{}";
				const existing = mcpRepo.listConfigured(sql).find((row) => row.id === id);
				mcpRepo.restoreRow(
					sql,
					{ id, name: str(s.name), url: str(s.url), headers: mergeHeaders(incoming, existing?.headers) },
					now(),
				);
				counts.mcpServers = (counts.mcpServers ?? 0) + 1;
			}
			for (const s of list("settings")) {
				const key = str(s.key).trim();
				if (!key) continue;
				settingsRepo.restoreRow(sql, { key, value: str(s.value) });
				counts.settings = (counts.settings ?? 0) + 1;
			}
			for (const pr of list("prompts")) {
				const name = str(pr.name).trim();
				if (!name) continue;
				promptsRepo.restorePrompt(sql, { name, description: str(pr.description), content: str(pr.content) }, now());
				counts.prompts = (counts.prompts ?? 0) + 1;
			}
			for (const rl of list("rules")) {
				const name = str(rl.name).trim();
				if (!name) continue;
				promptsRepo.restoreRule(sql, { name, content: str(rl.content), enabled: num(rl.enabled) ? 1 : 0 }, now());
				counts.rules = (counts.rules ?? 0) + 1;
			}
			for (const g of list("goals")) {
				const sid = str(g.session_id).trim();
				const objective = str(g.objective).trim();
				if (!sid || !objective) continue;
				goalsRepo.restoreRow(
					sql,
					{
						session_id: sid,
						objective,
						status: str(g.status) || "paused",
						token_budget: num(g.token_budget) || GOAL_TOKEN_BUDGET_DEFAULT,
						baseline_tokens: num(g.baseline_tokens),
						tokens_used: num(g.tokens_used),
						turns: num(g.turns),
						max_turns: num(g.max_turns) || GOAL_MAX_TURNS_DEFAULT,
						summary: str(g.summary),
						next_run_at: num(g.next_run_at),
						created_at: str(g.created_at) || now(),
					},
					now(),
				);
				counts.goals = (counts.goals ?? 0) + 1;
			}
			for (const p of list("providers")) {
				const id = str(p.id).trim();
				if (!id) continue;
				providersRepo.restoreRow(
					sql,
					{
						id,
						name: str(p.name),
						base_url: str(p.base_url),
						// 備份裡金鑰已被摘除：空值沿用庫裡已有的金鑰
						api_key: str(p.api_key) || providersRepo.find(sql, id)?.api_key || "",
						models: str(p.models),
					},
					now(),
				);
				counts.providers = (counts.providers ?? 0) + 1;
			}
			for (const p of list("plans")) {
				const conversationId = str(p.conversation_id);
				if (!conversationId) continue;
				plansRepo.restoreRow(sql, {
					conversation_id: conversationId,
					steps: str(p.steps) || "[]",
					updated_at: str(p.updated_at) || now(),
				});
				counts.plans = (counts.plans ?? 0) + 1;
			}
			for (const s of list("sessions")) {
				const id = str(s.id);
				if (!id) continue;
				sessionsRepo.restoreRow(sql, {
					id,
					title: str(s.title) || `會話 ${id}`,
					created_at: str(s.created_at) || now(),
					updated_at: str(s.updated_at) || now(),
					model: str(s.model) || "",
				});
				counts.sessions = (counts.sessions ?? 0) + 1;
			}
			// 全部資料落庫後再重建擴充套件與重排鬧鐘：settings / prompts / MCP 都已是恢復後的狀態。
			await runtime.afterRestore();
			// 恢復後可能帶回進行中的目標：重排鬧鐘（與舊 restore 的順序一致，放在最後）
			await alarm.schedule();
			return counts;
		},

		exportMarkdown: async (sessionId) => {
			const snapshot = await runtime.exportSnapshot(sessionId);
			return renderExportMarkdown(snapshot, now());
		},

		reflect: async (sessionId) => ({ ok: true, saved: await runtime.reflect(sessionId) }),
	};
}

