import type { SqlHandle } from "../db/migrations";
import { AppError, defaultErrorCode } from "../http/errors";
import * as automationsRepo from "../repo/automations-repo";
import * as goalsRepo from "../repo/goals-repo";

/**
 * 定時任務與 alarm 排程用例（ADR-0001 §2）：
 * `/automations*` 的 CRUD、下一次執行時間、到點篩選與順延、目標到點會話。
 *
 * `alarm()` 仍是 DO 入口（包 `agentScope.run`），這裡只做業務判斷；
 * 真正呼叫 `chat()` / 寫 `ctx.storage.setAlarm` 由 DO 組合根完成。
 */
export type Schedule = { kind: string; time?: string; minutes?: number };

const DAILY_DEFAULT: Schedule = { kind: "daily", time: "09:00" };

/** 計算下一次執行時間（毫秒）；daily 按 UTC+8 的 HH:MM。 */
export function nextRunAt(schedule: Schedule, now = Date.now()): number {
	if (schedule.kind === "interval") {
		const minutes = Math.max(1, Math.floor(Number(schedule.minutes ?? 60)));
		return now + minutes * 60_000;
	}
	const [hh, mm] = String(schedule.time ?? "09:00").split(":").map((v) => Number(v) || 0);
	const offsetMs = 8 * 3600_000;
	const local = new Date(now + offsetMs);
	const target = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hh!, mm!, 0));
	let at = target.getTime() - offsetMs;
	if (at <= now) at += 24 * 3600_000;
	return at;
}

export class AutomationApiError extends AppError {
	constructor(status: number, message: string, code = defaultErrorCode(status)) {
		super(code, status, message);
		this.name = "AutomationApiError";
	}
}

export type AutomationInput = {
	name?: string;
	prompt?: string;
	sessionId?: string;
	schedule?: { kind?: string; time?: string; minutes?: number };
};

/** PATCH 請求體（NERE-64）：欄位都可選，值來自 JSON，所以按 unknown 校驗。 */
export type AutomationPatchInput = {
	name?: unknown;
	prompt?: unknown;
	sessionId?: unknown;
	schedule?: unknown;
	enabled?: unknown;
	/** PATCH `fresh_session`（NERE-84）：每輪新建會話開關。 */
	fresh_session?: unknown;
};

/** PATCH 返回給前端的任務形態；`next_run_at` 與列表同一口徑。 */
export type AutomationView = {
	id: string;
	name: string;
	prompt: string;
	sessionId: string;
	schedule: Schedule;
	enabled: boolean;
	last_run_at: number | null;
	/** 上次執行結果（NERE-68）：ok / failed / deferred，老資料為 null。 */
	last_status: automationsRepo.AutomationLastStatus | null;
	/** 上次失敗原因（v1.0.4）：僅 failed 時有值，成功 / 順延 / 老資料為 null。 */
	last_error: string | null;
	/** 每輪新建會話（NERE-84）：1 = 不繼承歷史，0 = 固定使用 `sessionId`。 */
	fresh_session: boolean;
	/** 最近一次執行實際用的會話（NERE-84）；沒有執行過為 null。 */
	last_session_id: string | null;
	next_run_at: number;
};

export const AUTOMATION_NAME_MAX = 40;
export const AUTOMATION_PROMPT_MAX = 2000;
/** `last_error` 上限（NERE-84）：只留錯誤摘要，夠定位即可。 */
export const AUTOMATION_ERROR_MAX = 300;
const DAILY_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 編輯的排程校驗：不合法直接 400，不做 create 那種靜默兜底。 */
export function parseScheduleInput(raw: unknown): Schedule {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new AutomationApiError(400, "排程格式不正確");
	}
	const input = raw as { kind?: unknown; time?: unknown; minutes?: unknown };
	if (input.kind === "interval") {
		const minutes = Number(input.minutes);
		if (!Number.isInteger(minutes) || minutes < 1) throw new AutomationApiError(400, "間隔需為不小於 1 的整數分鐘");
		return { kind: "interval", minutes };
	}
	if (input.kind === "daily") {
		const time = typeof input.time === "string" ? input.time.trim() : "";
		if (!DAILY_TIME.test(time)) throw new AutomationApiError(400, "時間需為 HH:MM（24 小時制）");
		return { kind: "daily", time };
	}
	throw new AutomationApiError(400, "排程型別需為 daily 或 interval");
}

/**
 * 校驗 PATCH 並算出倉儲增量（純函式，便於單測）。
 * - 只校驗傳入的欄位，未傳的不動；
 * - 傳了 schedule → `next_run_at = nextRunAt(newSchedule)`；
 * - 只傳 enabled → 沿用舊啟停語義（啟用時 next_run_at = now+60s，停用不動）；
 * - 傳了其他欄位時即使帶了 enabled 也不改 next_run_at（編輯不該把任務提前到 60 秒後）。
 */
export function buildAutomationPatch(body: AutomationPatchInput, now = Date.now()): automationsRepo.AutomationUpdate {
	const patch: automationsRepo.AutomationUpdate = {};
	if (body.name !== undefined) {
		if (typeof body.name !== "string") throw new AutomationApiError(400, "名稱需為字串");
		const name = body.name.trim();
		if (!name || name.length > AUTOMATION_NAME_MAX) {
			throw new AutomationApiError(400, `名稱需為 1–${AUTOMATION_NAME_MAX} 個字元`);
		}
		patch.name = name;
	}
	if (body.prompt !== undefined) {
		if (typeof body.prompt !== "string") throw new AutomationApiError(400, "提示詞需為字串");
		const prompt = body.prompt.trim();
		if (!prompt || prompt.length > AUTOMATION_PROMPT_MAX) {
			throw new AutomationApiError(400, `提示詞需為 1–${AUTOMATION_PROMPT_MAX} 個字元`);
		}
		patch.prompt = prompt;
	}
	if (body.sessionId !== undefined) {
		if (typeof body.sessionId !== "string") throw new AutomationApiError(400, "會話 ID 需為字串");
		patch.sessionId = body.sessionId;
	}
	let schedule: Schedule | undefined;
	if (body.schedule !== undefined) {
		schedule = parseScheduleInput(body.schedule);
		patch.schedule = JSON.stringify(schedule);
	}
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== "boolean") throw new AutomationApiError(400, "enabled 需為布林值");
		patch.enabled = body.enabled;
	}
	if (body.fresh_session !== undefined) {
		if (typeof body.fresh_session !== "boolean") throw new AutomationApiError(400, "fresh_session 需為布林值");
		patch.freshSession = body.fresh_session;
	}

	const onlyEnabled =
		body.enabled !== undefined &&
		body.name === undefined &&
		body.prompt === undefined &&
		body.sessionId === undefined &&
		body.schedule === undefined &&
		body.fresh_session === undefined;
	if (schedule) patch.nextRunAt = nextRunAt(schedule, now);
	else if (onlyEnabled && body.enabled === true) patch.nextRunAt = now + 60_000;
	return patch;
}

function parseStoredSchedule(raw: string): Schedule {
	try {
		const value = JSON.parse(raw) as Schedule;
		return value && typeof value === "object" ? value : DAILY_DEFAULT;
	} catch {
		return DAILY_DEFAULT;
	}
}

export function automationView(row: automationsRepo.AutomationRow): AutomationView {
	return {
		id: row.id,
		name: row.name,
		prompt: row.prompt,
		sessionId: row.session_id,
		schedule: parseStoredSchedule(row.schedule),
		enabled: row.enabled === 1,
		last_run_at: row.last_run_at,
		last_status: automationsRepo.parseLastStatus(row.last_status),
		last_error: row.last_error ?? null,
		fresh_session: row.fresh_session === 1,
		last_session_id: row.last_session_id ?? null,
		next_run_at: row.next_run_at,
	};
}

export type AutomationService = {
	list(): automationsRepo.AutomationRow[];
	create(body: AutomationInput): { id: string; nextRunAt: number };
	/** 編輯 / 啟停（NERE-64）；只傳 enabled 時與舊行為一致。 */
	update(id: string, body: AutomationPatchInput, now?: number): AutomationView;
	remove(id: string): void;
	/** alarm：到點且啟用的任務。 */
	due(now: number): automationsRepo.AutomationDueRow[];
	/** 會話忙：順延 5 分鐘，只記 `last_status = deferred`（不改 last_run_at）。 */
	defer(id: string, now: number): void;
	/** 執行完一輪：寫 last_run_at、last_status（ok / failed）、last_session_id 與下一次 next_run_at；失敗附原因（v1.0.4）。 */
	markRun(
		job: { id: string; schedule: string },
		now: number,
		status: "ok" | "failed",
		error?: string,
		sessionId?: string | null,
	): void;
	/** 把任務繫結到實際執行的會話（NERE-84，fresh_session 輪換時呼叫）。 */
	bindSession(id: string, sessionId: string): void;
	/** 本輪處理過任務時，把仍落在過去的時間統一順延 60s。 */
	rescheduleOverdue(now: number): void;
	/** alarm：到點且 active 的目標會話。 */
	dueGoals(now: number): string[];
	/** 目標忙：順延 60s。 */
	deferGoal(sessionId: string, now: number): void;
	/** 任務與目標中最早的鬧鐘時刻；沒有返回 null。 */
	nextAlarmAt(): number | null;
};

/** alarm 每輪需要的執行埠：新建會話、會話忙判斷、提交一輪、失敗後的會話恢復。 */
export type AutomationRunner = {
	/** 新建一個空會話並返回 id（NERE-84，複用 `/sessions` 的建立路徑）。 */
	createSession(): Promise<string>;
	hasActive(sessionId: string): boolean;
	run(job: automationsRepo.AutomationDueRow): Promise<void>;
	recover(): Promise<void>;
};

/**
 * 執行一輪到點任務（NERE-68 三態 + NERE-84 會話隔離）：
 * - `fresh_session = 1` → 先新建空會話並繫結到任務（`session_id` / `last_session_id`），
 *   失敗原因與歷史長度無關，也不會在下一輪繼續累積；
 * - 會話忙 → `deferred` 且不改 last_run_at（順延不算一次執行）；
 * - 成功 → `ok`；異常 → `failed`（console.warn 保留，原因寫入 last_error），兩者都更新 last_run_at；
 * - 單個任務的異常不外拋，後續任務照常執行。
 */
export async function runDueAutomations(
	jobs: readonly automationsRepo.AutomationDueRow[],
	now: number,
	service: Pick<AutomationService, "defer" | "markRun" | "bindSession">,
	runner: AutomationRunner,
): Promise<void> {
	for (const job of jobs) {
		let sessionId = job.session_id || "1";
		if (job.fresh_session === 1) {
			// 新建會話失敗（Harness/儲存故障）→ 記 failed 但保留原會話繫結，下一輪重新嘗試。
			try {
				sessionId = await runner.createSession();
				service.bindSession(job.id, sessionId);
			} catch (err) {
				console.warn(`automation ${job.id} create session failed`, String(err).slice(0, 200));
				service.markRun(job, now, "failed", String(err));
				continue;
			}
		}
		// 會話正忙時跳過這一輪，避免併發 submit 破壞會話狀態（v0.17.1）
		if (runner.hasActive(sessionId)) {
			service.defer(job.id, now);
			continue;
		}
		let status: "ok" | "failed" = "ok";
		let error: string | undefined;
		try {
			await runner.run({ ...job, session_id: sessionId });
		} catch (err) {
			console.warn(`automation ${job.id} failed`, String(err).slice(0, 200));
			status = "failed";
			// 失敗原因落庫（v1.0.4）：console.warn 會丟，SQL 裡要能查到當時為什麼失敗。
			error = String(err);
			// recover 失敗不能吞掉本次執行結果，也不能中斷後續任務。
			try {
				await runner.recover();
			} catch (recoverErr) {
				console.warn(`automation ${job.id} recover failed`, String(recoverErr).slice(0, 200));
			}
		}
		service.markRun(job, now, status, error, sessionId);
	}
}

export function createAutomationService(sql: SqlHandle): AutomationService {
	return {
		list: () => automationsRepo.list(sql),

		create(body) {
			const name = (body.name ?? "").trim().slice(0, 40);
			const prompt = (body.prompt ?? "").trim().slice(0, 2000);
			if (!name || !prompt) throw new AutomationApiError(400, "需要名稱與提示詞");
			const schedule: Schedule =
				body.schedule?.kind === "interval"
					? { kind: "interval", minutes: Math.max(1, Math.floor(Number(body.schedule.minutes ?? 60))) }
					: {
							kind: "daily",
							time: /^\d{1,2}:\d{2}$/.test(body.schedule?.time ?? "") ? body.schedule!.time! : "09:00",
						};
			const id = `a${Date.now().toString(36)}`;
			const at = nextRunAt(schedule);
			automationsRepo.insert(sql, {
				id,
				name,
				prompt,
				sessionId: body.sessionId ?? "",
				schedule: JSON.stringify(schedule),
				nextRunAt: at,
				createdAt: new Date().toISOString(),
			});
			return { id, nextRunAt: at };
		},

		update(id, body, now = Date.now()) {
			if (!id) throw new AutomationApiError(400, "缺少 id");
			const patch = buildAutomationPatch(body, now);
			if (!automationsRepo.get(sql, id)) throw new AutomationApiError(404, "任務不存在");
			automationsRepo.update(sql, id, patch);
			return automationView(automationsRepo.get(sql, id)!);
		},

		remove(id) {
			automationsRepo.remove(sql, id);
		},

		due: (now) => automationsRepo.listDue(sql, now),

		defer(id, now) {
			automationsRepo.markDeferred(sql, id, now + 5 * 60_000);
		},

		markRun(job, now, status, error, sessionId) {
			let schedule: Schedule = DAILY_DEFAULT;
			try {
				schedule = JSON.parse(job.schedule) as Schedule;
			} catch {
				// 保持預設
			}
			const summary = error ? error.slice(0, AUTOMATION_ERROR_MAX) : null;
			automationsRepo.markRun(sql, job.id, now, nextRunAt(schedule, Date.now()), status, summary, sessionId);
		},

		bindSession(id, sessionId) {
			automationsRepo.bindSession(sql, id, sessionId);
		},

		rescheduleOverdue(now) {
			automationsRepo.rescheduleOverdue(sql, now, now + 60_000);
		},

		dueGoals: (now) => goalsRepo.listDue(sql, now),

		deferGoal(sessionId, now) {
			goalsRepo.update(sql, sessionId, { next_run_at: now + 60_000 });
		},

		nextAlarmAt() {
			const candidates = [automationsRepo.nextScheduledAt(sql), goalsRepo.nextScheduledAt(sql)].filter(
				(value): value is number => typeof value === "number" && Number.isFinite(value),
			);
			return candidates.length ? Math.min(...candidates) : null;
		},
	};
}
