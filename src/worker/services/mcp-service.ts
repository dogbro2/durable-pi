import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { McpClient, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import type { SqlHandle } from "../db/migrations";
import * as mcpRepo from "../repo/mcp-repo";
import * as settingsRepo from "../repo/settings-repo";
import { withApproval } from "./approval-service";

/**
 * MCP 域用例（ADR-0001 §2）：`/mcp` 的配置 CRUD + 工具擴充套件構建。
 *
 * R5：連線快取由呼叫方顯式傳入（DO 例項欄位），同 isolate 的多使用者不共享；
 * 配置變更後由 DO 清空自己的快取再重建（`McpRuntime.rebuild`），Service 不認識 DO。
 */
export type McpTool = { name: string; description?: string; inputSchema?: unknown };
export type McpCacheEntry = { client: McpClient; tools: McpTool[] };
export type McpCache = Map<string, McpCacheEntry>;

/** MCP 工具總數達到該閾值時改為延遲披露，避免工具列表撐爆上下文。 */
export const DEFER_MCP_THRESHOLD = 12;

export type McpInput = { name?: string; url?: string; headers?: Record<string, string> };

export type SavedMcpServer = { id: string; name: string; url: string; headers: string };

export function listServers(sql: SqlHandle): mcpRepo.McpServerSummary[] {
	return mcpRepo.list(sql);
}

/** POST /mcp：名稱 + http(s) 地址；id 由名稱推導（重複則覆蓋同名伺服器）。 */
export function saveServer(sql: SqlHandle, body: McpInput): SavedMcpServer {
	const name = (body.name ?? "").trim();
	const url = (body.url ?? "").trim();
	if (!name || !/^https?:\/\//.test(url)) throw new Error("需要名稱與 http(s) 伺服器地址");
	const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || `s${Date.now()}`;
	const headers = JSON.stringify(body.headers ?? {});
	mcpRepo.upsert(sql, { id, name, url, headers, createdAt: new Date().toISOString() });
	return { id, name, url, headers };
}

export function removeServer(sql: SqlHandle, id: string): void {
	mcpRepo.remove(sql, id);
}

/**
 * 讀取配置的 MCP 伺服器，連線並包裝成 pi-durable 工具（惰性、失敗靜默）。
 * `cache` 必須是呼叫方（DO 例項）的快取，不能放模組級。
 */
export async function buildExtension(sql: SqlHandle, cache: McpCache) {
	const servers = mcpRepo.listConfigured(sql);
	if (!servers.length) return null;

	// 第一遍：連線所有伺服器並拿到工具清單（已快取的直接複用）。
	const connected: { server: { id: string; name: string }; entry: McpCacheEntry }[] = [];
	for (const server of servers) {
		try {
			let entry = cache.get(server.id);
			if (!entry) {
				const client = new McpClient({ name: "durable-pi", version: "1.2.0" });
				const headers = JSON.parse(server.headers || "{}") as Record<string, string>;
				await client.connect(new StreamableHttpTransport({ url: server.url, headers }));
				const listed = await client.listTools();
				entry = { client, tools: listed as McpTool[] };
				cache.set(server.id, entry);
			}
			connected.push({ server, entry });
		} catch (err) {
			console.warn(`MCP server ${server.name} unavailable`, String(err));
		}
	}
	const total = connected.reduce((n, item) => n + item.entry.tools.length, 0);
	// 工具多時改為延遲披露：模型先用 tool_search 搜尋，再按需載入。
	const defer = total > DEFER_MCP_THRESHOLD;

	const tools = [];
	for (const { server, entry } of connected) {
		for (const tool of entry.tools) {
			const jsName = `mcp__${server.id}__${tool.name}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60);
			tools.push(
				defineTool({
					name: jsName,
					...(defer ? { deferred: true as const } : {}),
					description: `[${server.name}] ${tool.description ?? tool.name}`.slice(0, 400),
					parameters: Type.Unsafe((tool.inputSchema as object) ?? { type: "object", properties: {} }),
					execute: async (args: unknown) => {
						const res = await entry.client.callTool(tool.name, (args ?? {}) as Record<string, unknown>);
						const content = toLlmContent(res as never) as { type: string; text?: string }[];
						const text = content.map((c) => c.text ?? "").join("\n").slice(0, 8000);
						return { output: [{ type: "text", text: text || "(空結果)" }] };
					},
				}),
			);
		}
	}
	// MCP 工具預設按寫入處理（外部服務可能有副作用），統一套審批閘門（v0.33.0）
	const gate = {
		sql: () => sql,
		get: (key: string, fallback: string) => settingsRepo.get(sql, key, fallback),
	};
	return defineExtension({ name: "mcp", tools: tools.map((tool) => withApproval(tool as never, gate)) });
}
