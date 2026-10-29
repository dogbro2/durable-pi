/**
 * 技能匯入的抓取邊界（NERE-55，契約 §4.2 X1–X4 與 §5.4）。
 *
 * 只做「URL 合法化 + 抓取 + 位元組/型別限制」，不審計、不落庫：
 * 審計是 `lib/skill-audit.ts` 的純函式，寫入在 `services/skill-service.ts`。
 */

import {
	IMPORT_CONTENT_MAX_BYTES,
	IMPORT_REDIRECT_LIMIT,
	IMPORT_TIMEOUT_MS,
	byteLength,
	checkImportUrl,
	type AuditReason,
} from "./skill-audit";

/** 抓取失敗的分類：由 Service 對映成 4xx/5xx，不在這裡拼響應。 */
export class SkillFetchError extends Error {
	constructor(
		readonly rule: "X1" | "X2" | "X3" | "X4",
		readonly status: 413 | 422 | 502,
		message: string,
		readonly evidence?: string,
	) {
		super(message);
		this.name = "SkillFetchError";
	}
}

export type FetchSkillText = { text: string; url: string; contentType: string };

/** 把 GitHub 頁面/目錄連結統一成 raw 地址；非 http(s) 返回 null。 */
export function normalizeSkillUrl(input: string): string | null {
	const url = input.trim();
	if (!/^https?:\/\//.test(url)) return null;
	const repo = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+)$/.exec(url);
	if (repo) {
		const [, owner, name, branch, path] = repo;
		const clean = path!.replace(/\/+$/, "");
		const file = /\.(?:md|json|js)$/i.test(clean) ? clean : `${clean}/SKILL.md`;
		return `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${file}`;
	}
	if (/^https?:\/\/raw\.githubusercontent\.com\/.+$/.test(url)) {
		return /\.[a-z]+$/i.test(url) ? url : `${url.replace(/\/+$/, "")}/SKILL.md`;
	}
	if (/\.(?:md|json|js)$/i.test(url)) return url;
	return `${url.replace(/\/+$/, "")}/SKILL.md`;
}

/**
 * 相容社群技能的「入口 stub」：本 harness 沒有 Skill 工具，改成 load_skill。
 * 只改正文，不參與審計判定（改寫後正文與釋出雜湊不再等價時，呼叫方跳過目錄雜湊校驗）。
 */
export function rewriteSkillStub(body: string): string {
	return body.replace(
		/Call the Skill tool with\s+["'“]([^"'”]+)["'”][.。]?/gi,
		'呼叫 load_skill("$1") 讀取完整流程後再繼續。',
	);
}

const TEXT_CONTENT_TYPES = new Set(["text/markdown", "text/plain", "text/x-markdown", "application/json"]);

function isTextContentType(value: string): boolean {
	const type = value.split(";")[0]?.trim().toLowerCase() ?? "";
	if (!type) return true; // 預設按 text 處理（契約 X4）
	return TEXT_CONTENT_TYPES.has(type);
}

/**
 * 抓取一份技能文本；每一跳重定向都重新做 X1/X2 校驗。
 * 失敗拋 `SkillFetchError`，呼叫方決定 HTTP 狀態。
 */
export async function fetchSkillText(
	rawUrl: string,
	fetchImpl: typeof fetch = fetch,
): Promise<FetchSkillText> {
	let current = rawUrl;
	for (let hop = 0; hop <= IMPORT_REDIRECT_LIMIT; hop += 1) {
		const checked = checkImportUrl(current);
		if (!checked.ok) {
			throw new SkillFetchError(checked.rule as "X1" | "X2", 422, checked.message, checked.evidence);
		}
		let response: Response;
		try {
			response = await fetchImpl(checked.url.toString(), {
				redirect: "manual",
				headers: { "user-agent": "durable-pi-skill-import" },
				signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
			});
		} catch (err) {
			if (err instanceof SkillFetchError) throw err;
			throw new SkillFetchError("X3", 502, `抓取失敗：${String(err).slice(0, 120)}`);
		}
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) {
				throw new SkillFetchError("X3", 502, `抓取失敗：HTTP ${response.status} 缺少 Location`);
			}
			current = new URL(location, checked.url).toString();
			continue;
		}
		if (!response.ok) {
			throw new SkillFetchError("X3", 502, `抓取失敗：HTTP ${response.status}`);
		}
		const contentType = response.headers.get("content-type") ?? "";
		if (!isTextContentType(contentType)) {
			throw new SkillFetchError("X4", 422, "內容型別不支援：只接受 Markdown / 純文本 / JSON", contentType.slice(0, 120));
		}
		const text = await response.text();
		if (byteLength(text) > IMPORT_CONTENT_MAX_BYTES) {
			throw new SkillFetchError("X3", 413, "抓取內容超過 512 KiB", `實際 ${byteLength(text)} 位元組`);
		}
		return { text, url: checked.url.toString(), contentType };
	}
	throw new SkillFetchError("X3", 502, "重定向超過 3 次");
}

/** 把抓取失敗轉成審計 reason（用於 blocked 報告）。 */
export function fetchFailureReason(failure: SkillFetchError): AuditReason {
	return {
		rule: failure.rule,
		level: "blocked",
		message: failure.message,
		...(failure.evidence ? { evidence: failure.evidence.slice(0, 120) } : {}),
	};
}
