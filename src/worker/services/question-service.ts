import type { SqlHandle } from "../db/migrations";
import { AppError, defaultErrorCode } from "../http/errors";
import * as questionsRepo from "../repo/questions-repo";

/**
 * 互動式問答用例（ADR-0001 §2）：ask_user 落庫與 `/questions` 回答編排。
 * 端點失敗體保留 `{ ok:false, error }` 相容欄位，統一經 `toResponse` 輸出（NERE-79）。
 */
export type AskOption = { label: string; description?: string; recommended?: boolean };
export type AskItem = { id: string; question: string; options?: AskOption[]; allowText?: boolean };
export type AskPayload = { title?: string; questions: AskItem[] };
export type QuestionAnswer = { id?: string; choice?: string; text?: string };

/** 待回答的問題清單（GET /questions、/bootstrap 共用）。 */
export function listPending(sql: SqlHandle, sessionId: string) {
	return questionsRepo.listPending(sql, sessionId).map((row) => ({
		id: row.id,
		created_at: row.created_at,
		...(JSON.parse(row.payload) as AskPayload),
	}));
}

/** 最近一條待回答問題；目標續轉據此暫停。損壞的 payload 視為沒有問題。 */
export function readPending(sql: SqlHandle, sessionId: string): { id: number; payload: AskPayload } | null {
	try {
		const row = questionsRepo.latestPending(sql, sessionId);
		if (!row) return null;
		return { id: row.id, payload: JSON.parse(row.payload) as AskPayload };
	} catch {
		return null;
	}
}

/** 工具 ask_user 落庫；失敗不阻塞工具（返回 null）。 */
export function record(sql: SqlHandle, sessionId: string, payload: AskPayload): number | null {
	try {
		return questionsRepo.insert(sql, {
			sessionId,
			payload: JSON.stringify(payload),
			now: new Date().toISOString(),
		});
	} catch {
		return null;
	}
}

export class QuestionApiError extends AppError {
	constructor(status: number, message: string, code = defaultErrorCode(status)) {
		super(code, status, message);
		this.name = "QuestionApiError";
	}
}

export type QuestionResolution = { ok: true; id: number; resume: string };

export function answer(sql: SqlHandle, rawId: unknown, answers: QuestionAnswer[] | undefined): QuestionResolution {
	const id = Math.floor(Number(rawId));
	if (!Number.isFinite(id) || id <= 0) throw new QuestionApiError(400, "缺少問題 id");
	const row = questionsRepo.get(sql, id);
	if (!row) throw new QuestionApiError(404, "問題不存在");
	if (row.status !== "pending") throw new QuestionApiError(409, "該問題已回答");
	const payload = JSON.parse(row.payload) as AskPayload;
	const given = Array.isArray(answers) ? answers : [];
	const lines: string[] = [];
	for (const q of payload.questions) {
		const hit = given.find((a) => String(a.id ?? "") === q.id);
		const choice = String(hit?.choice ?? "").trim();
		const text = String(hit?.text ?? "").trim();
		const answer = text || choice || "（未回答）";
		lines.push(`- ${q.id}「${q.question}」：${answer}`);
	}
	if (!lines.length) throw new QuestionApiError(400, "沒有有效回答");
	questionsRepo.markAnswered(sql, id, new Date().toISOString());
	const resume = `使用者回答了你的問題${payload.title ? `（${payload.title}）` : ""}：\n${lines.join("\n")}\n\n請據此繼續。`;
	return { ok: true, id, resume };
}
