import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { expandTemplate } from "../lib/template";
import { api } from "../lib/api";
import { Icon } from "./Icon";
import type { PromptInfo, SkillInfo } from "../types";

interface ComposerProps {
	pending: boolean;
	/** text 為文字，images 為 data URL 列表（v0.12.0，多模態）。 */
	onSend: (text: string, images: string[]) => void;
	onStop: () => void;
	/** 生成中插話（v0.34.0）：訊息進入當前這輪，模型在下一次工具呼叫後看到。 */
	onInterject?: (text: string) => void;
	/** 已安裝技能（v0.23.0）：輸入 / 喚起，選中後把「/技能名」寫進輸入框。 */
	skills: SkillInfo[];
	/** 提示模板（v0.31.0）：選中後把模板正文填進輸入框。 */
	prompts?: PromptInfo[];
	/** 模型與思考等級（v0.42.0）：從聊天頭部移到輸入框上方。 */
	sessionId: string;
	models: string[];
	model: string;
	onModelChange: (model: string) => void;
	thinkingLevel: string;
	onThinkingLevelChange: (level: string) => void;
	/** 每輪結束 +1，觸發上下文佔用重新整理。 */
	contextTick: number;
	/** 由空會話起步卡 / 「試用」預填的草稿；預填不觸發傳送。 */
	draft?: string | null;
	/** 每次 +1 都重新寫入 draft（NERE-59：連點同一個技能也要把游標移回末尾）。 */
	draftNonce?: number;
}

const MAX_IMAGES = 4;
/** 壓縮到最長邊 1568px，PNG 有透明保留 PNG，否則轉 JPEG。 */
const MAX_EDGE = 1568;

/** 讀檔案 → 縮放 → data URL；失敗返回 null。 */
function compressImage(file: File): Promise<string | null> {
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onerror = () => resolve(null);
		reader.onload = () => {
			const img = new Image();
			img.onerror = () => resolve(null);
			img.onload = () => {
				try {
					const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
					const canvas = document.createElement("canvas");
					canvas.width = Math.max(1, Math.round(img.width * scale));
					canvas.height = Math.max(1, Math.round(img.height * scale));
					const ctx = canvas.getContext("2d");
					if (!ctx) return resolve(null);
					ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
					// 有透明通道時保留 PNG，避免黑底
					const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
					let transparent = false;
					for (let i = 3; i < data.length; i += 4) {
						if (data[i]! < 255) {
							transparent = true;
							break;
						}
					}
					resolve(transparent ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.85));
				} catch {
					resolve(null);
				}
			};
			img.src = String(reader.result);
		};
		reader.readAsDataURL(file);
	});
}

const MAX_HEIGHT = 160;
/** 輸入框手動高度（v0.40.0）：拖動頂部手柄調整，雙擊恢復自動。 */
const MIN_INPUT_HEIGHT = 44;
const MAX_INPUT_HEIGHT = 480;
const INPUT_HEIGHT_KEY = "pi-harness.composer-height";

/** 千位壓縮：54.2k / 128k。 */
function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

function maxInputHeight(): number {
	if (typeof window === "undefined") return MAX_INPUT_HEIGHT;
	return Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, Math.round(window.innerHeight * 0.6)));
}

function readInputHeight(): number | null {
	try {
		const raw = Number(localStorage.getItem(INPUT_HEIGHT_KEY));
		if (!Number.isFinite(raw) || raw < MIN_INPUT_HEIGHT) return null;
		return Math.min(Math.round(raw), maxInputHeight());
	} catch {
		return null;
	}
}
const SKILL_MENU_LIMIT = 8;

/** 找出游標前正在輸入的 /技能 片段（行首或空格後）。 */
function detectSkillToken(value: string, caret: number): { start: number; query: string } | null {
	const upto = value.slice(0, caret);
	const match = /(^|\s)\/([^\s/]*)$/.exec(upto);
	if (!match) return null;
	return { start: upto.lastIndexOf("/"), query: match[2] ?? "" };
}

export function Composer({
	pending,
	onSend,
	onStop,
	onInterject,
	skills,
	prompts = [],
	sessionId,
	models,
	model,
	onModelChange,
	thinkingLevel,
	onThinkingLevelChange,
	contextTick,
	draft,
	draftNonce = 0,
}: ComposerProps) {
	const [text, setText] = useState("");
	const [images, setImages] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	/** 技能選單（v0.23.0）：{start, query} 記錄要替換的片段位置。 */
	const [skillMenu, setSkillMenu] = useState<{ start: number; query: string } | null>(null);
	const [skillIndex, setSkillIndex] = useState(0);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	/** 手動高度（v0.40.0）；null = 按內容自動伸縮。 */
	const [inputHeight, setInputHeight] = useState<number | null>(readInputHeight);
	const heightRef = useRef<number | null>(inputHeight);
	const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
	/**
	 * 上下文佔用（v0.42.0）：估算值，重新整理訊號來自每輪結束 / 手動壓縮。
	 * NERE-26：首屏只發一個 bootstrap 請求，首幀不自動取佔用；首次互動或輪次結束後再取。
	 */
	const [context, setContext] = useState<{ usedTokens: number; contextWindow: number; percent: number } | null>(null);
	const [contextReload, setContextReload] = useState(0);
	const [compactBusy, setCompactBusy] = useState(false);
	const lastContextSession = useRef(sessionId);

	useEffect(() => {
		if (!draft) return;
		setText(draft);
		setImages([]);
		setNotice(null);
		window.requestAnimationFrame(() => {
			const el = textareaRef.current;
			el?.focus();
			// 預填後游標落在末尾，使用者直接接著輸入（驗收 2）。
			el?.setSelectionRange(draft.length, draft.length);
		});
	}, [draft, draftNonce]);

	useEffect(() => {
		// NERE-26：首屏請求只保留 /api/bootstrap，上下文佔用推遲到切換會話、
		// 點選重新整理或一輪結束（contextTick）之後再取；首幀顯示 “—”。
		// 用上一次的 sessionId 判斷，避免 StrictMode 雙跑 effect 時漏過首幀。
		const sessionChanged = lastContextSession.current !== sessionId;
		lastContextSession.current = sessionId;
		if (!sessionChanged && contextTick === 0 && contextReload === 0) return;
		let alive = true;
		void (async () => {
			try {
				const data = await api.context(sessionId);
				if (alive) setContext(data);
			} catch {
				if (alive) setContext(null);
			}
		})();
		return () => {
			alive = false;
		};
	}, [sessionId, contextTick, contextReload]);

	// 手動壓縮是非同步任務：15 秒內輪詢佔用，按鈕恢復後停止
	useEffect(() => {
		if (!compactBusy) return;
		const interval = window.setInterval(() => setContextReload((n) => n + 1), 2500);
		const stop = window.setTimeout(() => setCompactBusy(false), 15000);
		return () => {
			window.clearInterval(interval);
			window.clearTimeout(stop);
		};
	}, [compactBusy]);

	const compactContext = () => {
		if (compactBusy || pending) return;
		if (!window.confirm("壓縮當前會話上下文？較早的內容會摘要成一條記錄，最近訊息保留原文。")) return;
		setCompactBusy(true);
		void api.compact(sessionId).catch(() => setCompactBusy(false));
	};

	const percent = context?.percent ?? 0;
	const contextTone = !context
		? "border-slate-700 text-slate-500"
		: percent >= 85
			? "border-rose-500/40 bg-rose-500/10 text-rose-300"
			: percent >= 60
				? "border-amber-500/40 bg-amber-500/10 text-amber-300"
				: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";

	type MenuItem = { kind: "skill" | "prompt"; name: string; description: string; content?: string };
	const candidates: MenuItem[] = [
		...skills.map((s) => ({ kind: "skill" as const, name: s.name, description: s.description ?? "" })),
		...prompts.map((p) => ({ kind: "prompt" as const, name: p.name, description: p.description ?? "", content: p.content })),
	];
	const matches = skillMenu
		? candidates
				.filter((item) => {
					const q = skillMenu.query.toLowerCase();
					if (!q) return true;
					return item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);
				})
				.slice(0, SKILL_MENU_LIMIT)
		: [];
	const menuOpen = skillMenu !== null && matches.length > 0;

	/** 選中條目：技能寫「/技能名 」，提示模板把正文填進輸入框。 */
	const pickItem = (item: MenuItem) => {
		const el = textareaRef.current;
		const start = skillMenu?.start ?? 0;
		const caret = el?.selectionStart ?? text.length;
		const replacement = item.kind === "skill" ? `/${item.name} ` : expandTemplate(item.content ?? "");
		const next = `${text.slice(0, start)}${replacement}${text.slice(caret)}`;
		setText(next);
		setSkillMenu(null);
		setSkillIndex(0);
		window.requestAnimationFrame(() => {
			const pos = start + replacement.length;
			el?.focus();
			el?.setSelectionRange(pos, pos);
		});
	};

	const addFiles = (files: FileList | File[]) => {
		const list = Array.from(files).filter((f) => /^image\/(png|jpe?g|webp)$/.test(f.type));
		if (!list.length) return;
		void (async () => {
			setBusy(true);
			setNotice(null);
			const room = MAX_IMAGES - images.length;
			if (room <= 0) {
				setNotice(`最多 ${MAX_IMAGES} 張圖片`);
				setBusy(false);
				return;
			}
			const accepted = list.slice(0, room);
			if (list.length > room) setNotice(`最多 ${MAX_IMAGES} 張，已保留前 ${room} 張`);
			const results = await Promise.all(accepted.map(compressImage));
			const ok = results.filter((v): v is string => Boolean(v));
			if (ok.length < results.length) setNotice("部分圖片壓縮失敗，已跳過");
			setImages((prev) => [...prev, ...ok].slice(0, MAX_IMAGES));
			setBusy(false);
		})();
	};

	// 輸入內容變化（含傳送後清空）時自適應高度；手動高度優先，只做 DOM 操作，不 setState
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		if (inputHeight != null) {
			el.style.height = `${inputHeight}px`;
			return;
		}
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
	}, [text, inputHeight]);

	const applyHeight = (next: number) => {
		const clamped = Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, maxInputHeight(), Math.round(next)));
		heightRef.current = clamped;
		setInputHeight(clamped);
	};

	const persistInputHeight = () => {
		try {
			if (heightRef.current == null) localStorage.removeItem(INPUT_HEIGHT_KEY);
			else localStorage.setItem(INPUT_HEIGHT_KEY, String(heightRef.current));
		} catch {
			// 無 localStorage 時只在本次會話生效
		}
	};

	const startResize = (event: PointerEvent<HTMLButtonElement>) => {
		const el = textareaRef.current;
		dragRef.current = { startY: event.clientY, startHeight: inputHeight ?? el?.offsetHeight ?? MIN_INPUT_HEIGHT };
		event.currentTarget.setPointerCapture(event.pointerId);
		event.preventDefault();
	};

	const resizeMove = (event: PointerEvent<HTMLButtonElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		applyHeight(drag.startHeight - (event.clientY - drag.startY));
	};

	const endResize = (event: PointerEvent<HTMLButtonElement>) => {
		if (!dragRef.current) return;
		dragRef.current = null;
		try {
			event.currentTarget.releasePointerCapture(event.pointerId);
		} catch {
			// 指標已釋放
		}
		persistInputHeight();
	};

	const resetInputHeight = () => {
		dragRef.current = null;
		heightRef.current = null;
		setInputHeight(null);
		persistInputHeight();
	};

	const nudgeInputHeight = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
		event.preventDefault();
		const el = textareaRef.current;
		applyHeight((heightRef.current ?? el?.offsetHeight ?? MIN_INPUT_HEIGHT) + (event.key === "ArrowUp" ? 16 : -16));
		persistInputHeight();
	};

	const submit = () => {
		const trimmed = text.trim();
		if ((!trimmed && !images.length) || pending || busy) return;
		onSend(trimmed, images);
		setText("");
		setImages([]);
		setNotice(null);
	};

	/** 生成中插話：把當前文字送進本輪，不清空技能選單狀態之外的東西。 */
	const interject = () => {
		const trimmed = text.trim();
		if (!trimmed || !pending || busy || !onInterject) return;
		onInterject(trimmed);
		setText("");
		setNotice(null);
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		// 技能選單開啟時，方向鍵/回車/Tab 歸選單用
		if (menuOpen) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setSkillIndex((i) => (i + 1) % matches.length);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setSkillIndex((i) => (i - 1 + matches.length) % matches.length);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				pickItem(matches[Math.min(skillIndex, matches.length - 1)]!);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setSkillMenu(null);
				return;
			}
		}
		// Enter 傳送，Shift+Enter 換行；輸入法選字確認的 Enter 不傳送
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			// 生成中且有內容 → 插話；否則按傳送/忽略
			if (pending && text.trim() && onInterject) interject();
			else submit();
		}
	};

	/** 輸入變化時判斷是否要彈出技能選單。 */
	const handleChange = (value: string, caret: number) => {
		setText(value);
		if (!skills.length && !prompts.length) {
			setSkillMenu(null);
			return;
		}
		const token = detectSkillToken(value, caret);
		if (!token) {
			setSkillMenu(null);
			return;
		}
		setSkillMenu(token);
		setSkillIndex(0);
	};

	/** 點技能按鈕：在游標處插入「/」並展開選單。 */
	const openSkillMenu = () => {
		if (!skills.length && !prompts.length) {
			setNotice("還沒有技能或模板，先在左側「技能」面板裡新增。");
			return;
		}
		const el = textareaRef.current;
		const caret = el?.selectionStart ?? text.length;
		const before = text.slice(0, caret);
		const prefix = before && !/\s$/.test(before) ? " /" : "/";
		const next = `${before}${prefix}${text.slice(caret)}`;
		setText(next);
		setSkillMenu({ start: before.length + prefix.length - 1, query: "" });
		setSkillIndex(0);
		window.requestAnimationFrame(() => {
			const pos = before.length + prefix.length;
			el?.focus();
			el?.setSelectionRange(pos, pos);
		});
	};

	return (
		<div className="shrink-0 border-t border-slate-800 bg-slate-900/80 backdrop-blur">
			{(images.length > 0 || notice) && (
				<div className="mx-auto w-full max-w-3xl px-4 pt-2 sm:border-x sm:border-slate-800/60">
					{notice && <p className="mb-1 text-[11px] text-amber-300">{notice}</p>}
					<div className="flex flex-wrap gap-2">
						{images.map((src, index) => (
							<span key={`${src.slice(0, 32)}-${index}`} className="relative">
								<img src={src} alt={`待發送圖片 ${index + 1}`} className="h-14 w-14 rounded-lg border border-slate-700 object-cover" />
								<button
									type="button"
									onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
									aria-label={`移除圖片 ${index + 1}`}
									className="absolute -right-1 -top-1 h-4 w-4 rounded-full bg-slate-700 text-[10px] leading-none text-slate-100"
								>
									×
								</button>
							</span>
						))}
					</div>
				</div>
			)}
			<div className="relative mx-auto w-full max-w-3xl px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:border-x sm:border-slate-800/60">
				<button
					type="button"
					aria-label="調整輸入框高度：拖動，雙擊恢復自動"
					title="拖動調整高度，雙擊恢復自動"
					onPointerDown={startResize}
					onPointerMove={resizeMove}
					onPointerUp={endResize}
					onPointerCancel={endResize}
					onDoubleClick={resetInputHeight}
					onKeyDown={nudgeInputHeight}
					className="mx-auto flex h-3 w-16 cursor-row-resize touch-none items-center justify-center rounded text-slate-600 transition-colors hover:text-slate-400 focus:outline-none focus-visible:text-sky-400"
				>
					<Icon name="grip" className="h-3.5 w-3.5" />
				</button>
				<div className="flex flex-wrap items-center justify-end gap-1.5 pb-1.5">
					<label className="inline-flex items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-1 text-[11px] text-sky-300">
						<Icon name="model" className="h-3 w-3 shrink-0" />
						<select
							value={model}
							onChange={(event) => onModelChange(event.target.value)}
							aria-label="選擇模型"
							className="max-w-[8.5rem] cursor-pointer appearance-none bg-transparent text-[11px] font-medium text-sky-300 outline-none"
						>
							{(models.length ? models : [model]).map((id) => (
								<option key={id} value={id} className="bg-slate-900 text-slate-100">
									{id}
								</option>
							))}
						</select>
						<Icon name="chevronDown" className="h-3 w-3 shrink-0 opacity-60" />
					</label>
					<label className="inline-flex items-center gap-1 rounded-md border border-violet-500/30 bg-violet-500/10 px-1.5 py-1 text-[11px] text-violet-300">
						<Icon name="thinking" className="h-3 w-3 shrink-0" />
						<select
							value={thinkingLevel}
							onChange={(event) => onThinkingLevelChange(event.target.value)}
							aria-label="思考等級"
							className="cursor-pointer appearance-none bg-transparent text-[11px] font-medium text-violet-300 outline-none"
						>
							<option value="off" className="bg-slate-900 text-slate-100">
								不思考
							</option>
							<option value="low" className="bg-slate-900 text-slate-100">
								低思考
							</option>
							<option value="high" className="bg-slate-900 text-slate-100">
								高思考
							</option>
						</select>
						<Icon name="chevronDown" className="h-3 w-3 shrink-0 opacity-60" />
					</label>
					<button
						type="button"
						onClick={() => setContextReload((n) => n + 1)}
						title="上下文佔用（估算）：點選重新整理"
						className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] tabular-nums transition-colors ${contextTone}`}
					>
						<span className="h-1.5 w-8 overflow-hidden rounded-full bg-slate-700/60">
							<span
								className="block h-full rounded-full bg-current transition-[width]"
								style={{ width: `${percent}%` }}
							/>
						</span>
						{context ? `${percent}%` : "—"}
						<span className="hidden text-[10px] opacity-70 sm:inline">
							{context ? `${formatTokens(context.usedTokens)}/${formatTokens(context.contextWindow)}` : ""}
						</span>
					</button>
					<button
						type="button"
						onClick={compactContext}
						disabled={compactBusy || pending}
						title="壓縮上下文：把較早內容摘要成一條記錄"
						className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-1.5 py-1 text-[11px] text-slate-300 transition-colors hover:border-sky-500/50 hover:text-sky-300 disabled:opacity-50"
					>
						<Icon name="compact" className="h-3 w-3" />
						<span className="hidden sm:inline">{compactBusy ? "壓縮中…" : "壓縮"}</span>
					</button>
				</div>
				<div className="flex items-end gap-2 pt-1">
				{/* 技能選單（v0.23.0）：輸入 / 自動彈出 */}
				{menuOpen && (
					<div
						role="listbox"
						aria-label="選擇技能或模板"
						className="absolute bottom-full left-4 right-4 mb-1 max-h-64 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-1 shadow-2xl"
					>
						<p className="px-2 py-1 text-[11px] text-slate-500">選擇技能 / 模板 · ↑↓ 選擇，Enter 確認，Esc 取消</p>
						{matches.map((item, index) => (
							<button
								key={`${item.kind}-${item.name}`}
								type="button"
								role="option"
								aria-selected={index === skillIndex}
								onMouseEnter={() => setSkillIndex(index)}
								onMouseDown={(e) => {
									e.preventDefault();
									pickItem(item);
								}}
								className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
									index === skillIndex ? "bg-sky-600/20 text-sky-100" : "text-slate-300 hover:bg-slate-800"
								}`}
							>
								<span aria-hidden className="mt-0.5 shrink-0 text-slate-400">
									<Icon name={item.kind === "skill" ? "skills" : "prompt"} className="h-3.5 w-3.5" />
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[13px] font-medium">{item.name}</span>
									{item.description && (
										<span className="block truncate text-[11px] text-slate-500">{item.description}</span>
									)}
								</span>
							</button>
						))}
					</div>
				)}
				<button
					type="button"
					onClick={openSkillMenu}
					title="呼叫技能（也可以直接輸入 /）"
					aria-label="呼叫技能"
					className="mb-1 inline-flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-lg border border-slate-700 text-slate-400 transition-colors hover:text-slate-100"
				>
					<Icon name="skills" className="h-4 w-4" />
				</button>
				<button
					type="button"
					onClick={() => fileRef.current?.click()}
					disabled={busy || images.length >= MAX_IMAGES}
					title="新增圖片"
					aria-label="新增圖片"
					className="mb-1 inline-flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-lg border border-slate-700 text-slate-400 transition-colors hover:text-slate-100 disabled:opacity-40"
				>
					<Icon name="attach" className="h-4 w-4" />
				</button>
				<input
					ref={fileRef}
					type="file"
					accept="image/png,image/jpeg,image/webp"
					multiple
					hidden
					onChange={(event) => {
						if (event.target.files?.length) addFiles(event.target.files);
						event.target.value = "";
					}}
				/>
				<textarea
					ref={textareaRef}
					value={text}
					onChange={(event) => handleChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
					onClick={(event) => {
						// 點回已有文本時不誤開選單
						const el = event.currentTarget;
						if (skillMenu) setSkillMenu(detectSkillToken(el.value, el.selectionStart ?? 0));
					}}
					onBlur={() => setSkillMenu(null)}
					onKeyDown={handleKeyDown}
					onPaste={(event) => {
						const files = Array.from(event.clipboardData?.files ?? []);
						if (files.length) {
							event.preventDefault();
							addFiles(files);
						}
					}}
					rows={1}
					placeholder={
						pending ? (onInterject ? "生成中：輸入內容可插話，Enter 插入本輪" : "等待回覆中…") : "輸入訊息，/ 呼叫技能或模板，Enter 傳送"
					}
					aria-label="訊息輸入框"
					className="min-h-[44px] flex-1 resize-none rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-[16px] leading-relaxed text-slate-100 outline-none transition-colors placeholder:text-slate-500 focus:border-sky-500/70 focus:ring-1 focus:ring-sky-500/40 sm:text-[15px]"
				/>
				{pending && onInterject && text.trim() && (
					<button
						type="button"
						onClick={interject}
						disabled={busy}
						aria-label="插話到當前這輪"
						title="插話：模型會在下一次工具呼叫後看到（不中斷當前這輪）"
						className="h-[44px] shrink-0 rounded-xl bg-amber-600 px-4 text-sm font-medium text-white transition-colors hover:bg-amber-500 disabled:opacity-40"
					>
						插話
					</button>
				)}
				{pending ? (
					<button
						type="button"
						onClick={onStop}
						aria-label="停止等待本次回覆"
						className="h-[44px] shrink-0 rounded-xl border border-slate-600 bg-slate-700 px-4 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-600"
					>
						停止
					</button>
				) : (
					<button
						type="button"
						onClick={submit}
						disabled={(!text.trim() && !images.length) || busy}
						className="h-[44px] shrink-0 rounded-xl bg-sky-600 px-4 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
					>
						傳送
					</button>
					)}
				</div>
			</div>
		</div>
	);
}
