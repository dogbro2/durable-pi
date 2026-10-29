import type { SqlHandle } from "../db/migrations";
import * as mcpRepo from "../repo/mcp-repo";
import * as panelsRepo from "../repo/panels-repo";
import * as providersRepo from "../repo/providers-repo";
import * as skillsRepo from "../repo/skills-repo";
import type { SettingsView } from "./settings-service";

/**
 * 能力登錄檔用例（ADR-0001 §2）：`GET /capabilities` 把三類來源彙總成一張表。
 * 只讀：設定檢視由 Route 從 settings-service 傳入，計數全部走倉儲。
 */
export type CapabilityItem = {
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	count?: number;
	detail?: string;
};

export type CapabilityGroup = { key: string; label: string; items: CapabilityItem[] };

export type CapabilityDeps = { sql: SqlHandle; settings: SettingsView };

export function capabilities({ sql, settings }: CapabilityDeps): { groups: CapabilityGroup[] } {
	const approvalOn =
		settings.approval.read !== "allow" || settings.approval.write !== "allow" || settings.approval.exec !== "allow";
	const builtin: CapabilityItem[] = [
		{ id: "codemode", name: "Code Mode", description: "QuickJS 沙箱裡寫 JS 調工具", enabled: true },
		{ id: "tool_search", name: "工具搜尋", description: "工具多時按需檢索載入", enabled: true },
		{
			id: "compaction",
			name: "上下文壓縮",
			description: "接近上下文上限時自動摘要舊內容",
			enabled: settings.compaction.enabled,
			detail: `保留 ${settings.compaction.keepRecentTokens} tokens / 預留 ${settings.compaction.reserveTokens}`,
		},
		{ id: "plan", name: "計劃清單", description: "update_plan 維護分步計劃", enabled: true },
		{ id: "share", name: "分享連結", description: "share_file / share_conversation 生成只讀連結", enabled: true },
		{ id: "subagents", name: "子代理", description: "dispatch_tasks 並行分派子任務", enabled: true },
		{ id: "goal", name: "目標模式", description: "目標 + token 預算 + 自動續轉 + 完成校驗", enabled: true },
		{
			id: "approval",
			name: "工具審批",
			description: "read/write/exec 三檔 + 逐工具覆蓋",
			enabled: approvalOn,
			detail: `讀 ${settings.approval.read} / 寫 ${settings.approval.write} / 執行 ${settings.approval.exec}`,
		},
		{ id: "web_search", name: "聯網搜尋", description: "web_search / web_fetch_page", enabled: settings.webSearch },
	];
	const data: CapabilityItem[] = [
		{
			id: "skills",
			name: "技能",
			description: "SKILL.md 說明書，按需 load_skill",
			enabled: true,
			count: skillsRepo.countVisibleSkills(sql),
		},
		{ id: "prompts", name: "提示模板", description: "輸入 / 展開的常用指令", enabled: true, count: panelsRepo.countPrompts(sql) },
		{
			id: "rules",
			name: "規則檔案",
			description: "每輪注入的專案約定",
			enabled: true,
			count: panelsRepo.countEnabledRules(sql),
		},
	];
	const protocol: CapabilityItem[] = [
		{
			id: "mcp",
			name: "MCP 伺服器",
			description: "Streamable HTTP 工具接入",
			enabled: true,
			count: mcpRepo.count(sql),
		},
		{
			id: "providers",
			name: "模型供應商",
			description: "OpenAI 相容端點",
			enabled: true,
			count: providersRepo.list(sql).length,
		},
	];
	return {
		groups: [
			{ key: "builtin", label: "內建能力", items: builtin },
			{ key: "data", label: "資料能力", items: data },
			{ key: "protocol", label: "協議接入", items: protocol },
		],
	};
}
