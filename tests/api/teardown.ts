import { existsSync, rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

/**
 * 停掉 detached 啟動的 `wrangler dev` 程序組，再刪測試 persist 目錄。
 *
 * 為什麼不能直接 `kill` 完就 `rmSync`：process.kill 是非同步的，workerd 還在往
 * persist 目錄落盤，此時 rmSync 會拋 `ENOTEMPTY: Directory not empty`。
 * vitest 會把這條 afterAll 異常記成「整個測試檔案失敗」——即使裡面所有用例都過了，
 * `npm test` 仍然非 0 退出。表現為「本地跑不出一份全綠」，跟產品程式碼無關。
 *
 * 所以：先等子程序退出（最多 5s），再刪；刪不掉就重試，最多 5s。
 */
export async function stopServer(proc: ChildProcess | null, stateDir: string): Promise<void> {
	if (proc?.pid) {
		const pid = proc.pid;
		const exited = new Promise<void>((resolve) => {
			proc.once("exit", () => resolve());
			setTimeout(resolve, 5_000);
		});
		try {
			// detached: true 時子程序自成一組，負 pid 殺整組（npx → node → workerd）
			process.kill(-pid, "SIGTERM");
		} catch {
			proc.kill("SIGTERM");
		}
		await exited;
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// 已經退出了
		}
	}

	for (let i = 0; i < 50; i++) {
		try {
			rmSync(stateDir, { recursive: true, force: true });
			if (!existsSync(stateDir)) return;
		} catch {
			// workerd 還在收尾寫盤，稍等重試
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	console.warn(`[test] 未能清理測試狀態目錄：${stateDir}`);
}
