import { describe, expect, it, vi } from "vitest";
import type { BackupPayload } from "../../src/worker/services/data-service";
import { createUserAdminService, type UserAdminPorts } from "../../src/worker/services/user-admin-service";
import { emptyUserDataCounts, type RevokeResult } from "../../src/worker/services/user-lifecycle-service";

const USER_ID = "u_ab12cd34";

function ports(overrides: Partial<UserAdminPorts> = {}): UserAdminPorts {
	return {
		deleteRegistryUser: vi.fn(async () => ({ deleted: true })),
		registryHas: vi.fn(async () => true),
		revoke: vi.fn(async (): Promise<RevokeResult> => ({ shares: 2, retained: emptyUserDataCounts() })),
		backup: vi.fn(async () => ({ version: 1, exportedAt: "", data: {} }) as BackupPayload),
		purge: vi.fn(async () => emptyUserDataCounts()),
		...overrides,
	};
}

describe("使用者吊銷順序（NERE-77）", () => {
	it("先刪分享再刪登錄檔：吊銷失敗時登錄檔保留、介面報錯，重試冪等", async () => {
		const revoke = vi
			.fn(async (): Promise<RevokeResult> => ({ shares: 3, retained: emptyUserDataCounts() }))
			.mockRejectedValueOnce(new Error("使用者 DO 不可用"));
		const deleteRegistryUser = vi.fn(async () => ({ deleted: true }));
		const service = createUserAdminService(ports({ revoke, deleteRegistryUser }));

		await expect(service.remove(USER_ID)).rejects.toThrow("使用者 DO 不可用");
		// 失敗方向是可用性：登錄檔行還在，但分享沒刪成功時不能假裝成功。
		expect(deleteRegistryUser).not.toHaveBeenCalled();

		await expect(service.remove(USER_ID)).resolves.toMatchObject({ ok: true, deleted: true, shares: 3 });
		expect(revoke).toHaveBeenCalledTimes(2);
		expect(deleteRegistryUser).toHaveBeenCalledTimes(1);
	});

	it("成功路徑按 revoke → deleteRegistryUser 順序呼叫", async () => {
		const calls: string[] = [];
		const service = createUserAdminService(
			ports({
				revoke: async () => {
					calls.push("revoke");
					return { shares: 1, retained: emptyUserDataCounts() };
				},
				deleteRegistryUser: async () => {
					calls.push("deleteRegistryUser");
					return { deleted: true };
				},
			}),
		);
		await service.remove(USER_ID);
		expect(calls).toEqual(["revoke", "deleteRegistryUser"]);
	});
});
