import { describe, expect, it, vi } from "vitest";
import type { Harness } from "@earendil-works/pi-durable";
import type { SqlHandle } from "../../src/worker/db/migrations";
import { buildContext, type AppEnv, type BuildContextInput } from "../../src/worker/http/context";
import { AppError } from "../../src/worker/http/errors";
import { dispatch } from "../../src/worker/routes";
import type { Route } from "../../src/worker/http/router";
import type { SessionRuntime } from "../../src/worker/services/session-service";
import type { ShareRuntime } from "../../src/worker/http/ports";

const sql: SqlHandle = { exec: () => ({ toArray: () => [] }) };
const env = {} as AppEnv;
/** 只為型別佔位：buildContext 不觸碰 Harness 成員。 */
const harness = {} as Harness;
const sessionRuntime: SessionRuntime = {
	entries: async () => ({ conversationId: "1", items: [] }),
	createConversation: async () => "1",
	forkBefore: async () => ({ id: "2", parentId: "1", at: 1 }),
	rootId: async () => "1",
	scanConversationIds: async () => [],
	modelFor: () => "deepseek-flash",
	pauseGoal: () => {},
};
const shareRuntime: ShareRuntime = {
	conversationId: async () => "1",
	entries: async () => [],
};
const dataRuntime = {
	exportSnapshot: async () => ({ sessionId: "1", title: "會話 1", entries: [] }),
	reflect: async () => 0,
	afterRestore: async () => {},
};
const debugRuntime = { inspect: async () => ({ tools: [] }) };
const customToolsRuntime = {
	save: () => ({ name: "x", tools: 0 }),
	remove: () => ({ tools: 0 }),
};

function context(overrides: Partial<Parameters<typeof buildContext>[0]> = {}) {
	return buildContext({
		req: new Request("https://pi.example/chat?x=1"),
		env,
		scopeId: "agent-1",
		userKey: "owner",
		origin: "https://pi.example",
		sql,
		ensureMigrated: async () => {},
		open: async () => harness,
		sessionRuntime,
		shareRuntime,
		settings: { get: (_key, fallback) => fallback },
		setSetting: () => {},
		dataRuntime,
		debugRuntime,
		customToolsRuntime,
		webFetch: async () => ({ ok: false, kind: "error", message: "stub" }),
		...overrides,
	} as BuildContextInput);
}

describe("buildContext", () => {
	it("暴露請求欄位與已遷移 SQL 控制代碼", () => {
		const ctx = context();
		expect(ctx.url.pathname).toBe("/chat");
		expect(ctx.url.search).toBe("?x=1");
		expect(ctx.origin).toBe("https://pi.example");
		expect(ctx.scopeId).toBe("agent-1");
		expect(ctx.userKey).toBe("owner");
		expect(ctx.sql()).toBe(sql);
	});

	it("ready() 委託 ensureMigrated，harness() 惰性 open", async () => {
		const ensureMigrated = vi.fn(async () => {});
		const open = vi.fn(async () => harness);
		const ctx = context({ ensureMigrated, open });
		expect(open).not.toHaveBeenCalled();
		await ctx.ready();
		expect(ensureMigrated).toHaveBeenCalledTimes(1);
		await ctx.harness();
		expect(open).toHaveBeenCalledTimes(1);
	});
});

describe("請求級設定快取（NERE-82 P2-2）", () => {
	it("首次讀取用 snapshot 一次拉全表，後續 key 不再查庫", () => {
		const calls = { snapshot: 0, get: 0 };
		const store: Record<string, string> = { web_search: "0", kb_prefetch: "1", display_name: "pi" };
		const ctx = context({
			settings: {
				get: (key, fallback) => {
					calls.get += 1;
					return store[key] ?? fallback;
				},
				snapshot: () => {
					calls.snapshot += 1;
					return { ...store };
				},
			},
		});

		expect(ctx.settings.get("web_search", "1")).toBe("0");
		expect(ctx.settings.get("kb_prefetch", "1")).toBe("1");
		expect(ctx.settings.get("display_name", "")).toBe("pi");
		expect(ctx.settings.get("missing", "fallback")).toBe("fallback");
		expect(calls).toEqual({ snapshot: 1, get: 0 });
	});

	it("同一請求 setSetting 後讀到新值", () => {
		const store: Record<string, string> = { kernel_version: "v1" };
		const ctx = context({
			settings: { get: (key, fallback) => store[key] ?? fallback, snapshot: () => ({ ...store }) },
			setSetting: (key, value) => {
				store[key] = value;
			},
		});

		expect(ctx.settings.get("kernel_version", "")).toBe("v1");
		ctx.setSetting("kernel_version", "v2");
		expect(ctx.settings.get("kernel_version", "")).toBe("v2");
	});

	it("沒有 snapshot 的埠仍按 key 快取，不回退到每次查庫", () => {
		const get = vi.fn((_key: string, fallback: string) => fallback);
		const ctx = context({ settings: { get } });
		ctx.settings.get("a", "1");
		ctx.settings.get("a", "1");
		expect(get).toHaveBeenCalledTimes(1);
	});
});

describe("dispatch", () => {
	const route = (overrides: Partial<Route> = {}): Route => ({
		method: "GET",
		path: "/chat",
		needsHarness: true,
		handle: async () => new Response("routed", { status: 200 }),
		...overrides,
	});

	it("未命中直接 404（階段 6：沒有 legacy 兜底，且不觸發遷移/ Harness）", async () => {
		const ensureMigrated = vi.fn(async () => {});
		const open = vi.fn(async () => harness);
		const ctx = context({ ensureMigrated, open });
		const res = await dispatch(ctx, []);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "not found", code: "not_found" });
		expect(ensureMigrated).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
	});

	it("命中後按 ready → harness → handle 順序執行", async () => {
		const calls: string[] = [];
		const ctx = context({
			ensureMigrated: async () => {
				calls.push("ready");
			},
			open: async () => {
				calls.push("harness");
				return harness;
			},
		});
		const res = await dispatch(ctx, [
			route({
				handle: async () => {
					calls.push("handle");
					return new Response("routed");
				},
			}),
		]);
		expect(await res.text()).toBe("routed");
		expect(calls).toEqual(["ready", "harness", "handle"]);
	});

	it("needsHarness=false 不 open", async () => {
		const open = vi.fn(async () => harness);
		const ctx = context({ open });
		await dispatch(ctx, [route({ needsHarness: false })]);
		expect(open).not.toHaveBeenCalled();
	});

	it("真實路由表裡 GET /s/<token> 不 open Harness（階段 3）", async () => {
		const open = vi.fn(async () => harness);
		const ctx = context({ req: new Request("https://pi.example/s/doesnotexist"), open });
		const res = await dispatch(ctx);
		expect(res.status).toBe(404);
		expect(open).not.toHaveBeenCalled();
	});

	it("AppError 走對映，未知異常保持 500 截斷", async () => {
		const bad = await dispatch(context(), [
			route({
				handle: async () => {
					throw new AppError("bad_request", 400, "引數錯誤");
				},
			}),
		]);
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: "引數錯誤", code: "bad_request" });

		const unknown = await dispatch(context(), [
			route({
				handle: async () => {
					throw new Error("boom");
				},
			}),
		]);
		expect(unknown.status).toBe(500);
		expect(await unknown.json()).toEqual({ error: "boom", code: "internal_error" });
	});
});
