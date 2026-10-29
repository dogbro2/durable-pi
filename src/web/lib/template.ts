/** 提示模板展開（v0.31.0）：把 `$1..$9`、`$@` / `$ARGUMENTS` 替換成引數。 */

/**
 * 展開模板。
 * - `$1`..`$9` 取對應引數
 * - `$@` / `$ARGUMENTS` 取全部引數（空格連線）
 * - 沒有對應引數時保留原樣，避免誤刪內容
 */
export function expandTemplate(content: string, args: string[] = []): string {
	const all = args.join(" ");
	return content
		.replace(/\$ARGUMENTS|\$@/g, all)
		.replace(/\$([1-9])/g, (whole, index: string) => {
			const value = args[Number(index) - 1];
			return value === undefined ? whole : value;
		});
}

/** 模板是否含佔位符。 */
export function hasPlaceholders(content: string): boolean {
	return /\$ARGUMENTS|\$@|\$[1-9]/.test(content);
}
