import { describe, expect, it } from "vitest";
import type { RequestContext } from "../../src/worker/http/context";
import { matchRoute, type Route } from "../../src/worker/http/router";

const handle = async () => new Response(null, { status: 204 });
const route = (method: Route["method"], path: string): Route => ({ method, path, needsHarness: true, handle });

describe("matchRoute", () => {
	it("精確匹配 method + path", () => {
		const sessions = route("GET", "/sessions");
		expect(matchRoute([sessions], "GET", "/sessions")).toBe(sessions);
	});

	it("method 不同不命中", () => {
		expect(matchRoute([route("GET", "/sessions")], "POST", "/sessions")).toBeNull();
	});

	it("非 /s/ 路徑不做字首匹配", () => {
		expect(matchRoute([route("GET", "/sessions")], "GET", "/sessions/1")).toBeNull();
	});

	it("/s/ 字首命中任意分享子路徑", () => {
		const share = route("GET", "/s/");
		expect(matchRoute([share], "GET", "/s/abc123")).toBe(share);
		expect(matchRoute([share], "GET", "/s/abc123/report.md")).toBe(share);
		expect(matchRoute([route("GET", "/s")], "GET", "/s/abc123")).not.toBeNull();
	});

	it("/shares 不落進 /s/ 字首", () => {
		expect(matchRoute([route("GET", "/s/")], "GET", "/shares")).toBeNull();
	});

	it("/shares/ 字首命中撤銷路徑，/shares/all 走精確路由", () => {
		const revoke = route("DELETE", "/shares/");
		const all = route("GET", "/shares/all");
		expect(matchRoute([revoke], "DELETE", "/shares/abc123")).toBe(revoke);
		expect(matchRoute([all], "GET", "/shares/all")).toBe(all);
		expect(matchRoute([revoke], "GET", "/shares/abc123")).toBeNull();
	});

	it("返回第一個命中的路由", () => {
		const first = route("GET", "/s/");
		const second = route("GET", "/s/");
		expect(matchRoute([first, second], "GET", "/s/token")).toBe(first);
	});
});
