/**
 * Skill Hub 的一行（NERE-54）：摘要 + 展開後的審計報告 + 安裝按鈕。
 * 純展示元件：資料由父級（SkillHubPanel）傳入，安裝動作只回調，不直接碰傳輸層。
 */

import {
	BLOCKED_HINT,
	SKILL_AUDIT_LABELS,
	SKILL_AUDIT_STYLES,
	canInstallHubEntry,
	hubEntryInstallUrl,
	isHubEntryUpdatable,
	runtimeLabel,
	sourceHost,
} from "../lib/skill-hub";
import type { SkillHubEntry } from "../types";
import { Icon } from "./Icon";

const CHIP = "rounded-full px-1.5 py-px text-[10px] leading-4";

function AuditBadge({ status }: { status: SkillHubEntry["audit"]["status"] }) {
	return <span className={`${CHIP} ${SKILL_AUDIT_STYLES[status]}`}>{SKILL_AUDIT_LABELS[status]}</span>;
}

/** 審計詳情：reasons（message / evidence / rule）、detected（runtime / network / tools）、hash、來源。 */
function AuditDetail({ entry }: { entry: SkillHubEntry }) {
	const { audit } = entry;
	const hash = audit.hash || entry.contentHash;
	return (
		<dl className="space-y-1 rounded-md border border-slate-700/60 bg-slate-950/40 px-2 py-1.5 text-[11px] text-slate-400">
			<div className="flex gap-2">
				<dt className="w-16 shrink-0 text-slate-500">審計</dt>
				<dd className="flex min-w-0 flex-wrap items-center gap-1">
					<AuditBadge status={audit.status} />
					{audit.auditedAt && <span className="text-slate-500">{audit.auditedAt}</span>}
					{audit.rulesVersion !== undefined && <span className="text-slate-600">規則 v{audit.rulesVersion}</span>}
				</dd>
			</div>
			<div className="flex gap-2">
				<dt className="w-16 shrink-0 text-slate-500">執行時</dt>
				<dd className="min-w-0 break-all">{runtimeLabel(audit.detected.runtime || entry.runtime)}</dd>
			</div>
			<div className="flex gap-2">
				<dt className="w-16 shrink-0 text-slate-500">聯網</dt>
				<dd className="min-w-0 break-all">{audit.detected.network.length > 0 ? audit.detected.network.join("、") : "未檢測到聯網"}</dd>
			</div>
			<div className="flex gap-2">
				<dt className="w-16 shrink-0 text-slate-500">外部工具</dt>
				<dd className="min-w-0 break-all">{audit.detected.tools.length > 0 ? audit.detected.tools.join("、") : "無"}</dd>
			</div>
			<div className="flex gap-2">
				<dt className="w-16 shrink-0 text-slate-500">來源</dt>
				<dd className="min-w-0 break-all">{entry.source || "未知"}</dd>
			</div>
			{entry.license && (
				<div className="flex gap-2">
					<dt className="w-16 shrink-0 text-slate-500">許可證</dt>
					<dd className="min-w-0 break-all">{entry.license}</dd>
				</div>
			)}
			{hash && (
				<div className="flex gap-2">
					<dt className="w-16 shrink-0 text-slate-500">雜湊</dt>
					<dd className="min-w-0 break-all font-mono text-[10px] text-slate-500">{hash}</dd>
				</div>
			)}
			<div className="flex gap-2">
				<dt className="w-16 shrink-0 text-slate-500">審計原因</dt>
				<dd className="min-w-0">
					{audit.reasons.length > 0 ? (
						<ul className="list-disc space-y-0.5 pl-4">
							{audit.reasons.map((reason, index) => (
								<li key={`${index}-${reason.rule ?? ""}-${reason.message}`}>
									{reason.level && (
										<span className={`${CHIP} mr-1 align-middle ${SKILL_AUDIT_STYLES[reason.level]}`}>
											{SKILL_AUDIT_LABELS[reason.level]}
										</span>
									)}
									{reason.rule && <span className="mr-1 font-mono text-[10px] text-slate-500">[{reason.rule}]</span>}
									{reason.message}
									{reason.evidence && (
										<span className="mt-0.5 block break-all font-mono text-[10px] text-slate-600">
											依據：{reason.evidence}
										</span>
									)}
								</li>
							))}
						</ul>
					) : (
						<span className="text-emerald-300">未發現問題</span>
					)}
				</dd>
			</div>
		</dl>
	);
}

export function SkillHubRow({
	entry,
	expanded,
	installed,
	installedNow,
	installing,
	installError,
	onToggle,
	onInstall,
	onTry,
}: {
	entry: SkillHubEntry;
	expanded: boolean;
	installed: boolean;
	/** 本次會話剛裝成功：目錄快照還沒重新整理，先按「已安裝」呈現，不再提示「可更新」。 */
	installedNow: boolean;
	installing: boolean;
	/** 安裝失敗首因（422 `details.audit.reasons[0].message`）。 */
	installError: string | null;
	onToggle: (name: string) => void;
	onInstall: (entry: SkillHubEntry) => void;
	/** 「試用」：頁面層關彈窗並把 `/技能名 ` 預填進輸入框。 */
	onTry: (name: string) => void;
}) {
	const blocked = entry.audit.status === "blocked";
	const installUrl = hubEntryInstallUrl(entry);
	const installable = canInstallHubEntry(entry);
	const isInstalled = installed || entry.installed;
	const updatable = isHubEntryUpdatable(entry) && !installedNow;
	const actionLabel = blocked ? "不可安裝" : installing ? "安裝中…" : updatable ? "更新" : isInstalled ? "重新安裝" : "安裝";
	/** blocked 條目按鈕按契約停用；把首條原因放在按鈕旁，使用者不用展開審計報告也能看到為什麼。 */
	const blockedReason = blocked ? entry.audit.reasons[0]?.message ?? "" : "";

	return (
		<li className="rounded-lg bg-slate-800/50">
			<button
				type="button"
				onClick={() => onToggle(entry.name)}
				aria-expanded={expanded}
				className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-slate-800/80"
			>
				<Icon name={expanded ? "chevronDown" : "chevronRight"} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-1.5">
						<span className="truncate text-[13px] text-slate-100">{entry.name}</span>
						{entry.version && (
							<span className="shrink-0 text-[10px] tabular-nums text-slate-500">v{entry.version.replace(/^v/i, "")}</span>
						)}
						{updatable ? (
							<span className={`${CHIP} shrink-0 bg-amber-500/15 text-amber-300`}>可更新</span>
						) : (
							isInstalled && <span className={`${CHIP} shrink-0 bg-sky-500/15 text-sky-300`}>已安裝</span>
						)}
					</span>
					<span className="mt-0.5 block line-clamp-2 text-[11px] leading-relaxed text-slate-500">
						{entry.description || "（無描述）"}
					</span>
					<span className="mt-1 flex flex-wrap items-center gap-1">
						<AuditBadge status={entry.audit.status} />
						<span className={`${CHIP} bg-slate-700/70 text-slate-300`}>{runtimeLabel(entry.runtime)}</span>
						{entry.tags.slice(0, 3).map((tag) => (
							<span key={tag} className={`${CHIP} bg-slate-800 text-slate-400`}>
								{tag}
							</span>
						))}
						{entry.source && (
							<span title={entry.source} className="min-w-0 truncate text-[10px] text-slate-600">
								來源 {sourceHost(entry.source)}
							</span>
						)}
					</span>
				</span>
			</button>

			{expanded && (
				<div role="region" aria-label={`${entry.name} 的審計報告`} className="space-y-2 border-t border-slate-700/60 px-2.5 py-2">
					<AuditDetail entry={entry} />
					{blocked && (
						<p role="note" className="rounded-md border border-rose-500/30 bg-rose-950/30 px-2 py-1.5 text-[11px] text-rose-200">
							{BLOCKED_HINT}
							{blockedReason && <span className="mt-0.5 block break-all">原因：{blockedReason}</span>}
						</p>
					)}
					{!blocked && !installUrl && !isInstalled && (
						<p role="note" className="rounded-md border border-amber-500/30 bg-amber-950/20 px-2 py-1.5 text-[11px] text-amber-200">
							這條技能沒有安裝地址（source 不是 http(s) 連結），暫時無法從這裡安裝。
						</p>
					)}
					<button
						type="button"
						disabled={!installable || installing}
						onClick={() => {
							if (installable) onInstall(entry);
						}}
						aria-label={`${blocked ? "不可安裝" : updatable ? "更新" : isInstalled ? "重新安裝" : "安裝"}技能 ${entry.name}`}
						className="w-full rounded-md bg-sky-600 px-2 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{actionLabel}
					</button>
					{installError && (
						<p
							role="alert"
							className="rounded-md border border-rose-500/30 bg-rose-950/30 px-2 py-1.5 text-[11px] leading-relaxed text-rose-200"
						>
							安裝失敗：<span className="break-all">{installError}</span>
						</p>
					)}
					{isInstalled && !blocked && (
						<div className="flex flex-wrap items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-950/20 px-2 py-1.5 text-[11px] text-emerald-200">
							<span>已安裝 ·</span>
							<button
								type="button"
								onClick={() => onTry(entry.name)}
								aria-label={`試用技能 ${entry.name}`}
								className="rounded-md border border-emerald-400/40 px-2 py-0.5 text-[11px] text-emerald-100 transition-colors hover:bg-emerald-900/40"
							>
								試用
							</button>
						</div>
					)}
					{blocked && (
						<p className="text-[10px] leading-relaxed text-slate-500">
							審計結論為 blocked，安裝不會發起請求；如果你認為誤判，請讓作者修正執行時或指令碼後再上架。
						</p>
					)}
				</div>
			)}
		</li>
	);
}
