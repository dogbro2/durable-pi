import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopServer } from "./teardown";

/**
 * 知識庫匯入通道（v0.56.0）金標。
 * AI 繫結用 tests/fixtures 裡的 ai-mock（RPC service binding）；
 * v1.1.0：連結抓取端點不再讀環境變數，改為啟動後通過 /api/settings 寫入「工具箱」
 * （指向本檔案的本地 HTTP 樁），避免真實外網與憑證依賴。
 */
const ROOT = join(__dirname, "../..");
const PORT = Number(process.env.INGEST_TEST_PORT ?? 18881);
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = join(ROOT, "tests/.tmp-state-ingest");

const UNIQUE_TERM = "尼瑞德量子錨";
const LINK_TERM = "連結匯入驗收詞";

let proc: ChildProcess | null = null;
let stub: Server | null = null;

/** 連結抓取樁：標題固定，正文 > 1000 字；url 裡帶 empty / boom 時走失敗分支。 */
const LINK_CONTENT = Array.from(
	{ length: 30 },
	(_, i) => `第 ${i + 1} 段：知識庫匯入驗收正文，用於確認連結抓取與入庫鏈路。${LINK_TERM} 出現在正文裡。`,
).join("\n\n");

type IngestOk = { ok: true; docId: string; title: string; chunks: number; chars: number; updated: boolean };
type IngestFail = { ok: false; code: string; message: string };
type IngestResult = IngestOk | IngestFail;
type KbDoc = { id: number; title: string; source: string; chunks: number };
type KbHit = { docId: number; title: string; text: string };

function okBody(json: IngestResult): IngestOk {
	expect(json.ok).toBe(true);
	if (!json.ok) throw new Error("預期成功響應");
	return json;
}
function failBody(json: IngestResult): IngestFail {
	expect(json.ok).toBe(false);
	if (json.ok) throw new Error("預期失敗響應");
	return json;
}

async function api<T>(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let json: T | null = null;
	try {
		json = JSON.parse(text) as T;
	} catch {
		// 非 JSON 響應
	}
	return { status: res.status, json: json as T, text };
}

const postIngest = (body: unknown) =>
	api<IngestResult>("/api/kb/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const upload = (file: File) => {
	const form = new FormData();
	form.append("file", file);
	return api<IngestResult>("/api/kb/ingest", { method: "POST", body: form });
};

async function waitForServer(timeoutMs = 90_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const res = await fetch(`${BASE}/api/auth`, { signal: AbortSignal.timeout(1500) });
			if (res.ok) return;
		} catch {
			// 還沒起來
		}
		await delay(800);
	}
	throw new Error("wrangler dev 未在超時內就緒");
}

beforeAll(async () => {
	rmSync(STATE, { recursive: true, force: true });

	stub = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			let target = "";
			try {
				target = String((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { url?: unknown }).url ?? "");
			} catch {
				// 非法 JSON 走預設成功分支
			}
			const send = (status: number, body: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
			};
			if (target.includes("boom")) return send(500, { error: { message: "上游抓取服務不可用" } });
			if (target.includes("empty")) return send(200, { title: "空頁面", content: "   " });
			send(200, { title: "金標測試頁面", content: LINK_CONTENT });
		});
	});
	const listening = Promise.withResolvers<void>();
	stub.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = stub.address();
	if (!address || typeof address === "string") throw new Error("抓取樁未監聽");
	const stubUrl = `http://127.0.0.1:${address.port}`;

	proc = spawn(
		"npx",
		[
			"wrangler", "dev",
			"-c", "tests/fixtures/wrangler.ingest.jsonc",
			"-c", "tests/fixtures/wrangler.ai-mock.jsonc",
			"--port", String(PORT),
			"--var", "ACCESS_PASSWORD:",
			"--var", "PI_ALLOW_OPEN:1",
			"--var", "CF_DISABLE_VECTOR:1",
			"--persist-to", STATE,
		],
		{ cwd: ROOT, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "ignore", detached: true },
	);
	await waitForServer();
	// 工具箱端點在 UI 設定裡：這裡寫成本地樁，等價於使用者在設定頁填寫。
	const configured = await api("/api/settings", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ toolbox: { baseUrl: stubUrl, apiKey: "golden-key", model: "golden-model" } }),
	});
	if (configured.status !== 200) throw new Error(`工具箱設定失敗：${configured.status} ${configured.text}`);
}, 240_000);

afterAll(async () => {
	await stopServer(proc, STATE);
	if (stub) {
		const closed = Promise.withResolvers<void>();
		stub.close(() => closed.resolve());
		await closed.promise;
	}
});

describe("知識庫匯入：檔案", () => {
	it("PDF 走 toMarkdown 後入庫，列表與檢索都能命中", async () => {
		const res = await upload(new File(["%PDF-1.4 mock"], "向量檢索實戰筆記.pdf", { type: "application/pdf" }));
		expect(res.status).toBe(200);
		const body = okBody(res.json);
		expect(body.title).toBe("向量檢索實戰筆記");
		expect(body.docId).toBeTypeOf("string");
		expect(body.chunks).toBeGreaterThan(0);
		expect(body.chars).toBeGreaterThan(0);

		const list = await api<{ docs: KbDoc[] }>("/api/kb");
		const doc = list.json.docs.find((d) => String(d.id) === body.docId);
		expect(doc).toMatchObject({ title: "向量檢索實戰筆記", source: "向量檢索實戰筆記.pdf" });
		expect(doc!.chunks).toBeGreaterThan(0);

		const search = await api<{ hits: KbHit[] }>(`/api/kb/search?q=${encodeURIComponent(UNIQUE_TERM)}`);
		expect(search.json.hits.length).toBeGreaterThan(0);
		expect(search.json.hits[0]!.title).toBe("向量檢索實戰筆記");
		expect(search.json.hits[0]!.text).toContain(UNIQUE_TERM);
	});

	it("Markdown / TXT 不依賴 AI，直接入庫", async () => {
		const res = await upload(new File(["# 本地筆記\n\n純文本匯入路徑，不呼叫 toMarkdown。"], "local-note.md", { type: "text/markdown" }));
		expect(res.status).toBe(200);
		const body = okBody(res.json);
		expect(body).toMatchObject({ title: "local-note", chunks: 1 });
		expect(body.chars).toBeGreaterThan(0);
	});

	it("解析結果為空 → 422 empty_content", async () => {
		const empty = await upload(new File(["MOCK_EMPTY"], "blank.pdf", { type: "application/pdf" }));
		expect(empty.status).toBe(422);
		const emptyBody = failBody(empty.json);
		expect(emptyBody.code).toBe("empty_content");
		expect(emptyBody.message).toBeTruthy();

		const blankText = await upload(new File(["   \n"], "blank.txt", { type: "text/plain" }));
		expect(blankText.status).toBe(422);
		const blankBody = failBody(blankText.json);
		expect(blankBody.code).toBe("empty_content");
	});

	it("解析器報錯 → 422 且帶原因", async () => {
		const res = await upload(new File(["MOCK_ERROR"], "broken.pdf", { type: "application/pdf" }));
		expect(res.status).toBe(422);
		const body = failBody(res.json);
		expect(body.code).toBe("empty_content");
		expect(body.message).toContain("這個檔案打不開");
	});

	it("超過 25MB → 413 too_large", async () => {
		const big = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "huge.pdf", { type: "application/pdf" });
		const res = await upload(big);
		expect(res.status).toBe(413);
		const body = failBody(res.json);
		expect(body.code).toBe("too_large");
		expect(body.message).toContain("25MB");
	});

	it("不支援的格式 → 415 unsupported_type", async () => {
		const res = await upload(new File(["MZ"], "setup.exe", { type: "application/x-msdownload" }));
		expect(res.status).toBe(415);
		const body = failBody(res.json);
		expect(body.code).toBe("unsupported_type");
		expect(body.message).toContain("PDF");
	});
});

describe("知識庫匯入：連結", () => {
	it("抓取成功，標題取頁面 title，正文完整入庫", async () => {
		const res = await postIngest({ url: "https://example.com/golden-article" });
		expect(res.status).toBe(200);
		const body = okBody(res.json);
		expect(body.title).toBe("金標測試頁面");
		expect(body.chars).toBeGreaterThan(1000);

		const search = await api<{ hits: KbHit[] }>(`/api/kb/search?q=${encodeURIComponent(LINK_TERM)}`);
		expect(search.json.hits.length).toBeGreaterThan(0);
		expect(search.json.hits[0]!.title).toBe("金標測試頁面");
	});

	it("頁面無正文 → 422 empty_content", async () => {
		const res = await postIngest({ url: "https://example.com/empty-page" });
		expect(res.status).toBe(422);
		const body = failBody(res.json);
		expect(body.code).toBe("empty_content");
	});

	it("抓取服務失敗 → 502 fetch_failed，不靜默", async () => {
		const res = await postIngest({ url: "https://example.com/boom" });
		expect(res.status).toBe(502);
		const body = failBody(res.json);
		expect(body.code).toBe("fetch_failed");
		expect(body.message).toContain("上游抓取服務不可用");
	});

	it("非 http(s) 連結 → 400 invalid_url", async () => {
		const res = await postIngest({ url: "file:///etc/passwd" });
		expect(res.status).toBe(400);
		const body = failBody(res.json);
		expect(body.code).toBe("invalid_url");
	});
});

describe("知識庫匯入：去重與版本替換（NERE-47）", () => {
	const FILE = "去重驗收.pdf";
	const listBySource = async (source: string) =>
		(await api<{ docs: KbDoc[] }>("/api/kb")).json.docs.filter((doc) => doc.source === source);

	it("同一份 PDF 連導兩次：仍 1 篇、chunk 數不變、updated:false", async () => {
		const first = okBody((await upload(new File(["%PDF-1.4 dedupe"], FILE, { type: "application/pdf" }))).json);
		expect(first.updated).toBe(true);
		const before = await listBySource(FILE);
		expect(before).toHaveLength(1);

		const second = okBody((await upload(new File(["%PDF-1.4 dedupe"], FILE, { type: "application/pdf" }))).json);
		expect(second).toMatchObject({ docId: first.docId, chunks: first.chunks, updated: false });

		const after = await listBySource(FILE);
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({ id: Number(first.docId), chunks: before[0]!.chunks });
	});

	it("改一句話再導：仍 1 篇、updated:true、舊句子不再命中", async () => {
		const [before] = await listBySource(FILE);
		expect(before).toBeTruthy();

		const revised = okBody(
			(await upload(new File(["%PDF-1.4 MOCK_REVISION"], FILE, { type: "application/pdf" }))).json,
		);
		expect(revised).toMatchObject({ docId: String(before!.id), updated: true });

		const after = await listBySource(FILE);
		expect(after).toHaveLength(1);
		expect(after[0]!.id).toBe(before!.id);

		// 其他文件也可能含相近詞，只驗證被替換的這一篇
		const oldHits = await api<{ hits: KbHit[] }>(`/api/kb/search?q=${encodeURIComponent("舊版本專用詞")}`);
		expect(oldHits.json.hits.filter((hit) => hit.docId === before!.id && hit.text.includes("舊版專用詞甲"))).toEqual([]);
		const oldPhrase = await api<{ hits: KbHit[] }>(`/api/kb/search?q=${encodeURIComponent("舊版")}`);
		expect(oldPhrase.json.hits.filter((hit) => hit.docId === before!.id)).toEqual([]);

		const newHits = await api<{ hits: KbHit[] }>(`/api/kb/search?q=${encodeURIComponent("新版專用詞")}`);
		expect(newHits.json.hits.length).toBeGreaterThan(0);
		expect(newHits.json.hits[0]!.title).toBe("去重驗收");
	});
});
