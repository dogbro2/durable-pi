import { describe, expect, it, vi } from "vitest";
import type { SqlHandle } from "../../src/worker/db/migrations";
import { buildExtension as buildCustomTools, saveTool, CustomToolApiError } from "../../src/worker/services/custom-tool-service";
import { buildExtension as buildMcp, type McpCache } from "../../src/worker/services/mcp-service";

// 自定義工具服務會在模組載入時引用 workerd 專屬的 QuickJS 沙箱，node 單測裡替換掉。
vi.mock("@earendil-works/pi-codemode/cloudflare", () => ({
	createInlineCodemodeSandbox: () => ({ execute: async () => ({ ok: false }) }),
}));

/** 極簡 SQL 替身：倉儲只用到 `exec(...).toArray()`。 */
function fakeSql(handler: (query: string) => unknown[]): SqlHandle {
	return {
		exec(query: string) {
			return { toArray: () => handler(query) };
		},
	} as unknown as SqlHandle;
}

const toolRow = (name: string) => ({ name, description: "", parameters: "{}", code: "return 1" });

describe("R5：自定義工具名集合按例項隔離", () => {
	it("兩次構建不會互相覆蓋對方的集合", () => {
		const owner = new Set<string>();
		const user = new Set<string>();
		buildCustomTools(fakeSql(() => [toolRow("owner_tool")]), owner);
		buildCustomTools(fakeSql(() => [toolRow("user_tool")]), user);

		expect([...owner]).toEqual(["owner_tool"]);
		expect([...user]).toEqual(["user_tool"]);
	});

	it("重建時清空舊名（刪掉工具後不再參與分級）", () => {
		const names = new Set<string>();
		const sql = fakeSql(() => [toolRow("old_tool")]);
		buildCustomTools(sql, names);
		buildCustomTools(fakeSql(() => []), names);
		expect([...names]).toEqual([]);
	});
});

describe("R5：MCP 快取由呼叫方顯式傳入", () => {
	const server = { id: "s1", name: "Server", url: "https://mcp.example.com", headers: "{}" };
	const mcpSql = fakeSql((query) => (query.includes("FROM mcp_servers") ? [server] : []));

	it("命中傳入的快取，不建立新連線", async () => {
		const cache: McpCache = new Map([
			["s1", { client: {} as never, tools: [{ name: "ping" }, { name: "pong" }] }],
		]);
		const ext = await buildMcp(mcpSql, cache);
		expect(ext?.tools?.length).toBe(2);
	});

	it("兩個快取各自持有不同的連線結果", async () => {
		const owner: McpCache = new Map([["s1", { client: {} as never, tools: [{ name: "owner_tool" }] }]]);
		const user: McpCache = new Map([["s1", { client: {} as never, tools: [{ name: "user_tool" }, { name: "user_tool_2" }] }]]);
		expect((await buildMcp(mcpSql, owner))?.tools?.length).toBe(1);
		expect((await buildMcp(mcpSql, user))?.tools?.length).toBe(2);
	});
});

describe("自定義工具寫入校驗", () => {
	it("保留名與非法 code 走 400", () => {
		const names = new Set<string>();
		const sql = fakeSql(() => []);
		expect(() => saveTool(sql, { name: "read_file", code: "return 1" }, names)).toThrow(CustomToolApiError);
		expect(() => saveTool(sql, { name: "probe", code: "" }, names)).toThrow(CustomToolApiError);
	});
});
