/**
 * 內建技能目錄（NERE-55，契約 §6）：構建期快照作為 JSON 模組打入 Worker，列表請求零 subrequest。
 *
 * catalog 只含後設資料 + 內容地址 + sha256 + 審計快照，不內聯內容。
 * 校驗（無 blocked、hash 一致）由 `tests/unit/skill-catalog.test.ts` 與 CI 門禁執行。
 */

import bundled from "../../../skills/catalog.json";
import type { AuditReport, SkillManifest, SkillRuntime } from "./skill-audit";

export type CatalogAudit = AuditReport;
export type CatalogEntry = SkillManifest & {
	contentUrl: string;
	contentHash: string;
	audit: CatalogAudit;
	origin?: "bundled" | "remote";
};

export type SkillCatalog = {
	schemaVersion: 1;
	generatedAt: string;
	entries: CatalogEntry[];
};

/** 內建目錄（`skills/catalog.json`）。JSON 模組由 wrangler/esbuild/vitest 直接解析。 */
export const BUNDLED_CATALOG = bundled as unknown as SkillCatalog;
export const BUNDLED_CATALOG_GENERATED_AT = BUNDLED_CATALOG.generatedAt;

/** 目錄條目的執行時取值；未知值按 other（fail closed）。 */
export function catalogRuntime(entry: { runtime?: unknown }): SkillRuntime {
	const value = String(entry.runtime ?? "");
	return (["prompt", "javascript", "typescript", "python", "shell", "binary", "other"] as const).includes(
		value as SkillRuntime,
	)
		? (value as SkillRuntime)
		: "other";
}
