/**
 * 彈窗外殼（NERE-62）：遮罩、尺寸、header / close、焦點圈、Esc、滾動鎖、portal。
 *
 * 約束（契約 §2）：
 * - 只承載 UI，不出現 `api.` / `fetch(` / `"/api/`；
 * - 不做關閉動畫，`open=false` 直接卸掉；
 * - 內容區不滾動（`min-h-0 flex-1`），捲軸歸各面板自己。
 */

import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FOCUSABLE_SELECTOR, nextFocusIndex } from "../lib/focus";
import { useMediaQuery } from "../lib/useMediaQuery";
import { Icon } from "./Icon";

export type ModalSize = "md" | "lg" | "xl";

/** 尺寸單點定義（契約 §3.2）：md = MCP / lg = 知識庫 / xl = 技能。 */
export const MODAL_SIZE: Record<ModalSize, string> = {
	md: "w-[min(92vw,45rem)]",
	lg: "w-[min(92vw,55rem)]",
	xl: "w-[min(92vw,60rem)]",
};

/** 彈窗形態斷點（與三欄佈局的 DESKTOP_QUERY 無關）。 */
const SHEET_QUERY = "(max-width: 720px)";

// 模組級滾動鎖計數：為將來「彈窗裡再開一層」留出正確性（契約 §4.5）。
let lockCount = 0;
let overflowBeforeLock = "";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function focusableWithin(root: HTMLElement | null): HTMLElement[] {
	if (!root) return [];
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(element) => element.getClientRects().length > 0,
	);
}

export interface ModalShellProps {
	open: boolean;
	/** header 標題，同時作為 aria-labelledby 的文本來源（內部用 useId 生成 id）。 */
	title: string;
	/** md = 720px / lg = 880px / xl = 960px。 */
	size?: ModalSize;
	/** Esc、遮罩、關閉按鈕都收斂到這一個回撥。 */
	onClose: () => void;
	children: ReactNode;
	/** 可選底欄；不傳則不渲染。 */
	footer?: ReactNode;
	/** 覆蓋預設焦點落點（預設落到內容區第一個可聚焦元素）。 */
	initialFocusRef?: RefObject<HTMLElement | null>;
	/** 預設 true；匯入進行中等場景可關掉防誤觸。 */
	closeOnScrim?: boolean;
	/** 供測試 / 端到端定位。 */
	testId?: string;
	/**
	 * 觸發入口標識（"kb" / "mcp" / "skills"）：關閉時若原觸發元素已解除安裝
	 * （移動端抽屜裡的 Rail 會隨抽屜關閉而解除安裝），用 `[data-modal-trigger]` 兜底回焦。
	 */
	triggerKey?: string;
}

export function ModalShell({
	open,
	title,
	size = "md",
	onClose,
	children,
	footer,
	initialFocusRef,
	closeOnScrim = true,
	testId,
	triggerKey,
}: ModalShellProps) {
	const isSheet = useMediaQuery(SHEET_QUERY);
	const titleId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const triggerRef = useRef<HTMLElement | null>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// 進入：記錄觸發元素、鎖滾動、把 #root 移出可達樹、落焦。
	useIsomorphicLayoutEffect(() => {
		if (!open) return;
		const active = document.activeElement;
		triggerRef.current = active instanceof HTMLElement ? active : null;

		if (lockCount === 0) {
			overflowBeforeLock = document.body.style.overflow;
			document.body.style.overflow = "hidden";
		}
		lockCount += 1;

		const root = document.getElementById("root");
		root?.setAttribute("aria-hidden", "true");
		root?.setAttribute("inert", "");

		const firstInContent = focusableWithin(contentRef.current)[0];
		const target = initialFocusRef?.current ?? firstInContent ?? closeRef.current;
		target?.focus();

		return () => {
			lockCount -= 1;
			if (lockCount === 0) document.body.style.overflow = overflowBeforeLock;
			root?.removeAttribute("aria-hidden");
			root?.removeAttribute("inert");

			const trigger = triggerRef.current;
			const fallback = triggerKey ? document.querySelector<HTMLElement>(`[data-modal-trigger="${triggerKey}"]`) : null;
			const back = trigger?.isConnected ? trigger : fallback;
			back?.focus();
		};
		// 只跟隨 open：回撥變化不應觸發一次「回焦 + 再落焦」。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// Esc：document capture，命中即阻斷，避免分享 / 設定彈窗同時被關掉（契約 §4.1）。
	useEffect(() => {
		if (!open) return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onCloseRef.current();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [open]);

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Tab") return;
		const items = focusableWithin(dialogRef.current);
		if (items.length === 0) {
			event.preventDefault();
			return;
		}
		const current = document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
		const next = nextFocusIndex(event.shiftKey ? -1 : 1, current, items.length);
		if (next < 0) return;
		event.preventDefault();
		items[next]?.focus();
	};

	if (!open) return null;

	const dialog = (
		<div
			className={isSheet ? "fixed inset-0 z-40" : "fixed inset-0 z-40 flex items-center justify-center p-4"}
			data-testid={testId}
		>
			{/* 遮罩用按鈕：鍵盤使用者也能點到，且不需額外 tabIndex。 */}
			<button
				type="button"
				aria-label="關閉彈窗"
				onClick={() => {
					if (closeOnScrim) onClose();
				}}
				className="dialog-scrim absolute inset-0"
			/>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				onKeyDown={handleKeyDown}
				className={`modal-card relative flex flex-col overflow-hidden border border-slate-700 bg-slate-900 shadow-2xl ${
					isSheet
						? "h-[100dvh] w-screen rounded-none pb-[env(safe-area-inset-bottom)]"
						: `max-h-[90vh] rounded-2xl ${MODAL_SIZE[size]}`
				}`}
			>
				<header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800/70 px-5 py-3">
					<h2 id={titleId} className="text-sm font-semibold text-slate-100">
						{title}
					</h2>
					<button
						ref={closeRef}
						type="button"
						onClick={onClose}
						aria-label="關閉"
						className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white max-[720px]:h-11 max-[720px]:w-11"
					>
						<Icon name="close" className="h-4 w-4" />
					</button>
				</header>

				{/* 內容區不滾動：Shell 給 min-h-0 flex-1，捲軸歸面板。 */}
				<div ref={contentRef} className="flex min-h-0 flex-1 flex-col">
					{children}
				</div>

				{footer && <footer className="shrink-0 border-t border-slate-800/70 px-5 py-3">{footer}</footer>}
			</div>
		</div>
	);

	// SSR（renderToStaticMarkup）沒有 document：就地渲染，不做 portal。
	return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
