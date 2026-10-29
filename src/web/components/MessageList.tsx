import { memo, useEffect, useRef } from "react";
import type { ChatMessage, FileInfo, KbRef, PlanStep } from "../types";
import { renderMarkdownCached, renderRichText } from "../lib/rich";
import { ToolBar } from "./ToolBar";
import { ThinkingBlock } from "./ThinkingBlock";
import { PlanCard } from "./PlanCard";
import { ArtifactCard } from "./ArtifactCard";
import { ShareLinkCard } from "./ShareLinkCard";
import { KbRefsBar } from "./KbRefsBar";
import { Icon } from "./Icon";

const AUTO_SCROLL_THRESHOLD = 80;

/**
 * 氣泡按 `message` 引用 memo（NERE-75 P1-2）：流式時只有當前氣泡物件會換新引用，
 * 歷史訊息保持同一物件，父元件因 elapsed 每秒重渲染時不會重複解析它們的 Markdown。
 */
const UserBubble = memo(function UserBubble({
	message,
	onBranch,
}: {
	message: Extract<ChatMessage, { role: "user" }>;
	/** 從這條訊息分叉（v0.32.0）：這條訊息之前的歷史會帶到新會話。 */
	onBranch?: (entryId: number) => void;
}) {
	return (
		<div className="group flex flex-col items-end gap-1.5">
			{message.images && message.images.length > 0 && (
				<div className="flex max-w-[85%] flex-wrap justify-end gap-1.5 sm:max-w-[72%]">
					{message.images.map((src, index) => (
						<img
							key={`${src.slice(0, 24)}-${index}`}
							src={src}
							alt={`圖片 ${index + 1}`}
							className="max-h-44 max-w-[12rem] rounded-xl border border-slate-700 object-cover"
						/>
					))}
				</div>
			)}
			{message.text && message.text !== "（圖片）" && (
				<div className="flex max-w-[85%] items-start justify-end gap-1.5 sm:max-w-[72%]">
					{onBranch && message.entryId !== undefined && (
						<button
							type="button"
							onClick={() => onBranch(message.entryId as number)}
							title="從這裡分叉：新建一個會話，帶上這條訊息之前的對話"
							aria-label="從這條訊息分叉"
							className="mt-1.5 shrink-0 rounded-md px-1.5 py-1 text-[11px] text-slate-500 opacity-0 transition-opacity hover:bg-slate-800 hover:text-sky-300 focus-visible:opacity-100 group-hover:opacity-100"
						>
							⑂ 分支
						</button>
					)}
					<div className="min-w-0 whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-sky-600 px-4 py-2.5 text-[15px] leading-relaxed text-white">
						{renderRichText(message.text)}
					</div>
				</div>
			)}
		</div>
	);
});

const AssistantBubble = memo(function AssistantBubble({
	message,
	streaming,
	onOpenFile,
	onOpenKbRef,
}: {
	message: Extract<ChatMessage, { role: "assistant" }>;
	streaming?: boolean;
	onOpenFile?: (name: string) => void;
	/** 點開參考資料裡的某一篇（NERE-41）。 */
	onOpenKbRef?: (ref: KbRef) => void;
}) {
	const hasBody = message.text.trim().length > 0 || !message.tools?.length;
	return (
		<div className="flex w-full flex-col items-start gap-1.5">
			{message.thinking && <ThinkingBlock text={message.thinking} streaming={streaming} />}
			{message.tools && message.tools.length > 0 && <ToolBar tools={message.tools} />}
			{message.files && message.files.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{message.files.map((file, index) => (
						<ArtifactCard key={`${file.name}-${index}`} file={file} onOpen={onOpenFile} />
					))}
				</div>
			)}
			{message.shares && message.shares.length > 0 && (
				<div className="flex w-full flex-wrap gap-2">
					{message.shares.map((link, index) => (
						<ShareLinkCard key={`${link.url}-${index}`} link={link} />
					))}
				</div>
			)}
			{hasBody && message.text.trim() && (
				<div
					className={`md-prose w-full break-words rounded-2xl rounded-bl-md border px-4 py-2.5 text-[15px] ${
						message.error
							? "border-red-500/40 bg-red-950/40 text-red-200"
							: "border-slate-700/60 bg-slate-800/80 text-slate-100"
					}`}
				>
					{renderMarkdownCached(message.text)}
				</div>
			)}
			<KbRefsBar refs={message.kbRefs ?? []} onOpen={onOpenKbRef} />
		</div>
	);
});

const NoticeBubble = memo(function NoticeBubble({ text }: { text: string }) {
	return <div className="self-center rounded-full bg-slate-800/60 px-3.5 py-1 text-xs text-slate-400">{text}</div>;
});

function PendingBubble({ elapsed, phase }: { elapsed: number; phase: "thinking" | "working" }) {
	return (
		<div className="flex flex-col items-start gap-1.5">
			<div className="flex items-center gap-2.5 self-start rounded-2xl rounded-bl-md border border-slate-700/60 bg-slate-800/80 px-4 py-2.5 text-sm text-slate-300">
				<span aria-hidden className="flex items-end gap-1">
					<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400" />
					<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:150ms]" />
					<span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:300ms]" />
				</span>
				<span>{phase === "thinking" ? "思考中…" : "執行中…"}</span>
				<span className="tabular-nums text-slate-500">{elapsed}s</span>
			</div>
		</div>
	);
}

/** 頂部常駐的計劃面板（v0.22.0）：全部完成後收起成一行。 */
function PlanPanel({ plan }: { plan: PlanStep[] }) {
	if (!plan.length) return null;
	const done = plan.filter((s) => s.status === "completed").length;
	const body =
		done === plan.length ? (
			<details className="rounded-xl border border-emerald-500/25 bg-emerald-950/20 px-3 py-1.5 text-xs text-emerald-200/80">
				<summary className="inline-flex cursor-pointer items-center gap-1.5">
					<Icon name="done" className="h-3.5 w-3.5 text-emerald-400" />
					計劃已完成（{plan.length} 步）
				</summary>
				<ul className="mt-1.5 space-y-0.5 text-[12.5px] text-slate-400">
					{plan.map((step, index) => (
						<li key={`${index}-${step.title}`} className="flex items-start gap-1.5">
							<Icon name="check" className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400/80" />
							<span>{step.title}</span>
						</li>
					))}
				</ul>
			</details>
		) : (
			<PlanCard steps={plan} />
		);
	// 吸頂：滾動檢視歷史時不丟掉當前進度（背景用不透明色，避免正文透出來）
	return <div className="sticky top-0 z-10 -mx-1 bg-slate-950 px-1 py-1">{body}</div>;
}

/** 本會話產出檔案（v0.22.0）：歷史回放時也能一鍵開啟工作臺預覽。 */
function ArtifactSummary({ files, onOpen }: { files: FileInfo[]; onOpen?: (name: string) => void }) {
	if (files.length === 0) return null;
	return (
		<div className="w-full rounded-xl border border-cyan-500/35 bg-cyan-950/40">
			<div className="flex items-center gap-2 border-b border-cyan-500/25 px-3 py-1.5">
				<Icon name="folder" className="h-4 w-4 text-cyan-400" />
				<span className="text-xs font-medium text-slate-200">產出檔案</span>
				<span className="tabular-nums text-[11px] text-cyan-300/80">{files.length}</span>
			</div>
			<ul className="flex flex-wrap gap-1 p-2">
				{files.slice(0, 12).map((file) => (
					<li key={file.name}>
						<button
							type="button"
							onClick={() => onOpen?.(file.name)}
							disabled={!onOpen}
							className="rounded-lg border border-cyan-500/30 px-2 py-1 text-[12px] text-cyan-200 transition-colors enabled:hover:border-cyan-400 enabled:hover:bg-cyan-500/10"
						>
							{file.name}
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

interface MessageListProps {
	messages: ChatMessage[];
	pending: boolean;
	elapsed: number;
	loading: boolean;
	loadError: string | null;
	onRetry: () => void;
	/** 當前會話的計劃（update_plan）。 */
	plan: PlanStep[];
	/** 當前會話工作臺裡的檔案（歷史回放時顯示產出清單）。 */
	files?: FileInfo[];
	/** 開啟某個產出檔案（右欄預覽）。 */
	onOpenFile?: (name: string) => void;
	/** 從某條使用者訊息分叉出新會話（v0.32.0）。 */
	onBranch?: (entryId: number) => void;
	/** 點開 assistant 回覆下的參考資料（NERE-41）。 */
	onOpenKbRef?: (ref: KbRef) => void;
	/** 空會話起步卡：只把建議寫入輸入框，不傳送請求。 */
	onStartPrompt?: (prompt: string) => void;
}

const STARTER_CARDS = [
	{
		title: "寫一份週報並給我分享連結",
		description: "先整理本週進展，再生成可轉發的只讀連結。",
		prompt: "請根據我接下來提供的內容寫一份本週週報，並生成一個可分享的連結。",
	},
	{
		title: "把這篇文章存進知識庫，再問我三個問題",
		description: "貼上文章後儲存，隨後基於它繼續提問。",
		prompt: "請把我接下來貼上的文章存進知識庫，然後基於文章內容向我提出三個值得繼續思考的問題。",
	},
	{
		title: "設一個每天 9 點生成摘要的定時任務",
		description: "說明摘要來源後，建立一個可持續執行的提醒。",
		prompt: "請幫我設一個每天上午 9 點生成摘要的定時任務；先詢問摘要需要基於哪些內容。",
	},
];

export function MessageList({ messages, pending, elapsed, loading, loadError, onRetry, plan, files = [], onOpenFile, onBranch, onOpenKbRef, onStartPrompt }: MessageListProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickToBottomRef = useRef(true);

	// 新內容到達時：若使用者本來就在底部附近則自動滾動，否則保持當前位置
	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
	}, [messages, pending, elapsed, plan]);

	const handleScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD;
	};

	const isEmpty = messages.length === 0 && !pending;
	// 最後一條助手訊息在 pending 期間仍在流式（思考塊自動展開）
	const lastAssistantId = pending
		? [...messages].reverse().find((m) => m.role === "assistant")?.id
		: undefined;
	// 整個會話裡最後一條助手訊息（產出檔案清單掛在它下面）
	const lastAssistantIdAll = [...messages].reverse().find((m) => m.role === "assistant")?.id;

	return (
		<main ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
			<div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3 px-4 py-5 sm:border-x sm:border-slate-800/60">
				{loading && isEmpty && (
					<div className="flex flex-1 items-center justify-center text-sm text-slate-500">正在載入會話…</div>
				)}

				{!loading && isEmpty && (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 px-2 py-10 text-center sm:px-6">
						<div
							aria-hidden
							className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-500/15 text-2xl font-semibold text-sky-400"
						>
							π
						</div>
						<p className="text-sm text-slate-300">開始與 π 對話</p>
						<p className="max-w-xs text-xs leading-relaxed text-slate-500">
							回覆由 Cloudflare Worker 生成，多步任務會先列計劃、再逐步執行。
						</p>
						<div className="mt-3 grid w-full max-w-2xl grid-cols-1 gap-3 text-left sm:grid-cols-3">
							{STARTER_CARDS.map((card) => (
								<button
									key={card.title}
									type="button"
									onClick={() => onStartPrompt?.(card.prompt)}
									className="min-h-28 rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-left transition-colors hover:border-sky-500/60 hover:bg-sky-500/10 focus:outline-none focus:ring-2 focus:ring-sky-500/60"
								>
									<span className="block text-sm font-medium leading-snug text-slate-100">{card.title}</span>
									<span className="mt-2 block text-xs leading-relaxed text-slate-400">{card.description}</span>
								</button>
							))}
						</div>
					</div>
				)}

				{loadError && (
					<div className="flex items-center justify-center gap-2 text-xs text-amber-300/90">
						<span>歷史記錄載入失敗：{loadError}</span>
						<button
							type="button"
							onClick={onRetry}
							className="rounded-md border border-slate-700 px-2 py-0.5 text-slate-300 transition-colors hover:bg-slate-800"
						>
							重試
						</button>
					</div>
				)}

				<PlanPanel plan={plan} />

				{messages.map((message, index) => {
					switch (message.role) {
						case "user":
							// 第一條訊息之前沒有歷史，不能分叉（v0.32.0）
							return <UserBubble key={message.id} message={message} onBranch={index > 0 ? onBranch : undefined} />;
						case "assistant": {
							const isLast = message.id === lastAssistantIdAll;
							return (
								<div key={message.id} className="flex w-full flex-col items-start gap-1.5">
									<AssistantBubble
										message={message}
										streaming={message.id === lastAssistantId}
										onOpenFile={onOpenFile}
										onOpenKbRef={onOpenKbRef}
									/>
									{isLast && !pending && <ArtifactSummary files={files} onOpen={onOpenFile} />}
								</div>
							);
						}
						case "tool":
							return (
								<div key={message.id} className="flex flex-col items-start">
									<ToolBar tools={message.tools} />
								</div>
							);
						case "notice":
							return <NoticeBubble key={message.id} text={message.text} />;
					}
				})}

				{pending && <PendingBubble elapsed={elapsed} phase={elapsed > 3 ? "working" : "thinking"} />}
			</div>
		</main>
	);
}
