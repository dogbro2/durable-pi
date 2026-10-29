import type { SqlHandle } from "../db/migrations";
import { AppError } from "../http/errors";
import { shareTokenOwner, shareTokenPrefix, type SettingsPort, type ShareRuntime } from "../http/ports";
import { entryText } from "../lib/entries";
import {
	expiredSharePage,
	isShareTheme,
	markdownToHtml,
	shareFileCard,
	sharePage,
	shareToc,
	writeFileResult,
	type ShareHeading,
	type SharePage,
	type ShareThemeId,
} from "../lib/share-render";
import { getContent } from "../repo/files-repo";
import { get as getSession } from "../repo/sessions-repo";
import {
	deleteByToken,
	getByToken,
	insert,
	latestTokenForFile,
	listAll as listAllRows,
	listUnexpired,
	purgeExpired,
	recordOpen,
	type ShareKind,
	type ShareRow,
	type ShareStatus,
} from "../repo/shares-repo";

/**
 * 分享域用例（ADR-0001 §2）：token / TTL / 主題 / 渲染編排都在這裡。
 * SQL 在 repo/shares-repo.ts 與 repo/files-repo.ts，純字串在 lib/share-render.ts。
 * 會話條目通過 `runtime` 埠讀取——檔案分享、失效與過期 token 都走不到它，因此不啟動 Harness。
 */

export type ShareRecord = {
	token: string;
	kind: string;
	name: string;
	expiresAt: number;
	theme: string;
	createdAt: string;
};

/** `/api/shares/all` 的一行（NERE-42）：相對 `url` 由前端按當前域名拼絕對地址。 */
export type ShareSummary = {
	token: string;
	kind: ShareKind;
	name: string;
	expiresAt: number;
	theme: string;
	createdAt: string;
	openCount: number;
	lastOpenedAt: number;
	sessionId: string;
	url: string;
};

export type ShareServiceDeps = {
	sql: SqlHandle;
	settings: SettingsPort;
	/** 分享連結的絕對域名：優先本次請求 Origin，alarm 場景由呼叫方回落到 share_origin。 */
	origin: string;
	/** 請求身份；邀請使用者的分享 token 帶 `<userId>.` 字首。 */
	userKey: string;
	/** `DEMO_SHARE_URL` 指向的 token；命中時分享頁頂部加「這是隻讀樣例」橫條。 */
	demoToken?: string;
	/** `REPO_URL`：頁尾「用同樣的方式做一個」出口；留空則不渲染（自架例項不必掛別人的倉庫）。 */
	repoUrl?: string;
	/** 會話解析埠；只有 HTTP 端點的 create/list/render 需要。 */
	runtime?: ShareRuntime;
	now?: () => number;
};

export type CreateShareInput = {
	sessionId?: string;
	kind: ShareKind;
	name?: string;
	ttlSeconds?: number;
	theme?: string;
};

export type ToolShare = { share: ShareRecord; reused: boolean };

export interface ShareService {
	create(input: CreateShareInput): Promise<{ token: string; expiresAt: number }>;
	list(sessionId: string | undefined, kind: ShareKind, name?: string): Promise<ShareRecord[]>;
	/** 當前使用者的全量分享清單（NERE-42），`status` 預設 active。 */
	listAll(status?: string | null): ShareSummary[];
	/** 撤銷當前使用者自己的分享（NERE-42）：立即刪行，連結隨即 404；越權 403。 */
	revoke(token: string): void;
	/** 分享頁（服務端渲染，只讀）。html 檔案原樣輸出，其餘按 Markdown 渲染。
	 * `openerIp` 只用於去重計數，落庫前雜湊，原始地址不持久化。 */
	render(token: string, themeOverride?: string | null, openerIp?: string): Promise<SharePage | null>;
	/** 模型工具入口：會話 id 已知，先複用未過期連結，否則按解析後的 TTL 新建。 */
	shareForTool(kind: ShareKind, conversationId: string, name: string, ttlValue: unknown): ToolShare;
	urlFor(token: string): string;
	sessionTitle(conversationId: string): string;
}

/** `status` 只認契約裡的三個值；預設/未知一律按 active（與前端預設值一致）。 */
export function normalizeShareStatus(value: unknown): ShareStatus {
	return value === "expired" || value === "all" ? value : "active";
}

/** 分享預設有效期（秒）：0 = 永久；與分享彈窗預設的 7 天一致。 */
export const DEFAULT_SHARE_TTL = 7 * 86400;
export const MAX_SHARE_TTL = 365 * 86400;

export function shareDefaultTtl(settings: SettingsPort): number {
	const raw = Number(settings.get("share_ttl_seconds", String(DEFAULT_SHARE_TTL)));
	return Number.isFinite(raw) && raw >= 0 ? Math.min(Math.floor(raw), MAX_SHARE_TTL) : DEFAULT_SHARE_TTL;
}

/** 解析分享有效期：未傳（undefined/null/""）沿用設定預設；顯式 0 表示永久。 */
export function shareTtlSeconds(value: unknown, settings: SettingsPort): number {
	if (value === undefined || value === null || value === "") return shareDefaultTtl(settings);
	const raw = Number(value);
	if (!Number.isFinite(raw) || raw < 0) return shareDefaultTtl(settings);
	return Math.min(raw, MAX_SHARE_TTL);
}

/** 分享頁署名：設定裡的 displayName，未設定時回落到產品名。 */
export function shareAuthor(settings: SettingsPort): string {
	return settings.get("display_name", "").trim().slice(0, 40) || "Durable Pi";
}

/** 無歧義 token：base32 字元集，避免 0/1/l/o 混淆（v0.55.0 起 12 位元組）。 */
function newShareToken(tokenPrefix: string): string {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return `${tokenPrefix}${[...bytes].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("")}`;
}

/** 複用條件：未過期，且有效期覆蓋本次請求（顯式 0 = 永久）。 */
function reusableShare(rows: ShareRecord[], ttlSeconds: number, now: number): ShareRecord | undefined {
	// 顯式「永久」只能複用永久的；其它 TTL 允許 10 秒誤差，避免「7 天」重問時因幾毫秒差新建 token
	if (ttlSeconds === 0) return rows.find((row) => row.expiresAt === 0);
	const needed = now + ttlSeconds * 1000 - 10_000;
	return rows.find((row) => row.expiresAt === 0 || row.expiresAt >= needed);
}

function toRecord(row: ShareRow): ShareRecord {
	return {
		token: row.token,
		kind: row.kind,
		name: row.name,
		expiresAt: Number(row.expiresAt ?? 0),
		theme: row.theme ?? "dark",
		createdAt: row.createdAt,
	};
}

/**
 * 開啟者指紋（NERE-42）：SHA-256(token + IP)，以 token 作鹽，
 * 同一 IP 在不同連結上得到不同值，庫裡不出現原始地址。
 */
async function openerFingerprint(token: string, ip: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${token}\n${ip.trim()}`));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createShareService(deps: ShareServiceDeps): ShareService {
	const { sql, settings, origin, repoUrl = "" } = deps;
	const now = deps.now ?? Date.now;
	const demoToken = deps.demoToken ?? "";
	const runtime = deps.runtime;
	const tokenPrefix = shareTokenPrefix(deps.userKey);

	/** 撤銷歸屬：帶字首的 token 必須屬於當前使用者；無字首舊連結只屬於主人（userKey 不是邀請使用者）。 */
	function assertRevocable(token: string): void {
		const owner = shareTokenOwner(token);
		const mine = owner ? `${owner}.` === tokenPrefix : tokenPrefix === "";
		if (!mine) throw new AppError("forbidden", 403, "無權撤銷該分享");
	}

	function toSummary(row: ShareRow): ShareSummary {
		return {
			token: row.token,
			kind: row.kind === "file" ? "file" : "conversation",
			name: row.name,
			expiresAt: Number(row.expiresAt ?? 0),
			theme: row.theme ?? "dark",
			createdAt: row.createdAt,
			openCount: Number(row.openCount ?? 0),
			lastOpenedAt: Number(row.lastOpenedAt ?? 0),
			sessionId: row.sessionId,
			// 契約要求相對路徑：服務端可能部署在反代後，origin 不可靠。
			url: `/s/${row.token}`,
		};
	}

	function conversationRuntime(): ShareRuntime {
		if (!runtime) throw new Error("分享服務缺少會話埠");
		return runtime;
	}

	/** 生成一條分享記錄。ttlSeconds 已解析：0 = 永久。 */
	function createRecord(
		conversationId: string,
		kind: ShareKind,
		name: string,
		ttlSeconds: number,
		theme: string | undefined,
	): ShareRecord {
		const fileName = name.trim();
		if (kind === "file") {
			if (!fileName) throw new Error("缺少檔名");
			if (!getContent(sql, conversationId, fileName)) throw new Error("檔案不存在");
		}
		// 清掉已過期的分享，避免表無限增長
		const at = now();
		purgeExpired(sql, at);
		const expiresAt = ttlSeconds > 0 ? at + Math.min(ttlSeconds, MAX_SHARE_TTL) * 1000 : 0;
		const themeId: ShareThemeId = isShareTheme(theme) ? theme : "dark";
		const record: ShareRecord = {
			token: newShareToken(tokenPrefix),
			kind,
			name: fileName,
			expiresAt,
			theme: themeId,
			createdAt: new Date().toISOString(),
		};
		insert(sql, {
			token: record.token,
			kind,
			sessionId: conversationId,
			name: record.name,
			expiresAt,
			theme: themeId,
			createdAt: record.createdAt,
		});
		return record;
	}

	/** 未過期的分享連結（新→舊）。 */
	function unexpired(conversationId: string, kind: ShareKind, name?: string): ShareRecord[] {
		return listUnexpired(sql, conversationId, kind, (name ?? "").trim(), now()).map(toRecord);
	}

	function fileShareHref(conversationId: string, name: string): string | undefined {
		const token = latestTokenForFile(sql, conversationId, name, now());
		return token ? `/s/${token}` : undefined;
	}

	return {
		async create(input) {
			const conversationId = await conversationRuntime().conversationId(input.sessionId);
			return createRecord(
				conversationId,
				input.kind,
				input.name ?? "",
				shareTtlSeconds(input.ttlSeconds, settings),
				input.theme,
			);
		},

		async list(sessionId, kind, name) {
			const conversationId = await conversationRuntime().conversationId(sessionId);
			return unexpired(conversationId, kind, name);
		},

		listAll(status) {
			return listAllRows(sql, normalizeShareStatus(status), now()).map(toSummary);
		},

		revoke(token) {
			if (!token) throw new AppError("not_found", 404, "分享連結不存在");
			assertRevocable(token);
			if (!deleteByToken(sql, token)) throw new AppError("not_found", 404, "分享連結不存在");
		},

		shareForTool(kind, conversationId, name, ttlValue) {
			const ttl = shareTtlSeconds(ttlValue, settings);
			const explicit = ttlValue !== undefined && ttlValue !== null && ttlValue !== "";
			const rows = unexpired(conversationId, kind, name);
			// 不傳 ttlSeconds（沿用設定預設）時直接複用任意未過期連結；顯式要求則必須覆蓋本次 TTL
			const existing = explicit ? reusableShare(rows, ttl, now()) : rows[0];
			if (existing) return { share: existing, reused: true };
			return { share: createRecord(conversationId, kind, name, ttl, undefined), reused: false };
		},

		urlFor(token) {
			return `${origin}/s/${token}`;
		},

		sessionTitle(conversationId) {
			try {
				return getSession(sql, conversationId)?.title?.trim() || "當前對話";
			} catch {
				return "當前對話";
			}
		},

		async render(token, themeOverride, openerIp = "") {
			const row = getByToken(sql, token);
			if (!row) return null;
			// ?theme= 可臨時覆蓋；否則用分享時記錄的主題，老連結回落深色
			const theme: ShareThemeId = isShareTheme(themeOverride)
				? themeOverride
				: isShareTheme(row.theme)
					? row.theme
					: "dark";
			const expiresAt = Number(row.expiresAt ?? 0);
			if (expiresAt > 0 && expiresAt <= now()) return expiredSharePage(row.name, expiresAt, theme);
			// NERE-42：有效連結的開啟才計數；同一 IP 指紋 1 小時內只計 1 次（repo 層判重）。
			recordOpen(sql, token, await openerFingerprint(token, openerIp), now());
			// 登入頁「看一個真實對話」落到的那條分享：頂部加一條只讀樣例說明（NERE-46）。
			const demo = demoToken !== "" && demoToken === token;

			if (row.kind === "file") {
				const file = getContent(sql, row.sessionId, row.name);
				if (!file) {
					return { status: 404, contentType: "text/plain; charset=utf-8", body: "檔案已刪除，分享不再可用" };
				}
				// HTML 原樣輸出：獨立頁面才能帶樣式與指令碼。CSP sandbox 讓它落在不透明源，
				// 即使有人開啟惡意產物，也讀不到本站 cookie / Storage。
				if (/\.html?$/i.test(row.name)) {
					return {
						status: 200,
						contentType: "text/html; charset=utf-8",
						body: file.content,
						headers: { "content-security-policy": "sandbox allow-scripts" },
					};
				}
				const headings: ShareHeading[] = [];
				const usedIds = new Set<string>();
				const article = markdownToHtml(file.content, { headings, usedIds });
				return {
					status: 200,
					contentType: "text/html; charset=utf-8",
					body: sharePage(
						row.name || "檔案",
						`<article class="article">${article}</article>`,
						expiresAt,
						theme,
						shareToc(headings),
						{ author: shareAuthor(settings), createdAt: row.createdAt },
						demo,
						repoUrl,
					),
				};
			}

			const sessionId = row.sessionId;
			const items = await conversationRuntime().entries(sessionId);
			const title = getSession(sql, sessionId)?.title ?? "對話";
			const parts: string[] = [];
			// 對話分享也生成目錄：所有訊息共用一套錨點 id（v0.41.0）
			const headings: ShareHeading[] = [];
			const usedIds = new Set<string>();
			for (const entry of [...items].reverse()) {
				const item = entry as Record<string, unknown>;
				const kind = String(item.kind ?? "");
				const text = entryText(item.model).trim();
				if (!text) continue;
				if (kind === "pi.user") {
					parts.push(`<div class="msg user"><div class="who">使用者</div><div class="md">${markdownToHtml(text, { headings, usedIds })}</div></div>`);
				} else if (kind === "pi.assistant") {
					parts.push(`<div class="msg bot"><div class="who">助手</div><div class="md">${markdownToHtml(text, { headings, usedIds })}</div></div>`);
				} else if (kind === "pi.tool-result") {
					// 工作臺寫入在分享頁裡補一張檔案卡（NERE-13）：有同一檔案的分享連結時可直接開啟。
					const blocks = Array.isArray(item.model) ? (item.model as { toolName?: unknown; isError?: unknown }[]) : [];
					const block = blocks[0];
					if (block?.toolName === "write_file" && !block.isError) {
						const file = writeFileResult(text);
						if (file) parts.push(shareFileCard(file.name, file.size, fileShareHref(sessionId, file.name)));
					}
				}
			}
			return {
				status: 200,
				contentType: "text/html; charset=utf-8",
				body: sharePage(
					title,
					// 訊息與檔案卡必須包在一個容器裡：main.with-toc 是兩列網格，
					// 頂層節點會各自成為網格項，導致檔案卡跑到目錄下面。
					`<div class="thread">${parts.join("") || "<p class='empty'>（暫無內容）</p>"}</div>`,
					expiresAt,
					theme,
					shareToc(headings),
					{ author: shareAuthor(settings), createdAt: row.createdAt },
					demo,
					repoUrl,
				),
			};
		},
	};
}
