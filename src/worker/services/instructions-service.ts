import type { SqlHandle } from "../db/migrations";
import type { SettingsPort } from "../http/ports";
import type { KbRef } from "../lib/kb";
import { listSkillMeta } from "../repo/skills-repo";
import { getProject } from "../repo/sessions-repo";
import type { KbService } from "./kb-service";
import { enabledRuleContents } from "./prompts-service";
import { goalInstructionsBlock, readGoal } from "./goal-service";

/**
 * 組裝本輪 instructions（ADR-0001 §2 / v0.46.0）：
 * 基礎規則 + 技能索引 + 顯式技能 + 進行中的目標 + 知識庫預檢索。
 * 純裝配，SQL 經 repo，知識庫經 `KbService` 注入。
 */
export type InstructionsDeps = {
	sql: SqlHandle;
	settings: SettingsPort;
	kb: KbService;
};

export type SkillInvocation = { name: string; content: string; rest: string };

/** 已安裝技能索引（blocked 不進入模型視野）。讀取失敗時回退空陣列。 */
function skillIndex(sql: SqlHandle): { name: string; description: string }[] {
	try {
		return listSkillMeta(sql)
			.filter((skill) => skill.auditStatus !== "blocked")
			.map((skill) => ({ name: skill.name, description: skill.description }));
	} catch {
		return [];
	}
}

const BASE =
	"你在 Durable Pi 裡執行：一個自架的 pi agent 工作台，單一 Cloudflare Worker + 每位使用者一個 Durable Object，個人用量在 Cloudflare 免費額度內。被問到本專案時不要臆造倉庫位址、版本或功能；不確定就直說不知道。\n" +
	"凡是需要計算、批次處理、解析或轉換資料時，必須呼叫 codemode 工具寫 JavaScript 執行（指令碼內可用 await tools.<name>(args) 呼叫其它工具），不要心算或聲稱沒有該工具。";

function withSkillInstructions(base: string, sql: SqlHandle, settings: SettingsPort): string {
	let out = base;
	const index = skillIndex(sql);
	if (index.length) {
		const lines = index.map((s) => `- ${s.name}：${s.description || "（無描述）"}`).join("\n");
		out = `${out}\n\n可用技能（需要時呼叫 load_skill 讀取完整說明後再執行）：\n${lines}`;
	}
	out += "\n安裝技能：使用者給出 SKILL.md 連結時，直接呼叫 install_skill({ url }) 安裝；不要用 write_file 往工作臺複製技能檔案，工作臺檔案不會被註冊。";
	// 使用者知識庫（v0.45.0）：每個使用者獨立，和工作臺檔案是兩套儲存
	out +=
		"\n使用者資料與長期知識用知識庫：先 kb_search 檢索；使用者要求「存到知識庫 / 記到資料庫」時用 kb_add。工作臺檔案不會被知識庫檢索到。";
	// 網頁搜尋開啟時才在提示詞裡引導模型使用；關閉時工具會返回開啟指引。
	if (settings.get("web_search", "1") === "1") {
		out += "\n需要聯網查資料時優先用 web_search 搜尋、web_fetch_page 抓取正文（比 http_fetch 更乾淨）。";
	}
	// 分步計劃（v0.22.0）：多步任務先 update_plan，使用者在聊天裡實時看到清單。
	out +=
		"\n任務需要 3 步以上（多次檢索、多檔案產出、先計算後寫作等）時，先用 update_plan 列出步驟並在每完成一步後更新；單步問題不要呼叫它。";
	// 規則檔案（v0.31.0）：使用者維護的專案約定，每輪注入
	const rules = enabledRuleContents(sql);
	if (rules.length) {
		out += "\n\n## 專案規則（必須遵守）\n" + rules.map((r) => `- ${r}`).join("\n");
	}
	// 互動式問答（v0.37.0）：需要使用者決策時用卡片而不是純文本羅列
	out +=
		"\n需要使用者在方案之間做選擇、或缺少關鍵偏好無法繼續時，用 ask_user 提結構化問題（一次 1–6 題，每題給 recommended 選項），比在正文裡羅列問題更好用；能從環境查到的資訊不要問使用者。";
	// 子代理（v0.29.0）：可並行的獨立子任務交給它們
	out +=
		"\n當有 2–4 個**互不依賴**的子任務（如分別調研幾個物件再做對比）時，用 dispatch_tasks 並行分派給子代理，比序列逐個做更快；子代理看不到主對話，每個 prompt 要自包含。";
	// 分享（v0.55.0）：模型能直接生成連結，不能把使用者推給配置項
	out +=
		"\n使用者說「分享 / 發我個連結 / 轉給同事 / 生成公開連結」時，直接呼叫 share_file（工作臺檔案）或 share_conversation（當前對話），並把返回的完整 URL 原樣寫進回覆；不要回答「做不到」，也不要讓使用者去別處配置。";
	// 產出即給連結（NERE-73）：可交付文件收尾時問一句，別自動分享
	out +=
		"\n產出是可交付文件（報告、週報、清單等）時，在回覆結尾用一句話問是否需要分享連結；使用者確認後再呼叫 share_file，不要自動分享。";
	return out;
}

/** 專案會話：說明它是長期專案，資料夾就是本會話的工作臺檔案，並附上專案指令。 */
export function projectBlock(sql: SqlHandle, sessionId?: string): string {
	if (!sessionId) return "";
	let project: { title: string; instructions: string } | undefined;
	try {
		project = getProject(sql, sessionId);
	} catch {
		return "";
	}
	if (!project) return "";
	let out =
		`\n\n## 目前專案：${project.title}\n` +
		"這是一個長期專案會話，所有相關對話都在這裡進行。本會話的工作臺檔案就是專案資料夾：產出的文件、資料與筆記都寫進工作臺，之後回來時先看資料夾裡已有的內容再接著做。";
	const text = project.instructions.trim();
	if (text) out += `\n\n### 專案指令（必須遵守）\n${text}`;
	return out;
}

export async function buildInstructions(
	{ sql, settings, kb }: InstructionsDeps,
	inv: SkillInvocation | null,
	sessionId?: string,
	message?: string,
): Promise<{ instructions: string; kbRefs: KbRef[] }> {
	const withSkills = withSkillInstructions(BASE, sql, settings);
	const goal = sessionId ? readGoal(sql, sessionId) : null;
	const goalBlock = goalInstructionsBlock(goal) + projectBlock(sql, sessionId);
	const prefetch = message ? await kb.prefetch(message) : { block: "", refs: [] };
	// 只有真正注入了檢索塊才記引用（NERE-40）：未命中/開關關閉時 kbRefs 為空。
	const kbRefs = prefetch.block ? prefetch.refs : [];
	const instructions = !inv
		? withSkills + goalBlock + prefetch.block
		: `${withSkills}${goalBlock}\n\n## 使用者顯式呼叫的技能：${inv.name}\n下面是該技能的完整說明，請嚴格按照它執行，不要聲稱找不到該技能：\n\n${inv.content}${prefetch.block}`;
	return { instructions, kbRefs };
}
