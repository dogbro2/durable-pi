import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillCard } from "../../src/web/components/SkillCard";
import { parseSkills } from "../../src/web/lib/collections";
import {
	NEVER_TRIED_DAYS,
	lastUsedLabel,
	shouldSuggestRemoval,
	skillRuntimeLabel,
} from "../../src/web/lib/skill-usage";
import type { SkillInfo } from "../../src/web/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-22T12:00:00Z");

/** 服務端 GET /skills 的一條：欄位只增不改（NERE-55 listCompat）。 */
const ROW = {
	name: "weekly-report",
	description: "把一週的流水整理成周報",
	content: "# 週報\n\n按專案分組。",
	created_at: "2026-10-20T09:00:00Z",
	runtime: "prompt",
	auditStatus: "pass",
	lastInvokedAt: null,
};

function card(skill: SkillInfo, now = NOW) {
	return renderToStaticMarkup(
		<SkillCard
			skill={skill}
			expanded={false}
			onToggle={() => {}}
			onDelete={() => {}}
			onTry={() => {}}
			now={now}
		/>,
	);
}

describe("lastUsedLabel · 上次使用口徑（NERE-59）", () => {
	it("欄位缺失 → null：沒有埋點資料，整行不渲染（不顯示 0 / 不顯示「從未」）", () => {
		expect(lastUsedLabel(undefined, NOW)).toBeNull();
	});

	it("null → 從未使用", () => {
		expect(lastUsedLabel(null, NOW)).toBe("從未");
	});

	it("相對時間：剛剛 / 分鐘 / 小時 / 天", () => {
		expect(lastUsedLabel(NOW - 30_000, NOW)).toBe("剛剛");
		expect(lastUsedLabel(NOW - 5 * MINUTE, NOW)).toBe("5 分鐘前");
		expect(lastUsedLabel(NOW - 3 * HOUR, NOW)).toBe("3 小時前");
		expect(lastUsedLabel(NOW - 3 * DAY, NOW)).toBe("3 天前");
	});

	it("髒資料（NaN / 負數極端）不拋錯：NaN 不渲染", () => {
		expect(lastUsedLabel(Number.NaN, NOW)).toBeNull();
		// 服務端時鐘略快於瀏覽器時按「剛剛」處理，不出現「-1 天前」
		expect(lastUsedLabel(NOW + DAY, NOW)).toBe("剛剛");
	});
});

describe("shouldSuggestRemoval · 裝了 7 天還沒用過", () => {
	const based: Pick<SkillInfo, "lastInvokedAt" | "createdAt"> = {
		lastInvokedAt: null,
		createdAt: new Date(NOW - (NEVER_TRIED_DAYS + 1) * DAY).toISOString(),
	};

	it("從未使用且滿 7 天 → 提示刪掉", () => {
		expect(shouldSuggestRemoval(based, NOW)).toBe(true);
	});

	it("剛好 7 天前安裝 → 提示；6 天前 → 不提示", () => {
		expect(shouldSuggestRemoval({ ...based, createdAt: new Date(NOW - NEVER_TRIED_DAYS * DAY).toISOString() }, NOW)).toBe(true);
		expect(shouldSuggestRemoval({ ...based, createdAt: new Date(NOW - 6 * DAY).toISOString() }, NOW)).toBe(false);
	});

	it("用過（哪怕是 null 之外的 0）或沒有安裝時間 → 不提示", () => {
		expect(shouldSuggestRemoval({ ...based, lastInvokedAt: NOW - HOUR }, NOW)).toBe(false);
		expect(shouldSuggestRemoval({ ...based, createdAt: undefined }, NOW)).toBe(false);
	});
});

describe("skillRuntimeLabel · 執行時徽標", () => {
	it("只顯示 issue 要求的三類短標籤", () => {
		expect(skillRuntimeLabel("prompt")).toBe("提示詞");
		expect(skillRuntimeLabel("javascript")).toBe("JS");
		expect(skillRuntimeLabel("typescript")).toBe("TS");
		expect(skillRuntimeLabel(undefined)).toBeNull();
		expect(skillRuntimeLabel("")).toBeNull();
	});
});

describe("parseSkills · 寬容解析（NERE-59）", () => {
	it("空陣列 / 缺欄位 → 不崩、空態", () => {
		expect(parseSkills({ skills: [] })).toEqual([]);
		expect(parseSkills(undefined)).toEqual([]);
		expect(parseSkills({ skills: "nope" })).toEqual([]);
	});

	it("帶上 runtime / auditStatus / createdAt / lastInvokedAt", () => {
		const [skill] = parseSkills({ skills: [ROW] });
		expect(skill).toMatchObject({
			name: "weekly-report",
			runtime: "prompt",
			auditStatus: "pass",
			createdAt: "2026-10-20T09:00:00Z",
			lastInvokedAt: null,
		});
	});

	it("老服務端沒有 lastInvokedAt → undefined（無埋點資料）", () => {
		const { lastInvokedAt: _drop, ...legacy } = ROW;
		const [skill] = parseSkills({ skills: [legacy] });
		expect(skill!.lastInvokedAt).toBeUndefined();
	});

	it("無法識別的 auditStatus 不猜成 pass", () => {
		const [skill] = parseSkills({ skills: [{ ...ROW, auditStatus: "bogus" }] });
		expect(skill!.auditStatus).toBeUndefined();
	});

	it("lastInvokedAt 是數字字串時轉成數字（寬容讀取）", () => {
		const [skill] = parseSkills({ skills: [{ ...ROW, lastInvokedAt: String(NOW) }] });
		expect(skill!.lastInvokedAt).toBe(NOW);
	});
});

describe("SkillCard · 已安裝卡片（驗收 1 / 3 / 4）", () => {
	const parsed = (overrides: Record<string, unknown> = {}) =>
		parseSkills({ skills: [{ ...ROW, ...overrides }] })[0]!;

	it("有埋點欄位、從未呼叫 → 執行時 + 審計 + 「上次使用：從未」+ 試用按鈕", () => {
		const html = card(parsed());
		expect(html).toContain("上次使用：從未");
		expect(html).toContain("提示詞");
		expect(html).toContain("審計通過");
		expect(html).toContain("試用");
		expect(html).toContain(`aria-label="試用 weekly-report"`);
	});

	it("剛被呼叫過一次 → 「剛剛」", () => {
		const html = card(parsed({ lastInvokedAt: NOW - 1_000 }));
		expect(html).toContain("上次使用：剛剛");
		expect(html).not.toContain("上次使用：從未");
	});

	it("skill_events 為空（全部 lastInvokedAt=null）→ 正常渲染，無佔位錯誤", () => {
		const list = parseSkills({ skills: [ROW, { ...ROW, name: "meeting-notes" }] });
		for (const skill of list) {
			const html = card(skill);
			expect(html).toContain("上次使用：從未");
			expect(html).not.toContain("NaN");
			expect(html).not.toContain("undefined");
		}
	});

	it("沒有埋點欄位（老服務端）→ 整行不渲染，不顯示 0 / 從未", () => {
		const { lastInvokedAt: _drop, ...legacy } = ROW;
		const html = card(parseSkills({ skills: [legacy] })[0]!);
		expect(html).not.toContain("上次使用");
		expect(html).not.toContain("從未");
		// 卡片主體仍然可用
		expect(html).toContain("weekly-report");
		expect(html).toContain("試用");
	});

	it("從未使用且裝了 8 天 → 底部灰字提示；剛裝的不提示", () => {
		const old = card(parsed({ created_at: new Date(NOW - 8 * DAY).toISOString() }));
		expect(old).toContain("還沒用過。試試「試用」，或刪掉它保持面板清爽。");

		const fresh = card(parsed({ created_at: new Date(NOW - DAY).toISOString() }));
		expect(fresh).not.toContain("還沒用過。試試");
	});
});
