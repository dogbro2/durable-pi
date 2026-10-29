/**
 * 焦點工具（NERE-62）：可聚焦元素選擇器與索引推進。
 *
 * 純函式放這裡是為了單測（`tests/unit/modal.test.tsx`），DOM 焦點行為本身靠手動走查。
 */

/** 與契約 §4.3 一致：排除 disabled 與 tabindex="-1"。 */
export const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type FocusDirection = 1 | -1;

/**
 * Tab（+1）/ Shift+Tab（-1）在一個迴圈圈裡的下一個索引。
 * - count = 0：沒有可聚焦元素，返回 -1（呼叫方不要調 focus）。
 * - index 不在圈內（-1）：+1 落到第一個，-1 落到最後一個。
 * - 只有一個元素時兩個方向都停在 0。
 */
export function nextFocusIndex(direction: FocusDirection, index: number, count: number): number {
	if (count <= 0) return -1;
	if (index < 0 || index >= count) return direction > 0 ? 0 : count - 1;
	return (index + direction + count) % count;
}
