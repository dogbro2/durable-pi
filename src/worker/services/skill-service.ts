import type { SqlHandle } from "../db/migrations";
import { AppError } from "../http/errors";
import type { SettingsPort } from "../http/ports";
import {
	CONTENT_MAX_BYTES,
	HASH_RE,
	INSTALLABLE_RUNTIMES,
	MANIFEST_MAX_BYTES,
	RULES_VERSION,
	SKILL_NAME_RE,
	SKILL_RUNTIMES,
	auditSkill,
	byteLength,
	parseFrontmatter,
	parseManifest,
	sha256Content,
	slugifySkillName,
	stripFrontmatter,
	synthesizeManifest,
	untrustedCatalogReason,
	type AuditReport,
	type SkillManifest,
	type SkillRuntime,
} from "../lib/skill-audit";
import { BUNDLED_CATALOG, BUNDLED_CATALOG_GENERATED_AT, catalogRuntime, type CatalogEntry } from "../lib/skill-catalog";
import { SkillFetchError, fetchSkillText, normalizeSkillUrl, rewriteSkillStub, type FetchSkillText } from "../lib/skill-import";
import {
	countSkills,
	deleteSkill,
	eventCounts,
	getCachedAudit,
	getSkillRow,
	invokedNames,
	lastInvokedMap,
	listSkillMeta,
	listSkillRows,
	putCachedAudit,
	recordEvent,
	updateSkillAudit,
	upsertManualSkill,
	upsertSkill,
	type SkillEventType,
	type SkillMeta,
	type SkillRow,
} from "../repo/skills-repo";

/**
 * 技能域用例（NERE-55）：目錄裝載 + 已安裝合併 + 匯入審計 + 埋點聚合。
 * SQL 全部經 repo；HTTP 狀態碼與響應體在 `routes/skills.ts`。
 */

export class SkillApiError extends AppError {
	constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
		super(code, status, message, false, details);
		this.name = "SkillApiError";
	}
}

export type SkillServiceDeps = {
	sql: SqlHandle;
	settings?: SettingsPort;
	fetchImpl?: typeof fetch;
	now?: () => Date;
	/** 測試注入：跳過內建模組，直接用給定目錄。 */
	catalog?: CatalogEntry[];
};

export type HubQuery = {
	q?: string | null;
	runtime?: string | null;
	tag?: string | null;
	audit?: string | null;
	source?: string | null;
	origin?: string | null;
	installed?: string | null;
	sort?: string | null;
	limit?: string | null;
	offset?: string | null;
};

export type HubSkill = {
	name: string;
	version: string;
	description: string;
	author: string;
	source: string;
	license: string;
	runtime: SkillRuntime;
	tags: string[];
	requires: { tools: string[]; bindings: string[]; network: string[] };
	contentHash: string;
	installed: boolean;
	installedHash?: string;
	audit: AuditReport;
	origin: "bundled" | "remote";
	/** 安裝地址：前端 `hubEntryInstallUrl` 優先讀 installUrl，再回退 contentUrl/source。 */
	installUrl?: string;
	contentUrl?: string;
};

export type HubResponse = {
	skills: HubSkill[];
	total: number;
	nextOffset: number | null;
	catalog: { source: "bundled" | "remote"; fetchedAt: string | null; stale: boolean; count: number };
	filters: { runtimes: SkillRuntime[]; tags: string[]; sources: string[] };
};

export type ImportResult = {
	ok: true;
	installed: true;
	changed: boolean;
	name: string;
	version: string;
	description: string;
	source: string;
	contentHash: string;
	audit: AuditReport;
};

export type MetricsResponse = {
	days: number;
	since: number;
	hubViews: number;
	installOk: number;
	installBlocked: number;
	blockedRatio: number;
	installed: number;
	called7d: number;
};

/** 社群目錄（badlogic/pi-skills）8 條：全部需要本地執行時或宿主命令，統一對映為 blocked。 */
export const COMMUNITY_SKILLS = [
	{ name: "brave-search", description: "通過 Brave Search API 搜尋網頁與提取正文", needsLocal: false },
	{ name: "youtube-transcript", description: "抓取 YouTube 影片字幕用於總結分析", needsLocal: false },
	{ name: "browser-tools", description: "通過 Chrome DevTools 協議做瀏覽器自動化", needsLocal: true },
	{ name: "transcribe", description: "本地語音轉寫（Apple Silicon / ffmpeg）", needsLocal: true },
	{ name: "gdcli", description: "Google Drive 命令列（列目錄/上傳/下載/分享）", needsLocal: true },
	{ name: "gccli", description: "Google Calendar 命令列（檢視/建立事件）", needsLocal: true },
	{ name: "gmcli", description: "Gmail 命令列（搜尋/讀信/發信）", needsLocal: true },
	{ name: "vscode", description: "VS Code 整合（檢視 diff / 比較檔案）", needsLocal: true },
] as const;
const COMMUNITY_RAW_BASE = "https://raw.githubusercontent.com/badlogic/pi-skills/main";

const HUB_LIMIT_DEFAULT = 50;
const HUB_LIMIT_MAX = 200;
const REMOTE_TTL_MS = 10 * 60 * 1000;
const METRICS_MAX_DAYS = 90;

type RemoteCache = { url: string; at: number; entries: CatalogEntry[] };
/** 程序內 LRU（按 isolate）：遠端目錄 TTL 10 分鐘；失敗時用最近一次成功結果。 */
let remoteCache: RemoteCache | null = null;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function tagList(raw: string): string[] {
	const parsed = parseJson<unknown>(raw, null);
	if (Array.isArray(parsed)) return parsed.filter((tag): tag is string => typeof tag === "string");
	return raw
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
}

function coerceRuntime(value: string | undefined): SkillRuntime {
	return (SKILL_RUNTIMES as readonly string[]).includes(value ?? "") ? (value as SkillRuntime) : "other";
}

function sourceHost(source: string): string {
	if (!source || source === "local") return "";
	try {
		return new URL(source).hostname.toLowerCase();
	} catch {
		return source.toLowerCase();
	}
}

function parseCsv(value: string | null | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

/** 目錄快照審計：缺 audit 或 hash 不一致一律 blocked（fail closed，契約 §4.5 / §6.1）。 */
function snapshotAudit(entry: CatalogEntry, generatedAt: string): AuditReport {
	const audit = entry.audit as AuditReport | undefined;
	const hash = String(entry.contentHash ?? "");
	const runtime = catalogRuntime(entry);
	if (!audit || !hash || audit.hash !== hash || !Array.isArray(audit.reasons)) {
		return {
			status: "blocked",
			reasons: [untrustedCatalogReason()],
			detected: { runtime, network: [], tools: [] },
			auditedAt: generatedAt,
			hash,
			rulesVersion: RULES_VERSION,
			auditSource: "catalog",
		};
	}
	return { ...audit, detected: { ...audit.detected, runtime }, auditSource: "catalog" };
}

function rowManifest(row: SkillMeta): SkillManifest {
	const stored = parseJson<unknown>(row.manifest, null);
	if (stored) {
		const parsed = parseManifest(stored);
		if (parsed.ok) return parsed.manifest;
	}
	return synthesizeManifest({
		name: row.name,
		description: row.description,
		runtime: coerceRuntime(row.runtime),
		source: row.source || "local",
	});
}

function hubFromCatalog(entry: CatalogEntry, installed: SkillMeta | undefined, installedAudit: AuditReport | undefined, generatedAt: string): HubSkill {
	const runtime = catalogRuntime(entry);
	const contentHash = String(entry.contentHash ?? "");
	return {
		name: String(entry.name ?? ""),
		version: String(entry.version ?? ""),
		description: String(entry.description ?? ""),
		author: String(entry.author ?? ""),
		source: String(entry.source ?? ""),
		license: String(entry.license ?? ""),
		runtime,
		tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : [],
		requires: {
			tools: Array.isArray(entry.requires?.tools) ? entry.requires.tools : [],
			bindings: Array.isArray(entry.requires?.bindings) ? entry.requires.bindings : [],
			network: Array.isArray(entry.requires?.network) ? entry.requires.network : [],
		},
		contentHash,
		installed: Boolean(installed),
		...(installed && installed.contentHash !== contentHash
			? { installedHash: installedAudit?.hash ?? installed.contentHash }
			: {}),
		// 已安裝技能的本地重審計優先於目錄快照（契約 §4.5）
		audit: installedAudit ?? snapshotAudit(entry, generatedAt),
		origin: entry.origin === "remote" ? "remote" : "bundled",
		installUrl: String(entry.contentUrl ?? ""),
		contentUrl: String(entry.contentUrl ?? ""),
	};
}

function hubFromInstalled(row: SkillMeta, audit: AuditReport): HubSkill {
	const manifest = rowManifest(row);
	return {
		name: row.name,
		version: row.version || manifest.version,
		description: row.description,
		author: row.author || manifest.author,
		source: row.source || manifest.source,
		license: row.license || manifest.license,
		runtime: coerceRuntime(row.runtime),
		tags: tagList(row.tags),
		requires: manifest.requires,
		contentHash: audit.hash || row.contentHash,
		installed: true,
		audit,
		origin: "bundled",
	};
}

export type CommunityResponse = {
	source: string;
	skills: {
		name: string;
		description: string;
		needsLocal: boolean;
		url: string;
		runtime: SkillRuntime;
		audit_status: "blocked";
		audit: AuditReport;
	}[];
};

const AUDIT_RANK: Record<string, number> = { pass: 0, warn: 1, blocked: 2 };

/** 模型側 load_skill / 顯式技能呼叫寫同一套事件（NERE-59）；失敗不影響主流程。 */
export function trackSkillCall(sql: SqlHandle, name: string, kind: "loaded" | "invoked"): void {
	try {
		recordEvent(sql, {
			name: name.slice(0, 80),
			type: kind === "loaded" ? "skill_loaded" : "skill_invoked",
			source: kind,
			at: Date.now(),
		});
	} catch {
		// 事件表不可用時靜默降級
	}
}

export function createSkillService(deps: SkillServiceDeps): SkillService {
	const { sql, settings, fetchImpl = fetch } = deps;
	const now = () => (deps.now ? deps.now() : new Date());

	/** 埋點失敗不阻斷主流程（契約追加 A）。 */
	function track(type: SkillEventType, name: string, source = "", meta = ""): void {
		try {
			recordEvent(sql, { name: name.slice(0, 80), type, source: source.slice(0, 200), at: now().getTime(), meta: meta.slice(0, 500) });
		} catch {
			// 事件表缺失/寫入失敗：降級，不影響安裝與列表
		}
	}

	/** 已安裝行的本地重審計：按 content_hash 快取，命中直接複用報告。 */
	async function auditRow(row: SkillRow): Promise<AuditReport> {
		const runtime = coerceRuntime(row.runtime);
		const hash = await sha256Content(runtime === "prompt" ? stripFrontmatter(row.content) : row.content);
		const cached = getCachedAudit(sql, hash, RULES_VERSION);
		if (cached) {
			const report = parseJson<AuditReport | null>(cached.report, null);
			if (report) {
				const current = { ...report, hash, auditSource: "local" as const };
				persistAudit(row, current);
				return current;
			}
		}
		const manifest = rowManifest(row);
		const report = await auditSkill({
			manifest,
			content: row.content,
			filename: manifest.entry ?? (runtime === "prompt" ? "SKILL.md" : undefined),
			exemptMeta: true,
			auditSource: "local",
			auditedAt: now().toISOString(),
		});
		putCachedAudit(sql, {
			hash: report.hash,
			rulesVersion: RULES_VERSION,
			status: report.status,
			report: JSON.stringify(report),
			auditedAt: report.auditedAt,
		});
		persistAudit(row, report);
		return report;
	}

	/** 重審計是判定真相：把狀態/報告回寫，避免 `GET /skills` 與 hub / 提示詞索引各讀各的。 */
	function persistAudit(row: SkillRow, report: AuditReport): void {
		const auditReport = JSON.stringify(report);
		if (row.auditStatus === report.status && row.auditReport === auditReport && row.contentHash) return;
		updateSkillAudit(sql, row.name, {
			contentHash: report.hash,
			auditStatus: report.status,
			auditReport,
		});
	}

	/**
	 * 落庫報告可以直接複用：雜湊與規則版本都對得上，就不必讀正文重算。
	 * 舊庫行（報告缺失 / 空 hash）與規則升級後的行回落到重審計。
	 */
	function storedAudit(row: SkillMeta): AuditReport | null {
		const report = parseJson<AuditReport | null>(row.auditReport, null);
		if (!report || !row.contentHash || report.hash !== row.contentHash) return null;
		if (report.rulesVersion !== RULES_VERSION || !Array.isArray(report.reasons) || typeof report.status !== "string") return null;
		return report;
	}

	async function installedRows(): Promise<{ rows: SkillMeta[]; audits: Map<string, AuditReport> }> {
		const rows = listSkillMeta(sql);
		const audits = new Map<string, AuditReport>();
		for (const row of rows) {
			const stored = storedAudit(row);
			if (stored) {
				audits.set(row.name, stored);
				continue;
			}
			// 只有存量行 / 舊規則版本的報告才讀正文重審計（正常路徑零正文、零 SHA-256）。
			const full = getSkillRow(sql, row.name);
			if (full) audits.set(row.name, await auditRow(full));
		}
		return { rows, audits };
	}

	/** 內建目錄 + 可選遠端目錄（遠端失敗回落內建並標 stale，不 5xx）。 */
	async function loadCatalog(): Promise<{
		entries: CatalogEntry[];
		source: "bundled" | "remote";
		fetchedAt: string | null;
		stale: boolean;
	}> {
		const bundled = (deps.catalog ?? (BUNDLED_CATALOG.entries as CatalogEntry[])).map((entry) => ({
			...entry,
			origin: entry.origin ?? "bundled",
		}));
		const remoteUrl = (settings?.get("skill_catalog_url", "") ?? "").trim();
		if (!remoteUrl) {
			return { entries: bundled, source: "bundled", fetchedAt: BUNDLED_CATALOG_GENERATED_AT, stale: false };
		}
		const cached = remoteCache && remoteCache.url === remoteUrl ? remoteCache : null;
		if (cached && now().getTime() - cached.at < REMOTE_TTL_MS) {
			return { entries: [...bundled, ...cached.entries], source: "remote", fetchedAt: new Date(cached.at).toISOString(), stale: false };
		}
		try {
			const response = await fetchImpl(remoteUrl, {
				headers: { "user-agent": "durable-pi-skill-catalog" },
				signal: AbortSignal.timeout(5_000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const text = await response.text();
			if (byteLength(text) > 512 * 1024) throw new Error("目錄超過 512 KiB");
			const parsed = JSON.parse(text) as { schemaVersion?: number; entries?: unknown };
			if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) throw new Error("目錄結構非法");
			const seen = new Set(bundled.map((entry) => entry.name));
			const remote: CatalogEntry[] = [];
			for (const raw of parsed.entries.slice(0, 200)) {
				const entry = raw as CatalogEntry;
				if (!entry || typeof entry.name !== "string" || !SKILL_NAME_RE.test(entry.name)) continue;
				if (seen.has(entry.name)) continue; // 重名保留首條
				seen.add(entry.name);
				remote.push({ ...entry, origin: "remote" });
			}
			remoteCache = { url: remoteUrl, at: now().getTime(), entries: remote };
			return {
				entries: [...bundled, ...remote],
				source: "remote",
				fetchedAt: now().toISOString(),
				stale: false,
			};
		} catch {
			return {
				entries: [...bundled, ...(cached?.entries ?? [])],
				source: "remote",
				fetchedAt: cached ? new Date(cached.at).toISOString() : null,
				stale: true,
			};
		}
	}

	async function hub(query: HubQuery = {}): Promise<HubResponse> {
		const qt = (query.q ?? "").trim().toLowerCase().slice(0, 100);
		const runtimeFilter = parseCsv(query.runtime).map((value) =>
			value === "js" ? "javascript" : value === "ts" ? "typescript" : value,
		);
		for (const runtime of runtimeFilter) {
			if (!(SKILL_RUNTIMES as readonly string[]).includes(runtime)) {
				throw new SkillApiError(400, "bad_request", `runtime 不支援：${runtime}`);
			}
		}
		const auditFilter = parseCsv(query.audit);
		for (const status of auditFilter) {
			if (status !== "pass" && status !== "warn" && status !== "blocked") {
				throw new SkillApiError(400, "bad_request", `audit 只接受 pass/warn/blocked：${status}`);
			}
		}
		const tagFilter = parseCsv(query.tag);
		const originFilter = query.origin === "bundled" || query.origin === "remote" ? query.origin : "";
		const installedFilter = query.installed === "1" ? true : query.installed === "0" ? false : null;
		const sourceFilter = (query.source ?? "").trim().toLowerCase();
		const sort = query.sort === "name" || query.sort === "updated" ? query.sort : "audit";
		const limit = Math.min(HUB_LIMIT_MAX, Math.max(1, Number(query.limit ?? HUB_LIMIT_DEFAULT) || HUB_LIMIT_DEFAULT));
		const offset = Math.max(0, Number(query.offset ?? 0) || 0);

		const catalog = await loadCatalog();
		const { rows, audits } = await installedRows();
		const installedByName = new Map(rows.map((row) => [row.name, row]));
		const seen = new Set<string>();
		const merged: HubSkill[] = [];
		for (const entry of catalog.entries) {
			if (!entry?.name || seen.has(entry.name)) continue;
			seen.add(entry.name);
			merged.push(
				hubFromCatalog(entry, installedByName.get(entry.name), audits.get(entry.name), catalog.fetchedAt ?? BUNDLED_CATALOG_GENERATED_AT),
			);
		}
		for (const row of rows) {
			if (seen.has(row.name)) continue;
			seen.add(row.name);
			const audit = audits.get(row.name);
			if (audit) merged.push(hubFromInstalled(row, audit));
		}

		if (auditFilter.includes("blocked")) {
			for (const skill of communityHubEntries()) {
				if (seen.has(skill.name)) continue;
				seen.add(skill.name);
				merged.push(skill);
			}
		}

		const runtimeSet = runtimeFilter.length ? new Set(runtimeFilter) : null;
		const auditSet = auditFilter.length ? new Set(auditFilter) : null;
		const tagSet = tagFilter.length ? new Set(tagFilter) : null;
		const filtered = merged.filter((item) => {
			if (qt && !`${item.name} ${item.description} ${item.tags.join(" ")}`.toLowerCase().includes(qt)) return false;
			if (runtimeSet && !runtimeSet.has(item.runtime)) return false;
			if (auditSet && !auditSet.has(item.audit.status)) return false;
			if (tagSet && !item.tags.some((tag) => tagSet.has(tag))) return false;
			if (originFilter && item.origin !== originFilter) return false;
			if (installedFilter !== null && item.installed !== installedFilter) return false;
			if (sourceFilter && !`${item.source} ${sourceHost(item.source)}`.toLowerCase().includes(sourceFilter)) return false;
			return true;
		});

		if (sort === "name") filtered.sort((a, b) => a.name.localeCompare(b.name));
		else if (sort === "updated") {
			const updatedAt = (name: string) => installedByName.get(name)?.updatedAt ?? "";
			filtered.sort((a, b) => updatedAt(b.name).localeCompare(updatedAt(a.name)) || a.name.localeCompare(b.name));
		} else {
			filtered.sort(
				(a, b) => (AUDIT_RANK[a.audit.status] ?? 9) - (AUDIT_RANK[b.audit.status] ?? 9) || a.name.localeCompare(b.name),
			);
		}

		const page = filtered.slice(offset, offset + limit);
		track("skill_hub_view", "", "hub");
		return {
			skills: page,
			total: filtered.length,
			nextOffset: offset + page.length < filtered.length ? offset + page.length : null,
			catalog: {
				source: catalog.source,
				fetchedAt: catalog.fetchedAt,
				stale: catalog.stale,
				count: catalog.entries.length,
			},
			filters: {
				runtimes: [...INSTALLABLE_RUNTIMES],
				tags: [...new Set(catalog.entries.flatMap((entry) => (Array.isArray(entry.tags) ? entry.tags : [])))].sort(),
				sources: [...new Set(merged.map((item) => sourceHost(item.source)).filter(Boolean))].sort(),
			},
		};
	}

	async function auditFor(name: string): Promise<{ name: string; version: string; contentHash: string; source: string; audit: AuditReport }> {
		if (!SKILL_NAME_RE.test(name)) throw new SkillApiError(400, "bad_request", "技能名不合法");
		const row = getSkillRow(sql, name);
		if (row) {
			const audit = await auditRow(row);
			track("skill_detail_view", name, "installed");
			return { name: row.name, version: row.version, contentHash: audit.hash, source: row.source, audit };
		}
		const catalog = await loadCatalog();
		const entry = catalog.entries.find((item) => item.name === name);
		if (!entry) throw new SkillApiError(404, "not_found", "技能不存在");
		track("skill_detail_view", name, "catalog");
		return {
			name,
			version: String(entry.version ?? ""),
			contentHash: String(entry.contentHash ?? ""),
			source: String(entry.source ?? ""),
			audit: snapshotAudit(entry, catalog.fetchedAt ?? BUNDLED_CATALOG_GENERATED_AT),
		};
	}

	async function importSkill(body: unknown): Promise<ImportResult> {
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw new SkillApiError(400, "bad_request", "請求體必須是 JSON 物件");
		}
		const input = body as {
			url?: unknown;
			manifest?: unknown;
			content?: unknown;
			expectedHash?: unknown;
			overwrite?: unknown;
			name?: unknown;
		};
		const overwrite = input.overwrite === true;
		const nameOverride = typeof input.name === "string" ? input.name.trim() : "";
		const expectedHash = typeof input.expectedHash === "string" ? input.expectedHash.trim() : "";
		if (expectedHash && !HASH_RE.test(expectedHash)) throw new SkillApiError(400, "bad_request", "expectedHash 必須是 sha256:<64 hex>");
		if (input.url !== undefined) {
			if (input.manifest !== undefined || input.content !== undefined) {
				throw new SkillApiError(400, "bad_request", "url 與 manifest+content 只能二選一");
			}
			if (typeof input.url !== "string" || !input.url.trim()) throw new SkillApiError(400, "bad_request", "缺少 url");
			return await importFromUrl(input.url.trim(), expectedHash, overwrite, nameOverride);
		}
		if (input.manifest === undefined || typeof input.content !== "string") {
			throw new SkillApiError(400, "bad_request", "需要 url，或 manifest + content");
		}
		if (byteLength(input.content) > CONTENT_MAX_BYTES) throw new SkillApiError(413, "too_large", "內容超過 256 KiB");
		const parsed = parseManifest(input.manifest);
		if (!parsed.ok) throw new SkillApiError(400, "bad_request", parsed.reason.message, { reason: parsed.reason });
		const manifest = parsed.manifest;
		if (byteLength(JSON.stringify(manifest)) > MANIFEST_MAX_BYTES) throw new SkillApiError(413, "too_large", "manifest 超過 16 KiB");
		const filename = manifest.entry ?? (manifest.runtime === "prompt" ? "SKILL.md" : undefined);
		const audit = await auditSkill({
			manifest,
			content: input.content,
			filename,
			expectedHash: expectedHash || undefined,
			auditSource: "local",
			auditedAt: now().toISOString(),
		});
		return finishImport({
			manifest,
			content: manifest.runtime === "prompt" ? stripFrontmatter(input.content) : input.content,
			audit,
			overwrite,
			urlSource: manifest.source,
			legacy: false,
		});
	}

	async function importFromUrl(
		url: string,
		expectedHash: string,
		overwrite: boolean,
		nameOverride = "",
	): Promise<ImportResult> {
		const target = normalizeSkillUrl(url);
		if (!target) throw new SkillApiError(400, "bad_request", "需要 http(s) 連結");
		let fetched: FetchSkillText;
		try {
			fetched = await fetchSkillText(target, fetchImpl);
		} catch (err) {
			if (err instanceof SkillFetchError) {
				const code = err.status === 413 ? "too_large" : err.status === 502 ? "upstream_failed" : "audit_blocked";
				throw new SkillApiError(err.status, code, err.message, {
					audit: {
						status: "blocked",
						reasons: [{ rule: err.rule, level: "blocked", message: err.message, ...(err.evidence ? { evidence: err.evidence } : {}) }],
						detected: { runtime: "other", network: [], tools: [] },
						auditedAt: now().toISOString(),
						hash: "",
						rulesVersion: RULES_VERSION,
						auditSource: "local",
					},
				});
			}
			throw err;
		}

		// URL 指向 skill.json → 再抓一次入口檔案（契約 §5.4 A）。
		const manifestText = parseJson<{ schemaVersion?: unknown } | null>(fetched.text, null);
		if (manifestText && manifestText.schemaVersion === 1) {
			const parsed = parseManifest(manifestText);
			if (!parsed.ok) throw new SkillApiError(400, "bad_request", parsed.reason.message, { reason: parsed.reason });
			const manifest = parsed.manifest;
			if (!manifest.entry) {
				// prompt 技能的內容檔案是同目錄的 SKILL.md（契約 §2.1）。
				const contentUrl = new URL("SKILL.md", fetched.url).toString();
				let body: string;
				try {
					body = (await fetchSkillText(contentUrl, fetchImpl)).text;
				} catch (err) {
					if (err instanceof SkillFetchError) {
						throw new SkillApiError(err.status === 413 ? 413 : 502, err.status === 413 ? "too_large" : "upstream_failed", err.message);
					}
					throw err;
				}
				const audit = await auditSkill({
					manifest,
					content: body,
					filename: "SKILL.md",
					expectedHash: expectedHash || undefined,
					hashMismatch: Boolean(manifest.contentHash && manifest.contentHash !== (await sha256Content(stripFrontmatter(body)))),
					auditSource: "local",
					auditedAt: now().toISOString(),
				});
				return finishImport({
					manifest,
					content: stripFrontmatter(body),
					audit,
					overwrite,
					urlSource: fetched.url,
					legacy: false,
				});
			}
			const entryUrl = new URL(manifest.entry, fetched.url).toString();
			let entryText: string;
			try {
				entryText = (await fetchSkillText(entryUrl, fetchImpl)).text;
			} catch (err) {
				if (err instanceof SkillFetchError) {
					throw new SkillApiError(err.status === 413 ? 413 : 502, err.status === 413 ? "too_large" : "upstream_failed", err.message);
				}
				throw err;
			}
			if (byteLength(entryText) > CONTENT_MAX_BYTES) throw new SkillApiError(413, "too_large", "內容超過 256 KiB");
			const audit = await auditSkill({
				manifest,
				content: entryText,
				filename: manifest.entry,
				expectedHash: expectedHash || undefined,
				hashMismatch: Boolean(manifest.contentHash && manifest.contentHash !== (await sha256Content(entryText))),
				auditSource: "local",
				auditedAt: now().toISOString(),
			});
			return finishImport({ manifest, content: entryText, audit, overwrite, urlSource: fetched.url, legacy: false });
		}

		// 任意文本 → 合成 legacy prompt manifest（契約 §2.6）。
		const frontmatter = parseFrontmatter(fetched.text);
		const fallback = fetched.url.split("/").slice(-2, -1)[0] ?? "imported-skill";
		const override = nameOverride ? slugifySkillName(nameOverride) : "";
		if (nameOverride && !override) throw new SkillApiError(400, "bad_request", "覆蓋的技能名不合法");
		const name = override || slugifySkillName(frontmatter.name) || slugifySkillName(fallback) || "imported-skill";
		const description = (frontmatter.description || "（從社群匯入，未提供描述）").slice(0, 200);
		const manifest = synthesizeManifest({
			name,
			description,
			runtime: "prompt",
			source: fetched.url,
			frontmatter: { name, description },
		});
		const rawBody = stripFrontmatter(fetched.text);
		const body = rewriteSkillStub(rawBody);
		const catalogHash = await bundledHashFor(name);
		const audit = await auditSkill({
			manifest,
			content: body,
			filename: "SKILL.md",
			// 正文被本地改寫後與釋出雜湊不再等價，此時不拿目錄雜湊做校驗（改寫只發生在匯入側）。
			expectedHash: expectedHash || (body === rawBody ? catalogHash : "") || undefined,
			auditSource: "local",
			auditedAt: now().toISOString(),
		});
		return finishImport({
			manifest,
			content: body,
			audit,
			overwrite,
			urlSource: fetched.url,
			legacy: true,
		});
	}

	/** 內建目錄同名條目的雜湊：安裝時自動校驗，目錄被篡改即 blocked。 */
	async function bundledHashFor(name: string): Promise<string> {
		const catalog = await loadCatalog();
		const entry = catalog.entries.find((item) => item.name === name);
		return entry?.contentHash && HASH_RE.test(entry.contentHash) ? entry.contentHash : "";
	}

	async function finishImport(input: {
		manifest: SkillManifest;
		content: string;
		audit: AuditReport;
		overwrite: boolean;
		urlSource: string;
		legacy: boolean;
	}): Promise<ImportResult> {
		const { manifest, audit, legacy } = input;
		const name = manifest.name;
		if (byteLength(input.content) > CONTENT_MAX_BYTES) throw new SkillApiError(413, "too_large", "內容超過 256 KiB");
		track("skill_import", name, input.urlSource || "local");
		if (audit.status === "blocked") {
			track("skill_blocked", name, input.urlSource || "local", audit.reasons.map((reason) => reason.rule).join(","));
			throw new SkillApiError(422, "audit_blocked", `審計未通過：${audit.reasons[0]?.message ?? "執行時不受支援"}`, {
				audit,
			});
		}
		const existing = getSkillRow(sql, name);
		if (existing && existing.contentHash && existing.contentHash !== audit.hash && !input.overwrite) {
			throw new SkillApiError(409, "name_conflict", "同名技能內容不同，需要 overwrite=1 才能覆蓋");
		}
		if (existing && !existing.contentHash && !input.overwrite) {
			throw new SkillApiError(409, "name_conflict", "同名技能已存在，需要 overwrite=1 才能覆蓋");
		}
		const changed = !existing || existing.contentHash !== audit.hash;
		const nowIso = now().toISOString();
		putCachedAudit(sql, {
			hash: audit.hash,
			rulesVersion: RULES_VERSION,
			status: audit.status,
			report: JSON.stringify(audit),
			auditedAt: audit.auditedAt,
		});
		if (changed) {
			upsertSkill(sql, {
				name,
				description: manifest.description,
				content: input.content,
				version: manifest.version,
				source: manifest.source || input.urlSource || "local",
				author: manifest.author,
				license: manifest.license,
				runtime: manifest.runtime,
				tags: manifest.tags,
				contentHash: audit.hash,
				auditStatus: audit.status,
				auditReport: JSON.stringify(audit),
				manifest: JSON.stringify(manifest),
				createdAt: existing?.createdAt ?? nowIso,
				updatedAt: nowIso,
			});
			track("skill_install", name, legacy ? "import-url" : "import");
		}
		return {
			ok: true,
			installed: true,
			changed,
			name,
			version: manifest.version,
			description: manifest.description,
			source: manifest.source || input.urlSource || "local",
			contentHash: audit.hash,
			audit,
		};
	}

	/** 既有 `GET /skills` 相容：欄位只增不改；新增 lastInvokedAt（NERE-59）。 */
	function listCompat(): { skills: Record<string, unknown>[] } {
		const invoked = lastInvokedMap(sql);
		return {
			skills: listSkillRows(sql).map((row) => ({
				name: row.name,
				description: row.description,
				content: row.content,
				created_at: row.createdAt,
				version: row.version,
				source: row.source,
				author: row.author,
				runtime: coerceRuntime(row.runtime),
				tags: tagList(row.tags),
				contentHash: row.contentHash,
				auditStatus: row.auditStatus,
				updated_at: row.updatedAt,
				lastInvokedAt: invoked[row.name] ?? null,
			})),
		};
	}

	/**
	 * 手工貼上（相容舊 `POST /skills`）：先審計再落庫，大小沿用 256 KiB 上限。
	 * blocked 內容仍寫入（舊介面語義），但狀態為 blocked，不會進入提示詞索引。
	 */
	async function addManual(input: { name: string; description: string; content: string }): Promise<void> {
		if (byteLength(input.content) > CONTENT_MAX_BYTES) throw new SkillApiError(413, "too_large", "內容超過 256 KiB");
		const manifest = synthesizeManifest({
			name: input.name,
			description: input.description,
			runtime: "prompt",
		});
		const nowIso = now().toISOString();
		const report = await auditSkill({
			manifest,
			content: input.content,
			filename: "SKILL.md",
			exemptMeta: true,
			auditSource: "local",
			auditedAt: nowIso,
		});
		putCachedAudit(sql, {
			hash: report.hash,
			rulesVersion: RULES_VERSION,
			status: report.status,
			report: JSON.stringify(report),
			auditedAt: report.auditedAt,
		});
		upsertManualSkill(
			sql,
			{
				...input,
				contentHash: report.hash,
				auditStatus: report.status,
				auditReport: JSON.stringify(report),
				manifest: JSON.stringify(manifest),
			},
			nowIso,
		);
	}

	function remove(name: string): void {
		deleteSkill(sql, name);
	}

	function community(): CommunityResponse {
		return {
			source: "https://github.com/badlogic/pi-skills",
			skills: COMMUNITY_SKILLS.map((item) => ({
				...item,
				url: `${COMMUNITY_RAW_BASE}/${item.name}/SKILL.md`,
				runtime: "other" as SkillRuntime,
				audit_status: "blocked" as const,
				audit: {
					status: "blocked" as const,
					reasons: [
						{
							rule: "M3",
							level: "blocked" as const,
							message: item.needsLocal
								? "需要本機執行時可執行能力（命令列/子系統），託管環境無法執行"
								: "依賴託管環境未提供的宿主能力，安裝後無法執行",
						},
					],
					detected: { runtime: "other" as SkillRuntime, network: [], tools: [] },
					auditedAt: now().toISOString(),
					hash: "",
					rulesVersion: RULES_VERSION,
					auditSource: "catalog" as const,
				},
			})),
		};
	}

	/** audit=blocked 檢視要能看到 8 條社群技能（驗收 9）：轉成 Hub 條目，不可安裝。 */
	function communityHubEntries(): HubSkill[] {
		return community().skills.map((skill) => ({
			name: skill.name,
			version: "0.0.0",
			description: skill.description,
			author: "badlogic",
			source: community().source,
			license: "UNLICENSED",
			runtime: "other",
			tags: [],
			requires: { tools: [], bindings: [], network: [] },
			contentHash: "",
			installed: false,
			audit: skill.audit,
			origin: "remote",
		}));
	}

	function metrics(daysRaw: unknown): MetricsResponse {
		const days = Math.min(METRICS_MAX_DAYS, Math.max(1, Math.floor(Number(daysRaw ?? 7)) || 7));
		const since = now().getTime() - days * 86_400_000;
		const counts = eventCounts(sql, since);
		const installOk = counts.skill_install ?? 0;
		const installBlocked = counts.skill_blocked ?? 0;
		const installed = countSkills(sql);
		return {
			days,
			since,
			hubViews: counts.skill_hub_view ?? 0,
			installOk,
			installBlocked,
			blockedRatio: installOk + installBlocked ? installBlocked / (installOk + installBlocked) : 0,
			installed,
			called7d: invokedNames(sql, since).length,
		};
	}

	return {
		hub,
		auditFor,
		importSkill,
		listCompat,
		addManual,
		remove,
		community,
		metrics,
		track,
		/** 供 worker.ts 的 load_skill / 顯式技能呼叫寫入同一套事件（NERE-59）。 */
		trackCall: (name: string, kind: "loaded" | "invoked") =>
			track(kind === "loaded" ? "skill_loaded" : "skill_invoked", name, kind),
	};
}

export type SkillService = {
	hub(query?: HubQuery): Promise<HubResponse>;
	auditFor(name: string): Promise<{ name: string; version: string; contentHash: string; source: string; audit: AuditReport }>;
	importSkill(body: unknown): Promise<ImportResult>;
	listCompat(): { skills: Record<string, unknown>[] };
	addManual(input: { name: string; description: string; content: string }): Promise<void>;
	remove(name: string): void;
	community(): CommunityResponse;
	metrics(daysRaw: unknown): MetricsResponse;
	track(type: SkillEventType, name: string, source?: string, meta?: string): void;
	trackCall(name: string, kind: "loaded" | "invoked"): void;
};

/**
 * 識別訊息開頭的「/技能名」（v0.23.0）：命中已安裝且未 blocked 的技能時返回正文與去掉字首的正文。
 * 顯式呼叫會寫 `skill_invoked` 埋點；任何讀取失敗都按「未命中」處理，不阻塞對話。
 */
export function parseSkillInvocation(
	sql: SqlHandle,
	message: string,
): { name: string; content: string; rest: string } | null {
	const trimmed = message.trimStart();
	if (!trimmed.startsWith("/")) return null;
	const match = /^\/(\S{1,60})(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return null;
	try {
		const row = getSkillRow(sql, match[1]!);
		if (!row || row.auditStatus === "blocked") return null;
		trackSkillCall(sql, row.name, "invoked");
		return { name: row.name, content: row.content, rest: (match[2] ?? "").trim() };
	} catch {
		return null;
	}
}
