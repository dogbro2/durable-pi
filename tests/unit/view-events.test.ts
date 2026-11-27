import { describe, expect, it } from "vitest";
import { createViewEventTracker, type ViewLike } from "../../src/worker/lib/view-events";

const live = (l: object, entries: ViewLike["entries"] = []): ViewLike => ({ entries, docs: { "pi.live": l } });

describe("view-events tracker（Conversation.watch → 舊事件形狀）", () => {
	it("基線不重放，之後只推增量文字與思考", () => {
		const t = createViewEventTracker();
		expect(t.next(live({ generation: { attempt: 1, message: { content: [{ type: "text", text: "舊" }] } } }), true)).toEqual([]);
		const e1 = t.next(live({ generation: { attempt: 1, message: { content: [{ type: "text", text: "舊新" }] } } }));
		expect(e1).toEqual([{ type: "message_update", changes: [{ type: "text_delta", delta: "新" }] }]);
		const e2 = t.next(
			live({
				generation: { attempt: 2, message: { content: [{ type: "thinking", thinking: "想" }, { type: "text", text: "答" }] } },
			}),
		);
		expect(e2[0]?.changes).toEqual([
			{ type: "thinking_start" },
			{ type: "thinking_delta", delta: "想" },
			{ type: "text_delta", delta: "答" },
		]);
	});

	it("工具開始/結束各推一次，結束帶結果條目；巢狀呼叫消失時補 end", () => {
		const t = createViewEventTracker();
		t.next(live({}), true);
		const msg = { content: [{ type: "toolCall", id: "c1", name: "web", arguments: { q: "x" } }] };
		const s1 = t.next(
			live({
				tools: [{ callId: "c1", name: "web", status: "running" }],
				nestedTools: [{ callId: "c1/a", name: "fetch", status: "running", parentCallId: "c1", arguments: { u: 1 } }],
			}, [{ id: 5, model: [msg] }]),
		);
		expect(s1.map((e) => e.type)).toEqual(["tool_execution_start", "tool_execution_start"]);
		expect(s1[0]?.args).toEqual({ q: "x" });
		expect(s1[1]?.parentToolCallId).toBe("c1");
		const result = { content: [{ type: "text", text: "ok" }] };
		const s2 = t.next(live({ tools: [{ callId: "c1", name: "web", status: "done", entry: 6 }] }, [{ id: 6, model: [result] }]));
		expect(s2.map((e) => [e.type, e.toolCallId])).toEqual([
			["tool_execution_end", "c1"],
			["tool_execution_end", "c1/a"],
		]);
		expect(s2[0]?.entry?.model?.[0]).toEqual(result);
		expect(t.next(live({ tools: [{ callId: "c1", name: "web", status: "done", entry: 6 }] }))).toEqual([]);
	});

	it("壓縮開始與結束", () => {
		const t = createViewEventTracker();
		t.next(live({}), true);
		expect(t.next(live({ compactions: [{}] }))).toEqual([{ type: "compaction_start" }]);
		expect(t.next(live({}))).toEqual([{ type: "compaction_end" }]);
	});
});
