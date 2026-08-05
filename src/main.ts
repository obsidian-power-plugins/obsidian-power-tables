import {
	App,
	Editor,
	ItemView,
	MarkdownView,
	Menu,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	type SettingDefinitionItem,
	type SettingDefinitionPage,
	type SettingDefinitionRender,
	TFile,
	WorkspaceLeaf,
	debounce,
	editorLivePreviewField,
	setIcon,
} from "obsidian";
import { Facet, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import {
	BorderAction,
	BORDER_COLORS,
	BorderColor,
	CellBlock,
	Edge,
	EdgeWeight,
	CalcFn,
	CalcSpec,
	ColAlign,
	blockTargets,
	dragFillPreview,
	planDragFill,
	DATE_PATTERNS,
	DateParts,
	EditPlan,
	FMT_DEFAULTS,
	FmtSpec,
	cellTextParts,
	applyCompletion,
	completionsAt,
	refInsertAllowed,
	NegStyle,
	NumFmt,
	Patch,
	RuleOp,
	Scope,
	SumDir,
	TIME_PATTERNS,
	TextStyle,
	TimeParts,
	alignToLogical,
	applyStickyFormats,
	colFromCh,
	emphasisWrap,
	fmtFromTag,
	fmtToTag,
	formatBySpec,
	formatPiece,
	formatDateSpec,
	formatTimeSpec,
	locateLine,
	parseDateCell,
	parseNumeric,
	parseTimeCell,
	planBorders,
	planCopyCells,
	planDrawBorders,
	planFill,
	planPasteCells,
	planSetColumnFilter,
	planClearFilters,
	edgeInDirection,
	parseFilterTag,
	filterHit,
	fltSafe,
	fltValue,
	clipFromRows,
	clipToTsv,
	CellClip,
	ColFilter,
	FilterOp,
	PasteMode,
	planFormatCells,
	planMulti,
	planStickyFormat,
	parseCellContent,
	parseDelimited,
	parseRow,
	planApplyRule,
	planSetColumnRules,
	planSetTableFlag,
	planTotalsRow,
	scaleColors,
	calcToFormula,
	columnRulesAt,
	TABLE_FLAGS,
	TableFlag,
	parseTableFlagTag,
	tableFlagsAt,
	planPrettify,
	planSelectionCalc,
	planSetCellValue,
	planSetChecked,
	planSetColumnWidth,
	planToggleCheckbox,
	CHECKBOX_RE,
	tableToCsv,
	planAlign,
	planAutoFitColumnWidths,
	planClearContents,
	planDeleteColumn,
	planDeleteRow,
	planDuplicateRow,
	planEdits,
	planFormatNumber,
	planFreezeCalc,
	planImportRows,
	planInsertColumn,
	planInsertRow,
	planMoveColumn,
	planMoveRow,
	planSort,
	planTextStyle,
	planToggleCalc,
	applyLiveRules,
	recalcCalcs,
	sanitizeColor,
	selectionStats,
	tableBounds,
	tableFromRows,
	mergeForSave,
	parseCellLink,
	buildCellLink,
	columnAlign,
} from "./cells";

/** A resolved action target. Dialogs pin one at open so clicks that land
 *  behind a floating dialog can't silently retarget the eventual apply. */
type CellTarget = {
	path: string;
	line: number;
	col: number;
	expect: string | null;
	editor: Editor | null;
	fromCursor: boolean;
};

/** A conditional color rule as stored on a column's header cell. */
type Rule = { op: RuleOp; value: string; bg: string | null; fg: string | null };

/** Which rail a reference guide belongs to: a column letter, a row number, or
 *  the corner box that takes the whole table. */
type GuideKind = "col" | "row" | "all";

/**
 * The slice of Obsidian's Live Preview table object this plugin drives.
 *
 * Undocumented, so every member is optional at the call site and checked before
 * use; anything missing sends the selection down the plugin's own path instead.
 * Selecting through Obsidian is worth the feature detection: the block then
 * highlights the way a drag-selection does, and the editor's own copy, cut and
 * delete act on it.
 */
type WidgetTable = {
	tableEl?: HTMLElement | null;
	rows?: unknown[];
	alignments?: unknown[];
	selectedCells?: unknown[];
	getCellAt?: (row: number, col: number) => unknown;
	selectCells?: (anchor: unknown, head: unknown) => void;
	receiveCellFocus?: (row: number, col: number) => void;
};

const VIEW_TYPE_PT = "power-tables-view";

/** How far either side of a column boundary still counts as grabbing it. The
 *  band is this wide on both sides of the line, so a divider is about 12px of
 *  target rather than the 6px inside a single cell it used to be. Wide enough
 *  to hit on a scaled display, narrow enough that an ordinary click into a
 *  header cell is still an ordinary click. */
const EDGE_GRAB = 6;

function colLetter(n: number): string {
	let s = "";
	do {
		s = String.fromCharCode(65 + (n % 26)) + s;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return s;
}

/** What a rendered cell reads as, which is what a filter matches against. The
 *  guides and the funnel are injected elements carrying no text of their own,
 *  so they cost nothing here. */
function cellText(cell: HTMLTableCellElement | undefined): string {
	return (cell?.textContent ?? "").trim();
}

/** A filter in one short phrase, for the funnel's tooltip. */
function filterLabel(f: ColFilter): string {
	const names: Record<FilterOp, string> = {
		in: "showing",
		ex: "hiding",
		gt: "greater than",
		lt: "less than",
		eq: "equals",
		contains: "contains",
		starts: "begins with",
		ends: "ends with",
		between: "between",
		empty: "is empty",
		notempty: "is not empty",
	};
	if (f.op === "empty" || f.op === "notempty") return names[f.op];
	const vals = f.value.split("~").filter(Boolean);
	if (f.op === "in" || f.op === "ex") {
		const head = vals.slice(0, 3).join(", ");
		return `${names[f.op]} ${head}${vals.length > 3 ? ` and ${vals.length - 3} more` : ""}`;
	}
	return `${names[f.op]} ${f.value}`;
}

interface PowerTablesSettings {
	palette: string;
	paletteDark: string;
	lastFill: string;
	lastText: string;
	lastHl: string;
	lastMode: "fill" | "text" | "hl";
	hideMarkup: boolean;
	panelMode: "sidebar" | "floating";
	autoOpenSidebar: boolean;
	stripedRows: boolean;
	compactTables: boolean;
	fillHeaders: boolean;
	headerFill: string;
	headerFillDark: string;
	stickyHeaders: boolean;
	filterRow: boolean;
	toolbarX: number | null;
	toolbarY: number | null;
	fmtModalX: number | null;
	fmtModalY: number | null;
	openOnStart: boolean;
	cellRefs: boolean;
	fillHandle: boolean;
	/** Dock the formatting + formula strip over a table while the cursor is in one. */
	tableBar: boolean;
	/** Draw Borders pen: the style it lays down and the colour it uses. */
	penStyle: string;
	penColor: string;
}

const DEFAULT_SETTINGS: PowerTablesSettings = {
	// Design-handoff palette: a row of soft fills, a row of medium fills,
	// and a row of strong text colors (8 each).
	palette:
		"#FFFFFF, #EFEAFC, #E3F0FC, #E2F5EA, #FDF3D7, #FCE9DC, #FDE8E6, #F1F1F4, " +
		"#D9CCF7, #BFDDF8, #BEE9CF, #F8E4A0, #F7CDB0, #F6C3BE, #DFDFE5, #B9B9C2, " +
		"#6D28D9, #0B6BCB, #1E8553, #B45309, #C2410C, #B42318, #374151, #1A1A1F",
	paletteDark: "",
	lastFill: "#EFEAFC",
	lastText: "#B42318",
	lastHl: "#BEE9CF",
	lastMode: "fill",
	hideMarkup: true,
	panelMode: "sidebar",
	autoOpenSidebar: true,
	stripedRows: false,
	compactTables: false,
	fillHeaders: true,
	headerFill: "#E3F0FC",
	headerFillDark: "",
	stickyHeaders: true,
	filterRow: false,
	toolbarX: null,
	toolbarY: null,
	fmtModalX: null,
	fmtModalY: null,
	openOnStart: false,
	cellRefs: true,
	fillHandle: true,
	tableBar: true,
	penStyle: "thin",
	penColor: "default",
};

/** Marks editor states that already carry the tag-hider, so sub-editor injection never doubles it. */
const hiderInstalled = Facet.define<boolean, boolean>({ combine: (v) => v.length > 0 });

/** No-op effect used to force a decoration rebuild in a cell editor that built too early. */
const ptbPoke = StateEffect.define<null>();

/**
 * Live Preview nicety: collapse the plugin's <span …> wrappers while a table
 * cell (or any line) is being edited, and paint the wrapped content with its
 * actual colors instead. The raw markup stays visible in Source mode, and any
 * tag the selection touches is revealed so nothing is ever truly hidden.
 * Registered as an editor extension, and additionally injected into the small
 * editors Obsidian creates for focused table cells (see scanAll), which don't
 * reliably receive registered extensions.
 */
function buildTagHider(plugin: PowerTablesPlugin) {
	return ViewPlugin.fromClass(
		class {
			deco: DecorationSet;
			hidden: DecorationSet;

			constructor(view: EditorView) {
				({ deco: this.deco, hidden: this.hidden } = this.safeBuild(view));
				this.clampCursor(view);
			}

			update(u: ViewUpdate) {
				// Cell sub-editors mount before being placed in the table DOM, so
				// the inTableCell check can flip after construction, rebuild on
				// focus/geometry changes too, not just doc/viewport/selection.
				if (
					u.docChanged ||
					u.viewportChanged ||
					u.selectionSet ||
					u.focusChanged ||
					u.geometryChanged ||
					u.transactions.some((t) => t.effects.some((e) => e.is(ptbPoke)))
				) {
					({ deco: this.deco, hidden: this.hidden } = this.safeBuild(u.view));
					this.clampCursor(u.view);
				}
			}

			/**
			 * Obsidian mounts cell editors with the cursor at the end of the raw
			 * text (i.e. after the hidden </span>) so typed text would land
			 * outside the wrapper. When a cell's doc is exactly one wrapped
			 * value, keep an empty cursor inside the content.
			 */
			private clampCursor(view: EditorView) {
				if (!view.dom.closest<HTMLTableCellElement>("td, th")) return;
				window.requestAnimationFrame(() => {
					if (!view.dom.isConnected) return;
					const doc = view.state.doc.toString();
					const m = doc.match(/^(<span class="ptb[^"]*"(?:\s+(?:data-sum|data-calc|data-f|data-b|data-fmt|style)="[^"]*")*\s*>)[\s\S]*<\/span>$/);
					let start = m ? m[1].length : 0;
					let end = m ? doc.length - "</span>".length : doc.length;
					const w = emphasisWrap(doc.slice(start, end));
					start += w.lead;
					end -= w.trail;
					if (start <= 0 && end >= doc.length) return;
					const s = view.state.selection.main;
					if (!s.empty || (s.head >= start && s.head <= end)) return;
					view.dispatch({ selection: { anchor: Math.min(Math.max(s.head, start), end) } });
				});
			}

			// CodeMirror silently disables a view plugin whose update throws
			// ("CodeMirror plugin crashed", easy to miss). Fail soft and loud.
			private safeBuild(view: EditorView): { deco: DecorationSet; hidden: DecorationSet } {
				try {
					return this.build(view);
				} catch (e) {
					console.error("Power Tables: tag hider failed", e);
					return { deco: Decoration.none, hidden: Decoration.none };
				}
			}

			build(view: EditorView): { deco: DecorationSet; hidden: DecorationSet } {
				const decoB = new RangeSetBuilder<Decoration>();
				const hideB = new RangeSetBuilder<Decoration>();
				// Obsidian's focused-table-cell sub-editors report Source mode
				// (their job is editing the cell's raw text), but they are exactly
				// where hiding matters most. Only bail on Source mode when the
				// editor is NOT inside a table cell; the real Source-mode view has
				// no table widgets, so it always stays raw.
				const lp = view.state.field(editorLivePreviewField, false);
				const inTableCell = view.dom.closest<HTMLElement>(".cm-table-widget, td, th") != null;
				if (!plugin.settings.hideMarkup || (lp === false && !inTableCell)) {
					return { deco: decoB.finish(), hidden: hideB.finish() };
				}
				const sel = view.state.selection.ranges;
				// Strict interior overlap only: a cursor merely sitting at a tag
				// boundary, which is almost everywhere in a tiny cell editor
				// whose whole doc is one span, must not reveal the markup.
				const touched = (a: number, b: number) => sel.some((r) => r.to > a && r.from < b);
				// Don't trust visibleRanges: table content is widget-hidden in the
				// main editor, and a just-mounted cell editor reports empty ranges
				// until measured. Docs are small; scan everything.
				const ranges =
					view.state.doc.length <= 100000 ? [{ from: 0, to: view.state.doc.length }] : view.visibleRanges;
				// The B/I/S buttons wrap the whole cell value in **/*/~~, hide those
				// markers like the span tags, but only in cell sub-editors, where the
				// document IS one cell's content so a whole-doc wrap is unambiguous.
				// The main editor keeps Obsidian's normal marker behavior.
				const cellDoc = view.dom.closest<HTMLTableCellElement>("td, th") != null;
				const docLen = view.state.doc.length;
				if (cellDoc && docLen <= 10000) {
					const whole = view.state.doc.toString();
					if (!whole.includes('<span class="ptb')) {
						const w = emphasisWrap(whole);
						if (w.lead && !touched(0, w.lead) && !touched(docLen - w.trail, docLen)) {
							decoB.add(0, w.lead, Decoration.replace({}));
							hideB.add(0, w.lead, Decoration.replace({}));
							decoB.add(docLen - w.trail, docLen, Decoration.replace({}));
							hideB.add(docLen - w.trail, docLen, Decoration.replace({}));
						}
					}
				}
				for (const { from, to } of ranges) {
					const text = view.state.doc.sliceString(from, to);
					const openRe = /<span class="ptb[^"]*"(?:\s+(?:data-sum|data-calc|data-f|data-b|data-fmt|style)="[^"]*")*\s*>/g;
					let m: RegExpExecArray | null;
					while ((m = openRe.exec(text))) {
						const openFrom = from + m.index;
						const openTo = openFrom + m[0].length;
						// find the matching close tag, tolerating nested spans
						let depth = 1;
						let i = openTo - from;
						let closeFrom = -1;
						while (i < text.length) {
							const nextOpen = text.indexOf("<span", i);
							const nextClose = text.indexOf("</span>", i);
							if (nextClose === -1) break;
							if (nextOpen !== -1 && nextOpen < nextClose) {
								depth++;
								i = nextOpen + 5;
								continue;
							}
							depth--;
							if (depth === 0) {
								closeFrom = from + nextClose;
								break;
							}
							i = nextClose + 7;
						}
						if (closeFrom < 0) continue;
						const closeTo = closeFrom + 7;
						openRe.lastIndex = closeTo - from;
						if (touched(openFrom, openTo) || touched(closeFrom, closeTo)) continue;
						const style = m[0].match(/style="([^"]*)"/)?.[1] ?? "";
						decoB.add(openFrom, openTo, Decoration.replace({}));
						hideB.add(openFrom, openTo, Decoration.replace({}));
						// whole-value emphasis just inside the wrapper hides too (cell editors only)
						let w = cellDoc ? emphasisWrap(text.slice(openTo - from, closeFrom - from)) : { lead: 0, trail: 0 };
						if (w.lead && (touched(openTo, openTo + w.lead) || touched(closeFrom - w.trail, closeFrom))) {
							w = { lead: 0, trail: 0 };
						}
						if (w.lead) {
							decoB.add(openTo, openTo + w.lead, Decoration.replace({}));
							hideB.add(openTo, openTo + w.lead, Decoration.replace({}));
						}
						if (closeFrom - w.trail > openTo + w.lead && style) {
							decoB.add(
								openTo + w.lead,
								closeFrom - w.trail,
								Decoration.mark({ class: "ptb-live", attributes: { style } })
							);
						}
						if (w.trail) {
							decoB.add(closeFrom - w.trail, closeFrom, Decoration.replace({}));
							hideB.add(closeFrom - w.trail, closeFrom, Decoration.replace({}));
						}
						decoB.add(closeFrom, closeTo, Decoration.replace({}));
						hideB.add(closeFrom, closeTo, Decoration.replace({}));
					}
				}
				return { deco: decoB.finish(), hidden: hideB.finish() };
			}
		},
		{
			decorations: (v) => v.deco,
			provide: (p) => EditorView.atomicRanges.of((view) => view.plugin(p)?.hidden ?? Decoration.none),
		}
	);
}

interface ClickTarget {
	path: string;
	line: number;
	col: number;
	expect: string;
}

export default class PowerTablesPlugin extends Plugin {
	settings: PowerTablesSettings = { ...DEFAULT_SETTINGS };
	/** The settings as they last stood on disk, read or written by us. Whatever
	 *  differs from this in memory is OUR change, and only those keys may
	 *  overwrite a synced data.json; see saveSettings(). */
	private baseline: PowerTablesSettings = { ...DEFAULT_SETTINGS };
	/** Panel "Apply to" scope for colors, text styles, number formats, and Clear values. */
	uiScope: Scope = "cell";
	private toolbar: ColorToolbar | null = null;
	private clickTarget: ClickTarget | null = null;
	/** Cell under the most recent right-button press, cleared by any press that
	 *  missed a table. Obsidian owns the context menu on a link, so this is how
	 *  the handler filling that menu knows the link was in one of our cells. */
	private rightPressCell: HTMLTableCellElement | null = null;
	/** Set only for the length of a menu action, by withCell. */
	private pinnedTarget: ClickTarget | null = null;
	private outlined: HTMLElement | null = null;
	private scanQueued = false;
	private recalcTimers = new Map<string, number>();
	private panels = new Set<PanelUI>();
	private tableBars = new Map<MarkdownView, TableBar>();
	/** The look the format painter is holding, or null when it is off. */
	private painter: Patch | null = null;
	/** "once" pays out on the next cell and disarms; "locked" keeps painting
	 *  until it is switched off. The brush cycles off -> once -> locked -> off,
	 *  so the sticky mode is found by clicking the button rather than by
	 *  knowing Excel's undocumented double-click. */
	private painterMode: "off" | "once" | "locked" = "off";
	/** The cell a payout would be a no-op on: the source to begin with, then
	 *  whichever cell was painted last. Without it a locked painter repaints
	 *  the cell it is already sitting on. */
	private painterFrom: { line: number; col: number } | null = null;
	/** applyFromUI calls updatePanels, which calls paintIfArmed, so a locked
	 *  painter would re-enter itself forever. A one-shot painter never noticed
	 *  because it disarmed before applying. */
	private painting = false;
	/** The armed border-drawing tool, or null. */
	private pen: { tool: "border" | "grid" | "erase" } | null = null;
	private stickySel: ReturnType<PowerTablesPlugin["readWidgetSelection"]> = null;
	/** Where the guide gesture started, so a drag or a Shift-click extends from
	 *  the first guide pressed rather than from the one under the pointer. */
	private guideAnchor: { table: HTMLTableElement; kind: GuideKind; index: number } | null = null;
	private autoRevealed = false;
	private resizing: { th: HTMLElement; startX: number; startW: number; moved: boolean } | null = null;
	private edgeHover: HTMLElement | null = null;
	private statsEl: HTMLElement | null = null;
	private statsText!: HTMLElement;
	private statsSum!: HTMLElement;
	/** Selection snapshot backing the stats chip; the Insert press consumes it. */
	private statsSel: ReturnType<PowerTablesPlugin["widgetSelection"]> = null;
	/** The last block copied or cut from a table, and the plain text that went to
	 *  the system clipboard alongside it. The text is how a paste tells our own
	 *  copy from anything the user has copied since: matching text means the rich
	 *  block is still what the clipboard is describing, and anything else is
	 *  somebody else's data that has to land as values. */
	private clip: CellClip | null = null;
	private clipText = "";
	/** The open AutoFilter dropdown, if any. Only ever one. */
	private filterMenu: HTMLElement | null = null;
	/** Where a keyboard range selection started. Obsidian's selectedCells is a
	 *  set and cannot say which corner was the anchor, so the corner the arrows
	 *  are pivoting around is remembered here. */
	private keyAnchor: { table: HTMLTableElement; row: number; col: number } | null = null;
	fmtModal: FormatCellsModal | null = null;
	private hiderView = buildTagHider(this);
	private hiderExtension = [hiderInstalled.of(true), this.hiderView];

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_PT, (leaf) => new PowerTablesView(leaf, this));
		this.addRibbonIcon("table", "Power Tables", () => void this.openPanel());
		this.addCommand({ id: "open-sidebar", icon: "panel-right", name: "Open panel", callback: () => void this.openPanel() });
		this.addCommand({ id: "toggle-toolbar", icon: "panel-top", name: "Toggle floating panel", callback: () => this.toggleToolbar() });
		this.addCommand({
			id: "clear-cell", icon: "eraser",
			name: "Clear colors in current cell",
			callback: () => void this.applyColor({ bg: null, fg: null }, "cell"),
		});
		this.addCommand({
			id: "clear-table", icon: "eraser",
			name: "Clear all colors in current table",
			callback: () => void this.applyColor({ bg: null, fg: null }, "table"),
		});
		this.addCommand({
			id: "fill-last", icon: "paint-bucket",
			name: "Fill with last color",
			callback: () => this.applyLastColor("fill"),
		});
		this.addCommand({
			id: "fill-down", icon: "arrow-down-to-line",
			name: "Fill down",
			callback: () => void this.fill("down"),
		});
		this.addCommand({
			id: "fill-right", icon: "arrow-right-to-line",
			name: "Fill right",
			callback: () => void this.fill("right"),
		});
		this.addCommand({
			id: "filter-column", icon: "list-filter",
			name: "Filter this column…",
			callback: () => this.openFilterForTarget(),
		});
		this.addCommand({
			id: "clear-filters", icon: "filter-x",
			name: "Clear all filters in this table",
			callback: () => void this.clearFilters(),
		});
		this.addCommand({ id: "copy-cells", icon: "copy", name: "Copy cells", callback: () => void this.copyCells() });
		this.addCommand({ id: "cut-cells", icon: "scissors", name: "Cut cells", callback: () => void this.copyCells(true) });
		this.addCommand({
			id: "paste-cells", icon: "clipboard-paste",
			name: "Paste cells",
			callback: () => void this.pasteCells(),
		});
		this.addCommand({
			id: "paste-values", icon: "hash",
			name: "Paste special: values",
			callback: () => void this.pasteCells("values"),
		});
		this.addCommand({
			id: "paste-formulas", icon: "function-square",
			name: "Paste special: formulas",
			callback: () => void this.pasteCells("formulas"),
		});
		this.addCommand({
			id: "paste-formats", icon: "paintbrush",
			name: "Paste special: formats",
			callback: () => void this.pasteCells("formats"),
		});
		this.addCommand({
			id: "paste-transpose", icon: "flip-horizontal-2",
			name: "Paste special: transpose",
			callback: () => void this.pasteCells("all", true),
		});
		this.addCommand({
			id: "text-last", icon: "type",
			name: "Color text with last color",
			callback: () => this.applyLastColor("text"),
		});
		this.addCommand({
			id: "hl-last", icon: "highlighter",
			name: "Highlight with last color",
			callback: () => this.applyLastColor("hl"),
		});
		this.addCommand({
			id: "sum-column", icon: "sigma",
			name: "Toggle live column sum in current cell",
			callback: () => void this.sumInto("column"),
		});
		this.addCommand({
			id: "sum-row", icon: "sigma",
			name: "Toggle live row sum in current cell",
			callback: () => void this.sumInto("row"),
		});
		this.addCommand({
			id: "sort-asc", icon: "arrow-up-narrow-wide",
			name: "Sort table by current column (ascending)",
			callback: () => void this.sortTable("asc"),
		});
		this.addCommand({
			id: "sort-desc", icon: "arrow-down-wide-narrow",
			name: "Sort table by current column (descending)",
			callback: () => void this.sortTable("desc"),
		});
		this.addCommand({ id: "move-row-up", icon: "arrow-up", name: "Move row up", callback: () => void this.moveRow(-1) });
		this.addCommand({ id: "move-row-down", icon: "arrow-down", name: "Move row down", callback: () => void this.moveRow(1) });
		this.addCommand({ id: "move-col-left", icon: "arrow-left", name: "Move column left", callback: () => void this.moveColumn(-1) });
		this.addCommand({ id: "move-col-right", icon: "arrow-right", name: "Move column right", callback: () => void this.moveColumn(1) });
		this.addCommand({ id: "insert-row-above", icon: "plus", name: "Insert row above", callback: () => void this.insertRow("above") });
		this.addCommand({ id: "insert-row-below", icon: "plus", name: "Insert row below", callback: () => void this.insertRow("below") });
		this.addCommand({ id: "insert-col-left", icon: "plus", name: "Insert column left", callback: () => void this.insertColumn("left") });
		this.addCommand({ id: "insert-col-right", icon: "plus", name: "Insert column right", callback: () => void this.insertColumn("right") });
		this.addCommand({ id: "duplicate-row", icon: "copy", name: "Duplicate row", callback: () => void this.duplicateRow() });
		this.addCommand({ id: "delete-row", icon: "trash-2", name: "Delete row", callback: () => void this.deleteRow() });
		this.addCommand({ id: "delete-col", icon: "trash-2", name: "Delete column", callback: () => void this.deleteColumn() });
		this.addCommand({ id: "clear-contents", icon: "eraser", name: "Clear cell contents", callback: () => void this.clearContents(null) });
		this.addCommand({ id: "import-csv", icon: "upload", name: "Import CSV / Excel data…", callback: () => this.openImportModal() });
		this.addCommand({
			id: "paste-data", icon: "clipboard-paste",
			name: "Paste data from the clipboard (append rows)",
			callback: () => void this.pasteFromClipboard(),
		});
		this.addCommand({ id: "totals-row", icon: "sigma", name: "Insert totals row", callback: () => void this.insertTotalsRow() });
		this.addCommand({ id: "prettify", icon: "align-justify", name: "Prettify table (align pipes)", callback: () => void this.prettifyTable() });
		this.addCommand({
			id: "autofit-widths", icon: "move-horizontal",
			name: "Auto-fit column widths",
			callback: () => void this.autoFitColumnWidths(),
		});
		this.addCommand({
			id: "insert-demo", icon: "table",
			name: "Insert demo table",
			callback: () => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || view.getMode() === "preview") {
					new Notice("Power Tables: open a note in editing mode first.");
					return;
				}
				const cur = view.editor.getCursor("head");
				const demo = [
					'| <span class="ptb" data-w="140">Item</span> | Amount | Status |',
					"| --- | ---: | --- |",
					'| <span class="ptb" style="background:#EFEAFC">Design</span> | $1,200.00 | [x] Done |',
					'| <span class="ptb" style="color:#0B6BCB">**Build**</span> | $3,400.00 | [ ] In progress |',
					'| <span class="ptb ptb-hl" style="background:#BEE9CF">Launch</span> | $150.00 | [ ] Waiting |',
					"| **Total** | <span class=\"ptb\" data-calc=\"sum:col\">$4,750.00</span> | <span class=\"ptb\" data-f=\"=COUNTIF(C1:C3,'[x] Done')\">1</span> |",
					"| Fee (10%) | =ROUND(B4*0.1,2) | |",
					"",
					"Try it: click any cell and use the sidebar, drag-select the amounts to see the stats chip, tick the checkboxes in Reading view, or right-click a cell for row and column operations.",
					"",
				].join("\n");
				view.editor.replaceRange(demo + "\n", { line: cur.line, ch: 0 });
				new Notice("Demo table inserted. The Fee row's formula comes alive on the first recalc.");
			},
		});
		this.addCommand({ id: "copy-csv", icon: "copy", name: "Copy table as CSV", callback: () => void this.copyTableCsv() });
		this.addCommand({ id: "edit-formula", icon: "calculator", name: "Edit cell value / formula…", callback: () => this.openFormulaModal() });
		this.addCommand({ id: "rule-modal", icon: "palette", name: "Conditional color rule…", callback: () => this.openRulesModal() });
		this.addCommand({ id: "format-cells", icon: "paintbrush", name: "Format cells…", callback: () => this.openFormatModal() });
		this.addCommand({
			id: "debug-report", icon: "bug",
			name: "Copy debug report (troubleshooting)",
			callback: () => {
				new Notice("Power Tables: watching editors for 12 seconds (click into a formatted table cell now)");
				const rows: Record<string, unknown>[] = [];
				const seen = new Set<EditorView>();
				const snap = (ev: EditorView, el: Element, when: string) => {
					const inst = ev.plugin(this.hiderView);
					const doc = ev.state.doc.toString();
					rows.push({
						when,
						inTd: el.closest<HTMLTableCellElement>("td, th") != null,
						lp: ev.state.field(editorLivePreviewField, false) ?? "missing",
						extensionInstalled: ev.state.facet(hiderInstalled),
						pluginActive: inst != null,
						decorations: inst ? inst.deco.size : -1,
						docLen: doc.length,
						ptbSpans: (doc.match(/<span class="ptb/g) || []).length,
						docHead: doc.slice(0, 60),
					});
				};
				const tick = window.setInterval(() => {
					document.body.querySelectorAll(".cm-editor").forEach((el) => {
						const ev = EditorView.findFromDOM(el as HTMLElement);
						if (!ev || seen.has(ev)) return;
						seen.add(ev);
						snap(ev, el, "appeared");
					});
				}, 400);
				this.registerInterval(tick);
				const done = window.setTimeout(() => {
					window.clearInterval(tick);
					document.body.querySelectorAll(".cm-editor").forEach((el) => {
						const ev = EditorView.findFromDOM(el as HTMLElement);
						if (ev) snap(ev, el, "final");
					});
					const report = JSON.stringify(
						{ version: this.manifest.version, hideMarkup: this.settings.hideMarkup, editors: rows },
						null,
						1
					);
					void navigator.clipboard.writeText(report);
					new Notice("Power Tables: debug report copied to clipboard. Paste it into a GitHub issue.");
				}, 12000);
				this.register(() => window.clearTimeout(done));
			},
		});
		this.addSettingTab(new PowerTablesSettingTab(this.app, this));

		// Reading view / embeds / PDF export: remember where each table lives in its
		// source file and paint the real <td> elements from the in-cell spans.
		this.registerMarkdownPostProcessor((el, ctx) => {
			const tables = el.querySelectorAll("table");
			if (!tables.length) return;
			tables.forEach((table) => {
				const info = ctx.getSectionInfo(table) ?? ctx.getSectionInfo(el);
				if (info) {
					table.setAttribute("data-ptb-start", String(info.lineStart));
					table.setAttribute("data-ptb-path", ctx.sourcePath);
				}
				table.querySelectorAll("td span.ptb, th span.ptb").forEach((s) => this.lift(s as HTMLElement));
				// per-table appearance classes are wiped with every re-render;
				// re-apply here so Reading view never flashes the global look
				this.applyFlagClasses(table);
			});
		});

		// Live Preview renders tables natively (outside post-processors); a DOM
		// observer keeps <td> paint in sync there and after any re-render.
		const observer = new MutationObserver(() => this.queueScan());
		observer.observe(document.body, { childList: true, subtree: true });
		this.register(() => observer.disconnect());
		this.queueScan();

		this.registerDomEvent(document, "click", (evt) => this.onDocClick(evt), { capture: true });
		this.registerDomEvent(document, "contextmenu", (evt) => this.onCellContextMenu(evt), { capture: true });
		// Remember where a right-click landed before any contextmenu handler
		// runs, ours or Obsidian's. Recording it on the press instead of the
		// menu event means the order those handlers fire in cannot matter.
		this.registerDomEvent(
			document,
			"pointerdown",
			(evt) => {
				const cell = evt.target instanceof Element ? evt.target.closest<HTMLTableCellElement>("td, th") : null;
				this.rightPressCell = evt.button === 2 && cell?.closest(".markdown-rendered") ? cell : null;
			},
			{ capture: true }
		);
		// Rendered [ ]/[x] checkboxes write their state back to the markdown.
		// The whole toggle runs on pointerdown in the capture phase: that is
		// the one event guaranteed to reach us before Live Preview's table
		// widget reacts (the widget's own handling can destroy and rebuild the
		// cell before a click would ever be dispatched). The later click is
		// swallowed so the native checkbox behavior can't double-toggle.
		this.registerDomEvent(
			document,
			"pointerdown",
			(evt) => {
				const box = evt.target;
				if (!(box instanceof HTMLInputElement) || !box.classList.contains("ptb-cbx")) return;
				evt.preventDefault();
				evt.stopPropagation();
				if (evt.button !== 0) return;
				const cell = box.closest<HTMLTableCellElement>("td, th");
				if (!cell) return;
				box.checked = !box.checked;
				const checked = box.checked;
				const apply = (tgt: ClickTarget) => {
					this.clickTarget = tgt;
					void this.runPlan({ ...tgt, editor: this.editorForPath(tgt.path), fromCursor: false }, (lines) =>
						planSetChecked(lines, tgt, checked)
					);
				};
				const tgt = this.targetFromCell(cell);
				if (tgt) apply(tgt);
				else void this.fallbackTargetFromCell(cell).then((fb) => fb && apply(fb));
			},
			{ capture: true }
		);
		this.registerDomEvent(
			document,
			"click",
			(evt) => {
				if (evt.target instanceof HTMLInputElement && evt.target.classList.contains("ptb-cbx")) {
					evt.preventDefault();
					evt.stopPropagation();
				}
			},
			{ capture: true }
		);
		// drag the right edge of a header cell to set the column width
		this.registerDomEvent(document, "pointermove", (evt) => {
			if (this.resizing) return;
			const edge = this.headerEdgeAt(evt);
			if (this.edgeHover && this.edgeHover !== edge) {
				this.edgeHover.removeClass("ptb-col-edge");
				this.edgeHover = null;
			}
			if (edge) {
				edge.addClass("ptb-col-edge");
				this.edgeHover = edge;
			}
		});
		this.registerDomEvent(
			document,
			"pointerdown",
			(evt) => {
				const edge = this.headerEdgeAt(evt);
				if (!edge) return;
				evt.preventDefault();
				evt.stopPropagation();
				// double-click on the resize edge auto-fits that column, like Excel
				if (evt.detail >= 2) {
					void this.autoFitColumn(edge as HTMLTableCellElement);
					return;
				}
				this.resizing = { th: edge, startX: evt.clientX, startW: edge.getBoundingClientRect().width, moved: false };
				const move = (ev: PointerEvent) => {
					const rs = this.resizing;
					if (!rs) return;
					if (Math.abs(ev.clientX - rs.startX) > 2) rs.moved = true;
					const w = Math.max(48, Math.round(rs.startW + ev.clientX - rs.startX));
					rs.th.style.width = w + "px";
					rs.th.style.minWidth = w + "px";
				};
				const up = (ev: PointerEvent) => {
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", up);
					const rs = this.resizing;
					this.resizing = null;
					if (!rs?.moved) return;
					const w = Math.max(48, Math.round(rs.startW + ev.clientX - rs.startX));
					void this.commitColumnWidth(rs.th as HTMLTableCellElement, w);
				};
				window.addEventListener("pointermove", move);
				window.addEventListener("pointerup", up);
			},
			{ capture: true }
		);
		// Live Preview cell focus: the widget assigns its focused cell before
		// focusing the cell editor, so a bubbling focusin always reads the NEW
		// cell, click handlers fire too early and lag one cell behind.
		// A press inside a table begins a fresh selection, so the remembered one
		// stops being the answer. A press anywhere else in the note leaves the
		// table altogether, which has to clear the last-clicked cell too: that
		// is what resolveTarget falls back on, and a stale one kept the table
		// bar up over prose. A press on our own bar, panel or a menu is neither.
		this.registerDomEvent(
			document,
			"pointerdown",
			(evt) => {
				if (!(evt.target instanceof Element)) return;
				// A press on the fill handle acts ON the selection, so it is not
				// the start of a new one and must not clear the old one.
				if (evt.target.closest(".ptb-panel, .ptb-toolbar, .ptb-tablebar, .ptb-stats, .ptb-fh, .menu, .modal")) return;
				if (evt.target.closest<HTMLElement>(".cm-table-widget, td, th")) this.dropStickySelection();
				else this.leaveTableContext();
			},
			{ capture: true }
		);
		// Column letters and row numbers select what they label. This is
		// registered after the handler above on purpose: that one clears the
		// remembered selection for any press in a table, guides included, and
		// this one then puts the new selection in its place.
		this.registerDomEvent(document, "pointerdown", (evt) => this.onGuideDown(evt), { capture: true });
		// the fill handle, on the same terms: the press must not reach the cell
		this.registerDomEvent(document, "pointerdown", (evt) => this.onFillDown(evt), { capture: true });
		// and the funnel, which opens the column's filter instead of editing the header
		this.registerDomEvent(document, "pointerdown", (evt) => this.onFunnelDown(evt), { capture: true });
		// a press anywhere else puts the dropdown away, the way a menu behaves
		this.registerDomEvent(document, "pointerdown", (evt) => {
			if (!this.filterMenu) return;
			if (evt.target instanceof Element && evt.target.closest(".ptb-fdrop, .ptb-funnel")) return;
			this.closeFilterMenu();
		});
		this.registerDomEvent(document, "focusin", (evt) => {
			if (evt.target instanceof Element && evt.target.closest<HTMLElement>(".cm-table-widget, td, th")) this.updatePanels();
		});
		this.registerPenHandlers();
		// Ctrl+C / Ctrl+X / Ctrl+V over a table selection. Capture, because the
		// editor's own handlers would otherwise get there first and paste our
		// markup as text.
		this.registerDomEvent(document, "copy", (evt) => this.onClipboardCopy(evt, false), { capture: true });
		this.registerDomEvent(document, "cut", (evt) => this.onClipboardCopy(evt, true), { capture: true });
		this.registerDomEvent(document, "paste", (evt) => this.onClipboardPaste(evt), { capture: true });
		this.registerDomEvent(document, "keydown", (evt) => {
			if (evt.key === "Escape" && this.filterMenu) {
				evt.preventDefault();
				evt.stopPropagation();
				this.closeFilterMenu();
				return;
			}
			if (this.filterMenu) return;
			// Excel's selection keys. onTableKeys answers false for anything it
			// does not claim, and the press goes on to Obsidian untouched.
			if (this.onTableKeys(evt)) {
				evt.preventDefault();
				evt.stopPropagation();
				this.updatePanels();
			}
		}, { capture: true });
		this.registerDomEvent(document, "keyup", (evt) => {
			if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab", "Enter"].includes(evt.key)) {
				// moving the cursor by keyboard is also a new selection, and it
				// can walk clean out of the table
				this.dropStickySelection();
				if (!this.cursorInTable()) this.leaveTableContext();
				this.updatePanels();
			}
		});
		// drag-selections finish on pointerup; refresh the panels and stats chip then
		this.registerDomEvent(document, "pointerup", () => this.updatePanels());
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.dropStickySelection();
				this.updatePanels();
			})
		);
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				const cur = editor.getCursor("head");
				const row = parseRow(editor.getLine(cur.line));
				if (!row || row.isDelim) return;
				menu.addSeparator();
				this.addStructureItems(menu);
			})
		);

		// The two menus Obsidian raises for a right-clicked link: url-menu for an
		// external URL, file-menu for a note. Adding to them is what keeps a link
		// cell down to one menu.
		this.registerEvent(this.app.workspace.on("url-menu", (menu) => this.addLinkCellItems(menu)));
		this.registerEvent(this.app.workspace.on("file-menu", (menu) => this.addLinkCellItems(menu)));

		// Hide the span wrappers while editing in Live Preview.
		this.registerEditorExtension(this.hiderExtension);

		// Live sums: recalculate marked cells shortly after any change to a note.
		this.registerEvent(
			this.app.workspace.on("editor-change", (_editor, info) => {
				if (info?.file) {
					this.scheduleRecalc(info.file.path);
					this.updatePanels();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "md") this.scheduleRecalc(file.path);
			})
		);
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) this.scheduleRecalc(file.path, 100);
			})
		);
		this.register(() => {
			for (const t of this.recalcTimers.values()) window.clearTimeout(t);
			this.recalcTimers.clear();
			for (const bar of this.tableBars.values()) bar.destroy();
			this.tableBars.clear();
		});

		this.applyAppearance();
		// theme flips swap in the dark-mode palette and header fill
		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				this.applyAppearance();
				this.rebuildPanels();
			})
		);
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.openOnStart) void this.openPanel();
			// Reading views rendered before this plugin (re)loaded carry no
			// table stamps, re-run their post-processors once.
			this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
				const v = leaf.view;
				if (v instanceof MarkdownView && v.getMode() === "preview") {
					(v.previewMode as unknown as { rerender?: (full?: boolean) => void }).rerender?.(true);
				}
			});
		});
	}

	onunload() {
		this.closeToolbar();
		document.body.removeClass("ptb-striped", "ptb-compact", "ptb-cellrefs", "ptb-headerfill", "ptb-sticky");
		document.body.style.removeProperty("--ptb-header-fill");
		this.closeFilterMenu();
		document.body.querySelectorAll(".ptb-funnel").forEach((f) => f.remove());
		document.body.querySelectorAll("tr.ptb-fhidden").forEach((r) => (r as HTMLElement).removeClass("ptb-fhidden"));
		document.body.querySelectorAll("td[data-ptb], th[data-ptb]").forEach((cell) => {
			(cell as HTMLElement).style.removeProperty("background-color");
			cell.removeAttribute("data-ptb");
		});
		document.body.querySelectorAll("td[data-ptb-b], th[data-ptb-b]").forEach((c) => c.removeAttribute("data-ptb-b"));
	}

	/* ---------------- cell background lifting ---------------- */

	private queueScan() {
		if (this.scanQueued) return;
		this.scanQueued = true;
		window.requestAnimationFrame(() => {
			this.scanQueued = false;
			this.scanAll();
		});
	}

	private scanAll() {
		// Obsidian's focused table cells (and similar embeds) get their own
		// small CodeMirror editors that don't reliably include registered
		// editor extensions, inject the tag-hider into any that lack it, and
		// poke any cell editor that built before it was attached/measured and
		// ended up with zero decorations despite ptb spans in its text.
		document.body.querySelectorAll(".cm-editor").forEach((el) => {
			const ev = EditorView.findFromDOM(el as HTMLElement);
			if (!ev) return;
			if (!ev.state.facet(hiderInstalled)) {
				ev.dispatch({ effects: StateEffect.appendConfig.of(this.hiderExtension) });
				return;
			}
			if (el.closest<HTMLTableCellElement>("td, th") && ev.state.doc.length < 200000) {
				const inst = ev.plugin(this.hiderView);
				if (inst && inst.deco.size === 0 && ev.state.doc.toString().includes('<span class="ptb')) {
					ev.dispatch({ effects: ptbPoke.of(null) });
				}
			}
		});
		document.body.querySelectorAll("td span.ptb, th span.ptb").forEach((s) => this.lift(s as HTMLElement));
		// a cell keeps its lifted borders only while a span still carries them
		document.body.querySelectorAll("td[data-ptb-b], th[data-ptb-b]").forEach((cell) => {
			if (!cell.querySelector("span.ptb[data-b]")) cell.removeAttribute("data-ptb-b");
		});
		document.body.querySelectorAll("td[data-ptb], th[data-ptb]").forEach((cell) => {
			const s = cell.querySelector<HTMLElement>("span.ptb");
			if (!s || !s.style.backgroundColor || s.classList.contains("ptb-hl")) {
				(cell as HTMLElement).style.removeProperty("background-color");
				cell.removeAttribute("data-ptb");
			}
		});
		this.applyColumnWidths();
		this.applyTableFlags();
		this.renderCheckboxes();
		this.renderFunnels();
		this.renderGuides();
		this.renderFillHandle();
	}

	/* ---------------- reference guides (column letters + row numbers) ---------------- */

	/** Whether this table draws guides: its own override first, then the global setting. */
	private guidesOn(tbl: HTMLTableElement): boolean {
		if (tbl.hasClass("ptb-t-guides")) return true;
		if (tbl.hasClass("ptb-t-noguides")) return false;
		return this.settings.cellRefs;
	}

	/** A table's rows in grid order, header first. */
	private guideRows(tbl: HTMLTableElement): HTMLTableRowElement[] {
		return Array.from(tbl.rows);
	}

	/**
	 * Draw the guides as real elements rather than CSS counters.
	 *
	 * They used to be ::before content, which cannot be clicked: the press landed
	 * on the header cell underneath and started editing it. As elements they are
	 * their own click targets, so a letter selects its column and a number its
	 * row, and a drag across them takes the span, the way a spreadsheet does.
	 * Their text rides on a data attribute drawn by CSS, so the cell's
	 * textContent stays exactly the cell's own text: the click paths match a
	 * cell's text against the note to be sure they are editing the line they
	 * think they are, and a letter mixed into it would fail every one of them.
	 */
	private renderGuides() {
		document.body
			.querySelectorAll<HTMLTableElement>(":is(.markdown-rendered, .cm-table-widget) table")
			.forEach((tbl) => {
				const on = this.guidesOn(tbl);
				tbl.toggleClass("ptb-guided", on);
				if (!on) {
					tbl.querySelectorAll(".ptb-guide").forEach((g) => g.remove());
					return;
				}
				const rows = this.guideRows(tbl);
				rows.forEach((tr, r) => {
					const first = tr.cells[0];
					if (!first) return;
					this.ensureGuide(first, "row", r, String(r + 1));
					if (r > 0) return;
					Array.from(tr.cells).forEach((c, i) => this.ensureGuide(c, "col", i, colLetter(i)));
					this.ensureGuide(first, "all", 0, "");
				});
				// A guide belongs to the cell it labels. Anything left behind by a
				// column that moved, or by a first column that was deleted, is
				// removed rather than left labelling the wrong cell.
				tbl.querySelectorAll<HTMLElement>(".ptb-guide").forEach((g) => {
					const cell = g.closest<HTMLTableCellElement>("td, th");
					const inHeader = !!cell && cell.closest("tr") === rows[0];
					const keep = g.hasClass("ptb-gcol")
						? inHeader
						: cell?.cellIndex === 0 && (g.hasClass("ptb-grow") || inHeader);
					if (!keep) g.remove();
				});
			});
	}

	/** Put one guide in its cell, or update the label it already has. Column
	 *  letters go first in the cell so they sit above its text; the other two are
	 *  positioned out of flow, so where they land in the cell doesn't matter. */
	private ensureGuide(cell: HTMLTableCellElement, kind: GuideKind, index: number, label: string) {
		const cls = kind === "col" ? "ptb-gcol" : kind === "row" ? "ptb-grow" : "ptb-gall";
		let el = cell.querySelector<HTMLElement>(`:scope > .${cls}`);
		if (!el) {
			el = createDiv({ cls: `ptb-guide ${cls}` });
			if (kind === "col") cell.prepend(el);
			else cell.append(el);
		}
		if (el.dataset.l !== label) el.dataset.l = label;
		if (el.dataset.i !== String(index)) el.dataset.i = String(index);
		const tip =
			kind === "all"
				? "Select the whole table"
				: `Select ${kind === "col" ? "column" : "row"} ${label}, or drag to take more`;
		if (el.title !== tip) el.title = tip;
	}

	/**
	 * A press on a guide takes the whole column, the whole row, or, from the
	 * corner box, the whole table, and keeps taking more while the pointer drags
	 * along the rail. Shift extends the block the last press started instead of
	 * beginning a new one. All three are what the same press does in Excel.
	 */
	private onGuideDown(evt: PointerEvent) {
		if (evt.button !== 0 || !(evt.target instanceof Element)) return;
		// an armed drawing tool draws everywhere, and the column-resize band wins
		// over the letter it crosses, exactly as the same pixels do in Excel
		if (this.pen || this.headerEdgeAt(evt)) return;
		const g = evt.target.closest<HTMLElement>(".ptb-guide");
		const table = g?.closest<HTMLTableElement>("table");
		if (!g || !table) return;
		// The press must not reach the cell underneath: it would put the caret in
		// it, and in Live Preview that rebuilds the cell mid-gesture.
		evt.preventDefault();
		evt.stopPropagation();
		// Preventing the default press also stops Obsidian's own switch to the
		// pane that was clicked, and everything downstream reads the active one,
		// so make the pane holding this table active first.
		const view = this.viewForEl(table);
		if (view && this.app.workspace.getActiveViewOfType(MarkdownView) !== view) {
			this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
		}
		const kind: GuideKind = g.hasClass("ptb-gall") ? "all" : g.hasClass("ptb-gcol") ? "col" : "row";
		const index = Number(g.dataset.i ?? 0);
		const prev = this.guideAnchor;
		const anchor = evt.shiftKey && prev && prev.table === table && prev.kind === kind ? prev.index : index;
		this.guideAnchor = { table, kind, index: anchor };
		this.selectGuideBlock(table, kind, anchor, index, true);
		if (kind === "all") return;
		const rail = kind === "col" ? ".ptb-gcol" : ".ptb-grow";
		const move = (e: PointerEvent) => {
			const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(rail);
			// The drag stays in the table it started in, and off the rail it holds
			// what it has, so wandering out of a thin strip costs nothing.
			if (!over || over.closest("table") !== table) return;
			this.selectGuideBlock(table, kind, anchor, Number(over.dataset.i ?? 0), false);
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
			this.updatePanels();
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
	}

	/** Select the block a pair of guide indices covers. */
	private selectGuideBlock(table: HTMLTableElement, kind: GuideKind, from: number, to: number, focus: boolean) {
		const rows = this.guideRows(table);
		const cols = rows[0]?.cells.length ?? 0;
		if (!rows.length || !cols) return;
		const lo = Math.max(0, Math.min(from, to));
		const hi = Math.max(from, to);
		const block: CellBlock =
			kind === "col"
				? { r1: 0, r2: rows.length - 1, c1: lo, c2: Math.min(hi, cols - 1) }
				: kind === "row"
					? { r1: lo, r2: Math.min(hi, rows.length - 1), c1: 0, c2: cols - 1 }
					: { r1: 0, r2: rows.length - 1, c1: 0, c2: cols - 1 };
		this.clearGuidePaint();
		this.stickySel = null;
		// Obsidian's own selection first: the block then paints the way a drag
		// through the cells paints, and the editor's copy, cut and delete act on it.
		if (!this.selectNative(table, block, focus)) {
			const own = this.docBlockTargets(table, block);
			if (own) {
				// the plugin's remembered selection is exactly this shape, so a
				// guide selection needs no second one: everything already reads it
				this.stickySel = own;
				this.paintBlock(table, block);
			} else {
				// nothing here can be selected (no editor open on the file), so
				// fall back to targeting the block's first cell rather than nothing
				const cell = rows[block.r1]?.cells[block.c1];
				const t = cell ? this.targetFromCell(cell) : null;
				if (t) this.clickTarget = t;
			}
		}
		this.markGuides(table, block, kind);
		// mid-drag the guides and the block itself already show what is being
		// taken; the panel and the stats chip catch up on pointerup, the same as
		// they do for a drag through the cells
		if (focus) this.updatePanels();
	}

	/**
	 * Hand the block to Obsidian's own table selection.
	 *
	 * Worth doing rather than only painting one ourselves: the block then reads
	 * as a selection to the editor, so copy, cut and Delete act on it, and the
	 * plugin's existing selection reader picks it up with no second path to keep
	 * in step. Every internal is checked before it is called, and false here
	 * means the plugin selects the block its own way instead.
	 */
	private selectNative(tableEl: HTMLTableElement, b: CellBlock, focus: boolean): boolean {
		try {
			const t = this.acquireWidgetTable(tableEl);
			if (!t?.getCellAt || !t.selectCells) return false;
			// focus first and read the cells after: focusing rebuilds the one it lands on
			if (focus) t.receiveCellFocus?.(b.r1, b.c1);
			const from = t.getCellAt(b.r1, b.c1);
			const to = t.getCellAt(b.r2, b.c2);
			if (!from || !to || from === to) return false;
			t.selectCells(from, to);
			return (t.selectedCells?.length ?? 0) > 1;
		} catch {
			return false;
		}
	}

	/**
	 * Obsidian's table object for a rendered table, if it will part with one.
	 *
	 * It exposes the object only through the cell being edited, so when the press
	 * did not come from inside this table the cursor is placed in it first. That
	 * is no detour: selecting a column makes its first cell the active one
	 * anyway, which is what Obsidian's own column handle does.
	 */
	private acquireWidgetTable(tableEl: HTMLTableElement): WidgetTable | null {
		const view = this.viewForEl(tableEl);
		if (!view?.file || view.getMode() === "preview") return null;
		const held = (): WidgetTable | null => {
			const em = (view as unknown as { editMode?: unknown }).editMode ?? view.editor;
			const t = (em as { tableCell?: { table?: WidgetTable } } | null)?.tableCell?.table;
			return t && t.tableEl === tableEl ? t : null;
		};
		const have = held();
		if (have) return have;
		const cm = (view.editor as unknown as { cm?: EditorView }).cm;
		if (!cm || !cm.dom.contains(tableEl)) return null;
		const start = cm.state.doc.lineAt(cm.posAtDOM(tableEl)).number - 1;
		// ch 2 is inside the first cell of any row line, which always opens with "|"
		view.editor.setCursor({ line: start, ch: 2 });
		return held();
	}

	/** The note view a rendered table sits in, whether or not it is the active
	 *  one: a press has to act on the pane that holds the table. */
	private viewForEl(el: HTMLElement): MarkdownView | null {
		let found: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const v = leaf.view;
			if (!found && v instanceof MarkdownView && v.containerEl.contains(el)) found = v;
		});
		return found;
	}

	/** A block in document coordinates, or null when nothing can act on it: no
	 *  open editor for the file, or a table whose place in it can't be read. */
	private docBlockTargets(table: HTMLTableElement, b: CellBlock) {
		// Reading view carries the post-processor's stamp; Live Preview asks
		// CodeMirror, through the pane holding the table rather than the active one
		const stamped = table.getAttribute("data-ptb-start");
		const path = table.getAttribute("data-ptb-path");
		let start: number;
		let file: string;
		if (stamped != null && path) {
			start = parseInt(stamped, 10);
			file = path;
		} else {
			const view = this.viewForEl(table);
			const cm = (view?.editor as unknown as { cm?: EditorView } | undefined)?.cm;
			if (!view?.file || !cm || !cm.dom.contains(table)) return null;
			try {
				start = cm.state.doc.lineAt(cm.posAtDOM(table)).number - 1;
			} catch {
				return null;
			}
			file = view.file.path;
		}
		const editor = this.editorForPath(file);
		if (!editor || Number.isNaN(start)) return null;
		return { path: file, editor, targets: blockTargets(start, b) };
	}

	/** Shade a block the plugin selected itself. Obsidian paints its own
	 *  selection, so this is only for the path where it would not take one. */
	private paintBlock(table: HTMLTableElement, b: CellBlock) {
		const rows = this.guideRows(table);
		for (let r = b.r1; r <= b.r2; r++) {
			for (let c = b.c1; c <= b.c2; c++) rows[r]?.cells[c]?.addClass("ptb-sel");
		}
	}

	/** Light the guides a block spans, the way a spreadsheet lights the letters
	 *  and numbers of the selected range: the rail that was pressed solid, the
	 *  one crossing it only tinted. */
	private markGuides(table: HTMLTableElement, b: CellBlock, kind: GuideKind) {
		table.querySelectorAll<HTMLElement>(".ptb-gcol").forEach((g) => {
			const on = Number(g.dataset.i) >= b.c1 && Number(g.dataset.i) <= b.c2;
			g.toggleClass("is-active", on);
			g.toggleClass("is-lead", on && kind !== "row");
		});
		table.querySelectorAll<HTMLElement>(".ptb-grow").forEach((g) => {
			const on = Number(g.dataset.i) >= b.r1 && Number(g.dataset.i) <= b.r2;
			g.toggleClass("is-active", on);
			g.toggleClass("is-lead", on && kind !== "col");
		});
	}

	/** Take back everything a guide selection drew. */
	private clearGuidePaint() {
		document.body.querySelectorAll(".ptb-sel").forEach((c) => c.removeClass("ptb-sel"));
		document.body.querySelectorAll(".ptb-guide.is-active").forEach((g) => g.removeClasses(["is-active", "is-lead"]));
	}

	/* ---------------- the fill handle ---------------- */

	/**
	 * The cell the handle hangs off: the bottom-right of whatever is selected,
	 * or the one cell being worked in.
	 *
	 * Obsidian's own selected-cell objects carry the elements they were built
	 * from, so in Live Preview the corner is asked of them rather than worked out
	 * from coordinates. Failing that it is the plugin's own painted selection,
	 * then Reading view's outlined cell.
	 */
	private handleAnchor(): HTMLTableCellElement | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view && view.getMode() !== "preview") {
			const em = (view as unknown as { editMode?: unknown }).editMode ?? view.editor;
			const tc = (
				em as {
					tableCell?: { table?: { selectedCells?: unknown[] }; cell?: { el?: unknown } };
				} | null
			)?.tableCell;
			const sel = tc?.table?.selectedCells;
			if (Array.isArray(sel) && sel.length) {
				let best: { row: number; col: number; el?: unknown } | null = null;
				for (const raw of sel) {
					const c = raw as { row?: number; col?: number; el?: unknown };
					if (typeof c.row !== "number" || typeof c.col !== "number") continue;
					if (!best || c.row > best.row || (c.row === best.row && c.col > best.col)) {
						best = { row: c.row, col: c.col, el: c.el };
					}
				}
				if (best?.el instanceof HTMLTableCellElement) return best.el;
			}
			if (tc?.cell?.el instanceof HTMLTableCellElement) return tc.cell.el;
		}
		const painted = document.body.querySelectorAll<HTMLTableCellElement>("td.ptb-sel, th.ptb-sel");
		if (painted.length) return painted[painted.length - 1];
		return this.outlined?.closest<HTMLTableCellElement>("td, th") ?? null;
	}

	/** Keep the handle on the corner of whatever is selected now. Cheap enough to
	 *  run from every panel refresh, which is what keeps it in step. */
	private renderFillHandle() {
		const cell = this.settings.fillHandle ? this.handleAnchor() : null;
		const existing = document.body.querySelector<HTMLElement>(".ptb-fh");
		if (!cell || !cell.closest(":is(.markdown-rendered, .cm-table-widget) table")) {
			existing?.remove();
			return;
		}
		if (existing?.parentElement === cell) return;
		existing?.remove();
		cell.append(
			createDiv({
				cls: "ptb-fh",
				attr: { title: "Drag to fill: a series where the cells describe one, a copy where they do not" },
			})
		);
	}

	/** Grid row index of a doc line, given the table's first line: the inverse of
	 *  the sum every fill and click path does in the other direction. */
	private gridRowOfLine(start: number, line: number): number {
		return line === start ? 0 : line - start - 1;
	}

	/**
	 * Drag the handle. The pointer picks an axis by leaving the seed's rows or
	 * its columns, the cells it would write are outlined as it goes, and a label
	 * follows it reading the value that will land where it is, which is the one
	 * part of Excel's handle that makes the rest legible.
	 */
	private onFillDown(evt: PointerEvent) {
		if (evt.button !== 0 || !(evt.target instanceof Element)) return;
		if (!evt.target.closest(".ptb-fh")) return;
		const anchor = evt.target.closest<HTMLTableCellElement>("td, th");
		const table = anchor?.closest<HTMLTableElement>("table");
		if (!anchor || !table) return;
		evt.preventDefault();
		evt.stopPropagation();

		const sel = this.widgetSelection();
		const single = sel ? null : this.resolveTarget(true);
		const seed = sel ? sel.targets.map((t) => ({ line: t.line, col: t.col })) : single ? [{ line: single.line, col: single.col }] : [];
		const path = sel?.path ?? single?.path;
		const editor = sel?.editor ?? single?.editor ?? (path ? this.editorForPath(path) : null);
		const anchorDoc = this.docCellFromDom(anchor);
		if (!seed.length || !path || !editor || !anchorDoc || anchorDoc.path !== path) return;

		// The document cannot change mid-drag, so one snapshot answers every
		// preview; re-reading it per pointermove would be the same string.
		const lines = editor.getValue().split("\n");
		const rows = this.guideRows(table);
		const anchorRow = rows.indexOf(anchor.closest<HTMLTableRowElement>("tr") as HTMLTableRowElement);
		if (anchorRow < 0) return;
		const start = anchorDoc.line - (anchorRow === 0 ? 0 : anchorRow + 1);
		const seedRows = seed.map((s) => this.gridRowOfLine(start, s.line));
		const r1 = Math.min(...seedRows);
		const r2 = Math.max(...seedRows);
		const c1 = Math.min(...seed.map((s) => s.col));
		const c2 = Math.max(...seed.map((s) => s.col));

		const tip = document.body.createDiv({ cls: "ptb-fh-tip" });
		let dest: { line: number; col: number } | null = null;
		const clear = () => {
			table.querySelectorAll(".ptb-fh-to").forEach((c) => c.removeClass("ptb-fh-to"));
		};

		const move = (e: PointerEvent) => {
			const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLTableCellElement>("td, th");
			clear();
			dest = null;
			tip.toggleClass("is-shown", false);
			if (!over || over.closest("table") !== table) return;
			const row = rows.indexOf(over.closest<HTMLTableRowElement>("tr") as HTMLTableRowElement);
			const col = over.cellIndex;
			if (row < 0) return;
			// out of the seed's rows makes it a row fill, out of its columns a
			// column fill, and inside both means the drag is back where it began
			const rowFill = row < r1 || row > r2;
			const colFill = !rowFill && (col < c1 || col > c2);
			if (!rowFill && !colFill) return;
			const lo = rowFill ? Math.min(row, r1) : Math.min(col, c1);
			const hi = rowFill ? Math.max(row, r2) : Math.max(col, c2);
			for (let r = rowFill ? lo : r1; r <= (rowFill ? hi : r2); r++) {
				for (let c = colFill ? lo : c1; c <= (colFill ? hi : c2); c++) {
					if (r >= r1 && r <= r2 && c >= c1 && c <= c2) continue;
					rows[r]?.cells[c]?.addClass("ptb-fh-to");
				}
			}
			dest = { line: row === 0 ? start : start + row + 1, col };
			const text = dragFillPreview(lines, seed, dest);
			if (text == null) return;
			tip.setText(text || "(empty)");
			tip.toggleClass("is-shown", true);
			tip.style.left = e.clientX + 14 + "px";
			tip.style.top = e.clientY + 18 + "px";
		};

		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
			clear();
			tip.remove();
			const to = dest;
			if (!to) return;
			void this.runPlan({ path, editor, fromCursor: false }, (ls) => planDragFill(ls, seed, to));
		};

		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
	}

	/** Apply one table's appearance overrides (data-tbl on a header-cell span)
	 *  as classes on the table element; CSS resolves them against the globals. */
	private applyFlagClasses(tbl: HTMLElement) {
		const tag = tbl.querySelector("span.ptb[data-tbl]")?.getAttribute("data-tbl") ?? "";
		const flags = parseTableFlagTag(tag);
		for (const f of TABLE_FLAGS) {
			tbl.toggleClass("ptb-t-" + f, flags[f] === true);
			tbl.toggleClass("ptb-t-no" + f, flags[f] === false);
		}
	}

	private applyTableFlags() {
		document.body.querySelectorAll("table").forEach((tbl) => this.applyFlagClasses(tbl));
	}

	/* ---------------- AutoFilter (hides rows on screen; only the filter itself is stored) ---------------- */

	/** Whether this table draws its filter buttons: its own override first, then
	 *  the global setting. */
	private filtersOn(tbl: HTMLTableElement): boolean {
		if (tbl.hasClass("ptb-t-filters")) return true;
		if (tbl.hasClass("ptb-t-nofilters")) return false;
		return this.settings.filterRow;
	}

	private renderFunnels() {
		document.body
			.querySelectorAll<HTMLTableElement>(":is(.markdown-rendered, .cm-table-widget) table")
			.forEach((tbl) => {
				const on = this.filtersOn(tbl);
				if (!on) {
					if (tbl.querySelector(".ptb-funnel")) {
						tbl.querySelectorAll(".ptb-funnel").forEach((f) => f.remove());
						tbl.querySelectorAll(".ptb-hasfunnel").forEach((c) => (c as HTMLElement).removeClass("ptb-hasfunnel"));
						tbl.querySelectorAll("tr.ptb-fhidden").forEach((r) => (r as HTMLElement).removeClass("ptb-fhidden"));
					}
					return;
				}
				const head = tbl.rows[0];
				if (!head) return;
				Array.from(head.cells).forEach((cell, i) => this.ensureFunnel(cell, i));
				this.applyFilters(tbl);
			});
	}

	/** The funnel in a header cell. Excel puts it at the right-hand end of the
	 *  header and marks it while that column is filtering, which is the only
	 *  sign on screen that rows are missing. */
	private ensureFunnel(cell: HTMLTableCellElement, index: number) {
		let el = cell.querySelector<HTMLElement>(":scope > .ptb-funnel");
		if (!el) {
			el = createDiv({ cls: "ptb-funnel" });
			setIcon(el, "list-filter");
			cell.append(el);
			cell.addClass("ptb-hasfunnel");
		}
		if (el.dataset.i !== String(index)) el.dataset.i = String(index);
		const f = this.filterOf(cell);
		el.toggleClass("ptb-funnel-on", !!f);
		const tip = f ? `Filtered: ${filterLabel(f)}. Click to change it.` : "Filter this column";
		if (el.title !== tip) el.title = tip;
	}

	/** A column's filter, read off the header cell's own span. The markdown is
	 *  the source of truth and the rendered span carries the attribute through,
	 *  so nothing here has to go back to the file to know what is filtering. */
	private filterOf(cell: HTMLTableCellElement): ColFilter | null {
		const span = cell.querySelector<HTMLElement>("span.ptb[data-flt]");
		return parseFilterTag(span?.getAttribute("data-flt") ?? null);
	}

	/**
	 * Hide the rows that fail any column's filter.
	 *
	 * The text comes off the rendered cell because that is what is already here;
	 * filteredRows reaches the same answer from the file, for SUBTOTAL and copy,
	 * which have no DOM to read. The two agree because both route their text
	 * through normalizeText, which resolves a wiki link to the alias it renders
	 * as and strips emphasis, so markdown and rendered text arrive at the same
	 * string. Hidden rows stay in the DOM, so the next pass can bring them back.
	 */
	private applyFilters(table: HTMLTableElement) {
		const head = table.rows[0];
		if (!head) return;
		// A header cell under the cursor in Live Preview is a text editor, not
		// rendered markup, so its filter is momentarily invisible. Re-reading now
		// would unhide the column's rows for as long as the cursor sits there;
		// leaving the view alone until the cell renders again is the honest
		// answer, since nothing has actually changed.
		if (head.querySelector(".cm-editor")) return;
		const filters = Array.from(head.cells).map((c) => this.filterOf(c));
		const rows = Array.from(table.rows).slice(1);
		for (const row of rows) {
			let hide = false;
			for (let c = 0; c < filters.length && !hide; c++) {
				if (filters[c] && !filterHit(cellText(row.cells[c]), filters[c])) hide = true;
			}
			row.toggleClass("ptb-fhidden", hide);
		}
	}

	/* ---------------- keyboard range selection ---------------- */

	/** The cell the cursor is in, as the table element and its grid coordinates.
	 *  Live Preview only: Reading view has no cursor to extend from. */
	private focusedWidgetCell(): { table: HTMLTableElement; row: number; col: number } | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.getMode() === "preview") return null;
		const em = (view as unknown as { editMode?: unknown }).editMode ?? view.editor;
		const tc = (
			em as { tableCell?: { table?: WidgetTable; cell?: { row?: number; col?: number } } } | null
		)?.tableCell;
		const table = tc?.table?.tableEl;
		const cell = tc?.cell;
		if (!(table instanceof HTMLTableElement) || !cell || typeof cell.row !== "number" || typeof cell.col !== "number") {
			return null;
		}
		return { table, row: cell.row, col: cell.col };
	}

	/**
	 * Whether the caret has run out of text in the direction it is being pushed.
	 *
	 * This is what lets Shift+Left/Right mean two things without a mode. Inside a
	 * cell's text it selects text, which is what it does everywhere else in
	 * Obsidian and what people are entitled to expect; at the end of the text
	 * there is nothing left to select, so the same key starts taking cells, which
	 * is what it does in Excel. An empty cell is at both ends at once, so a fresh
	 * table behaves like a grid straight away.
	 */
	private caretSpent(back: boolean): boolean {
		const sel = window.getSelection();
		if (!sel || !sel.rangeCount) return true;
		if (!sel.isCollapsed) return false; // text is selected: that gesture is already under way
		const range = sel.getRangeAt(0);
		const host = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)
			?.closest<HTMLElement>(".cm-content, td, th");
		if (!host) return true;
		const pre = document.createRange();
		pre.selectNodeContents(host);
		pre.setEnd(range.startContainer, range.startOffset);
		const before = pre.toString().length;
		return back ? before === 0 : before >= (host.textContent ?? "").length;
	}

	/**
	 * Excel's selection keys, for the table the cursor is in.
	 *
	 * Shift+Up/Down always take cells: a table cell holds one line, so those keys
	 * have no text meaning to take away. Shift+Left/Right defer to the text until
	 * the caret runs out of it, and stop deferring entirely once a block is
	 * selected, because then there is no single caret left to be considerate of.
	 */
	private onTableKeys(evt: KeyboardEvent): boolean {
		const at = this.focusedWidgetCell();
		if (!at) return false;
		const rows = this.guideRows(at.table);
		const cols = rows[0]?.cells.length ?? 0;
		if (!rows.length || !cols) return false;
		const mod = evt.ctrlKey || evt.metaKey;
		const last = rows.length - 1;

		// Ctrl+A takes the table, then gets out of the way: pressing it again with
		// the whole table already taken is how you reach "select the note".
		if (mod && !evt.shiftKey && evt.key.toLowerCase() === "a") {
			const live = this.readWidgetSelection();
			if (live && live.targets.length >= rows.length * cols) return false;
			this.keyAnchor = { table: at.table, row: 0, col: 0 };
			return this.selectNative(at.table, { r1: 0, c1: 0, r2: last, c2: cols - 1 }, false);
		}
		// Ctrl+Space takes the column, Shift+Space the row, both together the
		// whole table, as in Excel. Plain Shift+Space has to defer to the text
		// first: holding Shift through the space of "Hello World" is a common
		// enough slip that stealing it would be worse than the key is worth.
		if (evt.key === " " && (mod || evt.shiftKey)) {
			if (!mod && !this.readWidgetSelection() && !this.caretSpent(false)) return false;
			const block: CellBlock =
				mod && evt.shiftKey
					? { r1: 0, c1: 0, r2: last, c2: cols - 1 }
					: mod
						? { r1: 0, c1: at.col, r2: last, c2: at.col }
						: { r1: at.row, c1: 0, r2: at.row, c2: cols - 1 };
			this.keyAnchor = { table: at.table, row: block.r1, col: block.c1 };
			return this.selectNative(at.table, block, false);
		}

		const step: Record<string, [number, number]> = {
			ArrowUp: [-1, 0],
			ArrowDown: [1, 0],
			ArrowLeft: [0, -1],
			ArrowRight: [0, 1],
		};
		const d = step[evt.key];
		if (!d) return false;
		if (!evt.shiftKey && !mod) return false;
		const [dr, dc] = d;
		const live = this.readWidgetSelection();
		// Sideways keys belong to the text until the caret runs out of it, whether
		// they are extending a selection or jumping by word. Once a block is
		// selected there is no single caret left to be considerate of.
		if (dc !== 0 && !live && !this.caretSpent(dc < 0)) return false;

		// The remembered anchor only means anything while the selection it belongs
		// to is still live. Once there is none, the cursor's own cell is the
		// anchor, which is what starting a fresh selection means and what saves
		// this from having to be cleared by every gesture that could invalidate it.
		const anchor =
			live && this.keyAnchor && this.keyAnchor.table === at.table
				? this.keyAnchor
				: { table: at.table, row: at.row, col: at.col };
		const head = this.keyHead(at.table, rows, cols, anchor, at, dr, dc, mod);
		if (!head) return false;
		if (!evt.shiftKey) {
			// A plain Ctrl+Arrow moves rather than selects, so it lands the cursor
			// and leaves the anchor there for whatever Shift press comes next.
			// selectCells cannot express one cell (it refuses a range that starts
			// and ends in the same place), so this goes through cell focus.
			this.keyAnchor = { table: at.table, row: head.r, col: head.c };
			this.dropStickySelection();
			return this.focusCell(at.table, head.r, head.c);
		}
		this.keyAnchor = anchor;
		const block: CellBlock = {
			r1: Math.min(anchor.row, head.r),
			c1: Math.min(anchor.col, head.c),
			r2: Math.max(anchor.row, head.r),
			c2: Math.max(anchor.col, head.c),
		};
		// Shrinking back onto the anchor is a selection of one, which selectCells
		// will not express: it refuses a range that starts and ends in the same
		// place. That is the moment the selection should simply stop existing.
		if (block.r1 === block.r2 && block.c1 === block.c2) {
			this.dropStickySelection();
			return this.focusCell(at.table, block.r1, block.c1);
		}
		return this.selectNative(at.table, block, false);
	}

	/**
	 * Where the head lands. A plain arrow steps one cell; with Ctrl it runs to the
	 * edge of the data.
	 *
	 * Rows an AutoFilter is hiding are stepped over rather than through, so the
	 * keys move between the rows on screen. Landing a selection edge on a row
	 * that cannot be seen is the one outcome with nothing to recommend it.
	 */
	private keyHead(
		table: HTMLTableElement,
		rows: HTMLTableRowElement[],
		cols: number,
		anchor: { row: number; col: number },
		at: { row: number; col: number },
		dr: number,
		dc: number,
		toEdge: boolean
	): { r: number; c: number } | null {
		// the head is the corner away from the anchor, which is where the last
		// press left it; with no selection it is the cursor's own cell
		const live = this.readWidgetSelection();
		let hr = at.row;
		let hc = at.col;
		if (live) {
			const b = this.selectionBlock(table);
			if (b) {
				hr = anchor.row === b.r1 ? b.r2 : b.r1;
				hc = anchor.col === b.c1 ? b.c2 : b.c1;
			}
		}
		const shown = rows.map((tr, i) => i).filter((i) => i === 0 || !rows[i].hasClass("ptb-fhidden"));
		if (!shown.length) return null;
		if (toEdge) {
			const grid = shown.map((i) => Array.from({ length: cols }, (_, c) => cellText(rows[i].cells[c])));
			const y = Math.max(0, shown.indexOf(hr));
			const p = edgeInDirection(grid, y, hc, dr, dc);
			return { r: shown[p.r] ?? hr, c: p.c };
		}
		if (dc !== 0) return { r: hr, c: Math.max(0, Math.min(cols - 1, hc + dc)) };
		const y = shown.indexOf(hr);
		const next = Math.max(0, Math.min(shown.length - 1, (y < 0 ? 0 : y) + dr));
		return { r: shown[next], c: hc };
	}

	/** Put the cursor in one cell, which is a move rather than a selection. */
	private focusCell(table: HTMLTableElement, row: number, col: number): boolean {
		try {
			const t = this.acquireWidgetTable(table);
			if (!t?.receiveCellFocus) return false;
			t.receiveCellFocus(row, col);
			return true;
		} catch {
			return false;
		}
	}

	/** The rectangle Obsidian's current selection covers, in grid coordinates. */
	private selectionBlock(table: HTMLTableElement): CellBlock | null {
		const t = this.acquireWidgetTable(table);
		const sel = t?.selectedCells;
		if (!Array.isArray(sel) || !sel.length) return null;
		const rs: number[] = [];
		const cs: number[] = [];
		for (const c of sel) {
			const rc = c as { row?: number; col?: number };
			if (typeof rc.row === "number" && typeof rc.col === "number") {
				rs.push(rc.row);
				cs.push(rc.col);
			}
		}
		if (!rs.length) return null;
		return { r1: Math.min(...rs), c1: Math.min(...cs), r2: Math.max(...rs), c2: Math.max(...cs) };
	}

	/** Open the targeted column's filter from a command or a menu, where there is
	 *  no funnel to have pressed. */
	openFilterForTarget() {
		const t = this.resolveTarget();
		if (!t) return;
		const tbl = this.tableElForTarget(t);
		const head = tbl?.rows[0];
		const cell = head?.cells[t.col];
		if (!cell) {
			new Notice("Power Tables: turn AutoFilter on for this table first (the panel's View menu, or Settings).");
			return;
		}
		this.openFilterMenu(cell, t.col);
	}

	async clearFilters() {
		const t = this.resolveTarget();
		if (!t) return;
		const plan = await this.runPlan(t, (lines) => planClearFilters(lines, t));
		if (!plan) return;
		new Notice(
			plan.cleared
				? `${plan.cleared} column filter${plan.cleared === 1 ? "" : "s"} cleared.`
				: "Power Tables: no filters on this table."
		);
	}

	/** A press on a funnel opens that column's filter and never reaches the cell
	 *  underneath, which would otherwise start editing the header. */
	private onFunnelDown(evt: PointerEvent) {
		if (!(evt.target instanceof Element)) return;
		const el = evt.target.closest<HTMLElement>(".ptb-funnel");
		if (!el) return;
		evt.preventDefault();
		evt.stopPropagation();
		const cell = el.closest<HTMLTableCellElement>("th, td");
		if (cell) this.openFilterMenu(cell, Number(el.dataset.i ?? 0));
	}

	closeFilterMenu() {
		this.filterMenu?.remove();
		this.filterMenu = null;
	}

	/**
	 * Excel's AutoFilter dropdown: sort, then either tick the values to keep or
	 * give the column a condition.
	 *
	 * It commits on OK rather than on every tick, because a filter is stored in
	 * the note and a write per checkbox would be a write per checkbox. That is
	 * also what Excel does, so the shape is already familiar.
	 */
	openFilterMenu(cell: HTMLTableCellElement, index: number) {
		this.closeFilterMenu();
		const table = cell.closest<HTMLTableElement>("table");
		if (!table) return;
		const current = this.filterOf(cell);
		const root = document.body.createDiv({ cls: "ptb-fdrop" });
		this.filterMenu = root;

		const sorts = root.createDiv({ cls: "ptb-fsorts" });
		const sortBtn = (label: string, icon: string, dir: "asc" | "desc") => {
			const b = sorts.createEl("button", { cls: "ptb-fbtn" });
			setIcon(b.createSpan({ cls: "ptb-fbtn-icon" }), icon);
			b.createSpan({ text: label });
			b.addEventListener("click", () => {
				this.closeFilterMenu();
				void this.withCell(cell, () => this.sortTable(dir));
			});
		};
		sortBtn("Sort A→Z", "arrow-down-a-z", "asc");
		sortBtn("Sort Z→A", "arrow-up-a-z", "desc");

		// Every distinct value in the column, with how many rows hold it, taken
		// from the rendered cells so the list says what the screen says.
		const counts = new Map<string, number>();
		for (const row of Array.from(table.rows).slice(1)) {
			const v = fltSafe(cellText(row.cells[index]));
			counts.set(v, (counts.get(v) ?? 0) + 1);
		}

		const ops: [FilterOp | "values", string][] = [
			["values", "Filter by value"],
			["contains", "Contains"],
			["starts", "Begins with"],
			["ends", "Ends with"],
			["eq", "Equals"],
			["gt", "Greater than"],
			["lt", "Less than"],
			["between", "Between (10 ~ 20)"],
			["empty", "Is empty"],
			["notempty", "Is not empty"],
		];
		const sel = root.createEl("select", { cls: "ptb-fop" });
		for (const [value, label] of ops) sel.createEl("option", { value, text: label });
		sel.value = !current || current.op === "in" || current.op === "ex" ? "values" : current.op;

		const cond = root.createDiv({ cls: "ptb-fcond" });
		const val = cond.createEl("input", { cls: "ptb-fval", attr: { type: "text", placeholder: "Value" } });
		if (current && current.op !== "in" && current.op !== "ex") val.value = current.value;

		const listWrap = root.createDiv({ cls: "ptb-flistwrap" });
		const search = listWrap.createEl("input", {
			cls: "ptb-fsearch",
			attr: { type: "search", placeholder: "Search values" },
		});
		const list = listWrap.createDiv({ cls: "ptb-flist" });

		// Ticked means visible. A stored filter decides the starting state; with
		// none stored everything is ticked, which is what "no filter" means.
		const ticked = new Set<string>();
		for (const v of counts.keys()) {
			const shown = !current || current.op === "in" || current.op === "ex" ? filterHit(v, current) : true;
			if (shown) ticked.add(v);
		}
		const boxes = new Map<string, HTMLInputElement>();
		const allBox = list.createEl("label", { cls: "ptb-fitem ptb-fall" });
		const allInput = allBox.createEl("input", { attr: { type: "checkbox" } });
		allBox.createSpan({ text: "(Select all)" });
		// Select-all follows the search: it ticks what you can see, which is the
		// only reading that makes it useful on a column of hundreds.
		const syncAll = () => {
			const visible = [...boxes].filter(([, b]) => !b.parentElement?.hasClass("ptb-fgone"));
			const on = visible.filter(([v]) => ticked.has(v)).length;
			allInput.checked = on === visible.length && !!visible.length;
			allInput.indeterminate = on > 0 && on < visible.length;
		};
		for (const [value, count] of counts) {
			const row = list.createEl("label", { cls: "ptb-fitem" });
			const box = row.createEl("input", { attr: { type: "checkbox" } });
			box.checked = ticked.has(value);
			row.createSpan({ cls: "ptb-fitem-t", text: value || "(blank)" });
			row.createSpan({ cls: "ptb-fitem-n", text: String(count) });
			box.addEventListener("change", () => {
				if (box.checked) ticked.add(value);
				else ticked.delete(value);
				syncAll();
			});
			boxes.set(value, box);
		}
		allInput.addEventListener("change", () => {
			for (const [v, b] of boxes) {
				if (b.parentElement?.hasClass("ptb-fgone")) continue;
				b.checked = allInput.checked;
				if (allInput.checked) ticked.add(v);
				else ticked.delete(v);
			}
			syncAll();
		});
		// The search narrows the list rather than the table: it is how you find a
		// value to tick when the column holds hundreds.
		search.addEventListener("input", () => {
			const n = search.value.trim().toLowerCase();
			for (const [v, b] of boxes) {
				b.parentElement?.toggleClass("ptb-fgone", !!n && !v.toLowerCase().includes(n));
			}
			syncAll();
		});
		syncAll();

		const showValues = () => {
			const values = sel.value === "values";
			listWrap.toggleClass("ptb-fhide", !values);
			cond.toggleClass("ptb-fhide", values);
			val.toggleClass("ptb-fhide", sel.value === "empty" || sel.value === "notempty");
		};
		sel.addEventListener("change", showValues);
		showValues();

		const commit = (filter: ColFilter | null) => {
			this.closeFilterMenu();
			const apply = (tgt: ClickTarget) =>
				void this.runPlan({ ...tgt, editor: this.editorForPath(tgt.path), fromCursor: false }, (lines) =>
					planSetColumnFilter(lines, tgt, filter)
				);
			const tgt = this.targetFromCell(cell);
			if (tgt) apply({ ...tgt, col: index });
			else void this.fallbackTargetFromCell(cell).then((fb) => fb && apply({ ...fb, col: index }));
		};

		const foot = root.createDiv({ cls: "ptb-ffoot" });
		const clear = foot.createEl("button", { cls: "ptb-fbtn", text: "Clear" });
		clear.addEventListener("click", () => commit(null));
		const cancel = foot.createEl("button", { cls: "ptb-fbtn", text: "Cancel" });
		cancel.addEventListener("click", () => this.closeFilterMenu());
		const ok = foot.createEl("button", { cls: "ptb-fbtn mod-cta", text: "OK" });
		ok.addEventListener("click", () => {
			if (sel.value !== "values") {
				const op = sel.value as FilterOp;
				const v = op === "empty" || op === "notempty" ? "" : val.value.trim();
				commit(op !== "empty" && op !== "notempty" && !v ? null : { op, value: v });
				return;
			}
			// Store whichever side of the tick list is shorter. Which side that is
			// also decides what a value arriving later does, and the shorter side
			// is the one that describes what was meant: untick two of forty and
			// new arrivals should show, tick one of forty and they should not.
			const all = [...counts.keys()];
			const out = all.filter((v) => !ticked.has(v));
			if (!out.length) commit(null);
			else if (ticked.size <= out.length) commit({ op: "in", value: [...ticked].map(fltValue).join("~") });
			else commit({ op: "ex", value: out.map(fltValue).join("~") });
		});

		// anchored under the funnel, then pulled back inside the window
		const r = cell.getBoundingClientRect();
		const box = root.getBoundingClientRect();
		const left = Math.max(6, Math.min(r.right - box.width, window.innerWidth - box.width - 6));
		const top = r.bottom + 4 + box.height > window.innerHeight ? Math.max(6, r.top - box.height - 4) : r.bottom + 4;
		root.style.left = `${left}px`;
		root.style.top = `${top}px`;
		search.focus();
	}

	/** Copy a span's background onto its <td>/<th> so the whole cell fills, like a
	 *  spreadsheet, unless it's a text highlight (ptb-hl), which stays on the text. */
	private lift(span: HTMLElement) {
		const cell = span.closest<HTMLTableCellElement>("td, th");
		if (!cell) return;
		// Borders ride an attribute copied onto the cell rather than a :has()
		// selector reaching down into the span. :has() invalidates styles up the
		// tree whenever any descendant changes, and a note full of tables being
		// live-edited changes descendants constantly. This sweep already runs on
		// the same mutations, so mirroring the attribute costs nothing extra.
		const b = span.getAttribute("data-b");
		if (b) {
			if (cell.getAttribute("data-ptb-b") !== b) cell.setAttribute("data-ptb-b", b);
		} else if (cell.hasAttribute("data-ptb-b")) {
			cell.removeAttribute("data-ptb-b");
		}
		if (span.classList.contains("ptb-hl")) return;
		const bg = span.style.backgroundColor;
		if (!bg) return;
		if (cell.style.backgroundColor !== bg) cell.style.backgroundColor = bg;
		cell.setAttribute("data-ptb", "");
		span.setAttribute("data-lifted", "");
	}

	/** Apply data-w column widths from header-cell spans onto the header cells.
	 *  Phones never pin: stored widths are desktop measurements, and a narrow
	 *  screen reads best when columns shrink and text wraps to fit. Falling
	 *  through to the removal branch also strips widths a pre-1.19.2 version
	 *  of the plugin may have left on this device's DOM. */
	private applyColumnWidths() {
		const pin = !Platform.isPhone;
		document.body.querySelectorAll("table").forEach((tbl) => {
			const firstRow = tbl.querySelector("tr");
			if (!firstRow) return;
			Array.from(firstRow.children).forEach((cellEl) => {
				const el = cellEl as HTMLElement;
				const cellEd = el.querySelector(".cm-editor");
				let w: string | null;
				if (cellEd) {
					// A focused header cell swaps its rendered span for a raw-text
					// editor in a rebuilt <th>, so the painted width is gone and the
					// column collapsed until blur. The stored width still sits in
					// the raw text; read it from the editor's doc and keep pinning.
					const ev = EditorView.findFromDOM(cellEd as HTMLElement);
					w = ev?.state.doc.toString().match(/data-w="(\d{2,4})"/)?.[1] ?? null;
					if (!w) return; // mid-mount, or the markup itself is being edited
				} else {
					w = el.querySelector("span.ptb[data-w]")?.getAttribute("data-w") ?? null;
				}
				if (pin && w && /^\d{2,4}$/.test(w)) {
					if (el.style.width !== w + "px") {
						el.style.width = w + "px";
						el.style.minWidth = w + "px";
					}
					el.setAttribute("data-ptb-w", "");
				} else if (el.hasAttribute("data-ptb-w")) {
					el.style.removeProperty("width");
					el.style.removeProperty("min-width");
					el.removeAttribute("data-ptb-w");
				}
			});
		});
	}

	/** Render a leading "[ ]"/"[x]" in a cell as a real checkbox (ticking it writes back). */
	private renderCheckboxes() {
		document.body.querySelectorAll("table td, table th").forEach((cellEl) => {
			if (cellEl.querySelector(".cm-editor") || cellEl.querySelector("input.ptb-cbx")) return;
			const walker = document.createTreeWalker(cellEl, NodeFilter.SHOW_TEXT);
			let node = walker.nextNode() as Text | null;
			while (node && !node.nodeValue?.trim()) node = walker.nextNode() as Text | null;
			// only a cell-level editor (focused cell) blocks rendering; in Live
			// Preview every cell is inside the note's own .cm-editor, and that's fine
			if (!node?.nodeValue) return;
			const m = node.nodeValue.match(CHECKBOX_RE);
			if (!m) return;
			const box = createEl("input");
			box.type = "checkbox";
			box.className = "ptb-cbx";
			box.checked = m[1] !== " ";
			node.nodeValue = node.nodeValue.slice(m[0].length);
			node.parentElement?.insertBefore(box, node);
		});
	}

	/* ---------------- targeting ---------------- */

	/** Which row of the table this is. Every rendered row maps to a markdown
	 *  line now that filtering injects nothing; a row hidden by a filter is
	 *  still one of them, which is what keeps the guides numbering the file
	 *  rather than the screen. */
	private realRowIndex(tr: HTMLTableRowElement): number | null {
		return tr.rowIndex;
	}

	private targetFromCell(cell: HTMLTableCellElement): ClickTarget | null {
		const table = cell.closest<HTMLTableElement>("table");
		const start = table?.getAttribute("data-ptb-start");
		const path = table?.getAttribute("data-ptb-path");
		if (!table || start == null || !path) return null;
		const tr = cell.closest<HTMLTableRowElement>("tr");
		if (!tr) return null;
		const idx = this.realRowIndex(tr);
		if (idx == null) return null;
		// Header row is the table's first line; +1 extra skips the |---| divider for body rows.
		const line = parseInt(start, 10) + (idx === 0 ? 0 : idx + 1);
		return { path, line, col: cell.cellIndex, expect: cell.textContent ?? "" };
	}

	/** The DOM table the Live Preview editor's cursor is currently inside, when
	 *  Obsidian's table editor exposes one. Feature-detected like the rest. */
	targetTableEl(): HTMLElement | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return null;
		const em = (view as unknown as { editMode?: unknown }).editMode ?? (view.editor);
		const tc = (em as { tableCell?: { table?: { tableEl?: HTMLElement | null } } } | null)?.tableCell;
		return tc?.table?.tableEl ?? null;
	}

	/**
	 * "B3" for a rendered table cell, from the DOM alone, using the numbering
	 * the gutter draws: the header row is 1 and body rows carry on.
	 *
	 * References are table-local, so a click in some other table would insert
	 * one that quietly resolves against the formula's own table instead. The
	 * caller passes the table it snapshotted when the formula was loaded; if it
	 * cannot be matched, this returns null and the click just behaves normally.
	 */
	refFromDomCell(cell: HTMLTableCellElement, target: CellTarget, snapshot: HTMLElement | null): string | null {
		const table = cell.closest<HTMLTableElement>("table");
		if (!table) return null;
		if (snapshot) {
			if (table !== snapshot) return null;
		} else {
			// Reading view: the post-processor stamped where this table lives
			const startAttr = table.getAttribute("data-ptb-start");
			if (startAttr == null || table.getAttribute("data-ptb-path") !== target.path) return null;
			const start = parseInt(startAttr, 10);
			if (target.line < start || target.line > start + table.rows.length) return null;
		}
		const tr = cell.closest<HTMLTableRowElement>("tr");
		if (!tr) return null;
		const idx = this.realRowIndex(tr);
		if (idx == null) return null;
		return `${colLetter(cell.cellIndex)}${idx + 1}`;
	}

	private onDocClick(evt: MouseEvent) {
		if (!(evt.target instanceof Element)) return;
		if (evt.target.closest(".ptb-toolbar") || evt.target.closest(".ptb-panel")) return;
		const cell = evt.target.closest<HTMLTableCellElement>("td, th");
		if (!cell || !cell.closest(".markdown-rendered")) return;
		const tgt = this.targetFromCell(cell);
		if (tgt) {
			this.clickTarget = tgt;
			if (this.toolbar || this.panels.size) this.setOutline(cell);
			this.updatePanels();
			return;
		}
		// Table not stamped (e.g. the pane rendered before the plugin loaded)
		// resolve by position and content instead.
		void this.fallbackTargetFromCell(cell).then((fb) => {
			if (!fb) return;
			this.clickTarget = fb;
			if (this.toolbar || this.panels.size) this.setOutline(cell);
			this.updatePanels();
		});
	}

	/** Stampless targeting: find the hosting note, count tables to this one, and match the row. */
	private async fallbackTargetFromCell(cell: HTMLTableCellElement): Promise<ClickTarget | null> {
		let path: string | null = null;
		let hostEl: HTMLElement | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const v = leaf.view;
			if (!path && v instanceof MarkdownView && v.containerEl.contains(cell)) {
				path = v.file?.path ?? null;
				hostEl = v.containerEl;
			}
		});
		if (!path || !hostEl) return null;
		const table = cell.closest<HTMLTableElement>("table");
		const tr = cell.closest<HTMLTableRowElement>("tr");
		if (!table || !tr) return null;
		const tableIdx = Array.from((hostEl as HTMLElement).querySelectorAll("table")).indexOf(table);
		if (tableIdx < 0) return null;
		const ed = this.editorForPath(path);
		let lines: string[];
		if (ed) {
			lines = ed.getValue().split("\n");
		} else {
			const af = this.app.vault.getAbstractFileByPath(path);
			if (!(af instanceof TFile)) return null;
			lines = (await this.app.vault.cachedRead(af)).split("\n");
		}
		let idx = -1;
		let start = -1;
		for (let i = 0; i < lines.length; i++) {
			const r = parseRow(lines[i]);
			const prev = i > 0 ? parseRow(lines[i - 1]) : null;
			const nxt = i + 1 < lines.length ? parseRow(lines[i + 1]) : null;
			if (r && !r.isDelim && !prev && nxt?.isDelim) {
				idx++;
				if (idx === tableIdx) {
					start = i;
					break;
				}
			}
		}
		if (start < 0) return null;
		const ri = this.realRowIndex(tr);
		if (ri == null) return null;
		const line = start + (ri === 0 ? 0 : ri + 1);
		return { path, line, col: cell.cellIndex, expect: cell.textContent ?? "" };
	}

	private onCellContextMenu(evt: MouseEvent) {
		if (!(evt.target instanceof Element)) return;
		const cell = evt.target.closest<HTMLTableCellElement>("td, th");
		if (!cell || !cell.closest(".markdown-rendered")) return;
		const tgt = this.targetFromCell(cell);
		if (tgt) {
			this.clickTarget = tgt;
		} else {
			// resolve asynchronously; the menu's actions re-resolve on click anyway
			void this.fallbackTargetFromCell(cell).then((fb) => {
				if (fb) {
					this.clickTarget = fb;
					this.updatePanels();
				}
			});
		}
		this.setOutline(cell);
		this.updatePanels();
		// Obsidian raises its own menu when the right-click lands on a link, and
		// two menus stacked over one click is what the user gets if we raise a
		// second. Let Obsidian's win; addLinkCellItems hangs the table actions
		// off it so nothing is lost by standing down here.
		if (evt.target.closest("a.external-link, a.internal-link")) return;
		// answered here, so it cannot go on to fill a link menu somewhere else
		this.rightPressCell = null;
		evt.preventDefault();
		const menu = new Menu();
		this.addStructureItems(menu);
		menu.showAtMouseEvent(evt);
	}

	/** Append the table actions to the link menu Obsidian raised over one of our
	 *  cells. Both events also fire for links nowhere near a table, so the
	 *  remembered press is the gate, and it is spent on the first menu it fills. */
	private addLinkCellItems(menu: Menu) {
		const cell = this.rightPressCell;
		this.rightPressCell = null;
		if (!cell) return;
		menu.addSeparator();
		menu.addItem((i) =>
			i.setTitle("Edit link…").setIcon("link").onClick(() => void this.withCell(cell, () => this.linkCell()))
		);
		this.addStructureItems(menu, cell);
	}

	/**
	 * Run a menu action against the cell its menu was raised over.
	 *
	 * Obsidian's table editor holds focus wherever it already was when a
	 * right-click lands on a link, since the link's own menu is what that click
	 * is for. resolveTarget reads that focused cell first and is right to, for
	 * every other caller: it is the cell the user is actually working in. Here
	 * it is the last cell they typed in, which can be anywhere in the note, so
	 * the action has to be told the cell instead of asking for it.
	 */
	private async withCell(cell: HTMLTableCellElement | null, fn: () => unknown) {
		const tgt = cell ? this.targetFromCell(cell) ?? (await this.fallbackTargetFromCell(cell)) : null;
		if (!tgt) {
			await fn();
			return;
		}
		this.pinnedTarget = tgt;
		try {
			// Only the synchronous prefix needs the pin. Every action either
			// finishes here or resolves its target and hands it to a dialog,
			// which is the pinning the dialogs already do for themselves.
			await fn();
		} finally {
			this.pinnedTarget = null;
		}
	}

	private addStructureItems(menu: Menu, cell: HTMLTableCellElement | null = null) {
		const run = (fn: () => unknown) => void this.withCell(cell, fn);
		menu.addItem((i) => i.setTitle("Copy cells").setIcon("copy").onClick(() => run(() => this.copyCells())));
		menu.addItem((i) => i.setTitle("Cut cells").setIcon("scissors").onClick(() => run(() => this.copyCells(true))));
		menu.addItem((i) => i.setTitle("Paste cells").setIcon("clipboard-paste").onClick(() => run(() => this.pasteCells())));
		menu.addItem((i) =>
			i.setTitle("Paste special…").setIcon("clipboard-list").onClick((e) => this.showPasteMenu(e as MouseEvent, cell))
		);
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Insert row above").setIcon("arrow-up").onClick(() => run(() => this.insertRow("above"))));
		menu.addItem((i) => i.setTitle("Insert row below").setIcon("arrow-down").onClick(() => run(() => this.insertRow("below"))));
		menu.addItem((i) => i.setTitle("Insert column left").setIcon("arrow-left").onClick(() => run(() => this.insertColumn("left"))));
		menu.addItem((i) =>
			i.setTitle("Insert column right").setIcon("arrow-right").onClick(() => run(() => this.insertColumn("right")))
		);
		menu.addItem((i) => i.setTitle("Duplicate row").setIcon("copy").onClick(() => run(() => this.duplicateRow())));
		menu.addItem((i) =>
			i.setTitle("Fill down").setIcon("arrow-down-to-line").onClick(() => run(() => this.fill("down")))
		);
		menu.addItem((i) =>
			i.setTitle("Fill right").setIcon("arrow-right-to-line").onClick(() => run(() => this.fill("right")))
		);
		menu.addItem((i) =>
			i.setTitle("Edit value / formula…").setIcon("function-square").onClick(() => run(() => this.openFormulaModal()))
		);
		menu.addItem((i) => i.setTitle("Clear cell contents").setIcon("eraser").onClick(() => run(() => this.clearContents(null))));
		menu.addItem((i) =>
			i.setTitle("Auto-fit column widths").setIcon("chevrons-right-left").onClick(() => run(() => this.autoFitColumnWidths()))
		);
		menu.addItem((i) =>
			i.setTitle("Reset column width").setIcon("move-horizontal").onClick(() => run(() => this.resetColumnWidth()))
		);
		menu.addItem((i) =>
			i.setTitle("Prettify table").setIcon("align-justify").onClick(() => run(() => this.prettifyTable()))
		);
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Delete row").setIcon("trash").onClick(() => run(() => this.deleteRow())));
		menu.addItem((i) => i.setTitle("Delete column").setIcon("trash-2").onClick(() => run(() => this.deleteColumn())));
	}

	private setOutline(el: HTMLElement | null) {
		this.outlined?.removeClass("ptb-target");
		this.outlined = el;
		el?.addClass("ptb-target");
	}

	resolveTarget(silent = false): CellTarget | null {
		// A menu action pins the cell its menu was raised over, and that beats
		// every live reading below: see withCell for why the live ones are wrong
		// for exactly that case.
		if (this.pinnedTarget) {
			return { ...this.pinnedTarget, editor: this.editorForPath(this.pinnedTarget.path), fromCursor: false };
		}
		// The sidebar is a workspace leaf, so clicking its buttons makes IT the
		// active view, fall back to the most recent note leaf in that case.
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		const recent = this.app.workspace.getMostRecentLeaf();
		const view = active ?? (recent?.view instanceof MarkdownView ? recent.view : null);
		if (view && view.file && view.getMode() !== "preview") {
			const editor = view.editor;
			// The focused table-cell editor knows its exact doc offsets, more
			// reliable than the main cursor, which Obsidian doesn't always sync
			// when an empty cell gains focus.
			const wcell = this.widgetCellAt(view);
			if (wcell) {
				return { path: view.file.path, line: wcell.line, col: wcell.col, expect: null, editor, fromCursor: true };
			}
			const cur = editor.getCursor("head");
			const row = parseRow(editor.getLine(cur.line));
			if (row && !row.isDelim) {
				return {
					path: view.file.path,
					line: cur.line,
					col: colFromCh(row, cur.ch),
					expect: null,
					editor,
					fromCursor: true,
				};
			}
			if (row && row.isDelim && !this.clickTarget) {
				if (!silent) new Notice("Power Tables: that's the divider row (move the cursor to a content row).");
				return null;
			}
		}
		if (this.clickTarget) {
			return { ...this.clickTarget, editor: this.editorForPath(this.clickTarget.path), fromCursor: false };
		}
		if (!silent) {
			new Notice("Power Tables: click a table cell (Reading view) or put the cursor in one (Editing view) first.");
		}
		return null;
	}

	/**
	 * What the ref chip and formula bar should describe when several cells are
	 * selected: the block, and its first cell as the thing an edit lands on.
	 * Without this the display falls back to wherever the cursor drifted after
	 * the last edit, which is both confusing to read and dangerous to type into.
	 */
	selectionDisplay(): { target: CellTarget; ref: string; summary: string } | null {
		const sel = this.widgetSelection();
		if (!sel) return null;
		const lines = sel.editor.getValue().split("\n");
		const r1 = Math.min(...sel.targets.map((t) => t.line));
		const r2 = Math.max(...sel.targets.map((t) => t.line));
		const c1 = Math.min(...sel.targets.map((t) => t.col));
		const c2 = Math.max(...sel.targets.map((t) => t.col));
		const target: CellTarget = { path: sel.path, line: r1, col: c1, expect: null, editor: sel.editor, fromCursor: false };
		const rowNo = (line: number) => {
			let start = line;
			while (start > 0 && parseRow(lines[start - 1])) start--;
			let delim = -1;
			for (let i = start; i < lines.length; i++) {
				const rr = parseRow(lines[i]);
				if (!rr) break;
				if (rr.isDelim) {
					delim = i;
					break;
				}
			}
			return delim < 0 ? 1 : line < delim ? 1 : line - delim + 1;
		};
		const a = `${colLetter(c1)}${rowNo(r1)}`;
		const b = `${colLetter(c2)}${rowNo(r2)}`;
		const rows = r2 - r1 + 1;
		const cols = c2 - c1 + 1;
		return {
			target,
			ref: a === b ? a : `${a}:${b}`,
			summary: `${sel.targets.length} cells selected (${rows} × ${cols})`,
		};
	}

	/** Cell reference ("B3") and summary for the panel header; null when nothing is targeted. */
	currentRef(target?: CellTarget | null): { ref: string; summary: string } | null {
		const t = target ?? this.resolveTarget(true);
		if (!t) return null;
		const letter = colLetter(t.col);
		let rowLabel = "?";
		const ed = t.editor ?? this.editorForPath(t.path);
		if (ed) {
			const lines = ed.getValue().split("\n");
			if (t.line < lines.length) {
				let start = t.line;
				while (start > 0 && parseRow(lines[start - 1])) start--;
				let delim = -1;
				for (let i = start; i < lines.length; i++) {
					const r = parseRow(lines[i]);
					if (!r) break;
					if (r.isDelim) {
						delim = i;
						break;
					}
				}
				// the header is row 1 and the first data row is 2, so the chip
				// reads the same number the gutter draws beside the row
				rowLabel = delim < 0 ? "?" : t.line < delim ? "1" : String(t.line - delim + 1);
			}
		}
		return { ref: `${letter}${rowLabel}`, summary: `Column ${letter} · Row ${rowLabel} (1 × 1 cell)` };
	}

	/** Map a table-widget cell (structural row/col) to doc coordinates: the
	 *  widget's DOM anchor gives the table's first line, widget row 0 is the
	 *  header, and body rows sit below the delimiter. Structural indices are
	 *  stable, unlike character offsets or the main cursor, which Obsidian
	 *  doesn't always keep in sync. All internals feature-detected. */
	private widgetCellLine(
		em: unknown,
		table: { tableEl?: HTMLElement | null },
		row: number,
		col: number,
		view: MarkdownView
	): { line: number; col: number } | null {
		const cm = (em as { cm?: EditorView } | null)?.cm;
		const tableEl = table?.tableEl;
		if (!cm || !tableEl || !tableEl.isConnected) return null;
		try {
			const startLine = cm.state.doc.lineAt(cm.posAtDOM(tableEl)).number - 1;
			const line = startLine + (row === 0 ? 0 : row + 1);
			const r = parseRow(view.editor.getLine(line) ?? "");
			if (!r || r.isDelim || col >= r.cellCount) return null;
			return { line, col };
		} catch {
			return null;
		}
	}

	/** The Live Preview table widget's focused cell, in doc coordinates. */
	private widgetCellAt(view: MarkdownView): { line: number; col: number } | null {
		const em = (view as unknown as { editMode?: unknown }).editMode ?? (view.editor);
		const tc = (
			em as {
				tableCell?: { table?: { tableEl?: HTMLElement | null }; cell?: { row?: number; col?: number } };
			} | null
		)?.tableCell;
		const cell = tc?.cell;
		if (!tc?.table || !cell || typeof cell.row !== "number" || typeof cell.col !== "number") return null;
		return this.widgetCellLine(em, tc.table, cell.row, cell.col, view);
	}

	/**
	 * The table editor's multi-cell selection (2+ cells), as doc targets.
	 *
	 * Sticky on purpose. Applying a format rewrites the table's lines, Obsidian
	 * re-renders the widget, and the widget drops selectedCells on the way
	 * through, so the very next toolbar press would find nothing selected and
	 * quietly act on one cell instead. Selecting a column and clicking 123 then
	 * $ then Auto has to keep meaning the column. The remembered selection is
	 * cleared by the gestures that genuinely start a new one, never by our own
	 * edits, which is the distinction the live read cannot make.
	 */
	widgetSelection(): { path: string; editor: Editor; targets: { line: number; col: number; expect: null }[] } | null {
		const live = this.readWidgetSelection();
		if (live) {
			this.stickySel = live;
			return live;
		}
		const s = this.stickySel;
		if (!s) return null;
		// the remembered cells have to still be cells: validate before trusting
		// coordinates that were taken before the last edit
		const ed = this.editorForPath(s.path);
		const stillCells =
			!!ed &&
			s.targets.every((t) => {
				const r = parseRow(ed.getLine(t.line) ?? "");
				return !!r && !r.isDelim && t.col < r.cellCount;
			});
		if (!ed || !stillCells) {
			this.stickySel = null;
			return null;
		}
		return { ...s, editor: ed };
	}

	/** Forget the remembered selection: a new gesture is starting one. */
	private dropStickySelection() {
		this.stickySel = null;
		this.clearGuidePaint();
	}

	/** Work has moved out of the table. Both remembered signals go, so nothing
	 *  downstream can answer "still in a table" from a cell you have left. */
	private leaveTableContext() {
		this.stickySel = null;
		this.clickTarget = null;
		this.guideAnchor = null;
		this.clearGuidePaint();
	}

	/** Whether the live cursor is on a table row, ignoring anything remembered.
	 *  In Reading view there is no cursor, so this cannot answer and says so. */
	private cursorInTable(): boolean {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file || view.getMode() === "preview") return true;
		if (this.widgetCellAt(view)) return true;
		const cur = view.editor.getCursor("head");
		return !!parseRow(view.editor.getLine(cur.line) ?? "");
	}

	private readWidgetSelection(): { path: string; editor: Editor; targets: { line: number; col: number; expect: null }[] } | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		const recent = this.app.workspace.getMostRecentLeaf();
		const view = active ?? (recent?.view instanceof MarkdownView ? recent.view : null);
		if (!view || !view.file || view.getMode() === "preview") return null;
		const em = (view as unknown as { editMode?: unknown }).editMode ?? (view.editor);
		const table = (
			em as { tableCell?: { table?: { tableEl?: HTMLElement | null; selectedCells?: unknown[] } } } | null
		)?.tableCell?.table;
		const sel = table?.selectedCells;
		if (!table || !Array.isArray(sel) || sel.length < 2) return null;
		const targets: { line: number; col: number; expect: null }[] = [];
		for (const c of sel) {
			const rc = c as { row?: number; col?: number };
			if (typeof rc.row !== "number" || typeof rc.col !== "number") continue;
			const t = this.widgetCellLine(em, table, rc.row, rc.col, view);
			if (t) targets.push({ ...t, expect: null });
		}
		return targets.length >= 2 ? { path: view.file.path, editor: view.editor, targets } : null;
	}

	/** Route a cell action: an explicit modifier wins, then the table editor's
	 *  multi-cell selection (each selected cell at "cell" scope), then Apply-to. */
	private async cellAction(
		evt: MouseEvent | null,
		fn: (lines: string[], t: { line: number; col: number; expect: string | null }, scope: Scope) => EditPlan | null
	) {
		const forced: Scope | null = evt?.shiftKey ? "row" : evt && (evt.ctrlKey || evt.metaKey) ? "column" : null;
		const sel = forced ? null : this.widgetSelection();
		if (sel) {
			await this.runPlan({ path: sel.path, editor: sel.editor, fromCursor: false }, (lines) =>
				planMulti(lines, sel.targets, (ls, t) => fn(ls, t, "cell"))
			);
			return;
		}
		const t = this.resolveTarget();
		if (!t) return;
		await this.runPlan(t, (lines) => fn(lines, t, forced ?? this.uiScope));
	}

	private editorForPath(path: string): Editor | null {
		let found: Editor | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const v = leaf.view;
			if (!found && v instanceof MarkdownView && v.file?.path === path && v.getMode() !== "preview") {
				found = v.editor;
			}
		});
		return found;
	}

	/* ---------------- applying colors ---------------- */

	applyFromUI(patch: Patch, evt: MouseEvent | null) {
		if (typeof patch.bg === "string") {
			if (patch.hl) this.settings.lastHl = patch.bg;
			else this.settings.lastFill = patch.bg;
		}
		if (typeof patch.fg === "string") this.settings.lastText = patch.fg;
		void this.saveSettings();
		this.updatePanels();
		void this.cellAction(evt, (lines, t, scope) => planEdits(lines, t, patch, scope));
	}

	/** Per-table appearance overrides for the targeted table ({} = none).
	 *  Reads the file when no editor is open (Reading view), so the panel
	 *  reflects the note's stored overrides everywhere. */
	async tableFlags(target?: CellTarget | null): Promise<Partial<Record<TableFlag, boolean>>> {
		const t = target ?? this.resolveTarget(true);
		if (!t) return {};
		const ed = t.editor ?? this.editorForPath(t.path);
		let lines: string[];
		if (ed) {
			lines = ed.getValue().split("\n");
		} else {
			const af = this.app.vault.getAbstractFileByPath(t.path);
			if (!(af instanceof TFile)) return {};
			lines = (await this.app.vault.cachedRead(af)).split("\n");
		}
		return tableFlagsAt(lines, t);
	}

	/** Flip one appearance flag for the targeted table. The override lives in
	 *  the markdown; when it lands back on the global default it's removed, so
	 *  untouched tables keep following the global settings. */
	async toggleTableFlag(flag: TableFlag) {
		const t = this.resolveTarget();
		if (!t) return;
		const s = this.settings;
		const globalOn =
			flag === "guides"
				? s.cellRefs
				: flag === "striped"
					? s.stripedRows
					: flag === "headerfill"
						? s.fillHeaders
						: flag === "sticky"
							? s.stickyHeaders
							: flag === "filters"
								? s.filterRow
								: s.compactTables;
		const effective = (await this.tableFlags(t))[flag] ?? globalOn;
		const next = !effective;
		await this.runPlan(t, (lines) => planSetTableFlag(lines, t, flag, next === globalOn ? null : next));
		this.scanAll();
		this.updatePanels();
	}

	/** Command-palette / mobile-toolbar version of tapping a swatch: apply the
	 *  mode's most recent color at the panel's Apply-to scope. */
	applyLastColor(mode: "fill" | "text" | "hl", evt: MouseEvent | null = null) {
		const s = this.settings;
		const patch: Patch =
			mode === "fill" ? { bg: s.lastFill } : mode === "text" ? { fg: s.lastText } : { bg: s.lastHl, hl: true };
		this.applyFromUI(patch, evt);
	}

	/** Undo/redo the note, for the bar that stands in for the editor's toolbar
	 *  while you are in a table. */
	editorUndo(redo: boolean) {
		const ed = this.resolveTarget(true)?.editor ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
		const e = ed as unknown as { undo?: () => void; redo?: () => void } | undefined;
		if (redo) e?.redo?.();
		else e?.undo?.();
	}

	/**
	 * Format painter. The first press copies the targeted cell's look, the next
	 * cell you click wears it. Colors, highlight, borders, and number format
	 * travel; the value never does, which is the whole point of a painter.
	 */
	togglePainter() {
		// off -> once -> locked -> off. Clicking the lit button again is how the
		// sticky mode is discovered, and it means an Excel user's double-click
		// lands on "locked" anyway, without any double-click handling.
		if (this.painterMode === "once") {
			this.painterMode = "locked";
			new Notice("Format painter locked on. Every cell you click gets the look; Esc or the brush stops it.");
			this.syncPainterChrome();
			this.updatePanels();
			return;
		}
		if (this.painterMode === "locked") {
			this.setPainterOff("Format painter off.");
			return;
		}
		const t = this.resolveTarget();
		if (!t) return;
		const raw = this.cellAttrsAt(t);
		if (!raw) return;
		this.painter = raw;
		this.painterMode = "once";
		this.painterFrom = { line: t.line, col: t.col };
		// An unformatted cell is a legitimate thing to copy: it is how the
		// painter strips a look back off, the same way Excel's does. The patch
		// carries explicit nulls, which planEdits reads as "clear".
		const bare = raw.bg == null && raw.fg == null && raw.borders == null && raw.fmt == null;
		new Notice(
			bare
				? "Format painter on, holding no formatting. Click a cell to strip its look; click the brush again to keep going."
				: "Format painter on. Click a cell to paint it; click the brush again to keep painting."
		);
		this.syncPainterChrome();
		this.updatePanels();
	}

	private setPainterOff(msg?: string) {
		this.painter = null;
		this.painterMode = "off";
		this.painterFrom = null;
		if (msg) new Notice(msg);
		this.syncPainterChrome();
		this.updatePanels();
	}

	/** Body classes drive both the brush's own state and the cursor over cells,
	 *  the same way the pen tool advertises itself. */
	private syncPainterChrome() {
		document.body.toggleClass("ptb-painting", this.painterMode !== "off");
		document.body.toggleClass("ptb-painting-locked", this.painterMode === "locked");
	}

	/** The look of a cell, as a patch that can be applied to another. */
	private cellAttrsAt(t: CellTarget): Patch | null {
		const ed = t.editor ?? this.editorForPath(t.path);
		if (!ed) return null;
		const lines = ed.getValue().split("\n");
		const located = locateLine(lines, t);
		if (located == null) return null;
		const r = parseRow(lines[located]);
		if (!r || r.isDelim) return null;
		const p = parseCellContent(r.pieces[Math.min(t.col, r.cellCount - 1) + 1]);
		// Everything that is a *look* travels: colors, the highlight mode,
		// borders, and the number format. Every field is stated rather than
		// left undefined, so copying a plain cell clears the target instead of
		// leaving whatever it already had. What stays behind is the value, the
		// column width, and any calc or formula: those are not the cell's
		// appearance, and a painter that moved them would be a different tool.
		return { bg: p.bg, fg: p.fg, hl: p.hl, borders: p.borders, fmt: p.fmt };
	}

	/** Link the targeted cell's text, or edit the link it already holds. */
	async linkCell() {
		const t = this.resolveTarget();
		if (!t) return;
		const raw = (this.currentCellRaw(t) ?? "").trim();
		const link = parseCellLink(raw);
		if (link) {
			// A cell that is already a link opens for editing with its target
			// filled in. Unlinking used to be all this did, which meant the only
			// way to correct a URL was to throw it away and retype the whole
			// thing; it is the second button now.
			new LinkCellModal(
				this.app,
				link.label,
				link.url,
				async (text, url) => void (await this.commitCellValue(buildCellLink(text, url, link.kind), t)),
				// nothing to unlink on a plain URL: stripping the markup off it
				// would leave the same string it already is
				link.kind === "bare"
					? null
					: async () => {
							await this.commitCellValue(link.label, t);
							new Notice("Link removed; the text stays.");
						}
			).open();
			return;
		}
		if (!raw) {
			new Notice("Power Tables: put some text in the cell first, then link it.");
			return;
		}
		new LinkCellModal(this.app, raw, "", async (text, url) => {
			await this.commitCellValue(buildCellLink(text, url), t);
		}).open();
	}

	async styleText(style: TextStyle, evt: MouseEvent | null) {
		await this.cellAction(evt, (lines, t, scope) => planTextStyle(lines, t, style, scope));
	}

	async toggleCheckbox(evt: MouseEvent | null) {
		await this.cellAction(evt, (lines, t, scope) => planToggleCheckbox(lines, t, scope));
	}

	async resetColumnWidth() {
		const t = this.resolveTarget();
		if (!t) return;
		await this.runPlan(t, (lines) => planSetColumnWidth(lines, t, null));
	}

	async prettifyTable() {
		const t = this.resolveTarget();
		if (!t) return;
		const plan = await this.runPlan(t, (lines) => planPrettify(lines, t));
		if (!plan) return;
		new Notice(plan.rows ? `Aligned ${plan.rows} table line(s).` : "Power Tables: the table is already tidy.");
	}

	private async commitColumnWidth(cell: HTMLTableCellElement, width: number) {
		const tgt = this.targetFromCell(cell) ?? (await this.fallbackTargetFromCell(cell));
		if (!tgt) return;
		await this.runPlan({ ...tgt, editor: this.editorForPath(tgt.path), fromCursor: false }, (lines) =>
			planSetColumnWidth(lines, tgt, width)
		);
	}

	/** The header cell whose right edge the pointer is on (the resize hot zone). */
	private headerEdgeAt(evt: PointerEvent | MouseEvent): HTMLElement | null {
		// phones never apply widths, so dragging one out would just snap back
		if (Platform.isPhone) return null;
		if (!(evt.target instanceof Element)) return null;
		// the funnel sits in the band the resize edge would claim, and it is the
		// smaller target of the two, so it wins the pixels it covers
		if (evt.target.closest(".ptb-funnel")) return null;
		const cell = evt.target.closest<HTMLTableCellElement>("th, td");
		if (!cell) return null;
		const tr = cell.closest<HTMLTableRowElement>("tr");
		if (!tr || tr.rowIndex !== 0) return null;
		if (!cell.closest(".markdown-rendered") && !cell.closest(".cm-table-widget")) return null;
		const r = cell.getBoundingClientRect();
		// A boundary is grabbable from either side of the line, because that is
		// what people aim at. Testing only right edges made the real target the
		// few pixels inside one particular cell: land a pixel past the divider
		// and closest() hands back the NEXT cell, whose own right edge is a whole
		// column away, so the hover silently did nothing. Checking the left edge
		// too and resizing the previous column turns two one-sided slivers into
		// one band centred on the divider.
		if (evt.clientX >= r.right - EDGE_GRAB && evt.clientX <= r.right + 2) return cell;
		if (evt.clientX <= r.left + EDGE_GRAB && evt.clientX >= r.left - 2) {
			const prev = cell.previousElementSibling;
			return prev instanceof HTMLTableCellElement ? prev : null;
		}
		return null;
	}

	/** Excel's AutoFit: measure every column's widest unwrapped content on the
	 *  rendered table and store those widths, so each column ends up at the
	 *  smallest size that still shows all of its data. */
	async autoFitColumnWidths() {
		if (Platform.isPhone) {
			new Notice("Power Tables: phones ignore stored column widths so tables can shrink and wrap to fit; run auto-fit on a bigger screen.");
			return;
		}
		const t = this.resolveTarget();
		if (!t) return;
		const tbl = this.tableElForTarget(t);
		const widths = tbl ? this.measureColumnWidths(tbl) : [];
		if (!widths.length) {
			new Notice("Power Tables: auto-fit needs the rendered table. View the note in Live Preview or Reading view.");
			return;
		}
		const plan = await this.runPlan(t, (lines) => planAutoFitColumnWidths(lines, t, widths));
		if (!plan) return;
		new Notice(
			plan.edits.length
				? `Auto-fit: ${widths.length} column${widths.length === 1 ? "" : "s"} sized to fit.`
				: "Power Tables: the columns already fit their content."
		);
	}

	/** Auto-fit a single column from a double-click on its header's resize edge. */
	private async autoFitColumn(cell: HTMLTableCellElement) {
		const tbl = cell.closest<HTMLTableElement>("table");
		const w = tbl ? this.measureColumnWidths(tbl)[cell.cellIndex] : undefined;
		if (w == null) return;
		const tgt = this.targetFromCell(cell) ?? (await this.fallbackTargetFromCell(cell));
		if (!tgt) return;
		await this.runPlan({ ...tgt, editor: this.editorForPath(tgt.path), fromCursor: false }, (lines) =>
			planSetColumnWidth(lines, tgt, w)
		);
	}

	/** Natural no-wrap width of every column, in px. The momentary ptb-measure
	 *  class lets each column shrink-wrap its widest content; it's added and
	 *  removed within one task, before the browser ever paints, so nothing
	 *  flashes on screen. */
	private measureColumnWidths(tbl: HTMLTableElement): number[] {
		const firstRow = tbl.querySelector("tr");
		if (!firstRow) return [];
		// The widths being measured around are inline ones this plugin set, and
		// no amount of selector specificity beats an inline style. So take them
		// off for the measurement and put them back, rather than shouting them
		// down with !important from the stylesheet.
		const pinned = Array.from(tbl.querySelectorAll<HTMLElement>("td[style*='width'], th[style*='width']")).map(
			(el) => [el, el.style.width] as const
		);
		for (const [el] of pinned) el.style.removeProperty("width");
		tbl.addClass("ptb-measure");
		try {
			// +2 absorbs fractional-pixel rounding so a stored width never lands
			// a hair under the content and wraps it after all
			return Array.from(firstRow.children).map((c) => Math.ceil(c.getBoundingClientRect().width) + 2);
		} finally {
			tbl.removeClass("ptb-measure");
			for (const [el, w] of pinned) el.style.width = w;
		}
	}

	/** The rendered <table> showing the target's markdown table: Live Preview
	 *  widgets are matched by their position in the doc, Reading-view tables by
	 *  the stamps the post-processor left. Hidden panes measure as zero-width
	 *  and are skipped. */
	private tableElForTarget(t: { path: string; line: number }): HTMLTableElement | null {
		// a table whose markdown starts at `start` spans start..start+rows lines
		// (header + delimiter + body)
		const contains = (tbl: HTMLTableElement, start: number) => {
			const rows = tbl.querySelectorAll("tr").length;
			return t.line >= start && t.line <= start + rows;
		};
		let found: HTMLTableElement | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const v = leaf.view;
			if (found || !(v instanceof MarkdownView) || v.file?.path !== t.path || v.getMode() === "preview") return;
			const em = (v as unknown as { editMode?: unknown }).editMode ?? (v.editor);
			const cm = (em as { cm?: EditorView } | null)?.cm;
			if (!cm) return;
			for (const el of Array.from(v.containerEl.querySelectorAll("table"))) {
				const tbl = el;
				if (!tbl.closest(".cm-table-widget") || !tbl.getBoundingClientRect().width) continue;
				try {
					if (contains(tbl, cm.state.doc.lineAt(cm.posAtDOM(tbl)).number - 1)) {
						found = tbl;
						return;
					}
				} catch {
					/* table not in this editor's DOM */
				}
			}
		});
		if (found) return found;
		for (const el of Array.from(document.body.querySelectorAll("table[data-ptb-start]"))) {
			const tbl = el as HTMLTableElement;
			const start = parseInt(tbl.getAttribute("data-ptb-start") ?? "", 10);
			if (
				tbl.getAttribute("data-ptb-path") === t.path &&
				!Number.isNaN(start) &&
				tbl.getBoundingClientRect().width &&
				contains(tbl, start)
			) {
				return tbl;
			}
		}
		return null;
	}

	async alignColumn(align: ColAlign, snapshot?: ReturnType<PowerTablesPlugin["widgetSelection"]>) {
		// a multi-cell selection aligns every column it spans. The selection bar
		// passes the one it snapshotted, because pressing its button is exactly
		// what makes the live selection go away.
		const sel = snapshot ?? this.widgetSelection();
		if (sel) {
			const cols = [...new Set(sel.targets.map((t) => t.col))];
			if (this.alignViaWidget(sel.path, cols, align)) return;
			await this.runPlan({ path: sel.path, editor: sel.editor, fromCursor: false }, (lines) =>
				planMulti(
					lines,
					cols.map((c) => ({ line: sel.targets[0].line, col: c, expect: null })),
					(ls, t) => planAlign(ls, t, align)
				)
			);
			return;
		}
		const t = this.resolveTarget();
		if (!t) return;
		if (t.fromCursor && this.alignViaWidget(t.path, [t.col], align)) return;
		await this.runPlan(t, (lines) => planAlign(lines, t, align));
	}

	/** Live Preview's table widget caches column alignment when it is built and
	 *  never re-parses the delimiter row on outside edits, it even serializes
	 *  the stale cache back over them on its next write. While a cell editor is
	 *  active, go through the widget's own setAlignment (updates the DOM, the
	 *  cache, and the markdown in one step); rewriting the delimiter row stays
	 *  the fallback for source mode and Reading view, where no widget is alive. */
	private alignViaWidget(path: string, cols: number[], align: ColAlign): boolean {
		const views: MarkdownView[] = [];
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) views.push(active);
		const recent = this.app.workspace.getMostRecentLeaf();
		if (recent?.view instanceof MarkdownView) views.push(recent.view);
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) views.push(leaf.view);
		});
		for (const view of views) {
			if (view.file?.path !== path || view.getMode() === "preview") continue;
			// Undocumented internals, feature-detect every step and fall through cleanly.
			const em = (view as unknown as { editMode?: unknown }).editMode ?? (view.editor);
			const table = (
				em as {
					tableCell?: {
						table?: {
							alignments?: unknown[];
							tableEl?: HTMLElement | null;
							setAlignment?: (cols: number[], dir: "start" | "center" | "end") => void;
						};
					};
				} | null
			)?.tableCell?.table;
			if (!table || typeof table.setAlignment !== "function" || !Array.isArray(table.alignments)) continue;
			if (cols.some((c) => c >= (table.alignments as unknown[]).length)) continue;
			const rtl = table.tableEl ? getComputedStyle(table.tableEl).direction === "rtl" : false;
			try {
				table.setAlignment(cols, alignToLogical(align, rtl));
			} catch {
				continue;
			}
			this.updatePanels();
			return true;
		}
		return false;
	}

	async formatNumber(fmt: NumFmt, evt: MouseEvent | null) {
		await this.cellAction(evt, (lines, t, scope) => planFormatNumber(lines, t, fmt, scope));
	}

	/** One-shot format at the Apply-to scope; for row/column, `sticky` also
	 *  writes (or clears) the auto-reapply marker. A multi-cell selection wins
	 *  at cell scope and formats every selected cell. The Format cells dialog
	 *  passes the target it pinned at open: by Apply-click time the modal owns
	 *  focus and the table widget has dropped its cell, so a live re-resolve
	 *  comes back empty and the apply used to silently do nothing. */
	async applyFormat(spec: FmtSpec, sticky: boolean, target?: CellTarget | null) {
		const scope = this.uiScope;
		const sel = scope === "cell" ? this.widgetSelection() : null;
		if (sel) {
			await this.runPlan({ path: sel.path, editor: sel.editor, fromCursor: false }, (lines) =>
				planMulti(lines, sel.targets, (ls, t) => planFormatCells(ls, t, spec, "cell"))
			);
			return;
		}
		const t = target ?? this.resolveTarget();
		if (!t) return;
		await this.runPlan(t, (lines) => planFormatCells(lines, t, spec, scope));
		if (scope === "row" || scope === "column") {
			await this.runPlan(t, (lines) => planStickyFormat(lines, t, sticky ? fmtToTag(spec) : null, scope));
		}
	}

	/** The sticky format tag already stored for the target's Apply-to row/column, if any. */
	currentStickyTag(target?: CellTarget | null): string | null {
		const scope = this.uiScope;
		if (scope !== "row" && scope !== "column") return null;
		const t = target ?? this.resolveTarget(true);
		if (!t) return null;
		const ed = t.editor ?? this.editorForPath(t.path);
		if (!ed) return null;
		const lines = ed.getValue().split("\n");
		const ln = locateLine(lines, t);
		if (ln == null) return null;
		if (scope === "column") {
			const { start } = tableBounds(lines, ln);
			const hr = parseRow(lines[start]);
			if (!hr || hr.isDelim) return null;
			const col = Math.min(t.col, hr.cellCount - 1);
			return parseCellContent(hr.pieces[col + 1]).fmt;
		}
		const r = parseRow(lines[ln]);
		if (!r || r.isDelim) return null;
		for (let c = 0; c < r.cellCount; c++) {
			const f = parseCellContent(r.pieces[c + 1]).fmt;
			if (f?.startsWith("row:")) return f.slice(4);
		}
		return null;
	}

	openFormatModal() {
		new FormatCellsModal(this.app, this).open();
	}

	async applyBorders(action: BorderAction) {
		await this.cellAction(null, (lines, t, scope) => planBorders(lines, t, action, scope));
	}

	/* ---------------- Draw Borders ---------------- */

	/**
	 * A clicked table cell in document coordinates, in either view. Reading view
	 * has the post-processor's stamp to go on; Live Preview has none, so the
	 * table's own position in the document is asked of CodeMirror and the row
	 * and column come from the DOM.
	 */
	private docCellFromDom(cell: HTMLTableCellElement): { path: string; line: number; col: number } | null {
		const tr = cell.closest<HTMLTableRowElement>("tr");
		const table = cell.closest<HTMLTableElement>("table");
		if (!tr || !table) return null;
		const idx = this.realRowIndex(tr);
		if (idx == null) return null;
		const stamped = table.getAttribute("data-ptb-start");
		const path = table.getAttribute("data-ptb-path");
		// header is the table's first line; body rows clear the |---| divider
		const lineFor = (start: number) => start + (idx === 0 ? 0 : idx + 1);
		if (stamped != null && path) return { path, line: lineFor(parseInt(stamped, 10)), col: cell.cellIndex };
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return null;
		const cm = (view.editor as unknown as { cm?: EditorView }).cm;
		if (!cm) return null;
		try {
			const start = cm.state.doc.lineAt(cm.posAtDOM(table)).number - 1;
			return { path: view.file.path, line: lineFor(start), col: cell.cellIndex };
		} catch {
			return null;
		}
	}

	/** Which edge of a cell the pointer is nearest, for the pen that draws one
	 *  edge at a time. Whichever side it is closest to wins. */
	private nearestEdge(cell: HTMLElement, x: number, y: number): "top" | "bottom" | "left" | "right" {
		const r = cell.getBoundingClientRect();
		const d = { top: y - r.top, bottom: r.bottom - y, left: x - r.left, right: r.right - x };
		return (Object.keys(d) as (keyof typeof d)[]).reduce((a, b) => (d[b] < d[a] ? b : a));
	}

	/** Arm or disarm a drawing tool. Toggling the armed one off is how you stop,
	 *  as is Escape. */
	setPen(tool: "border" | "grid" | "erase" | null) {
		this.pen = this.pen?.tool === tool ? null : tool ? { tool } : null;
		document.body.toggleClass("ptb-drawing", !!this.pen);
		document.body.toggleClass("ptb-drawing-erase", this.pen?.tool === "erase");
		new Notice(
			this.pen
				? `${this.pen.tool === "erase" ? "Erase" : this.pen.tool === "grid" ? "Draw grid" : "Draw border"}: drag over cells. Esc or the same button to stop.`
				: "Border pen off."
		);
	}

	/** Collect a stroke while the pen is armed and commit it in one edit. */
	private registerPenHandlers() {
		let stroke: { line: number; col: number; edge?: Edge }[] = [];
		let path: string | null = null;
		let drawing = false;
		const at = (e: PointerEvent) => {
			if (!(e.target instanceof Element)) return null;
			const cell = e.target.closest<HTMLTableCellElement>("td, th");
			if (!cell || !cell.closest<HTMLTableElement>("table")) return null;
			const doc = this.docCellFromDom(cell);
			if (!doc) return null;
			const edge = this.pen?.tool === "border" ? this.nearestEdge(cell, e.clientX, e.clientY) : undefined;
			return { doc, edge };
		};
		const add = (e: PointerEvent) => {
			const hit = at(e);
			if (!hit) return;
			if (path && hit.doc.path !== path) return;
			path = hit.doc.path;
			const key = `${hit.doc.line}:${hit.doc.col}:${hit.edge ?? ""}`;
			if (stroke.some((s) => `${s.line}:${s.col}:${s.edge ?? ""}` === key)) return;
			stroke.push({ line: hit.doc.line, col: hit.doc.col, edge: hit.edge });
		};
		this.registerDomEvent(
			document,
			"pointerdown",
			(e) => {
				if (!this.pen || !at(e)) return;
				// keep the press off the cell editor: this is a pen stroke, not
				// a click into the text
				e.preventDefault();
				e.stopPropagation();
				drawing = true;
				stroke = [];
				path = null;
				add(e);
			},
			{ capture: true }
		);
		this.registerDomEvent(document, "pointermove", (e) => {
			if (drawing && this.pen) add(e);
		});
		this.registerDomEvent(document, "pointerup", () => {
			if (!drawing) return;
			drawing = false;
			const pen = this.pen;
			const cells = stroke;
			const p = path;
			stroke = [];
			if (!pen || !p || !cells.length) return;
			const spec = {
				tool: pen.tool,
				weight: this.settings.penStyle as EdgeWeight,
				color: this.settings.penColor === "default" ? null : (this.settings.penColor as BorderColor),
			};
			void this.runPlan({ path: p, editor: this.editorForPath(p), fromCursor: false }, (lines) =>
				planDrawBorders(lines, cells, spec)
			);
		});
		this.registerDomEvent(document, "keydown", (e) => {
			if (e.key === "Escape" && this.pen) this.setPen(null);
			// the painter is modal in the same way the pen is, so it leaves the
			// same way; a locked one especially needs an exit that is not a hunt
			// for the button that armed it
			if (e.key === "Escape" && this.painterMode !== "off") this.setPainterOff("Format painter off.");
		});
	}

	/** The pen's colour, as its own menu: this Obsidian has no submenu API. */
	showLineColorMenu(evt: MouseEvent, at?: { x: number; y: number }) {
		const pos = at ?? this.menuAnchor(evt);
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Line color").setIsLabel(true));
		const pick = (value: string, label: string) =>
			menu.addItem((i) =>
				i
					.setTitle(label)
					.setChecked(this.settings.penColor === value)
					.onClick(async () => {
						this.settings.penColor = value;
						await this.saveSettings();
					})
			);
		pick("default", "Default");
		for (const c of BORDER_COLORS) pick(c, c[0].toUpperCase() + c.slice(1));
		menu.showAtPosition(pos);
	}

	showLineStyleMenu(evt: MouseEvent, at?: { x: number; y: number }) {
		const pos = at ?? this.menuAnchor(evt);
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Line style").setIsLabel(true));
		const styles: [EdgeWeight, string][] = [
			["thin", "Thin"],
			["thick", "Thick"],
			["double", "Double"],
			["dashed", "Dashed"],
			["dotted", "Dotted"],
		];
		for (const [w, label] of styles) {
			menu.addItem((i) =>
				i
					.setTitle(label)
					.setChecked(this.settings.penStyle === w)
					.onClick(async () => {
						this.settings.penStyle = w;
						await this.saveSettings();
					})
			);
		}
		menu.showAtPosition(pos);
	}

	showBordersMenu(evt: MouseEvent, at?: { x: number; y: number }) {
		const menu = new Menu();
		const scope = this.uiScope;
		menu.addItem((i) => i.setTitle("Borders").setIsLabel(true));
		const items: [BorderAction, string, string][] = [
			["bottom", "Bottom border", "panel-bottom"],
			["top", "Top border", "panel-top"],
			["left", "Left border", "panel-left"],
			["right", "Right border", "panel-right"],
		];
		for (const [action, title, icon] of items) {
			menu.addItem((i) => i.setTitle(title).setIcon(icon).onClick(() => void this.applyBorders(action)));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("No border").setIcon("box-select").onClick(() => void this.applyBorders("none")));
		menu.addItem((i) => i.setTitle("All borders").setIcon("layout-grid").onClick(() => void this.applyBorders("all")));
		menu.addItem((i) =>
			i.setTitle(`Outside borders (${scope})`).setIcon("square").onClick(() => void this.applyBorders("outside"))
		);
		menu.addItem((i) =>
			i.setTitle(`Thick outside borders (${scope})`).setIcon("frame").onClick(() => void this.applyBorders("thickoutside"))
		);
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Stacked").setIsLabel(true));
		// glyphs chosen from ones this plugin already renders, rather than the
		// exact Lucide name for each shape: a missing icon shows as nothing, and
		// the labels carry the meaning anyway
		const stacked: [BorderAction, string, string][] = [
			["thickbottom", "Thick bottom border", "panel-bottom"],
			["doublebottom", "Double bottom border", "equal"],
			["topbottom", "Top and bottom border", "align-justify"],
			["topthickbottom", "Top and thick bottom border", "align-justify"],
			["topdoublebottom", "Top and double bottom border", "equal"],
		];
		for (const [action, title, icon] of stacked) {
			menu.addItem((i) => i.setTitle(title).setIcon(icon).onClick(() => void this.applyBorders(action)));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Draw borders").setIsLabel(true));
		const anchor = this.menuAnchor(evt);
		const pens: [("border" | "grid" | "erase"), string, string][] = [
			["border", "Draw border", "pencil"],
			["grid", "Draw border grid", "layout-grid"],
			["erase", "Erase border", "eraser"],
		];
		for (const [tool, title, icon] of pens) {
			menu.addItem((i) =>
				i
					.setTitle(title)
					.setIcon(icon)
					.setChecked(this.pen?.tool === tool)
					.onClick(() => this.setPen(tool))
			);
		}
		menu.addItem((i) =>
			i
				.setTitle(`Line color: ${this.settings.penColor}`)
				.setIcon("palette")
				.onClick(() => this.showLineColorMenu(evt, anchor))
		);
		menu.addItem((i) =>
			i
				.setTitle(`Line style: ${this.settings.penStyle}`)
				.setIcon("minus")
				.onClick(() => this.showLineStyleMenu(evt, anchor))
		);
		menu.showAtPosition(at ?? anchor);
	}

	async insertRow(where: "above" | "below") {
		const t = this.resolveTarget();
		if (!t) return;
		await this.runPlan(t, (lines) => planInsertRow(lines, t, where));
	}

	async deleteRow() {
		const t = this.resolveTarget();
		if (!t) return;
		await this.runPlan(t, (lines) => planDeleteRow(lines, t));
	}

	async duplicateRow() {
		const t = this.resolveTarget();
		if (!t) return;
		await this.runPlan(t, (lines) => planDuplicateRow(lines, t));
	}

	async insertColumn(where: "left" | "right") {
		const t = this.resolveTarget();
		if (!t) return;
		await this.runPlan(t, (lines) => planInsertColumn(lines, t, where));
	}

	async deleteColumn() {
		const t = this.resolveTarget();
		if (!t) return;
		await this.runPlan(t, (lines) => planDeleteColumn(lines, t));
	}

	async clearContents(evt: MouseEvent | null) {
		await this.cellAction(evt, (lines, t, scope) => planClearContents(lines, t, scope));
	}

	openImportModal() {
		new CsvImportModal(this.app, this).open();
	}

	openRulesModal() {
		new RulesModal(this.app, this).open();
	}

	openFormulaModal() {
		new FormulaModal(this.app, this).open();
	}

	/** Raw content of the targeted cell for the formula bar: the formula if live, else the text. */
	currentCellRaw(target?: CellTarget | null): string | null {
		const t = target ?? this.resolveTarget(true);
		if (!t) return null;
		const ed = t.editor ?? this.editorForPath(t.path);
		if (!ed) return null;
		const lines = ed.getValue().split("\n");
		const located = locateLine(lines, t);
		if (located == null) return null;
		const r = parseRow(lines[located]);
		if (!r || r.isDelim) return null;
		const col = Math.min(t.col, r.cellCount - 1);
		const parsed = parseCellContent(r.pieces[col + 1]);
		if (parsed.formula) return parsed.formula;
		if (parsed.calc) {
			// show live Σ calcs as the formula they are: =SUM(B:B) / =SUM(3:3)
			let start = located;
			while (start > 0 && parseRow(lines[start - 1])) start--;
			let delim = -1;
			for (let i = start; i < lines.length; i++) {
				const rr = parseRow(lines[i]);
				if (!rr) break;
				if (rr.isDelim) {
					delim = i;
					break;
				}
			}
			const row = delim >= 0 && located > delim ? located - delim + 1 : 1;
			return calcToFormula(parsed.calc, col, row);
		}
		// the value, not how it is stored: a bolded, highlighted, colored cell
		// is still just 500 as far as the formula bar is concerned
		return cellTextParts(parsed.inner).text;
	}

	async commitCellValue(raw: string, target?: CellTarget | null) {
		const t = target ?? this.resolveTarget();
		if (!t) return;
		await this.runPlan(t, (lines) => planSetCellValue(lines, t, raw));
	}

	/** One-shot conditional coloring; stored live rules are untouched. */
	async applyRule(rule: Rule, target?: CellTarget | null) {
		const t = target ?? this.resolveTarget();
		if (!t) return;
		const plan = await this.runPlan(t, (lines) => planApplyRule(lines, t, rule));
		if (plan) new Notice(`Rule matched ${plan.matched} cell(s) in that column.`);
	}

	/** The live rules stored on the targeted column, for the Rules dialog. */
	async currentColumnRules(target?: CellTarget | null): Promise<Rule[]> {
		const t = target ?? this.resolveTarget(true);
		if (!t) return [];
		const ed = t.editor ?? this.editorForPath(t.path);
		let lines: string[];
		if (ed) {
			lines = ed.getValue().split("\n");
		} else {
			const af = this.app.vault.getAbstractFileByPath(t.path);
			if (!(af instanceof TFile)) return [];
			lines = (await this.app.vault.cachedRead(af)).split("\n");
		}
		return columnRulesAt(lines, t);
	}

	/** Replace the targeted column's live-rule list; an empty list removes them all. */
	async setColumnRules(rules: Rule[], target?: CellTarget | null) {
		const t = target ?? this.resolveTarget();
		if (!t) return;
		const plan = await this.runPlan(t, (lines) => planSetColumnRules(lines, t, rules));
		if (plan) {
			new Notice(
				plan.active
					? `${plan.active} live rule${plan.active === 1 ? "" : "s"} active on this column.`
					: "Live rules removed. Colors already painted were left in place."
			);
		}
	}

	async copyTableCsv() {
		const t = this.resolveTarget();
		if (!t) return;
		const ed = t.editor ?? this.editorForPath(t.path);
		let lines: string[];
		if (ed) {
			lines = ed.getValue().split("\n");
		} else {
			const af = this.app.vault.getAbstractFileByPath(t.path);
			if (!(af instanceof TFile)) return;
			lines = (await this.app.vault.cachedRead(af)).split("\n");
		}
		const located = locateLine(lines, t);
		if (located == null) {
			this.cantLocate();
			return;
		}
		const csv = tableToCsv(lines, located);
		if (!csv) {
			new Notice("Power Tables: no table found.");
			return;
		}
		await navigator.clipboard.writeText(csv);
		new Notice("Table copied to the clipboard as CSV.");
	}

	applyAppearance() {
		document.body.toggleClass("ptb-striped", this.settings.stripedRows);
		document.body.toggleClass("ptb-compact", this.settings.compactTables);
		document.body.toggleClass("ptb-cellrefs", this.settings.cellRefs);
		document.body.toggleClass("ptb-headerfill", this.settings.fillHeaders);
		const dark = document.body.hasClass("theme-dark");
		document.body.style.setProperty(
			"--ptb-header-fill",
			(dark && this.settings.headerFillDark) || this.settings.headerFill
		);
		document.body.toggleClass("ptb-sticky", this.settings.stickyHeaders);
		this.queueScan(); // the filter row and the guides are DOM-injected, not CSS-driven; a rescan applies the toggle
	}

	/** One-click paste: append clipboard rows (Excel/Sheets tabs or CSV) to the targeted table. */
	async pasteFromClipboard() {
		const text = (await navigator.clipboard.readText()).trim();
		if (!text) {
			new Notice("Power Tables: the clipboard is empty.");
			return;
		}
		await this.importCsv(text, "append");
	}

	async insertTotalsRow() {
		const t = this.resolveTarget();
		if (!t) return;
		const plan = await this.runPlan(t, (lines) => planTotalsRow(lines, t));
		if (!plan) return;
		new Notice(
			plan.added
				? `Totals row added with ${plan.added} live sum${plan.added === 1 ? "" : "s"}.`
				: "Power Tables: the table already has column calcs, or nothing numeric to total."
		);
	}

	async importCsv(text: string, mode: "replace" | "append", target?: CellTarget | null) {
		const rows = parseDelimited(text);
		if (!rows.length) {
			new Notice("Power Tables: nothing to import.");
			return;
		}
		const t = target ?? this.resolveTarget(true);
		if (t) {
			const plan = await this.runPlan(t, (lines) => planImportRows(lines, t, rows, mode));
			if (plan) new Notice(`Imported ${mode === "append" ? rows.length : Math.max(0, rows.length - 1)} row(s).`);
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.getMode() === "preview") {
			new Notice("Power Tables: open a note in editing mode (or target a table cell) first.");
			return;
		}
		const cur = view.editor.getCursor("head");
		view.editor.replaceRange(tableFromRows(rows).join("\n") + "\n", { line: cur.line, ch: 0 });
		new Notice(`Inserted a table with ${Math.max(0, rows.length - 1)} data row(s).`);
	}

	async applyColor(patch: Patch, scope: Scope) {
		const t = this.resolveTarget();
		if (!t) return;
		await this.runPlan(t, (lines) => planEdits(lines, t, patch, scope));
	}

	async sumInto(direction: SumDir) {
		await this.calcInto({ fn: "sum", dir: direction });
	}

	/** AutoSum a (possibly snapshotted) selection: the result lands in the
	 *  selection's empty cell or the one just below. The stats chip captures
	 *  the selection before its press can clear it and passes it in here. */
	private async insertSelectionCalc(
		sel: NonNullable<ReturnType<PowerTablesPlugin["widgetSelection"]>>,
		fn: CalcFn
	) {
		const splan = await this.runPlan({ path: sel.path, editor: sel.editor, fromCursor: false }, (lines) =>
			planSelectionCalc(lines, sel.targets, fn)
		);
		if (!splan) return;
		if (splan.count === -1) {
			new Notice("Power Tables: include an empty cell in the selection (or leave one just below it) to hold the result.");
		} else if (!splan.count) {
			new Notice("Power Tables: no numbers in the selected cells.");
		} else {
			new Notice(`${splan.formatted} written as the live formula =${fn.toUpperCase()}(${splan.ref}).`);
		}
	}

	/** Excel's Fill Down / Fill Right. A drag selection fills from its leading
	 *  edge into the rest; a single targeted cell fills from its neighbour. */
	async fill(dir: "down" | "right") {
		const sel = this.widgetSelection();
		const where = sel
			? { target: { path: sel.path, editor: sel.editor, fromCursor: false }, targets: sel.targets }
			: null;
		let plan;
		if (where) {
			plan = await this.runPlan(where.target, (lines) => planFill(lines, where.targets, dir));
		} else {
			const t = this.resolveTarget();
			if (!t) return;
			plan = await this.runPlan(t, (lines) => planFill(lines, [{ line: t.line, col: t.col }], dir));
		}
		if (!plan) {
			new Notice(
				dir === "down"
					? "Power Tables: select the cells to fill, or put the cursor in a cell with a row above it to copy."
					: "Power Tables: select the cells to fill, or put the cursor in a cell with a column to its left to copy."
			);
			return;
		}
		if (!plan.filled) {
			new Notice("Power Tables: nothing to fill, those cells already match.");
			return;
		}
		new Notice(`Filled ${plan.filled} cell${plan.filled === 1 ? "" : "s"} ${dir}.`);
	}

	/** The cells a copy or a paste acts on: the drag selection if there is one,
	 *  otherwise the single targeted cell. */
	private clipTargets(): { where: { path: string; editor: Editor | null; fromCursor: boolean }; targets: { line: number; col: number }[] } | null {
		const sel = this.widgetSelection();
		if (sel) {
			return { where: { path: sel.path, editor: sel.editor, fromCursor: false }, targets: sel.targets };
		}
		const t = this.resolveTarget();
		if (!t) return null;
		return { where: t, targets: [{ line: t.line, col: t.col }] };
	}

	/**
	 * Take the selected block. The rich clip stays here, where formulas and
	 * formatting survive; the plain text goes to the system clipboard so the
	 * same Ctrl+C also lands in Excel, Sheets or anywhere else.
	 */
	async copyCells(cut = false, data?: DataTransfer | null) {
		const at = this.clipTargets();
		if (!at) return;
		const ed = at.where.editor ?? this.editorForPath(at.where.path);
		if (!ed) {
			new Notice("Power Tables: open the note in editing mode to copy cells.");
			return;
		}
		const clip = planCopyCells(ed.getValue().split("\n"), at.targets, { cut, path: at.where.path });
		if (!clip) {
			this.cantLocate();
			return;
		}
		this.clip = clip;
		this.clipText = clipToTsv(clip);
		if (data) data.setData("text/plain", this.clipText);
		else await navigator.clipboard.writeText(this.clipText);
		const n = clip.rows.length * (clip.rows[0]?.length ?? 0);
		new Notice(
			cut
				? `${n} cell${n === 1 ? "" : "s"} cut. They clear where they are when the paste lands.`
				: `${n} cell${n === 1 ? "" : "s"} copied.`
		);
	}

	/**
	 * Put a block back down, with its top-left on the targeted cell.
	 *
	 * `text` is what the system clipboard holds. When it is what our own copy
	 * put there the rich block lands, formulas and formatting included; when it
	 * is anything else it came from outside and lands as values, which is the
	 * only thing tab-separated text can honestly carry.
	 */
	async pasteCells(mode: PasteMode = "all", transpose = false, text?: string | null) {
		const at = this.clipTargets();
		if (!at) return;
		const incoming = text ?? (await navigator.clipboard.readText());
		let clip = this.clip && incoming.trim() === this.clipText.trim() ? this.clip : null;
		if (!clip) {
			const rows = parseDelimited(incoming ?? "");
			clip = rows.length ? clipFromRows(rows) : null;
		}
		if (!clip) {
			new Notice("Power Tables: nothing to paste. Copy some cells first.");
			return;
		}
		// A cut only takes its source with it inside the file it was cut from:
		// the plan can only see one document, and a move across two of them
		// would clear cells nothing here is holding open.
		const moving = clip.cut && clip.path === at.where.path;
		const use = moving ? clip : { ...clip, cut: false };
		const plan = await this.runPlan(at.where, (lines) => planPasteCells(lines, at.targets, use, mode, transpose));
		if (!plan) {
			this.cantLocate();
			return;
		}
		// a cut is spent once it lands, the way Excel's marching ants stop
		if (moving && plan.cleared) this.clip = { ...clip, cut: false };
		const bits = [`Pasted ${plan.pasted} cell${plan.pasted === 1 ? "" : "s"}`];
		if (plan.added) bits.push(`${plan.added} row${plan.added === 1 ? "" : "s"} added`);
		if (plan.cleared) bits.push("source cleared");
		if (clip.cut && !moving) bits.push("cut left in place, it came from another note");
		if (plan.clamped) bits.push(`${plan.clamped} past the last column dropped`);
		new Notice(bits.join(", ") + ".");
	}

	/** Excel's Paste Special menu. The cell is threaded through because this
	 *  menu is raised from another one, by which point the right-clicked cell is
	 *  no longer whatever happens to be focused. */
	showPasteMenu(evt: MouseEvent, cell: HTMLTableCellElement | null = null) {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Paste special").setIsLabel(true));
		const items: [string, string, PasteMode, boolean][] = [
			["All", "clipboard-paste", "all", false],
			["Values", "hash", "values", false],
			["Formulas", "function-square", "formulas", false],
			["Formats", "paintbrush", "formats", false],
			["Transpose", "flip-horizontal-2", "all", true],
		];
		for (const [label, icon, mode, transpose] of items) {
			menu.addItem((i) =>
				i
					.setTitle(label)
					.setIcon(icon)
					.onClick(() => void this.withCell(cell, () => this.pasteCells(mode, transpose)))
			);
		}
		menu.showAtPosition(this.menuAnchor(evt));
	}

	/**
	 * Ctrl+C / Ctrl+X over a live multi-cell selection.
	 *
	 * Only a live selection counts, never the remembered one: the sticky
	 * selection exists so a run of toolbar presses keeps meaning the same cells,
	 * and reading it here would hijack a copy the user aimed at something else
	 * entirely. A focused text field is left alone for the same reason.
	 */
	private onClipboardCopy(evt: ClipboardEvent, cut: boolean) {
		if (evt.target instanceof HTMLInputElement || evt.target instanceof HTMLTextAreaElement) return;
		if (!this.readWidgetSelection()) return;
		evt.preventDefault();
		evt.stopPropagation();
		void this.copyCells(cut, evt.clipboardData);
	}

	/**
	 * Ctrl+V into a table.
	 *
	 * Two things are worth taking over from the editor's own paste, and nothing
	 * else is: our own copied block, which would otherwise land as raw markup,
	 * and a grid of tab or newline separated text, which would otherwise pile
	 * into one cell. A single value pasted into a cell is exactly what Obsidian
	 * already does well, so it goes straight through.
	 */
	private onClipboardPaste(evt: ClipboardEvent) {
		if (evt.target instanceof HTMLInputElement || evt.target instanceof HTMLTextAreaElement) return;
		const text = evt.clipboardData?.getData("text/plain") ?? "";
		if (!text.trim()) return;
		const ours = !!this.clip && text.trim() === this.clipText.trim();
		if (!ours && !/[\t\n]/.test(text.trim())) return;
		const inTable = evt.target instanceof HTMLElement && !!evt.target.closest("table");
		if (!inTable && !this.readWidgetSelection()) return;
		evt.preventDefault();
		evt.stopPropagation();
		void this.pasteCells("all", false, text);
	}

	async calcInto(spec: CalcSpec) {
		// Excel-style AutoSum: with a drag selection, the function runs over the
		// selected range and lands in its empty cell (or the one just below).
		const sel = this.widgetSelection();
		if (sel) {
			await this.insertSelectionCalc(sel, spec.fn);
			return;
		}
		const t = this.resolveTarget();
		if (!t) return;
		const plan = await this.runPlan(t, (lines) => planToggleCalc(lines, t, spec));
		if (!plan) return;
		if (plan.toggledOff) {
			new Notice("Live calc removed. The value stays as plain text.");
			return;
		}
		if (!plan.count) {
			new Notice(`Power Tables: no numbers found in that ${spec.dir}.`);
			return;
		}
		const label = spec.fn === "avg" ? "average" : spec.fn;
		new Notice(`Σ live ${spec.dir} ${label}: ${plan.formatted} (auto-updates when the table changes)`);
	}

	async freezeCalc() {
		const t = this.resolveTarget();
		if (!t) return;
		const plan = await this.runPlan(t, (lines) => planFreezeCalc(lines, t));
		if (!plan) return;
		new Notice(
			plan.toggledOff
				? "Live calc removed. The value stays as plain text."
				: "Power Tables: that cell isn't a live calc."
		);
	}

	async sortTable(dir: "asc" | "desc") {
		const t = this.resolveTarget();
		if (!t) return;
		const plan = await this.runPlan(t, (lines) => planSort(lines, t, dir));
		if (!plan) return;
		new Notice(
			plan.rows
				? `Sorted ${plan.rows} row${plan.rows === 1 ? "" : "s"} by that column (${dir === "asc" ? "ascending" : "descending"}).`
				: "Power Tables: nothing to sort in that table."
		);
	}

	async moveRow(delta: -1 | 1) {
		const t = this.resolveTarget();
		if (!t) return;
		await this.runPlan(t, (lines) => planMoveRow(lines, t, delta));
	}

	async moveColumn(delta: -1 | 1) {
		const t = this.resolveTarget();
		if (!t) return;
		await this.runPlan(t, (lines) => planMoveColumn(lines, t, delta));
	}

	/**
	 * Excel's AutoSum split button: the five functions people actually reach
	 * for, then a way out to the rest. Each one routes through calcInto, so a
	 * drag selection gets an AutoSum written into its empty cell and a lone
	 * cell gets a live column calc, exactly as those buttons already behaved.
	 */
	/**
	 * Where a toolbar menu should open: pinned under its own button, not at the
	 * pointer, so it lines up the same however you happened to click. The rect
	 * is read synchronously because a menu callback runs after the event has
	 * finished dispatching, by which point currentTarget is null.
	 */
	private menuAnchor(evt: MouseEvent): { x: number; y: number } {
		const el = evt.currentTarget instanceof HTMLElement ? evt.currentTarget : null;
		if (!el) return { x: evt.clientX, y: evt.clientY };
		const r = el.getBoundingClientRect();
		return { x: r.left, y: r.bottom + 4 };
	}

	/** Apply-to as a menu, for the bar where three buttons is two too many.
	 *  The button's own label carries the current scope, so it stays readable
	 *  without opening anything: this setting governs nearly every other button
	 *  on the bar, and a scope you cannot see is a scope that surprises you. */
	showScopeMenu(evt: MouseEvent) {
		const defs: [Scope, string][] = [
			["cell", "Cell"],
			["row", "Row"],
			["column", "Column"],
		];
		const menu = new Menu();
		for (const [scope, label] of defs) {
			menu.addItem((i) =>
				i
					.setTitle(label)
					.setChecked(this.uiScope === scope)
					.onClick(() => {
						this.uiScope = scope;
						this.updatePanels();
					})
			);
		}
		menu.showAtPosition(this.menuAnchor(evt));
	}

	/** The three column alignments, with the one the column already carries
	 *  ticked. Nothing is ticked on a column nobody has aligned: markdown
	 *  renders that left, but it is not the same source as left. */
	showAlignMenu(evt: MouseEvent) {
		const cur = this.currentColumnAlign();
		const defs: [ColAlign, string, string][] = [
			["left", "Align left", "align-left"],
			["center", "Align center", "align-center"],
			["right", "Align right", "align-right"],
		];
		const menu = new Menu();
		for (const [align, label, icon] of defs) {
			menu.addItem((i) =>
				i
					.setTitle(label)
					.setIcon(icon)
					.setChecked(cur === align)
					.onClick(() => void this.alignColumn(align))
			);
		}
		menu.showAtPosition(this.menuAnchor(evt));
	}

	/** The alignment written on the targeted column, for the menu's tick and
	 *  the collapsed button's icon. */
	currentColumnAlign(target?: CellTarget | null): ColAlign | null {
		const t = target ?? this.resolveTarget(true);
		if (!t) return null;
		const ed = t.editor ?? this.editorForPath(t.path);
		if (!ed) return null;
		return columnAlign(ed.getValue().split("\n"), t);
	}

	/** Structure: the things that change the table's shape. */
	showTableMenu(evt: MouseEvent) {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Table").setIsLabel(true));
		const items: [string, string, () => void][] = [
			["Insert row below", "plus", () => void this.insertRow("below")],
			["Insert column right", "plus", () => void this.insertColumn("right")],
			["Totals row", "sigma", () => void this.insertTotalsRow()],
			["Sort A→Z", "arrow-down-a-z", () => void this.sortTable("asc")],
			["Sort Z→A", "arrow-up-a-z", () => void this.sortTable("desc")],
			["Prettify", "align-justify", () => void this.prettifyTable()],
			["Auto-fit columns", "chevrons-right-left", () => void this.autoFitColumnWidths()],
		];
		for (const [label, icon, run] of items) {
			menu.addItem((i) => i.setTitle(label).setIcon(icon).onClick(run));
		}
		menu.showAtPosition(this.menuAnchor(evt));
	}

	/** Getting values in and out, and taking them back off again. */
	showDataMenu(evt: MouseEvent) {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Data").setIsLabel(true));
		const items: [string, string, (e: MouseEvent) => void][] = [
			["Fill down", "arrow-down-to-line", () => void this.fill("down")],
			["Fill right", "arrow-right-to-line", () => void this.fill("right")],
			["Filter column…", "list-filter", () => this.openFilterForTarget()],
			["Clear filters", "filter-x", () => void this.clearFilters()],
			["Copy cells", "copy", () => void this.copyCells()],
			["Cut cells", "scissors", () => void this.copyCells(true)],
			["Paste cells", "clipboard-paste", () => void this.pasteCells()],
			["Paste special…", "clipboard-list", (e: MouseEvent) => this.showPasteMenu(e)],
			["Import…", "upload", () => this.openImportModal()],
			["Paste rows", "clipboard", () => void this.pasteFromClipboard()],
			["Copy as CSV", "copy", () => void this.copyTableCsv()],
			["Color rules…", "wand-2", () => this.openRulesModal()],
		];
		for (const [label, icon, run] of items) {
			menu.addItem((i) => i.setTitle(label).setIcon(icon).onClick((e) => run(e as MouseEvent)));
		}
		menu.addSeparator();
		menu.addItem((i) =>
			i.setTitle("Clear colors (table)").setIcon("eraser").onClick(() => void this.applyColor({ bg: null, fg: null }, "table"))
		);
		menu.addItem((i) =>
			i.setTitle("Clear values").setIcon("eraser").onClick((e) => void this.clearContents(e as MouseEvent))
		);
		menu.showAtPosition(this.menuAnchor(evt));
	}

	/**
	 * Per-table appearance. Checkable items, so the menu reads its own state;
	 * a flag set on this table specifically says so, since that is the bit you
	 * cannot infer from the checkmark alone.
	 */
	async showViewMenu(evt: MouseEvent) {
		const at = this.menuAnchor(evt);
		const t = this.resolveTarget(true);
		const flags = await this.tableFlags(t);
		const s = this.settings;
		const globals: Record<TableFlag, boolean> = {
			guides: s.cellRefs,
			striped: s.stripedRows,
			compact: s.compactTables,
			headerfill: s.fillHeaders,
			sticky: s.stickyHeaders,
			filters: s.filterRow,
		};
		const defs: [TableFlag, string][] = [
			["guides", "Reference guides"],
			["striped", "Striped rows"],
			["compact", "Compact rows"],
			["headerfill", "Header fill"],
			["sticky", "Sticky header"],
			["filters", "AutoFilter"],
		];
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("This table").setIsLabel(true));
		for (const [f, label] of defs) {
			const set = flags[f] !== undefined;
			menu.addItem((i) =>
				i
					.setTitle(set ? `${label} (set on this table)` : label)
					.setChecked(flags[f] ?? globals[f])
					.onClick(() => void this.toggleTableFlag(f))
			);
		}
		menu.showAtPosition(at);
	}

	showAutoSumMenu(evt: MouseEvent, at?: { x: number; y: number }) {
		const anchor = this.menuAnchor(evt);
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("AutoSum").setIsLabel(true));
		const items: [CalcFn, string, string][] = [
			["sum", "Sum", "sigma"],
			["avg", "Average", "divide"],
			["count", "Count numbers", "hash"],
			["max", "Max", "arrow-up"],
			["min", "Min", "arrow-down"],
		];
		for (const [fn, label, icon] of items) {
			menu.addItem((i) => i.setTitle(label).setIcon(icon).onClick(() => void this.calcInto({ fn, dir: "column" })));
		}
		menu.addSeparator();
		menu.addItem((i) =>
			i.setTitle("Across the row…").setIcon("move-horizontal").onClick(() => this.showCalcMenu(evt, anchor))
		);
		menu.addItem((i) =>
			i.setTitle("More functions…").setIcon("function-square").onClick(() => this.openFormulaModal())
		);
		menu.showAtPosition(at ?? this.menuAnchor(evt));
	}

	/**
	 * Excel's number-format dropdown, consolidating what were five buttons.
	 * Every entry previews against the targeted cell's own value, so you pick
	 * by what it will look like rather than by the name of a format. Only what
	 * this plugin can actually render is listed: no Fraction or Scientific
	 * entries that would sit there doing nothing.
	 */
	showNumberFormatMenu(evt: MouseEvent, at?: { x: number; y: number }) {
		const raw = this.currentCellRaw() ?? "";
		const n = parseNumeric(raw);
		const sample = n ? n.value : 45;
		const presets: [string, string, FmtSpec | null][] = [
			["General", "circle-slash", null],
			["Number", "hash", { ...FMT_DEFAULTS, kind: "number" }],
			["Currency", "dollar-sign", { ...FMT_DEFAULTS, kind: "currency" }],
			["Accounting", "landmark", { ...FMT_DEFAULTS, kind: "currency", negative: "paren" }],
			["Short date", "calendar", { ...FMT_DEFAULTS, kind: "date", datePattern: "mdy" }],
			["Long date", "calendar-days", { ...FMT_DEFAULTS, kind: "date", datePattern: "weekday" }],
			["Time", "clock", { ...FMT_DEFAULTS, kind: "time", timePattern: "h12s" }],
			["Percentage", "percent", { ...FMT_DEFAULTS, kind: "percent" }],
		];
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Number format").setIsLabel(true));
		for (const [label, icon, spec] of presets) {
			// dates and times preview off the cell's own text, numbers off its value
			let preview = "";
			if (!spec) preview = raw.trim().slice(0, 24);
			else if (spec.kind === "date" || spec.kind === "time") preview = formatPiece(` ${raw.trim()} `, spec)?.trim() ?? "";
			else preview = formatBySpec(sample, spec);
			menu.addItem((i) =>
				i
					.setTitle(preview ? `${label}    ${preview}` : label)
					.setIcon(icon)
					.onClick(() => {
					if (spec) void this.applyFormat(spec, false);
					else void this.formatNumber("auto", null);
				})
			);
		}
		menu.addSeparator();
		menu.addItem((i) =>
			i.setTitle("More number formats…").setIcon("settings-2").onClick(() => this.openFormatModal())
		);
		menu.showAtPosition(at ?? this.menuAnchor(evt));
	}

	showCalcMenu(evt: MouseEvent, at?: { x: number; y: number }) {
		const menu = new Menu();
		const fns: [CalcFn, string][] = [
			["sum", "Sum"],
			["avg", "Average"],
			["min", "Min"],
			["max", "Max"],
			["count", "Count"],
		];
		for (const [fn, label] of fns) {
			menu.addItem((i) => i.setTitle(`${label} (column)`).onClick(() => void this.calcInto({ fn, dir: "column" })));
		}
		menu.addSeparator();
		for (const [fn, label] of fns) {
			menu.addItem((i) => i.setTitle(`${label} (row)`).onClick(() => void this.calcInto({ fn, dir: "row" })));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Freeze value (remove live calc)").onClick(() => void this.freezeCalc()));
		menu.showAtPosition(at ?? this.menuAnchor(evt));
	}

	showSortMenu(evt: MouseEvent, at?: { x: number; y: number }) {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Sort ascending (small → large, A → Z)").onClick(() => void this.sortTable("asc")));
		menu.addItem((i) => i.setTitle("Sort descending (large → small, Z → A)").onClick(() => void this.sortTable("desc")));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Move row up").onClick(() => void this.moveRow(-1)));
		menu.addItem((i) => i.setTitle("Move row down").onClick(() => void this.moveRow(1)));
		menu.addItem((i) => i.setTitle("Move column left").onClick(() => void this.moveColumn(-1)));
		menu.addItem((i) => i.setTitle("Move column right").onClick(() => void this.moveColumn(1)));
		menu.showAtPosition(at ?? this.menuAnchor(evt));
	}

	private scheduleRecalc(path: string, delay = 600) {
		const prev = this.recalcTimers.get(path);
		if (prev != null) window.clearTimeout(prev);
		this.recalcTimers.set(
			path,
			window.setTimeout(() => {
				this.recalcTimers.delete(path);
				void this.recalcFile(path);
			}, delay)
		);
	}

	/** Sticky formats first (so totals sum the reformatted values), then calcs. */
	private settlePass(lines: string[], skip?: { line: number; col: number }): { line: number; text: string }[] {
		const work = lines.slice();
		const sEdits = applyStickyFormats(work, skip);
		for (const e of sEdits) work[e.line] = e.text;
		const cEdits = recalcCalcs(work);
		for (const e of cEdits) work[e.line] = e.text;
		const rEdits = applyLiveRules(work);
		for (const e of rEdits) work[e.line] = e.text;
		const changed = new Set<number>([...sEdits, ...cEdits, ...rEdits].map((e) => e.line));
		return [...changed].filter((l) => work[l] !== lines[l]).map((l) => ({ line: l, text: work[l] }));
	}

	/**
	 * Recompute every live-sum cell and sticky-formatted row/column in the
	 * file. Writes only when something actually changed, so the modify/editor-
	 * change events our own write fires settle after one no-op pass instead of
	 * looping.
	 */
	private async recalcFile(path: string) {
		const af = this.app.vault.getAbstractFileByPath(path);
		if (!(af instanceof TFile)) return;
		const marked = (s: string) =>
			s.includes('data-sum="') ||
			s.includes('data-calc="') ||
			s.includes('data-f="') ||
			s.includes('data-fmt="') ||
			s.includes('data-rule="') ||
			(s.includes("|") && s.includes("="));
		const editor = this.editorForPath(path);
		if (editor) {
			const lines = editor.getValue().split("\n");
			if (!lines.some(marked)) return;
			// Never reformat the cell the cursor is in, it would fight typing.
			// The cell catches up on the next pass after the cursor moves on.
			let skip: { line: number; col: number } | undefined;
			const cur = editor.getCursor("head");
			const row = parseRow(editor.getLine(cur.line));
			if (row && !row.isDelim) skip = { line: cur.line, col: colFromCh(row, cur.ch) };
			const edits = this.settlePass(lines, skip);
			if (!edits.length) return;
			// the settle pass fires ~600ms after an edit; unpinned, its own
			// transaction re-triggers the Live Preview scroll jump
			this.holdScroll(editor, () =>
				editor.transaction({
					changes: edits.map((e) => ({
						from: { line: e.line, ch: 0 },
						to: { line: e.line, ch: lines[e.line].length },
						text: e.text,
					})),
				})
			);
		} else {
			const content = await this.app.vault.cachedRead(af);
			if (!marked(content)) return;
			await this.app.vault.process(af, (data) => {
				const lines = data.split("\n");
				const edits = this.settlePass(lines);
				if (!edits.length) return data;
				for (const e of edits) lines[e.line] = e.text;
				return lines.join("\n");
			});
		}
	}

	/** Run a mutation without letting the pane scroll. Editing a focused table
	 *  from outside makes Live Preview scroll on its own (removing our cursor
	 *  restore wasn't enough), and any position covered by the table widget
	 *  resolves to the widget's bottom edge, so tall tables dove to the last
	 *  row on every format. Pinning the scroller is cause-agnostic: capture
	 *  the offsets, run the edit, and re-assert them now and over the next
	 *  two frames to swallow the widget's async scrolls too. */
	private holdScroll<T>(editor: Editor, fn: () => T): T {
		const scroller = (editor as unknown as { cm?: EditorView }).cm?.scrollDOM;
		const top = scroller?.scrollTop ?? 0;
		const left = scroller?.scrollLeft ?? 0;
		try {
			return fn();
		} finally {
			if (scroller) {
				const restore = () => {
					scroller.scrollTop = top;
					scroller.scrollLeft = left;
				};
				restore();
				window.requestAnimationFrame(() => {
					restore();
					window.requestAnimationFrame(restore);
				});
			}
		}
	}

	private async runPlan<P extends EditPlan>(
		t: { path: string; editor: Editor | null; fromCursor: boolean },
		make: (lines: string[]) => P | null
	): Promise<P | null> {
		const af = this.app.vault.getAbstractFileByPath(t.path);
		if (!(af instanceof TFile)) {
			new Notice("Power Tables: couldn't find file " + t.path);
			return null;
		}
		if (t.editor) {
			const editor = t.editor;
			const lines = editor.getValue().split("\n");
			const plan = make(lines);
			if (!plan) {
				this.cantLocate();
				return null;
			}
			// a structural edit moves every line after it, so remembered cell
			// coordinates stop meaning what they meant
			if (plan.edits.some((e) => e.kind === "insert" || e.kind === "delete")) this.dropStickySelection();
			if (plan.edits.length) {
				this.holdScroll(editor, () => {
					editor.transaction({
						changes: plan.edits.map((e) => {
							if (e.kind === "insert") {
								if (e.line >= lines.length) {
									const last = lines.length - 1;
									return {
										from: { line: last, ch: lines[last].length },
										to: { line: last, ch: lines[last].length },
										text: "\n" + e.text,
									};
								}
								return { from: { line: e.line, ch: 0 }, to: { line: e.line, ch: 0 }, text: e.text + "\n" };
							}
							if (e.kind === "delete") {
								if (e.line < lines.length - 1) {
									return { from: { line: e.line, ch: 0 }, to: { line: e.line + 1, ch: 0 }, text: "" };
								}
								const prevLen = e.line > 0 ? lines[e.line - 1].length : 0;
								return {
									from: { line: Math.max(0, e.line - 1), ch: prevLen },
									to: { line: e.line, ch: lines[e.line].length },
									text: "",
								};
							}
							return { from: { line: e.line, ch: 0 }, to: { line: e.line, ch: lines[e.line].length }, text: e.text };
						}),
					});
					// Restore the cursor in Source mode only, where rewriting the
					// line would otherwise dump it at the line end. In Live Preview
					// the table widget keeps cell focus itself and a main cursor
					// pushed into the atomic widget only causes trouble.
					const cm = (editor as unknown as { cm?: EditorView }).cm;
					const lp = cm?.state.field(editorLivePreviewField, false) ?? false;
					if (t.fromCursor && !lp) editor.setCursor({ line: plan.cursorLine, ch: plan.cursorCh });
				});
			}
			this.updatePanels();
			return plan;
		}
		// No open editor for the file (pure Reading view): rewrite the file itself.
		let result: P | null = null;
		await this.app.vault.process(af, (data) => {
			const lines = data.split("\n");
			const plan = make(lines);
			if (!plan) return data;
			result = plan;
			const out = lines.slice();
			let off = 0;
			for (const e of [...plan.edits].sort((a, b) => a.line - b.line)) {
				const idx = e.line + off;
				if (e.kind === "insert") {
					out.splice(Math.max(0, Math.min(idx, out.length)), 0, e.text);
					off++;
				} else if (e.kind === "delete") {
					if (idx >= 0 && idx < out.length) {
						out.splice(idx, 1);
						off--;
					}
				} else if (idx >= 0 && idx < out.length) {
					out[idx] = e.text;
				}
			}
			return out.join("\n");
		});
		if (!result) this.cantLocate();
		this.updatePanels();
		return result;
	}

	private cantLocate() {
		new Notice("Power Tables: couldn't locate that cell anymore. The note changed, so click the cell again.");
	}

	/* ---------------- toolbar ---------------- */

	toggleToolbar() {
		if (this.toolbar) this.closeToolbar();
		else this.openToolbar();
	}

	/** Open whichever surface the user chose in settings; the other one closes. */
	async openPanel() {
		if (this.settings.panelMode === "floating") this.openToolbar();
		else await this.activateSidebar();
	}

	openToolbar() {
		// never show both surfaces at once
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_PT);
		if (!this.toolbar) this.toolbar = new ColorToolbar(this);
	}

	closeToolbar() {
		this.toolbar?.destroy();
		this.toolbar = null;
		this.setOutline(null);
		this.clickTarget = null;
	}

	palette(): string[] {
		if (document.body.hasClass("theme-dark")) {
			const d = this.parsePalette(this.settings.paletteDark);
			if (d.length) return d;
		}
		const v = this.parsePalette(this.settings.palette);
		return v.length ? v : this.parsePalette(DEFAULT_SETTINGS.palette);
	}

	private parsePalette(s: string): string[] {
		return s
			.split(",")
			.map((c) => sanitizeColor(c))
			.filter(Boolean)
			.slice(0, 32);
	}

	registerPanel(p: PanelUI) {
		this.panels.add(p);
	}

	unregisterPanel(p: PanelUI) {
		this.panels.delete(p);
	}

	/** True when the docked bar is the home for per-cell formatting. On a phone
	 *  two extra rows cost more than they give, so the panel keeps everything. */
	barEnabled(): boolean {
		return this.settings.tableBar && !Platform.isMobile;
	}

	/**
	 * The layout a freshly built sidebar or floating panel should use.
	 *
	 * Always the complete one. The docked bar is the default surface and the
	 * panel no longer opens itself, so anyone who goes and opens it deliberately
	 * wants the tools, not a stub explaining that they moved.
	 */
	panelLayout(): "full" {
		return "full";
	}

	/** Dock the bar in the active view while the target is inside a table, drop
	 *  it the moment it is not, and never leave one behind in a closed view. */
	private syncTableBar(inTable: boolean) {
		const view = this.barEnabled() ? this.app.workspace.getActiveViewOfType(MarkdownView) : null;
		for (const [v, bar] of [...this.tableBars]) {
			if (v === view && v.containerEl.isConnected) continue;
			bar.destroy();
			this.tableBars.delete(v);
		}
		if (!view) return;
		const have = this.tableBars.get(view);
		if (inTable && !have) this.tableBars.set(view, new TableBar(this, view));
		else if (!inTable && have) {
			have.destroy();
			this.tableBars.delete(view);
		}
	}

	/** A primed painter pays out on the next cell the target moves to. In "once"
	 *  it then disarms, like Excel's single-click painter; in "locked" it stays
	 *  loaded and the next cell gets it too. */
	private paintIfArmed() {
		const patch = this.painter;
		// applyFromUI below runs updatePanels, which lands back here before the
		// edit has even been made, so the target has not moved yet. Without this
		// a locked painter recurses until the stack gives out.
		if (!patch || this.painting) return;
		const t = this.resolveTarget(true);
		if (!t || (t.line === this.painterFrom?.line && t.col === this.painterFrom?.col)) return;
		if (this.painterMode === "once") {
			this.painter = null;
			this.painterMode = "off";
			this.painterFrom = null;
			this.syncPainterChrome();
		} else {
			// stay loaded, but do not pay out again on the cell just painted
			this.painterFrom = { line: t.line, col: t.col };
		}
		this.painting = true;
		try {
			this.applyFromUI(patch, null);
		} finally {
			this.painting = false;
		}
	}

	updatePanels() {
		this.paintIfArmed();
		this.renderFillHandle();
		this.syncTableBar(this.maybeAutoReveal());
		// the bar registers itself as a panel while we are here, so iterate a copy
		for (const p of [...this.panels]) p.refresh();
		this.fmtModal?.refreshScope();
		this.updateStatsChip();
	}

	/** Full panel re-render (not just a refresh), swatch grids re-read the palette. */
	rebuildPanels() {
		for (const p of [...this.panels]) p.rebuild();
	}

	/** Tear the surfaces down and let them come back in the current shape. Used
	 *  when the bar is switched on or off, which moves whole sections between
	 *  the bar and the panel and so cannot be handled by a refresh. */
	refreshSurfaces() {
		for (const [v, bar] of [...this.tableBars]) {
			bar.destroy();
			this.tableBars.delete(v);
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PT)) {
			const view = leaf.view as PowerTablesView;
			view.rebuildUI();
		}
		if (this.toolbar) {
			this.closeToolbar();
			this.openToolbar();
		}
		this.updatePanels();
	}

	/** Excel-style status readout for a drag selection: Sum, Avg, Count, and a one-click insert. */
	/**
	 * The bar that appears while cells are selected. It carries the readout when
	 * the selection is numeric, and the actions that belong to a selection
	 * either way, because selecting a column and reaching for align is the
	 * moment the sidebar is furthest from your hand.
	 */
	private updateStatsChip() {
		const sel = this.widgetSelection();
		if (!sel) {
			this.statsSel = null;
			this.statsEl?.detach();
			return;
		}
		const stats = selectionStats(sel.editor.getValue().split("\n"), sel.targets);
		this.statsSel = sel;
		if (!this.statsEl) {
			this.statsEl = createDiv({ cls: "ptb-stats" });
			this.statsText = this.statsEl.createSpan({ cls: "ptb-stats-text" });
			// Every one of these acts at pointerdown against the snapshotted
			// selection: the press makes the table widget drop its selection and
			// this bar detach, so a click event would never be dispatched (the
			// same lesson the checkboxes taught).
			const press = (el: HTMLElement, run: (s: NonNullable<typeof this.statsSel>) => void) => {
				el.addEventListener("pointerdown", (e) => {
					e.preventDefault();
					e.stopPropagation();
					const s = this.statsSel;
					if (s) run(s);
				});
				el.addEventListener("click", (e) => e.preventDefault());
			};
			const acts = this.statsEl.createDiv({ cls: "ptb-stats-acts" });
			for (const [align, icon, tip] of [
				["left", "align-left", "Align column left"],
				["center", "align-center", "Align column center"],
				["right", "align-right", "Align column right"],
			] as [ColAlign, string, string][]) {
				const b = acts.createEl("button", { cls: "ptb-stats-icon", attr: { "aria-label": tip, title: tip } });
				setIcon(b, icon);
				press(b, (s) => void this.alignColumn(align, s));
			}
			this.statsSum = this.statsEl.createEl("button", { cls: "ptb-stats-btn", text: "Σ Insert" });
			press(this.statsSum, (s) => void this.insertSelectionCalc(s, "sum"));
			this.register(() => this.statsEl?.remove());
		}
		this.statsText.setText(stats ? `Sum ${stats.sum}   ·   Avg ${stats.avg}   ·   Count ${stats.count}` : "");
		this.statsText.toggle(!!stats);
		this.statsSum.toggle(!!stats);
		if (!this.statsEl.isConnected) document.body.appendChild(this.statsEl);
	}

	async activateSidebar() {
		// never show both surfaces at once
		this.closeToolbar();
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_PT);
		if (existing.length) {
			void this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_PT, active: false });
		void this.app.workspace.revealLeaf(leaf);
	}

	/** First time the user edits inside a table this session, reveal the chosen panel. */
	/**
	 * Surface the panel when work moves into a table, in whichever form the
	 * setting asks for. Runs from updatePanels, so it catches every way into a
	 * table: typing, arrow keys, clicking a cell, finishing a drag selection.
	 *
	 * The latch re-arms only when the target leaves the table. That keeps a
	 * panel you closed on purpose closed while you carry on in the same table,
	 * without stranding you toolbar-less in the next one.
	 */
	private maybeAutoReveal(): boolean {
		const t0 = this.resolveTarget(true);
		const onRow0 = !!t0 && !!parseRow((t0.editor ?? this.editorForPath(t0.path))?.getLine(t0.line) ?? "");
		const inTable0 = onRow0 || !!this.widgetSelection();
		// with the bar docked over the table there is nothing to reveal: the
		// tools are already there, and popping a sidebar open as well is the
		// clutter this split exists to remove
		if (!this.settings.autoOpenSidebar || this.barEnabled()) {
			if (!inTable0) this.autoRevealed = false;
			return inTable0;
		}
		const inTable = inTable0;
		if (!inTable) {
			this.autoRevealed = false;
			return false;
		}
		if (this.autoRevealed) return true;
		this.autoRevealed = true;
		if (this.panels.size || this.toolbar) return true;
		// honor the mode the user picked
		if (this.settings.panelMode === "floating") this.openToolbar();
		else void this.openPanel();
		return true;
	}

	async loadSettings() {
		// loadData is untyped by the API; name what we expect back rather than
		// letting an any spread over every setting
		const saved = (await this.loadData()) as Partial<PowerTablesSettings> | null;
		this.adoptSettings(Object.assign({}, DEFAULT_SETTINGS, saved ?? {}));
		this.baseline = structuredClone(this.settings);
	}

	/**
	 * Take on new settings CONTENTS without swapping the object.
	 *
	 * Settings tabs and modals capture this object once (`const s =
	 * plugin.settings`, then `s.key = v`), so replacing it strands every one of
	 * those writes on an orphan and the setting silently stops sticking. Every
	 * assignment to this.settings goes through here for that reason.
	 */
	private adoptSettings(next: PowerTablesSettings) {
		if (this.settings) Object.assign(this.settings, next);
		else this.settings = { ...next };
	}

	/**
	 * The one write path, and it merges rather than overwrites.
	 *
	 * data.json is synced, so this file belongs to every device at once. Writing
	 * memory wholesale reverts whatever another device changed since this one last
	 * read the file, and a setting nothing rewrites afterwards never comes back.
	 * Re-read, and carry only what WE changed.
	 */
	async saveSettings() {
		const disk = (await this.loadData()) as Partial<PowerTablesSettings> | null;
		this.adoptSettings(mergeForSave(this.settings, this.baseline, disk));
		await this.saveData(this.settings);
		this.baseline = structuredClone(this.settings);
	}

	/** Obsidian calls this when Sync lands another device's write. Adopting it
	 *  keeps this device from holding a stale snapshot it would later write back. */
	async onExternalSettingsChange() {
		await this.loadSettings();
	}
}

/**
 * The Power Tables control surface, one implementation rendered both in the
 * right-sidebar view (primary, per the design handoff) and inside the
 * floating panel.
 */
/**
 * The strip docked under the editor's own toolbar while the cursor is in a
 * table: formatting on the first row, the formula bar on the second, the way a
 * spreadsheet stacks them. It mounts by inserting before .view-content, which
 * is how Obsidian toolbars dock, so if another plugin already put one there
 * this lands underneath it rather than fighting for the same slot.
 */
class TableBar {
	private el: HTMLElement;
	private ui: PanelUI;

	constructor(plugin: PowerTablesPlugin, view: MarkdownView) {
		this.el = createDiv({ cls: "ptb-tablebar" });
		const content = view.containerEl.querySelector(":scope > .view-content");
		if (content) view.containerEl.insertBefore(this.el, content);
		else view.containerEl.prepend(this.el);
		this.ui = new PanelUI(plugin, this.el, "bar");
	}

	refresh() {
		this.ui.refresh();
	}

	destroy() {
		this.ui.destroy();
		this.el.remove();
	}
}

class PanelUI {
	private mode: "fill" | "text" | "hl";
	private fillBtn!: HTMLButtonElement;
	private textBtn!: HTMLButtonElement;
	private fillChip!: HTMLElement;
	private textChip!: HTMLElement;
	private hlBtn!: HTMLButtonElement;
	private hlChip!: HTMLElement;
	private customInput!: HTMLInputElement;
	private refEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private formulaInput!: HTMLInputElement;
	/** Cell whose content the formula bar is showing; commits go here, not to
	 *  wherever the cursor drifted while the user was typing in the bar. */
	private fxTarget: CellTarget | null = null;
	private fxLoaded = "";
	private acEl!: HTMLElement;
	private acItems: string[] = [];
	private acIndex = 0;
	/** The table the formula bar was loaded from, captured while the editor
	 *  still had the cell, so point mode can refuse clicks in other tables. */
	private fxTableEl: HTMLElement | null = null;

	private pointReady(): boolean {
		return refInsertAllowed(this.formulaInput.value, this.formulaInput.selectionStart ?? this.formulaInput.value.length);
	}

	private markPointMode() {
		this.formulaInput.toggleClass("is-pointing", this.pointReady());
	}

	private onPointDown = (evt: MouseEvent) => {
		if (!(evt.target instanceof Element)) return;
		if (evt.target.closest(".ptb-panel") || evt.target.closest(".ptb-toolbar")) return;
		const cell = evt.target.closest<HTMLTableCellElement>("td, th");
		if (!cell || !this.fxTarget || !this.pointReady()) return;
		const ref = this.plugin.refFromDomCell(cell, this.fxTarget, this.fxTableEl);
		if (!ref) return;
		// keep focus in the bar: no blur means no commit, and the formula stays
		// open for the next reference
		evt.preventDefault();
		evt.stopPropagation();
		const v = this.formulaInput.value;
		const from = this.formulaInput.selectionStart ?? v.length;
		const to = this.formulaInput.selectionEnd ?? from;
		this.formulaInput.value = v.slice(0, from) + ref + v.slice(to);
		const caret = from + ref.length;
		this.formulaInput.setSelectionRange(caret, caret);
		this.formulaInput.focus();
		this.markPointMode();
	};

	private acClose() {
		this.acItems = [];
		this.acRender();
	}

	private acUpdate() {
		const v = this.formulaInput.value;
		this.acItems = completionsAt(v, this.formulaInput.selectionStart ?? v.length);
		this.acIndex = 0;
		this.acRender();
	}

	private acRender() {
		this.acEl.empty();
		this.acEl.toggleClass("is-open", this.acItems.length > 0);
		this.acItems.forEach((name, k) => {
			const item = this.acEl.createDiv({ cls: "ptb-fx-ac-item", text: name });
			item.toggleClass("is-active", k === this.acIndex);
			// mousedown, not click: preventDefault here keeps focus in the input
			// so the blur handler cannot commit out from under the pick
			item.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.acAccept(k);
			});
		});
	}

	private acAccept(k: number) {
		const name = this.acItems[k];
		if (!name) return;
		const v = this.formulaInput.value;
		const next = applyCompletion(v, this.formulaInput.selectionStart ?? v.length, name);
		this.formulaInput.value = next.text;
		this.formulaInput.setSelectionRange(next.caret, next.caret);
		this.acClose();
		this.formulaInput.focus();
		this.markPointMode();
	}
	private scopeBtns: [Scope, HTMLButtonElement][] = [];
	private tflagBtns: [TableFlag, HTMLButtonElement][] = [];
	private moreLabel!: HTMLElement;
	private pickerOpen = false;

	/**
	 * Where this instance is rendering. "bar" is the strip docked over the
	 * table: formatting and the formula row inline, everything else behind the
	 * AutoSum, Format, Table, Data and View menus. "full" is the standalone
	 * panel, which lays the same tools out as sections for the cases with no
	 * bar to carry them: phones, and anyone who turns it off.
	 */
	constructor(
		private plugin: PowerTablesPlugin,
		private root: HTMLElement,
		private layout: "full" | "bar" = "full"
	) {
		this.mode = plugin.settings.lastMode;
		this.build();
		plugin.registerPanel(this);
	}

	destroy() {
		this.plugin.unregisterPanel(this);
		if (this.popClose) document.removeEventListener("click", this.popClose, true);
		this.popClose = null;
		this.root.empty();
	}

	private popClose: ((e: MouseEvent) => void) | null = null;
	private scopeLabel: HTMLElement | null = null;
	private alignBtn: HTMLButtonElement | null = null;
	private alignIcon: HTMLElement | null = null;
	/** Where the bar wants the colors button, reserved mid-row while the icons
	 *  are laid out and filled in later by buildColorsAndNumbers. */
	private colorSlot: HTMLElement | null = null;

	private guard(b: HTMLElement) {
		b.addEventListener("mousedown", (e) => e.preventDefault());
	}

	/** Re-render from scratch, used when a theme flip swaps the active palette. */
	rebuild() {
		this.build();
	}

	private build() {
		const root = this.root;
		root.empty();
		root.removeClass("ptb-panel");
		root.removeClass("ptb-bar");
		root.addClass(this.layout === "bar" ? "ptb-bar" : "ptb-panel");
		const perTable = this.layout !== "bar";
		if (perTable) this.buildHead(root);
		this.buildFormatting(root);
		if (perTable) this.buildPerTable(root);
		this.refresh();
	}

	/** Title, ref chip, settings gear: panel chrome, not toolbar chrome. */
	private buildHead(root: HTMLElement) {
		const head = root.createDiv({ cls: "ptb-panelhead" });
		head.createSpan({ cls: "ptb-paneltitle", text: "Power Tables" });
		// the chip only appears once a cell is targeted; a placeholder dash
		// reads like a minimize button and invites dead clicks
		this.refEl = head.createSpan({ cls: "ptb-refchip" });
		this.refEl.hide();
		const gear = head.createSpan({ cls: "ptb-gear", attr: { "aria-label": "Power Tables settings" } });
		setIcon(gear, "settings");
		gear.addEventListener("click", () => {
			const s = (this.plugin.app as unknown as { setting?: { open: () => void; openTabById: (id: string) => void } })
				.setting;
			s?.open();
			s?.openTabById("powertables");
		});
		this.summaryEl = root.createDiv({ cls: "ptb-summary", text: "Click a table cell to begin" });
	}

	/** Everything that acts on the targeted cell, row, or column. Lives in the
	 *  docked bar when there is one, in the panel when there is not. */
	private buildFormatting(root: HTMLElement) {
		// Excel-style formula bar: shows the targeted cell's value (or its
		// formula); Enter or leaving the bar commits, Esc reverts
		// "=SUM(B2:B4)" becomes a live formula cell.
		const fx = root.createDiv({ cls: "ptb-fx" });
		// the bar has no panel header, so the ref chip rides on the formula row,
		// which is where a spreadsheet puts it anyway
		if (this.layout === "bar") {
			this.refEl = fx.createSpan({ cls: "ptb-refchip" });
			this.refEl.hide();
		}
		fx.createSpan({ cls: "ptb-fx-icon", text: "ƒx" });
		this.formulaInput = fx.createEl("input", {
			cls: "ptb-fx-input",
			attr: { type: "text", placeholder: "Value or =SUM(B2:B4)", spellcheck: "false" },
		});
		this.acEl = fx.createDiv({ cls: "ptb-fx-ac" });
		if (this.layout === "bar") this.summaryEl = fx.createDiv({ cls: "ptb-summary ptb-barsummary" });
		this.formulaInput.addEventListener("keydown", (e) => {
			// the suggestion list owns these keys while it is open
			if (this.acItems.length) {
				if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					e.preventDefault();
					const step = e.key === "ArrowDown" ? 1 : -1;
					this.acIndex = (this.acIndex + step + this.acItems.length) % this.acItems.length;
					this.acRender();
					return;
				}
				if (e.key === "Tab" || e.key === "Enter") {
					e.preventDefault();
					this.acAccept(this.acIndex);
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					this.acClose();
					return;
				}
			}
			if (e.key === "Enter") {
				e.preventDefault();
				this.commitFx();
				this.formulaInput.blur();
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.formulaInput.value = this.fxLoaded;
				this.formulaInput.blur();
			}
		});
		this.formulaInput.addEventListener("input", () => {
			this.acUpdate();
			this.markPointMode();
		});
		this.formulaInput.addEventListener("focus", () => {
			// capture phase, so a click on a table cell is seen before it can
			// move focus and fire the blur that commits
			document.addEventListener("mousedown", this.onPointDown, true);
			this.markPointMode();
		});
		this.formulaInput.addEventListener("blur", () => {
			document.removeEventListener("mousedown", this.onPointDown, true);
			this.acClose();
			this.formulaInput.removeClass("is-pointing");
			this.commitFx();
		});

		if (this.layout !== "bar") root.createDiv({ cls: "ptb-label", text: "Text" });
		const trow = root.createDiv({ cls: "ptb-iconrow" });
		// the bar replaces the editor's own toolbar while you are in a table, so
		// it has to carry the general-purpose tools that still work in a cell
		if (this.layout === "bar") {
			this.iconBtn(trow, "undo-2", "Undo", () => this.plugin.editorUndo(false));
			this.iconBtn(trow, "redo-2", "Redo", () => this.plugin.editorUndo(true));
			trow.createDiv({ cls: "ptb-vsep" });
			// Apply-to reads first because it governs nearly everything after it:
			// bold, alignment, borders, colors, number formats and Clear values
			// all act at whatever this says.
			// no icon: the word is the label, and a crosshair beside it was one
			// more thing competing for width without saying anything the word
			// does not already say
			const scope = this.dropBtn(
				trow,
				null,
				"Cell",
				"What the buttons after this act on: the targeted cell, its whole row, or its whole column",
				(e) => this.plugin.showScopeMenu(e)
			);
			this.scopeLabel = scope.querySelector(".ptb-droplabel");
			trow.createDiv({ cls: "ptb-vsep" });
		}
		this.iconBtn(trow, "bold", "Bold (Shift: row · Ctrl: column)", (e) => void this.plugin.styleText("bold", e));
		this.iconBtn(trow, "italic", "Italic (Shift: row · Ctrl: column)", (e) => void this.plugin.styleText("italic", e));
		this.iconBtn(trow, "strikethrough", "Strikethrough (Shift: row · Ctrl: column)", (e) =>
			void this.plugin.styleText("strike", e)
		);
		trow.createDiv({ cls: "ptb-vsep" });
		// three buttons to set one of three states, only one of which can be on:
		// that is a dropdown, and it costs a third of the width. The icon tracks
		// the column so the collapsed control still reports what it collapsed.
		this.alignBtn = this.dropBtn(trow, "align-left", null, "Column alignment", (e) => this.plugin.showAlignMenu(e));
		this.alignIcon = this.alignBtn.querySelector(".ptb-btnic");
		trow.createDiv({ cls: "ptb-vsep" });
		this.iconBtn(trow, "layout-grid", "Borders (follows Apply to)", (e) => this.plugin.showBordersMenu(e));
		this.iconBtn(
			trow,
			"check-square",
			"Checkbox: adds/removes [ ] on the cell (follows Apply to); tick the box in Reading view",
			(e) => void this.plugin.toggleCheckbox(e)
		);
		if (this.layout === "bar") {
			trow.createDiv({ cls: "ptb-vsep" });
			this.iconBtn(trow, "highlighter", "Highlight with the last highlight color (follows Apply to)", (e) =>
				void this.plugin.applyLastColor("hl", e)
			);
			// the colors open here rather than at the end of the row: highlight
			// is one of the three things in that popover, so the two belong side
			// by side instead of with a paintbrush and a link between them
			this.colorSlot = trow.createDiv({ cls: "ptb-colorwrap" });
			this.iconBtn(
				trow,
				"paintbrush",
				"Format painter: copies colors, highlight, borders and number format. Click a cell to paint it, click the brush again to keep painting, Esc stops. Copying a plain cell strips formatting instead.",
				() => this.plugin.togglePainter()
			).addClass("ptb-paintbtn");
			this.iconBtn(trow, "link", "Wrap the cell's text in a link, or edit the link it already has", () =>
				void this.plugin.linkCell()
			);
		}

		// Visible stand-in for the Shift/Ctrl modifiers: pick a scope once and
		// colors, text styles, number formats, and Clear values all follow it.
		this.scopeBtns = [];
		// the bar already placed it, ahead of the buttons it governs
		if (this.layout === "bar") return this.buildColorsAndNumbers(root);
		root.createDiv({ cls: "ptb-label", text: "Apply to" });
		const scopes = root.createDiv({ cls: "ptb-modes" });
		const scopeDefs: [Scope, string, string][] = [
			["cell", "Cell", "Act on just the targeted cell"],
			["row", "Row", "Colors, text styles, number formats, and Clear values act on the whole row"],
			["column", "Column", "Colors, text styles, number formats, and Clear values act on the whole column"],
		];
		for (const [scope, lbl, tip] of scopeDefs) {
			const b = scopes.createEl("button", { cls: "ptb-mode", text: lbl, attr: { title: tip } });
			this.guard(b);
			b.addEventListener("click", () => {
				this.plugin.uiScope = scope;
				this.plugin.updatePanels();
			});
			this.scopeBtns.push([scope, b]);
		}
		this.buildColorsAndNumbers(root);
	}

	/** Colors and the number tools, shared by both arrangements. */
	private buildColorsAndNumbers(root: HTMLElement) {
		let colorHost = root;
		if (this.layout === "bar") {
			// a three-row swatch grid is not a toolbar control, so the whole
			// section moves behind one button and opens over the table. The bar
			// reserves its slot mid-row, beside highlight; anything else appends.
			const wrap = this.colorSlot ?? root.createDiv({ cls: "ptb-colorwrap" });
			const trigger = wrap.createEl("button", { cls: "ptb-iconbtn", attr: { title: "Colors", "aria-label": "Colors" } });
			setIcon(trigger, "palette");
			this.guard(trigger);
			const pop = wrap.createDiv({ cls: "ptb-colorpop" });
			trigger.addEventListener("click", () => pop.toggleClass("is-open", !pop.hasClass("is-open")));
			this.popClose = (e: MouseEvent) => {
				if (!(e.target instanceof Node) || !wrap.contains(e.target)) pop.removeClass("is-open");
			};
			document.addEventListener("click", this.popClose, true);
			colorHost = pop;
		} else {
			root.createDiv({ cls: "ptb-label", text: "Colors" });
		}
		const modes = colorHost.createDiv({ cls: "ptb-modes" });
		this.fillBtn = this.modeButton(modes, "Fill", "fill");
		this.textBtn = this.modeButton(modes, "Text", "text");
		this.hlBtn = this.modeButton(modes, "Highlight", "hl");
		const grid = colorHost.createDiv({ cls: "ptb-grid" });
		for (const c of this.plugin.palette()) this.swatch(grid, c);
		const items = colorHost.createDiv({ cls: "ptb-items" });
		const none = items.createEl("button", { cls: "ptb-item" });
		none.createSpan({ cls: "ptb-noicon" });
		none.createSpan({ text: "No color" });
		this.guard(none);
		none.addEventListener("click", (e) => this.applyPick(null, e));
		const more = items.createEl("button", { cls: "ptb-item" });
		const moreIcon = more.createSpan({ cls: "ptb-item-icon" });
		setIcon(moreIcon, "palette");
		this.moreLabel = more.createSpan({ text: "More colors…" });
		this.guard(more);
		more.addEventListener("click", () => this.toggleCustomPicker());
		this.customInput = this.makeCustomInput(colorHost);

		// Two split buttons instead of eight: Excel consolidates its functions
		// and its number formats the same way, and it is what keeps this usable
		// when the pane is narrow.
		if (this.layout !== "bar") root.createDiv({ cls: "ptb-label", text: "Numbers" });
		const nrow = root.createDiv({ cls: "ptb-iconrow" });
		this.dropBtn(nrow, "sigma", "AutoSum", "Sum the selection or the column; the arrow has Average, Count, Max and Min", (e) =>
			this.plugin.showAutoSumMenu(e)
		);
		this.dropBtn(nrow, "hash", "Format", "Number, currency, accounting, date, time and percent, previewed on this cell", (e) =>
			this.plugin.showNumberFormatMenu(e)
		);
		if (this.layout === "bar") {
			nrow.createDiv({ cls: "ptb-vsep" });
			this.dropBtn(nrow, "table", "Table", "Rows, columns, totals, sorting and tidying", (e) =>
				this.plugin.showTableMenu(e)
			);
			this.dropBtn(nrow, "database", "Data", "Fill, import, paste, CSV, color rules and clearing", (e) =>
				this.plugin.showDataMenu(e)
			);
			this.dropBtn(nrow, "eye", "View", "How this table looks: guides, stripes, compact, header, sticky, filter", (e) =>
				void this.plugin.showViewMenu(e)
			);
		}

	}

	/** Set once for a table rather than once per cell: the data operations and
	 *  the per-table appearance flags. These stay in the panel. */
	private buildPerTable(root: HTMLElement) {
		root.createDiv({ cls: "ptb-label", text: "Data" });
		const dgrid = root.createDiv({ cls: "ptb-datagrid" });
		// AutoSum lives on the bar when there is one; without a bar the panel is
		// the only home, so it keeps them
		// Sum and Formulas used to live here; the Numbers section's AutoSum
		// dropdown is both of them now, in every layout
		this.dataBtn(dgrid, "Sort A→Z", "Sort rows by the targeted column, ascending", () => void this.plugin.sortTable("asc"));
		this.dataBtn(dgrid, "Sort Z→A", "Sort rows by the targeted column, descending", () =>
			void this.plugin.sortTable("desc")
		);
		this.dataBtn(dgrid, "Fill ↓", "Copy the top of the selection down, adjusting references (Excel's Ctrl+D)", () =>
			void this.plugin.fill("down")
		);
		this.dataBtn(dgrid, "Fill →", "Copy the left of the selection right, adjusting references", () =>
			void this.plugin.fill("right")
		);
		this.dataBtn(dgrid, "Copy", "Copy the selected cells, formulas and formatting included", () =>
			void this.plugin.copyCells()
		);
		this.dataBtn(dgrid, "Cut", "Cut the selected cells; they clear when the paste lands", () =>
			void this.plugin.copyCells(true)
		);
		this.dataBtn(dgrid, "Paste", "Put the copied block down with its top-left on the targeted cell", () =>
			void this.plugin.pasteCells()
		);
		this.dataBtn(dgrid, "Paste…", "Paste special: values, formulas, formats or transposed", (e) =>
			this.plugin.showPasteMenu(e)
		);
		this.dataBtn(dgrid, "+ Row", "Insert row below", () => void this.plugin.insertRow("below"));
		this.dataBtn(dgrid, "+ Column", "Insert column right", () => void this.plugin.insertColumn("right"));
		this.dataBtn(dgrid, "Import…", "Paste CSV or Excel data into this table", () => this.plugin.openImportModal());
		this.dataBtn(dgrid, "Append rows", "Add the clipboard's rows to the bottom of the table (Excel, Sheets, or CSV)", () =>
			void this.plugin.pasteFromClipboard()
		);
		this.dataBtn(dgrid, "Totals row", "Append a Total row with a live sum under every numeric column", () =>
			void this.plugin.insertTotalsRow()
		);
		this.dataBtn(dgrid, "Copy CSV", "Copy the table to the clipboard as CSV", () => void this.plugin.copyTableCsv());
		this.dataBtn(dgrid, "Rules…", "Conditional color rule for the targeted column", () => this.plugin.openRulesModal());
		this.dataBtn(dgrid, "Prettify", "Re-pad the raw markdown so the table's pipes line up", () =>
			void this.plugin.prettifyTable()
		);
		this.dataBtn(dgrid, "Auto-fit", "Size every column to its widest entry: the smallest width that still shows all the data", () =>
			void this.plugin.autoFitColumnWidths()
		);
		this.dataBtn(dgrid, "Clear colors", "Remove all colors from the table", () =>
			void this.plugin.applyColor({ bg: null, fg: null }, "table")
		);
		this.dataBtn(dgrid, "Clear values", "Clear cell contents (Shift: row, Ctrl: column)", (e) =>
			void this.plugin.clearContents(e)
		);

		// Per-table appearance: overrides the global settings for just the
		// targeted table, stored in the note like everything else.
		root.createDiv({ cls: "ptb-label", text: "This table" });
		const trow2 = root.createDiv({ cls: "ptb-tflagrow" });
		this.tflagBtns = [];
		const tflag = (f: TableFlag, lbl: string, tip: string) => {
			const b = trow2.createEl("button", { cls: "ptb-iconbtn ptb-tflag", text: lbl, attr: { title: tip } });
			this.guard(b);
			b.addEventListener("click", () => void this.plugin.toggleTableFlag(f));
			this.tflagBtns.push([f, b]);
		};
		tflag("guides", "Guides", "Column letters and row numbers on this table, which also select what they label (overrides the global setting)");
		tflag("striped", "Striped", "Tint alternating rows on this table (overrides the global setting)");
		tflag("compact", "Compact", "Reduce cell padding on this table (overrides the global setting)");
		tflag("headerfill", "Header", "Fill this table's header row (overrides the global setting)");
		tflag("sticky", "Sticky", "Keep this table's header row pinned while scrolling (overrides the global setting)");
		tflag("filters", "Filter", "Filter buttons on this table's column headers (overrides the global setting)");

		root.createDiv({
			cls: "ptb-hint",
			text: "Apply to sets the scope for colors, text styles, number formats, and Clear values; hold Shift (row) or Ctrl (column) on any click for a one-off. Right-click a cell for row/column operations.",
		});
	}

	/** A labelled button with a chevron: opens a menu rather than acting. */
	/** Icon and label are both optional: on a narrow window every control that
	 *  can say what it is with one of the two should only spend one. */
	private dropBtn(parent: HTMLElement, icon: string | null, label: string | null, tip: string, fn: (e: MouseEvent) => void) {
		const b = parent.createEl("button", { cls: "ptb-iconbtn ptb-dropbtn", attr: { "aria-label": tip, title: tip } });
		if (icon) setIcon(b.createSpan({ cls: "ptb-btnic" }), icon);
		if (label !== null) b.createSpan({ cls: "ptb-droplabel", text: label });
		else b.addClass("ptb-dropicon");
		const caret = b.createSpan({ cls: "ptb-dropcaret" });
		setIcon(caret, "chevron-down");
		this.guard(b);
		b.addEventListener("click", (e) => fn(e));
		return b;
	}

	private iconBtn(parent: HTMLElement, icon: string, tip: string, fn: (e: MouseEvent) => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "ptb-iconbtn", attr: { "aria-label": tip, title: tip } });
		setIcon(b, icon);
		this.guard(b);
		b.addEventListener("click", (e) => fn(e));
		return b;
	}

	private dataBtn(parent: HTMLElement, lbl: string, tip: string, fn: (e: MouseEvent) => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "ptb-databtn", text: lbl, attr: { title: tip } });
		this.guard(b);
		b.addEventListener("click", (e) => fn(e));
		return b;
	}

	private modeButton(parent: HTMLElement, label: string, mode: "fill" | "text" | "hl"): HTMLButtonElement {
		const b = parent.createEl("button", { cls: "ptb-mode" });
		b.createSpan({ text: label });
		const chip = b.createSpan({ cls: "ptb-chip" });
		if (mode === "fill") this.fillChip = chip;
		else if (mode === "text") this.textChip = chip;
		else this.hlChip = chip;
		this.guard(b);
		b.addEventListener("click", () => {
			this.mode = mode;
			this.plugin.settings.lastMode = mode;
			void this.plugin.saveSettings();
			this.plugin.updatePanels();
		});
		return b;
	}

	private applyPick(color: string | null, evt: MouseEvent | null) {
		const patch: Patch =
			this.mode === "fill" ? { bg: color } : this.mode === "text" ? { fg: color } : { bg: color, hl: true };
		this.plugin.applyFromUI(patch, evt);
	}

	private swatch(parent: HTMLElement, c: string) {
		const b = parent.createEl("button", {
			cls: "ptb-swatch",
			attr: { "aria-label": c, title: `${c}  (Shift: row · Ctrl: column)` },
		});
		b.style.backgroundColor = c;
		this.guard(b);
		b.addEventListener("click", (e) => this.applyPick(c, e));
	}

	private makeCustomInput(parent: HTMLElement): HTMLInputElement {
		const inp = parent.createEl("input", { cls: "ptb-hidden-color", type: "color" });
		inp.addEventListener("change", () => {
			this.setPickerOpen(false);
			this.applyPick(inp.value, null);
		});
		return inp;
	}

	/** Native color inputs have no close API, swapping in a fresh input is the
	 *  one reliable way to dismiss the popup, which lets "More colors…" toggle. */
	private toggleCustomPicker() {
		if (this.pickerOpen) {
			const fresh = this.makeCustomInput(this.root);
			this.customInput.replaceWith(fresh);
			this.customInput = fresh;
			this.setPickerOpen(false);
			return;
		}
		const last =
			this.mode === "fill"
				? this.plugin.settings.lastFill
				: this.mode === "text"
					? this.plugin.settings.lastText
					: this.plugin.settings.lastHl;
		this.customInput.value = /^#[0-9a-fA-F]{6}$/.test(last) ? last : "#ffff00";
		this.customInput.click();
		this.setPickerOpen(true);
	}

	private setPickerOpen(open: boolean) {
		this.pickerOpen = open;
		this.moreLabel.setText(open ? "Close color picker" : "More colors…");
	}

	refresh() {
		// the bar has no per-table sections, so that group is optional here
		const perTable = this.layout !== "bar";
		this.mode = this.plugin.settings.lastMode;
		{
			this.fillBtn.toggleClass("is-active", this.mode === "fill");
			this.textBtn.toggleClass("is-active", this.mode === "text");
			this.hlBtn.toggleClass("is-active", this.mode === "hl");
			for (const [scope, b] of this.scopeBtns) b.toggleClass("is-active", this.plugin.uiScope === scope);
			// the bar shows the scope on the button itself instead
			if (this.scopeLabel) {
				const s = this.plugin.uiScope;
				this.scopeLabel.setText(s === "cell" ? "Cell" : s === "row" ? "Row" : "Column");
			}
			this.fillChip.style.backgroundColor = this.plugin.settings.lastFill;
			this.textChip.style.backgroundColor = this.plugin.settings.lastText;
			this.hlChip.style.backgroundColor = this.plugin.settings.lastHl;
			// While the formula bar is being edited, the header and bar stay
			// frozen on the cell whose content was loaded; the commit goes there.
			if (document.activeElement === this.formulaInput) return;
		}
		// a live selection is what the buttons will act on, so it is what the
		// chip and the formula bar have to be describing
		const selected = this.plugin.selectionDisplay();
		this.fxTarget = selected?.target ?? this.plugin.resolveTarget(true);
		this.fxTableEl = this.plugin.targetTableEl();
		if (this.alignIcon) {
			// an unaligned column shows the left icon, because that is what it
			// renders as; the menu is where the difference is still visible
			setIcon(this.alignIcon, `align-${this.plugin.currentColumnAlign(this.fxTarget) ?? "left"}`);
		}
		const ref = selected ?? this.plugin.currentRef(this.fxTarget);
		if (ref) {
			this.refEl.setText(ref.ref);
			this.refEl.show();
		} else {
			this.refEl.hide();
		}
		this.summaryEl.setText(ref ? ref.summary : "Click a table cell to begin");
		this.fxLoaded = this.plugin.currentCellRaw(this.fxTarget) ?? "";
		this.formulaInput.value = this.fxLoaded;
		if (!perTable) return;
		const s = this.plugin.settings;
		const globals: Record<TableFlag, boolean> = {
			guides: s.cellRefs,
			striped: s.stripedRows,
			compact: s.compactTables,
			headerfill: s.fillHeaders,
			sticky: s.stickyHeaders,
			filters: s.filterRow,
		};
		const tgt = this.fxTarget;
		void this.plugin.tableFlags(tgt).then((flags) => {
			if (this.fxTarget !== tgt) return; // target moved on; a newer refresh will paint
			for (const [f, b] of this.tflagBtns) {
				b.toggleClass("is-active", flags[f] ?? globals[f]);
				b.toggleClass("ptb-override", flags[f] !== undefined);
			}
		});
	}

	/** Write the bar's text back to the cell it was loaded from. Enter and
	 *  clicking away both commit; an unchanged value writes nothing. */
	private commitFx() {
		const v = this.formulaInput.value;
		if (!this.fxTarget || v === this.fxLoaded) return;
		this.fxLoaded = v;
		void this.plugin.commitCellValue(v, this.fxTarget);
	}
}

/** Floating variant of the panel (secondary surface; the sidebar is primary). */
class ColorToolbar {
	private el: HTMLElement;
	private ui: PanelUI;

	constructor(private plugin: PowerTablesPlugin) {
		const el = (this.el = document.body.createDiv({ cls: "ptb-toolbar" }));
		const head = el.createDiv({ cls: "ptb-head" });
		const grip = head.createSpan({ cls: "ptb-grip" });
		setIcon(grip, "grip-vertical");
		head.createSpan({
			cls: "ptb-title",
			text: "Power Tables",
			attr: { title: "Editing view: targets the cell at the cursor. Reading view: click a cell first." },
		});
		const close = head.createSpan({ cls: "ptb-close", attr: { "aria-label": "Close" } });
		setIcon(close, "x");
		close.addEventListener("click", () => this.plugin.closeToolbar());
		this.makeDraggable(head);

		const body = el.createDiv({ cls: "ptb-body" });
		this.ui = new PanelUI(plugin, body, plugin.panelLayout());

		const x = this.plugin.settings.toolbarX ?? window.innerWidth - 266;
		const y = this.plugin.settings.toolbarY ?? 96;
		el.style.left = Math.max(8, Math.min(x, window.innerWidth - 80)) + "px";
		el.style.top = Math.max(8, Math.min(y, window.innerHeight - 80)) + "px";
	}

	refresh() {
		this.ui.refresh();
	}

	destroy() {
		this.ui.destroy();
		this.el.remove();
	}

	private makeDraggable(handle: HTMLElement) {
		handle.addEventListener("pointerdown", (e) => {
			if ((e.target as Element).closest(".ptb-close")) return;
			e.preventDefault();
			const dx = e.clientX - this.el.offsetLeft;
			const dy = e.clientY - this.el.offsetTop;
			const move = (ev: PointerEvent) => {
				this.el.style.left = Math.max(0, Math.min(ev.clientX - dx, window.innerWidth - 60)) + "px";
				this.el.style.top = Math.max(0, Math.min(ev.clientY - dy, window.innerHeight - 40)) + "px";
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				this.plugin.settings.toolbarX = this.el.offsetLeft;
				this.plugin.settings.toolbarY = this.el.offsetTop;
				void this.plugin.saveSettings();
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		});
	}
}

/** The right-sidebar leaf hosting the panel, the design's primary surface. */
class PowerTablesView extends ItemView {
	private ui: PanelUI | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: PowerTablesPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_PT;
	}

	getDisplayText(): string {
		return "Power Tables";
	}

	getIcon(): string {
		return "table";
	}

	async onOpen() {
		this.rebuildUI();
	}

	/** Rebuild from scratch, for when the bar takes sections away or gives them
	 *  back: which half this panel owns is decided when it is built. */
	rebuildUI() {
		this.ui?.destroy();
		this.contentEl.empty();
		this.ui = new PanelUI(this.plugin, this.contentEl.createDiv({ cls: "ptb-sidebar" }), this.plugin.panelLayout());
	}

	async onClose() {
		this.ui?.destroy();
		this.ui = null;
	}
}

/** Turn a dialog into a floating tool window: see-through, click-through
 *  backdrop and drag-by-title, so it can be moved off the table it edits. */
function floatModal(m: Modal) {
	const bg = m.containerEl.querySelector<HTMLElement>(".modal-bg");
	bg?.addClass("ptb-fmt-backdrop");
	m.containerEl.addClass("ptb-fmt-host");
	m.modalEl.addClass("ptb-fmt-floating");
	m.titleEl.addClass("ptb-fmt-grab");
	const place = (x: number, y: number) => {
		m.modalEl.addClass("ptb-fmt-placed");
		m.modalEl.style.left = Math.max(8, Math.min(x, window.innerWidth - 120)) + "px";
		m.modalEl.style.top = Math.max(8, Math.min(y, window.innerHeight - 60)) + "px";
	};
	m.titleEl.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		const rect = m.modalEl.getBoundingClientRect();
		place(rect.left, rect.top);
		const dx = e.clientX - rect.left;
		const dy = e.clientY - rect.top;
		const move = (ev: PointerEvent) => place(ev.clientX - dx, ev.clientY - dy);
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	});
}

/** The two halves of a link, on the two lines every other editor writes them
 *  on: what the cell reads as, and where clicking it goes. An address to start
 *  from turns the dialog into the editor for a link the cell already has. */
class LinkCellModal extends Modal {
	constructor(
		app: App,
		private text: string,
		private url: string,
		private onDone: (text: string, url: string) => void | Promise<void>,
		private onRemove: (() => void | Promise<void>) | null = null
	) {
		super(app);
	}

	onOpen() {
		const editing = this.url !== "";
		this.modalEl.addClass("ptb-linkmodal");
		this.titleEl.setText(editing ? "Edit link" : "Link this cell");
		const fields = this.contentEl.createDiv({ cls: "ptb-fields" });
		this.field(fields, "Text to display", this.text, "What the cell reads", (v) => (this.text = v));
		const addr = this.field(fields, "Address", this.url, "https://example.com or a note name", (v) => (this.url = v));
		const btns = this.contentEl.createDiv({ cls: "ptb-modal-btns" });
		// unlinking sits off on its own, away from the two buttons a hurried
		// click lands on: it throws the address away and Save is right there
		if (this.onRemove) {
			btns.createEl("button", { cls: "ptb-modal-far", text: "Remove link" }).addEventListener("click", () => {
				this.close();
				void this.onRemove?.();
			});
		}
		btns.createEl("button", { cls: "mod-cta", text: editing ? "Save" : "Link" }).addEventListener("click", () =>
			this.commit()
		);
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		// the address, selected: the text is already whatever the cell said, so
		// the address is the half anyone opening this came to change
		window.setTimeout(() => {
			addr.focus();
			addr.select();
		}, 0);
	}

	private field(host: HTMLElement, label: string, value: string, placeholder: string, onInput: (v: string) => void) {
		host.createEl("label", { text: label });
		const input = host.createEl("input", { attr: { type: "text", placeholder, spellcheck: "false" } });
		input.value = value;
		input.addEventListener("input", () => onInput(input.value));
		input.addEventListener("keydown", (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			this.commit();
		});
		return input;
	}

	private commit() {
		const url = this.url.trim();
		if (!url) return;
		this.close();
		// an emptied text field means the address speaks for itself, which is
		// also the one case a plain URL stays a plain URL
		void this.onDone(this.text.trim() || url, url);
	}
}

class CsvImportModal extends Modal {
	private text = "";
	private target: CellTarget | null = null;

	constructor(app: App, private plugin: PowerTablesPlugin) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Import CSV / Excel data");
		floatModal(this);
		this.target = this.plugin.resolveTarget(true);
		const { contentEl } = this;
		contentEl.createEl("p", {
			cls: "ptb-modal-desc",
			text: "Paste rows copied from Excel/Sheets (tab-separated) or CSV text. The delimiter is detected automatically; with Replace, the first line becomes the header.",
		});
		const ta = contentEl.createEl("textarea", {
			cls: "ptb-csv-input",
			attr: { rows: "10", placeholder: "Date,Amount\n1/1/2026,500\n1/2/2026,1800" },
		});
		ta.addEventListener("input", () => (this.text = ta.value));
		const btns = contentEl.createDiv({ cls: "ptb-modal-btns" });
		const cancel = btns.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		const append = btns.createEl("button", { text: "Append rows" });
		append.addEventListener("click", () => {
			this.close();
			void this.plugin.importCsv(this.text, "append", this.target);
		});
		const replace = btns.createEl("button", { text: "Replace table", cls: "mod-cta" });
		replace.addEventListener("click", () => {
			this.close();
			void this.plugin.importCsv(this.text, "replace", this.target);
		});
		ta.focus();
	}

	onClose() {
		this.contentEl.empty();
	}
}

class FormulaModal extends Modal {
	private target: CellTarget | null = null;

	constructor(app: App, private plugin: PowerTablesPlugin) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Edit cell value / formula");
		floatModal(this);
		this.target = this.plugin.resolveTarget(true);
		this.contentEl.createEl("p", {
			cls: "ptb-modal-desc",
			text: "Formulas start with = and use Excel refs, counting the header as row 1: =SUM(B2:B4), =C2*1.08, =AVG(B2,B4). Anchor a reference with $ (=$B$2) to hold it still when the formula is filled. The computed value is stored in the note and recalculates automatically.",
		});
		const input = this.contentEl.createEl("input", {
			cls: "ptb-fx-modal-input",
			attr: { type: "text", spellcheck: "false" },
		});
		input.value = this.plugin.currentCellRaw(this.target) ?? "";
		const commit = () => {
			const v = input.value;
			this.close();
			void this.plugin.commitCellValue(v, this.target);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			}
		});
		const btns = this.contentEl.createDiv({ cls: "ptb-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		btns.createEl("button", { text: "Apply", cls: "mod-cta" }).addEventListener("click", commit);
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 10);
	}

	onClose() {
		this.contentEl.empty();
	}
}

const RULE_OP_LABEL: Record<RuleOp, string> = {
	gt: "greater than",
	lt: "less than",
	eq: "equals",
	contains: "contains",
	between: "between",
	empty: "is empty",
	notempty: "is not empty",
	regex: "matches",
	scale: "color scale (min→max)",
};

class RulesModal extends Modal {
	private op: RuleOp = "gt";
	private value = "";
	private bg: string | null = null;
	private fg: string | null = null;
	private rules: Rule[] = [];
	private editing: number | null = null;
	private target: CellTarget | null = null;

	constructor(app: App, private plugin: PowerTablesPlugin) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Conditional color rules");
		floatModal(this);
		this.target = this.plugin.resolveTarget(true);
		void this.build();
	}

	/** Re-read the column's stored rules from the note, then render. */
	private async build() {
		this.rules = await this.plugin.currentColumnRules(this.target);
		if (this.editing != null && this.editing >= this.rules.length) this.editing = null;
		this.render();
	}

	private render() {
		const c = this.contentEl;
		c.empty();
		const ref = this.plugin.currentRef(this.target);
		const colName = ref ? (ref.ref.match(/^[A-Z]+/)?.[0] ?? "?") : "?";
		c.createEl("p", {
			cls: "ptb-modal-desc",
			text: this.rules.length
				? `Rules for column ${colName}, checked top to bottom; the first match colors the cell. Colors you set by hand on individual cells always win.`
				: `Colors every matching cell in column ${colName} of the targeted table. Add the rule to keep it live (it re-applies as values change, and each column can hold several), or apply it once.`,
		});
		if (this.rules.length) {
			const list = c.createDiv({ cls: "ptb-rulelist" });
			this.rules.forEach((r, i) => {
				const row = list.createDiv({ cls: "ptb-rulerow" });
				if (this.editing === i) row.addClass("is-editing");
				const chips = row.createSpan({ cls: "ptb-rulechips" });
				const chipCols = r.op === "scale" ? (scaleColors(r.value) ?? [null, null]) : [r.bg, r.fg];
				for (const col of chipCols) {
					const chip = chips.createSpan({ cls: "ptb-rulechip" });
					if (col) chip.style.backgroundColor = col;
					else chip.addClass("ptb-chip-none");
				}
				const cond =
					r.op === "scale" || r.op === "empty" || r.op === "notempty"
						? RULE_OP_LABEL[r.op]
						: `${RULE_OP_LABEL[r.op]} ${r.value}`;
				row.createSpan({ cls: "ptb-rulecond", text: cond });
				const edit = row.createEl("button", {
					cls: "ptb-iconbtn ptb-rulebtn",
					attr: { title: "Edit this rule", "aria-label": "Edit this rule" },
				});
				setIcon(edit, "pencil");
				edit.addEventListener("click", () => {
					this.editing = i;
					this.op = r.op;
					this.value = r.value;
					this.bg = r.bg;
					this.fg = r.fg;
					if (r.op === "scale") {
						// scale stores its two colors in the value; surface them on the pickers
						const sc = scaleColors(r.value);
						this.bg = sc?.[0] ?? null;
						this.fg = sc?.[1] ?? null;
					}
					this.render();
				});
				const del = row.createEl("button", {
					cls: "ptb-iconbtn ptb-rulebtn",
					attr: { title: "Remove this rule (colors it painted stay)", "aria-label": "Remove this rule" },
				});
				setIcon(del, "trash-2");
				del.addEventListener("click", () => {
					const next = this.rules.filter((_, k) => k !== i);
					this.editing = null;
					void this.plugin.setColumnRules(next, this.target).then(() => this.build());
				});
			});
		}
		c.createDiv({ cls: "ptb-label", text: this.editing != null ? `Edit rule ${this.editing + 1}` : "New rule" });
		const scale = this.op === "scale";
		const needsValue = !scale && this.op !== "empty" && this.op !== "notempty";
		new Setting(c)
			.setName("Condition")
			.addDropdown((d) =>
				d
					.addOptions({
						gt: "greater than",
						lt: "less than",
						eq: "equals",
						contains: "contains",
						between: "between",
						empty: "is empty",
						notempty: "is not empty",
						regex: "matches pattern",
						scale: "color scale (min→max)",
					})
					.setValue(this.op)
					.onChange((v) => {
						this.op = v as RuleOp;
						this.render();
					})
			)
			.addText((t) => {
				t.setPlaceholder(
					this.op === "between"
						? "min ~ max, e.g. 10 ~ 20"
						: this.op === "regex"
							? "pattern, e.g. ^F-?150"
							: "value, e.g. 0"
				)
					.setValue(needsValue ? this.value : "")
					.setDisabled(!needsValue)
					.onChange((v) => (this.value = v));
			});
		c.createDiv({ cls: "ptb-label", text: scale ? "Low fill (column minimum)" : "Cell fill" });
		this.swatchRow(
			c.createDiv({ cls: "ptb-rule-swatches" }),
			scale ? ["#FFFFFF", ...this.plugin.palette().slice(8, 16)] : ["#FFFFFF", ...this.plugin.palette().slice(8, 16), null],
			(v) => (this.bg = v),
			() => this.bg,
			"No fill: this rule leaves cell fills alone"
		);
		c.createDiv({ cls: "ptb-label", text: scale ? "High fill (column maximum)" : "Text color" });
		this.swatchRow(
			c.createDiv({ cls: "ptb-rule-swatches" }),
			scale ? ["#FFFFFF", ...this.plugin.palette().slice(8, 16)] : ["#FFFFFF", ...this.plugin.palette().slice(16, 24), null],
			(v) => (this.fg = v),
			() => this.fg,
			"No text color: this rule leaves text colors alone"
		);
		const btns = c.createDiv({ cls: "ptb-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		if (this.editing != null) {
			const idx = this.editing;
			btns.createEl("button", { text: "Update rule", cls: "mod-cta" }).addEventListener("click", () => {
				const rule = this.currentRule();
				if (!rule) return;
				const next = this.rules.slice();
				next[idx] = rule;
				this.close();
				void this.plugin.setColumnRules(next, this.target);
			});
		} else {
			btns.createEl("button", { text: "Apply once" }).addEventListener("click", () => {
				const rule = this.currentRule();
				if (!rule) return;
				this.close();
				void this.plugin.applyRule(rule, this.target);
			});
			btns.createEl("button", { text: "Add rule", cls: "mod-cta" }).addEventListener("click", () => {
				const rule = this.currentRule();
				if (!rule) return;
				this.close();
				void this.plugin.setColumnRules([...this.rules, rule], this.target);
			});
		}
	}

	/** The dialog's current rule, validated; null (with a Notice) when incomplete. */
	private currentRule(): Rule | null {
		if (this.op === "empty" || this.op === "notempty") return { op: this.op, value: "", bg: this.bg, fg: this.fg };
		if (this.op === "scale") {
			if (!this.bg || !this.fg) {
				new Notice("Pick a low and a high color for the scale.");
				return null;
			}
			return { op: "scale", value: `${this.bg}~${this.fg}`, bg: null, fg: null };
		}
		if (this.op === "between") {
			const v = this.value.replace(/\s+(?:to|–|—)\s+/i, "~");
			const parts = v.split("~");
			if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
				new Notice("Between needs two values, like 10 ~ 20.");
				return null;
			}
			return { op: "between", value: `${parts[0].trim()}~${parts[1].trim()}`, bg: this.bg, fg: this.fg };
		}
		if (this.op === "regex") {
			// the stored tag strips : ; " and |, drop them up front so what
			// the user tests is what actually runs
			const clean = this.value.replace(/[:"|;]/g, "").trim();
			if (!clean) {
				new Notice("Enter a pattern (note: : ; \" and | can't be used).");
				return null;
			}
			try {
				new RegExp(clean, "i");
			} catch {
				new Notice("That pattern isn't a valid regular expression.");
				return null;
			}
			return { op: "regex", value: clean, bg: this.bg, fg: this.fg };
		}
		return { op: this.op, value: this.value, bg: this.bg, fg: this.fg };
	}

	private swatchRow(
		parent: HTMLElement,
		colors: (string | null)[],
		set: (v: string | null) => void,
		get: () => string | null,
		noneTitle: string
	) {
		const btns: HTMLButtonElement[] = [];
		const sync = () => btns.forEach((b) => b.toggleClass("is-active", (b.dataset.c || null) === get()));
		for (const col of colors) {
			const b = parent.createEl("button", {
				cls: "ptb-swatch ptb-rule-swatch",
				attr: { title: col ?? noneTitle },
			});
			if (col) b.style.backgroundColor = col;
			else b.addClass("ptb-noicon");
			b.dataset.c = col ?? "";
			b.addEventListener("click", (e) => {
				e.preventDefault();
				set(col);
				sync();
			});
			btns.push(b);
		}
		sync();
	}

	onClose() {
		this.contentEl.empty();
	}
}

/**
 * Excel's Format Cells, minus the ceremony: one type switch, the targeted
 * cell's own value as the live sample, and click-to-pick chips instead of
 * abstract format codes. Applies at the panel's current "Apply to" scope.
 */
class FormatCellsModal extends Modal {
	private spec: FmtSpec = {
		kind: "number",
		decimals: 2,
		thousands: true,
		negative: "minus",
		symbol: "$",
		datePattern: "mdy",
		timePattern: "h12",
	};
	private numValue = -1234.1;
	private dateValue: DateParts;
	private timeValue: TimeParts = { h: 13, min: 30, s: 55 };
	private sampleEl!: HTMLElement;
	private optsEl!: HTMLElement;
	private stickyEl!: HTMLElement;
	private applyBtn!: HTMLButtonElement;
	private kindBtns: [FmtSpec["kind"], HTMLButtonElement][] = [];
	private sticky = false;
	/** Cell pinned at open; Apply commits here (the pinned-target invariant). */
	private target: CellTarget | null = null;
	/** Scope the sticky row was last rendered for; guards against rebuilds. */
	private renderedScope: Scope | null = null;

	constructor(app: App, private plugin: PowerTablesPlugin) {
		super(app);
		const now = new Date();
		this.dateValue = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
		this.target = plugin.resolveTarget(true);
		// A row/column that already has a sticky format opens with that spec.
		const tag = plugin.currentStickyTag(this.target);
		const stickySpec = tag ? fmtFromTag(tag) : null;
		if (stickySpec) {
			this.spec = stickySpec;
			this.sticky = true;
		}
		// Seed the samples (and, without a sticky, the starting type) from the targeted cell.
		const raw = plugin.currentCellRaw(this.target);
		if (!raw) return;
		const clean = raw
			.replace(/<[^>]*>/g, "")
			.replace(/[*_~=`]/g, "")
			.trim();
		const d = parseDateCell(clean);
		const t = parseTimeCell(clean);
		const n = parseNumeric(raw);
		if (d) {
			this.dateValue = d;
			if (!stickySpec) this.spec.kind = "date";
		} else if (t) {
			this.timeValue = t;
			if (!stickySpec) this.spec.kind = "time";
		} else if (n) {
			this.numValue = n.value;
			if (!stickySpec && n.currency) {
				this.spec.kind = "currency";
				this.spec.symbol = n.currency;
			}
		}
	}

	onOpen() {
		this.plugin.fmtModal = this;
		this.titleEl.setText("Format cells");
		const c = this.contentEl;
		c.createEl("p", {
			cls: "ptb-modal-desc",
			text: "Rewrites matching cells in the chosen style once; the markdown stays the source of truth, so nothing hidden lingers.",
		});
		const kinds = c.createDiv({ cls: "ptb-modes" });
		const defs: [FmtSpec["kind"], string][] = [
			["number", "Number"],
			["currency", "Currency"],
			["percent", "Percent"],
			["date", "Date"],
			["time", "Time"],
		];
		for (const [kind, lbl] of defs) {
			const b = kinds.createEl("button", { cls: "ptb-mode", text: lbl });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				this.spec.kind = kind;
				this.render();
			});
			this.kindBtns.push([kind, b]);
		}
		this.sampleEl = c.createDiv({ cls: "ptb-fmt-sample" });
		this.optsEl = c.createDiv({ cls: "ptb-fmt-opts" });
		this.stickyEl = c.createDiv({ cls: "ptb-fmt-sticky" });
		const btns = c.createDiv({ cls: "ptb-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		this.applyBtn = btns.createEl("button", { cls: "mod-cta" });
		this.applyBtn.addEventListener("click", () => {
			const spec = { ...this.spec };
			const sticky = this.sticky;
			const target = this.target;
			this.close();
			void this.plugin.applyFormat(spec, sticky, target);
		});
		this.float();
		this.refreshScope();
		this.render();
	}

	/** Keep the Apply button and the sticky checkbox in step with the panel's
	 *  Apply-to scope. Rebuild only on a real scope change: updatePanels runs
	 *  on every document pointerup, and emptying stickyEl mid-click destroyed
	 *  the checkbox under the press, so it could never be ticked. */
	refreshScope() {
		if (!this.applyBtn) return;
		const scope = this.plugin.uiScope;
		if (scope === this.renderedScope) return;
		this.renderedScope = scope;
		this.applyBtn.setText(`Apply to ${scope}`);
		this.stickyEl.empty();
		if (scope === "cell") return;
		const box = this.stickyEl.createEl("input", { attr: { type: "checkbox", id: "ptb-sticky-box" } });
		box.checked = this.sticky;
		box.addEventListener("change", () => (this.sticky = box.checked));
		this.stickyEl.createEl("label", {
			text: `Keep formatting this ${scope}; new and edited cells pick it up automatically`,
			attr: { for: "ptb-sticky-box" },
		});
	}

	/** Turn the modal into a floating tool window: transparent click-through
	 *  backdrop, draggable by its title, position remembered across opens. */
	private float() {
		const bg = this.containerEl.querySelector<HTMLElement>(".modal-bg");
		bg?.addClass("ptb-fmt-backdrop");
		this.containerEl.addClass("ptb-fmt-host");
		this.modalEl.addClass("ptb-fmt-floating");
		const x = this.plugin.settings.fmtModalX;
		const y = this.plugin.settings.fmtModalY;
		if (x != null && y != null) this.place(x, y);
		this.titleEl.addClass("ptb-fmt-grab");
		this.titleEl.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			const rect = this.modalEl.getBoundingClientRect();
			this.place(rect.left, rect.top);
			const dx = e.clientX - rect.left;
			const dy = e.clientY - rect.top;
			const move = (ev: PointerEvent) => this.place(ev.clientX - dx, ev.clientY - dy);
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				const r = this.modalEl.getBoundingClientRect();
				this.plugin.settings.fmtModalX = Math.round(r.left);
				this.plugin.settings.fmtModalY = Math.round(r.top);
				void this.plugin.saveSettings();
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
		});
	}

	private place(x: number, y: number) {
		this.modalEl.addClass("ptb-fmt-placed");
		this.modalEl.style.left = Math.max(8, Math.min(x, window.innerWidth - 120)) + "px";
		this.modalEl.style.top = Math.max(8, Math.min(y, window.innerHeight - 60)) + "px";
	}

	private sampleText(): string {
		const s = this.spec;
		if (s.kind === "date") return formatDateSpec(this.dateValue, s.datePattern);
		if (s.kind === "time") return formatTimeSpec(this.timeValue, s.timePattern);
		return formatBySpec(this.numValue, s);
	}

	private render() {
		const s = this.spec;
		for (const [kind, b] of this.kindBtns) b.toggleClass("is-active", s.kind === kind);
		this.sampleEl.setText(this.sampleText());
		this.sampleEl.toggleClass(
			"is-red",
			this.numValue < 0 &&
				s.kind !== "date" &&
				s.kind !== "time" &&
				(s.negative === "red" || s.negative === "redparen")
		);
		const o = this.optsEl;
		o.empty();
		if (s.kind === "date") {
			this.chipRow(o, "Format", DATE_PATTERNS, s.datePattern, (id) => (s.datePattern = id), (id) =>
				formatDateSpec(this.dateValue, id)
			);
			return;
		}
		if (s.kind === "time") {
			this.chipRow(o, "Format", TIME_PATTERNS, s.timePattern, (id) => (s.timePattern = id), (id) =>
				formatTimeSpec(this.timeValue, id)
			);
			return;
		}
		if (s.kind === "currency") {
			o.createDiv({ cls: "ptb-label", text: "Symbol" });
			const row = o.createDiv({ cls: "ptb-fmt-chips" });
			const presets = ["$", "€", "£", "¥"];
			const chips: HTMLButtonElement[] = [];
			const sync = () => chips.forEach((b) => b.toggleClass("is-active", s.symbol === b.textContent));
			// custom symbol updates in place (no re-render) so typing keeps focus;
			// currency symbols (₹, ₩, ₿…) stay summable, letter codes format only
			const custom = row.createEl("input", {
				cls: "ptb-fmt-custom",
				attr: { type: "text", placeholder: "Other…", maxlength: "4", spellcheck: "false" },
			});
			for (const sym of presets) {
				const b = row.createEl("button", { cls: "ptb-fmt-chip", text: sym });
				b.addEventListener("click", (e) => {
					e.preventDefault();
					s.symbol = sym;
					custom.value = "";
					this.render();
				});
				chips.push(b);
			}
			row.append(custom);
			if (!presets.includes(s.symbol)) custom.value = s.symbol;
			custom.addEventListener("input", () => {
				s.symbol = custom.value.replace(/["|:<>]/g, "").trim() || "$";
				this.sampleEl.setText(this.sampleText());
				sync();
			});
			sync();
		}
		new Setting(o).setName("Decimal places").addDropdown((d) => {
			for (let i = 0; i <= 6; i++) d.addOption(String(i), String(i));
			d.setValue(String(s.decimals)).onChange((v) => {
				s.decimals = +v;
				this.render();
			});
		});
		if (s.kind === "number") {
			new Setting(o).setName("Thousands separator (,)").addToggle((t) =>
				t.setValue(s.thousands).onChange((v) => {
					s.thousands = v;
					this.render();
				})
			);
		}
		if (s.kind !== "percent") {
			o.createDiv({ cls: "ptb-label", text: "Negative numbers" });
			const row = o.createDiv({ cls: "ptb-fmt-chips" });
			const negSample = -Math.abs(this.numValue);
			const styles: [NegStyle, boolean][] = [
				["minus", false],
				["red", true],
				["paren", false],
				["redparen", true],
			];
			for (const [st, red] of styles) {
				this.chip(row, formatBySpec(negSample, { ...s, negative: st }), s.negative === st, red, () => (s.negative = st));
			}
		}
	}

	private chipRow<T extends string>(
		parent: HTMLElement,
		label: string,
		ids: readonly T[],
		current: T,
		set: (id: T) => void,
		render: (id: T) => string
	) {
		parent.createDiv({ cls: "ptb-label", text: label });
		const row = parent.createDiv({ cls: "ptb-fmt-chips" });
		for (const id of ids) this.chip(row, render(id), current === id, false, () => set(id));
	}

	private chip(parent: HTMLElement, label: string, active: boolean, red: boolean, pick: () => void) {
		const b = parent.createEl("button", { cls: "ptb-fmt-chip", text: label });
		b.toggleClass("is-active", active);
		b.toggleClass("is-red", red);
		b.addEventListener("click", (e) => {
			e.preventDefault();
			pick();
			this.render();
		});
	}

	onClose() {
		this.plugin.fmtModal = null;
		this.contentEl.empty();
	}
}

/** One row of the settings tab. `build` is handed a Setting whose name and
 *  description are already set, so it only adds the controls. Rows are data
 *  rather than drawing code so the two renderers cannot disagree about what
 *  the tab holds. */
type Row = { name: string; desc?: string; help?: string; aliases?: string[]; build?: (s: Setting) => void | (() => void) };

/** One section: a native settings page on Obsidian 1.13 and up, a tab in the
 *  fallback renderer for older builds. */
type Page = { id: string; label: string; rows: Row[] };

class PowerTablesSettingTab extends PluginSettingTab {
	plugin: PowerTablesPlugin;
	/** Which settings tab is showing; kept across re-renders. */
	private activeTab = "panel";
	/** Current search filter; when set, matching settings show across all tabs. */
	private query = "";
	/** The one open help popover, if any, and the icon it hangs from. */
	private helpEl: HTMLElement | null = null;
	private helpAnchor: HTMLElement | null = null;
	private helpPinned = false;
	private helpCleanup: (() => void) | null = null;
	/** Saving on every keystroke of a palette would write the file constantly.
	 *  Kept on the tab, not in a render closure, so a redraw mid-edit reuses it. */
	private readonly savePalette = debounce(() => void this.plugin.saveSettings(), 400, true);

	constructor(app: App, plugin: PowerTablesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide() {
		this.closeHelp();
	}

	private closeHelp() {
		this.helpCleanup?.();
		this.helpCleanup = null;
		this.helpEl?.remove();
		this.helpEl = null;
		this.helpAnchor = null;
		this.helpPinned = false;
	}

	/** Show the help popover for `icon`: a soft theme-colored card rather than
	 *  the native black tooltip. Opens instantly on hover; a click pins it so
	 *  it survives the pointer leaving; Esc, a click elsewhere, or scrolling
	 *  closes it. Opening for a new icon replaces the old popover. */
	private openHelp(icon: HTMLElement, text: string, pin: boolean) {
		if (this.helpAnchor === icon && this.helpEl) {
			if (pin) this.helpPinned = true;
			return;
		}
		this.closeHelp();
		const el = document.body.createDiv({ cls: "ptb-help-pop", text });
		this.helpEl = el;
		this.helpAnchor = icon;
		this.helpPinned = pin;
		const r = icon.getBoundingClientRect();
		el.style.left = Math.max(8, Math.min(r.left - 12, window.innerWidth - el.offsetWidth - 8)) + "px";
		const below = r.bottom + 8;
		el.style.top = (below + el.offsetHeight > window.innerHeight - 8 ? r.top - el.offsetHeight - 8 : below) + "px";
		const onDocDown = (e: MouseEvent) => {
			if (e.target instanceof Node && (el.contains(e.target) || icon.contains(e.target))) return;
			this.closeHelp();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.closeHelp();
		};
		const onScroll = () => this.closeHelp();
		document.addEventListener("pointerdown", onDocDown, true);
		document.addEventListener("keydown", onKey, true);
		document.addEventListener("scroll", onScroll, true);
		this.helpCleanup = () => {
			document.removeEventListener("pointerdown", onDocDown, true);
			document.removeEventListener("keydown", onKey, true);
			document.removeEventListener("scroll", onScroll, true);
		};
	}

	/** Redraw when the rows themselves change. Obsidian 1.13 rebuilds the tab
	 *  from getSettingDefinitions(); older builds have only the fallback renderer. */
	private refresh() {
		this.closeHelp(); // whatever the popover is anchored to is about to go
		// update() arrived with the declarative API in 1.13 and minAppVersion is
		// still 1.7.2, so it is reached through a cast rather than named outright:
		// an older build has no definitions to rebuild from and redraws instead.
		const tab = this as unknown as { update?: () => void };
		if (tab.update) tab.update();
		else this.renderFallback();
	}

	/** A small help icon after the setting name carrying the deeper "what does
	 *  this actually do" explanation; hover shows it instantly, a click pins it
	 *  open (the desc stays one line). No aria-label here: Obsidian auto-shows
	 *  its native black tooltip for any labeled element, which doubled up with
	 *  the popover. */
	private addHelp(st: Setting, text: string) {
		const ic = st.nameEl.createSpan({ cls: "ptb-setting-help" });
		setIcon(ic, "help-circle");
		ic.addEventListener("mouseenter", () => this.openHelp(ic, text, false));
		ic.addEventListener("mouseleave", () => {
			if (!this.helpPinned && this.helpAnchor === ic) this.closeHelp();
		});
		ic.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.helpPinned && this.helpAnchor === ic) this.closeHelp();
			else this.openHelp(ic, text, true);
		});
	}

	/** Obsidian 1.13 and up builds the tab from these and never calls display():
	 *  one native page per section, standing in for the tab bar the fallback
	 *  draws for older builds.
	 *
	 *  Every row renders itself rather than declaring a `control`. A declarative
	 *  control writes through Obsidian's generic setControlValue, and these
	 *  settings do more than store a value: they repaint live tables and reopen
	 *  the panel, so they have to stay on the plugin's own save path. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const pages = this.buildPages();
		const rowsOf = new Map(pages.map((p) => [p.label, p.rows] as const));
		return [
			{
				name: "",
				searchable: false, // it is a masthead, not a setting
				render: (s) => {
					s.settingEl.empty();
					this.renderAbout(s.settingEl);
				},
			},
			{
				type: "group",
				search: {
					placeholder: "Search settings...",
					// the entries here are whole sections, so a section stays up when
					// anything inside it matches. Obsidian's own search box, top left,
					// reaches the individual settings.
					match: (def, query) => {
						const q = query.trim().toLowerCase();
						if (!q) return true;
						const has = (v: string | undefined) => (v ?? "").toLowerCase().includes(q);
						return (rowsOf.get(def.name) ?? []).some(
							(r) => has(r.name) || has(r.desc) || (r.aliases ?? []).some(has)
						);
					},
				},
				items: pages.map(
					(p): SettingDefinitionPage => ({
						type: "page",
						name: p.label,
						items: p.rows.map(
							(r): SettingDefinitionRender => ({
								name: r.name,
								desc: r.desc,
								// searching the section name still finds its rows, the way
								// a heading match opened the whole section in the tab bar
								aliases: [...(r.aliases ?? []), p.label],
								render: (s) => {
									// the name and description are Obsidian's to draw and it
									// rebuilds both on a redraw, so a row only hands back
									// what it hung on the row element itself
									const teardown = r.build?.(s);
									if (r.help) this.addHelp(s, r.help);
									return teardown;
								},
							})
						),
					})
				),
			},
		];
	}

	/** What this plugin is and which build is running, above the section list.
	 *  Read off the manifest so it cannot drift from the released version. */
	private renderAbout(el: HTMLElement) {
		el.addClass("ptb-about");
		const head = el.createDiv({ cls: "ptb-about-head" });
		head.createSpan({ cls: "ptb-about-name", text: this.plugin.manifest.name });
		head.createSpan({ cls: "ptb-about-version", text: "v" + this.plugin.manifest.version });
		el.createDiv({ cls: "ptb-about-desc", text: this.plugin.manifest.description });
	}

	/** The pre-1.13 renderer: every section on one page, with a tab bar and a
	 *  search box of our own because there was no declarative API to hand the
	 *  work to. Obsidian 1.13 and up ignores this and renders the definitions
	 *  above instead, so the two only ever differ in how they draw, never in
	 *  what they draw. */
	display(): void {
		this.renderFallback();
	}

	private renderFallback() {
		const root = this.containerEl;
		root.empty();
		this.closeHelp(); // a re-render orphans any popover anchored to the old DOM

		const pages = this.buildPages();
		if (!pages.some((p) => p.id === this.activeTab)) this.activeTab = pages[0].id;

		// the same masthead the declarative tab shows, minus the setting-item
		// wrapper it gets there
		this.renderAbout(root.createDiv({ cls: "ptb-about-standalone" }));

		const searchWrap = root.createDiv({ cls: "ptb-settings-search" });
		const searchInput = searchWrap.createEl("input", { cls: "ptb-settings-search-input" });
		searchInput.type = "search";
		searchInput.placeholder = "Search settings...";
		searchInput.value = this.query;

		const tabBar = root.createDiv({ cls: "ptb-settings-tabs" });
		const body = root.createDiv({ cls: "ptb-settings-body" });

		// one section div per page, tagged with its tab so the tab bar and the
		// search box below can show and hide whole sections at a time
		for (const p of pages) {
			const sec = body.createDiv({ cls: "ptb-settings-section" });
			sec.dataset.tab = p.id;
			sec.dataset.name = p.label.toLowerCase();
			new Setting(sec).setName(p.label).setHeading();
			// name and description first, then the row's own content: the same
			// order Obsidian applies a definition in, so a row that appends to
			// either element lands in the same place under both renderers
			for (const r of p.rows) {
				const st = new Setting(sec).setName(r.name);
				if (r.desc) st.setDesc(r.desc);
				if (r.aliases?.length) st.settingEl.dataset.ptbAlias = r.aliases.join(" ").toLowerCase();
				r.build?.(st);
				if (r.help) this.addHelp(st, r.help);
			}
		}

		const setVisible = (el: HTMLElement, v: boolean) => (el.style.display = v ? "" : "none");
		const applyView = () => {
			const q = this.query.trim().toLowerCase();
			setVisible(tabBar, !q);
			for (const sec of Array.from(body.children) as HTMLElement[]) {
				const items = Array.from(
					sec.querySelectorAll<HTMLElement>(":scope > .setting-item:not(.setting-item-heading)")
				);
				if (!q) {
					for (const it of items) setVisible(it, true);
					setVisible(sec, sec.dataset.tab === this.activeTab);
					continue;
				}
				// a heading-name match reveals the whole section; otherwise match each row
				const nameHit = (sec.dataset.name ?? "").includes(q);
				let anyHit = false;
				for (const it of items) {
					const name = it.querySelector(".setting-item-name")?.textContent?.toLowerCase() ?? "";
					const desc = it.querySelector(".setting-item-description")?.textContent?.toLowerCase() ?? "";
					const hit = nameHit || name.includes(q) || desc.includes(q) || (it.dataset.ptbAlias ?? "").includes(q);
					setVisible(it, hit);
					if (hit) anyHit = true;
				}
				setVisible(sec, anyHit);
			}
		};

		for (const p of pages) {
			const btn = tabBar.createEl("button", { text: p.label, cls: "ptb-settings-tab" });
			btn.toggleClass("is-active", p.id === this.activeTab);
			btn.onclick = () => {
				if (this.activeTab === p.id) return;
				this.activeTab = p.id;
				for (const other of Array.from(tabBar.children) as HTMLElement[]) other.toggleClass("is-active", other === btn);
				applyView();
			};
		}

		searchInput.addEventListener("input", () => {
			this.query = searchInput.value;
			applyView();
		});

		applyView();
	}

	/** Every row of the settings tab, in order, as plain data: the one source
	 *  both renderers draw from, so they cannot drift apart. */
	private buildPages(): Page[] {
		const panel: Row[] = [];
		const appearance: Row[] = [];
		const palette: Row[] = [];

		panel.push({
			name: "Panel style",
			desc: "Where the Power Tables panel lives. Only one surface is ever shown; switching closes the other.",
			help: "The panel is the control surface with the color swatches, number formats, and data tools. Sidebar docks it on the right like Backlinks; Floating makes it a small draggable window you can park beside a table.",
			build: (s) => {
				s.addDropdown((d) =>
					d
						.addOptions({ sidebar: "Sidebar pane", floating: "Floating panel" })
						.setValue(this.plugin.settings.panelMode)
						.onChange(async (v) => {
							this.plugin.settings.panelMode = v as "sidebar" | "floating";
							await this.plugin.saveSettings();
							// switch the live surface immediately (openPanel closes the other one)
							void this.plugin.openPanel();
						})
				);
			},
		});
		panel.push({
			name: "Table toolbar",
			desc: "Dock a formatting row and a formula row over the table while the cursor is in one.",
			help: "Puts the per-cell tools where your hands are: alignment, text styles, colors, number formats and borders on one row, the formula bar on the row below, both docked under the editor's toolbar and only while you are in a table. With this on, the side panel drops those sections and keeps the per-table ones (Data, This table), so every control has one home instead of two. Phones always keep everything in the panel, where two extra rows would cost more than they give.",
			build: (s) => {
				s.addToggle((t) =>
					t.setValue(this.plugin.settings.tableBar).onChange(async (v) => {
						this.plugin.settings.tableBar = v;
						await this.plugin.saveSettings();
						// the panel's layout is decided at build time, so the
						// halves swap only on a full re-render
						this.plugin.refreshSurfaces();
					})
				);
			},
		});
		panel.push({
			name: "Auto-open panel",
			desc: "Reveal the panel whenever you start working inside a table.",
			help: "Putting the cursor in a table, or selecting cells in one, opens the panel you chose above (sidebar or floating) so the table tools are at hand. Closing it leaves it closed while you keep working in that table; moving to another one offers it again. With this off, open it from the ribbon table icon or the Open panel command.",
			build: (s) => {
				s.addToggle((t) =>
					t.setValue(this.plugin.settings.autoOpenSidebar).onChange(async (v) => {
						this.plugin.settings.autoOpenSidebar = v;
						await this.plugin.saveSettings();
					})
				);
			},
		});
		panel.push({
			name: "Open panel on startup",
			help: "Opens the panel as soon as Obsidian starts, without waiting for the first table edit or the ribbon icon.",
			build: (s) => {
				s.addToggle((t) =>
					t.setValue(this.plugin.settings.openOnStart).onChange(async (v) => {
						this.plugin.settings.openOnStart = v;
						await this.plugin.saveSettings();
					})
				);
			},
		});

		appearance.push({
			name: "Cell reference guides",
			desc: "Show Excel-style column letters above and row numbers beside every table, and select by pressing them. The panel's This-table buttons override it per table.",
			help: "Paints column letters (A, B, C) above and row numbers beside each table so cell references in formulas like =SUM(B2:B4) are easy to read and write. The header is row 1 and the first data row is 2, the same as Excel. They also select: press a letter to take its column, a number to take its row, the corner box to take the whole table, and drag along either rail, or Shift-press, to take a span. Nothing is stored in the note.",
			build: (s) => {
				s.addToggle((t) =>
					t.setValue(this.plugin.settings.cellRefs).onChange(async (v) => {
						this.plugin.settings.cellRefs = v;
						await this.plugin.saveSettings();
						this.plugin.applyAppearance();
					})
				);
			},
		});
		appearance.push({
			name: "Striped rows",
			desc: "Subtly tint alternating table rows. The panel's This-table buttons override it per table.",
			help: "Tints every other row so wide tables are easier to scan. Purely visual; the note itself never changes.",
			build: (s) => {
				s.addToggle((t) =>
					t.setValue(this.plugin.settings.stripedRows).onChange(async (v) => {
						this.plugin.settings.stripedRows = v;
						await this.plugin.saveSettings();
						this.plugin.applyAppearance();
					})
				);
			},
		});
		appearance.push({
			name: "Fill handle",
			desc: "Put Excel's small square on the corner of the selection, to drag a series or a copy into the cells around it.",
			help: "Drag the square on the bottom-right corner of the selection to fill the cells you drag over, and a label follows the pointer reading the value that will land there. What lands depends on what was selected, the way it does in a spreadsheet: dates walk a day (or a month, if the selection steps months), two numbers set their own step while a lone one copies, weekdays and month names walk, and text carrying a number increments it. Formulas are not extrapolated, they are copied with their references shifted to where they land, so =C2-B2 dragged down becomes =C3-B3. Anything with no series in it repeats. The whole drag is one edit, so it is one undo.",
			build: (s) => {
				s.addToggle((t) =>
					t.setValue(this.plugin.settings.fillHandle).onChange(async (v) => {
						this.plugin.settings.fillHandle = v;
						await this.plugin.saveSettings();
						this.plugin.applyAppearance();
					})
				);
			},
		});
		appearance.push({
			name: "Compact tables",
			desc: "Reduce table cell padding. The panel's This-table buttons override it per table.",
			help: "Cuts cell padding so dense tables take less space and more rows fit on screen.",
			build: (s) => {
				s.addToggle((t) =>
					t.setValue(this.plugin.settings.compactTables).onChange(async (v) => {
						this.plugin.settings.compactTables = v;
						await this.plugin.saveSettings();
						this.plugin.applyAppearance();
					})
				);
			},
		});
		appearance.push({
			name: "Header fill",
			desc: "Fill every table's header row with a color. The panel's This-table buttons override it per table.",
			help: "Paints every table's header row so headers stand out from the data. The color picker sets the fill; the toggle turns the feature on or off.",
			build: (s) => {
				s.addColorPicker((cp) =>
					cp.setValue(this.plugin.settings.headerFill).onChange(async (v) => {
						this.plugin.settings.headerFill = v;
						await this.plugin.saveSettings();
						this.plugin.applyAppearance();
					})
				);
				s.addToggle((t) =>
					t.setValue(this.plugin.settings.fillHeaders).onChange(async (v) => {
						this.plugin.settings.fillHeaders = v;
						await this.plugin.saveSettings();
						this.plugin.applyAppearance();
					})
				);
			},
		});
		appearance.push({
			name: "Header fill in dark mode",
			desc: "Color used for the header fill while the app is in dark mode. Until you change it, dark mode uses the same color as above.",
			help: "A separate header color used only while Obsidian is in dark mode, so a light fill does not glare there. Until you pick one, dark mode reuses the normal header color.",
			build: (s) => {
				s.addColorPicker((cp) =>
					cp
						.setValue(this.plugin.settings.headerFillDark || this.plugin.settings.headerFill)
						.onChange(async (v) => {
							this.plugin.settings.headerFillDark = v;
							await this.plugin.saveSettings();
							this.plugin.applyAppearance();
						})
				);
			},
		});
		appearance.push({
			name: "Sticky headers",
			desc: "Keep the header row pinned while a long table scrolls. The panel's This-table buttons override it per table.",
			help: "Pins the header row to the top of the pane while a long table scrolls beneath it, like frozen panes in a spreadsheet.",
			build: (s) => {
				s.addToggle((t) =>
					t.setValue(this.plugin.settings.stickyHeaders).onChange(async (v) => {
						this.plugin.settings.stickyHeaders = v;
						await this.plugin.saveSettings();
						this.plugin.applyAppearance();
					})
				);
			},
		});
		appearance.push({
			name: "AutoFilter",
			desc: "A filter button on every column header, in both Reading view and Live Preview. Filtering hides rows on screen; the only thing written to the note is the filter itself, on the header cell. The panel's This-table buttons override it per table.",
			help: "Puts Excel's filter button on each column header. The dropdown sorts the column, ticks the values to keep, or takes a condition (contains, begins with, greater than, between, is empty). Rows failing any column's filter are hidden on screen; no row is ever rewritten. The filter is stored on the header cell, so it survives reopening the note, sorts, and column moves, and it clears from the funnel or from Clear all filters.",
			build: (s) => {
				s.addToggle((t) =>
					t.setValue(this.plugin.settings.filterRow).onChange(async (v) => {
						this.plugin.settings.filterRow = v;
						await this.plugin.saveSettings();
						this.plugin.applyAppearance();
					})
				);
			},
		});
		appearance.push({
			name: "Hide cell markup while editing",
			desc: "In Live Preview, collapse the <span> wrapper and whole-value **bold** / *italic* / ~~strike~~ markers when a cell is edited, keeping the cell rendered with its colors. Source mode always shows the raw markup.",
			help: "Colors and formats live in a small <span> wrapper inside each cell's markdown. With this on, Live Preview keeps that wrapper hidden while you edit, so you see the rendered cell instead of raw HTML. Turn it off to always see exactly what is stored.",
			build: (s) => {
				s.addToggle((t) =>
					t.setValue(this.plugin.settings.hideMarkup).onChange(async (v) => {
						this.plugin.settings.hideMarkup = v;
						await this.plugin.saveSettings();
						this.app.workspace.updateOptions();
					})
				);
			},
		});

		palette.push({
			name: "Palette",
			desc: "The colors offered by the panel's swatch grid. Comma-separated hex values, 8 per row, up to 32. Reopen the panel to see changes.",
			help: "These are the swatches you click in the panel's Colors section; Fill, Text, and Highlight all draw from this one grid. Enter hex colors separated by commas, like #FFEE00, #0B6BCB. Every 8 colors start a new swatch row: the default set is a row of soft fills, a row of stronger fills, and a row of text colors.",
			build: (s) => {
				s.addTextArea((ta) =>
					ta.setValue(this.plugin.settings.palette).onChange((v) => {
						this.plugin.settings.palette = v;
						this.savePalette();
					})
				);
			},
		});
		palette.push({
			name: "Palette (dark mode)",
			desc: "Optional: swatches shown while the app is in dark mode, same format as above. Leave empty to use one palette everywhere.",
			help: "An optional second palette shown while Obsidian is in dark mode, for colors that would look washed out on a dark background. Same comma-separated hex format, 8 per row. Leave it empty to use the main palette everywhere.",
			build: (s) => {
				s.addTextArea((ta) =>
					ta.setValue(this.plugin.settings.paletteDark).onChange((v) => {
						this.plugin.settings.paletteDark = v;
						this.savePalette();
					})
				);
			},
		});

		return [
			{ id: "panel", label: "Panel", rows: panel },
			{ id: "appearance", label: "Appearance", rows: appearance },
			{ id: "palette", label: "Palette", rows: palette },
		];
	}
}
