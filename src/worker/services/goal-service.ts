import type { SqlHandle } from "../db/migrations";
import type { GoalRuntime } from "../http/ports";
import * as goalsRepo from "../repo/goals-repo";
import type { GoalPatch, GoalRow, GoalStatus } from "../repo/goals-repo";

/**
 * 目標模式用例（ADR-0001 §2）：`/goal*` 端點與 set_goal / complete_goal / report_goal 共用。
 * alarm 的續轉排程判斷在 services/automation-service.ts；這裡只維護目標行與提示詞。
 */
export type { GoalRow, GoalStatus, GoalPatch };

export const GOAL_TOKEN_BUDGET_DEFAULT = 200_000;
export const GOAL_MAX_TURNS_DEFAULT = 12;
/** 單次請求內最多自動續轉幾輪；剩下的交給 alarm 跨請求接續。 */
export const GOAL_ROUNDS_PER_REQUEST = 3;

export function readGoal(sql: SqlHandle, sessionId: string): GoalRow | null {
	return goalsRepo.get(sql, sessionId);
}

/** 對外（前端 / SSE）的目標檢視。 */
export type GoalView = {
	objective: string;
	status: GoalStatus;
	tokenBudget: number;
	tokensUsed: number;
	turns: number;
	maxTurns: number;
	summary?: string;
	updatedAt: string;
};

export function goalInfo(row: GoalRow | null): GoalView | null {
	if (!row) return null;
	return {
		objective: row.objective,
		status: row.status,
		tokenBudget: row.token_budget,
		tokensUsed: row.tokens_used,
		turns: row.turns,
		maxTurns: row.max_turns,
		summary: row.summary || undefined,
		updatedAt: row.updated_at,
	};
}

export function writeGoal(sql: SqlHandle, sessionId: string, patch: GoalPatch): void {
	goalsRepo.update(sql, sessionId, patch);
}

export function startGoal(
	sql: SqlHandle,
	input: { sessionId: string; objective: string; tokenBudget: number; maxTurns: number; baseline: number },
): void {
	goalsRepo.start(sql, { ...input, now: new Date().toISOString() });
}

/** instructions 裡的「目標模式（進行中）」段；無進行中目標時為空串。 */
export function goalInstructionsBlock(row: GoalRow | null): string {
	if (!row || row.status !== "active") return "";
	return `\n\n## 目標模式（進行中）\n目標：${row.objective}\n進度：第 ${row.turns + 1} 輪，已用 ${row.tokens_used} / ${row.token_budget} tokens。\n- 這一輪必須有實際進展，不要只回復「繼續」。\n- 全部達成後呼叫 complete_goal，並附可核對的證據。\n- 確實無法推進時呼叫 report_goal 說明阻塞原因。`;
}

/** 自動續轉的提示詞：強調「直接做」，避免模型空轉。 */
export function goalContinuePrompt(row: GoalRow): string {
	return [
		`繼續推進目標：${row.objective}`,
		"",
		`進度：已完成 ${row.turns} 輪，已用 ${row.tokens_used} / ${row.token_budget} tokens。`,
		"要求：",
		"- 先看計劃和已有產出，不要重複已經做過的工作，直接做下一步。",
		"- 不要只回復「繼續」之類的話，這一輪必須有實際進展。",
		"- 全部達成後呼叫 complete_goal，並給出可核對的驗證證據。",
		"- 確實無法推進時呼叫 report_goal 說明阻塞原因。",
	].join("\n");
}

/** 規範化 POST /goal 的預算與輪次（舊端點口徑）。 */
export function normalizeGoalLimits(tokenBudget?: number, maxTurns?: number) {
	return {
		budget: Math.max(
			10_000,
			Math.floor(Number(tokenBudget ?? GOAL_TOKEN_BUDGET_DEFAULT) || GOAL_TOKEN_BUDGET_DEFAULT),
		),
		turns: Math.min(
			50,
			Math.max(1, Math.floor(Number(maxTurns ?? GOAL_MAX_TURNS_DEFAULT) || GOAL_MAX_TURNS_DEFAULT)),
		),
	};
}

export type GoalServiceDeps = { sql: SqlHandle; runtime: GoalRuntime };

export interface GoalService {
	view(sessionId: string): GoalView | null;
	pause(sessionId: string): GoalView | null;
	create(sessionId: string, objective: string, tokenBudget?: number, maxTurns?: number): Promise<GoalView | null>;
}

export function createGoalService({ sql, runtime }: GoalServiceDeps): GoalService {
	return {
		view: (sessionId) => goalInfo(readGoal(sql, sessionId)),
		pause(sessionId) {
			writeGoal(sql, sessionId, { status: "paused", next_run_at: 0 });
			return goalInfo(readGoal(sql, sessionId));
		},
		async create(sessionId, objective, tokenBudget, maxTurns) {
			const { budget, turns } = normalizeGoalLimits(tokenBudget, maxTurns);
			const baseline = await runtime.baselineTokens(sessionId);
			startGoal(sql, { sessionId, objective, tokenBudget: budget, maxTurns: turns, baseline });
			return goalInfo(readGoal(sql, sessionId));
		},
	};
}
