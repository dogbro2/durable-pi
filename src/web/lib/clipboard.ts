/**
 * 複製純文本（NERE-43，R-FE-5）：平臺能力收口到 lib，新元件只從這裡取。
 * 安全上下文優先 Clipboard API；http 內網地址等場景退回 execCommand。
 * 既有 ShareLinkCard / ShareDialog / Composer 的 4 份實現本輪不動，全量收口歸 [ARCH] R1。
 */
export async function copyText(text: string): Promise<boolean> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// 無許可權 / 非安全上下文：落到下面的兜底
		}
	}
	if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.top = "0";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	try {
		textarea.select();
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		document.body.removeChild(textarea);
	}
}
