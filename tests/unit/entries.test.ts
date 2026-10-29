import { describe, expect, it } from "vitest";
import { parseEntries } from "../../src/web/lib/entries";

/** 構造一條 pi 條目。 */
function entry(id: number, kind: string, model: unknown) {
	return { id, kind, model };
}

describe("parseEntries · 順序", () => {
	it("後端倒序（新→舊）會被反轉成正常對話順序", () => {
		const raw = [
			entry(3, "pi.assistant", [{ content: [{ type: "text", text: "答" }] }]),
			entry(2, "pi.user", [{ role: "user", content: "問" }]),
		];
		const messages = parseEntries(raw);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(messages[0]).toMatchObject({ text: "問" });
		expect(messages[1]).toMatchObject({ text: "答" });
	});

	it("已是正序時不反轉", () => {
		const raw = [
			entry(1, "pi.user", [{ role: "user", content: "問" }]),
			entry(2, "pi.assistant", [{ content: [{ type: "text", text: "答" }] }]),
		];
		const messages = parseEntries(raw);
		expect(messages[0]).toMatchObject({ text: "問" });
	});
});

describe("parseEntries · 思考過程", () => {
	it("提取 thinking 內容塊", () => {
		const raw = [
			entry(1, "pi.assistant", [
				{ content: [{ type: "thinking", thinking: "先想一下" }, { type: "text", text: "結論" }] },
			]),
		];
		const [msg] = parseEntries(raw);
		expect(msg).toMatchObject({ role: "assistant", text: "結論", thinking: "先想一下" });
	});
});

describe("parseEntries · 工具與產出", () => {
	it("工具結果掛到緊隨其後的助手訊息上", () => {
		const raw = [
			entry(3, "pi.assistant", [{ content: [{ type: "text", text: "完成" }] }]),
			entry(2, "pi.tool-result", [{ toolName: "now", content: [{ type: "text", text: "2026-10-19" }] }]),
			entry(1, "pi.user", [{ role: "user", content: "現在幾點" }]),
		];
		const messages = parseEntries(raw);
		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant).toMatchObject({ text: "完成" });
		expect((assistant as { tools?: { name: string }[] }).tools?.[0]?.name).toBe("now");
	});

	it("dispatch_tasks 結果反解出子任務標題", () => {
		const raw = [
			entry(2, "pi.assistant", [{ content: [{ type: "text", text: "彙總完畢" }] }]),
			entry(1, "pi.tool-result", [
				{
					toolName: "dispatch_tasks",
					content: [{ type: "text", text: "已並行完成 2/2 個子任務：\n1. 查 Deno 版本 — 完成 · 2.8s\n2. 查 Bun 版本 — 完成 · 17.0s\n\n## 子任務 1：查 Deno 版本" }],
				},
			]),
		];
		const messages = parseEntries(raw);
		const assistant = messages.find((m) => m.role === "assistant") as {
			tools?: { name: string; args?: { tasks?: { title: string }[] } }[];
		};
		expect(assistant.tools?.[0]?.args?.tasks?.map((t) => t.title)).toEqual(["查 Deno 版本", "查 Bun 版本"]);
	});

	it("write_file 結果生成檔案產出", () => {
		const raw = [
			entry(2, "pi.assistant", [{ content: [{ type: "text", text: "已寫入" }] }]),
			entry(1, "pi.tool-result", [{ toolName: "write_file", content: [{ type: "text", text: "已寫入 report.md（1234 字元）。" }] }]),
		];
		const messages = parseEntries(raw);
		const assistant = messages.find((m) => m.role === "assistant") as { files?: { name: string; size?: number }[] };
		expect(assistant.files).toEqual([{ name: "report.md", size: 1234 }]);
	});
});

describe("parseEntries · 分享連結（v0.55.0）", () => {
	it("share_file 成功：檔案卡與連結卡同屬一條助手訊息", () => {
		const raw = [
			entry(4, "pi.assistant", [{ content: [{ type: "text", text: "週報和連結都在這裡。" }] }]),
			entry(3, "pi.tool-result", [
				{
					toolName: "share_file",
					content: [{ type: "text", text: "已生成分享連結：https://pi.example.com/s/abc123（有效期至 2026-10-28 10:00:00）。" }],
					details: {
						share: {
							kind: "file",
							name: "weekly.md",
							url: "https://pi.example.com/s/abc123",
							expiresAt: Date.now() + 7 * 86400_000,
							createdAt: new Date().toISOString(),
							reused: false,
						},
					},
				},
			]),
			entry(2, "pi.tool-result", [{ toolName: "write_file", content: [{ type: "text", text: "已寫入 weekly.md（2048 字元）。" }] }]),
			entry(1, "pi.user", [{ role: "user", content: "寫一份本週週報並給我分享連結" }]),
		];
		const messages = parseEntries(raw);
		const assistant = messages.find((m) => m.role === "assistant") as {
			files?: { name: string }[];
			shares?: { url: string; title: string; kind: string }[];
		};
		expect(assistant.files?.map((f) => f.name)).toEqual(["weekly.md"]);
		expect(assistant.shares?.[0]).toMatchObject({
			url: "https://pi.example.com/s/abc123",
			title: "weekly.md",
			kind: "file",
		});
	});

	it("過期的 share_file 仍解析成連結卡（card 負責顯示已過期）", () => {
		const past = Date.now() - 60_000;
		const raw = [
			entry(2, "pi.assistant", [{ content: [{ type: "text", text: "連結已過期。" }] }]),
			entry(1, "pi.tool-result", [
				{
					toolName: "share_file",
					content: [{ type: "text", text: "已生成分享連結：https://pi.example.com/s/old" }],
					details: { share: { kind: "file", name: "old.md", url: "https://pi.example.com/s/old", expiresAt: past } },
				},
			]),
		];
		const assistant = parseEntries(raw).find((m) => m.role === "assistant") as {
			shares?: { expiresAt: number }[];
		};
		expect(assistant.shares?.[0]?.expiresAt).toBe(past);
	});
});

describe("parseEntries · 上下文壓縮（v0.31.0）", () => {
	it("pi.compaction 渲染成一條系統提示", () => {
		const raw = [
			entry(1, "pi.user", [{ role: "user", content: "問" }]),
			entry(2, "pi.compaction", [{ content: "（更早的對話摘要）" }]),
			entry(3, "pi.assistant", [{ content: [{ type: "text", text: "答" }] }]),
		];
		const messages = parseEntries(raw);
		expect(messages.map((m) => m.role)).toEqual(["user", "notice", "assistant"]);
		expect(messages[1]).toMatchObject({ role: "notice" });
		expect((messages[1] as { text: string }).text).toContain("上下文已壓縮");
	});
});

describe("parseEntries · 容錯", () => {
	it("空輸入返回空陣列", () => {
		expect(parseEntries(null)).toEqual([]);
		expect(parseEntries([])).toEqual([]);
	});

	it("未知 kind 被跳過而不拋錯", () => {
		const raw = [entry(1, "pi.unknown", [{ content: "x" }]), entry(2, "pi.user", [{ role: "user", content: "問" }])];
		const messages = parseEntries(raw);
		expect(messages.length).toBe(1);
		expect(messages[0]).toMatchObject({ role: "user" });
	});
});
