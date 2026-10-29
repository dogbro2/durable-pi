import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_KEYS, collectBootstrap, type BootstrapLoaders } from "../../src/worker/bootstrap";
import { AppError } from "../../src/worker/http/errors";

const VALUES: Record<string, unknown> = {
	session: { ok: true, name: "durable-pi" },
	entries: [{ id: 1, kind: "pi.user" }],
	sessions: [{ id: "1", title: "預設會話" }],
	files: [{ name: "a.md", size: 3 }],
	memories: [{ id: 1, content: "記住" }],
	approvals: [{ id: 1, tool: "write_file" }],
	settings: { webSearch: true },
	plan: [{ title: "第一步", status: "pending" }],
	goal: { objective: "做完" },
	questions: [{ id: 1, questions: [] }],
	prompts: [{ name: "總結", content: "總結 $1" }],
	rules: [{ name: "r", content: "中文", enabled: true }],
	customTools: [{ name: "echo" }],
	skills: [{ name: "s" }],
	automations: [{ id: "a1" }],
	mcpServers: [{ id: "m1" }],
	models: { models: ["deepseek-flash"], default: "deepseek-flash" },
};

function loaders(overrides: Partial<Record<string, () => unknown>> = {}): BootstrapLoaders {
	const out = {} as Record<string, () => unknown>;
	for (const key of BOOTSTRAP_KEYS) out[key] = () => VALUES[key];
	return { ...out, ...overrides } as BootstrapLoaders;
}

describe("首屏聚合 collectBootstrap", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("全部面板成功時原樣返回，errors 為空", async () => {
		const payload = await collectBootstrap(loaders());
		for (const key of BOOTSTRAP_KEYS) expect(payload[key]).toEqual(VALUES[key]);
		expect(payload.errors).toEqual({});
	});

	it("單個數組面板失敗：該欄位回退空陣列，errors 只給穩定碼，不回傳異常原文", async () => {
		const payload = await collectBootstrap(
			loaders({
				files: () => {
					throw new Error("vfs_v2: no such table");
				},
			}),
		);
		expect(payload.files).toEqual([]);
		expect(payload.errors).toEqual({ files: "internal_error" });
		expect(JSON.stringify(payload)).not.toContain("vfs_v2");
		expect(payload.entries).toEqual(VALUES.entries);
		expect(payload.settings).toEqual(VALUES.settings);
	});

	it("單個物件面板失敗：該欄位回退 null，非同步拒絕同樣被隔離", async () => {
		const payload = await collectBootstrap(
			loaders({ settings: () => Promise.reject(new Error("app_settings locked")) }),
		);
		expect(payload.settings).toBeNull();
		expect(payload.errors).toEqual({ settings: "internal_error" });
		expect(payload.memories).toEqual(VALUES.memories);
	});

	it("非 Error 丟擲與非 503 AppError 都收斂為 internal_error", async () => {
		const payload = await collectBootstrap(
			loaders({
				skills: () => {
					throw "x".repeat(500);
				},
				prompts: () => {
					throw new AppError("bad_request", 400, "bad");
				},
			}),
		);
		expect(payload.skills).toEqual([]);
		expect(payload.prompts).toEqual([]);
		expect(payload.errors).toEqual({ skills: "internal_error", prompts: "internal_error" });
	});

	it("依賴不可用（Harness 會話失敗 / 503）報 unavailable，原文仍只進日誌", async () => {
		const sessionFailed = new Error("Session failed after a storage error; close and reopen it");
		sessionFailed.name = "SessionFailed";
		const payload = await collectBootstrap(
			loaders({
				entries: () => {
					throw sessionFailed;
				},
				settings: () => {
					throw new AppError("unavailable", 503, "upstream down");
				},
			}),
		);
		expect(payload.entries).toEqual([]);
		expect(payload.errors).toEqual({ entries: "unavailable", settings: "unavailable" });
		expect(JSON.stringify(payload)).not.toContain("storage error");
	});

	it("多個面板同時失敗互不影響", async () => {
		const payload = await collectBootstrap(
			loaders({
				entries: async () => {
					throw new Error("harness down");
				},
				mcpServers: async () => {
					throw new Error("mcp table missing");
				},
			}),
		);
		expect(payload.entries).toEqual([]);
		expect(payload.mcpServers).toEqual([]);
		expect(payload.errors).toEqual({ entries: "internal_error", mcpServers: "internal_error" });
		expect(payload.sessions).toEqual(VALUES.sessions);
		expect(payload.models).toEqual(VALUES.models);
	});
});
