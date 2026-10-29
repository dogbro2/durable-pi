# 更新記錄

本檔案記錄每次功能迭代。每次 push 到 `main` 都會自動部署（GitHub Actions → Cloudflare Worker）。

## v1.2.0（2026-10-29）

### 改名：`cloudflare-free-web-pi` → **Durable Pi**（`durable-pi`）

舊名裡的 `free` 像廣告詞、`web` 太空泛，而這專案真正說得出口的差異只有一個：**durable**（每位使用者一個 Durable Object，資料留在自己的 SQLite 裡）跑 **pi** agent。改名後 repo / npm 套件名 / Worker 名統一為 `durable-pi`。

- 介面標題、登入頁、分享頁署名、`<title>` / OG / Twitter meta、系統提示、`/api/health` 與 session 健康檢查一併更新
- 分享頁頁尾的推廣出口改由 `REPO_URL` 控制（`wrangler.jsonc` 的 `vars`）：留空就不顯示，不再寫死任何人的倉庫位址；填了才會出現「用同樣的方式做一個 →」
- `scripts/smoke.mjs`、`scripts/create-demo-share.mjs` 不再預設指向公開例項，`PI_BASE` 改為必填，沒給就明確報錯退出
- `README` 的徽章 / Deploy 按鈕 / `git clone` 指向本倉庫 `dogbro2/durable-pi`；拿掉了原作者的示範例項連結
- 順手修掉文件裡兩處過期描述：功能表的模型名（不再是 `deepseek-flash` / `deepseek-v4-pro`）、網頁工具的搜尋端點（改在「設定 → 工具服務」填）

**刻意保留舊名的三處**（改了會出事，不是漏改）：

| 位置 | 值 | 為什麼不能改 |
|---|---|---|
| `src/worker.ts` | `pi-harness-access-v1/v2`、`pi-harness-invite-v1` | HMAC 簽名輸入：改了所有登入 Cookie 失效、既有邀請碼全部作廢 |
| `src/web/*` | `pi-harness.*` localStorage 鍵 | 改了使用者的面板寬度 / 開合狀態被重置 |
| `skills/catalog.json` | `contentUrl` 指向上游倉庫 | 一鍵安裝要抓得到檔案；改成佔位字串會讓安裝全部 404 |

**升級注意**：Worker 名就是 Durable Object 的儲存位置。已經在 `pi-harness-spike` 名下跑著、而且有資料的例項，請把 `wrangler.jsonc` 的 `name` 改回舊值再部署；改名等於換一個新 Worker，舊的對話 / 知識庫 / 分享不會跟過去。

測試：634 pass / 1 skip。

## v1.1.0（2026-10-29）

本次是「自架小範圍使用」的加固版：外部端點只剩你自己在 UI 裡填的那幾個。

### 移除所有硬編碼 DeepSeek 端點，改為只在 UI 設定
- 刪掉 `api.deepseek.com` 的三處硬編碼（`/v1/chat/completions`、`/v1/tools/search`、`/v1/tools/fetch`）與 `reflect-service` 裡寫死的模型名
- 刪掉內建 `deepseek` 供應商與 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 環境變數讀取：模型端點只來自 `providers` 表（設定 → 模型與工具服務）
- 未配置供應商時聊天入口返回 `400 model_not_configured` 並給出操作路徑，不再偷偷回落到任何預設地址；`/api/models` 與 `/api/bootstrap` 相應返回空清單（`provider: ""`）
- 新增「工具服務」設定（`tool_base_url` / `tool_api_key` / `tool_model`）：搜尋、網頁抓取、知識庫連結匯入、自動記憶共用；任一留空則對應功能直接關閉、不發請求
- 設定頁新增工具服務區塊（金鑰只回顯 `••••xxxx`，可一鍵清除），並移除「內建供應商」卡片、補上「還沒有供應商」空狀態

### 移除 AI / Vectorize 繫結
- `wrangler.jsonc` 不再宣告 `ai` 與 `vectorize` 繫結；知識庫預設只有 FTS5 關鍵詞檢索（零外部呼叫）
- 代價：PDF / DOCX 匯入與向量 / 混合檢索預設不可用，只收 Markdown / 純文字；把繫結加回來即自動恢復（程式碼路徑保留，未繫結時降級）
- 設定頁的向量 / 混合按鈕在未繫結時停用

### 安全與運維
- 登入限速：遷移 v2 新增 `login_failures`，由 UserRegistry DO 計數；同一 IP 10 分鐘失敗 5 次封 15 分鐘，返回 429 + `retry-after`
- 備份 / 使用者匯出不再帶明文密鑰：供應商 `api_key` 清空、`tool_api_key` 不入庫、MCP headers 的 authorization / token / api-key 換成 `***`，並標記 `secretsOmitted: true`；恢復時留空或 `***` 沿用庫裡原值
- `http_fetch` 預設審批改為「詢問」（仍可在逐工具審批裡改回放行），避免任意 URL 成為外傳通道
- 沒有 `ACCESS_PASSWORD` 且沒有 `PI_ALLOW_OPEN=1` 時整站返回 503，避免誤部署成公開實例
- 所有 Worker 響應與靜態資產統一加 CSP / nosniff / DENY / no-referrer / permissions-policy；為此把 `index.html` 的內聯主題腳本移到 `public/theme-boot.js`（`script-src` 不需要 `unsafe-inline`）
- `wrangler.jsonc` 的 `DEMO_SHARE_URL` 預設清空，`index.html` 移除作者網域的 `og:url` / 絕對 `og:image`
- `deploy.yml` 去掉寫死的原作者倉庫名，改為「有 `CLOUDFLARE_API_TOKEN` 才部署」；冒煙測試改用倉庫變數 `SMOKE_BASE_URL`，未設則跳過
- `package.json`：版本 1.1.0、`license: MIT`、移除無效 `main`、加 `engines.node>=22`，並把實際被引用的 `typebox` / `@earendil-works/chord` 補進 `dependencies`

### 全站繁體化
- 所有程式碼註釋、UI 文案、文件與技能內容由簡體轉繁體（OpenCC s2twp），`zh-CN` 全部改為 `zh-TW`（`<html lang>`、`toLocaleString`、`localeCompare`）
- `README.zh-CN.md` 改名為 `README.zh-TW.md`，技能目錄 `skills/catalog.json` 重新生成雜湊

## v1.0.6（2026-10-26）

### 模型請求瞬時錯誤重試 + 空閒看門狗（NERE-85）
- 新增 provider fetch 包裝層（`src/worker/lib/provider-fetch.ts`）：連線失敗、首個位元組前的流中斷、408 / 429 / 5xx 自動重試，最多 2 次額外嘗試，退避 500ms → 2s；每次重試輸出一行結構化 `console.warn`（`attempt` / `errorClass` / `elapsedMs`，不含金鑰）
- 401 / 403 / 400 等不可重試狀態立即失敗，0 次重試，不浪費按量配額
- 空閒看門狗：從發起請求到收到首個響應位元組，60s 內沒有任何位元組即中止本次嘗試並按可重試處理；重試都在拿到首個位元組前完成，SSE 事件不重複；首個位元組之後的中斷不重放
- 自定義供應商與內建 DeepSeek 共用同一包裝；關閉核心按錯誤文本重試整輪生成的策略（`retry.enabled=false`），瞬時重試只發生在這一層，一次斷流最多 3 次請求
- 最終失敗的異常資訊仍由 runner 摘要進 `automations.last_error`（配合 NERE-84）

## v1.0.5（2026-10-26）

### 定時任務執行隔離：每輪新建會話（NERE-84）
- 08:03「每日科技日報」連續失敗的真因是單輪上下文過大：session 2991 已積累 4800+ 條目，每天執行都把全部歷史塞進一次模型請求。現已改為**每次執行新建會話**（遷移 v10 新增 `automations.fresh_session`，預設 1），任務執行完歷史不再跨輪累積
- `automations.last_session_id` 記錄最近一次執行實際用的會話；`last_error` 保留（≤300 字）並在成功時清空
- `GET /api/automations` 返回 `fresh_session` / `last_session_id`；`PATCH /api/automations` 接受 `fresh_session`（`false` = 固定使用 `session_id`，相容顯式繫結會話的任務）
- alarm 與「立即執行」同一語義；建會話失敗記為 `failed` 並保留原繫結，下一輪重試

### 定時面板失敗原因 + 產出指向最新會話（NERE-86）
- 定時任務行在 `last_status=failed` 時顯示 `last_error` 摘要（截斷 160 字，懸停 `title` 看全文）；成功 / 順延 / 無原因不顯示（沿用 v1.0.4 行為，本次補測試鎖定）
- 「檢視產出」改跳 `last_session_id`——最近一次執行實際用的會話；老資料 / 未執行過回落到 `session_id`
- 編輯彈窗新增「每次執行用新會話」開關：預設開，存量任務回填服務端當前值，儲存隨 PATCH 提交 `fresh_session`
- 列表解析同步 `last_session_id` / `fresh_session`（snake_case 相容，缺失不誤讀為關閉）；`tsc -p src/web/tsconfig.json`、`npm run build:web` 通過

## v1.0.4（2026-10-23）

### 定時任務失敗原因落庫 + 面板立即執行（v1.0.4）
- 08:03 日報失敗只留下 `console.warn`（日誌已丟，事後無法回溯）；現在失敗原因寫入 `last_error`（遷移 v9 `automation-last-error`），下次成功自動清空
- alarm 與 run-now（手動執行）統一記 `last_run_at / last_status / last_error`；手動運行同樣順延 `next_run_at`
- 定時面板新增「執行」按鈕：手動補跑一次（完整 chat 回合可能耗時幾分鐘，按鈕鎖定到返回）；失敗時面板直接顯示原因
- 復現結論：`amvj8h6jc`（每日科技日報）run-now 成功併產出分享連結，08:03 為瞬時故障；本次改動讓下次失敗可自查

## v1.0.3（2026-10-23）

### 修復 run-now 型別錯誤（v1.0.3）
- `automations.list()` 返回 `AutomationRow`，會話欄位是 `session_id`；v1.0.2 寫成了 `sessionId`
- CI 的 `tsc -p tsconfig.ci.json` 攔下；已修正並在本地跑過型別檢查

## v1.0.2（2026-10-23）

### 定時任務立即執行（v1.0.2）
- 修復 v1.0.1 的分層檢查失敗：`/automations/run` 不再在路由裡直接讀 SQL，改用 automation service 的 `list()`
- 路由直接丟擲 `AppError`，由統一錯誤層返回，不再手寫錯誤響應
- 保留 `POST /api/automations/run`：手動執行定時任務，用於診斷 08:03 日報失敗與補跑

## v1.0.1（2026-10-23）

### 定時任務立即執行 + 白屏修復（v1.0.1）
- 新增 `POST /api/automations/run`：手動執行指定定時任務，返回回答或錯誤，用於診斷和補跑
- 修復登入後白屏（React error #310）：Rail 的 `useCallback` 移到登入 early return 之前
- 2026-10-23 08:03「每日科技日報」`last_status=failed`；本版本用於復現失敗原因

## v1.0.0（2026-10-22）

首個穩定版本。基線 `main@36ada72`：49 個 issue 關閉、8/8 架構階段合併、12 條可安裝技能、515 個測試（514 通過 / 1 跳過，`npm test`）。生產例項：<https://pi-harness-gw.pages.dev>。

### 產品能力

- **Skill Hub 上線**：`skills/catalog.json` 收錄 12 條純提示詞技能（6 條內建 + 6 條外部），左欄市場支援篩選、審計詳情與一鍵安裝；安裝結果就地反饋，「試用」把 `/技能名 ` 寫進輸入框但不自動傳送。介面 `GET /api/skills/hub`、`POST /api/skills/import`（#40、#43、#46、#47、#49、#53、#64）。
- **分享即產出**：`share_file` / `share_conversation` 讓模型直接生成只讀連結，同一檔案複用未過期 token；分享頁帶目錄、四套主題、列印 / 存為 PDF、頁尾部署出口與演示頁只讀橫條；左欄「分享」面板可看開啟次數與全量清單，撤銷後原連結立即 404。介面 `POST /api/share`、`GET /api/shares/all`、`DELETE /api/shares/<token>`（#11、#27、#29、#30、#45）。
- **知識庫閉環**：支援檔案（PDF / DOCX / MD / TXT）與網頁匯入，按 source + 正文去重、正文變化原地替換；命中片段隨 assistant entry 落庫（`kbRefs`）並在訊息下方展示「參考資料」。介面 `POST /api/kb/ingest`、`GET /api/kb/prefetch`（#10、#14、#31、#33、#38）。
- **定時任務可編輯**：`PATCH /api/automations` 支援改名稱 / 提示詞 / 排程 / 會話；每行展示上次執行時間與 `ok` / `failed` / `deferred` 狀態，可跳轉產出（#60、#61、#62、#65、#66）。
- **前端一次取數**：`GET /api/bootstrap` 把 17 個只讀面板聚合成 1 個請求，首屏請求從 18 個降到 2 個（bootstrap + auth）；知識庫 / MCP / 技能改為互斥彈窗，≤720px 為全屏 sheet（#17、#20、#56）。
- **上手路徑**：空會話 3 張起步卡 + 設定內「部署自檢」（模型金鑰、供應商、知識庫檢索、分享域名、構建號）；登入頁可選「看一個真實對話」演示入口（#3、#9、#16）。

### 架構

- **8/8 階段合併**：階段 0a 版本化遷移器（#21）、0b `routes/` + `RequestContext` + `AppError`（#23）、階段 1 會話 / 檔案域（#24）、階段 2 知識庫域（#28）、階段 3 分享域且 `/s/*` 零 Harness（#41）、階段 4 設定 / 供應商 / MCP / 自動化 / 審批 / 問答 + R5 模組級狀態收口（#51）、階段 5 `/chat` 與 `/chat/stream` 合併提交路徑（#54）、階段 6 刪除 `sqlFacade` / `ensureTables` 相容層（#57）。
- **`src/worker.ts` 只留組合根**：鑑權、`SpikeAgent` / `UserRegistry`、Harness 生命週期與 `alarm`；業務按 `routes/` → `services/` → `repo/` 分層，路由層零 SQL（#24、#28、#41、#51、#54、#57）。
- **遷移可重試**：DDL 只出現在 `db/migrations.ts`，`worker.ts` 禁止 `CREATE TABLE` / `ALTER TABLE`；schema 到 v8（`automations.last_status`）（#21、#57、#65）。
- **文件同步**：架構地圖、ADR-0001、前端契約與 Skill Hub 契約隨階段更新（#13、#18、#25、#36、#50）。

### 安全與門禁

- **技能先審計再入庫**：`lib/skill-audit.ts` 按 M/L/C/I/S/X 規則掃描，prompt / JS / TS 通過；Python、shell、二進位制、宿主 API 與未宣告網路呼叫在寫庫前攔截，`blocked` 返回 422 且不落庫；模型側 `list_skills` / `load_skill` / `/技能名` 只接受非 blocked 技能（#36、#49）。
- **目錄與分層是 CI 硬門禁**：`npm run catalog:check` 校驗 catalog 無 blocked、sha256 與正文一致；`scripts/check-layering.sh` 禁止 `worker.ts` 出現 DDL、`src/worker/**` 出現 `sqlFacade` / `ensureTables` / `scope(`；PR 跑構建 + 全量測試（#4、#23、#49、#57）。
- **吊銷與刪除分離**：`DELETE /api/users?id=` 立即失效登入態與該使用者全部分享連結，資料預設保留並返回保留規模；`GET /api/users/export?id=` 可先留檔，`DELETE /api/users/data?id=&confirm=` 才不可逆清空；刪除會話級聯清理分享 / 檔案 / 計劃 / 審批 / 問題 / KB 旁路（#59）。
- **分享入口能力門禁**：介面未上線時左欄不渲染分享入口，避免點了才 404（#42）。

### 修復

- 長會話 `/api/entries` 500：`entry_kb_refs.getMany` 改用 `BETWEEN` 恆定 3 個繫結引數，不再撞 DO SQLite 每查詢 100 引數上限；補 120 條單測與 101 輪對話迴歸（#44）。
- 知識庫重建向量索引失敗：`markVectorized` / `chunksByIds` 的 `IN` 列表按 90 個 id 分批，500 條與預設 200 條重建用例通過（#63）。
- 本機 `.dev.vars` 讓 KB 引用測試 401：`tests/api/kb-refs.test.ts` 啟動時固定 `ACCESS_PASSWORD` 為空（#67）。

## 2026-10-22

### 統一錯誤契約：4 套 ApiError → AppError（NERE-79）
- `KbIngestError` / `SkillApiError` / `AutomationApiError` / `SettingsApiError`（以及審批、問答、提示模板、自定義工具的同類錯誤）全部繼承 `AppError`，保留 `code` / `details`；路由不再各自對映狀態碼
- `toResponse` 統一輸出 `{error, code, details?, retryable?}`；未知異常固定 500 + `code:"internal_error"`，只回傳 `message` 截斷、不帶 `Error:` 字首與堆疊
- 相容一個版本：`POST /api/kb/ingest` 保留 `ok:false` / `message`，`POST /api/skills/import` 保留 `ok:false` / `installed:false`，審批/問答/插話/目標/自定義工具保留 `ok:false`；HTTP 狀態碼與業務語義不變
- `scripts/check-layering.sh` 新增兩條硬約束：`src/worker/routes` 禁止 `String(err)`，禁止手寫 `Response.json({error…})` / `new Response(JSON.stringify({error…}))` 錯誤體（必須經 `toResponse`）
- 測試：`api/error-contract.test.ts` 覆蓋四條 ApiError 路徑（狀態碼與 code 一致、無內部異常文本）+ `unit/errors.test.ts` / `unit/http-context.test.ts` 斷言統一響應體

### 後端可靠 / 效能 P1：Harness 誤標 + 向量化截斷 + bootstrap 錯誤碼（NERE-78）
- `needsHarness` 收口：24 個只讀寫 SQL 的 method+path 改為 `false`（automations/files/kb/data 的 `/memories`/capabilities 的 `/capabilities`、`GET /mcp`）；`POST /goal` 仍為 `true`（`baselineTokens` 要讀 Harness 用量）。冷啟動首個 DO 請求打純 SQL 端點時 `/debug/harness` 的 `opens` 保持 0
- KB 入庫向量索引改為分批迴圈到該文件無剩餘（原先只建前 100 段）：入庫響應與 `GET /kb/status` 新增 `pending`，`vectorized` 回報該文件當前已建數；中途 AI 失敗保留已完成批次，剩餘量可輪詢或 `POST /kb/reindex` 續建
- `GET /api/bootstrap` 的 `errors` 只輸出穩定碼 `internal_error` / `unavailable`，異常原文（表名 / SQL）只進 `console.warn`；HTTP 狀態仍為 200
- 測試：`api/sql-cold.test.ts`（空 persist 冷啟動零 open）+ `unit/kb-service.test.ts`（300 段全建 / 中途失敗 pending）+ `unit/bootstrap.test.ts`（碼值與不洩漏）

### 定時任務上次執行結果落庫：`last_status`（NERE-68 2b）
- 遷移 v8 給 `automations` 加 `last_status TEXT`（`ok` / `failed` / `deferred`），老資料為 NULL，走 `ensureColumn` 冪等補列
- alarm 三條路徑各寫各的狀態：成功 `ok`、異常 `failed`（`console.warn` 保留）、會話忙 `deferred`；`deferred` 只推後 `next_run_at`，不動 `last_run_at`
- 執行迴圈從 `worker.ts` 收進 `automation-service.ts` 的 `runDueAutomations`：三態判定可單測，`worker.ts` 只注入 chat 埠
- `GET /api/automations` 與 `PATCH` 返回體的 `automation` 都帶 `last_status`（未知值收斂為 `null`）；bootstrap 的 `automations` 同步帶上
- 測試：`unit/automation-last-status.test.ts`（三態落庫 / 順延不覆蓋 / 檢視收斂）+ `unit/migrations.test.ts` v8 老庫補列 + `api/api.test.ts` 介面欄位斷言

### 知識庫重建向量索引支援大批次：`IN` 列表分批（NERE-66）
- `repo/kb-repo.ts` 的 `markVectorized` / `chunksByIds` 改用 `db/sql-batch.ts` 的 `chunkIds`（去重後每 90 個 id 一批）：SQLite-backed DO 每條查詢最多 100 個繫結引數，預設 200 / 上限 500 的重建批次原先會在 `IN (?,…)` 處失敗
- 設定頁「重建向量索引」不再報錯；`KB_VECTOR_BATCH` 預設值與檢索邏輯未改
- 測試：`unit/kb-service.test.ts` 的 SqlHandle 包裝按 DO 上限（100）拒絕超限繫結，新增 500 條 + 預設 200 條重建用例

### 定時任務可編輯：PATCH /api/automations 支援改名稱/提示詞/時間/會話（NERE-64）
- `PATCH /api/automations` 接受 `{id, name?, prompt?, schedule?, sessionId?, enabled?}`：只傳 `enabled` 時與舊啟停語義完全一致（啟用 → `next_run_at = now+60s`，停用不動）；帶編輯欄位時保留原 `next_run_at`，只有改 `schedule` 才按新排程重算（daily 按 UTC+8）
- 校驗與建立同口徑：名稱 1–40、提示詞 1–2000、daily `HH:MM`、interval 整數分鐘 ≥ 1；非法輸入 400 且原記錄不變，未知 id 404
- 響應 `{ok:true, automation:{id,name,prompt,schedule,sessionId,enabled,last_run_at,next_run_at}}`；路由只解析/狀態碼，校驗與 `nextRunAt` 在 `automation-service`，UPDATE 在 `automations-repo`；成功後 `alarmRuntime.schedule()` 重掛 alarm
- 測試：`unit/automation-patch.test.ts`（欄位組合 / next_run_at 重算 / 邊界）+ `api/api.test.ts`「定時任務編輯」（落庫、400 不落庫、啟停相容）

### 後端分層收口：刪除相容層，分層變成 CI 硬約束（NERE-34，階段 6）
- 刪除 `handleLegacyFetch`、`RequestContext.legacy()`、`sqlFacade` 代理、`scope()` / `agentScope`；`src/worker.ts` 2654 → **1165 行**，只剩鑑權、`SpikeAgent` / `UserRegistry` 組合根、Harness 生命週期與 `alarm`
- 12 個遺留路徑按域拆出：`routes/system.ts`（version/bootstrap/debug/kernel）、`routes/data.ts`（backup/restore/export/memories/reflect）、`routes/prompts.ts`（prompts/rules/custom-tools）；對應新增 `services/bootstrap|kernel|data|memory|reflect|prompts|context-service.ts` 與 `repo/memory|prompts-repo.ts`。`/backup`、`/restore`、`/export` 的 JSON 結構與狀態碼逐字不變
- 工具擴充套件遷到 `tools/spike-tools.ts`：SQL、設定、檔案/KB/分享服務、Harness、API Key 全部顯式注入，不再有模組級隱式儲存；擴充套件按請求構造並 install（pi-durable 按副檔名從登錄檔解析工具），`share_file` 的 Origin 來自當前請求
- `UserRegistry` 的 `users` 建表移入 `db/migrations.ts` 的 `migrateRegistry()`，DDL 只允許出現在遷移器
- `scripts/check-layering.sh` 新增兩條硬約束：`src/worker.ts` 禁止 `CREATE TABLE`/`ALTER TABLE`；`src/worker/**` 禁止 `sqlFacade`/`ensureTables`/`scope(`。`npm test` 414 passed（新增路由表凍結用例：20 個 method+path 全部命中，未知路徑仍 404）
- 文件：ADR-0001 §10 記錄收口；架構地圖模組清單改為最終佈局，R1/R4/R5/R11 全部關閉

### 對話提交路徑合併（NERE-33，階段 5）
- 新增 `services/chat-service.ts`：`prepare`（技能解析 → instructions → configure → beforeId）→ `submit`（submit → wait → commit → kbRefs）→ `finish`（標題 → 工具摘要）成為 `/chat` 與 `/chat/stream` 的唯一提交路徑；流式只額外負責 `watchEvents` 泵
- 新增 `routes/chat.ts`：`POST /chat`、`/chat/stream`、`/interject`、`/abort`、`/reset`、`/compact`；路由層零 SQL，SSE 事件名與順序不變（`thinking_start` / `thinking` / `text` / `tool_start` / `tool_end` / `compaction` / `goal` / `done`）
- 目標續轉、`activeChats` 併發閘門（現為 `ChatGate`）、反射節流與標題策略搬入 Service：`goalTick`/`syncGoalProgress`/`maybeReflect` 不再在 DO 重複實現；標題讀寫走 `repo/sessions-repo.ts`，反射進度走新增 `repo/reflect-repo.ts`
- Harness 的 open/重試、conversation、擴充套件裝配、`configure`、`watchEvents`、`reflect` 留在 DO 組合根，經 `ChatRuntime` 埠注入（`http/ports.ts`）
- 新增金標：同一輸入下流式與非流式返回相同 answer 且寫入相同的 `sessions_meta.title`（`tests/api/share-tools.test.ts`）

### 設定/供應商/MCP/自動化/審批/問答分層收口 + R5 全域性狀態（NERE-32）
- 後端五個域按 ADR-0001 拆分：路由 `routes/settings|automations|approvals|capabilities.ts` → 用例 `services/settings|automation|goal|plan|approval|question|mcp|custom-tool|capability-service.ts` → 倉儲 `repo/settings|providers|mcp|automations|goals|plans|approvals|questions|custom-tools|panels-repo.ts`
- `alarm()` 仍是 DO 入口並包 `agentScope.run`；到點篩選、下一次執行時間、忙時順延、目標續轉與 `nextAlarmAt` 判斷搬入 `automation-service`，Service 不依賴 DO 全域性
- 審批閘門讀取收口到 `approval-service`：三檔策略 + 逐工具覆蓋；扣 `uses` 與刪行仍是 `approvals-repo.consumeGrant` 的同一條 SQL 路徑，不引入讀-改-寫競態
- **R5 關閉**：`customToolNames` 與 `mcpCache` 從模組級搬入 `SpikeAgent` 例項欄位，`buildCustomToolsExtension(sql, names)` / `buildMcpExtension(sql, cache)` 顯式收快取；同 isolate 多使用者不再串用工具分級與 MCP 連線
- 端點契約不變：`/settings`、`/providers*`、`/models`、`/model`、`/context`、`/mcp`、`/automations*`、`/goal*`、`/plan`、`/approvals*`、`/questions*`、`/capabilities`、`/tools` 的響應與狀態碼逐字保留；備份/恢復對這些表的讀寫也改走倉儲
- 多使用者隔離用例：主人建立的 `owner_probe` 不出現在邀請使用者的 `/api/custom-tools` 與 `/api/tools`，其分級在主人側為 `exec`；單測用兩個集合/兩個快取驗證互不覆蓋
### 已安裝技能可見可用：執行時 / 審計 / 上次使用 + 試用（v0.62.0，NERE-59）
- 左欄「技能 → 已安裝」每行新增一行元資訊：執行時徽標（提示詞 / JS / TS）、審計結論（審計通過 / 有警告 / 不可安裝）、上次使用（剛剛 / N 分鐘前 / N 天前 / 從未）
- 新增「試用」按鈕：把 `/技能名 ` 寫進輸入框並把游標移到末尾，**不自動傳送**；手機端左欄是抽屜，點完自動回到聊天頁
- 從未使用且安裝滿 7 天的技能，卡片底部灰字提示「還沒用過。試試「試用」，或刪掉它保持面板清爽。」
- 沒有埋點資料（服務端不返回 `lastInvokedAt`）時這一行整行不渲染，不報錯、不顯示 0
- 首屏聚合的 `skills` 面板改用與 `GET /api/skills` 同一實現（`listCompat`），補齊 `runtime` / `auditStatus` / `lastInvokedAt`，避免左欄與介面口徑不一致

### Skill Hub 後端：目錄索引 / 審計引擎 / 能力准入 / 埋點（v0.61.0，NERE-55）
- 新增遷移 v6/v7：`skills` 增 `version/source/author/license/runtime/tags/content_hash/audit_status/audit_report/manifest/updated_at`（老庫回填 `prompt` / `pass` / `local` / `0.0.0`，正文不動、升級後可呼叫）；建 `skill_audits` 快取與 `skill_events` 埋點表（與分享計數無關）
- 新增純函式審計引擎 `lib/skill-audit.ts`：契約 §4 的 M/L/C/I/S/X 規則、去註釋/字串掃描、prompt 只掃 fence/shebang/命令列避免「Python 不受支援」誤傷；契約 §8 五個樣例的 `contentHash` 逐位元組對齊
- 新增 `GET /api/skills/hub`（構建期目錄快照 + 已安裝合併、篩選/排序/分頁、零抓取、`installed` 狀態）、`GET /api/skills/:name/audit`、`POST /api/skills/import`（URL 或 manifest+content，**先審計再入庫**，blocked → 422 且不寫庫，同名衝突 409 / `overwrite`）
- 准入：模型側技能索引、`list_skills`、`load_skill`、顯式 `/技能名` 呼叫只接受 `audit_status != 'blocked'`；`install_skill` 與 Hub 共用同一審計匯入通道
- 收口老入口：`GET /api/skills/community` 的 8 條固定 `blocked`（需要本地執行時，不再裸 INSERT）；`POST /api/skills/import` 的「抓下來裸 INSERT」刪除
- 埋點：`skill_hub_view / detail_view / import / blocked / install / loaded / invoked`，`GET /api/metrics/skill-hub?days=` 聚合 `hubViews / installOk / installBlocked / blockedRatio / installed / called7d`；`GET /api/skills` 每條新增 `lastInvokedAt`
- 目錄門禁：`npm run catalog:check` 校驗 `skills/catalog.json`（無 blocked、sha256 與正文一致、`audit.hash == contentHash`），CI 硬門禁；`npm run catalog` 重新生成

### 分享開啟計數 / 全量清單 / 撤銷（v0.60.0，NERE-42）
- `GET /s/<token>` 命中有效連結時累計 `openCount` 與 `lastOpenedAt`：同一 IP（`CF-Connecting-IP`，反代回落 `X-Forwarded-For` 首跳）1 小時內只計 1 次；IP 以 `SHA-256(token + IP)` 落庫，不存原始地址；未知/過期連結不計數
- 新增 `GET /api/shares/all?status=active|expired|all`（預設 `active`）：返回 `token/kind/name/expiresAt/theme/createdAt/openCount/lastOpenedAt/sessionId/url`，`url` 為相對路徑 `/s/<token>`
- 新增 `DELETE /api/shares/<token>`：立即刪行，原連結隨即 404；token 字首不屬於當前使用者時 403；不存在 404。路由改為通用 `/` 結尾字首匹配
- 新增遷移 v5：`shares` 補 `open_count` / `last_opened_at` / `opened_ip_hash`（`ensureColumn` 冪等，老庫補列、新庫由 v1 建表直接帶上）
- 單測覆蓋：同 IP 去重、換 IP / 過窗再計、過期與未知 token 不計數、狀態過濾、撤銷與越權 403、老庫遷移冪等

### 知識庫匯入去重與版本替換（v0.59.0，NERE-47）
- `POST /api/kb/ingest`（檔案與連結）、`POST /api/kb`、`kb_add` 統一按「source + 正文」查重：同來源同正文複用原 `docId`、不寫庫、不重建向量，響應 `updated:false`
- 同來源正文變化時原地替換：保留 `docId` 與 `created_at`，刪除舊分塊 / FTS / 向量後按新正文重建，`updated_at` 重新整理，響應 `updated:true`
- source 為空（貼上正文、工具未帶來源）不參與去重，避免不同資料互相覆蓋
- 新增遷移 v4：`kb_docs(source)` 索引；不新增表、不新增依賴，歷史重複文件不做破壞性清理
- 金標新增：同一 PDF 連導兩次仍 1 篇且 chunk 數不變、修改正文後同 docId 且舊句子檢索不到；單測覆蓋向量刪除與重建

### 分享域分層收口 + 分享頁零 Harness（NERE-31 / NERE-22）
- 後端分享域按 ADR-0001 拆為 `routes/share.ts` → `services/share-service.ts` → `repo/shares-repo.ts`，渲染純函式（`sharePage`、Markdown/目錄/主題/CSS）移入 `lib/share-render.ts`，entry 取值移入 `lib/entries.ts`
- `GET /s/<token>` 標 `needsHarness: false`：失效/過期 token 與檔案分享不再 `open()` Harness，只有會話分享命中 token 後才通過 `shareRuntime.entries()` 讀條目；路由層零 SQL，服務層零 `Response`
- `POST /api/share`、`GET /api/shares`、`/s/` 的響應與狀態碼逐字不變；列印按鈕與 `@media print`、頁尾 Deploy 出口、`DEMO_SHARE_URL` 只讀橫條原樣保留（`tests/unit/share-render.test.ts` 釘住）
- 新增測試觀測點 `GET /api/debug/harness`（僅 `TEST_HARNESS_STATS=1`）：`tests/api/share-cold.test.ts` 在空 persist 上以 `GET /s/<invalid>` 為首個 DO 請求，斷言 404 且 Harness `open()` 計數為 0

### 知識庫命中隨 assistant entry 落庫（v0.58.0，NERE-40）
- `GET /api/entries` 的 assistant entry 新增可選 `kbRefs: {docId, chunkId, chunkSeq, title, source?}[]`：本輪預檢索的命中與注入 instructions 的參考資料逐條對應；未命中或 `kb_prefetch` 關閉時不寫該欄位
- Harness 的 `pi.assistant` entry 不承載自定義欄位，命中落在旁路表 `entry_kb_refs(conversation_id, entry_id, refs, created_at)`；遷移 v3 建表，讀路徑在 session-service 合併，老會話無行時響應與遷移前一致
- 流式 `done` 事件透傳同一份 `kbRefs`（僅命中時），前端無需重新整理即可渲染「參考資料」
- 單測覆蓋：命中/未命中/多文件去重/老會話相容/壞 JSON 容錯；API 金標新增「久期」命中與「今天天氣」未命中的端到端驗收
- 修復長會話 500：`entry-kb-refs-repo.getMany` 改用 `entry_id BETWEEN ? AND ?`（恆定 3 個繫結引數），不再因 `/entries` 頁內 ≥100 條 assistant entry 撞 DO SQLite 每查詢 100 引數上限；新增 120 條單測與 101 輪對話的 API 迴歸（舊實現復現 500）
- 刪除會話時一併清理該會話的 `entry_kb_refs` 行；goal 續轉複用同一份 `kbRefs` 的語義補註釋

## 2026-10-23

### 修復登入後白屏（v0.54.3）
- 根因：React error #310。`handleSelectRailView` 這個 `useCallback` 位於登入閘門的 early return 之後
- 未登入首幀會跳過它，登入成功後同一組件多執行一個 hook → hooks 數量不一致 → 白屏
- 將該 hook 移到 early return 之前；所有 hooks 在元件頂層無條件執行
- 構建通過；598 條測試通過（1 skipped）

### 首屏聚合 `/api/bootstrap`（v0.57.0）
- 新增 `GET /api/bootstrap?sessionId=`：一次返回首屏 17 個只讀面板（會話/條目/檔案/記憶/審批/設定/計劃/目標/問答/模板/規則/自定義工具/技能/定時任務/MCP/模型）
- 後端把首屏 17 個只讀面板聚合成 1 個請求；前端切換後首屏為 bootstrap + auth 兩個請求（舊路徑 18 個）
- 邀請使用者對全域性 `UserRegistry` 的查詢從每面板一次降為每次聚合請求一次（舊路徑 17-18 次）
- 與單端點共用同一批讀取函式；單個面板失敗只回退該欄位（陣列 `[]` / 其它 `null`），`errors` 記錄原因，整體仍返回 200
- 非法 `sessionId` 返回 400；舊端點全部保留，前端可逐面板切換或整體回退
- 金標新增：聚合結果與單端點一致、空白會話預設值、非法 sessionId、單欄位故障隔離、邀請使用者登錄檔查詢計數

### 知識庫匯入通道（v0.56.0）
- 新增 `POST /api/kb/ingest`：`multipart/form-data` 上傳 PDF / DOCX / MD / TXT，或 JSON `{url}` 匯入網頁；複用 `kbAddDoc` 入庫、分塊、建索引，不引入解析庫與新儲存
- PDF / DOCX 走 Workers AI `toMarkdown()`；MD / TXT 直接讀文本，無 `AI` 繫結也能用
- 連結抓取複用 `web_fetch_page` 的 DeepSeek Fetch API，標題取頁面 `<title>`；`DEEPSEEK_BASE_URL` 可指向自建代理（預設官方地址）
- 失敗不靜默：413 `too_large` / 415 `unsupported_type` / 422 `empty_content` / 501 `ai_unavailable`；連結另有 400 `invalid_url`、502 `fetch_failed`
- 金標新增：PDF 解析 mock 路徑（RPC service binding 提供 `toMarkdown`）、連結匯入成功與失敗路徑、無 AI 繫結回退

### 分享工具化 + 分享頁署名（v0.55.0）
- 新增內建工具 `share_file(name, ttlSeconds?)` / `share_conversation(ttlSeconds?)`：模型可直接生成公開只讀連結，不再回答「做不到」
- 工具走 `write` 審批分級；同一檔案/對話已有未過期連結時複用 token，`/api/shares` 條目數不增；拒絕審批時提示「已取消分享」
- 工具結果帶結構化 details，聊天裡渲染成連結卡（標題 + 連結 + 複製 + 有效期），歷史回放同樣生效
- 系統提示補充：使用者說「分享 / 發我個連結 / 轉給同事」時主動呼叫分享工具
- 設定 → 對話新增「分享連結」：顯示署名 `displayName` 與模型分享預設有效期 `shareTtlSeconds`；`/api/share` 不傳 `ttlSeconds` 也使用該預設值
- 分享頁頁尾顯示作者署名與生成時間（`displayName` 未設定時回落 `π Harness`）
- 金標新增：分享工具註冊/寫入分級、預設有效期與頁尾署名、連結卡解析（成功/過期）；`tests/api/share-tools.test.ts` 用本地假 OpenAI 流式上游端到端覆蓋成功 / 複用 / 過期 / 審批拒絕；金標全綠

### 上手通道：空會話起步卡 + 設定內「部署自檢」（`1d7524c`）
- 空會話頁新增 3 張起步卡（寫週報並分享 / 存知識庫再提問 / 每日摘要定時任務），點選只把提示詞寫入輸入框，不直接傳送
- 設定 → 通用新增「部署自檢」：檢查模型金鑰、模型供應商、知識庫檢索、分享域名、線上構建號，失敗項給出修復命令
- 自檢只調用瀏覽器已能訪問的既有介面，不傳送聊天請求，也不讀取或展示金鑰
- 純前端改動，無 API 變更、無資料遷移

### 修復 deploy job 缺少前端構建（v0.54.2）
- PR #3 把 workflow 拆成 test / deploy 兩個 job 後，deploy job 只跑了 `npm ci`，沒有重新構建 `dist-web`
- wrangler 因 `assets.directory` 不存在而失敗；deploy job 補上 `npm run build:web`
- 測試 job 不受影響

### 向量檢索過濾回退（v0.54.1）
- Vectorize 查詢先按 `scope` 過濾；後設資料索引尚未生效時退化為無過濾查詢，再在 Worker 側按 scope 過濾
- 保證多使用者共享同一索引時不串資料，同時避免後設資料索引建立延遲導致向量檢索為空
- 生產實測：臨時文件「量子糾纏…」向量命中 score 0.797；臨時文件、向量與模式已清理
- 128 條金標全過

### 測試收尾競態 + 門戶面清理（v0.54.0）
- 修掉 `npm test` 本地跑不出一份全綠的根因：兩個 API 測試的 `afterAll` 先 `kill` 再立刻 `rmSync` persist 目錄，workerd 還在落盤 → `ENOTEMPTY`，vitest 記成「整個檔案失敗」，即使 128 條用例全部通過
- 新增 `tests/api/teardown.ts`：等 detached 程序組退出（SIGTERM → 5s → SIGKILL）後再刪目錄，刪不掉就重試；連續 3 次 `npm test` 均 exit 0 / 128 passed
- README 不再寫死測試條數：徽章換成 CI workflow 徽章（自更新），正文只描述測試方式
- 外對文案裡的「126 條」統一作廢（真實數一直是 128，v0.53.0 起如此）
- README 英文首頁補線上地址；中文首頁補 icon / 徽章 / 導航；工具數 27 → 24（按 `src/worker.ts` 實際註冊清點）

### 測試配置與 CI 修復（v0.53.1）
- 新增 `wrangler.test.jsonc`：測試專用配置，去掉 `AI` / `KB_VEC` 繫結
- 兩個 API 測試檔案改為 `wrangler dev --config wrangler.test.jsonc`，避免無憑證 CI 因遠端繫結啟動超時
- 開發配置繼續保留繫結；測試用 `CF_DISABLE_VECTOR=1` 驗證 FTS / 回退路徑
- 128 條金標全過

### 知識庫向量檢索（v0.53.0）
- 新增三檔檢索：關鍵詞（FTS5）/ 向量（Vectorize + bge-m3）/ 混合（RRF 融合）
- 設定 → 對話 → 「知識庫檢索」可切換；顯示已索引 / 總段數，支援重建向量索引
- 新增 `GET /api/kb/status`、`POST /api/kb/reindex`；`kb_add` 在向量模式下同步建索引
- 向量不可用或呼叫失敗時自動回退 FTS5；測試用 `CF_DISABLE_VECTOR=1` 強制關閉
- `wrangler.jsonc` 增加 `AI` 與 `KB_VEC` 繫結；已建立 `pi-kb` 索引（1024 維 / cosine）
- 金標新增 2 條，總計 **128 條**

### 獨立域名分享賣點 + 語義檢索方案（v0.52.0）
- README（英文首頁 / 中文副頁）把「檔案分享」升級為「走你自己 Cloudflare 域名的分享」：預設 `*.pages.dev`，可綁自定義域名
- 同步更新賣點文件、首發 thread、7 天文案裡的分享描述
- 新增 `docs/semantic-search-options.md`：當前未使用 Supabase；評估 pgvector 作為可選向量索引的架構、免費額度風險、與 Vectorize 的對比與落地順序
- 明確 Supabase 只做可重建的派生索引，不替換 DO 主儲存；預設 FTS5 不變

### 前 7 天逐日文案（v0.51.0）
- 新增 `marketing/06-seven-day-posts.md`：7 天 ×（X 英文 + 小紅書中文），含配圖路徑、置頂評論、標籤
- Day 1 首發 thread、Day 2 中文檢索、Day 3 檔案分享、Day 4 測試、Day 5 多使用者隔離、Day 6 成本、Day 7 求反饋
- 附 5 條通用回覆模板（伺服器 / 對比 ChatGPT / 小白 / 演示 / 為什麼不做 SaaS）
- 新增 `docs/architecture.png`（2000×720），便於直接上傳 X / 小紅書

### X / 小紅書流量計劃與素材（v0.50.0）
- 新增 `marketing/05-traffic-playbook.md`：14 天釋出日曆、四類內容支柱、鉤子寫法、釋出與互動規則、指標與迭代
- 新增 3 張小紅書封面（2160×2880）與分享彈窗 / 知識庫 / 全部檔案截圖
- 記錄 GitHub 流量基線（1 個獨立訪客、0 個外部來源）與每週 Traffic API 檢查命令
- 明確不做刷量/互贊，不使用「完全免費」或虛構案例

### README 重構：英文首頁 + 中文副頁（v0.49.0）
- 參考 magpie 的結構重寫首頁：圖示、標題、一句話、徽章、產品截圖、問題、賣點、快速開始、架構圖、部署、適用人群
- `README.md` 預設英文；完整中文文件移到 `README.zh-CN.md`，兩個頁面頂部互相切換
- 新增 `docs/icon.svg` 與 `docs/architecture.svg`
- 移除中文 README 裡原給英文讀者的摘要（由英文首頁承擔）
- 程式碼無改動

### 首發不設公開演示（v0.48.2）
- 決定首發只發倉庫 + 截圖，不做公開演示碼或只讀入口
- 同步更新 `marketing/03-launch-copy.md`：移除 `<demo>` 佔位與「線上試用」表述
- `marketing/04-demo-plan.md` 保留三種備選方案，等有真實案例再啟用
- 釋出前狀態：倉庫已 public、Social preview 已上傳、homepage 指向線上站點

### 公開演示方案（v0.48.1）
- 新增 `marketing/04-demo-plan.md`：演示邀請碼 / 錄屏 / 只讀模式三種方案與取捨
- 給出 45 秒錄屏分鏡與兩週釋出節奏；建議先發錄屏，演示碼只在私信/評論區補充
- 明確演示碼的計費風險與 DeepSeek 消費上限設定

### LICENSE、英文摘要、社交預覽（v0.48.0）
- 新增 MIT LICENSE（版權人 scudong）
- README 增加英文摘要，方便 X / GitHub 英文讀者快速理解
- 新增 `docs/social-preview.png`（1200×630）與 OG / Twitter Card 後設資料；站點 `/social-preview.png` 可直接訪問
- 核對倉庫與歷史記錄，沒有真實金鑰（只有文件佔位符 `sk-...` 與測試假金鑰）
- 剩餘：公開演示邀請碼、倉庫轉 public、在 GitHub 設定裡上傳社交預覽

### 命名調整：Cloudflare Free Web Pi（v0.47.1）
- 倉庫名改為 `cloudflare-free-web-pi`（v0.47.0 的 `cloudflare-free-pi-agent` 已被替換，GitHub 舊連結 301）
- README / 頁面 title / 頂欄 / worker 指令 / CI 倉庫守衛同步改為 Web Pi
- 重新生成 README 截圖，頂欄顯示 **Free Web Pi**
- 命名依據：Cloudflare + Free + Web + Pi 四個詞完整可搜；GitHub / npm 均無同名

### 倉庫改名 Cloudflare Free Pi Agent（v0.47.0）
- GitHub 倉庫：`scudong/pi-harness` → `scudong/cloudflare-free-pi-agent`（GitHub 會自動 301 舊連結）
- README 標題、頁面 `<title>` / description、頂欄品牌同步改為 **Cloudflare Free Pi Agent / Free Pi Agent**
- CI 的倉庫守衛、worker 指令裡的倉庫引用同步更新
- README 增加 Cloudflare 商標宣告（非官方專案）
- 保持不變：Worker 名 `pi-harness-spike`、pages.dev 域名、DO 資料、cookie 簽名與 localStorage 鍵

### 推廣素材與命名建議（v0.46.3）
- 新增 `marketing/` 目錄：一句話定位、8 個核心賣點、技術亮點、與常見方案的形態對比、目標人群、常見異議
- 命名調研：推薦 `pi-station`（π 空間站），備選 `pi-harbor`（π 港灣）；附 GitHub/npm 撞名檢索結果與改名清單
- 渠道文案：X 英文 thread / 短版中英文、小紅書 3 篇（個人網站 / 團隊空間 / 檔案分享）
- 釋出前清單：LICENSE、公開演示、README 英文摘要、社交預覽圖、GitHub Description / Topics
- 程式碼無改動；`.gitignore` 補上 `tests/.tmp-state*/`

## 2026-10-20（多使用者）

### README 截圖更新（v0.46.2）
- 換成當前介面：淺色主題、左側工具欄（含「全部檔案」「知識庫」）、輸入框上方的模型 / 思考 / 上下文控制、右側 Markdown 預覽
- 截圖來自本地演示會話（久期說明 + `duration.md`），不含真實資料；尺寸與舊圖一致（1500×940）

### 輸入框字號 + 會話失敗自愈（v0.46.1）
- 聊天輸入框（Composer）在桌面端從 16px 調到 15px，與訊息正文一致；移動端保持 16px，避免 iOS 聚焦時自動放大頁面
- 修復：部署或儲存中斷後 pi-durable 進入 `SessionFailed`，`/api/sessions` 持續 500，必須重啟 DO 才能恢復
- 現在 `root` / `conversation` / `newSession` 遇到 `SessionFailed | storage error` 會自動 `close + reopen` 並重試一次，會話列表與除錯介面自愈

### 知識庫每輪預檢索（v0.46.0）
- 每輪發送前用使用者訊息檢索知識庫，命中時把前 3 段（每段 ≤600 字）作為「知識庫參考資料」注入本輪 instructions；沒命中不增加內容
- 預設開啟；設定 → 對話 → 「知識庫預檢索」可關閉，關閉後模型仍可主動呼叫 `kb_search`
- 檢索先按 AND、全空退回 OR，並過濾「怎麼 / 什麼 / 如何」等口語停用詞，自然語言問句也能命中
- 預檢索在 `buildInstructions` 末尾拼接，位於顯式技能正文之後、使用者訊息之前
- 新增 `GET /api/kb/prefetch?q=` 預覽本輪注入內容；`/api/debug/agent?message=` 返回本輪完整 instructions
- 冒煙新增預檢索介面檢查；金標新增 3 條，總計 **126 條**

### 使用者知識庫 + 全部檔案總覽（v0.45.0）

**知識庫（每人獨立）**
- 每人一個獨立知識庫：文件、分塊與索引都存在自己的 DO SQLite，邀請使用者之間、與主人之間互不可見
- 檢索用 FTS5 + `bm25`；中文按重疊二元組索引（「知識庫」→ 知識/識庫），兩字詞也能命中；單字查詢退回 `LIKE`
- 自動分段：按空行聚合約 800 字，超長段落 720 字步長切分並留 80 字重疊；單篇上限 20 萬字符
- 新工具：`kb_search`（讀）、`kb_add`（寫）、`kb_list`（讀）、`kb_delete`（寫，參與審批分級）
- 提示詞明確：涉及使用者資料先 `kb_search`，使用者說「存到知識庫」用 `kb_add`，工作臺檔案不會被檢索
- 左欄新增「知識庫」：檢索、貼上正文入庫、檢視全文、刪除；空庫與結果為空都有引導
- 新介面：`GET/POST/DELETE /api/kb`、`GET /api/kb/doc`、`GET /api/kb/search`
- 備份新增 `kbDocs`（只含正文）；恢復時重新分塊並重建索引
- 設計 / 方案調研記錄見 `docs/knowledge-base.md`

**全部檔案（跨會話）**
- 左欄新增「全部檔案」：彙總當前使用者所有會話產出的檔案，顯示所屬會話、大小與時間
- 支援按檔名 / 會話名篩選；點選檔案自動切到所屬會話並在右欄開啟
- 可在列表內直接刪除（同步重新整理右欄工作臺與會話列表）
- 新介面 `GET /api/files/all?q=`：返回 `sessionId / name / size / updatedAt / sessionTitle`
- 修復跨會話開啟時「檔案不存在」守衛誤關檔案（新增 `filesForSession` 判斷）

**測試**
- 新增知識庫金標 8 條、全部檔案 3 條、多使用者隔離 5 條（獨立跑帶密碼的 wrangler dev，驗證知識庫與檔案互不可見、普通使用者不能管理使用者、刪除使用者後 401）
- 總計 **123 條**

### 分享連結自動帶主題引數（v0.44.1）
- 複製 / 在新視窗開啟分享連結時，自動追加 `?theme=<當前主題>`（深色 / 淺色 / 米黃 / 午夜藍）
- 舊的分享 token 仍可複用；重新開啟分享彈窗複製一次，連結就會跟隨當前主題
- 分享頁仍保留 `?theme=` 覆蓋與服務端記錄的主題
- 金標新增 1 條，總計 **107 條**

### 模型可以自己安裝技能（v0.44.0）
- 新工具 `install_skill({ url, name? })`：抓取 SKILL.md、解析 frontmatter、寫入當前使用者的技能庫（同名覆蓋）
- GitHub blob 連結自動轉 raw；相容「入口 stub」：`Call the Skill tool with "x"` 自動改寫為 `load_skill("x")`
- 按「寫入級」參與工具審批；工具名加入內建保留名
- 提示詞明確：使用者給 SKILL.md 連結時用 `install_skill`，不要往工作臺寫技能檔案（工作臺檔案不會被註冊）
- 冒煙與金標補充工具註冊斷言，總計 **106 條**

### 新使用者登入後重新整理資料（v0.43.2）
- 修復：登入頁階段面板已經用無 cookie 狀態請求過一次，401 結果被快取；新使用者登入後技能 / MCP / 定時 / 檔案 / 歷史都顯示「載入失敗」
- 登入成功後整頁過載，所有資料用新 cookie 重新載入；同時清掉上一賬號的殘留狀態

### 首次進入預設淺色（v0.43.1）
- 未儲存過主題時預設淺色（之前是深色）；已儲存的主題與 `?theme=` 引數不變
- 首屏內聯指令碼同步改為淺色，避免先深後淺的閃爍
- 「跟隨系統」仍按系統偏好解析

### 邀請碼 + 獨立空間 + 使用者管理頁（v0.43.0）
- 登入頁改為「訪問密碼或邀請碼」：主人密碼行為不變，舊 cookie 繼續有效
- 每個邀請碼對應一個獨立的 Durable Object：會話、檔案、記憶、設定完全隔離
- 左側導航新增「使用者」（僅主人）：生成邀請碼、複製、重置、刪除；碼只在生成時顯示一次
- 邀請碼 16 位無歧義字元（去掉 0/1/l/o），庫裡只存 SHA-256 雜湊與尾號
- 刪除使用者後其 cookie 立即失效（每次請求校驗登錄檔）；空間資料保留但無法再登入
- 分享連結帶使用者字首（`u_xxx.token`），按字首路由到對應空間；舊連結仍指向主人空間
- 修復：同一 isolate 承載多個 DO 時模組級 SQL / Harness 串資料（改用 AsyncLocalStorage 請求作用域）
- 安全：`/agent/*` 也納入登入校驗
- 新增 `UserRegistry` DO（遷移 v2）與 `GET/POST/DELETE /api/users`、`POST /api/users/reset`
- 金標新增 4 條，總計 **106 條**

### 輸入框上方的模型 / 思考 / 上下文控制（v0.42.0）
- 聊天頭部不再顯示模型選擇；模型與思考等級移到輸入框上方右側
- 新增思考等級下拉（不思考 / 低思考 / 高思考），寫入全域性設定
- 新增上下文佔用條：百分比 + 已用 / 視窗（估算：最近一次模型用量 + 之後新增內容按字元折算）
- 新增「壓縮」按鈕：確認後呼叫手動壓縮，15 秒內輪詢重新整理佔用
- 新增 `GET /api/context?sessionId=`，返回 `{ usedTokens, contextWindow, percent, approximate }`
- 金標新增 1 條，總計 **102 條**

### 分享頁標題目錄（v0.41.0）
- Markdown 分享頁自動生成目錄（h1–h4），點選跳到對應標題
- 標題自動加錨點 id：保留中英文與數字，重複標題加序號（`重複` / `重複-2`）
- 少於兩個標題不顯示目錄；最多列出 60 條
- 寬屏目錄固定在左側隨頁滾動，窄屏收到正文上方（最高 40vh）
- 對話分享裡的標題也會彙總進目錄
- 金標新增 1 條，總計 **101 條**

### 輸入框高度可調 + 分享連結複用（v0.40.0）
- 訊息輸入框頂部新增拖動手柄：上下拖動調整高度（44–480px，不超過視口 60%）
- 雙擊手柄恢復內容自適應；聚焦手柄時可用 ↑/↓ 每次調 16px
- 高度記在 `localStorage`（`pi-harness.composer-height`），重新整理與重啟後保持
- 手動高度下內容超出時輸入框內部滾動，不再擠壓聊天區
- 桌面與移動端都可拖，觸控時不會帶動頁面滾動
- **分享連結複用**：開啟檔案分享彈窗時讀取已有連結並直接展示，不再每次生成新 token；設定裡的「分享當前會話」同樣先複用
- 調整有效期後點「重新生成連結」才會建立新連結；已過期連結自動過濾
- 新增 `GET /api/shares?sessionId=&kind=file|conversation&name=`，返回未過期的分享連結
- 金標新增 3 條，總計 **100 條**

### 分享頁跟隨原主題（v0.39.1）
- 生成分享連結時把當前主題（深色 / 淺色 / 米黃 / 午夜藍）記入 `shares.theme`，Markdown 與對話分享頁按同一套 Arco 配色渲染
- 分享頁改用 CSS 變數（`--bg` / `--panel` / `--border` / `--fg` / `--accent`），不再寫死深藍色
- 支援 `?theme=light|sepia|midnight` 臨時覆蓋；老連結預設深色
- HTML 檔案分享仍原樣輸出（產物自帶樣式）
- 金標新增 1 條，總計 **97 條**

### 全站圖示統一（v0.39.0）
- 引入 `lucide-react`（按需 tree-shake），新增 `components/Icon.tsx` 語義圖標表：統一線性風格、1.75 描邊、`currentColor`，顏色沿用 slate / sky / emerald / amber / violet 色系
- 替換範圍：左側導航與會話欄、聊天頭部與目標/審批/問答條、工具呼叫與思考塊、計劃卡片、檔案卡與工作臺、設定彈窗五個 tab、分享彈窗、移動端底欄、Markdown 任務列表
- 去掉 emoji 圖示（🗑 ⚙️ 🎯 💬 🔗 📄 等），同類操作只用一種圖示：刪除統一垃圾桶、收起統一雙箭頭、設定統一齒輪、檔案統一文件、分享統一連結
- 主題選擇器改用 Moon / Sun / Scroll / MoonStar，與主題語義對應
- 淺色 / 米黃主題下圖示隨文字色自動適配
- 依賴新增：`lucide-react ^1.59.0`（構建產物 +23 KB raw / +7.6 KB gzip）

### 金標
- 更新 1 條（Markdown 任務列表改為斷言圖示名），總計 **96 條**

### 分享彈窗新增「在新視窗開啟」（v0.38.2）
- 生成連結後可直接在新標籤頁開啟，不用先複製
- 用普通 `<a target="_blank" rel="noopener noreferrer">`，不受彈窗攔截影響

### 分享連結改用當前域名（v0.38.1）
- 修復：通過 pages.dev 反代訪問時，服務端 `request.url` 是上游 workers.dev 地址，生成的連結在國內打不開
- 前端統一用 `window.location.origin + /s/<token>`（`shareUrlFor`），檔案分享與會話分享都走這條邏輯
- 已生成的連結不用重建：把域名換成 `https://pi-harness-gw.pages.dev` 即可開啟
- 金標新增 2 條，總計 **96 條**

### Markdown / HTML 檔案分享 + 有效期（v0.38.0）
- 工作臺開啟 `.md` / `.html` 檔案時，標題欄出現 🔗：選有效期（1 小時 / 1 天 / 7 天 / 30 天 / 永久）→ 生成連結 → 複製
- 連結帶域名字首（服務端用請求自身的 origin 拼），拿到連結的人**無需登入**即可開啟
- Markdown：服務端渲染成完整分享頁（標題 / 列表 / 程式碼塊 / 引用 / 表格 / 任務項），手機可直接閱讀
- HTML：原樣輸出，可互動；響應頭帶 `Content-Security-Policy: sandbox allow-scripts`，產物落在不透明源，讀不到本站 cookie / Storage
- 過期：`shares.expires_at`（0 = 永久），過期頁返回 **410** 並顯示失效時間；建立新連結時順手清理過期記錄
- 會話分享介面同樣接受 `ttlSeconds`；舊連結（無過期欄位）行為不變，頁尾顯示「連結有效期至 …」
- `POST /api/share` 新增 `kind=file`、`name`、`ttlSeconds`；響應返回絕對 `url` 與 `expiresAt`
- 分享頁統一 `noindex` / `no-referrer` / `X-Content-Type-Options: nosniff`

### 金標
- 新增 5 條（Markdown 渲染 / HTML + CSP / 過期 410 / 檔案不存在 400 / 未知 token 404），總計 **94 條**

## 2026-10-20（冒煙接入 CI）

### 部署後自動冒煙 + 每 6 小時巡檢（v0.37.2）
- `deploy.yml` 在 `wrangler deploy` 之後加一步：輪詢 `/api/version` 等 DO 換到本次構建（最多 6 分鐘），然後 `npm run smoke -- --deep`
- 新增 `smoke.yml`：每 6 小時 + 手動觸發跑一次線上冒煙，抓「部署幾天後才壞」的問題
- 密碼走倉庫 secret `SMOKE_PASSWORD`（已配置）；未配置時自動跳過而不是失敗
- 冒煙指令碼的 `--deep` 會清掉自己建立的會話，不在側欄堆積

## 2026-10-20（線上冒煙測試）

### npm run smoke：部署後一條命令驗收（v0.37.1）
- `scripts/smoke.mjs`：登入 → 打 10 個關鍵介面 → 逐項斷言（首頁 / 版本 / 能力登錄檔 / 工具清單 / 核心版本 / 會話 / 設定 / 待答問題 / 待審批 / 自定義工具）
- `--deep` 額外跑一次真實對話，斷言 **codemode 實際執行成功**——專門防「介面都通但工具壞了」這類迴歸（審批那次就是這種）
- 密碼從 `PI_PASSWORD` 或 macOS 鑰匙串讀，站點可 `PI_BASE` 覆蓋；失敗退出碼 1

### 金標
- 冒煙指令碼本身不佔金標用例（它打線上，不進 CI 單測）

## 2026-10-20（互動式問答卡片）

### ask_user：把「問你幾個問題」變成可點的卡片（v0.37.0）
- 新工具 `ask_user`：一次問 1–6 題，每題可帶選項（`recommended: true` 標推薦）與自由輸入
- 提問記錄進 `questions` 表，工具返回「已提交，等待回答」，本輪結束
- 聊天輸入框上方渲染**問答卡片**：題號、選項單選、推薦徽標、自由輸入框、提交按鈕
- 提交後服務端生成結構化回報（`- q1「問題」：答案`）並自動發回模型繼續，不用手動重述
- `GET /api/questions`、`POST /api/questions {id, answers}`
- **與目標模式聯動**：有待回答問題時會暫停自動續轉（請求內與 alarm 兩條路徑都處理），答完再繼續
- 系統提示里加了使用指引：需要使用者決策時用 ask_user，而不是在正文裡羅列問題
- 實測：兩題卡片選中「老闆 / 要」→ 提交 → 模型據此確認報告定位並繼續

### 金標
- 新增 4 條（空列表 / 缺 id / 不存在 / 工具註冊），總計 **89 條**

## 2026-10-20（自定義工具 + 專案身份）

### 使用者貼 JS 即成為工具（v0.36.0）
- **`custom_tools` 表**：工具名 / 描述 / 引數 JSON Schema / 程式碼；`GET/POST/DELETE /api/custom-tools`
- **執行在 QuickJS 沙箱**（複用 codemode 的內聯沙箱，32 MB 記憶體、15 秒超時）：程式碼是函式體，`args` 是入參，返回值即工具結果；返回值自動 JSON 序列化
- **註冊時機**：與 MCP 一樣在 `Harness.open` 之前構建並 `registry.install`，每輪 `configure()` 帶上 → 新工具對已有會話也生效
- **安全**：自定義工具歸 **exec** 級，預設跟隨工具審批策略；引數 schema 必須是 `{"type":"object"}`；工具名不能覆蓋內建工具
- **介面**：能力面板新增「🧩 自定義工具」摺疊區，含名稱/描述/schema/程式碼表單與刪除
- 實測：新增 `word_count` → 模型呼叫 → 返回 `{"chars":15,"words":3}`

### 專案身份寫進 instructions
- 系統提示裡明確「你在 scudong/pi-harness」，避免與 GitHub 上同名專案（如 wangmiaozero/pi-harness）混淆

### 金標
- 新增 5 條（非法名 / 內建名 / schema 非物件 / 空程式碼 / 增刪與分級），總計 **85 條**

## 2026-10-20（pi 核心版本管理）

### 核心版本可見 + 手動/自動升級 + 相容性門禁（v0.35.0）
- **執行時可見**：`GET /api/kernel` 返回四個核心包（pi-durable / pi-ai / pi-mcp / pi-codemode）的宣告版本、npm 最新版本、是否可升級；最新版本快取 6 小時，`?refresh=1` 強刷
- **設定 → 通用 → pi 核心**：顯示每個包的版本，發現新版本時標黃並給出升級路徑，帶「檢查更新」按鈕
- **手動升級**：`npm run upgrade:pi`（`scripts/upgrade-pi.mjs`）——查最新版 → 安裝 → `build:web` → 全部金標 → `wrangler deploy --dry-run` 打包校驗；**任何一步失敗自動回滾 package.json / package-lock.json**
- **自動升級**：`.github/workflows/pi-upgrade.yml`，每週一 09:00 UTC 檢查，有更新就開 PR（也可在 Actions 手動觸發）；PR 合併後走既有部署流水線
- **相容性**：升級指令碼把「構建 + 80 條金標 + Workers 打包校驗」作為硬門禁；`tests/unit/kernel.test.ts` 額外守住四個包版本鎖步、升級入口與工作流存在
- 順帶把 `@earendil-works/pi-codemode` 顯式寫進 dependencies（此前是傳遞依賴但直接 import）

### 金標
- 新增 4 條（核心包宣告 / 版本鎖步 / 升級入口 / 指令碼與工作流存在），總計 **80 條**

## 2026-10-20（生成中插話）

### 流式插話：生成中補一句話（v0.34.0）
- 後端 `POST /api/interject {sessionId, message}`：用 pi-durable 的 `submit(..., {whenBusy:"steer"})` 提交
- steer 輸入在**下一個邊界**（通常是下一次工具呼叫之後）被放進本輪，不打斷當前生成；會話空閒時等同普通傳送
- 輸入框在生成中顯示「插話」按鈕（有文字時才出現），Enter 也走插話；停止按鈕保留
- 插話立即以使用者氣泡顯示，隨後一條提示「已插入本輪：模型會在下一次工具呼叫後看到」
- 實測：長任務生成中插入「最終回答最後一行必須是『收到插話 v0.34』」，轉錄裡出現兩條 `pi.user`，模型繼續跑完

### 金標
- 新增 1 條（空插話被拒絕），總計 **76 條**

## 2026-10-20（修復 codemode 迴歸）

### 修：審批包裝漏傳第三個引數導致 codemode 報 abortSignal 錯誤（v0.33.1）
- 原因：`withApproval()` 只轉發了 `(args, api)`，而工具 `execute` 的第三個引數是呼叫上下文（含 `abortSignal`），codemode 在初始化時讀它 → `Cannot read properties of undefined (reading 'abortSignal')`
- 修復：包裝層改為 `(...rest)` 原樣轉發全部引數
- 加上回歸驗證：本地實測 codemode `123*456 = 56088`

## 2026-10-20（工具審批）

### read / write / exec 三檔審批 + 逐工具覆蓋（v0.33.0）
- 工具按三檔分級：**讀取**（read_file / web_search / recall / update_plan…）、**寫入**（write_file / remember / MCP 工具）、**執行**（codemode / dispatch_tasks）
- 每檔三種策略：**放行**（預設，行為不變）/ **詢問**（聊天裡出現待審批條）/ **禁止**（直接拒絕並提示去設定裡改）
- **待審批條**（輸入框上方）：顯示工具名、級別、引數預覽，三個按鈕「允許一次 / 始終允許 / 拒絕」；決定後自動把結果告訴模型讓它繼續（拒絕則讓它改方案）
- **逐工具覆蓋**：設定 → 對話 → 工具審批，16+ 個內建與 MCP 工具各有一個「跟隨分級 / 放行 / 詢問 / 禁止」下拉
- 審批閘門套在 `spike` / `codemode` / `tool-search` / `mcp` 四類擴充套件的 execute 外面，codemode 腳本里巢狀呼叫的工具同樣受控
- 子代理會話（側欄不可見）自動放行，避免子任務卡在沒人能點的審批上
- `GET /api/approvals`、`POST /api/approvals {id, action}`、`GET /api/tools`；能力登錄檔新增「工具審批」
- 實測：寫=詢問 → 模型提交審批（#1）→ 允許一次 → 自動續跑 → 檔案落盤；執行=詢問 → codemode 同樣被攔下並記錄引數

### 金標
- 新增 5 條（分級對映、策略跟隨、逐工具覆蓋優先、非法決定、空列表），總計 **75 條**

## 2026-10-20（會話分支 + 面板伸縮）

### 會話分支：從任意訊息分叉（v0.32.0）
- `POST /api/branches {sessionId, entryId}` → 調 pi-durable 的 `conversation.fork(at)`，新會話**繼承分叉點之前的全部歷史**，之後各自追加互不影響
- 分叉點取「這條訊息的**前一條**」：新會話歷史停在上一條，可以直接換個問法，不會把原問題再答一遍
- `sessions_meta` 新增 `parent_id` / `fork_at`，`GET /api/sessions` 一併返回
- 聊天裡使用者訊息懸停出現「⑂ 分支」按鈕（第一條訊息沒有歷史，不顯示）
- 側欄按分支關係渲染成樹：子會話縮排 + ⑂ 圖示；父會話被刪時子會話自動回到頂層
- 會話標題預設 `⑂ 父會話標題`

### 面板伸縮（v0.32.0）
- **會話欄可拖拽調寬**：拖右側分隔條，範圍 200px ~ 視口 45%，寬度記在 `localStorage`（`pi-left-width`）
- **左欄收起 / 展開**：會話欄、連線、定時、能力四個面板標題欄都有「«」；收起後聊天頂欄左側出現「»」展開
- **工作臺收起 / 展開**：檔案列表與檔案預覽標題欄都有「»」；收起後聊天頂欄右側出現「«」展開
- 拖拽寬度在 `pointerup` 時以最後一次拖動的值為準，避免快速拖動丟掉最終位置

### 金標
- 新增 8 條（分支樹 6 條 + 分支 API 2 條），總計 **70 條**

## 2026-10-19（HTML 預覽高度修復）

### 修：HTML 檔案預覽只佔視窗一半（v0.31.1）
- 原因：iframe 的 `h-full` 依賴父級有確定高度，而包裹層高度是 auto（由內容撐開）→ 百分比失效，回落到預設高度
- 修復：HTML 預覽時給包裹層補 `h-full`，高度鏈「滾動容器 → 包裹層 → iframe」打通，iframe 鋪滿右欄
- 本地 1440×900 實測：demo.html 預覽從半屏變為整屏

## 2026-10-19（目標模式 + 壓縮收尾）

### 目標模式：目標 + token 預算 + 自動續轉 + 完成硬校驗（v0.31.0）
- **一個會話一個目標**（`goals` 表）：目標描述、token 預算（預設 20 萬）、最大續轉輪次（預設 12）
- **自動續轉**：每輪結束後若目標仍在進行，自動提交「繼續推進目標」提示並接著跑
  - 單次請求內最多續轉 3 輪（`GOAL_ROUNDS_PER_REQUEST`），剩下的交給 DO alarm 跨請求接續（15 秒後）
  - 每次續轉前端都能看到新的助手氣泡 + 「🎯 繼續推進目標（第 N 輪）」提示，不是黑盒
- **token 記賬**：讀 `pi.usage` 會話賬本（models + tools 兩個桶），按目標建立時的基線算增量
- **完成硬校驗** `complete_goal`：必須給 ≥10 字的驗證證據；如果 `update_plan` 裡還有未完成步驟會**被拒絕**
- **受阻出口** `report_goal`：模型說明缺什麼、狀態轉 blocked、停止續轉
- 預算或輪次用盡 → 狀態 `exhausted`，自動收尾不再續轉
- **介面**：
  - 聊天頂欄新增「🎯 目標」按鈕 → 彈窗填寫目標 / 預算 / 輪次，點開始後立刻發第一輪
  - 輸入框上方常駐**目標條**：狀態、第幾輪、token 進度條、停止 / 新目標
  - SSE 新增 `goal` 幀（continuing / finished / scheduled）
- `GET/POST/DELETE /api/goal`；備份恢復納入 `goals`；刪除會話時目標自動暫停
- 實測（本地 + 真實模型）：單輪目標 1 輪完成並給出證據；三階段目標 3 輪完成（`turns=2`、25,874 tokens）；`maxTurns=1` 正確進入 `exhausted`

### 壓縮收尾：聊天提示 + 手動壓縮（補完 P0）
- SSE `compaction` 幀渲染成聊天提示：開始「上下文較長，正在壓縮更早的內容…」→ 結束「上下文已壓縮」
- 歷史回放：`pi.compaction` 條目解析成一條系統提示，重新整理後仍能看到
- 設定 → 對話 →「立即壓縮當前會話」按鈕（`POST /api/compact`），完成後回顯

### 金標
- 新增 5 條：目標模式 CRUD（空目標拒絕 / 建立→讀取→停止 / 覆蓋）、`pi.compaction` 解析、目標工具註冊防迴歸，總計 **62 條**

## 2026-10-19（能力登錄檔 + 提示模板 + 規則 + 壓縮配置）

### 三類能力統一註冊，資料型能力可執行時載入（v0.30.0）
- **能力登錄檔** `GET /api/capabilities`：把能力分三組彙總成一張表
  - **內建**（編譯進 bundle，靠 `registry.install`）：Code Mode、工具搜尋、上下文壓縮、計劃清單、子代理、聯網搜尋
  - **資料**（執行時從 DO 載入）：技能、提示模板、規則檔案
  - **協議**（執行時配置）：MCP 伺服器、模型供應商
- **提示模板**（`prompts` 表 + CRUD）：輸入框打 `/` 與技能一起出現在選單（⚡ 技能 / 📝 模板）；選中模板會把**正文填進輸入框**而不是發 `/名字`
  - `lib/template.ts` 支援 `$1..$9`、`$@` / `$ARGUMENTS` 佔位符，缺參時保留佔位符
- **規則檔案**（`rules` 表 + CRUD + 啟用開關）：啟用的規則每輪以「## 專案規則（必須遵守）」注入 instructions
- 左側工具欄「技能」更名「**能力**」，面板內新增「📝 提示模板」「📏 規則」兩個摺疊區（含新增表單、逐條刪除、規則啟用勾選）
- **上下文壓縮可配置**：設定 → 對話 新增「上下文壓縮」——開關 + 保留原文 tokens + 預留回答 tokens；改動後重建 Harness 下一輪生效
- `POST /api/compact` 手動觸發壓縮（v0.30.0 介面先行，UI 按鈕後續接）
- 備份/恢復納入 `prompts` 與 `rules`
- 金標新增 10 條（模板展開、模板 CRUD、規則 CRUD + 開關、能力登錄檔結構、計數跟隨），總計 **57 條**

## 2026-10-19（子代理編排）

### dispatch_tasks：可並行的子代理（v0.29.0）
- 新工具 `dispatch_tasks`：把 2–4 個**互不依賴**的子任務並行分派給子代理，各自獨立完成後彙總
- 每個子代理是一個獨立會話（不影響主對話上下文），只用**只讀類工具**（now / recall / read_file / list_files / http_fetch / web_search / web_fetch_page / codemode），避免併發寫檔案或記憶
- 子代理會話在 `sessions_meta.hidden = 1`，**不出現在側欄**；標題形如「子代理 1：查 Deno 版本」，可在備份裡看到
- 提示詞裡告訴模型：有 2–4 個可並行的獨立任務時優先用 `dispatch_tasks`
- 聊天裡渲染成一條綠色 pill：徽標顯示「N 個子代理」，展開先列子任務標題，再按 Markdown 渲染彙總結果（歷史回放同樣生效——從結果首部反解標題）
- 實測：兩個子任務並行（2.8s / 17.0s）各自查到 Deno v2.9.7 與 Bun v1.4.3 並正確彙總
- 同時補了 3 條金標：工具登錄檔防迴歸（`/api/debug/agent` 必須含 dispatch_tasks 等 8 個工具）、codemode 可呼叫工具清單、子任務標題反解

## 2026-10-19（金標迴歸測試體系）

### 每個功能配金標用例，CI 卡門禁（v0.28.0）
- 引入 **Vitest**，新增 44 條確定性用例，`npm test` 一條命令全跑（約 3 秒）
- **單元金標**（30 條，純函式，毫秒級）：
  - `rich.test.tsx`：Markdown 標題/表格（含「分隔行不入資料行」）/ 任務列表 / 巢狀列表 / 程式碼塊 props / HTML 與 `javascript:` 連結的 XSS 防護 / 行內格式
  - `entries.test.ts`：轉錄倒序自動反轉、思考塊提取、工具歸屬、`write_file` 檔案產出、空輸入與未知 kind 容錯
  - `theme.test.ts`：四套主題登錄檔、`isThemeId`、無 DOM 環境下安全降級
  - `format.test.ts`：檔案大小與時間格式化
- **介面金標**（14 條，自動 `wrangler dev --persist-to tests/.tmp-state`，用完即清）：訪問控制、會話增刪改查、思考檔位讀寫、**模型供應商全鏈路**（新增/掩碼/啟用/模型跟隨/切回預設/刪除/404/缺金鑰 400）、技能、記憶一鍵清空、備份鍵完整性、恢復、匯出、版本
- **CI 門禁**：`.github/workflows/deploy.yml` 在 `wrangler deploy` 前插入 `npm test`，用例不過不部署
- 文件：`tests/README.md` 寫明「一個功能至少一條用例」的約定、目錄結構、啟動方式與已知未覆蓋項
- 順帶修了用例暴露出的兩個真實問題：`applyTheme` 在無 DOM 環境會拋錯；檔案產出原先掛到上一條助手訊息，改為與工具 pill 一致掛到下一條

## 2026-10-19（LLM 供應商管理）

### 設定新增「模型」tab：CCswitch 式供應商切換（v0.27.0）
- 新增 **LLM 供應商** 管理，任意 OpenAI 相容端點都能接入：
  - 欄位：名稱 / Base URL / API Key / 模型 ID 列表（逗號分隔）
  - 列表裡顯示當前生效項（`使用中` 高亮）+ 金鑰掩碼（`••••1234`）
  - 每項可 **啟用 / 編輯 / 刪除**；編輯時 API Key 留空 = 保持原值
  - 內建「DeepSeek 官方」作為預設項，隨時可切回
- 切換後：`/api/models` 返回新供應商的模型，聊天頂欄的模型選擇器立即更新；已開會話需要重新選模型
- 後端用 pi-ai 的 `createProvider` + `openAICompletionsApi()` 動態構造 Provider，供應商配置存 DO（`providers` 表），隨備份/恢復遷移
- 新增介面：`GET/POST/DELETE /api/providers`、`POST /api/providers/activate`
- 實測：新增 Moonshot（kimi-k2 / kimi-k1.5）→ 啟用 → 模型選擇器變 `kimi-k2` → 切回預設恢復 `deepseek-flash`

## 2026-10-19（設定分 tab + 記憶清空）

### 設定彈窗按子功能分 tab（v0.26.0）
- 原來一長條的設定項拆成四個 tab：
  - **通用**：外觀（四套主題）、佈局（左右欄開關）、賬號（退出登入）
  - **對話**：思考檔位、網頁搜尋
  - **記憶**：記憶庫列表（可單條刪除）
  - **資料**：分享 / 匯出 / 備份 / 恢復
- 彈窗改為「標題 + tab 欄 + 滾動內容區」三段式，不再需要滾很久才能看到底部
- 每次打開回到「通用」tab；Esc 仍可關閉

### 記憶庫一鍵清空
- 新增 `DELETE /api/memories?all=1`，返回實際刪除條數
- 記憶 tab 右上角「清空全部」按鈕，執行前二次確認（提示條數）
- 實測：本地 34 條 → 返回 `{"ok":true,"deleted":34}` → 列表清空

## 2026-10-19（產出檔案配色 + 統一寬度 + Markdown 排版）

### 氣泡寬度統一 / 產出檔案配色 / 排版規範化（v0.25.2）
- **產出檔案**新增獨立配色 **Arco cyan**（`#14C9C9` 系列）：檔案卡、產出清單的邊框、圖示、檔名按鈕都是青色，與工具呼叫（綠）、思維鏈（紫）區分開
- **統一氣泡寬度**：思維鏈塊、計劃卡、工具 pill、檔案卡、產出清單、助手正文統一為**整欄滿寬**，左對齊；只有使用者訊息保持右對齊窄氣泡（區分「我說的」和「系統活動」）
  - 工具 pill 從自適應寬度改成整行，長摘要自動截斷
- **Markdown 排版**：新增 `.md-prose` 排版層，標題/程式碼/表格用 `em` 相對縮放，字號跟隨容器——窄欄 12px、檔案預覽 14→16px（隨螢幕寬度）、聊天氣泡 15px，比例始終一致
- 檔案預覽正文改為**響應式字號** `14px → 15px(sm) → 16px(xl)`，標題層級、列表縮排、引用、表格邊框、程式碼塊留白全部規範化
- **修復**：Markdown 表格的分隔行（`| --- |`）被當成資料行渲染——重構時把布林判斷換成了返回 `undefined` 的 `parseAlign`，已改為獨立的 `isSeparatorCell`

## 2026-10-19（工具/思維鏈配色對齊）

### 工具呼叫與思維鏈改用 Arco 語義色（v0.25.1）
- **工具呼叫**：從 Tailwind 預設綠換成 Arco green（`#00B42A` 系列）；深色下用 green-9/3 做底與字，淺色下底為 green-1 `#E8FFEA`、字為 green-8 `#007A21`
- **思維鏈**：從 Tailwind 預設紫換成 Arco purple（`#722ED1` 系列）；深色底 `#1E1233`、字 `#C396ED`，淺色底 `#F5E8FF`、字 `#3C108F`
- 思維鏈塊的背景透明度從 `20%` 提到 `50%`、邊框 `25%→35%`，深色下層次更清楚
- 錯誤氣泡（Arco red `#F53F3F`）與警示條（Arco orange `#FF7D00`）一併換成對應色卡
- 淺色系下這些 `*-950` 底色統一改成色卡最淺一級，`bg-*-950/40` 才呈現為淡淡的同色背景

## 2026-10-19（位元組系色卡）

### 改用 Arco Design 調色盤（v0.25.0）
- 四套主題的中性色與強調色全部換成 **Arco Design（字節跳動開源設計系統）** 的色卡：
  - 灰階 `gray-1..10`：`#F7F8FA #F2F3F5 #E5E6EB #C9CDD4 #A9AEB8 #86909C #6B7785 #4E5969 #272E3B #1D2129`
  - 品牌藍 `arcoblue`：`#165DFF`（淺 `#4080FF` / `#6AA1FF` / `#94BFFF`，深 `#0E42D2`）
  - 金 `gold`：`#F7BA1E`（`#D99800` / `#B37A00`）
- **深色** 改為 Arco Dark（頁面 `#17171A`、面板 `#232324`），主按鈕為品牌藍 `#165DFF`
- **淺色** 改為 Arco Light（頁面 `#F7F8FA`、卡片 `#FFFFFF`、分隔 `#E5E6EB`）
- **米黃** 改用 Arco 金色系（暖底 + 金色強調），替換原先的青色
- **午夜藍** 用 arcoblue 壓暗做中性底
- 主題後設資料（瀏覽器位址列色、選擇器色塊）同步更新

## 2026-10-19（淺色/米黃樣式修正）

### 淺色系可讀性調整（v0.24.1）
- **開關**：關閉態軌道從 `slate-700` 改 `slate-600` 並給滑塊加描邊，淺底上不再「看不見滑塊」
- **紫色選中按鈕**（思考檔位）：`bg-violet-600 text-white` 之前被全域性 `.text-white` 改成深色，現補進實心色例外表（同時補 sky-600/90、emerald/indigo/amber 等）
- **hover:text-white**：淺底上懸停變白字會消失，淺色系統一改回深色；實心強調色按鈕仍保持白字
- **語義色反轉**：工具 pill（emerald）、思考塊（violet）、錯誤氣泡（rose/red）、計劃進行中步驟（sky-200）原本是「深底淺字」，淺色系下統一反轉成「淺底深字」
- **吸頂計劃卡**：背景改為不透明，滾動時不再透出下方正文
- **彈窗**：淺色/米黃下遮罩從 `black/60` 降到 `slate-900/32`，邊框與分節線加深，資料按鈕加 `shadow-sm`

## 2026-10-19（四套主題）

### 新增米黃、午夜藍主題（v0.24.0）
- 外觀從「深/淺」兩套擴充套件為**四套**：深色（預設）、淺色、**米黃**（暖色淺底，長時間閱讀更柔和）、**午夜藍**（冷色深底）
- 設定 → 外觀改為四宮格選擇器，每格帶色塊預覽
- 實現沿用變數覆蓋：只改 `--color-slate-*` 調色盤 + 少量對比度修正，元件零改動
- `?theme=sepia` / `?theme=midnight` 可直接指定；`pi-theme` 記住選擇，首屏內聯指令碼防閃爍
- 主題邏輯抽到 `lib/theme.ts`（`THEMES` / `readTheme` / `applyTheme`）
- 實測四套主題的 `<html>` class 與 body 背景色：`theme-sepia` #f4eee1、`theme-midnight` #060b18、`theme-light` #f8fafc、深色 slate-950

## 2026-10-19（輸入框呼叫技能）

### 輸入框 `/` 喚起技能（v0.23.0）
- **輸入框輸入 `/`** 自動彈出技能選單（名稱 + 描述，↑↓ 選擇 / Enter 確認 / Esc 取消 / Tab 也可確認），選中後寫入 `/技能名 `
- 輸入框左側新增 **⚡ 按鈕**，點選在游標處插入 `/` 並展開選單
- **後端識別**：訊息以 `/技能名` 開頭且命中已安裝技能時，把該技能完整正文注入本輪 instructions，並告訴模型「嚴格按它執行」；未命中則當普通訊息處理
- 轉錄保留 `/技能名` 原文（與氣泡一致），技能正文只進本輪提示詞，不寫進對話歷史
- 會話標題取去掉 `/技能名` 後的內容
- 實測：`/債券研報摘要 幫我提煉…` 輸出嚴格遵循技能的「核心結論/關鍵資料/風險點/對投資的含義」結構，並遵守「不編造未出現數字」的約束

## 2026-10-19（右欄佈局還原）

### 關閉檔案預覽後右欄沒恢復（v0.22.1）
- 症狀：開啟檔案時右欄自動加寬到 560px，關掉標籤頁後仍停在 560px；在全寬閱讀模式下關閉檔案，聊天欄還會一直隱藏
- 原因：`handleFileOpenChange` 只在 `open === true` 時動作，`false` 直接 return；全寬模式也沒退出
- 修復：開啟前記住原寬度，關閉時還原並退出全寬；使用者在看檔案時手動拖過分隔條則以手動值為準
- 同時補齊兩條沒通知外層的關閉路徑：刪除正在看的檔案、檔案列表重新整理後文件消失
- 實測：340 → 560（開啟）→ 340（關閉）；全寬 1208 + 聊天隱藏 → 340 + 聊天恢復

## 2026-10-19（Codex 式對話展示）

### 思考過程 / 計劃 / 工具軌跡 / 文件卡 / Markdown（v0.22.0）
- **思考過程**：後端開 `thinkingLevel`（deepseek-flash 支援 low/high），SSE 新增 `thinking_start` / `thinking` 幀；聊天裡渲染為可摺疊的紫色「思考過程」塊，流式時自動展開、完成後收起，歷史回放也能看到（解析 `thinking` 內容塊）
- **計劃列表**：新增 `update_plan` 工具 + `plans` 表；聊天頂部**吸頂計劃卡**，帶進度條與 ✓/◐/○ 三態，全部完成後自動收成一行；模型多步任務會自己列計劃
- **工具軌跡**：SSE 工具事件帶 `toolCallId` / `parentToolCallId`，codemode 腳本里的內嵌呼叫掛到父呼叫下顯示（「N 子呼叫」可展開），不再塌縮成一條
- **文件產出**：`write_file` 名字直接從工具入參取，流式中出「檔案卡」；歷史回放時在會話末尾顯示「產出檔案」清單，點選直接在右欄開啟
- **Markdown 渲染升級**：任務列表 `- [ ]`、巢狀列表、`*斜體*` / `~~刪除線~~`、圖片、程式碼塊帶語言標籤與**複製按鈕**、表格對齊與斑馬紋；助手氣泡改用完整 Markdown（之前只處理行內格式）
- **設定頁新增「思考過程」**：關閉 / 低 / 高，預設低；關閉後不產生 reasoning token
- **修復歷史訊息倒序**：`/api/entries` 返回倒序而前端沒反轉，聊天一直是「新訊息在上」，工具結果還會掛到錯誤的助手訊息上——現在按 id 自動判斷並反轉
- 驗收：CDP 驅動真實瀏覽器點選截圖（吸頂計劃、思考塊展開、流式中表格、任務列表、設定頁）

## 2026-10-19（左欄工具欄 + 右欄專注預覽）

### 佈局重構（v0.21.0）
- **最左側新增固定工具欄**（Rail，48px）：新會話 ＋ · 會話 💬 · 連線 🔌 · 定時 ⏰ · 技能 ⚡，底部 ⚙ 設定；圖示切換對應的左側面板，會話欄可獨立摺疊
- **右側工作臺只保留檔案預覽**：檔案列表 + 預覽/原始碼/全寬閱讀；連線、定時、技能整體移到左欄
- **記憶庫移入設定彈窗**：可檢視/刪除，自動抽取的記憶標註「自動抽取」；側欄底部的「記憶庫」入口與工作臺「記憶」tab 移除
- 移動端：抽屜裡是「Rail + 會話列表」，底部導航改為 聊天 / 檔案 / 設定
- 順手修復：技能面板的「URL 匯入 + 社群安裝」區塊曾整段重複渲染兩次
- 視覺驗收：Chrome CDP 驅動點選截圖（桌面四欄、三個左欄面板、設定彈窗、移動端抽屜）

## 2026-10-19（設定頁 + 聯網搜尋）

### 設定頁與 DeepSeek 聯網搜尋（v0.20.0）
- **設定頁**（參照 Codex/Trae）：頂欄右側按鈕全部收進「設定」彈窗——主題、會話欄/工作臺開關、分享、匯出、備份、恢復，並新增「退出登入」；頂欄只保留品牌、狀態與 ⚙ 入口
- **DeepSeek 聯網搜尋**：新工具 `web_search`（`POST /v1/tools/search`，返回標題+連結+摘要列表）與 `web_fetch_page`（`POST /v1/tools/fetch`，返回乾淨 Markdown 正文），複用現有 `DEEPSEEK_API_KEY`
- 搜尋開關在 **設定 → 網頁搜尋**（預設開啟；關閉後模型呼叫工具會得到「到設定中開啟」的提示），按成功請求計費（約 ¥5/1000 次）
- 設定持久化在 `app_settings` 表，隨備份/恢復遷移；新增 `GET/POST /api/settings`
- 實測：搜尋「DeepSeek 最新模型」返回帶日期的真實連結；抓取 `api-docs.deepseek.com` 指南頁返回完整 Markdown

## 2026-10-19（真正的停止）

### 停止按鈕改為服務端中止（v0.19.0）
- 新增 `POST /api/abort {sessionId}` → `conversation.abort()`：撤回排隊輸入、中止當前生成並等待會話空閒
- 前端「停止」先調中止介面再斷開 SSE，避免「介面停了但服務端繼續跑、繼續燒 token」
- 中止後會話仍可繼續對話（不會進入失敗態）

## 2026-10-19（免本地瀏覽器的網頁操作）

### MCP 請求頭 + Browserbase 接入（v0.18.0）
- MCP 伺服器支援自定義**請求頭**（表單新增「請求頭名/值」兩欄），用於 API key 類服務
- 延遲披露閾值從 6 提高到 **12**：6–9 個工具的伺服器（如 Browserbase）直接可用，更大的集合才走 tool_search
- 實測 Browserbase MCP（`https://mcp.browserbase.com/mcp`，請求頭 `x-bb-api-key`）：
  `start` → `navigate` → 讀標題 `Example Domain` → `end` 全部成功，無需本地 Chrome

### 說明
- API key 存在 DO 的 `mcp_servers.headers` 裡（隨備份匯出，注意備份檔案保密）

## 2026-10-19（社群技能）

### 安裝 pi 社群技能（v0.17.0）
- 技能遵循 Agent Skills 規範（`SKILL.md` + YAML frontmatter）
- `GET /api/skills/community`：內建 `badlogic/pi-skills` 目錄（brave-search / youtube-transcript / browser-tools / transcribe / gdcli / gccli / gmcli / vscode），標註「需本地命令列」
- `POST /api/skills/import {url}`：支援 GitHub 目錄/檔案連結、raw 連結、任意 `.md`；自動規範化到 SKILL.md 並解析 frontmatter
- 技能頁新增「從社群安裝」列表（一鍵安裝/重灌）與 URL 匯入框

### 修復：定時任務與對話併發破壞會話
- 症狀：`SessionFailed: Session failed after a storage error; close and reopen it`，且之後該會話所有請求都失敗
- 原因：定時任務在會話正忙時仍然 `submit`，併發寫入破壞 `pi.live` 文件
- 修復：`activeChats` 記錄進行中的會話，忙時把定時任務順延 5 分鐘；`chat`/`chatStream` 出錯若為儲存類錯誤則 `close + reopen` Harness 自愈

## 2026-10-19（右欄可伸縮）

### 右欄不再固定 320px（v0.16.0）
- **拖拽分隔條**調整寬度（260px ~ 視口 65%），寬度寫入 `localStorage.pi-right-width`
- **開啟檔案自動加寬**：當前寬度 < 560px 時自動拉到 560px，保證文件可讀
- **全寬閱讀（⤢）**：檔案檢視新增按鈕，切換後右欄佔滿剩餘空間、桌面上隱藏聊天欄、正文居中限寬 `max-w-4xl`；再點一次返回
- 修復：全寬時右欄曾按固定寬度計算導致右側留白

## 2026-10-19（技能 / 預覽 / 側欄）

### 技能擴充套件與按需載入（v0.15.0）
- `skills` 表 + `GET/POST/DELETE /api/skills`；工作臺新增「技能」tab（名稱+描述+正文，可展開預覽、刪除）
- 提示詞自動注入技能索引（名稱+用途），模型需要時呼叫 `load_skill` 讀取完整正文，`list_skills` 可隨時檢視
- 技能納入 `/api/backup` 與 `/api/restore`

### Markdown / HTML 預覽增強
- Markdown 渲染補齊：1–6 級標題、有序/無序列表、程式碼塊、引用、分隔線、管道表格、行內程式碼與安全連結
- `.html/.htm` 檔案用 **sandbox iframe**（`allow-scripts`）渲染，可直接看生成的網頁

### 側欄自動擴充套件
- 首次進入按視口寬度決定：寬度 ≥1024 展開左欄、≥1280 同時展開右欄；視窗跨斷點自動跟隨
- 使用者手動切換後寫入 localStorage，此後以使用者選擇為準

### 其他
- 工作臺 tab 過多時改為橫向滾動、不換行

## 2026-10-19（備份 / 恢復）

### 全量備份與恢復（v0.14.0）
- `GET /api/backup` → JSON（記憶、檔案、定時任務、MCP 配置、會話後設資料、分享記錄；對話正文請用 `/api/export`）
- `POST /api/restore` → 按主鍵 upsert 合併，**不刪除現有資料**；記憶按內容去重
- 頂欄新增備份（下載）/ 恢復（選檔案上傳）兩個按鈕，恢復後提示各類寫入條數
- 驗證：本地備份 21 記憶 / 4 檔案 / 1 定時 / 1 MCP / 6 會話；原樣恢復無重複（記憶 0 新增，其餘覆蓋）

## 2026-10-19（工具搜尋）

### 工具搜尋與延遲披露（v0.13.0）
- 安裝 `createToolSearchExtension()`：模型可用 `tool_search` 搜尋尚未披露的工具並按需載入
- MCP 工具總數 **≥ 6** 時標記為 `deferred`（不進模型工具列表），避免工具過多撐爆上下文；少於閾值時直接可用
- 與 codemode 並存：指令碼內 `searchTools()` 也能發現被延遲的工具（兩條發現路徑）
- 驗證：閾值調為 1 時 deepwiki 三個工具進入 `deferred`，模型經搜尋後成功呼叫並拿到真實回答

## 2026-10-19（圖片輸入 + 歷史修復）

### 圖片輸入（v0.12.0）
- `POST /api/chat` 與 `/api/chat/stream` 接受 `images: string[]`（data URL，最多 4 張），轉為 pi-ai `ImageContent` 內容塊提交
- 輸入框新增 📎 附件按鈕 + 貼上圖片；前端壓縮到最長邊 1568px（有透明保 PNG，否則 JPEG 0.85），帶縮圖預覽與移除
- 使用者氣泡渲染圖片；匯出/分享仍只取文字

### 修復：歷史訊息不顯示（重要）
- `GET /api/entries` 返回的是**陣列**，前端卻按 `{ entries }` 讀取 → 歷史一直為空（介面停在「開始與 π 對話」）
- 條目 `kind` 形如 `pi.user` / `pi.assistant`，解析時未去字首 → 進一步導致匹配失敗；現已統一歸一化
- 工具活動 pill 的 `toolName` / 內容在 `model[0]` 裡，已補充解析（此前顯示為空 pill）
- 助手僅含工具呼叫時不再渲染空氣泡

## 2026-10-19（主題切換）

### 淺色 / 深色主題（v0.11.0）
- 頂欄新增主題切換按鈕（太陽/月亮），選擇寫入 `localStorage.pi-theme`，首屏內聯指令碼先行應用避免閃爍
- 實現方式：淺色主題直接反轉 Tailwind v4 的 `--color-slate-*` 等調色盤變數，元件程式碼零改動
- 對比度修正：選中會話（`bg-sky-500/15` + `text-white`）在淺底上改為深色文字；實心主按鈕保持白字
- 支援 `?theme=light` URL 引數（便於分享/截圖）

## 2026-10-19（訪問控制）

### 訪問密碼登入（v0.10.0）
- 環境變數 `ACCESS_PASSWORD`（wrangler secret）；未設定時服務保持開放（向後相容）
- `GET /api/auth` 返回是否需要登入；`POST /api/login` 校驗後下發 `pi_access` cookie（HMAC-SHA256，HttpOnly/Secure/SameSite=Lax，30 天）；`POST /api/logout` 清除
- 外層 Worker 統一攔截：`/api/*` 未登入返回 401；`/s/*` 分享頁保持公開
- 改密碼 = 全部會話立即失效（token 由密碼派生）
- 前端未登入時顯示整屏登入閘門
- 注意：本版本之前部署是**完全開放**的，若曾暴露需更換 DeepSeek key

## 2026-10-19（只讀分享）

### 只讀分享連結（v0.9.0）
- `POST /api/share {sessionId, kind}` → 隨機 token；`GET /s/<token>` 返回服務端渲染的只讀頁（深色、移動端友好）
- `shares` 表記錄 token；`wrangler.jsonc` 的 `run_worker_first` 增加 `/s/*`
- 頂欄分享按鈕：生成連結並自動複製到剪貼簿
- 注意：當前整套服務沒有登入鑑權，分享連結的意義是「只讀檢視」而非訪問控制；token 不可猜測（12 位隨機）

## 2026-10-19（定時任務）

### 定時任務（v0.8.0）
- `automations` 表 + `GET/POST/PATCH/DELETE /api/automations`
- 排程基於 **Durable Object alarm**（pi-durable 不含 cron）：每次變更重算最早 `next_run_at` 並 `setAlarm`
- 支援「每天 HH:MM（UTC+8）」與「每隔 N 分鐘」；到點在指定會話裡自動執行提示詞，執行完自動排下一次
- 工作臺新增「定時」tab：建立 / 暫停啟用 / 刪除，顯示排程說明與下次執行時間
- 驗證：建 1 分鐘間隔任務，到點自動在會話裡呼叫 `now` 工具並回報時間

## 2026-10-19（對話匯出）

### 會話匯出 Markdown（v0.7.0）
- `GET /api/export?sessionId=&format=md` 返回完整轉錄（使用者/助手訊息 + 工具呼叫摘要），帶 `Content-Disposition` 檔名
- 頂欄新增下載按鈕，一鍵匯出當前會話
- 條目按 id 倒序儲存，匯出時反轉成時間正序

## 2026-10-19（多模型切換）

### 按會話選擇模型（v0.6.0）
- `GET /api/models`（deepseek-flash / deepseek-v4-pro）、`POST /api/model {sessionId, modelId}`
- `sessions_meta.model` 持久化，會話列表返回該欄位；聊天時 `configure({model})` 生效
- 中欄頂條模型名改為下拉選擇，切換即儲存（按會話，不影響其他會話）
- 驗證：兩個會話分別用 flash / v4-pro，回答風格與模型一致

## 2026-10-19（MCP 接入）

### MCP（Model Context Protocol）工具接入（本條提交）
- `mcp_servers` 表 + `GET/POST/DELETE /api/mcp`；工作臺新增「連線」tab，可新增/移除 Streamable HTTP MCP 伺服器
- 啟動時連線並列出工具，包裝為 `mcp__<伺服器>__<工具>`，僅模型可呼叫
- **踩坑：** 擴充套件必須在 `Harness.open` 前 `registry.install`；早期版本每輪重建導致工具反覆新增/移除，汙染老會話轉錄（`pi.system` 的 toolsAdded/toolsRemoved 記錄），表現為模型只看到舊工具集——新會話正常。現改為「構建一次常駐 + 配置變更時重建，失敗保留上次成功結果」
- 驗證：新會話中模型呼叫 `mcp__deepwiki__ask_wiki_question` 得到真實回答

## 2026-10-19

### 檔案按會話隔離 + 會話重新命名/刪除（`201bb89`）
- `vfs_v2(conversation_id, name)` 複合主鍵，舊全域性檔案表自動遷移到根會話
- `write_file` / `read_file` / `list_files` 使用 `api.conversationId`；`/api/files*` 支援 `sessionId`
- `PATCH /api/sessions` 重新命名、`DELETE /api/sessions` 刪除（墓碑防列表復活，同時清空該會話檔案）
- 側欄會話項懸停顯示 ✎ / 🗑

### reflect：會話洞察自動入庫（`eea259d`）
- 每 6 個新條目後臺觸發一次，DeepSeek 低成本抽取 ≤3 條長期事實
- 規範化去重（去空白/標點後互為子串即跳過）；`pi_mem.source` 區分 manual / reflect
- `POST /api/reflect` 可手動觸發

### SSE 流式輸出（`a17e652`）
- `POST /api/chat/stream`：`watchEvents` → SSE（text 增量 / tool_start / tool_end / done）
- 前端增量渲染到氣泡，工具 pill 即時出現
- 注意：部署後舊 Durable Object 例項會繼續執行舊程式碼（活躍請求使其不被驅逐），約 5 分鐘後才切換

### 多會話（`5de940e`）
- `createConversation` 新建會話，`sessions_meta` 存標題/時間，首輪訊息自動生成標題
- 會話隔離：chat / entries / reset 均按 `sessionId`
- 會話列表由後設資料表 + `storage.scanConversations` 補齊

### codemode：QuickJS 沙箱執行（`09e9b1d`）
- `createCodemodeExtension` + `createInlineCodemodeSandbox`（WASM 由 wrangler 打包）
- 模型可寫 JavaScript，指令碼內 `await tools.<name>(args)` 呼叫任意工具
- 會話的 agent 選擇固化在 `pi.agent`，需 `root.configure()` 冪等重設才對老會話生效

## 2026-10-16

### Codex 式三欄佈局 + 虛擬檔案系統（`9bb4c5e`）
- 左會話欄 / 中聊天（可展開工具 pill）/ 右工作臺（檔案預覽/原始碼切換 + 記憶管理）
- `vfs_files` 表 + `write_file` / `read_file` / `list_files`；`/api/files*`、`/api/memories`、`/api/sessions`

### 中文聊天前端（`413f8fb`）
- React + Vite + Tailwind SPA，經 wrangler assets 與 API 同 Worker 部署
- `/api/*` 與 `/agent/*` 路由進 Durable Object（`run_worker_first`）

### CI 自動部署（`0d7f458`）
- push `main` → `npm ci` → `build:web` → `wrangler deploy`
- 倉庫 secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`

### pi-durable harness 上 Cloudflare（`398ea69`）
- Durable Object 內執行 `Harness`，儲存用官方 `openDurableObjectSqliteStorage`（DO SQLite）
- `pi-ai` 的 `deepseekProvider`（模型目錄 id：`deepseek-flash` / `deepseek-v4-pro`）
- 工具：`now` / `remember` / `recall` / `http_fetch`
- 驗證：工具呼叫、跨請求記憶、程序重啟後會話恢復
