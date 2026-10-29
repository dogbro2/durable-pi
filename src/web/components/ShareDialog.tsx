import { useEffect, useRef, useState } from "react";
import { api, type ShareLinkInfo } from "../lib/api";
import { formatTime, shareUrlFor } from "../lib/format";
import { readTheme } from "../lib/theme";
import { Icon } from "./Icon";

interface ShareDialogProps {
	sessionId: string;
	name: string;
	onClose: () => void;
}

/** 有效期選項（秒，0 = 永久）。 */
const TTL_OPTIONS = [
	{ label: "1 小時", seconds: 3600 },
	{ label: "1 天", seconds: 86400 },
	{ label: "7 天", seconds: 604800 },
	{ label: "30 天", seconds: 2592000 },
	{ label: "永久", seconds: 0 },
];

/** 檔案分享彈窗（v0.38.0）：選有效期 → 生成帶域名的公開只讀連結 → 複製。 */
export function ShareDialog({ sessionId, name, onClose }: ShareDialogProps) {
	const [ttl, setTtl] = useState(604800);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [result, setResult] = useState<{ url: string; expiresAt: number; reused?: boolean; createdAt?: string } | null>(null);
	const [existing, setExisting] = useState<ShareLinkInfo | null>(null);
	const [copied, setCopied] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	// 開啟時讀取已有連結：有就直接展示，避免每次都生成新 token（v0.40.0）
	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const data = await api.shares(sessionId, "file", name);
				const latest = data.shares?.[0];
				if (!alive || !latest) return;
				setExisting(latest);
				setResult((prev) =>
					prev ?? {
						url: shareUrlFor(latest.url, window.location.origin, readTheme()),
						expiresAt: Number(latest.expiresAt) || 0,
						reused: true,
						createdAt: latest.createdAt,
					},
				);
			} catch {
				// 讀取失敗不影響新建連結
			}
		})();
		return () => {
			alive = false;
		};
	}, [sessionId, name]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			// 上層（如 ModalShell）已處理 Esc 時不再重複關閉（NERE-62 契約 §4.1）
			if (event.defaultPrevented) return;
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const generate = () => {
		if (busy) return;
		setBusy(true);
		setError("");
		setCopied(false);
		void (async () => {
			try {
				const data = await api.shareFile(sessionId, name, ttl, readTheme());
				if (!data.url) throw new Error(data.error || "生成分享連結失敗");
				// 域名一律用當前頁面：pages.dev 反代下服務端看到的是 workers.dev 地址
				const url = shareUrlFor(data.url, window.location.origin, readTheme());
				setResult({ url, expiresAt: Number(data.expiresAt) || 0, reused: false, createdAt: new Date().toISOString() });
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setBusy(false);
			}
		})();
	};

	const copy = () => {
		if (!result) return;
		void (async () => {
			try {
				await navigator.clipboard.writeText(result.url);
				setCopied(true);
				return;
			} catch {
				// 非安全上下文/無剪貼簿許可權：退回選中 + execCommand
			}
			inputRef.current?.select();
			try {
				document.execCommand("copy");
				setCopied(true);
			} catch {
				// 讓使用者手動複製
			}
		})();
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			<button type="button" aria-label="關閉分享" onClick={onClose} className="dialog-scrim absolute inset-0" />
			<div
				role="dialog"
				aria-modal="true"
				aria-label={`分享 ${name}`}
				className="relative w-[min(92vw,26rem)] overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
			>
				<div className="flex items-start justify-between gap-3 px-5 pt-4">
					<div className="min-w-0">
						<h2 className="text-sm font-semibold text-slate-100">分享檔案</h2>
						<p className="mt-0.5 truncate text-xs text-slate-400" title={name}>
							{name}
						</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="關閉"
						className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
					>
						<Icon name="close" className="h-4 w-4" />
					</button>
				</div>

				<div className="px-5 pb-5 pt-3">
					<p className="text-[11px] text-slate-500">連結有效期</p>
					<div className="mt-1.5 flex flex-wrap gap-1.5">
						{TTL_OPTIONS.map((option) => (
							<button
								key={option.seconds}
								type="button"
								onClick={() => setTtl(option.seconds)}
								aria-pressed={ttl === option.seconds}
								className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
									ttl === option.seconds
										? "border-sky-500 bg-sky-500/20 text-sky-100"
										: "border-slate-700 text-slate-300 hover:bg-slate-800"
								}`}
							>
								{option.label}
							</button>
						))}
					</div>

					{result?.reused && (
						<p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
							已複用{existing ? `創建於 ${formatTime(existing.createdAt)} 的` : "已有"}連結；調整有效期後點「重新生成連結」才會建立新連結。
						</p>
					)}

					<button
						type="button"
						onClick={generate}
						disabled={busy}
						className="mt-3 w-full rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-50"
					>
						{busy ? "生成中…" : result ? "重新生成連結" : "生成分享連結"}
					</button>

					{error && <p className="mt-2 text-xs text-red-300">{error}</p>}

					{result && (
						<div className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-950/30 p-2.5">
							<div className="flex gap-1.5">
								<input
									ref={inputRef}
									readOnly
									value={result.url}
									onFocus={(event) => event.currentTarget.select()}
									aria-label="分享連結"
									className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950/70 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-emerald-500/50"
								/>
								<button
									type="button"
									onClick={copy}
									className="shrink-0 rounded-md bg-emerald-600 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-emerald-500"
								>
									{copied ? "已複製" : "複製"}
								</button>
							</div>
							<a
								href={result.url}
								target="_blank"
								rel="noopener noreferrer"
								className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md border border-slate-600 px-2.5 py-1.5 text-[11px] text-slate-200 transition-colors hover:bg-slate-800"
							>
								<Icon name="external" className="h-3.5 w-3.5" />
								在新視窗開啟
							</a>
							<p className="mt-1.5 text-[11px] text-emerald-200/70">
								{result.reused && (
									<span className="mr-1 rounded bg-emerald-500/20 px-1 text-[10px] text-emerald-200">已有</span>
								)}
								{result.expiresAt > 0
									? `有效期至 ${new Date(result.expiresAt).toLocaleString("zh-TW", { hour12: false })}`
									: "永久有效"}
								<span className="text-emerald-200/40"> · </span>
								拿到連結的人無需登入即可檢視
							</p>
						</div>
					)}

					<p className="mt-3 text-[11px] leading-relaxed text-slate-500">
						分享頁只讀，內容隨檔案更新；連結洩露時可刪除檔案使其立即失效。
					</p>
				</div>
			</div>
		</div>
	);
}
