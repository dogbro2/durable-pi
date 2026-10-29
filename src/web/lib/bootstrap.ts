/**
 * /api/bootstrap 響應 → 各面板的領域模型（NERE-26）。
 *
 * 後端（NERE-23）已經做了一層逐面板容錯：失敗的陣列面板回退 `[]`、物件面板回退 `null`，
 * 原因寫進 `errors`。這裡再做一次寬容解析，職責有兩個：
 * 1. 把傳輸層 DTO 收斂成 `types.ts` 的領域型別，元件不直接認識介面欄位；
 * 2. 後端欄位缺失 / 舊版本沒有聚合端點時，依然得到可渲染的空態，而不是讓整頁崩掉。
 *
 * 注意：`errors` 只做轉發，不在這裡拼接 UI 文案（文案屬於頁面層）。
 */

import type {
	AskQuestion,
	ApprovalInfo,
	AutomationInfo,
	CustomToolInfo,
	FileInfo,
	GoalInfo,
	McpServerInfo,
	MemoryInfo,
	PlanStep,
	PromptInfo,
	RuleInfo,
	SessionListItem,
	SkillInfo,
} from "../types";
import type { BootstrapKey, BootstrapResponse, ModelsView, SettingsView } from "./api";
import {
	parseAutomations,
	parseCustomTools,
	parseFiles,
	parseMemories,
	parsePrompts,
	parseRules,
	parseSessions,
	parseSkills,
} from "./collections";

export interface BootstrapPanels {
	session: { ok: boolean; name: string };
	entries: unknown[];
	sessions: SessionListItem[];
	files: FileInfo[];
	memories: MemoryInfo[];
	approvals: ApprovalInfo[];
	settings: SettingsView | null;
	plan: PlanStep[];
	goal: GoalInfo | null;
	questions: AskQuestion[];
	prompts: PromptInfo[];
	rules: RuleInfo[];
	customTools: CustomToolInfo[];
	skills: SkillInfo[];
	automations: AutomationInfo[];
	mcpServers: McpServerInfo[];
	models: { models: string[]; default: string };
	/** 後端記錄的失敗面板：鍵是面板名，值是截斷後的錯誤摘要。 */
	errors: Partial<Record<BootstrapKey, string>>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function records(raw: unknown): Record<string, unknown>[] {
	return (Array.isArray(raw) ? raw : []).filter(isObject);
}

function parseSession(raw: BootstrapResponse["session"]): { ok: boolean; name: string } {
	if (!isObject(raw)) return { ok: false, name: "" };
	return { ok: raw.ok !== false, name: text(raw.name) };
}

/** 相容舊後端：entries 可能是陣列本身，也可能包在 `{ entries: [...] }` 裡。 */
function parseEntryList(raw: unknown): unknown[] {
	if (Array.isArray(raw)) return raw;
	if (isObject(raw) && Array.isArray(raw.entries)) return raw.entries;
	return [];
}

function parsePlan(raw: unknown): PlanStep[] {
	const steps: PlanStep[] = [];
	for (const entry of records(raw)) {
		const title = text(entry.title).trim();
		if (!title) continue;
		const status = entry.status === "completed" || entry.status === "in_progress" ? entry.status : "pending";
		steps.push({ title, status });
	}
	return steps;
}

function parseGoal(raw: unknown): GoalInfo | null {
	if (!isObject(raw) || typeof raw.objective !== "string") return null;
	const statuses: GoalInfo["status"][] = ["active", "done", "blocked", "paused", "exhausted"];
	const status = statuses.find((value) => value === raw.status) ?? "active";
	return {
		objective: raw.objective,
		status,
		tokenBudget: num(raw.tokenBudget),
		tokensUsed: num(raw.tokensUsed),
		turns: num(raw.turns),
		maxTurns: num(raw.maxTurns),
		summary: typeof raw.summary === "string" ? raw.summary : undefined,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
	};
}

function parseApprovals(raw: unknown): ApprovalInfo[] {
	const approvals: ApprovalInfo[] = [];
	for (const entry of records(raw)) {
		if (typeof entry.id !== "number" || typeof entry.tool !== "string") continue;
		approvals.push({
			id: entry.id,
			tool: entry.tool,
			category: text(entry.category),
			args: text(entry.args),
			created_at: text(entry.created_at),
		});
	}
	return approvals;
}

function parseQuestions(raw: unknown): AskQuestion[] {
	const questions: AskQuestion[] = [];
	for (const entry of records(raw)) {
		if (typeof entry.id !== "number" || !Array.isArray(entry.questions)) continue;
		questions.push({
			id: entry.id,
			title: typeof entry.title === "string" ? entry.title : undefined,
			questions: entry.questions as AskQuestion["questions"],
			created_at: typeof entry.created_at === "string" ? entry.created_at : undefined,
		});
	}
	return questions;
}

function parseMcpServers(raw: unknown): McpServerInfo[] {
	const servers: McpServerInfo[] = [];
	for (const entry of records(raw)) {
		const name = text(entry.name);
		const url = text(entry.url);
		if (!name || !url) continue;
		const created = typeof entry.created_at === "string" ? entry.created_at : undefined;
		servers.push({ id: String(entry.id ?? ""), name, url, created_at: created });
	}
	return servers;
}

function parseModels(raw: ModelsView | null): { models: string[]; default: string } {
	if (!isObject(raw)) return { models: [], default: "" };
	const models = Array.isArray(raw.models) ? raw.models.filter((model): model is string => typeof model === "string") : [];
	const fallback = text(raw.default);
	return { models, default: fallback || models[0] || "" };
}

function parseErrors(raw: BootstrapResponse["errors"]): Partial<Record<BootstrapKey, string>> {
	if (!isObject(raw)) return {};
	const errors: Partial<Record<BootstrapKey, string>> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string" && value) errors[key as BootstrapKey] = value;
	}
	return errors;
}

export function parseBootstrap(raw: BootstrapResponse): BootstrapPanels {
	return {
		session: parseSession(raw.session),
		entries: parseEntryList(raw.entries),
		sessions: parseSessions(raw.sessions),
		files: parseFiles(raw.files),
		memories: parseMemories(raw.memories),
		approvals: parseApprovals(raw.approvals),
		settings: isObject(raw.settings) ? (raw.settings as SettingsView) : null,
		plan: parsePlan(raw.plan),
		goal: parseGoal(raw.goal),
		questions: parseQuestions(raw.questions),
		prompts: parsePrompts(raw.prompts),
		rules: parseRules(raw.rules),
		customTools: parseCustomTools(raw.customTools),
		skills: parseSkills(raw.skills),
		automations: parseAutomations(raw.automations),
		mcpServers: parseMcpServers(raw.mcpServers),
		models: parseModels(raw.models),
		errors: parseErrors(raw.errors),
	};
}
