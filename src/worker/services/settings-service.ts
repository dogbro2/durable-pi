import type { SqlHandle } from "../db/migrations";
import { AppError, defaultErrorCode } from "../http/errors";
import { KB_VECTOR_DEFAULT_INDEX } from "./kb-service";
import { MAX_SHARE_TTL, shareDefaultTtl } from "./share-service";
import * as providersRepo from "../repo/providers-repo";
import * as sessionsRepo from "../repo/sessions-repo";
import * as settingsRepo from "../repo/settings-repo";
import type { SettingsRuntime } from "../http/ports";

/**
 * 設定 / 供應商 / 模型域用例（ADR-0001 §2）：
 * - `app_settings` 的預設值與寫入口徑；
 * - `providers` 的金鑰回落、當前供應商、模型列表；
 * - 需要 Harness 重建的時機（壓縮策略、當前供應商）經 `runtime.recover()` 交給 DO。
 *
 * 端點契約逐字保持：`/settings`、`/providers*`、`/models`、`/model`。
 */

/** 讀取設定的函式形狀（DO 傳 `getSetting`，測試傳記憶體實現）。 */
export type GetSetting = (key: string, fallback: string) => string;

export type SettingsEnv = { AI?: unknown; KB_VEC?: unknown; CF_DISABLE_VECTOR?: string };

export type ApprovalPolicy = "allow" | "ask" | "deny";
export type ThinkingLevel = "off" | "low" | "high";

/** 與 pi-durable 內建預設一致，作為設定項的回落值。 */
export const DEFAULT_COMPACTION = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	backgroundTokens: 32768,
};

export type CompactionSettings = {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	backgroundTokens: number;
};

/** 思考檔位：off / low / high。 */
export function thinkingLevel(get: GetSetting): ThinkingLevel {
	const value = get("thinking_level", "low");
	return value === "off" || value === "high" ? value : "low";
}

export function compactionSettings(get: GetSetting): CompactionSettings {
	const num = (key: string, fallback: number, min: number) => {
		const value = Number(get(key, String(fallback)));
		return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
	};
	return {
		enabled: get("compaction_enabled", "1") === "1",
		reserveTokens: num("compaction_reserve", DEFAULT_COMPACTION.reserveTokens, 1024),
		keepRecentTokens: num("compaction_keep_recent", DEFAULT_COMPACTION.keepRecentTokens, 0),
		backgroundTokens: num("compaction_background", DEFAULT_COMPACTION.backgroundTokens, 0),
	};
}

/** 三檔策略（供設定頁、能力清單與審批閘門共用）。 */
export function approvalSettings(get: GetSetting): { read: ApprovalPolicy; write: ApprovalPolicy; exec: ApprovalPolicy } {
	const pick = (level: "read" | "write" | "exec"): ApprovalPolicy => {
		const value = get(`approval_${level}`, "allow");
		return value === "ask" || value === "deny" ? value : "allow";
	};
	return { read: pick("read"), write: pick("write"), exec: pick("exec") };
}

export type KbRetrievalMode = "fts" | "vector" | "hybrid";

export function kbRetrievalMode(get: GetSetting): KbRetrievalMode {
	const value = get("kb_retrieval", "fts");
	return value === "vector" || value === "hybrid" ? value : "fts";
}

export function vectorAvailable(env: SettingsEnv): boolean {
	if (env.CF_DISABLE_VECTOR === "1") return false;
	return Boolean(env.AI && env.KB_VEC);
}

/** 工具箱（搜尋 / 網頁抓取 / 自動記憶）：全部由 UI 設定，程式碼裡不再有硬編碼端點。 */
export type Toolbox = { baseUrl: string; apiKey: string; model: string };

export function toolboxSettings(get: GetSetting): Toolbox {
	return {
		baseUrl: get("tool_base_url", "").trim().replace(/\/+$/, ""),
		apiKey: get("tool_api_key", "").trim(),
		model: get("tool_model", "").trim(),
	};
}

export type ToolboxView = { baseUrl: string; hasKey: boolean; keyHint: string; model: string };

export type SettingsView = {
	webSearch: boolean;
	toolbox: ToolboxView;
	kbPrefetch: boolean;
	kbRetrieval: KbRetrievalMode;
	kbVector: { available: boolean; index: string };
	thinkingLevel: ThinkingLevel;
	compaction: CompactionSettings;
	approval: { read: ApprovalPolicy; write: ApprovalPolicy; exec: ApprovalPolicy };
	displayName: string;
	shareTtlSeconds: number;
};

/** GET /settings 的響應體；POST /settings 與 /bootstrap 複用，避免鍵漂移。 */
export function settingsView(get: GetSetting, env: SettingsEnv): SettingsView {
	const toolbox = toolboxSettings(get);
	return {
		webSearch: get("web_search", "1") === "1",
		toolbox: {
			baseUrl: toolbox.baseUrl,
			hasKey: Boolean(toolbox.apiKey),
			keyHint: toolbox.apiKey ? "••••" + toolbox.apiKey.slice(-4) : "",
			model: toolbox.model,
		},
		kbPrefetch: get("kb_prefetch", "1") === "1",
		kbRetrieval: kbRetrievalMode(get),
		kbVector: { available: vectorAvailable(env), index: KB_VECTOR_DEFAULT_INDEX },
		thinkingLevel: thinkingLevel(get),
		compaction: compactionSettings(get),
		approval: approvalSettings(get),
		displayName: get("display_name", ""),
		shareTtlSeconds: shareDefaultTtl({ get }),
	};
}

/* ---------------- 供應商與模型 ---------------- */

/**
 * 模型只來自 UI（`providers` 表）：沒有內建供應商、不讀環境變數裡的金鑰。
 * 未配置時一律返回空，聊天入口會給出「請先到 設定 → 模型 新增供應商」的提示。
 */
export const DEFAULT_MODEL_ID = "";

/** 顯式選中的供應商 id（未選為空串）。 */
export function activeProviderId(sql: SqlHandle): string {
	return settingsRepo.get(sql, "active_provider", "");
}

/**
 * 實際生效的供應商：顯式選中優先；只有一個供應商時即使沒選也用它；
 * 其餘情況返回 null（由聊天入口提示「尚未配置」），絕不回落到任何內建地址。
 */
function pickProvider(id: string, rows: providersRepo.ProviderRow[]): providersRepo.ProviderRow | null {
	if (id) {
		const hit = rows.find((r) => r.id === id);
		if (hit) return hit;
	}
	return rows.length === 1 ? rows[0] : null;
}

export function resolveProvider(sql: SqlHandle): providersRepo.ProviderRow | null {
	return pickProvider(activeProviderId(sql), providersRepo.list(sql));
}

/** 一次讀出「當前供應商 + 模型清單」：/models 與 /bootstrap 共用，避免重複查設定。 */
export function modelState(sql: SqlHandle): { provider: string; models: string[] } {
	const row = pickProvider(activeProviderId(sql), providersRepo.list(sql));
	return { provider: row?.id ?? "", models: row ? splitModels(row.models) : [] };
}

/** 實際生效的供應商 id（空串 = 尚未配置）。 */
export function effectiveProviderId(sql: SqlHandle): string {
	return resolveProvider(sql)?.id ?? "";
}

export function splitModels(raw: string): string[] {
	return raw
		.split(/[,，\s]+/)
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, 20);
}

/** 當前可用的模型 id 列表。 */
export function activeModelIds(sql: SqlHandle): string[] {
	return modelState(sql).models;
}

export type ProviderView = {
	id: string;
	name: string;
	baseUrl: string;
	models: string[];
	hasKey: boolean;
	keyHint: string;
	active: boolean;
};

export type ProviderInput = {
	id?: string;
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	models?: string | string[];
};

export type SettingsUpdateBody = {
	webSearch?: boolean;
	toolbox?: { baseUrl?: unknown; apiKey?: unknown; model?: unknown; clearKey?: unknown };
	kbPrefetch?: boolean;
	kbRetrieval?: string;
	thinkingLevel?: string;
	displayName?: string;
	shareTtlSeconds?: number;
	approval?: Record<string, unknown>;
	approvalTools?: Record<string, unknown>;
	compaction?: Record<string, unknown>;
};

/** 端點錯誤 -> Route 對映為 `{ error }` + status（與舊響應逐字一致）。 */
export class SettingsApiError extends AppError {
	constructor(status: number, message: string, code = defaultErrorCode(status)) {
		super(code, status, message);
		this.name = "SettingsApiError";
	}
}

export type SettingsServiceDeps = { sql: SqlHandle; env: SettingsEnv; runtime: SettingsRuntime };

export interface SettingsService {
	view(): SettingsView;
	update(body: SettingsUpdateBody): Promise<SettingsView>;
	listProviders(): { active: string; providers: ProviderView[] };
	saveProvider(input: ProviderInput): Promise<{ ok: true; id: string; models: string[] }>;
	removeProvider(id: string): Promise<{ ok: true }>;
	activate(id: string | undefined): Promise<{ ok: true; active: string; provider: string; models: string[] }>;
	models(): { models: string[]; default: string; provider: string };
	setModel(sessionId: string | undefined, modelId: string | undefined): void;
}

export function createSettingsService({ sql, env, runtime }: SettingsServiceDeps): SettingsService {
	const get: GetSetting = (key, fallback) => settingsRepo.get(sql, key, fallback);
	const set = (key: string, value: string) => settingsRepo.set(sql, key, value);

	return {
		view: () => settingsView(get, env),

		async update(body) {
			if (typeof body.webSearch === "boolean") set("web_search", body.webSearch ? "1" : "0");
			if (typeof body.kbPrefetch === "boolean") set("kb_prefetch", body.kbPrefetch ? "1" : "0");
			// 工具箱（v1.1.0）：搜尋 / 網頁抓取 / 自動記憶的端點與金鑰只在 UI 設定
			if (body.toolbox && typeof body.toolbox === "object") {
				const t = body.toolbox;
				if (typeof t.baseUrl === "string") {
					const baseUrl = t.baseUrl.trim().replace(/\/+$/, "");
					if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new SettingsApiError(400, "工具箱端點需以 http(s):// 開頭");
					set("tool_base_url", baseUrl);
				}
				if (t.clearKey === true) set("tool_api_key", "");
				const key = typeof t.apiKey === "string" ? t.apiKey.trim() : "";
				if (key) set("tool_api_key", key);
				if (typeof t.model === "string") set("tool_model", t.model.trim().slice(0, 80));
			}
			// 檢索模式（v0.53.0）：fts / vector / hybrid
			if (body.kbRetrieval === "fts" || body.kbRetrieval === "vector" || body.kbRetrieval === "hybrid") {
				set("kb_retrieval", body.kbRetrieval);
			}
			if (body.thinkingLevel === "off" || body.thinkingLevel === "low" || body.thinkingLevel === "high") {
				set("thinking_level", body.thinkingLevel);
			}
			// 分享頁署名與預設有效期（v0.55.0）
			if (typeof body.displayName === "string") set("display_name", body.displayName.trim().slice(0, 40));
			if (typeof body.shareTtlSeconds === "number" && Number.isFinite(body.shareTtlSeconds) && body.shareTtlSeconds >= 0) {
				set("share_ttl_seconds", String(Math.min(Math.floor(body.shareTtlSeconds), MAX_SHARE_TTL)));
			}
			// 工具審批（v0.33.0）：三檔策略 + 逐工具覆蓋
			if (body.approval && typeof body.approval === "object") {
				for (const level of ["read", "write", "exec"] as const) {
					const value = body.approval[level];
					if (value === "allow" || value === "ask" || value === "deny") set(`approval_${level}`, value);
				}
			}
			if (body.approvalTools && typeof body.approvalTools === "object") {
				for (const [name, value] of Object.entries(body.approvalTools)) {
					if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(name)) continue;
					if (value === "follow" || value === "allow" || value === "ask" || value === "deny") {
						set(`approval_tool_${name}`, value);
					}
				}
			}
			let compactionChanged = false;
			if (body.compaction && typeof body.compaction === "object") {
				const c = body.compaction;
				if (typeof c.enabled === "boolean") {
					set("compaction_enabled", c.enabled ? "1" : "0");
					compactionChanged = true;
				}
				for (const [patchKey, settingKey, min] of [
					["reserveTokens", "compaction_reserve", 1024],
					["keepRecentTokens", "compaction_keep_recent", 0],
					["backgroundTokens", "compaction_background", 0],
				] as const) {
					const raw = Number(c[patchKey]);
					if (Number.isFinite(raw) && raw >= min) {
						set(settingKey, String(Math.floor(raw)));
						compactionChanged = true;
					}
				}
			}
			// 壓縮策略在 Harness.open 時讀取，改了要重建（先寫庫後重建）。
			if (compactionChanged) await runtime.recover();
			return settingsView(get, env);
		},

		listProviders() {
			const active = effectiveProviderId(sql);
			const rows = providersRepo.list(sql).map((r) => ({
				id: r.id,
				name: r.name,
				baseUrl: r.base_url,
				models: splitModels(r.models),
				hasKey: Boolean(r.api_key),
				keyHint: r.api_key ? "••••" + r.api_key.slice(-4) : "",
				active: r.id === active,
			}));
			return { active, providers: rows };
		},

		async saveProvider(body) {
			const name = (body.name ?? "").trim().slice(0, 40);
			const baseUrl = (body.baseUrl ?? "").trim().replace(/\/+$/, "");
			if (!name || !/^https?:\/\//.test(baseUrl)) throw new SettingsApiError(400, "需要名稱與 http(s) 地址");
			const modelList = (Array.isArray(body.models) ? body.models : splitModels(String(body.models ?? "")))
				.map((m) => String(m).trim())
				.filter(Boolean)
				.slice(0, 20);
			const id =
				(body.id ?? "").trim() ||
				baseUrl.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().slice(0, 24) ||
				"p" + Date.now().toString(36);
			const existing = providersRepo.find(sql, id);
			// 編輯時 apiKey 留空 = 保留原金鑰
			const apiKey = (body.apiKey ?? "").trim() || existing?.api_key || "";
			if (!apiKey) throw new SettingsApiError(400, "需要 API Key");
			providersRepo.upsert(sql, {
				id,
				name,
				base_url: baseUrl,
				api_key: apiKey,
				models: modelList.join(","),
				createdAt: new Date().toISOString(),
			});
			if (activeProviderId(sql) === id) await runtime.recover();
			return { ok: true as const, id, models: modelList };
		},

		async removeProvider(id) {
			providersRepo.remove(sql, id);
			if (activeProviderId(sql) === id) set("active_provider", "");
			await runtime.recover();
			return { ok: true as const };
		},

		async activate(rawId) {
			const id = (rawId ?? "").trim();
			if (id && !providersRepo.find(sql, id)) throw new SettingsApiError(404, "供應商不存在");
			set("active_provider", id);
			await runtime.recover();
			return {
				ok: true as const,
				active: id,
				provider: effectiveProviderId(sql),
				models: activeModelIds(sql),
			};
		},

		models() {
			const available = modelState(sql).models;
			return {
				models: available,
				default: available[0] ?? DEFAULT_MODEL_ID,
				provider: effectiveProviderId(sql),
			};
		},

		setModel(sessionId, modelId) {
			if (!activeModelIds(sql).includes(modelId ?? "")) throw new SettingsApiError(400, "不支援的模型");
			if (!sessionId) throw new SettingsApiError(400, "缺少 sessionId");
			sessionsRepo.upsertModel(sql, sessionId, modelId!, new Date().toISOString());
		},
	};
}
