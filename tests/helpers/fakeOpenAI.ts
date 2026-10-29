import http from "node:http";

/** 假模型的一步：返回工具呼叫，或一段最終文本。 */
export type FakeStep =
	| { tool: { name: string; args: Record<string, unknown> } }
	| { text: string };

/**
 * 最小 OpenAI 相容流式服務（測試用）：按步驟返回 tool_calls / content。
 * 只實現 pi-ai 用到的 SSE 子集，不訪問外網。
 */
export function startFakeOpenAI(port: number) {
	let steps: FakeStep[] = [];
	let served = 0;
	/** 接下來若干次連線直接斷開（NERE-85：模擬上游瞬時斷流）。 */
	let drops = 0;
	let dropped = 0;
	const server = http.createServer((req, res) => {
		if (drops > 0) {
			drops--;
			dropped++;
			req.socket.destroy();
			return;
		}
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			served++;
			const step = steps.shift() ?? { text: "完成。" };
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const send = (delta: unknown, finish: string | null = null) =>
				res.write(
					`data: ${JSON.stringify({
						id: `chatcmpl-${served}`,
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model: "fake",
						choices: [{ index: 0, delta, finish_reason: finish }],
					})}\n\n`,
				);
			send({ role: "assistant", content: null });
			if ("tool" in step) {
				send({
					tool_calls: [
						{
							index: 0,
							id: `call_${served}`,
							type: "function",
							function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) },
						},
					],
				});
				send({}, "tool_calls");
			} else {
				send({ content: step.text });
				send({}, "stop");
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return {
		listen: () => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => resolve());
			return promise;
		},
		close: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			return promise;
		},
		/** 設定下一輪對話依次使用的步驟。 */
		setSteps: (next: FakeStep[]) => {
			steps = [...next];
			served = 0;
		},
		/** 接下來 count 次請求直接斷連（不消耗步驟），用於驗證重試。 */
		dropNext: (count: number) => {
			drops = count;
		},
		/** 已被斷開的連線數（驗證重試次數）。 */
		droppedCount: () => dropped,
	};
}
