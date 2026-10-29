import { describe, expect, it } from "vitest";
import { matchRoute } from "../../src/worker/http/router";
import { ROUTES } from "../../src/worker/routes";

/**
 * 階段 6 收口門禁：原先在 `handleLegacyFetch` 裡的 12 個路徑 / 20 個 method+path
 * 必須全部由路由表命中。清單凍結在測試裡，刪除或改名會立即失敗。
 */
const FROZEN: { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string }[] = [
	{ method: "GET", path: "/version" },
	{ method: "GET", path: "/bootstrap" },
	{ method: "GET", path: "/debug/agent" },
	{ method: "GET", path: "/kernel" },
	{ method: "GET", path: "/backup" },
	{ method: "POST", path: "/restore" },
	{ method: "GET", path: "/export" },
	{ method: "GET", path: "/memories" },
	{ method: "DELETE", path: "/memories" },
	{ method: "POST", path: "/reflect" },
	{ method: "GET", path: "/prompts" },
	{ method: "POST", path: "/prompts" },
	{ method: "DELETE", path: "/prompts" },
	{ method: "GET", path: "/rules" },
	{ method: "POST", path: "/rules" },
	{ method: "PATCH", path: "/rules" },
	{ method: "DELETE", path: "/rules" },
	{ method: "GET", path: "/custom-tools" },
	{ method: "POST", path: "/custom-tools" },
	{ method: "DELETE", path: "/custom-tools" },
];

describe("路由表覆蓋（階段 6）", () => {
	for (const entry of FROZEN) {
		it(`${entry.method} ${entry.path} 命中路由表`, () => {
			const route = matchRoute(ROUTES, entry.method, entry.path);
			expect(route, `${entry.method} ${entry.path} 未命中`).not.toBeNull();
			expect(route?.method).toBe(entry.method);
			expect(route?.path).toBe(entry.path);
		});
	}

	it("根路徑與未知路徑不命中（由 dispatch 返回 404）", () => {
		for (const path of ["/", "/does-not-exist", "/memories/1"]) {
			expect(matchRoute(ROUTES, "GET", path), path).toBeNull();
		}
	});

	it("method 不匹配不命中", () => {
		expect(matchRoute(ROUTES, "PUT" as never, "/backup")).toBeNull();
	});
});
