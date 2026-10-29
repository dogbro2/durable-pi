import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { SqlHandle } from "../db/migrations";
import { AppError, defaultErrorCode } from "../http/errors";
import * as customToolsRepo from "../repo/custom-tools-repo";
import * as settingsRepo from "../repo/settings-repo";
import { withApproval } from "./approval-service";

/**
 * 自定義工具用例（v0.36.0，ADR-0001 §2）：`custom_tools` 的寫入、沙箱執行與擴充套件構建。
 *
 * R5：已載入工具名集合由呼叫方顯式傳入（DO 例項欄位），不再有模組級 `customToolNames`；
 * `buildExtension` 會先清空再寫入該集合，保證同一 DO 的審批分級只看到自己的工具。
 */
export type CustomToolView = customToolsRepo.CustomToolView;
export type CustomToolExtension = { name: string; tools?: unknown[] };

/** 合法工具名：字母開頭，字母數字下劃線。 */
export const CUSTOM_TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_]{1,40}$/;
/** 保留名：不能覆蓋內建工具。 */
export const RESERVED_TOOL_NAMES: Record<string, true> = {
	now: true, remember: true, recall: true, list_skills: true, load_skill: true, install_skill: true, read_file: true,
	list_files: true, write_file: true, share_file: true, share_conversation: true,
	kb_search: true, kb_add: true, kb_list: true, kb_delete: true,
	update_plan: true, dispatch_tasks: true, web_search: true, web_fetch_page: true, http_fetch: true, tool_search: true,
	codemode: true, set_goal: true, complete_goal: true, report_goal: true, ask_user: true,
};
export const CUSTOM_TOOL_CODE_MAX = 8000;

/** 沙箱的最小形狀（型別放在本地，避免靜態 import 把 cloudflare 執行時拖進單測）。 */
type CustomSandbox = {
	execute(
		source: string,
		options: { store: Record<string, unknown>; timeoutMs: number },
	): Promise<{ ok: boolean; error?: unknown; value?: unknown }>;
};

/** 共享的 QuickJS 沙箱：每次 execute 起獨立 VM，自定義工具之間互不影響。
 * 按需動態載入：路由表可在 node 單測裡 import，不必拉起 workerd。 */
let customSandbox: Promise<CustomSandbox> | null = null;
function sandbox(): Promise<CustomSandbox> {
	customSandbox ??= import("@earendil-works/pi-codemode/cloudflare").then(
		({ createInlineCodemodeSandbox }) =>
			createInlineCodemodeSandbox({ memoryLimitBytes: 32 * 1024 * 1024, timeoutMs: 15_000 }) as CustomSandbox,
	);
	return customSandbox;
}

/** 把使用者程式碼包成函式體執行：`args` 是入參，返回值即工具結果。 */
async function runCustomTool(code: string, args: unknown): Promise<{ ok: boolean; text: string }> {
	const source = `async function __custom_tool(args) {\n${code}\n}\nreturn await __custom_tool(load("args"));`;
	try {
		const result = await (await sandbox()).execute(source, { store: { args: args ?? {} }, timeoutMs: 15_000 });
		if (!result.ok) {
			const detail = (result.error as { message?: unknown } | undefined)?.message;
			return { ok: false, text: `執行失敗：${String(detail ?? JSON.stringify(result.error)).slice(0, 400)}` };
		}
		const value = result.value;
		const text =
			value === undefined || value === null
				? "(無返回值)"
				: typeof value === "string"
					? value
					: JSON.stringify(value);
		return { ok: true, text: text.slice(0, 8000) };
	} catch (err) {
		return { ok: false, text: `執行異常：${String(err).slice(0, 300)}` };
	}
}

/** 從 `custom_tools` 構建擴充套件；沒有啟用的工具時仍是空擴充套件（與舊行為一致）。 */
export function buildExtension(sql: SqlHandle, customToolNames: Set<string>): CustomToolExtension {
	const rows = customToolsRepo.listEnabled(sql);
	customToolNames.clear();
	const gate = {
		sql: () => sql,
		get: (key: string, fallback: string) => settingsRepo.get(sql, key, fallback),
	};
	const tools = rows.map((row) => {
		customToolNames.add(row.name);
		let parameters: object = { type: "object", properties: {} };
		try {
			const parsed = JSON.parse(row.parameters) as { type?: unknown };
			if (parsed && typeof parsed === "object" && parsed.type === "object") parameters = parsed;
		} catch {
			// 保持預設空 schema
		}
		return withApproval(
			defineTool({
				name: row.name,
				description: `${row.description || row.name}\n（自定義工具：在 QuickJS 沙箱裡執行使用者提供的 JavaScript，入參是 args 物件，返回值即結果）`.slice(0, 400),
				parameters: Type.Unsafe(parameters as never),
				execute: async (args: unknown) => {
					const r = await runCustomTool(row.code, args);
					return { output: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) };
				},
			}) as never,
			gate,
			customToolNames,
		);
	});
	return defineExtension({ name: "custom-tools", tools: tools as never }) as CustomToolExtension;
}

export function listTools(sql: SqlHandle): CustomToolView[] {
	return customToolsRepo.listAll(sql);
}

export class CustomToolApiError extends AppError {
	constructor(status: number, message: string, code = defaultErrorCode(status)) {
		super(code, status, message);
		this.name = "CustomToolApiError";
	}
}

export type CustomToolInput = { name?: string; description?: string; parameters?: string; code?: string };

/** POST /custom-tools：校驗後 upsert，返回重建後的擴充套件與工具數。 */
export function saveTool(
	sql: SqlHandle,
	body: CustomToolInput,
	customToolNames: Set<string>,
): { name: string; extension: CustomToolExtension } {
	const name = String(body.name ?? "").trim();
	const code = String(body.code ?? "").trim();
	if (!CUSTOM_TOOL_NAME.test(name)) {
		throw new CustomToolApiError(400, "工具名只能字母開頭，含字母數字下劃線，2–41 字元");
	}
	if (name in RESERVED_TOOL_NAMES) throw new CustomToolApiError(400, `「${name}」是內建工具名，換一個`);
	if (!code) throw new CustomToolApiError(400, "程式碼不能為空");
	if (code.length > CUSTOM_TOOL_CODE_MAX) throw new CustomToolApiError(400, `程式碼最長 ${CUSTOM_TOOL_CODE_MAX} 字元`);
	let parameters = "{\"type\":\"object\",\"properties\":{}}";
	if (body.parameters && String(body.parameters).trim()) {
		try {
			const parsed = JSON.parse(String(body.parameters)) as { type?: unknown };
			if (!parsed || typeof parsed !== "object" || parsed.type !== "object") {
				throw new CustomToolApiError(400, "引數 schema 必須是 {\"type\":\"object\", ...} 的 JSON");
			}
			parameters = JSON.stringify(parsed);
		} catch (err) {
			if (err instanceof CustomToolApiError) throw err;
			throw new CustomToolApiError(400, "引數 schema 不是合法 JSON");
		}
	}
	customToolsRepo.upsert(sql, {
		name,
		description: String(body.description ?? "").trim().slice(0, 200),
		parameters,
		code,
		now: new Date().toISOString(),
	});
	return { name, extension: buildExtension(sql, customToolNames) };
}

/** DELETE /custom-tools?name=：刪行後重建擴充套件。 */
export function removeTool(
	sql: SqlHandle,
	name: string,
	customToolNames: Set<string>,
): { ok: true; extension: CustomToolExtension } {
	if (!name) throw new CustomToolApiError(400, "缺少 name");
	customToolsRepo.remove(sql, name);
	return { ok: true, extension: buildExtension(sql, customToolNames) };
}
