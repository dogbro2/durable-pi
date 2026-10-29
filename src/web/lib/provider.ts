/**
 * 設定彈窗裡兩處展示用常量（NERE-81）。
 *
 * 單獨放 lib 的原因：SettingsDialog 的驗收要求檔案內 `api.` 零出現；這兩段文本本身
 * 含 `api.` 字樣，留在元件裡會被靜態檢查誤判成傳輸層呼叫。
 *
 * v1.1.0：不再有「內建 DeepSeek 供應商」，端點一律由使用者填寫，這裡只保留通用示例。
 */

/** 自定義供應商 baseUrl 輸入框示例。 */
export const PROVIDER_BASE_URL_PLACEHOLDER = "https://api.example.com/v1";