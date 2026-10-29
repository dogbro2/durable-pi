import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillHubPanel } from "../../src/web/components/SkillHubPanel";
import { SkillHubRow } from "../../src/web/components/SkillHubRow";
import { api } from "../../src/web/lib/api";
import {
	BLOCKED_HINT,
	EMPTY_SKILL_HUB_FILTERS,
	HUB_RUNTIME_FILTERS,
	canInstallHubEntry,
	filterHubSkills,
	hasActiveHubFilters,
	hubEntryInstallUrl,
	installFailureMessage,
	isHubEntryUpdatable,
	parseHubPage,
	parseHubSkills,
	sortHubSkills,
	sourceHost,
	type SkillHubFilters,
} from "../../src/web/lib/skill-hub";
import type { SkillHubEntry } from "../../src/web/types";

/**
 * 驗收用的 6 條示例（NERE-53 契約 §驗收）：3 pass（純提示詞 / 純 JS / TS+聯網）、
 * 1 warn（宣告網路但未使用）、2 blocked（Python / shell）。
 * 欄位按契約 §5.2：source 是 URL，audit 是完整 AuditReport（reasons 為物件）。
 */
const RAW_SKILLS = [
	{
		name: "meeting-notes",
		version: "1.2.0",
		description: "把會議記錄整理成結構化紀要，純提示詞技能，無需指令碼。",
		author: "pi-skills",
		source: "https://github.com/badlogic/pi-skills/tree/main/meeting-notes",
		license: "MIT",
		runtime: "prompt",
		tags: ["writing", "notes"],
		contentHash: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
		installed: false,
		audit: {
			status: "pass",
			reasons: [],
			detected: { runtime: "prompt", network: [], tools: [] },
			auditedAt: "2026-10-21T08:00:00Z",
			hash: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
			rulesVersion: 1,
			auditSource: "local",
		},
	},
	{
		name: "pdf-to-markdown",
		version: "0.4.1",
		description: "把 PDF 拆成 Markdown，內建純 JS 解析器。",
		author: "community",
		source: "https://github.com/example/skills/tree/main/pdf-to-markdown",
		license: "Apache-2.0",
		runtime: "javascript",
		tags: ["document", "pdf"],
		contentHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
		installed: false,
		audit: {
			status: "pass",
			reasons: [],
			detected: { runtime: "javascript", network: [], tools: ["vfs"] },
		},
	},
	{
		name: "web-snapshot",
		version: "2.0.0",
		description: "抓取網頁並截圖歸檔，已宣告 api.github.com 出站。",
		author: "community",
		source: "https://github.com/example/skills/tree/main/web-snapshot",
		license: "MIT",
		runtime: "typescript",
		tags: ["web", "screenshot"],
		contentHash: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
		installed: false,
		audit: {
			status: "pass",
			reasons: [],
			detected: { runtime: "typescript", network: ["api.github.com"], tools: ["fetch", "write_file"] },
			hash: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
		},
	},
	{
		name: "crm-sync",
		version: "1.0.0",
		description: "把客戶記錄同步到 CRM，聲明瞭網路許可權。",
		author: "acme",
		source: "https://skills.acme.dev/crm-sync",
		license: "UNLICENSED",
		runtime: "javascript",
		tags: ["crm"],
		contentHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
		installed: true,
		installedHash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
		audit: {
			status: "warning",
			reasons: [
				{
					rule: "S2",
					level: "warn",
					message: "聲明瞭網路許可權 crm.example.com，但正文未使用",
					evidence: "requires.network: crm.example.com",
				},
			],
			detected: { runtime: "javascript", network: ["crm.example.com"], tools: [] },
		},
	},
	{
		name: "legacy-report",
		version: "3.1.0",
		description: "用 Python 生成周報 PDF。",
		author: "legacy",
		source: "https://github.com/legacy/skills/tree/main/legacy-report",
		license: "GPL-3.0",
		runtime: "python",
		tags: ["report"],
		contentHash: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
		installed: false,
		audit: {
			status: "blocked",
			reasons: [
				{
					rule: "M3",
					level: "blocked",
					message: "執行時 python 不受支援：僅支援 JS/TS 與純提示詞技能",
					evidence: "#!/usr/bin/env python3",
				},
			],
			detected: { runtime: "python", network: [], tools: ["requests"] },
			hash: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
		},
	},
	{
		name: "deploy-hook",
		version: "0.1.0",
		description: "部署完成後跑的 shell 鉤子。",
		author: "legacy",
		source: "https://github.com/legacy/skills/tree/main/deploy-hook",
		license: "UNLICENSED",
		runtime: "shell",
		tags: ["deploy"],
		contentHash: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
		installed: false,
		audit: {
			status: "blocked",
			reasons: [
				{
					rule: "M3",
					level: "blocked",
					message: "檢測到 `#!/usr/bin/env bash` 指令碼；Worker 不能執行 shell",
					evidence: "#!/usr/bin/env bash",
				},
			],
			detected: { runtime: "shell", network: [], tools: ["bash"] },
		},
	},
];

const ENTRIES = parseHubSkills({ skills: RAW_SKILLS });
const byName = (name: string): SkillHubEntry => ENTRIES.find((entry) => entry.name === name)!;
const filters = (patch: Partial<SkillHubFilters>): SkillHubFilters => ({ ...EMPTY_SKILL_HUB_FILTERS, ...patch });

describe("parseHubSkills · 契約對映", () => {
	it("6 條示例按順序解析，欄位與審計詳情齊全", () => {
		expect(ENTRIES.map((entry) => entry.name)).toEqual([
			"meeting-notes",
			"pdf-to-markdown",
			"web-snapshot",
			"crm-sync",
			"legacy-report",
			"deploy-hook",
		]);
		expect(byName("web-snapshot")).toMatchObject({
			version: "2.0.0",
			runtime: "typescript",
			tags: ["web", "screenshot"],
			license: "MIT",
			installed: false,
			audit: {
				status: "pass",
				detected: { runtime: "typescript", network: ["api.github.com"], tools: ["fetch", "write_file"] },
			},
		});
		expect(byName("web-snapshot").audit.hash).toBe(
			"sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
		);
		expect(byName("meeting-notes").audit).toMatchObject({ rulesVersion: 1, auditSource: "local" });
	});

	it("AuditReason 物件保留 rule / level / message / evidence", () => {
		expect(byName("legacy-report").audit.reasons).toEqual([
			{
				rule: "M3",
				level: "blocked",
				message: "執行時 python 不受支援：僅支援 JS/TS 與純提示詞技能",
				evidence: "#!/usr/bin/env python3",
			},
		]);
	});

	it("早期字串 reasons 仍相容", () => {
		const entries = parseHubSkills({ skills: [{ name: "old", audit: { status: "warn", reasons: ["舊格式原因"] } }] });
		expect(entries[0]?.audit.reasons).toEqual([{ message: "舊格式原因" }]);
	});

	it("installed / installedHash 從服務端讀取", () => {
		expect(byName("crm-sync").installed).toBe(true);
		expect(byName("crm-sync").installedHash).toMatch(/^sha256:333/);
		expect(isHubEntryUpdatable(byName("crm-sync"))).toBe(true);
		expect(isHubEntryUpdatable(byName("web-snapshot"))).toBe(false);
	});

	it("非陣列 / 缺 skills 包裝 → 空陣列", () => {
		expect(parseHubSkills(null)).toEqual([]);
		expect(parseHubSkills("oops")).toEqual([]);
		expect(parseHubSkills({})).toEqual([]);
	});

	it("丟棄無名稱條目；未知審計狀態按 warn 並補原因", () => {
		const entries = parseHubSkills({
			skills: [{ description: "沒有名字" }, { name: "mystery", audit: { status: "unknown" } }],
		});
		expect(entries.map((entry) => entry.name)).toEqual(["mystery"]);
		expect(entries[0]?.audit.status).toBe("warn");
		expect(entries[0]?.audit.reasons.map((reason) => reason.message).join()).toContain("審計狀態缺失或無法識別");
	});

	it("warning / passed 等別名歸一", () => {
		expect(byName("crm-sync").audit.status).toBe("warn");
		const entries = parseHubSkills({ skills: [{ name: "old", audit: { status: "passed" } }] });
		expect(entries[0]?.audit.status).toBe("pass");
	});
});

describe("parseHubPage · 列表響應包裝（契約 §5.2）", () => {
	it("total / catalog / filters 都解析；runtimes 只留可安裝三種", () => {
		const page = parseHubPage({
			skills: RAW_SKILLS,
			total: 6,
			nextOffset: null,
			catalog: { source: "remote", fetchedAt: "2026-10-22T01:00:00Z", stale: true, count: 6 },
			filters: {
				runtimes: ["prompt", "javascript", "typescript", "python", "shell"],
				tags: ["web", "crm"],
				sources: ["github.com"],
			},
		});
		expect(page.entries).toHaveLength(6);
		expect(page.total).toBe(6);
		expect(page.catalog).toMatchObject({ source: "remote", stale: true, count: 6 });
		expect(page.options.runtimes).toEqual(["prompt", "javascript", "typescript"]);
		expect(page.options.tags).toEqual(["web", "crm"]);
		expect(page.options.sources).toEqual(["github.com"]);
	});

	it("缺 catalog / filters 時給安全預設值", () => {
		const page = parseHubPage({ skills: [] });
		expect(page.catalog).toBeNull();
		expect(page.options).toEqual({ runtimes: [], tags: [], sources: [] });
		expect(page.total).toBe(0);
	});
});

describe("filterHubSkills · 篩選維度（驗收 1）", () => {
	it("runtime 篩選項只有 prompt / javascript / typescript", () => {
		expect(HUB_RUNTIME_FILTERS.map((option) => option.value)).toEqual([
			"",
			"javascript,typescript",
			"typescript",
			"javascript",
			"prompt",
		]);
		for (const option of HUB_RUNTIME_FILTERS) {
			for (const value of option.value.split(",").filter(Boolean)) {
				expect(["prompt", "javascript", "typescript"]).toContain(value);
			}
		}
	});

	it("runtime=TS 只剩 JS/TS 裡的 TypeScript 條目", () => {
		expect(filterHubSkills(ENTRIES, filters({ runtime: "typescript" })).map((entry) => entry.name)).toEqual(["web-snapshot"]);
		expect(filterHubSkills(ENTRIES, filters({ runtime: "ts" })).map((entry) => entry.name)).toEqual(["web-snapshot"]);
	});

	it("runtime=JS/TS 分組保留全部 JS/TS，Python / shell 被排除", () => {
		expect(filterHubSkills(ENTRIES, filters({ runtime: "javascript,typescript" })).map((entry) => entry.name)).toEqual([
			"pdf-to-markdown",
			"web-snapshot",
			"crm-sync",
		]);
	});

	it("audit=blocked 只剩 Python 與 shell 兩條", () => {
		expect(filterHubSkills(ENTRIES, filters({ audit: "blocked" })).map((entry) => entry.name)).toEqual([
			"legacy-report",
			"deploy-hook",
		]);
	});

	it("搜尋命中名稱、描述與標籤（大小寫不敏感）", () => {
		expect(filterHubSkills(ENTRIES, filters({ q: "CRM" })).map((entry) => entry.name)).toEqual(["crm-sync"]);
		expect(filterHubSkills(ENTRIES, filters({ q: "紀要" })).map((entry) => entry.name)).toEqual(["meeting-notes"]);
		expect(filterHubSkills(ENTRIES, filters({ q: "screenshot" })).map((entry) => entry.name)).toEqual(["web-snapshot"]);
		expect(filterHubSkills(ENTRIES, filters({ q: "不存在的技能" }))).toEqual([]);
	});

	it("tag / source(host) / 組合篩選", () => {
		expect(filterHubSkills(ENTRIES, filters({ tag: "web" })).map((entry) => entry.name)).toEqual(["web-snapshot"]);
		expect(filterHubSkills(ENTRIES, filters({ source: "acme" })).map((entry) => entry.name)).toEqual(["crm-sync"]);
		expect(filterHubSkills(ENTRIES, filters({ source: "github.com" }))).toHaveLength(5);
		expect(filterHubSkills(ENTRIES, filters({ runtime: "javascript", audit: "pass" })).map((entry) => entry.name)).toEqual([
			"pdf-to-markdown",
		]);
	});

	it("sourceHost 從 URL 取 host，local 原樣保留", () => {
		expect(sourceHost("https://github.com/acme/skills/tree/main/crm-sync")).toBe("github.com");
		expect(sourceHost("local")).toBe("local");
		expect(sourceHost("")).toBe("");
	});
});

describe("sortHubSkills · 預設 audit 優先", () => {
	it("pass → warn → blocked，同級按名稱", () => {
		const sorted = sortHubSkills(ENTRIES);
		expect(sorted.map((entry) => entry.audit.status)).toEqual(["pass", "pass", "pass", "warn", "blocked", "blocked"]);
		expect(sorted.slice(-2).map((entry) => entry.name)).toEqual(["deploy-hook", "legacy-report"]);
	});

	it("不修改入參", () => {
		const before = ENTRIES.map((entry) => entry.name);
		sortHubSkills(ENTRIES);
		expect(ENTRIES.map((entry) => entry.name)).toEqual(before);
	});
});

describe("安裝門檻（驗收 2）", () => {
	it("blocked 一律不可安裝，即使有 http(s) 來源", () => {
		expect(byName("legacy-report").source).toMatch(/^https:\/\//);
		expect(canInstallHubEntry(byName("legacy-report"))).toBe(false);
		expect(canInstallHubEntry(byName("deploy-hook"))).toBe(false);
	});

	it("pass / warn 有 http(s) 來源時可安裝", () => {
		expect(canInstallHubEntry(byName("web-snapshot"))).toBe(true);
		expect(canInstallHubEntry(byName("crm-sync"))).toBe(true);
		expect(hubEntryInstallUrl(byName("web-snapshot"))).toBe("https://github.com/example/skills/tree/main/web-snapshot");
	});

	it("沒有安裝地址時不發請求", () => {
		const entry = { ...byName("meeting-notes"), source: "local" };
		expect(hubEntryInstallUrl(entry)).toBe("");
		expect(canInstallHubEntry(entry)).toBe(false);
		expect(hasActiveHubFilters(EMPTY_SKILL_HUB_FILTERS)).toBe(false);
		expect(hasActiveHubFilters(filters({ audit: "pass" }))).toBe(true);
	});
});

describe("api.skillHub · 查詢串", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("只拼契約裡的引數，空值省略", async () => {
		const calls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ skills: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch);

		await api.skillHub({
			q: "週報",
			runtime: "typescript",
			audit: "blocked",
			source: "github.com",
			origin: "remote",
			installed: "0",
			sort: "name",
			limit: 50,
			offset: 20,
		});
		await api.skillHub();
		expect(calls).toEqual([
			"/api/skills/hub?q=%E9%80%B1%E5%A0%B1&runtime=typescript&audit=blocked&source=github.com&origin=remote&installed=0&sort=name&limit=50&offset=20",
			"/api/skills/hub",
		]);
	});
});

describe("api.importSkill · 422 審計攔截（契約 §5.4）", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("422 不拋錯，帶出 code / auditStatus / details.audit.reasons", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: false,
					installed: false,
					error: "審計未通過，技能未安裝",
					code: "audit_blocked",
					details: {
						audit: {
							status: "blocked",
							reasons: [
								{
									rule: "M3",
									level: "blocked",
									message: "執行時 python 不受支援：僅支援 JS/TS 與純提示詞技能",
									evidence: "#!/usr/bin/env python3",
								},
							],
							detected: { runtime: "python", network: [], tools: [] },
						},
					},
				}),
				{ status: 422, headers: { "content-type": "application/json" } },
			),
		);

		const result = await api.importSkill("https://example.com/skills/legacy-report/skill.json");
		expect(result).toMatchObject({
			ok: false,
			installed: false,
			code: "audit_blocked",
			auditStatus: "blocked",
			reasons: ["執行時 python 不受支援：僅支援 JS/TS 與純提示詞技能"],
		});
	});

	it("照樣讀取成功響應；非 422 失敗仍拋 ApiError", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: true, installed: true, changed: false, name: "pure-js" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await expect(api.importSkill("https://example.com/skill.json")).resolves.toMatchObject({
			ok: true,
			installed: true,
			name: "pure-js",
		});

		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "服務暫不可用" }), {
				status: 503,
				headers: { "content-type": "application/json" },
			}),
		);
		await expect(api.importSkill("https://example.com/skill.json")).rejects.toMatchObject({ status: 503 });
	});
});

describe("SkillHubRow · blocked 詳情（驗收 2）", () => {
	it("安裝按鈕停用、原因可見、點按不發請求", () => {
		const entry = byName("legacy-report");
		const onClick = vi.fn();
		const html = renderToStaticMarkup(
			<SkillHubRow
				entry={entry}
				expanded
				installed={false}
				installedNow={false}
				installing={false}
				installError={null}
				onToggle={() => {}}
				onInstall={onClick}
				onTry={() => {}}
			/>,
		);
		expect(html).toContain(BLOCKED_HINT);
		expect(html).toContain("執行時 python 不受支援");
		expect(html).toContain("python3");
		expect(html).toContain("[M3]");
		expect(html).toContain("Python");
		expect(html).toContain("disabled");
		expect(html).toContain('aria-label="不可安裝技能 legacy-report"');
		expect(html).toContain("不可安裝");
		// 元件只在 installable 時才回調：blocked 的按鈕停用且 onClick 內有 guard。
		expect(canInstallHubEntry(entry)).toBe(false);
		expect(onClick).not.toHaveBeenCalled();
	});

	it("pass 條目展開審計報告：hash、出站域名、工具、來源、許可證", () => {
		const html = renderToStaticMarkup(
			<SkillHubRow
				entry={byName("web-snapshot")}
				expanded
				installed={false}
				installedNow={false}
				installing={false}
				installError={null}
				onToggle={() => {}}
				onInstall={() => {}}
				onTry={() => {}}
			/>,
		);
		expect(html).toContain("審計通過");
		expect(html).toContain("api.github.com");
		expect(html).toContain("fetch、write_file");
		expect(html).toContain("2c26b46b68ffc68f");
		expect(html).toContain("MIT");
		expect(html).toContain('aria-label="安裝技能 web-snapshot"');
		expect(html).not.toContain(BLOCKED_HINT);
	});

	it("已安裝條目顯示「已安裝 / 重新安裝」", () => {
		const html = renderToStaticMarkup(
			<SkillHubRow
				entry={byName("meeting-notes")}
				expanded
				installed
				installedNow={false}
				installing={false}
				installError={null}
				onToggle={() => {}}
				onInstall={() => {}}
				onTry={() => {}}
			/>,
		);
		expect(html).toContain("已安裝");
		expect(html).toContain("重新安裝");
	});

	it("installedHash 與 contentHash 不同 → 可更新", () => {
		const html = renderToStaticMarkup(
			<SkillHubRow
				entry={byName("crm-sync")}
				expanded
				installed={false}
				installedNow={false}
				installing={false}
				installError={null}
				onToggle={() => {}}
				onInstall={() => {}}
				onTry={() => {}}
			/>,
		);
		expect(html).toContain("可更新");
		expect(html).toContain('aria-label="更新技能 crm-sync"');
	});
});

describe("安裝後行內反饋（NERE-69）", () => {
	it("失敗文案優先取 reasons[0]，其次 error，最後兜底", () => {
		expect(installFailureMessage({ reasons: [" 首條原因 ", "第二條"], error: "介面錯誤" })).toBe("首條原因");
		expect(installFailureMessage({ reasons: [], error: "介面錯誤" })).toBe("介面錯誤");
		expect(installFailureMessage({})).toBe("安裝失敗");
	});

	it("安裝成功：行內出現「已安裝 · 試用」，點試用回撥技能名", () => {
		const onTry = vi.fn();
		const html = renderToStaticMarkup(
			<SkillHubRow
				entry={byName("meeting-notes")}
				expanded
				installed
				installedNow
				installing={false}
				installError={null}
				onToggle={() => {}}
				onInstall={() => {}}
				onTry={onTry}
			/>,
		);
		expect(html).toContain("已安裝 ·");
		expect(html).toContain('aria-label="試用技能 meeting-notes"');
		expect(html).toContain(">試用<");
	});

	it("安裝失敗：紅字取首條審計原因，按鈕恢復可點", () => {
		const html = renderToStaticMarkup(
			<SkillHubRow
				entry={byName("web-snapshot")}
				expanded
				installed={false}
				installedNow={false}
				installing={false}
				installError="執行時 python 不受支援：僅支援 JS/TS 與純提示詞技能"
				onToggle={() => {}}
				onInstall={() => {}}
				onTry={() => {}}
			/>,
		);
		expect(html).toContain('role="alert"');
		expect(html).toContain("安裝失敗：");
		expect(html).toContain("執行時 python 不受支援");
		// 失敗後不殘留「安裝中…」，按鈕仍可點。
		expect(html).not.toContain("安裝中…");
		expect(html).toContain('aria-label="安裝技能 web-snapshot"');
	});

	it("blocked 條目：按鈕停用，首條原因就地在按鈕上方展示", () => {
		const html = renderToStaticMarkup(
			<SkillHubRow
				entry={byName("legacy-report")}
				expanded
				installed={false}
				installedNow={false}
				installing={false}
				installError={null}
				onToggle={() => {}}
				onInstall={() => {}}
				onTry={() => {}}
			/>,
		);
		expect(html).toContain("原因：執行時 python 不受支援");
		expect(html).toContain("不可安裝技能 legacy-report");
	});

	it("剛剛裝成功：目錄快照的「可更新」讓位給「已安裝 · 試用」", () => {
		const html = renderToStaticMarkup(
			<SkillHubRow
				entry={byName("crm-sync")}
				expanded
				installed
				installedNow
				installing={false}
				installError={null}
				onToggle={() => {}}
				onInstall={() => {}}
				onTry={() => {}}
			/>,
		);
		expect(html).not.toContain("可更新");
		expect(html).toContain('aria-label="重新安裝技能 crm-sync"');
		expect(html).toContain("已安裝 ·");
	});
});

describe("SkillHubPanel · 首屏狀態", () => {
	it("首次渲染是 loading 骨架，篩選控制元件齊全", () => {
		const html = renderToStaticMarkup(<SkillHubPanel installed={[]} onInstall={async () => ({ ok: true })} onTry={() => {}} />);
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("搜尋技能名稱、描述或標籤");
		expect(html).toContain('aria-label="按執行時篩選"');
		expect(html).toContain('aria-label="按審計狀態篩選"');
		expect(html).toContain('aria-label="按標籤篩選"');
		expect(html).toContain('aria-label="按來源篩選"');
		expect((html.match(/animate-pulse/g) ?? []).length).toBe(3);
		expect(html).toContain("正在載入技能列表");
	});
});
