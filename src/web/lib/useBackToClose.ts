import { useEffect, useRef } from "react";

/**
 * 手機返回鍵 / 返回手勢關閉浮層（抽屜、彈窗）。
 *
 * 所有浮層共用一條歷史記錄：第一個浮層開啟時 pushState，返回時關閉最上層那個；
 * 用按鈕關掉最後一個浮層時，下一拍再退掉這條記錄。抽屜 → 彈窗這類同一次渲染裡
 * 「關一個開一個」的切換不會多退一步，也不會把新開的彈窗誤關。
 */
const stack: { close: () => void }[] = [];
let pushed = false;
let listening = false;
const MARK = "durablePiOverlay";

function onPopState() {
	if (!pushed) return;
	pushed = false;
	const top = stack[stack.length - 1];
	top?.close();
	// 還有別的浮層開著：重新佔一條記錄，下一次返回關它。
	queueMicrotask(() => {
		if (stack.length > 0 && !pushed) {
			window.history.pushState({ [MARK]: true }, "");
			pushed = true;
		}
	});
}

export function useBackToClose(open: boolean, onClose: () => void, enabled = true): void {
	const closeRef = useRef(onClose);
	closeRef.current = onClose;

	useEffect(() => {
		if (!open || !enabled || typeof window === "undefined") return;
		if (!listening) {
			window.addEventListener("popstate", onPopState);
			listening = true;
		}
		const entry = { close: () => closeRef.current() };
		stack.push(entry);
		if (!pushed) {
			window.history.pushState({ [MARK]: true }, "");
			pushed = true;
		}
		return () => {
			const index = stack.indexOf(entry);
			if (index >= 0) stack.splice(index, 1);
			setTimeout(() => {
				if (stack.length === 0 && pushed) {
					pushed = false;
					const state = window.history.state as Record<string, unknown> | null;
					if (state?.[MARK]) window.history.back();
				}
			}, 0);
		};
	}, [open, enabled]);
}
