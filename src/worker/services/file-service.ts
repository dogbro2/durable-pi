import type { SqlHandle } from "../db/migrations";
import { getContent, listAll, listBySession, remove, removeSession, write } from "../repo/files-repo";
import type { AllFileRow, FileContent, FileSummary } from "../repo/files-repo";

/**
 * 檔案域用例（ADR-0001 §2）：只依賴顯式 sql 控制代碼，不讀請求級隱式作用域。
 * `listAll` 承擔查詢歸一化（舊 GET /files/all 的行為）。
 */
export type FileServiceDeps = {
	sql: SqlHandle;
	/** 可注入時鐘，便於測試；預設取當前 ISO 時間。 */
	now?: () => string;
};

export interface FileService {
	list(sessionId: string): FileSummary[];
	read(sessionId: string, name: string): FileContent | undefined;
	write(sessionId: string, name: string, content: string): void;
	delete(sessionId: string, name: string): void;
	deleteSession(sessionId: string): void;
	/** `query` 原樣傳入，歸一化（trim/截斷/小寫）在 Service 內完成。 */
	listAll(query: string): AllFileRow[];
}

export function createFileService({ sql, now = () => new Date().toISOString() }: FileServiceDeps): FileService {
	return {
		list(sessionId) {
			return listBySession(sql, sessionId);
		},
		read(sessionId, name) {
			return getContent(sql, sessionId, name);
		},
		write(sessionId, name, content) {
			write(sql, sessionId, name, content, now());
		},
		delete(sessionId, name) {
			remove(sql, sessionId, name);
		},
		deleteSession(sessionId) {
			removeSession(sql, sessionId);
		},
		listAll(query) {
			return listAll(sql, (query ?? "").trim().slice(0, 100).toLowerCase());
		},
	};
}
