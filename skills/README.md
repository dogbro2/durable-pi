# 內建技能

Skill Hub 的內建技能目錄。每條技能一個目錄，目錄名與 `SKILL.md` 的 `name`、`catalog.json` 的 `name` 一致。

全部技能均為 `runtime=prompt`：只有說明書，由模型按內容呼叫內建工具，不執行任何程式碼。工具宣告只使用契約 §2.3 的 18 個白名單工具。

## 索引

### 原生技能（NERE-60，6 條）

| 名稱 | 標籤 | 解決什麼 |
|---|---|---|
| `meeting-notes` | meeting | 把錄音轉寫、聊天記錄或零散筆記整理成決議、待辦、負責人和截止時間 |
| `weekly-report` | writing | 把一週工作記錄整理成周報或日報，突出結果、資料、風險和下週計劃 |
| `code-review-checklist` | engineering | 按風險優先順序審查程式碼變更，覆蓋正確性、邊界、併發、安全、相容性和測試 |
| `research-brief` | research | 把研報、公告、訪談或網頁資料壓縮成結論先行、證據可追溯的摘要 |
| `reply-polish` | business | 潤色客服、商務和跨部門回覆，保留原意與承諾邊界 |
| `requirement-breakdown` | product | 把一句話需求拆成使用者故事、邊界場景和可驗證的驗收標準 |

### 外部改編技能（NERE-61，6 條）

| 名稱 | 標籤 | 解決什麼 | 原作者 | 許可證 |
|---|---|---|---|---|
| `bp-diagnose-root` | diagnosis, debugging | 用復現、隔離、假設、驗證四階段定位缺陷根因 | Daniel（bigpowers） | MIT |
| `bp-grill-me` | planning, review | 用連續追問壓力測試計劃，區分事實與決策 | Daniel（bigpowers） | MIT |
| `bp-terse-mode` | communication, writing | 極簡表達，刪掉客套與冗餘，保留技術事實 | Daniel（bigpowers） | MIT |
| `bp-simple-english` | writing, documentation | 用簡化技術英語規則改寫文件，句子短、術語唯一 | Daniel（bigpowers） | MIT |
| `ponytail` | engineering, simplicity | 懶惰資深開發模式，用最少的新程式碼完整解決問題 | Dietrich Gebert（ponytail） | MIT |
| `ponytail-review` | engineering, code-review | 按正確、安全、負載、測試、速度、精簡的順序評審改動 | Dietrich Gebert（ponytail） | MIT |

## 來源與改編說明

外部技能都保留了原作者、原始專案地址和許可證，具體欄位見各目錄的 `skill.json` 與 `catalog.json` 條目。兩條上游專案均為 MIT 許可證，允許再分發和改編。

改編原則：

- 去掉對本地 shell、指令碼、npm 包、工作區檔案路徑和外掛 hook 的依賴。
- 原技能裡的本地檔案讀寫改為通過 `read_file` / `list_files` 訪問當前工作臺。
- 原技能裡的網頁抓取改為通過 `web_fetch_page` 訪問，並在 `requires.tools` 中宣告。
- 保留原技能的方法、檢查項和硬門檻，不改變其判斷標準。
- 每個 `SKILL.md` 末尾的「來源與改編」寫明原始技能、作者和改動範圍。

## 目錄約定

```text
skills/
  catalog.json          # Hub 索引：後設資料、contentUrl、contentHash、審計快照
  README.md             # 本檔案
  <skill-name>/
    SKILL.md            # runtime=prompt 的內容檔案
    skill.json          # manifest：來源、許可證、工具宣告、contentHash
```

規則：

- `contentHash` 按契約 §2.5 計算：`SKILL.md` 去掉 frontmatter 後的正文，UTF-8 原樣位元組，SHA-256。
- `contentUrl` 指向倉庫 `main` 分支的原始檔案，安裝時抓取並重算雜湊。
- `audit.hash` 必須等於 `contentHash`；內建目錄不允許 `blocked` 條目。
- 新增條目同時更新 `catalog.json` 和本索引。
- 修改 `SKILL.md` 正文後必須重算 `contentHash`，同步 `skill.json` 與 `catalog.json`。
- 不覆蓋已有技能；同名條目由服務端按 `name_conflict` 處理。

## 審計

`catalog.json` 的 `audit` 是目錄快照，安裝時的本地重審計才是權威。當前 12 條全部為 `pass`，`reasons` 為空。

## 許可證

原生 6 條為 MIT。外部改編技能遵循各自上游的 MIT 許可證，版權歸原作者；改編說明見各技能末尾。
