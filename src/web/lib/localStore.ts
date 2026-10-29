/**
 * Tolerant localStorage boolean read/write (silent fallback in private mode / when disabled).
 * Values are stored as "1" / "0"; anything else falls back to the provided default.
 */

export function loadBool(key: string, fallback: boolean): boolean {
	try {
		const raw = window.localStorage.getItem(key);
		if (raw === "1") return true;
		if (raw === "0") return false;
	} catch {
		// storage unavailable — use default
	}
	return fallback;
}

export function saveBool(key: string, value: boolean): void {
	try {
		window.localStorage.setItem(key, value ? "1" : "0");
	} catch {
		// storage unavailable — ignore
	}
}

/** 讀取布林值；從未設定過返回 null（用於區分「未設定」與「設定為 false」）。 */
export function loadBoolOrNull(key: string): boolean | null {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return null;
		return raw === "1" || raw === "true";
	} catch {
		return null;
	}
}
