import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate, type SqlHandle } from "../../src/worker/db/migrations";
import { AppError } from "../../src/worker/http/errors";
import { write } from "../../src/worker/repo/files-repo";
import { OPEN_DEDUPE_MS } from "../../src/worker/repo/shares-repo";
import { createShareService, type ShareService } from "../../src/worker/services/share-service";

/** 與 migrations.test.ts 相同的 SqlHandle 包裝：DDL 走 exec，查詢走 prepare().all()。 */
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

const START = Date.UTC(2026, 9, 22, 5, 0, 0);

type Harness = {
	db: DatabaseSync;
	sql: SqlHandle;
	clock: { now: number };
	service: (userKey?: string) => ShareService;
};

/** 每個用例一套記憶體庫：遷移 + 兩個檔案，分享服務用同一套時鐘。 */
function harness(): Harness {
	const db = new DatabaseSync(":memory:");
	const sql = sqlHandle(db);
	migrate(sql);
	write(sql, "1", "a.md", "# 檔案 A\n\n正文", "2026-10-22T05:00:00Z");
	write(sql, "1", "b.md", "# 檔案 B\n\n正文", "2026-10-22T05:00:00Z");
	const clock = { now: START };
	return {
		db,
		sql,
		clock,
		service: (userKey = "") =>
			createShareService({
				sql,
				settings: { get: (_key, fallback) => fallback },
				origin: "https://pi.test",
				userKey,
				runtime: {
					conversationId: async (sessionId) => sessionId ?? "1",
					entries: async () => [],
				},
				now: () => clock.now,
			}),
	};
}

function appError(run: () => void): AppError {
	try {
		run();
	} catch (err) {
		if (err instanceof AppError) return err;
		throw err;
	}
	throw new Error("預期丟擲 AppError");
}

const tokens = (shares: { token: string }[]): string[] => shares.map((share) => share.token).sort();

describe("分享開啟計數（NERE-42）", () => {
	it("有效開啟計數，同一 IP 一小時內只計一次，換 IP 或過窗後繼續計", async () => {
		const { sql, clock, service } = harness();
		const share = service();
		const created = await share.create({ sessionId: "1", kind: "file", name: "a.md", ttlSeconds: 0 });
		const list = () => share.listAll("all")[0]!;

		expect((await share.render(created.token, null, "203.0.113.9"))?.status).toBe(200);
		expect(list()).toMatchObject({ openCount: 1, url: `/s/${created.token}` });
		const firstOpen = list().lastOpenedAt;
		expect(firstOpen).toBe(clock.now);

		// 同 IP、視窗內重複開啟：兩個欄位都不動
		clock.now += 60_000;
		await share.render(created.token, null, "203.0.113.9");
		expect(list()).toMatchObject({ openCount: 1, lastOpenedAt: firstOpen });

		// 換 IP 計一次
		clock.now += 60_000;
		await share.render(created.token, null, "198.51.100.7");
		expect(list()).toMatchObject({ openCount: 2, lastOpenedAt: clock.now });

		// 同一 IP 過了一小時視窗後再次計入
		clock.now += OPEN_DEDUPE_MS + 1;
		await share.render(created.token, null, "198.51.100.7");
		expect(list().openCount).toBe(3);

		// 原始 IP 不落庫：opened_ip_hash 是 64 位十六進位制摘要
		const row = sql.exec("SELECT opened_ip_hash AS hash FROM shares WHERE token = ?", created.token).toArray() as {
			hash: string;
		}[];
		expect(row[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(row[0]!.hash).not.toContain("198.51.100.7");
	});

	it("未知與已過期連結不計數", async () => {
		const { sql, clock, service } = harness();
		const share = service();
		const created = await share.create({ sessionId: "1", kind: "file", name: "a.md", ttlSeconds: 0 });

		await share.render("missing-token", null, "203.0.113.9");
		sql.exec("UPDATE shares SET expires_at = ? WHERE token = ?", clock.now - 1, created.token);
		const expired = await share.render(created.token, null, "203.0.113.9");
		expect(expired?.status).toBe(410);

		const row = sql.exec("SELECT open_count AS n FROM shares WHERE token = ?", created.token).toArray() as { n: number }[];
		expect(row[0]!.n).toBe(0);
	});

	it("會話分享開啟同樣計數（渲染走 runtime 埠）", async () => {
		const { service } = harness();
		const share = service();
		const created = await share.create({ sessionId: "1", kind: "conversation", ttlSeconds: 0 });
		expect((await share.render(created.token, null, "203.0.113.9"))?.status).toBe(200);
		expect(share.listAll("all")[0]).toMatchObject({ openCount: 1, kind: "conversation" });
	});
});

describe("分享全量清單（NERE-42）", () => {
	async function threeShares(share: ShareService, sql: SqlHandle, clock: { now: number }) {
		const first = await share.create({ sessionId: "1", kind: "file", name: "a.md", ttlSeconds: 0 });
		const second = await share.create({ sessionId: "1", kind: "file", name: "b.md", ttlSeconds: 0 });
		const third = await share.create({ sessionId: "1", kind: "conversation", ttlSeconds: 0 });
		// 讓第二條過期；直接改庫，避免 create 的 purge 把它清掉
		sql.exec("UPDATE shares SET expires_at = ? WHERE token = ?", clock.now - 1000, second.token);
		return { first, second, third };
	}

	it("status 過濾：active / expired / all，預設 active", async () => {
		const { sql, clock, service } = harness();
		const share = service();
		const created = await threeShares(share, sql, clock);

		expect(tokens(share.listAll("active"))).toEqual([created.first.token, created.third.token].sort());
		expect(tokens(share.listAll())).toEqual(tokens(share.listAll("active")));
		expect(tokens(share.listAll(null))).toEqual(tokens(share.listAll("active")));
		expect(tokens(share.listAll("expired"))).toEqual([created.second.token]);
		expect(tokens(share.listAll("all"))).toEqual(tokens([created.first, created.second, created.third]));
		// 未知取值按 active，不把過期記錄帶進面板
		expect(tokens(share.listAll("bogus"))).toEqual(tokens(share.listAll("active")));
	});

	it("一行包含契約欄位，url 為相對路徑", async () => {
		const { sql, clock, service } = harness();
		const share = service();
		const { first } = await threeShares(share, sql, clock);
		const row = share.listAll("all").find((item) => item.token === first.token)!;
		expect(row).toEqual({
			token: first.token,
			kind: "file",
			name: "a.md",
			expiresAt: 0,
			theme: "dark",
			createdAt: expect.any(String),
			openCount: 0,
			lastOpenedAt: 0,
			sessionId: "1",
			url: `/s/${first.token}`,
		});
	});
});

describe("撤銷分享（NERE-42）", () => {
	it("撤銷後立即失效，列表為空，再撤 404", async () => {
		const { service } = harness();
		const share = service();
		const created = await share.create({ sessionId: "1", kind: "file", name: "a.md", ttlSeconds: 0 });

		share.revoke(created.token);
		expect(await share.render(created.token)).toBeNull();
		expect(share.listAll("all")).toEqual([]);
		expect(appError(() => share.revoke(created.token))).toMatchObject({ status: 404 });
	});

	it("越權撤銷返回 403，且不刪除別人的行", async () => {
		const { service } = harness();
		const owner = service();
		const invited = service("u_ab12cd34");
		const ownerShare = await owner.create({ sessionId: "1", kind: "file", name: "a.md", ttlSeconds: 0 });
		const invitedShare = await invited.create({ sessionId: "1", kind: "file", name: "b.md", ttlSeconds: 0 });
		expect(invitedShare.token.startsWith("u_ab12cd34.")).toBe(true);

		// 邀請使用者撤主人的舊連結（無字首）→ 403
		expect(appError(() => invited.revoke(ownerShare.token))).toMatchObject({ status: 403 });
		// 主人撤其他使用者的 token → 403（即使本庫沒有這行，也先判歸屬）
		expect(appError(() => owner.revoke("u_zz99yy88.notthere"))).toMatchObject({ status: 403 });
		// 越權失敗後行還在
		expect(tokens(owner.listAll("all"))).toEqual(tokens([ownerShare, invitedShare]));

		// 自己的 token 可以撤
		invited.revoke(invitedShare.token);
		expect(tokens(owner.listAll("all"))).toEqual([ownerShare.token]);
	});
});
