/**
 * 聊天輸入的內容塊（ADR-0001 §5.6 共享純函式）：有圖片時用塊陣列，否則純文本。
 * 原 `worker.ts` 的 toImageBlocks / userContent 原樣遷出，行為不變。
 */
export function toImageBlocks(images: string[] | undefined): { type: "image"; data: string; mimeType: string }[] {
	if (!images?.length) return [];
	const blocks: { type: "image"; data: string; mimeType: string }[] = [];
	for (const url of images.slice(0, 4)) {
		const match = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/.exec(url);
		if (!match) continue;
		blocks.push({ type: "image", data: match[2]!, mimeType: match[1]! });
	}
	return blocks;
}

export function userContent(
	message: string,
	images: string[] | undefined,
): string | { type: string; [key: string]: unknown }[] {
	const blocks = toImageBlocks(images);
	if (!blocks.length) return message;
	return [{ type: "text", text: message || "（圖片）" }, ...blocks];
}
