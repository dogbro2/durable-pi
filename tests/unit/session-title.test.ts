import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import { createChatGate, type ChatRuntime } from "../../src/worker/http/ports";
import * as sessionsRepo from "../../src/worker/repo/sessions-repo";
import { createChatService, type PreparedChat } from "../../src/worker/services/chat-service";

/**
 * 會話標題：首輪對話完成後，預設標題（「新會話」「預設會話」「會話 N」）
 * 被 effectiveMessage 前 24 字取代；使用者自訂標題不被覆寫；空訊息不寫入空標題。
 * 經 service.finish() 驗收整條標題路徑（finish → updateTitle → sessions_meta）。
 */

function sqlHandle(db: DatabaseSync): SqlHandle {
	return {
		exec(query, ...bindings) {
			if (!bindings.length && /^\s*(CREATE|ALTER|DROP)\b/i.test(query)) {
				db.exec(query);
				return { toArray: () => [] };
			}
			const rows = db.prepare(query).all(...(bindings as never[]));
			return { toArray: () => rows };
		},
	};
}

function setup(title: string) {
	const db = new DatabaseSync(":memory:");
	const sql = sqlHandle(db);
	migrate(sql);
	const now = new Date().toISOString();
	sessionsRepo.insertIfAbsent(sql, "1", title, now);
	const runtime: ChatRuntime = {
		gate: createChatGate(),
		conversation: async (sessionId) => ({ id: sessionId ?? "1" }),
		configure: async () => {},
		instructions: async () => ({ instructions: "", kbRefs: [] }),
		skillInvocation: () => null,
		toolNames: async () => [],
		lastEntryId: async () => 0,
		submit: async () => ({ id: "s1", raw: null }),
		wait: async () => ({ status: "done", type: "input", answer: "ok" }),
		commit: async () => ({ id: 1, kind: "pi.assistant", model: [{ content: "ok" }] }),
		entries: async () => [],
		watch: async () => ({ stop: async () => {} }),
		abort: async () => {},
		reset: async () => {},
		compact: async () => "",
		reflect: async () => 0,
		usageTokens: async () => 100,
		recover: async () => {},
		scheduleAlarm: async () => {},
		waitUntil: () => {},
	};
	return { sql, service: createChatService({ sql, runtime }) };
}

function prepared(message: string): PreparedChat {
	return {
		root: { id: "1" },
		sessionId: "1",
		input: { message },
		effectiveMessage: message,
		kbRefs: [],
		beforeId: 0,
	};
}

describe("會話標題（首輪取前 24 字）", () => {
	it("「預設會話」被取代：根會話第一輪後換成真標題", async () => {
		const { sql, service } = setup("預設會話");
		await service.finish(prepared("今天天氣怎麼樣。明天會下雨嗎"));
		expect(sessionsRepo.get(sql, "1")?.title).toBe("今天天氣怎麼樣。明天會下雨嗎");
	});

	it("「新會話」被取代", async () => {
		const { sql, service } = setup("新會話");
		await service.finish(prepared("Hello world"));
		expect(sessionsRepo.get(sql, "1")?.title).toBe("Hello world");
	});

	it("「會話 7」被取代", async () => {
		const { sql, service } = setup("會話 7");
		await service.finish(prepared("什麼是 AI"));
		expect(sessionsRepo.get(sql, "1")?.title).toBe("什麼是 AI");
	});

	it("超過 24 字的訊息截斷為前 24 字", async () => {
		const { sql, service } = setup("新會話");
		const message = "今天天氣怎麼樣，明天會下雨嗎，請告訴我詳細的天氣預報";
		await service.finish(prepared(message));
		const title = sessionsRepo.get(sql, "1")?.title ?? "";
		expect(title).toBe(message.slice(0, 24));
		expect(title.length).toBe(24);
	});

	it("使用者自訂標題不被覆寫", async () => {
		const { sql, service } = setup("我的筆記");
		await service.finish(prepared("今天天氣怎麼樣。明天會下雨嗎"));
		expect(sessionsRepo.get(sql, "1")?.title).toBe("我的筆記");
	});

	it("第二輪不覆寫首輪標題", async () => {
		const { sql, service } = setup("新會話");
		await service.finish(prepared("第一個問題"));
		expect(sessionsRepo.get(sql, "1")?.title).toBe("第一個問題");
		await service.finish(prepared("第二個問題"));
		expect(sessionsRepo.get(sql, "1")?.title).toBe("第一個問題");
	});

	it("空訊息不寫入空標題，保留原標題", async () => {
		const { sql, service } = setup("新會話");
		await service.finish(prepared(""));
		expect(sessionsRepo.get(sql, "1")?.title).toBe("新會話");
	});

	it("全空白訊息不寫入空白標題，保留原標題", async () => {
		const { sql, service } = setup("預設會話");
		await service.finish(prepared("   "));
		expect(sessionsRepo.get(sql, "1")?.title).toBe("預設會話");
	});
});
