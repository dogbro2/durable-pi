import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * 金標專用：模擬 Workers AI 的 toMarkdown。
 * CI 沒有 Workers AI 憑證，真實 PDF 解析跑不了；這裡用 RPC service binding
 * 提供一個同形的 toMarkdown，讓 /api/kb/ingest 的 PDF 路徑可以端到端驗證。
 * 檔案內容裡帶 MOCK_ERROR / MOCK_EMPTY 時分別模擬解析失敗與空正文。
 */
const MOCK_MARKDOWN = [
	"# 向量檢索實戰筆記",
	"",
	"## 第一頁：為什麼需要向量檢索",
	"關鍵詞檢索依賴字面命中，遇到同義改寫就會漏。尼瑞德量子錨 是本篇第 3 頁出現的專有名詞，用來驗證匯入後的檢索鏈路。",
	"",
	"## 第二頁：分塊策略",
	"按段落切塊，每塊不超過 800 字，相鄰塊保留 80 字重疊。這樣既能控制 embedding 的輸入長度，也能避免切在句子中間。",
	"",
	"## 第三頁：尼瑞德量子錨 的定位",
	"尼瑞德量子錨 是檢索質量評估裡的人工標註錨點：只要查詢這個詞能命中本文件，就說明解析、分塊、索引三步都通了。",
	"",
	"## 第四頁：混合檢索",
	"向量召回負責語義相近，BM25 負責精確詞。兩路結果用 RRF 融合，前 6 條注入上下文，剩餘的交由模型按需再查。",
	"",
	"## 第五頁：索引維護",
	"刪除文件時同步刪除分塊、FTS 行與向量 id，避免髒資料。重建索引只處理 vectorized = 0 的分塊，失敗自動回退關鍵詞檢索。",
	"",
	"## 第六頁：成本控制",
	"embedding 批次 16 條一次請求，向量庫批次 200 條寫入；許可權按使用者 DO 隔離，向量後設資料帶 scope 過濾。",
].join("\n");

/** 版本替換用：帶 MOCK_REVISION 的 PDF 返回換了備註段落的正文，舊句子在新版裡完全不存在。 */
const OLD_SECTION = "## 第七頁：初版備註\n\n舊版專用詞甲：這句只出現在初版裡，用於確認版本替換後不再被檢索到。";
const NEW_SECTION = "## 第七頁：修訂備註\n\n新版專用詞乙：這句只出現在修訂版裡，用於確認替換後的正文已重建索引。";

export class AiMock extends WorkerEntrypoint {
	async toMarkdown(input: { name: string; blob: Blob }) {
		const text = await input.blob.text();
		if (text.includes("MOCK_ERROR")) {
			return { id: "1", name: input.name, mimeType: "application/pdf", format: "error", error: "這個檔案打不開" };
		}
		if (text.includes("MOCK_EMPTY")) {
			return { id: "1", name: input.name, mimeType: "application/pdf", format: "markdown", tokens: 0, data: "  \n " };
		}
		return {
			id: "1",
			name: input.name,
			mimeType: "application/pdf",
			format: "markdown",
			tokens: 120,
			data: `${MOCK_MARKDOWN}\n\n${text.includes("MOCK_REVISION") ? NEW_SECTION : OLD_SECTION}`,
		};
	}
}

export default { fetch: () => new Response("ai-mock") };
