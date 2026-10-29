/**
 * useSkillHub（NERE-54）：Skill Hub 列表的唯一讀取者。
 *
 * - 進入 Hub 檢視時取一次；篩選變化時帶查詢串重取（q 防抖 250ms），只有最後一次請求能落地。
 * - 服務端可能忽略篩選引數，所以本地再過濾一遍；兩邊都過濾時結果一致。
 * - tag / source 下拉的選項優先用響應的 `filters`（契約 §5.2），並與歷史響應取並集，
 *   避免服務端過濾後選項自己塌掉。
 * - 遠端目錄重新整理失敗時響應仍是 200 + `catalog.stale=true`：列表照常展示，只提示可能過期。
 * - 請求失敗保留上一份資料並給可重試的錯誤；首次失敗就是錯誤態，不會無限 loading。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import {
	filterHubSkills,
	parseHubPage,
	sortHubSkills,
	sourceHost,
	type SkillHubCatalog,
	type SkillHubFilters,
} from "../lib/skill-hub";
import type { SkillHubEntry } from "../types";

export interface SkillHubFacets {
	tags: string[];
	/** host，不是完整 URL。 */
	sources: string[];
}

export interface SkillHubState {
	/** 當前篩選後的條目（已按 audit 優先排序）。 */
	items: SkillHubEntry[];
	/** 下拉選項：響應 `filters` 與歷史出現過的 tag / source 並集。 */
	facets: SkillHubFacets;
	/** 遠端目錄重新整理失敗（契約 §5.2）：列表可用，但可能過期。 */
	catalogStale: boolean;
	status: "loading" | "ready" | "error";
	/** 最近一次失敗原因（有舊資料時仍保留清單）。 */
	error: string | null;
	/** 服務端返回的匹配總數（可能大於當前頁）。 */
	total: number;
	/** 最近一次響應裡的條目數：區分「首次載入」與「篩選後為空」。 */
	rawCount: number;
	reload: () => void;
}

function union(previous: readonly string[], next: readonly string[]): string[] {
	const seen = new Set(previous);
	for (const item of next) seen.add(item);
	return [...seen].sort((a, b) => a.localeCompare(b, "zh-TW"));
}

export function useSkillHub(filters: SkillHubFilters): SkillHubState {
	const [all, setAll] = useState<SkillHubEntry[]>([]);
	const [status, setStatus] = useState<SkillHubState["status"]>("loading");
	const [error, setError] = useState<string | null>(null);
	const [catalog, setCatalog] = useState<SkillHubCatalog | null>(null);
	const [total, setTotal] = useState(0);
	const [facets, setFacets] = useState<SkillHubFacets>({ tags: [], sources: [] });
	const [debouncedQuery, setDebouncedQuery] = useState(filters.q);
	/** 請求序號：篩選快速切換時丟棄過期響應。 */
	const requestRef = useRef(0);
	const facetsRef = useRef<SkillHubFacets>({ tags: [], sources: [] });

	useEffect(() => {
		const timer = setTimeout(() => setDebouncedQuery(filters.q), 250);
		return () => clearTimeout(timer);
	}, [filters.q]);

	const load = useCallback(async () => {
		const request = ++requestRef.current;
		setStatus("loading");
		setError(null);
		try {
			const response = await api.skillHub({
				q: debouncedQuery,
				runtime: filters.runtime,
				tag: filters.tag,
				audit: filters.audit,
				source: filters.source,
			});
			if (request !== requestRef.current) return;
			const page = parseHubPage(response);
			setAll(page.entries);
			setTotal(page.total);
			setCatalog(page.catalog);
			const derivedTags = page.entries.flatMap((entry) => entry.tags);
			const derivedSources = page.entries.map((entry) => sourceHost(entry.source)).filter(Boolean);
			const mergedFacets: SkillHubFacets = {
				tags: union(facetsRef.current.tags, page.options.tags.length > 0 ? page.options.tags : derivedTags),
				sources: union(
					facetsRef.current.sources,
					page.options.sources.length > 0 ? page.options.sources : derivedSources,
				),
			};
			facetsRef.current = mergedFacets;
			setFacets(mergedFacets);
			setStatus("ready");
		} catch (err) {
			if (request !== requestRef.current) return;
			setError(err instanceof Error && err.message ? err.message : "未知錯誤");
			setStatus("error");
		}
	}, [debouncedQuery, filters.runtime, filters.tag, filters.audit, filters.source]);

	// 0ms 延時讓 StrictMode 的重複掛載在第一輪被清理掉，只發一次請求。
	useEffect(() => {
		const timer = setTimeout(() => void load(), 0);
		return () => clearTimeout(timer);
	}, [load]);

	const reload = useCallback(() => {
		void load();
	}, [load]);

	const items = useMemo(
		() => sortHubSkills(filterHubSkills(all, filters)),
		// 逐欄位依賴：呼叫方每次渲染重建 filters 物件時不用重算。
		[all, filters.q, filters.runtime, filters.tag, filters.audit, filters.source],
	);

	return {
		items,
		facets,
		catalogStale: catalog?.stale === true,
		status,
		error,
		total,
		rawCount: all.length,
		reload,
	};
}
