/**
 * Skill Hub 的解析、篩選與展示口徑（NERE-54）。
 *
 * - 契約：NERE-53 `docs/skill-hub-contract.md`（§5.2 列表 / §7 篩選 / §4.4 審計報告）。
 * - 解析寬容：契約漂移時降級成預設值，不拋錯、不讓面板崩。
 * - 取數只在 `hooks/useSkillHub`；元件拿這裡的結果做渲染與篩選。
 */

import type { SkillAudit, SkillAuditReason, SkillAuditStatus, SkillHubEntry } from "../types";
import { arrayOf, isObject, pickString } from "./collections";

/** 市場篩選條件：與契約 §5.2 的查詢引數一一對應。 */
export interface SkillHubFilters {
	q: string;
	runtime: string;
	tag: string;
	audit: "" | SkillAuditStatus;
	/** host 子串（契約 §5.2 `source`）；空串表示不過濾。 */
	source: string;
}

export const EMPTY_SKILL_HUB_FILTERS: SkillHubFilters = {
	q: "",
	runtime: "",
	tag: "",
	audit: "",
	source: "",
};

/** 可安裝 / 可篩選的執行時白名單（契約 §5.2 硬規則）：Python / Shell 不作為篩選項出現。 */
export const INSTALLABLE_RUNTIMES = ["prompt", "javascript", "typescript"] as const;

/**
 * 執行時下拉：只列契約允許的三種 + JS/TS 組合。
 * python / shell / binary / other 只能通過審計篩選（或不過濾）看到，避免誤導為可安裝。
 */
export const HUB_RUNTIME_FILTERS = [
	{ value: "", label: "全部執行時" },
	{ value: "javascript,typescript", label: "JS / TS" },
	{ value: "typescript", label: "TypeScript" },
	{ value: "javascript", label: "JavaScript" },
	{ value: "prompt", label: "提示詞" },
] as const;

export const HUB_AUDIT_FILTERS = [
	{ value: "", label: "全部審計" },
	{ value: "pass", label: "通過" },
	{ value: "warn", label: "警告" },
	{ value: "blocked", label: "不可安裝" },
] as const;

export const SKILL_AUDIT_LABELS: Record<SkillAuditStatus, string> = {
	pass: "審計通過",
	warn: "有警告",
	blocked: "不可安裝",
};

export const SKILL_AUDIT_STYLES: Record<SkillAuditStatus, string> = {
	pass: "bg-emerald-500/15 text-emerald-300",
	warn: "bg-amber-500/15 text-amber-300",
	blocked: "bg-rose-500/15 text-rose-300",
};

/** blocked 條目的統一說明：Worker 只能跑 JS/TS 與純提示詞技能。 */
export const BLOCKED_HINT = "不可安裝：僅支援 JS/TS 執行（含純提示詞技能）";

/** 審計排序（契約 §7.2）：可安裝的在前，不可安裝的沉底。 */
const AUDIT_RANK: Record<SkillAuditStatus, number> = { pass: 0, warn: 1, blocked: 2 };

const RUNTIME_ALIASES: Record<string, string> = {
	js: "javascript",
	javascript: "javascript",
	ecmascript: "javascript",
	ts: "typescript",
	typescript: "typescript",
	py: "python",
	python: "python",
	python3: "python",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	shell: "shell",
	prompt: "prompt",
	markdown: "prompt",
	md: "prompt",
	text: "prompt",
};

const RUNTIME_LABELS: Record<string, string> = {
	javascript: "JavaScript",
	typescript: "TypeScript",
	prompt: "提示詞",
	python: "Python",
	shell: "Shell",
	binary: "二進位制",
	other: "其他",
};

const AUDIT_ALIASES: Record<string, SkillAuditStatus> = {
	pass: "pass",
	passed: "pass",
	ok: "pass",
	clean: "pass",
	warn: "warn",
	warning: "warn",
	blocked: "blocked",
	block: "blocked",
	reject: "blocked",
	rejected: "blocked",
};

/** 執行時歸一：TS / ts / typescript 視為同一類。 */
export function canonicalRuntime(value: string): string {
	const key = value.trim().toLowerCase();
	return RUNTIME_ALIASES[key] ?? key;
}

export function runtimeLabel(value: string): string {
	const canonical = canonicalRuntime(value);
	return RUNTIME_LABELS[canonical] ?? (value.trim() || "未知");
}

/** 下拉值允許逗號分隔（如 javascript,typescript）；空串表示不過濾。 */
function runtimeFilterValues(filter: string): string[] {
	return filter
		.split(",")
		.map((item) => canonicalRuntime(item))
		.filter(Boolean);
}

function stringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.flatMap((item) => {
			if (typeof item === "string" && item.trim()) return [item.trim()];
			if (isObject(item)) {
				const name = pickString(item, ["name", "host", "domain", "tool", "id"]);
				return name ? [name] : [];
			}
			return [];
		});
	}
	if (typeof value === "string" && value.trim()) return [value.trim()];
	return [];
}

function parseBoolean(value: unknown): boolean {
	return value === true || value === 1 || value === "1" || value === "true";
}

function parseNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

/** 單條審計原因：契約是物件，早期 `string[]` 仍相容。 */
function parseAuditReason(raw: unknown): SkillAuditReason | null {
	if (typeof raw === "string") {
		const message = raw.trim();
		return message ? { message } : null;
	}
	if (!isObject(raw)) return null;
	const message = pickString(raw, ["message", "reason", "text"]);
	if (!message) return null;
	const rule = pickString(raw, ["rule"]);
	const evidence = pickString(raw, ["evidence"]);
	const levelKey = pickString(raw, ["level"]).toLowerCase();
	const level = AUDIT_ALIASES[levelKey];
	return {
		...(rule ? { rule } : {}),
		...(level ? { level } : {}),
		message,
		...(evidence ? { evidence } : {}),
	};
}

function parseAuditReasons(value: unknown): SkillAuditReason[] {
	if (Array.isArray(value)) {
		return value.map(parseAuditReason).filter((reason): reason is SkillAuditReason => reason !== null);
	}
	if (typeof value === "string" && value.trim()) return [{ message: value.trim() }];
	return [];
}

function parseAudit(raw: unknown, runtime: string, fallbackHash: string, requires: Record<string, unknown>): SkillAudit {
	const audit = isObject(raw) ? raw : {};
	const detected = isObject(audit.detected) ? audit.detected : {};
	const statusKey = pickString(audit, ["status"]).toLowerCase();
	const status = AUDIT_ALIASES[statusKey];
	const reasons = parseAuditReasons(audit.reasons);
	if (!status) reasons.push({ message: "審計狀態缺失或無法識別，按「有警告」處理" });
	const auditSource = pickString(audit, ["auditSource", "audit_source"]);
	const rulesVersion = parseNumber(audit.rulesVersion);
	const network = stringList(detected.network);
	const tools = stringList(detected.tools);
	return {
		status: status ?? "warn",
		reasons,
		detected: {
			runtime: pickString(detected, ["runtime"]) || runtime,
			network: network.length > 0 ? network : stringList(requires.network),
			tools: tools.length > 0 ? tools : stringList(requires.tools),
		},
		auditedAt: pickString(audit, ["auditedAt", "audited_at"]) || undefined,
		hash: pickString(audit, ["hash", "contentHash", "content_hash"]) || fallbackHash || undefined,
		...(rulesVersion !== undefined ? { rulesVersion } : {}),
		...(auditSource === "local" || auditSource === "catalog" ? { auditSource } : {}),
	};
}

/** GET /api/skills/hub → 領域條目；沒有名字的條目直接丟棄。 */
export function parseHubSkills(raw: unknown): SkillHubEntry[] {
	const list = arrayOf(raw, ["skills", "items"]).filter(isObject);
	const entries: SkillHubEntry[] = [];
	for (const item of list) {
		const name = pickString(item, ["name"]);
		if (!name) continue;
		const runtime = pickString(item, ["runtime"]) || "unknown";
		const contentHash = pickString(item, ["contentHash", "content_hash", "hash"]);
		const installedHash = pickString(item, ["installedHash", "installed_hash"]);
		const requires = isObject(item.requires) ? item.requires : {};
		entries.push({
			name,
			version: pickString(item, ["version"]),
			description: pickString(item, ["description"]),
			author: pickString(item, ["author"]),
			source: pickString(item, ["source"]),
			runtime,
			tags: stringList(item.tags),
			license: pickString(item, ["license"]),
			contentHash,
			installed: parseBoolean(item.installed),
			...(installedHash ? { installedHash } : {}),
			audit: parseAudit(item.audit, runtime, contentHash, requires),
			installUrl: pickString(item, ["installUrl", "install_url", "url", "contentUrl", "content_url"]) || undefined,
		});
	}
	return entries;
}

/** 目錄快照資訊（契約 §5.2 `catalog`）。 */
export interface SkillHubCatalog {
	source: string;
	fetchedAt?: string;
	/** 遠端重新整理失敗：列表仍可用，前端展示「目錄可能過期」。 */
	stale: boolean;
	count?: number;
}

/** 服務端給的篩選項（契約 §5.2 `filters`，取自目錄全集）。 */
export interface SkillHubFilterOptions {
	runtimes: string[];
	tags: string[];
	/** host（不是完整 URL）。 */
	sources: string[];
}

export interface SkillHubPage {
	entries: SkillHubEntry[];
	total: number;
	catalog: SkillHubCatalog | null;
	options: SkillHubFilterOptions;
}

const INSTALLABLE_SET = new Set<string>(INSTALLABLE_RUNTIMES);

/** 解析整個列表響應；缺欄位時給空值，不拋錯。 */
export function parseHubPage(raw: unknown): SkillHubPage {
	const root = isObject(raw) ? raw : {};
	const entries = parseHubSkills(root);
	const catalogRaw = isObject(root.catalog) ? root.catalog : null;
	const filtersRaw = isObject(root.filters) ? root.filters : {};
	return {
		entries,
		total: parseNumber(root.total) ?? entries.length,
		catalog: catalogRaw
			? {
					source: pickString(catalogRaw, ["source"]),
					fetchedAt: pickString(catalogRaw, ["fetchedAt", "fetched_at"]) || undefined,
					stale: parseBoolean(catalogRaw.stale),
					count: parseNumber(catalogRaw.count),
				}
			: null,
		options: {
			// 契約只允許三種可安裝執行時；服務端若誤帶 python/shell 也在這裡濾掉。
			runtimes: stringList(filtersRaw.runtimes)
				.map((value) => canonicalRuntime(value))
				.filter((value) => INSTALLABLE_SET.has(value)),
			tags: stringList(filtersRaw.tags),
			sources: stringList(filtersRaw.sources),
		},
	};
}

/** 來源展示 / 篩選口徑：URL 取 host，存量 `local` 原樣返回。 */
export function sourceHost(source: string): string {
	const value = source.trim();
	if (!value) return "";
	try {
		return new URL(value).host || value;
	} catch {
		return value;
	}
}

/** 搜尋命中名稱 / 描述 / 標籤（契約 §5.2：小寫子串），其餘維度按契約匹配。 */
export function filterHubSkills(entries: readonly SkillHubEntry[], filters: SkillHubFilters): SkillHubEntry[] {
	const query = filters.q.trim().toLowerCase();
	const runtimes = runtimeFilterValues(filters.runtime);
	const audits = filters.audit
		.split(",")
		.map((value) => AUDIT_ALIASES[value.trim().toLowerCase()])
		.filter((value): value is SkillAuditStatus => Boolean(value));
	const tags = filters.tag
		.split(",")
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	const source = sourceHost(filters.source).toLowerCase();
	return entries.filter((entry) => {
		if (query) {
			const haystack = `${entry.name} ${entry.description} ${entry.tags.join(" ")}`.toLowerCase();
			if (!haystack.includes(query)) return false;
		}
		if (runtimes.length > 0 && !runtimes.includes(canonicalRuntime(entry.runtime))) return false;
		if (audits.length > 0 && !audits.includes(entry.audit.status)) return false;
		if (tags.length > 0 && !entry.tags.some((tag) => tags.includes(tag.toLowerCase()))) return false;
		if (source && !sourceHost(entry.source).toLowerCase().includes(source)) return false;
		return true;
	});
}

/** 預設排序：audit 優先（pass → warn → blocked），同級按名稱。 */
export function sortHubSkills(entries: readonly SkillHubEntry[]): SkillHubEntry[] {
	return [...entries].sort((a, b) => {
		const rank = AUDIT_RANK[a.audit.status] - AUDIT_RANK[b.audit.status];
		return rank !== 0 ? rank : a.name.localeCompare(b.name, "zh-TW");
	});
}

export function hasActiveHubFilters(filters: SkillHubFilters): boolean {
	return Boolean(filters.q.trim() || filters.runtime || filters.tag || filters.audit || filters.source);
}

/** 安裝地址：優先 manifest 的 installUrl，其次 source（兩者都必須是 http(s)）。 */
export function hubEntryInstallUrl(entry: SkillHubEntry): string {
	const direct = entry.installUrl?.trim() ?? "";
	if (/^https?:\/\//i.test(direct)) return direct;
	const source = entry.source.trim();
	return /^https?:\/\//i.test(source) ? source : "";
}

/**
 * 安裝失敗首因（NERE-69）：`api.importSkill` 已把 `details.audit.reasons[].message`
 * 展平成 `reasons`，這裡取第一條非空文案；沒有審計原因時回退介面 `error`。
 */
export function installFailureMessage(result: { reasons?: readonly string[]; error?: string }): string {
	const first = result.reasons?.map((reason) => reason.trim()).find(Boolean);
	return first || result.error?.trim() || "安裝失敗";
}

/** blocked 一律不可安裝；沒有安裝地址的條目也不發請求。 */
export function canInstallHubEntry(entry: SkillHubEntry): boolean {
	return entry.audit.status !== "blocked" && hubEntryInstallUrl(entry) !== "";
}

/** 同名已安裝但內容不同（契約 §5.2 `installedHash`）→ 展示「可更新」。 */
export function isHubEntryUpdatable(entry: SkillHubEntry): boolean {
	return (
		entry.installed &&
		Boolean(entry.installedHash) &&
		Boolean(entry.contentHash) &&
		entry.installedHash !== entry.contentHash
	);
}
