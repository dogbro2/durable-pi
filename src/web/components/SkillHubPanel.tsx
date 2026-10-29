/**
 * 左欄「技能 · Hub」檢視（NERE-54，L2）：市場列表 + 篩選 + 審計狀態 + 詳情/安裝。
 *
 * - 取數只經 `useSkillHub`，元件不拼介面、不直接 fetch。
 * - 安裝複用現有匯入流（`onInstall` → App 的 handleImportSkill）；blocked 條目按鈕停用。
 * - 安裝結果留在彈窗內（NERE-69）：成功 → 行內「已安裝 · 試用」；失敗 → 行內紅字取首條審計原因。
 * - 三態：首次載入骨架 / 失敗可重試 / 篩選後空態；舊資料在重新整理失敗時保留。
 */

import { useEffect, useMemo, useState } from "react";
import { useSkillHub } from "../hooks/useSkillHub";
import {
	EMPTY_SKILL_HUB_FILTERS,
	HUB_AUDIT_FILTERS,
	HUB_RUNTIME_FILTERS,
	canInstallHubEntry,
	hasActiveHubFilters,
	hubEntryInstallUrl,
	type SkillHubFilters,
} from "../lib/skill-hub";
import type { SkillHubEntry, SkillInstallOutcome } from "../types";
import { Icon } from "./Icon";
import { SkillHubRow } from "./SkillHubRow";

const CONTROL =
	"w-full min-w-0 rounded-md border border-slate-700 bg-slate-800/70 px-1.5 py-1 text-xs text-slate-100 placeholder:text-slate-500";

function FilterSelect({
	label,
	value,
	onChange,
	options,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	options: readonly { value: string; label: string }[];
}) {
	return (
		<select
			aria-label={label}
			title={label}
			value={value}
			onChange={(event) => onChange(event.target.value)}
			className={CONTROL}
		>
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	);
}

/** 模組級 UI 記憶（契約 §6.3）：Hub 篩選詞在彈窗關閉後保留；不做跨重新整理持久化。 */
const viewMemory = { filters: EMPTY_SKILL_HUB_FILTERS };

export function SkillHubPanel({
	installed,
	onInstall,
	onTry,
}: {
	/** 已安裝的技能名：用於「已安裝 / 重新安裝」標記。 */
	installed: string[];
	/** 現有匯入流（App.handleImportSkill），返回結構化結果供行內反饋。 */
	onInstall: (url: string) => Promise<SkillInstallOutcome>;
	/** 「試用」（NERE-69）：由頁面層關彈窗並預填 `/技能名 `。 */
	onTry: (name: string) => void;
}) {
	const [filters, setFilters] = useState<SkillHubFilters>(viewMemory.filters);
	useEffect(() => {
		viewMemory.filters = filters;
	}, [filters]);
	const { items, facets, catalogStale, status, error, rawCount, reload } = useSkillHub(filters);
	const [openName, setOpenName] = useState<string | null>(null);
	const [installing, setInstalling] = useState<string | null>(null);
	/** 本次會話剛裝成功的名字：面板不重取，立即把行切到「已安裝 · 試用」。 */
	const [installedHere, setInstalledHere] = useState<ReadonlySet<string>>(() => new Set());
	/** 本次會話的安裝失敗首因：按技能名保留，重試時清掉。 */
	const [installErrors, setInstallErrors] = useState<Readonly<Record<string, string>>>({});
	const installedSet = useMemo(
		() => new Set([...installed, ...installedHere]),
		[installed, installedHere],
	);
	const loading = status === "loading";
	const filtersActive = hasActiveHubFilters(filters);
	const firstLoad = loading && rawCount === 0;

	const patch = (key: keyof SkillHubFilters, value: string) => {
		setFilters((previous) => ({ ...previous, [key]: value }));
	};

	const install = (entry: SkillHubEntry) => {
		if (installing || !canInstallHubEntry(entry)) return;
		const url = hubEntryInstallUrl(entry);
		const name = entry.name;
		setInstalling(name);
		setInstallErrors((previous) => {
			if (!(name in previous)) return previous;
			const next = { ...previous };
			delete next[name];
			return next;
		});
		void (async () => {
			try {
				const result = await onInstall(url);
				if (result.ok) {
					setInstalledHere((previous) => new Set(previous).add(name));
				} else {
					setInstallErrors((previous) => ({ ...previous, [name]: result.message }));
				}
			} catch (err) {
				const message = err instanceof Error && err.message ? err.message : String(err);
				setInstallErrors((previous) => ({ ...previous, [name]: message }));
			} finally {
				// 失敗也要恢復可點（驗收 3）：不卡在「安裝中…」。
				setInstalling((current) => (current === name ? null : current));
			}
		})();
	};

	const tagOptions = [{ value: "", label: "全部標籤" }, ...facets.tags.map((tag) => ({ value: tag, label: tag }))];
	const sourceOptions = [{ value: "", label: "全部來源" }, ...facets.sources.map((source) => ({ value: source, label: source }))];

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 space-y-1.5 border-b border-slate-800/70 p-3">
				<input
					value={filters.q}
					onChange={(event) => patch("q", event.target.value)}
					placeholder="搜尋技能名稱、描述或標籤"
					aria-label="搜尋 Skill Hub"
					maxLength={100}
					className={CONTROL}
				/>
				<div className="grid grid-cols-2 gap-1.5">
					<FilterSelect
						label="按執行時篩選"
						value={filters.runtime}
						onChange={(value) => patch("runtime", value)}
						options={HUB_RUNTIME_FILTERS}
					/>
					<FilterSelect
						label="按審計狀態篩選"
						value={filters.audit}
						onChange={(value) => patch("audit", value)}
						options={HUB_AUDIT_FILTERS}
					/>
					<FilterSelect label="按標籤篩選" value={filters.tag} onChange={(value) => patch("tag", value)} options={tagOptions} />
					<FilterSelect label="按來源篩選" value={filters.source} onChange={(value) => patch("source", value)} options={sourceOptions} />
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={loading || undefined}>
				<p role="status" className="sr-only">
					{loading ? "正在載入技能列表" : `共 ${items.length} 條技能`}
				</p>

				{catalogStale && (
					<p
						role="status"
						className="mx-2 mt-2 rounded-md border border-amber-500/30 bg-amber-950/20 px-2 py-1.5 text-[11px] leading-relaxed text-amber-200"
					>
						目錄可能過期：遠端重新整理失敗，當前顯示內建或上次快照；已安裝技能仍可用。
					</p>
				)}

				{error && (
					<div
						role="alert"
						className="m-2 space-y-1.5 rounded-md border border-rose-500/30 bg-rose-950/30 px-2 py-1.5 text-[11px] text-rose-200"
					>
						<p>Hub 載入失敗：{error}</p>
						<button
							type="button"
							onClick={reload}
							className="rounded-md border border-rose-400/40 px-2 py-0.5 text-[11px] text-rose-100 transition-colors hover:bg-rose-900/40"
						>
							重試
						</button>
					</div>
				)}

				{firstLoad ? (
					<div className="space-y-2 p-2" aria-hidden>
						{[0, 1, 2].map((row) => (
							<div key={row} className="h-[74px] animate-pulse rounded-lg bg-slate-800/50" />
						))}
					</div>
				) : items.length > 0 ? (
					<ul className="space-y-1.5 p-2">
						{items.map((entry) => (
							<SkillHubRow
								key={entry.name}
								entry={entry}
								expanded={openName === entry.name}
								installed={installedSet.has(entry.name)}
								installedNow={installedHere.has(entry.name)}
								installing={installing === entry.name}
								installError={installErrors[entry.name] ?? null}
								onToggle={(name) => setOpenName((current) => (current === name ? null : name))}
								onInstall={install}
								onTry={onTry}
							/>
						))}
					</ul>
				) : status === "error" ? null : (
					<div className="p-3">
						<p className="text-xs leading-relaxed text-slate-500">
							{filtersActive ? "沒有匹配的技能。換個關鍵詞或清空篩選試試。" : "Hub 暫時沒有可用技能，稍後重新整理試試。"}
						</p>
						{filtersActive && (
							<button
								type="button"
								onClick={() => setFilters(EMPTY_SKILL_HUB_FILTERS)}
								className="mt-2 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200 transition-colors hover:bg-slate-800"
							>
								清空篩選
							</button>
						)}
					</div>
				)}

				{loading && !firstLoad && (
					<p className="flex items-center gap-1.5 px-2 pb-2 text-[10px] text-slate-500">
						<Icon name="loader" className="h-3 w-3 animate-spin" />
						正在重新整理篩選結果…
					</p>
				)}
			</div>
		</div>
	);
}
