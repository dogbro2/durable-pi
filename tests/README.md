# 金標用例（golden cases）

每個功能都配一組**確定性**用例。功能再加，迴歸也只是一條命令：

```bash
npm test           # 全部（單元 + 介面）
npm run test:unit  # 只跑純函式，毫秒級
npm run test:api   # 只跑介面（會啟動 wrangler dev）
```

CI 裡 `npm test` 在 `wrangler deploy` **之前**執行——用例不過就不部署。

部署之後用 `npm run smoke`（加 `--deep` 會真跑一次 codemode）打線上介面做驗收。

---

## 目錄

```
tests/
  unit/          純函式與結構金標（不需要伺服器）
    route-coverage.test.ts  路由表凍結清單（階段 6 的 12 個遺留路徑）
    rich.test.tsx      Markdown 渲染：標題/表格/列表/程式碼塊/XSS
    entries.test.ts    會話轉錄解析：順序、思考塊、工具歸屬、檔案產出
    format.test.ts     格式化函式
    theme.test.ts      主題登錄檔與無 DOM 降級
  api/           介面金標（自動 spawn wrangler dev）
    api.test.ts        會話 / 設定 / 供應商 / 技能 / 記憶 / 備份 / 匯出
    multiuser.test.ts  多使用者隔離
    share-tools.test.ts 分享工具端到端（本地假 OpenAI 流式上游驅動 tool_calls）
  helpers/
    reactText.ts   React 元素樹 → 純文本，便於斷言
    fakeOpenAI.ts  最小 OpenAI 相容 SSE 服務，按步驟返回 tool_calls / 文本
```

---

## 寫用例的約定

1. **只測確定性行為**。不呼叫真實模型——所有涉及 LLM 的路徑要麼 mock，要麼測它前後可觀察的儲存/介面狀態。
2. **一個功能至少一條**。新功能提交時必須帶上對應 `describe` 塊，PR 裡寫清楚「這條用例守的是什麼」。
3. **用例要能獨立跑**。`api` 用例自己起服務、自己清理（`tests/.tmp-state` 每次重建），不依賴線上資料。
4. **斷言行為而不是實現**。例如斷言「分隔行不出現在表格裡」，而不是「parseAlign 返回 left」。
5. **失敗資訊要能定位**。用 `toMatchObject` / 具體值斷言，避免只斷言 `toBeTruthy`。

## 介面用例的啟動方式

`beforeAll` 裡用 `wrangler dev --persist-to tests/.tmp-state` 起一個獨立的本地例項，埠 `TEST_PORT`（預設 8797）。不讀取 `.dev.vars`，密碼用 `--var ACCESS_PASSWORD:` 置空，因此無需任何金鑰即可跑。

## 已知未覆蓋

- **真實模型呼叫**：仍未接入；分享工具用 `helpers/fakeOpenAI.ts` 的假流式上游驅動 tool_calls，驗證工具執行、審批與分享落庫，不驗證真實模型的措辭。
- **瀏覽器互動**：目前靠手工 CDP 截圖驗收，未做自動化。

---

## 功能 → 用例對照

| 功能 | 用例 |
|---|---|
| Markdown 渲染 | `unit/rich.test.tsx` |
| 轉錄解析 / 思考塊 / 檔案產出 | `unit/entries.test.ts` |
| 主題切換 | `unit/theme.test.ts` |
| 會話增刪改查 | `api/api.test.ts` · 會話 |
| 設定（思考檔位） | `api/api.test.ts` · 設定 |
| LLM 供應商 | `api/api.test.ts` · 模型供應商 |
| 技能 | `api/api.test.ts` · 技能 |
| 記憶庫 / 一鍵清空 | `api/api.test.ts` · 記憶庫 |
| 備份 / 恢復 | `api/api.test.ts` · 備份與恢復 |
| 匯出 / 版本 | `api/api.test.ts` · 匯出與版本 |
| **子代理編排** | `api/api.test.ts` · 工具註冊（防迴歸）+ `unit/entries.test.ts` · 子任務標題反解 |
| **工具登錄檔** | `api/api.test.ts` · 工具註冊（防迴歸） |
| **能力登錄檔** | `api/api.test.ts` · 能力登錄檔 |
| **提示模板** | `unit/template.test.ts` + `api/api.test.ts` · 提示模板 |
| **規則檔案** | `api/api.test.ts` · 規則檔案 |
| **上下文壓縮（提示）** | `unit/entries.test.ts` · 上下文壓縮 |
| **目標模式** | `api/api.test.ts` · 目標模式 + 工具註冊（防迴歸） |
| **會話分支** | `unit/sessionTree.test.ts` + `api/api.test.ts` · 會話分支 |
| **工具審批** | `api/api.test.ts` · 工具審批 |
| **生成中插話** | `api/api.test.ts` · 生成中插話 |
| **pi 核心版本** | `unit/kernel.test.ts` |
| **自定義工具** | `api/api.test.ts` · 自定義工具 |
| **互動式問答** | `api/api.test.ts` · 互動式問答 |
| **分享工具 / 連結卡** | `api/share-tools.test.ts`（成功/複用/過期/審批/預設有效期）+ `api/api.test.ts` · 檔案分享 / 工具註冊 + `unit/entries.test.ts` · 分享連結 |
| **首屏聚合 `/api/bootstrap`** | `unit/bootstrap.test.ts` · 逐欄位容錯 + `api/api.test.ts` · 首屏聚合 + `api/multiuser.test.ts` · 邀請使用者登錄檔計數 |
| **定時任務編輯（PATCH）** | `unit/automation-patch.test.ts` · 欄位組合 / next_run_at 重算 + `api/api.test.ts` · 定時任務編輯 |
| **路由表覆蓋（階段 6）** | `unit/route-coverage.test.ts`（20 個 method+path 全部命中，未知路徑不命中） |
