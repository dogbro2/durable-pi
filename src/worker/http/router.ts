import type { RequestContext } from "./context";

export type Route = {
	method: "GET" | "POST" | "PATCH" | "DELETE";
	/** DO 內部短路徑，如 "/sessions"；"/s/" 作為字首匹配（階段 3 分享頁）。 */
	path: string;
	needsHarness: boolean;
	handle(ctx: RequestContext): Promise<Response>;
};

/** 以 "/" 結尾的路由是字首路由：`/s/<token>`、`/shares/<token>`；歷史 `/s` 同等對待。 */
function pathMatches(routePath: string, pathname: string): boolean {
	if (routePath === pathname) return true;
	if (routePath === "/s") return pathname.startsWith("/s/");
	if (routePath.endsWith("/") && pathname.startsWith(routePath)) return true;
	// 路徑引數（NERE-55 的 `/skills/:name/audit`）：一段對一段，引數段非空。
	if (routePath.includes("/:")) {
		const routeParts = routePath.split("/");
		const pathParts = pathname.split("/");
		if (routeParts.length !== pathParts.length) return false;
		return routeParts.every((part, i) => (part.startsWith(":") ? Boolean(pathParts[i]) : part === pathParts[i]));
	}
	return false;
}

export function matchRoute(routes: readonly Route[], method: string, pathname: string): Route | null {
	for (const route of routes) {
		if (route.method === method && pathMatches(route.path, pathname)) return route;
	}
	return null;
}
