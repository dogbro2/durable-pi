/**
 * useSettingsData（NERE-81）：設定彈窗的全部服務端讀寫。
 *
 * 分層約束（ADR-0002）：`api.*` 只出現在 hooks 層。SettingsDialog 以前把 16 處呼叫
 * 散在多個 Section 裡，頁面層無法判斷「開啟設定會不會打介面」；這裡按資源拆成幾個
 * 內部 hook，再由 `useSettingsData` 彙總成一個返回值：
 * - 部署自檢：providers / models / kbStatus / version（`kbRetrieval` 直接吃 bootstrap）；
 * - pi 核心版本、知識庫索引狀態、工具清單、供應商、手動壓縮；
 * - 分享署名與預設有效期不在這裡：它們在 App 裡屬於 bootstrap 的 `settings` 面板。
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

export type SettingsTab = "general" | "chat" | "model" | "memory" | "data";

type ProviderInfo = {
	id: string;
	name: string;
	baseUrl: string;
	models: string[];
	keyHint?: string;
	active?: boolean;
};

export type CheckState = "loading" | "ok" | "warning" | "error";

export type DeploymentCheckRow = {
	label: string;
	state: CheckState;
	detail: string;
	fix?: string;
};

type KernelInfo = {
	current?: Record<string, string>;
	latest?: Record<string, string>;
	checkedAt?: string;
	updateAvailable?: boolean;
	outdated?: string[];
	upgrade?: { manual?: string; auto?: string };
};

export type KbIndexStatus = { mode?: string; available?: boolean; index?: string; total?: number; indexed?: number };

export type ToolPolicyRow = { name: string; category: string; policy: string; override: string };

export type ProviderForm = { id?: string; name: string; baseUrl: string; apiKey: string; models: string };

/** 部署自檢：只在「通用」tab 開啟時跑一組只讀探測。 */
function useDeploymentCheck(open: boolean, tab: SettingsTab, kbRetrieval: string) {
	const [rows, setRows] = useState<DeploymentCheckRow[]>([]);
	const [checking, setChecking] = useState(false);

	const check = useCallback(async () => {
		setChecking(true);
		setRows([
			{ label: "模型金鑰", state: "loading", detail: "正在檢查…" },
			{ label: "模型供應商", state: "loading", detail: "正在檢查…" },
			{ label: "知識庫檢索", state: "loading", detail: "正在檢查…" },
			{ label: "分享域名", state: "loading", detail: "正在檢查…" },
			{ label: "線上構建號", state: "loading", detail: "正在檢查…" },
		]);

		const [providers, models, kb, version] = await Promise.allSettled([
			api.providers(),
			api.models(),
			api.kbStatus(),
			api.version(),
		]);
		const providerData = providers.status === "fulfilled" ? providers.value : null;
		const modelData = models.status === "fulfilled" ? models.value : null;
		const kbData = kb.status === "fulfilled" ? kb.value : null;
		const versionData = version.status === "fulfilled" ? version.value : null;
		const activeId = providerData?.active || modelData?.provider || "";
		const customProvider = providerData?.providers?.find((provider) => provider.id === activeId);
		// `hasKey` 是已有 providers 響應在可提供時的非敏感布林值；絕不讀取或展示金鑰本身。
		const hasKey = customProvider?.hasKey;
		const providerReachable = Boolean(providerData && modelData && customProvider);
		// 檢索模式用頁面層已有的 bootstrap 設定，不再單獨拉一次 /api/settings。
		const kbMode = kbRetrieval || kbData?.mode;
		const kbReady = Boolean(kbData && (kbMode === "fts" || kbData.available));
		const origin = typeof window === "undefined" ? "" : window.location.origin;
		const build = versionData?.build?.trim() ?? "";

		setRows([
			{
				label: "模型金鑰",
				state: hasKey === false ? "warning" : hasKey === true ? "ok" : providerData ? "warning" : "error",
				detail:
					!customProvider
						? "尚未配置模型供應商。"
						: hasKey === false
							? "供應商缺少 API Key。"
							: hasKey === true
								? "已配置，金鑰不會在瀏覽器中顯示。"
								: "供應商未返回金鑰狀態。",
				fix: !customProvider || hasKey === false ? "在 設定 → 模型 新增供應商（Base URL / API Key / 模型 ID）。" : undefined,
			},
			{
				label: "模型供應商",
				state: providerReachable ? "ok" : providerData ? "warning" : "error",
				detail: providerReachable ? `當前使用 ${activeId}。` : "尚未配置模型供應商。",
				fix: providerReachable ? undefined : "在 設定 → 模型 新增供應商後重試。",
			},
			{
				label: "知識庫檢索",
				state: kbReady ? "ok" : kbData ? "warning" : "error",
				detail: kbReady ? `檢索模式：${kbMode ?? "fts"}。` : kbData ? "向量檢索繫結未啟用。" : "無法讀取知識庫狀態。",
				fix: kbReady ? undefined : "當前部署未繫結 Workers AI / Vectorize，使用 FTS 關鍵詞檢索即可。",
			},
			{
				label: "分享域名",
				state: origin ? "ok" : "error",
				detail: origin ? `公開連結將使用 ${origin}。` : "無法識別當前站點域名。",
			},
			{
				label: "線上構建號",
				state: build && build !== "dev" ? "ok" : build ? "warning" : "error",
				detail: build ? (build === "dev" ? "當前為本地開發構建。" : `SHA：${build.slice(0, 7)}。`) : "無法讀取構建號。",
				fix: build && build !== "dev" ? undefined : "重新部署後確認 BUILD 注入了當前提交 SHA。",
			},
		]);
		setChecking(false);
	}, [kbRetrieval]);

	useEffect(() => {
		if (!open || tab !== "general") return;
		void check();
	}, [open, tab, check]);

	return { rows, checking, recheck: check };
}

/** pi 核心版本：開啟設定時讀一次（走 6 小時快取）。 */
function useKernelInfo(open: boolean) {
	const [kernel, setKernel] = useState<KernelInfo | null>(null);
	const [kernelBusy, setKernelBusy] = useState(false);

	const loadKernel = async (refresh: boolean) => {
		setKernelBusy(true);
		try {
			setKernel(await api.kernel(refresh));
		} catch {
			setKernel(null);
		} finally {
			setKernelBusy(false);
		}
	};

	useEffect(() => {
		if (!open) return;
		let alive = true;
		void (async () => {
			try {
				const data = await api.kernel(false);
				if (alive) setKernel(data);
			} catch {
				// 介面不可用時保持空
			}
		})();
		return () => {
			alive = false;
		};
	}, [open]);

	return { kernel, kernelBusy, loadKernel };
}

/** 手動壓縮：只在「對話」tab 裡由按鈕觸發。 */
function useCompaction(sessionId: string) {
	const [compactState, setCompactState] = useState<"idle" | "running" | "done" | "error">("idle");
	const [compactMessage, setCompactMessage] = useState("");

	const compactNow = async () => {
		setCompactState("running");
		setCompactMessage("");
		try {
			const res = await api.compact(sessionId);
			if (res.error) {
				setCompactState("error");
				setCompactMessage(res.error);
			} else {
				setCompactState("done");
				setCompactMessage("已提交壓縮任務，完成後聊天裡會出現提示。");
			}
		} catch (err) {
			setCompactState("error");
			setCompactMessage(err instanceof Error ? err.message : String(err));
		}
	};

	return { compactState, compactMessage, compactNow };
}

/** 知識庫向量索引狀態（「對話」tab）。 */
function useKbIndexStatus(open: boolean, tab: SettingsTab) {
	const [kbStatus, setKbStatus] = useState<KbIndexStatus | null>(null);
	const [kbReindexBusy, setKbReindexBusy] = useState(false);
	const [kbReindexMessage, setKbReindexMessage] = useState("");

	useEffect(() => {
		if (!open || tab !== "chat") return;
		let alive = true;
		void (async () => {
			try {
				const data = await api.kbStatus();
				if (alive) setKbStatus(data);
			} catch {
				if (alive) setKbStatus(null);
			}
		})();
		return () => {
			alive = false;
		};
	}, [open, tab]);

	const reindexKb = () => {
		if (kbReindexBusy) return;
		setKbReindexBusy(true);
		setKbReindexMessage("");
		void (async () => {
			try {
				const data = await api.kbReindex();
				if (data.error) throw new Error(data.error);
				const remaining = Number(data.remaining ?? 0);
				setKbReindexMessage(
					`已索引 ${data.indexed ?? 0} 段${remaining > 0 ? `，剩餘 ${remaining} 段，再點一次繼續` : "，全部完成"}`,
				);
				setKbStatus(await api.kbStatus());
			} catch (err) {
				setKbReindexMessage(err instanceof Error ? err.message : String(err));
			} finally {
				setKbReindexBusy(false);
			}
		})();
	};

	return { kbStatus, kbReindexBusy, kbReindexMessage, reindexKb };
}

/** 工具清單（「對話」tab）：逐工具審批覆蓋的選擇項。 */
function useToolList(open: boolean, tab: SettingsTab) {
	const [toolList, setToolList] = useState<ToolPolicyRow[]>([]);

	useEffect(() => {
		if (!open || tab !== "chat") return;
		let alive = true;
		void (async () => {
			try {
				const data = await api.tools();
				if (alive && Array.isArray(data.tools)) setToolList(data.tools);
			} catch {
				// 介面不可用時保持空列表
			}
		})();
		return () => {
			alive = false;
		};
	}, [open, tab]);

	return { toolList, setToolList };
}

/** 供應商（「模型」tab）：列表 / 啟用 / 新增 / 編輯 / 刪除。 */
function useProviders(open: boolean, tab: SettingsTab, onModelsChanged?: () => void) {
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [activeProvider, setActiveProvider] = useState("");
	const [providersLoading, setProvidersLoading] = useState(false);
	const [providerError, setProviderError] = useState<string | null>(null);
	const [providerBusy, setProviderBusy] = useState(false);
	const [form, setForm] = useState<ProviderForm | null>(null);

	const loadProviders = async () => {
		setProvidersLoading(true);
		try {
			const data = await api.providers();
			setProviders(Array.isArray(data.providers) ? data.providers : []);
			setActiveProvider(data.active ?? "");
			setProviderError(null);
		} catch (err) {
			setProviderError(err instanceof Error ? err.message : String(err));
		} finally {
			setProvidersLoading(false);
		}
	};

	useEffect(() => {
		if (open && tab === "model") void loadProviders();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, tab]);

	const activateProvider = async (id: string) => {
		if (providerBusy) return;
		setProviderBusy(true);
		try {
			await api.activateProvider(id);
			await loadProviders();
			onModelsChanged?.();
		} catch (err) {
			setProviderError(err instanceof Error ? err.message : String(err));
		} finally {
			setProviderBusy(false);
		}
	};

	const saveProvider = async () => {
		if (!form || providerBusy) return;
		setProviderBusy(true);
		try {
			await api.saveProvider({
				id: form.id,
				name: form.name,
				baseUrl: form.baseUrl,
				apiKey: form.apiKey,
				models: form.models,
			});
			setForm(null);
			await loadProviders();
			onModelsChanged?.();
		} catch (err) {
			setProviderError(err instanceof Error ? err.message : String(err));
		} finally {
			setProviderBusy(false);
		}
	};

	const removeProvider = async (id: string, name: string) => {
		if (!window.confirm(`刪除供應商「${name}」？`)) return;
		setProviderBusy(true);
		try {
			await api.deleteProvider(id);
			await loadProviders();
			onModelsChanged?.();
		} catch (err) {
			setProviderError(err instanceof Error ? err.message : String(err));
		} finally {
			setProviderBusy(false);
		}
	};

	return {
		providers,
		activeProvider,
		providersLoading,
		providerError,
		providerBusy,
		form,
		setForm,
		activateProvider,
		saveProvider,
		removeProvider,
	};
}

export function useSettingsData({
	open,
	tab,
	sessionId,
	kbRetrieval,
	onModelsChanged,
}: {
	open: boolean;
	tab: SettingsTab;
	sessionId: string;
	/** bootstrap 裡已有的檢索模式：部署自檢不再單獨請求 /api/settings。 */
	kbRetrieval: string;
	onModelsChanged?: () => void;
}) {
	const deployment = useDeploymentCheck(open, tab, kbRetrieval);
	const kernel = useKernelInfo(open);
	const compaction = useCompaction(sessionId);
	const kbIndex = useKbIndexStatus(open, tab);
	const tools = useToolList(open, tab);
	const providers = useProviders(open, tab, onModelsChanged);

	return { deployment, kernel, compaction, kbIndex, tools, providers };
}
