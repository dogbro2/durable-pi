/**
 * 知識庫 / MCP 兩個彈窗的懶載入入口（NERE-81）。
 *
 * 兩者同一時刻只會開一個，放進同一個動態 import：首包不含這兩個元件，
 * 第一次開啟任一彈窗時載入一次 chunk，之後切到另一個不再請求。
 */

export { KnowledgePanel } from "./KnowledgePanel";
export { McpPanel } from "./McpPanel";
