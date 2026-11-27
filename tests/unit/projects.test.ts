import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import * as sessionsRepo from "../../src/worker/repo/sessions-repo";
import { projectBlock } from "../../src/worker/services/instructions-service";
import { createSessionService, type SessionRuntime } from "../../src/worker/services/session-service";
import { parseSessions } from "../../src/web/lib/collections";

/** 專案（v1.3）：一個專案 = 一個長期會話 + 資料夾 + 專案指令。 */

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

function setup() {
	const sql = sqlHandle(new DatabaseSync(":memory:"));
	migrate(sql);
	let next = 10;
	const runtime = {
		rootId: async () => "1",
		scanConversationIds: async () => [],
		createConversation: async () => String(next++),
	} as unknown as SessionRuntime;
	return { sql, service: createSessionService({ sql, runtime }) };
}

describe("專案", () => {
	it("建立專案：帶名稱與指令，列表標 kind=project", async () => {
		const { sql, service } = setup();
		const created = await service.create({ project: { title: "  論文改寫 ", instructions: "用正體中文" } });
		expect(created).toMatchObject({ title: "論文改寫", kind: "project" });
		await service.create();
		const list = await service.list();
		const project = list.sessions.find((s) => s.id === created.id);
		expect(project).toMatchObject({ kind: "project", instructions: "用正體中文" });
		expect(list.sessions.find((s) => s.id !== created.id)?.kind).toBe("chat");
		expect(sessionsRepo.getProject(sql, created.id)?.title).toBe("論文改寫");
	});

	it("專案指令注入 instructions；一般會話不注入", async () => {
		const { sql, service } = setup();
		const project = await service.create({ project: { title: "裝修", instructions: "預算 30 萬" } });
		const chat = await service.create();
		const block = projectBlock(sql, project.id);
		expect(block).toContain("目前專案：裝修");
		expect(block).toContain("預算 30 萬");
		expect(projectBlock(sql, chat.id)).toBe("");
		service.updateProject(project.id, { instructions: "" });
		expect(projectBlock(sql, project.id)).not.toContain("專案指令");
	});

	it("前端解析 kind / instructions", () => {
		const items = parseSessions({
			sessions: [
				{ id: "2", title: "裝修", kind: "project", instructions: "預算" },
				{ id: "3", title: "閒聊", kind: "chat" },
			],
		});
		expect(items[0]).toMatchObject({ isProject: true, instructions: "預算" });
		expect(items[1]?.isProject).toBeUndefined();
	});
});
