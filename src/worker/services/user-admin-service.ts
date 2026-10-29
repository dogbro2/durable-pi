import { AppError } from "../http/errors";
import { USER_ID_RE } from "../http/ports";
import type { BackupPayload } from "./data-service";
import { emptyUserDataCounts, type RevokeResult, type UserDataCounts } from "./user-lifecycle-service";

/**
 * 使用者登出編排（NERE-24）：登錄檔與使用者 DO 的跨 DO 協議順序在這裡固定。
 *
 * 1. 刪除使用者 DO 內全部分享：`/s/*` 舊連結立即 404；
 * 2. 刪除登錄檔行：`/api/*` 的舊 token 立即 401；
 * 3. 資料預設保留；purge 是獨立的顯式動作，要求先吊銷且 `confirm` 等於使用者 id。
 *
 * 先吊銷再刪登錄檔（NERE-77）：吊銷失敗時介面報錯、登錄檔行仍在，可重試；
 * 失敗方向是「暫時不可用」而不是「公開連結繼續可讀」。
 *
 * 每個埠都冪等，重複呼叫不會重複扣減或報錯。
 */
export type UserAdminPorts = {
	deleteRegistryUser(id: string): Promise<{ deleted: boolean }>;
	registryHas(id: string): Promise<boolean>;
	revoke(id: string): Promise<RevokeResult>;
	backup(id: string): Promise<BackupPayload>;
	purge(id: string): Promise<UserDataCounts>;
};

export type UserAdminService = {
	remove(id: string): Promise<{ ok: true; id: string; deleted: boolean; shares: number; retained: UserDataCounts }>;
	exportData(id: string): Promise<BackupPayload>;
	purge(id: string, confirm: string | null): Promise<UserDataCounts>;
};

export function createUserAdminService(ports: UserAdminPorts): UserAdminService {
	return {
		async remove(id) {
			// 非邀請使用者 id（空值、owner）歷史語義是「什麼都沒刪也返回 ok」；不建立使用者 DO。
			if (!USER_ID_RE.test(id)) {
				return { ok: true, id, deleted: false, shares: 0, retained: emptyUserDataCounts() };
			}
			const { shares, retained } = await ports.revoke(id);
			const { deleted } = await ports.deleteRegistryUser(id);
			return { ok: true, id, deleted, shares, retained };
		},

		async exportData(id) {
			assertUserId(id);
			return ports.backup(id);
		},

		async purge(id, confirm) {
			assertUserId(id);
			if (confirm !== id) {
				throw new AppError("bad_request", 400, "二次確認失敗：confirm 必須等於使用者 id");
			}
			if (await ports.registryHas(id)) {
				throw new AppError("conflict", 409, "使用者仍在登錄檔中，請先吊銷訪問（DELETE /api/users）");
			}
			return ports.purge(id);
		},
	};
}

function assertUserId(id: string): void {
	if (!USER_ID_RE.test(id)) throw new AppError("bad_request", 400, "缺少有效的使用者 id");
}
