import { describe, expect, it } from "vitest";
import { flattenSessions } from "../../src/web/lib/sessionTree";
import type { SessionListItem } from "../../src/web/types";

function session(id: string, parentId?: string): SessionListItem {
	return { id, title: `會話 ${id}`, createdAt: "", ...(parentId ? { parentId } : {}) };
}

describe("flattenSessions · 分支樹（v0.32.0）", () => {
	it("沒有分支時保持原順序、深度都是 0", () => {
		const out = flattenSessions([session("3"), session("2"), session("1")]);
		expect(out.map((n) => n.session.id)).toEqual(["3", "2", "1"]);
		expect(out.every((n) => n.depth === 0)).toBe(true);
	});

	it("分支緊跟父會話並縮排一層", () => {
		const out = flattenSessions([session("1"), session("2", "1"), session("3", "1")]);
		expect(out.map((n) => [n.session.id, n.depth])).toEqual([
			["1", 0],
			["2", 1],
			["3", 1],
		]);
	});

	it("多級分支逐層加深", () => {
		const out = flattenSessions([session("1"), session("2", "1"), session("3", "2")]);
		expect(out.map((n) => [n.session.id, n.depth])).toEqual([
			["1", 0],
			["2", 1],
			["3", 2],
		]);
	});

	it("父會話不存在時按頂層顯示", () => {
		const out = flattenSessions([session("9", "404")]);
		expect(out).toEqual([{ session: session("9", "404"), depth: 0 }]);
	});

	it("自引用不會死迴圈", () => {
		const out = flattenSessions([session("1", "1")]);
		expect(out.map((n) => n.session.id)).toEqual(["1"]);
	});

	it("互指成環時每個會話只出現一次", () => {
		const out = flattenSessions([session("1", "2"), session("2", "1")]);
		expect(out.map((n) => n.session.id).sort()).toEqual(["1", "2"]);
	});
});
