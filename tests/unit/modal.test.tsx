import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { KnowledgePanel } from "../../src/web/components/KnowledgePanel";
import { McpPanel } from "../../src/web/components/McpPanel";
import { SkillPanel } from "../../src/web/components/SkillPanel";
import { MODAL_SIZE, ModalShell } from "../../src/web/components/ModalShell";
import { Rail } from "../../src/web/components/Rail";
import { nextFocusIndex } from "../../src/web/lib/focus";

const noop = () => {};

describe("nextFocusIndex（契約 §4.3）", () => {
	it("沒有可聚焦元素時返回 -1", () => {
		expect(nextFocusIndex(1, -1, 0)).toBe(-1);
		expect(nextFocusIndex(-1, 0, 0)).toBe(-1);
	});

	it("只有一個元素時 Tab / Shift+Tab 都停在它身上", () => {
		expect(nextFocusIndex(1, 0, 1)).toBe(0);
		expect(nextFocusIndex(-1, 0, 1)).toBe(0);
	});

	it("多個元素時首尾迴圈", () => {
		expect(nextFocusIndex(1, 0, 3)).toBe(1);
		expect(nextFocusIndex(1, 2, 3)).toBe(0);
		expect(nextFocusIndex(-1, 0, 3)).toBe(2);
		expect(nextFocusIndex(-1, 2, 3)).toBe(1);
	});

	it("焦點不在圈內時落到兩端", () => {
		expect(nextFocusIndex(1, -1, 3)).toBe(0);
		expect(nextFocusIndex(-1, -1, 3)).toBe(2);
	});
});

describe("ModalShell 尺寸對映（契約 §3.2）", () => {
	it("md / lg / xl 單點定義，與契約尺寸一致", () => {
		expect(MODAL_SIZE.md).toContain("45rem");
		expect(MODAL_SIZE.lg).toContain("55rem");
		expect(MODAL_SIZE.xl).toContain("60rem");
	});
});

describe("ModalShell SSR 標記（契約 §4.4 / §10）", () => {
	it("open=false 直接不渲染", () => {
		const html = renderToStaticMarkup(
			<ModalShell open={false} title="知識庫" onClose={noop}>
				<p>內容</p>
			</ModalShell>,
		);
		expect(html).toBe("");
	});

	it("role / aria-modal / aria-labelledby 指向真實標題 id", () => {
		const html = renderToStaticMarkup(
			<ModalShell open title="知識庫" size="lg" onClose={noop} testId="kb-modal">
				<p>內容</p>
			</ModalShell>,
		);
		expect(html).toContain('role="dialog"');
		expect(html).toContain('aria-modal="true"');
		expect(html).toContain('data-testid="kb-modal"');
		expect(html).toContain("知識庫");
		expect(html).toContain("內容");
		expect(html).toContain(MODAL_SIZE.lg);

		const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
		expect(labelledBy).toBeTruthy();
		expect(html).toContain(`<h2 id="${labelledBy}"`);
	});

	it("只新增 ModalShell 一處 role=dialog / aria-modal（三個面板自己不宣告）", () => {
		const shell = renderToStaticMarkup(
			<ModalShell open title="技能" size="xl" onClose={noop}>
				<p>內容</p>
			</ModalShell>,
		);
		expect((shell.match(/role="dialog"/g) ?? []).length).toBe(1);

		const kb = renderToStaticMarkup(<KnowledgePanel onClose={noop} />);
		const mcp = renderToStaticMarkup(
			<McpPanel servers={[]} loading={false} error={null} onAdd={async () => true} onDelete={async () => true} onClose={noop} />,
		);
		const skills = renderToStaticMarkup(
			<SkillPanel
				items={[]}
				loading={false}
				error={null}
				onAdd={async () => true}
				onDelete={async () => true}
				onImport={async () => ({ ok: true })}
				onTry={noop}
				prompts={[]}
				rules={[]}
				onAddPrompt={async () => true}
				onDeletePrompt={async () => true}
				onAddRule={async () => true}
				onToggleRule={async () => true}
				onDeleteRule={async () => true}
				customTools={[]}
				onAddCustomTool={async () => true}
				onDeleteCustomTool={async () => true}
				onClose={noop}
			/>,
		);
		for (const html of [kb, mcp, skills]) {
			expect(html).not.toContain('role="dialog"');
			expect(html).not.toContain("aria-modal");
		}
	});
});

describe("Rail 彈窗入口語義（契約 §1.2）", () => {
	const html = renderToStaticMarkup(
		<Rail
			view="sessions"
			panel="kb"
			onSelectView={noop}
			onTogglePanel={noop}
			onNewSession={noop}
			onOpenSettings={noop}
			sharesAvailable
			isOwner
		/>,
	);

	it("三個入口帶 aria-haspopup=dialog 與 data-modal-trigger", () => {
		expect(html).toContain('aria-haspopup="dialog"');
		for (const panel of ["kb", "mcp", "skills"]) {
			expect(html).toContain(`data-modal-trigger="${panel}"`);
		}
	});

	it("只有當前開啟的入口 aria-expanded=true", () => {
		expect((html.match(/aria-expanded="true"/g) ?? []).length).toBe(1);
		expect((html.match(/aria-expanded="false"/g) ?? []).length).toBe(2);
	});

	it("左欄內容入口仍用 aria-pressed", () => {
		expect((html.match(/aria-pressed="/g) ?? []).length).toBe(5);
	});
});
