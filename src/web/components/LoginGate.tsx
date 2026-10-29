import { useState } from "react";

/**
 * 未登入時的整屏登入閘門。
 *
 * demoUrl 有值時，在表單下方多給一個「看一個真實對話」入口：指向一條永久、只讀的
 * 會話分享頁（/s/<token>），不經過登入、不呼叫任何寫介面。沒有配置演示連結時
 * 不渲染這個入口，避免出現死鏈。
 */
export function LoginGate({
	onSubmit,
	error,
	demoUrl,
}: {
	onSubmit: (password: string) => Promise<void>;
	error: string | null;
	demoUrl?: string;
}) {
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<div className="flex h-dvh items-center justify-center bg-slate-950 px-4">
			<div className="w-full max-w-sm">
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (!password.trim() || busy) return;
						setBusy(true);
						void onSubmit(password.trim()).finally(() => setBusy(false));
					}}
					className="rounded-2xl border border-slate-800 bg-slate-900/80 p-7 shadow-xl"
				>
					<h1 className="mb-1 text-lg font-semibold text-slate-100">Durable Pi</h1>
					<p className="mb-5 text-sm text-slate-400">請輸入訪問密碼或邀請碼</p>
					{error && <p className="mb-3 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>}
					<input
						type="text"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						placeholder="訪問密碼或邀請碼"
						aria-label="訪問密碼或邀請碼"
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						autoFocus
						className="mb-3 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500"
					/>
					<button
						type="submit"
						disabled={busy || !password.trim()}
						className="w-full rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
					>
						{busy ? "驗證中…" : "進入"}
					</button>
				</form>
				{demoUrl ? (
					<a
						href={demoUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="mt-3 flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/50 px-5 py-3.5 text-left transition-colors hover:border-sky-700 hover:bg-slate-900"
					>
						<span className="min-w-0">
							<span className="block text-sm font-medium text-slate-200">看一個真實對話</span>
							<span className="block text-xs text-slate-500">免登入 · 只讀分享頁</span>
						</span>
						<span aria-hidden="true" className="shrink-0 text-slate-500">
							→
						</span>
					</a>
				) : null}
			</div>
		</div>
	);
}
