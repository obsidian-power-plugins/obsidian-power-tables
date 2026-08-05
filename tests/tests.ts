import {
	FmtSpec,
	alignToLogical,
	applyLiveRules,
	lerpHex,
	planTotalsRow,
	ruleHit,
	applyStickyFormats,
	buildCellContent,
	emphasisWrap,
	fmtFromTag,
	fmtToTag,
	formatBySpec,
	formatPiece,
	formatDateSpec,
	formatTimeSpec,
	matchCriteria,
	mergeBorders,
	planDrawBorders,
	splitBorders,
	parseDateCell,
	parseTimeCell,
	planBorders,
	planFormatCells,
	planMulti,
	planStickyFormat,
	colFromCh,
	calcToFormula,
	evalFormula,
	formatFormulaResult,
	locateLine,
	looksLikeFormula,
	normalizeText,
	parseCellContent,
	parseDelimited,
	parseNumeric,
	parseRow,
	planAlign,
	planApplyRule,
	planAutoFitColumnWidths,
	planClearColumnRule,
	planSetColumnRules,
	planSetTableFlag,
	parseRuleTag,
	parseRuleTags,
	parseTableFlagTag,
	tableFlagTag,
	tableFlagsAt,
	columnRulesAt,
	planPrettify,
	selectionStats,
	planSelectionCalc,
	planSetCellValue,
	tableToCsv,
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
	planSetChecked,
	planSetColumnWidth,
	planToggleCheckbox,
	planTextStyle,
	planToggleCalc,
	recalcCalcs,
	shadeVariants,
	tableFromRows,
	tableGrid,
	gridRowOf,
	blockTargets,
	fillSeries,
	planDragFill,
	planCopyCells,
	planPasteCells,
	clipFromRows,
	clipToTsv,
	filterTag,
	parseFilterTag,
	filterHit,
	fltSafe,
	fltValue,
	columnFilterAt,
	planSetColumnFilter,
	planClearFilters,
	dragFillPreview,
	shiftFormulaRefs,
	formulaErrorText,
	FORMULA_FUNCTIONS,
	applyCompletion,
	completionsAt,
	refInsertAllowed,
	planFill,
	mergeForSave,
	parseCellLink,
	buildCellLink,
	columnAlign,
} from "../src/cells";

/** Mirrors the vault applier in main.ts: edit line numbers are in original
 *  document space, so walk ascending and carry the shift as you go. */
function applyPlan(lines: string[], plan: { edits: { line: number; text: string; kind?: string }[] } | null): string[] {
	if (!plan) return lines;
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
	return out;
}

let failures = 0;

function ok(cond: boolean, label: string) {
	if (cond) console.log("  ok - " + label);
	else {
		failures++;
		console.error("FAIL - " + label);
	}
}

function eq(got: unknown, want: unknown, label: string) {
	if (got !== want) console.error(`   got: ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
	ok(got === want, label);
}

const T = [
	"| Bed Size | Width | Price |",
	"| -------- | ----- | ----- |",
	"| Twin | 39 | $32.00 |",
	'| Queen | 60 | <span class="ptb ptb-fill" style="background-color:#00FF00;">$19.60</span> |',
	"| King | 76 | $79.00 |",
];

// --- parseRow ---
const h = parseRow(T[0])!;
eq(h.cellCount, 3, "header has 3 cells");
ok(!h.isDelim, "header is not delimiter");
ok(parseRow(T[1])!.isDelim, "delimiter row detected");
eq(parseRow("| a \\| b | c |")!.cellCount, 2, "escaped pipe stays inside cell");
ok(parseRow("plain text") === null, "non-table line rejected");
const bq = parseRow("> | a | b |")!;
eq(bq.prefix, "> ", "blockquote prefix preserved");
eq(bq.cellCount, 2, "blockquote row cells");

// --- colFromCh ---
const row2 = parseRow(T[2])!;
eq(colFromCh(row2, T[2].indexOf("Twin")), 0, "colFromCh first cell");
eq(colFromCh(row2, T[2].indexOf("39")), 1, "colFromCh middle cell");
eq(colFromCh(row2, T[2].indexOf("$32")), 2, "colFromCh last cell");

// --- parse/build cell content ---
const pc = parseCellContent(' <span class="ptb ptb-fill" style="background-color:#00FF00;">$19.60</span> ');
eq(pc.bg, "#00FF00", "parse bg");
eq(pc.inner, "$19.60", "parse inner");
eq(
	buildCellContent("x", "#FFFF00", "#C00000"),
	'<span class="ptb" style="background:#FF0;color:#C00000">x</span>',
	"build both colors (short format, compressed hex)"
);
eq(buildCellContent("x", null, null), "x", "build with no colors unwraps");
const pnew = parseCellContent('<span class="ptb" data-sum="row" style="background:#F00;color:#FFF">9</span>');
eq(pnew.bg, "#F00", "parse short background property");
eq(pnew.fg, "#FFF", "parse short fg");
eq(pnew.calc?.dir, "row", "parse short-format legacy sum marker");

// --- planEdits: cell scope ---
let plan = planEdits(T.slice(), { line: 2, col: 2, expect: null }, { bg: "#FFFF00" }, "cell")!;
eq(plan.edits.length, 1, "cell scope edits one line");
eq(
	plan.edits[0].text,
	'| Twin | 39 | <span class="ptb" style="background:#FF0">$32.00</span> |',
	"cell wrap exact output"
);

// --- recolor existing span: no nesting, bg kept when adding fg ---
plan = planEdits(T.slice(), { line: 3, col: 2, expect: null }, { fg: "#C00000" }, "cell")!;
const t3 = plan.edits[0].text;
eq((t3.match(/<span/g) || []).length, 1, "no nested spans on recolor");
ok(t3.includes('style="background:#0F0;color:#C00000"'), "bg kept, fg added (legacy input upgraded)");

// --- clear both restores plain cell ---
plan = planEdits(T.slice(), { line: 3, col: 2, expect: null }, { bg: null, fg: null }, "cell")!;
eq(plan.edits[0].text, "| Queen | 60 | $19.60 |", "clear unwraps span completely");

// --- borders and number format travel, but only when the patch names them ---
const TB = ["| A | B |", "| --- | --- |", '| <span class="ptb" data-b="tb" data-fmt="currency">5</span> | x |'];

// the guard that matters: every caller that existed before the format painter
// carried borders and formats sends colour-only patches, and must keep them
plan = planEdits(TB.slice(), { line: 2, col: 0, expect: null }, { bg: "#FFFF00" }, "cell")!;
ok(plan.edits[0].text.includes('data-b="tb"'), "a colour-only patch leaves borders where they were");
ok(plan.edits[0].text.includes('data-fmt="currency"'), "a colour-only patch leaves the number format alone");

plan = planEdits(TB.slice(), { line: 2, col: 0, expect: null }, { borders: "lr", fmt: "percent" }, "cell")!;
ok(plan.edits[0].text.includes('data-b="lr"'), "naming borders in the patch replaces them");
ok(plan.edits[0].text.includes('data-fmt="percent"'), "naming the format in the patch replaces it");

// the painter picking up an unformatted cell: every field is stated as null, so
// painting with it strips the target rather than leaving what was already there
plan = planEdits(TB.slice(), { line: 2, col: 0, expect: null }, { bg: null, fg: null, borders: null, fmt: null }, "cell")!;
eq(plan.edits[0].text, "| 5 | x |", "a patch of all nulls strips the cell back to plain text");

// --- row scope ---
plan = planEdits(T.slice(), { line: 2, col: 0, expect: null }, { bg: "#D9D9D9" }, "row")!;
eq((plan.edits[0].text.match(/<span/g) || []).length, 3, "row scope wraps all cells");

// --- column scope ---
plan = planEdits(T.slice(), { line: 2, col: 1, expect: null }, { bg: "#BDD7EE" }, "column")!;
eq(plan.edits.length, 4, "column scope touches header + 3 body rows");
ok(plan.edits.every((e) => e.line !== 1), "delimiter row untouched");
ok(plan.edits.every((e) => e.text.includes("background:#BDD7EE")), "column colored in every edited row");
const line3 = plan.edits.find((e) => e.line === 3)!.text;
eq((line3.match(/<span/g) || []).length, 2, "existing colored cell in another column untouched");

// --- table scope clears everything ---
plan = planEdits(T.slice(), { line: 3, col: 0, expect: null }, { bg: null, fg: null }, "table")!;
ok(plan.edits.every((e) => !e.text.includes("<span")), "table clear removes all spans");

// --- locateLine healing after rows shift ---
const shifted = ["intro line", ...T];
eq(locateLine(shifted, { line: 3, col: 2, expect: "$19.60" }), 4, "locateLine heals +1 shift via cell text");
eq(locateLine(shifted, { line: 0, col: 2, expect: "$19.60" }), 4, "locateLine full-file scan heal");

// --- normalizeText ---
eq(normalizeText('<span class="ptb" style="color:#f00;">**$19.60**</span>'), "19.60", "normalizeText strips markup");
eq(normalizeText("[[Some Note|alias]] text"), "alias text", "normalizeText resolves wikilink alias");

// --- cursor lands inside the recolored cell ---
plan = planEdits(T.slice(), { line: 2, col: 2, expect: null }, { bg: "#FFFF00" }, "cell")!;
ok(plan.edits[0].text.slice(plan.cursorCh).startsWith("$32.00"), "cursor at start of cell content");

// --- parseNumeric ---
eq(parseNumeric("$32.00")!.value, 32, "parseNumeric currency value");
eq(parseNumeric("$32.00")!.currency, "$", "parseNumeric currency symbol");
eq(parseNumeric("$32.00")!.decimals, 2, "parseNumeric decimals");
eq(parseNumeric("1,644")!.value, 1644, "parseNumeric thousands comma");
eq(parseNumeric("(5.00)")!.value, -5, "parseNumeric parens negative");
eq(parseNumeric("-$5")!.value, -5, "parseNumeric minus before currency");
ok(parseNumeric("abc") === null, "parseNumeric rejects text");
ok(parseNumeric("39 nights") === null, "parseNumeric rejects mixed text");
eq(parseNumeric("60%")!.value, 0.6, "parseNumeric reads percent as a fraction");
eq(parseNumeric('<span class="ptb" style="color:#fff;">1644.00</span>')!.value, 1644, "parseNumeric through span markup");

// --- span format with calc markers (current + both legacy forms) ---
const psum = parseCellContent(' <span class="ptb ptb-sum" data-sum="column">42</span> ');
eq(psum.calc?.fn, "sum", "legacy data-sum parses as sum calc");
eq(psum.calc?.dir, "column", "legacy data-sum direction");
eq(psum.inner, "42", "parse sum inner");
eq(psum.bg, null, "sum-only span has no bg");
const pcalc = parseCellContent('<span class="ptb" data-calc="avg:row">7</span>');
eq(pcalc.calc?.fn, "avg", "parse data-calc fn");
eq(pcalc.calc?.dir, "row", "parse data-calc dir");
eq(
	buildCellContent("42", "#FF0000", null, { fn: "sum", dir: "column" }),
	'<span class="ptb" data-calc="sum:col" style="background:#F00">42</span>',
	"build calc + fill span"
);

// --- planToggleCalc: column sum ---
const T2 = [
	"| Item | Qty | Price |",
	"| ---- | --- | ----- |",
	"| Twin | 39 | $32.00 |",
	'| Queen | 60 | <span class="ptb ptb-fill" style="background-color:#00FF00;">$19.60</span> |',
	"| King | 76 | $79.00 |",
	"| Total | | |",
];
const SUMCOL = { fn: "sum", dir: "column" } as const;
let sp = planToggleCalc(T2.slice(), { line: 5, col: 2, expect: null }, SUMCOL)!;
eq(sp.formatted, "$130.60", "column sum: shared currency + max decimals");
eq(sp.count, 3, "column sum: counts numeric cells incl. colored span");
eq(
	sp.edits[0].text,
	'| Total | | <span class="ptb" data-calc="sum:col">$130.60</span> |',
	"column sum written as live marker span"
);

// --- toggling the same calc freezes it; a different one switches ---
const T2b = T2.slice();
T2b[5] = sp.edits[0].text;
sp = planToggleCalc(T2b.slice(), { line: 5, col: 2, expect: null }, SUMCOL)!;
ok(sp.toggledOff, "same-spec toggle reports off");
eq(sp.edits[0].text, "| Total | | $130.60 |", "freeze unwraps to plain value");
sp = planToggleCalc(T2b.slice(), { line: 5, col: 2, expect: null }, { fn: "avg", dir: "column" })!;
ok(sp.switched, "different fn switches instead of freezing");
ok(sp.edits[0].text.includes('data-calc="avg:col">$43.53</span>'), "switched cell holds the average");

// --- other aggregate functions ---
sp = planToggleCalc(T2.slice(), { line: 5, col: 2, expect: null }, { fn: "avg", dir: "column" })!;
eq(sp.formatted, "$43.53", "average keeps currency, min 2 decimals");
sp = planToggleCalc(T2.slice(), { line: 5, col: 2, expect: null }, { fn: "min", dir: "column" })!;
eq(sp.formatted, "$19.60", "min");
sp = planToggleCalc(T2.slice(), { line: 5, col: 2, expect: null }, { fn: "max", dir: "column" })!;
eq(sp.formatted, "$79.00", "max");
sp = planToggleCalc(T2.slice(), { line: 5, col: 2, expect: null }, { fn: "count", dir: "column" })!;
eq(sp.formatted, "3", "count is a bare integer without currency");

// --- freeze command ---
const TF = T2.slice();
TF[5] = '| Total | | <span class="ptb" data-calc="sum:col">$130.60</span> |';
sp = planFreezeCalc(TF.slice(), { line: 5, col: 2, expect: null })!;
ok(sp.toggledOff, "planFreezeCalc removes a live calc");
eq(sp.edits[0].text, "| Total | | $130.60 |", "frozen value is plain");
sp = planFreezeCalc(T2.slice(), { line: 5, col: 2, expect: null })!;
ok(!sp.toggledOff && sp.edits.length === 0, "planFreezeCalc no-ops on a plain cell");

sp = planToggleCalc(T2.slice(), { line: 5, col: 1, expect: null }, SUMCOL)!;
eq(sp.formatted, "175", "integer column sums without decimals");

// --- sum keeps the target cell's colors ---
const T5 = T2.slice(0, 5);
T5.push('| Total | | <span class="ptb ptb-fill" style="background-color:#FF0000;color:#FFFFFF;"></span> |');
sp = planToggleCalc(T5, { line: 5, col: 2, expect: null }, SUMCOL)!;
ok(
	sp.edits[0].text.includes('<span class="ptb" data-calc="sum:col" style="background:#F00;color:#FFF">$130.60</span>'),
	"sum preserves target cell colors"
);

// --- coloring a live-calc cell keeps its marker (legacy input upgrades) ---
const T5b = T2.slice();
T5b[5] = '| Total | | <span class="ptb" data-sum="column">$130.60</span> |';
plan = planEdits(T5b, { line: 5, col: 2, expect: null }, { bg: "#FFFF00" }, "cell")!;
ok(plan.edits[0].text.includes('data-calc="sum:col"'), "coloring upgrades data-sum to data-calc");

// --- mixed currencies drop the symbol ---
const T4 = ["| A |", "| - |", "| $5 |", "| 5 |", "| |"];
sp = planToggleCalc(T4.slice(), { line: 4, col: 0, expect: null }, SUMCOL)!;
eq(sp.formatted, "10", "mixed currency omits symbol");

// --- row direction ---
const T6 = ["| A | B | Sum |", "| - | - | - |", "| 1 | 2 | |"];
sp = planToggleCalc(T6.slice(), { line: 2, col: 2, expect: null }, { fn: "sum", dir: "row" })!;
eq(sp.formatted, "3", "row sum");

// --- numeric header row is not summed ---
const T7 = ["| 100 | label |", "| --- | ----- |", "| 1 | x |", "| 2 | y |", "| | z |"];
sp = planToggleCalc(T7.slice(), { line: 4, col: 0, expect: null }, SUMCOL)!;
eq(sp.formatted, "3", "header row excluded from column sum");

// --- nothing to sum ---
sp = planToggleCalc(T7.slice(), { line: 4, col: 1, expect: null }, SUMCOL)!;
eq(sp.count, 0, "text column reports zero numbers");

// --- recalcSums: stale values refresh, correct ones untouched, chains settle ---
const R = [
	"| A | B | Sum |",
	"| - | - | --- |",
	'| 1 | 2 | <span class="ptb ptb-sum" data-sum="row">99</span> |',
	'| 3 | 4 | <span class="ptb ptb-sum" data-sum="row">7</span> |',
	'| Total | | <span class="ptb ptb-sum" data-sum="column">0</span> |',
];
const re = recalcCalcs(R.slice());
eq(re.length, 2, "recalc touches only stale lines");
ok(re.some((e) => e.line === 2 && e.text.includes(">3</span>")), "stale row sum refreshed");
ok(re.some((e) => e.line === 4 && e.text.includes(">10</span>")), "grand total chains through row sums");
ok(re.every((e) => e.text.includes('data-calc="sum:')), "legacy data-sum cells upgrade to data-calc on rewrite");

const R2 = R.slice();
for (const e of re) R2[e.line] = e.text;
eq(recalcCalcs(R2).length, 0, "recalc is stable at fixpoint");

// recalc preserves colors on sum cells
const R3 = [
	"| A |",
	"| - |",
	"| 5 |",
	'| <span class="ptb ptb-sum ptb-fill" data-sum="column" style="background-color:#FF0000;">1</span> |',
];
const re3 = recalcCalcs(R3.slice());
ok(re3[0].text.includes('style="background:#F00">5</span>'), "recalc keeps colors on sum cell");

// --- live average recalculates too ---
const R4 = ["| A |", "| - |", "| 2 |", "| 4 |", '| <span class="ptb" data-calc="avg:col">0</span> |'];
const re4 = recalcCalcs(R4.slice());
ok(re4[0].text.includes(">3.00</span>"), "live average recalculates");

// --- planSort ---
const S = [
	"| Item | Qty | When |",
	"| ---- | --- | ---- |",
	"| banana | 3 | 2/1/2026 |",
	"| apple | $1,644.00 | 1/15/2026 |",
	"| cherry | 2 | 12/1/2025 |",
	"| donut | | 3/3/2026 |",
	'| Total | <span class="ptb" data-calc="sum:col">1649</span> | |',
];
function applySort(src: string[], col: number, dir: "asc" | "desc"): string[] {
	const out = src.slice();
	const p = planSort(src.slice(), { line: 2, col, expect: null }, dir)!;
	for (const e of p.edits) out[e.line] = e.text;
	return out;
}
let sorted = applySort(S, 1, "asc");
ok(sorted[2].includes("cherry") && sorted[3].includes("banana") && sorted[4].includes("apple"), "numeric asc: 2, 3, 1644");
ok(sorted[5].includes("donut"), "blank key sorts last (before pinned)");
ok(sorted[6].includes("Total"), "row with live calc stays pinned at bottom");
sorted = applySort(S, 1, "desc");
ok(sorted[2].includes("apple") && sorted[3].includes("banana") && sorted[4].includes("cherry"), "numeric desc: 1644, 3, 2");
ok(sorted[5].includes("donut") && sorted[6].includes("Total"), "blanks and pinned rows stay at the end on desc");
sorted = applySort(S, 2, "asc");
ok(
	sorted[2].includes("cherry") && sorted[3].includes("apple") && sorted[4].includes("banana") && sorted[5].includes("donut"),
	"date sort m/d/y ascending"
);
sorted = applySort(S, 0, "asc");
ok(sorted[2].includes("apple") && sorted[3].includes("banana") && sorted[4].includes("cherry"), "string sort A→Z");
eq(planSort(S.slice(), { line: 2, col: 1, expect: null }, "asc")!.rows, 4, "sort reports sortable row count");

// --- planMoveRow ---
let mv = planMoveRow(S.slice(), { line: 2, col: 0, expect: null }, 1)!;
eq(mv.edits.length, 2, "move row down swaps two lines");
ok(mv.edits[0].line === 2 && mv.edits[0].text.includes("apple"), "row below moves up");
ok(mv.edits[1].line === 3 && mv.edits[1].text.includes("banana"), "target row moves down");
eq(mv.cursorLine, 3, "cursor follows the moved row");
mv = planMoveRow(S.slice(), { line: 2, col: 0, expect: null }, -1)!;
eq(mv.edits.length, 0, "first body row cannot move up into the header");

// --- planMoveColumn ---
const M = ["| A | B |", "| :-- | --: |", "| 1 | 2 |"];
mv = planMoveColumn(M.slice(), { line: 2, col: 0, expect: null }, 1)!;
eq(mv.edits.length, 3, "move column touches every table line");
ok(mv.edits.some((e) => e.line === 0 && e.text === "| B | A |"), "header cells swap");
ok(mv.edits.some((e) => e.line === 1 && e.text === "| --: | :-- |"), "alignment row travels with the column");
ok(mv.edits.some((e) => e.line === 2 && e.text === "| 2 | 1 |"), "body cells swap");
mv = planMoveColumn(M.slice(), { line: 2, col: 1, expect: null }, 1)!;
eq(mv.edits.length, 0, "last column cannot move further right");

// --- planTextStyle ---
const TX = ["| A | B |", "| - | - |", "| hello | 5 |"];
let tp = planTextStyle(TX.slice(), { line: 2, col: 0, expect: null }, "bold", "cell")!;
eq(tp.edits[0].text, "| **hello** | 5 |", "bold wraps cell content");
const TX2 = TX.slice();
TX2[2] = tp.edits[0].text;
tp = planTextStyle(TX2, { line: 2, col: 0, expect: null }, "bold", "cell")!;
eq(tp.edits[0].text, "| hello | 5 |", "bold toggles off");
const TX3 = ["| A |", "| - |", '| <span class="ptb" style="background:#F00">x</span> |'];
tp = planTextStyle(TX3.slice(), { line: 2, col: 0, expect: null }, "italic", "cell")!;
ok(tp.edits[0].text.includes(">*x*</span>"), "styling applies inside the color span");

// --- planAlign ---
let ap = planAlign(TX.slice(), { line: 2, col: 1, expect: null }, "right")!;
eq(ap.edits[0].text, "| - | ---: |", "align right rewrites the delimiter column");
ap = planAlign(TX.slice(), { line: 2, col: 0, expect: null }, "center")!;
eq(ap.edits[0].text, "| :---: | - |", "align center");
eq(alignToLogical("left", false), "start", "left is start in LTR");
eq(alignToLogical("right", false), "end", "right is end in LTR");
eq(alignToLogical("left", true), "end", "left is end in RTL");
eq(alignToLogical("right", true), "start", "right is start in RTL");
eq(alignToLogical("center", true), "center", "center is direction-independent");

// what the condensed alignment menu ticks
{
	const A = ["| A | B | C | D |", "| :--- | :---: | ---: | --- |", "| 1 | 2 | 3 | 4 |"];
	const at = (col: number) => columnAlign(A, { line: 2, col, expect: null });
	eq(at(0), "left", "a leading colon reads as left");
	eq(at(1), "center", "colons both ends read as center");
	eq(at(2), "right", "a trailing colon reads as right");
	eq(at(3), null, "an unmarked column has no alignment to tick");
	eq(columnAlign(["| A |", "| 1 |"], { line: 1, col: 0, expect: null }), null, "a table with no delimiter row has none either");
	// the reader and the writer have to agree, or the menu ticks the box the
	// button it just ran did not fill
	for (const want of ["left", "center", "right"] as const) {
		const after = applyPlan(A.slice(), planAlign(A.slice(), { line: 2, col: 3, expect: null }, want));
		eq(columnAlign(after, { line: 2, col: 3, expect: null }), want, `planAlign ${want} reads back as ${want}`);
	}
}

// --- emphasisWrap ---
let ew = emphasisWrap("**750**");
eq(`${ew.lead}/${ew.trail}`, "2/2", "bold wrap");
ew = emphasisWrap("*x*");
eq(`${ew.lead}/${ew.trail}`, "1/1", "italic wrap");
ew = emphasisWrap("~~**750**~~");
eq(`${ew.lead}/${ew.trail}`, "4/4", "nested strike+bold wrap");
ew = emphasisWrap("***750***");
eq(`${ew.lead}/${ew.trail}`, "3/3", "bold+italic wrap");
ew = emphasisWrap("750");
eq(`${ew.lead}/${ew.trail}`, "0/0", "plain value untouched");
ew = emphasisWrap("a **b** c");
eq(`${ew.lead}/${ew.trail}`, "0/0", "partial emphasis untouched");
ew = emphasisWrap("**750*");
eq(`${ew.lead}/${ew.trail}`, "0/0", "unbalanced markers untouched");

// --- cell links ---
{
	const md = parseCellLink("[Rob Prod](https://example.com/Rob-Prod")!;
	ok(md === null, "an unclosed link is not a link");
}
{
	const md = parseCellLink("[Rob Prod](https://example.com/Rob-Prod)")!;
	eq(md.label, "Rob Prod", "markdown link label");
	eq(md.url, "https://example.com/Rob-Prod", "markdown link target");
	eq(md.kind, "md", "markdown link kind");
}
// A URL pasted straight in is the way most link cells actually get made, and
// reading it as plain text is what left "Edit link" with nothing to edit.
{
	const b = parseCellLink("www.example.com/Rob-Prod")!;
	eq(b.url, "www.example.com/Rob-Prod", "a bare www URL is a link");
	eq(b.label, "www.example.com/Rob-Prod", "a bare URL is its own label");
	eq(b.kind, "bare", "bare link kind");
}
eq(parseCellLink("https://example.com")!.kind, "bare", "a bare https URL is a link");
eq(parseCellLink("mailto:steve@example.com")!.kind, "bare", "so is a mailto");
eq(parseCellLink("obsidian://open?vault=x")!.kind, "bare", "and any other scheme");
ok(parseCellLink("545.60") === null, "a number is not a bare URL");
ok(parseCellLink("www.example.com and more") === null, "a bare URL with text after it is left alone");
{
	const u = "https://new.example.com";
	eq(buildCellLink(u, u, "bare"), u, "a plain URL that is still its own text stays plain");
	eq(buildCellLink("Our site", u, "bare"), `[Our site](${u})`, "giving a plain URL text of its own makes it a real link");
}
{
	// the old regex ended the URL at the first ")" and so decided this was not
	// a link at all, which turned "edit the link" into "wrap it in a second one"
	const md = parseCellLink("[Mercury](https://en.wikipedia.org/wiki/Mercury_(planet))")!;
	eq(md.url, "https://en.wikipedia.org/wiki/Mercury_(planet)", "a URL may close a paren of its own");
}
{
	const w = parseCellLink("[[Weekly Notes]]")!;
	eq(w.url, "Weekly Notes", "bare wikilink target");
	eq(w.label, "Weekly Notes", "bare wikilink labels itself");
	eq(w.kind, "wiki", "wikilink kind");
}
{
	const w = parseCellLink("[[Weekly Notes|This week]]")!;
	eq(w.url, "Weekly Notes", "aliased wikilink target");
	eq(w.label, "This week", "aliased wikilink label");
}
ok(parseCellLink("plain text") === null, "plain text is not a link");
ok(parseCellLink("see [the note](x.md) for more") === null, "a link with text around it is left alone");
ok(parseCellLink("[[]]") === null, "an empty wikilink is not a link");
eq(buildCellLink("Rob Prod", "https://example.com"), "[Rob Prod](https://example.com)", "builds a markdown link");
eq(buildCellLink("This week", "Weekly Notes", "wiki"), "[[Weekly Notes|This week]]", "builds an aliased wikilink");
eq(buildCellLink("Weekly Notes", "Weekly Notes", "wiki"), "[[Weekly Notes]]", "a label equal to the target needs no alias");
{
	// round-tripping is what "edit the link" does: parse, swap the target,
	// build. Neither the label nor the flavor may drift on the way through.
	for (const before of ["[[Weekly Notes|This week]]", "[[Weekly Notes]]", "[Rob Prod](https://x.example.com)", "https://x.example.com"]) {
		const p = parseCellLink(before)!;
		eq(buildCellLink(p.label, p.url, p.kind), before, `${before} survives a parse/build round trip`);
	}
	const p2 = parseCellLink("[Rob Prod](https://old.example.com)")!;
	eq(buildCellLink(p2.label, "https://new.example.com", p2.kind), "[Rob Prod](https://new.example.com)", "editing swaps only the target");
}

// --- planFormatNumber ---
const NF = ["| A |", "| - |", "| 1644 |", "| $2 |", "| text |"];
let fp = planFormatNumber(NF.slice(), { line: 2, col: 0, expect: null }, "currency", "column")!;
ok(fp.edits.some((e) => e.text.includes("$1,644.00")), "currency format adds symbol and separators");
fp = planFormatNumber(NF.slice(), { line: 2, col: 0, expect: null }, "number", "cell")!;
eq(fp.edits[0].text, "| 1,644.00 |", "number format");
fp = planFormatNumber(["| A |", "| - |", "| 0.153 |"], { line: 2, col: 0, expect: null }, "percent", "cell")!;
eq(fp.edits[0].text, "| 15.3% |", "percent format");
fp = planFormatNumber(["| A |", "| - |", "| $1,644.00 |"], { line: 2, col: 0, expect: null }, "auto", "cell")!;
eq(fp.edits[0].text, "| 1644 |", "auto strips formatting");
const DF = ["| When | Note |", "| - | - |", "| 3-14-12 | keep |", "| not a date | 5 |"];
fp = planFormatNumber(DF.slice(), { line: 2, col: 0, expect: null }, "date", "column")!;
eq(fp.edits.length, 1, "date quick format skips cells that don't parse");
eq(fp.edits[0].text, "| 3/14/2012 | keep |", "date quick format normalizes to m/d/yyyy");

// --- Format cells (spec-driven) ---
const SPEC: FmtSpec = {
	kind: "number",
	decimals: 2,
	thousands: true,
	negative: "minus",
	symbol: "$",
	datePattern: "mdy",
	timePattern: "h12",
};
eq(formatBySpec(-1234.1, SPEC), "-1,234.10", "number with thousands and minus");
eq(formatBySpec(-1234.1, { ...SPEC, negative: "paren" }), "(1,234.10)", "accounting parens");
eq(formatBySpec(1234.1, { ...SPEC, thousands: false, decimals: 0 }), "1234", "no grouping, no decimals");
eq(formatBySpec(-1234.1, { ...SPEC, kind: "currency", symbol: "€", negative: "redparen" }), "(€1,234.10)", "currency parens");
eq(formatBySpec(0.153, { ...SPEC, kind: "percent" }), "15.30%", "percent from fraction");
const DP = parseDateCell("3/14/2012")!;
eq(formatDateSpec(DP, "mdy2"), "3/14/12", "date short year");
eq(formatDateSpec(DP, "iso"), "2012-03-14", "date iso");
eq(formatDateSpec(DP, "weekday"), "Wednesday, March 14, 2012", "date long weekday");
const DT = parseDateCell("Mar 14, 2012")!;
eq(formatDateSpec(DT, "mdy"), "3/14/2012", "textual date round-trips");
eq(parseDateCell("14/14/2012"), null, "impossible month rejected");
eq(formatTimeSpec(parseTimeCell("1:30 PM")!, "h24s"), "13:30:00", "12h to 24h with seconds");
eq(formatTimeSpec(parseTimeCell("13:30:55")!, "h12s"), "1:30:55 PM", "24h to 12h keeps seconds");
eq(formatTimeSpec(parseTimeCell("13:30:55")!, "h12"), "1:30 PM", "12h short drops seconds");
eq(parseTimeCell("25:00"), null, "impossible hour rejected");
const FC = ["| A | B |", "| - | - |", "| -5 | 3/14/2012 |", "| 10 | x |"];
let fc = planFormatCells(FC.slice(), { line: 2, col: 0, expect: null }, { ...SPEC, negative: "redparen" }, "column")!;
ok(
	fc.edits.some((e) => e.text.includes("color:#F00") && e.text.includes("(5.00)")),
	"red parens negative writes the color"
);
fc = planFormatCells(FC.slice(), { line: 2, col: 1, expect: null }, { ...SPEC, kind: "date", datePattern: "mon" }, "column")!;
eq(fc.edits.length, 1, "date format skips non-date cells");
ok(fc.edits[0].text.includes("Mar 14, 2012"), "date column reformat");
const RC = ["| A |", "| - |", '| <span class="ptb" style="color:#F00">(5.00)</span> |'];
fc = planFormatCells(RC.slice(), { line: 2, col: 0, expect: null }, SPEC, "cell")!;
eq(fc.edits[0].text, "| -5.00 |", "leaving red style clears the red and unwraps");

// --- borders ---
eq(mergeBorders(null, [{ edge: "bottom", weight: "thin" }]), "b", "single edge");
eq(mergeBorders("b", [{ edge: "top", weight: "thick" }]), "Tb", "merge keeps canonical order");
eq(mergeBorders("B", [{ edge: "bottom", weight: "thin" }]), "b", "explicit thin replaces thick");
eq(mergeBorders(null, [{ edge: "bottom", weight: "double" }]), "=b", "a double edge writes its = marker");
eq(mergeBorders("t", [{ edge: "bottom", weight: "double" }]), "t=b", "double merges alongside a thin edge");
eq(mergeBorders("=b", [{ edge: "bottom", weight: "thin" }]), "b", "setting thin clears the double");
eq(mergeBorders("=b", [{ edge: "top", weight: "thin" }]), "t=b", "an existing double survives another edge");
eq(mergeBorders("=t=b=l=r", []), "=t=b=l=r", "every edge can be double and round-trips");
eq(mergeBorders("Tb", []), "Tb", "strings from before doubles existed parse unchanged");
eq(mergeBorders(null, [{ edge: "top", weight: "dashed" }]), "~t", "dashed writes its own marker");
eq(mergeBorders(null, [{ edge: "top", weight: "dotted" }]), ".t", "so does dotted");
eq(mergeBorders("~t.b", []), "~t.b", "mixed styles round-trip");
eq(mergeBorders(null, [{ edge: "top", weight: "thin" }], "red"), "t#red", "a pen colour rides on the end");
eq(mergeBorders("t#red", [{ edge: "bottom", weight: "thin" }]), "tb#red", "and survives another edge");
eq(mergeBorders("t#red", [], null), "t", "passing null clears the colour");
eq(splitBorders("=t~b#blue").edges, "=t~b", "splitBorders separates the edges");
eq(splitBorders("=t~b#blue").color, "blue", "and the colour");
eq(splitBorders("tb").color, null, "with no colour when there is none");
eq(splitBorders("tb#nonsense").color, null, "and none for a colour it does not know");

// the pen: a stroke becomes one edit, whatever it crossed
const DBT = ["| A | B |", "| - | - |", "| 1 | 2 |", "| 3 | 4 |"];
const drawn = planDrawBorders(
	DBT.slice(),
	[
		{ line: 2, col: 0, edge: "bottom" },
		{ line: 2, col: 1, edge: "bottom" },
	],
	{ tool: "border", weight: "dashed", color: "red" }
)!;
eq(drawn.edits.length, 1, "two cells on one row are a single edit");
ok(drawn.edits[0].text.includes('data-b="~b#red"'), "the pen lays down its style and colour");
const gridded = planDrawBorders(DBT.slice(), [{ line: 3, col: 1 }], { tool: "grid", weight: "thin", color: null })!;
ok(gridded.edits[0].text.includes('data-b="tblr"'), "the grid pen draws all four edges");
const erased = planDrawBorders(
	[DBT[0], DBT[1], DBT[2], '| 3 | <span class="ptb" data-b="tblr">4</span> |'],
	[{ line: 3, col: 1 }],
	{ tool: "erase", weight: "thin", color: null }
)!;
ok(!erased.edits[0].text.includes("data-b"), "the eraser takes them all off again");
eq(planDrawBorders(DBT.slice(), [], { tool: "grid", weight: "thin", color: null }), null, "an empty stroke plans nothing");
const BT = ["| A | B | C |", "| - | - | - |", "| 1 | 2 | 3 |", "| 4 | 5 | 6 |"];
// the stacked presets, end to end: over a column they put the top edge on the
// first row and the bottom edge on the last, each with its own weight
const stack = (action: Parameters<typeof planBorders>[2]) => {
	const out = BT.slice();
	const p = planBorders(out, { line: 2, col: 1, expect: null }, action, "column")!;
	for (const e of p.edits) out[e.line] = e.text;
	return out;
};
// a column selection starts at the header, so that is where its top edge goes
const sTB = stack("topdoublebottom");
ok(sTB[0].includes('data-b="t"'), "top and double bottom puts a thin top on the column's first cell");
ok(sTB[3].includes('data-b="=b"'), "and a double bottom on its last");
ok(!sTB[2].includes("data-b"), "leaving the rows between untouched");
const sThick = stack("topthickbottom");
ok(sThick[3].includes('data-b="B"'), "top and thick bottom writes the thick marker");
const sPlain = stack("topbottom");
ok(sPlain[0].includes('data-b="t"') && sPlain[3].includes('data-b="b"'), "top and bottom are both thin");
const sBot = stack("doublebottom");
ok(!sBot[0].includes("data-b") && sBot[3].includes('data-b="=b"'), "a bottom-only preset leaves the top alone");
let bp = planBorders(BT.slice(), { line: 2, col: 1, expect: null }, "all", "cell")!;
ok(bp.edits[0].text.includes('data-b="tblr"'), "all borders on a cell");
bp = planBorders(BT.slice(), { line: 2, col: 0, expect: null }, "outside", "row")!;
ok(
	bp.edits[0].text.includes('data-b="tbl"') &&
		bp.edits[0].text.includes('data-b="tb"') &&
		bp.edits[0].text.includes('data-b="tbr"'),
	"row outside draws the selection perimeter"
);
bp = planBorders(BT.slice(), { line: 2, col: 1, expect: null }, "bottom", "column")!;
eq(bp.edits.length, 1, "column bottom hits only one row");
eq(bp.edits[0].line, 3, "…the last body row");
bp = planBorders(
	["| A |", "| - |", '| <span class="ptb" data-b="tblr">x</span> |'],
	{ line: 2, col: 0, expect: null },
	"none",
	"cell"
)!;
eq(bp.edits[0].text, "| x |", "no border unwraps a border-only span");
const BP = ["| A |", "| - |", '| <span class="ptb" data-b="B">5</span> |'];
const tb2 = planTextStyle(BP.slice(), { line: 2, col: 0, expect: null }, "bold", "cell")!;
ok(tb2.edits[0].text.includes('data-b="B"'), "bold keeps borders");
const cb = planEdits(BP.slice(), { line: 2, col: 0, expect: null }, { bg: "#00FF00" }, "cell")!;
ok(cb.edits[0].text.includes('data-b="B"'), "coloring keeps borders");

// --- sticky formats ---
eq(fmtToTag(SPEC), "n:2:1:minus", "fmt tag encode");
const dec = fmtFromTag("c:₹:0:paren")!;
eq(`${dec.kind}|${dec.symbol}|${dec.decimals}|${dec.negative}`, "currency|₹|0|paren", "fmt tag decode");
eq(fmtFromTag("d:nope"), null, "bad fmt tag rejected");
eq(parseNumeric("₹1,000")?.value, 1000, "unicode currency symbols parse");
const SF = ["| A | B |", "| - | - |", "| 1 | 2 |"];
const stick = planStickyFormat(SF.slice(), { line: 2, col: 1, expect: null }, "c:$:2:minus", "column")!;
ok(stick.edits[0].line === 0 && stick.edits[0].text.includes('data-fmt="c:$:2:minus"'), "column sticky lives on the header cell");
const SL = SF.slice();
SL[0] = stick.edits[0].text;
let sEdits = applyStickyFormats(SL);
eq(sEdits.length, 1, "sticky pass formats the column");
ok(sEdits[0].text.includes("$2.00"), "…using the stored spec");
SL[2] = sEdits[0].text;
eq(applyStickyFormats(SL).length, 0, "sticky pass is idempotent");
SL.push("| 3 | 4 |");
ok(
	applyStickyFormats(SL).some((e) => e.line === 3 && e.text.includes("$4.00")),
	"new rows pick up the column format"
);
ok(!applyStickyFormats(SL, { line: 3, col: 1 }).some((e) => e.line === 3), "the cursor cell is skipped");
const rowStick = planStickyFormat(SL.slice(), { line: 3, col: 0, expect: null }, "p:0", "row")!;
const RSL = SL.slice();
RSL[3] = rowStick.edits[0].text;
ok(
	applyStickyFormats(RSL).some((e) => e.line === 3 && e.text.includes("300%") && e.text.includes("400%")),
	"row sticky wins over the column format"
);
eq(planStickyFormat(SF.slice(), { line: 0, col: 0, expect: null }, "p:0", "row"), null, "header row refuses row stickies");

// --- multi-cell selection + live-cell formats ---
const MC = ["| A | B |", "| - | - |", "| 1 | 2 |", "| 3 | 4 |"];
const mp = planMulti(
	MC.slice(),
	[
		{ line: 2, col: 0, expect: null },
		{ line: 2, col: 1, expect: null },
		{ line: 3, col: 1, expect: null },
	],
	(ls, t) => planTextStyle(ls, t, "bold", "cell")
)!;
eq(mp.edits.length, 2, "planMulti merges per-cell plans by line");
ok(mp.edits.some((e) => e.text === "| **1** | **2** |"), "both selected cells on one line styled");
const FT = ["| A |", "| - |", '| <span class="ptb" data-f="=1000+84">1084</span> |'];
const ftp = planFormatCells(FT.slice(), { line: 2, col: 0, expect: null }, { ...SPEC, kind: "currency" }, "cell")!;
ok(
	ftp.edits[0].text.includes('data-fmt="c:$:2:minus"') && ftp.edits[0].text.includes("1084"),
	"formatting a formula cell stores a tag"
);
const FT2 = FT.slice();
FT2[2] = ftp.edits[0].text;
ok(
	recalcCalcs(FT2).some((e) => e.text.includes("$1,084.00")),
	"recalc renders the formula through its tag"
);
const QC = ["| A |", "| - |", '| <span class="ptb" data-calc="sum:col">10</span> |', "| 5 |"];
fp = planFormatNumber(QC.slice(), { line: 2, col: 0, expect: null }, "currency", "cell")!;
ok(fp.edits[0].text.includes('data-fmt="c:$:2:minus"'), "quick $ on a live calc stores a tag");

// --- structure: rows ---
const ST = ["| A | B |", "| - | - |", "| 1 | 2 |", "| 3 | 4 |"];
let ip = planInsertRow(ST.slice(), { line: 2, col: 0, expect: null }, "below")!;
eq(ip.edits[0].kind, "insert", "insert row uses insert kind");
eq(ip.edits[0].line, 3, "insert below lands after the row");
ip = planInsertRow(ST.slice(), { line: 0, col: 0, expect: null }, "above")!;
eq(ip.edits[0].line, 2, "insert above header clamps below the delimiter");
let dp = planDeleteRow(ST.slice(), { line: 2, col: 0, expect: null })!;
eq(dp.edits[0].kind, "delete", "delete row uses delete kind");
dp = planDeleteRow(ST.slice(), { line: 0, col: 0, expect: null })!;
eq(dp.edits.length, 0, "header row cannot be deleted");
const dup = planDuplicateRow(ST.slice(), { line: 2, col: 0, expect: null })!;
eq(dup.edits[0].text, "| 1 | 2 |", "duplicate copies the row");
eq(dup.edits[0].line, 3, "duplicate inserts below");

// --- structure: columns ---
let cp = planInsertColumn(ST.slice(), { line: 2, col: 0, expect: null }, "right")!;
eq(cp.edits.length, 4, "insert column touches all lines");
ok(cp.edits.some((e) => e.line === 1 && e.text === "| - | --- | - |"), "delimiter gains a column");
cp = planDeleteColumn(ST.slice(), { line: 2, col: 1, expect: null })!;
ok(cp.edits.every((e) => !e.text.includes("B") || e.line !== 0), "delete column removes header cell");
eq(parseRow(cp.edits.find((e) => e.line === 2)!.text)!.cellCount, 1, "delete column shrinks rows");
ok(planDeleteColumn(["| A |", "| - |", "| 1 |"], { line: 2, col: 0, expect: null }) === null, "cannot delete the only column");

// --- clear contents ---
const CC = ["| A |", "| - |", '| <span class="ptb" style="background:#F00">55</span> |'];
const cc = planClearContents(CC.slice(), { line: 2, col: 0, expect: null }, "cell")!;
ok(cc.edits[0].text.includes('style="background:#F00"></span>'), "clear keeps colors, drops the value");

// --- CSV import ---
const csv = parseDelimited('Name,Amount\n"Smith, Co",5\nAcme,7');
eq(csv.length, 3, "csv rows parsed");
eq(csv[1][0], "Smith, Co", "quoted commas survive");
const tsv = parseDelimited("a\tb\n1\t2");
eq(tsv[0][1], "b", "tab delimiter auto-detected");
const built = tableFromRows([["Date", "Amt"], ["1/1", "5"]]);
eq(built[0], "| Date | Amt |", "tableFromRows header");
eq(built[1], "| --- | --- |", "tableFromRows delimiter");
const IM = ["| A | B |", "| - | - |", "| 1 | 2 |"];
let imp = planImportRows(IM.slice(), { line: 2, col: 0, expect: null }, [["9", "8"], ["7", "6"]], "append")!;
eq(imp.edits.length, 2, "append adds every row");
ok(imp.edits.every((e) => e.kind === "insert" && e.line === 3), "append inserts after the table");
// --- formulas ---
const G = [
	["1", "10"],
	["2", "20"],
	["3", "$30.50"],
	["", ""],
];
eq(evalFormula("=SUM(A1:A3)", G, 3, 0), 6, "SUM over a range");
eq(evalFormula("=AVG(B1:B3)", G, 3, 1), 20.166666666666668, "AVG reads currency values");
eq(evalFormula("=MIN(A1:A3)*MAX(A1:A3)", G, 3, 0), 3, "functions compose with arithmetic");
eq(evalFormula("=COUNT(A1:B3)", G, 3, 0), 6, "COUNT over 2D range");
eq(evalFormula("=A1*1.08", G, 3, 0), 1.08, "bare ref arithmetic");
eq(evalFormula("=(A1+A2)*2", G, 3, 0), 6, "parentheses");
eq(evalFormula("=-A2+5", G, 3, 0), 3, "unary minus");
eq(evalFormula("=SUM(A1:A4)", G, 3, 0), 6, "range skips the formula's own cell and blanks");
let threw = 0;
try { evalFormula("=A4", G, 3, 0); } catch { threw++; }
try { evalFormula("=Z9", G, 3, 0); } catch { threw++; }
try { evalFormula("=A1/0", G, 3, 0); } catch { threw++; }
try { evalFormula("=SUM(", G, 3, 0); } catch { threw++; }
eq(threw, 4, "self-ref, out-of-range, div-by-zero, and syntax errors all throw");
eq(formatFormulaResult(1774.4400000000003), "1774.44", "formula results round cleanly");
ok(looksLikeFormula("=SUM(B1:B3)") && looksLikeFormula("=C1*2") && !looksLikeFormula("=hello world"), "formula detection heuristics");

// --- Excel-literal row numbers: the header is row 1, data starts at 2 ---
const XL = ["| Loc | Count |", "| - | - |", "| PH | 70 |", "| US | 30 |", "| Total | |"];
const xg = tableGrid(XL, 0)!;
eq(xg.rows.length, 4, "the grid counts the header as a row");
eq(xg.rows[0][0], "Loc", "grid row 0 is the header");
eq(gridRowOf(xg, 0), 0, "the header line is grid row 0, addressed as 1");
eq(gridRowOf(xg, 2), 1, "the first data line is grid row 1, addressed as 2");
eq(gridRowOf(xg, 1), -1, "the delimiter line is not a row at all");
eq(evalFormula("=B1", xg.rows, 3, 1), "Count", "B1 addresses the header cell");
eq(evalFormula("=SUM(B2:B3)", xg.rows, 3, 1), 100, "data rows are numbered from 2");
const xlp = planSetCellValue(XL.slice(), { line: 4, col: 1, expect: null }, "=SUM(B2:B3)")!;
ok(xlp.edits[0].text.includes(">100</span>"), "a total row sums its Excel-numbered data rows");

// --- blockTargets: a guide selection in document coordinates ---
// the whole of column B, header included, in a table whose first line is 10
const colB = blockTargets(10, { r1: 0, r2: 3, c1: 1, c2: 1 });
eq(colB.length, 4, "a column of a 4-row grid selects 4 cells");
eq(colB[0].line, 10, "grid row 0 is the header, on the table's own first line");
eq(colB[1].line, 12, "the first data row clears the |---| divider");
eq(colB[3].line, 14, "and the rest carry on one line each");
ok(colB.every((t) => t.col === 1), "every cell of the block is in column B");
const row3 = blockTargets(10, { r1: 2, r2: 2, c1: 0, c2: 2 });
eq(row3.length, 3, "a row selects one cell per column");
eq(row3.map((t) => t.col).join(""), "012", "left to right");
ok(
	row3.every((t) => t.line === 13),
	"all on the one line"
);
// a drag runs in whichever direction the pointer went, so corners arrive either way
eq(
	JSON.stringify(blockTargets(0, { r1: 3, r2: 1, c1: 2, c2: 0 })),
	JSON.stringify(blockTargets(0, { r1: 1, r2: 3, c1: 0, c2: 2 })),
	"a block dragged up and left is the block dragged down and right"
);

// --- the fill handle's series ---
const SER = (seed: string[], n: number) => fillSeries(seed, n).join("|");
// dates: one cell steps a day, which is what Steve's screenshot drags
eq(SER(["8/4/2026"], 3), "8/5/2026|8/6/2026|8/7/2026", "a lone date walks a day at a time");
eq(SER(["8/4/2026", "8/11/2026"], 2), "8/18/2026|8/25/2026", "two dates set the interval, here a week");
eq(SER(["1/31/2026", "2/28/2026"], 1), "3/31/2026", "a month series holds the day of the month, clamped where the month is short");
eq(SER(["2026-08-04"], 2), "2026-08-05|2026-08-06", "the seed's own date style is the one written back");
eq(SER(["Aug 4, 2026"], 1), "Aug 5, 2026", "including the spelled ones");
eq(SER(["12/31/2026"], 1), "1/1/2027", "and the year rolls");
// numbers: a lone one copies, two set the step, presentation is preserved
eq(SER(["7"], 3), "7|7|7", "a lone number copies, the way a rate dragged down a column should");
eq(SER(["1", "2"], 3), "3|4|5", "two numbers set the step");
eq(SER(["10", "20", "30"], 2), "40|50", "and a longer run keeps it");
eq(SER(["5", "3"], 2), "1|-1", "a falling series keeps falling, through zero");
eq(SER(["$1,000.00", "$2,000.00"], 1), "$3,000.00", "currency, grouping and decimals all survive");
eq(SER(["50%", "60%"], 1), "70%", "so does a percent");
eq(SER(["(100)", "(200)"], 1), "(300)", "and accounting parentheses on a negative");
// times, names, and text carrying a number
eq(SER(["9:00 AM"], 2), "10:00 AM|11:00 AM", "a lone time steps an hour");
eq(SER(["9:00 AM", "9:30 AM"], 1), "10:00 AM", "two times set their own interval");
eq(SER(["Mon"], 3), "Tue|Wed|Thu", "weekdays walk");
eq(SER(["Sat"], 2), "Sun|Mon", "and wrap round the week rather than counting backwards");
eq(SER(["January", "March"], 1), "May", "months take the step they are given, spelled as they were spelled");
eq(SER(["Item 1"], 2), "Item 2|Item 3", "text carrying a number increments the number");
eq(SER(["Q1 2026"], 1), "Q1 2027", "the LAST number in the text is the one that moves");
eq(SER(["Row 08"], 2), "Row 09|Row 10", "zero padding is kept");
// anything with no series in it repeats, which is a spreadsheet's answer too
eq(SER(["Total"], 2), "Total|Total", "plain text copies");
eq(SER(["red", "blue"], 4), "red|blue|red|blue", "and a block with no pattern cycles");
eq(SER([""], 2), "|", "empty stays empty");
// a drag up passes its seed reversed, so one function answers both directions
eq(SER(["8/6/2026", "8/5/2026"], 2), "8/4/2026|8/3/2026", "reading the seed backwards walks the series backwards");

// --- planDragFill: the drag as one edit ---
const FH = ["| Date | Amount | Note |", "| - | - | - |", "| 8/4/2026 | 10 | a |", "| | | |", "| | | |"];
const fh = planDragFill(FH.slice(), [{ line: 2, col: 0 }], { line: 4, col: 0 })!;
eq(fh.filled, 2, "dragging one cell down two rows writes two cells");
const fhOut = applyPlan(FH.slice(), fh);
eq(fhOut[3].includes("8/5/2026"), true, "the row below takes the next date");
eq(fhOut[4].includes("8/6/2026"), true, "and the one after that the one after");
eq(fhOut[3].includes("| a |"), false, "the other columns are untouched by a single-column drag");
// every column of a multi-column seed projects on its own
const fh2 = planDragFill(FH.slice(), [{ line: 2, col: 0 }, { line: 2, col: 1 }], { line: 3, col: 1 })!;
const fh2Out = applyPlan(FH.slice(), fh2);
eq(fh2Out[3].includes("8/5/2026"), true, "the date column walks");
eq(fh2Out[3].includes("| 10 |"), true, "while the lone number beside it copies");
// a formula lane is copied with its references shifted, never extrapolated
const FF = ["| A | B | C |", "| - | - | - |", "| 2 | 3 | =A3*B3 |", "| 4 | 5 | |"];
const ff = planDragFill(FF.slice(), [{ line: 2, col: 2 }], { line: 3, col: 2 })!;
ok(applyPlan(FF.slice(), ff)[3].includes("=A4*B4"), "a filled formula follows the row it landed on");
eq(dragFillPreview(FF, [{ line: 2, col: 2 }], { line: 3, col: 2 }), "=A4*B4", "and the label says so before the drop");
eq(dragFillPreview(FH, [{ line: 2, col: 0 }], { line: 4, col: 0 }), "8/6/2026", "the label reads the value that will land, not the next one");
ok(planDragFill(FH.slice(), [{ line: 2, col: 0 }], { line: 2, col: 0 }) === null, "a drag that goes nowhere writes nothing");

// a header cell can hold a formula, and it computes and is referable like any
// other cell now that it has an address
const XH = ["| Item | =SUM(B2:B3) |", "| - | - |", "| a | 4 |", "| b | 6 |", "| echo | |"];
const xh = recalcCalcs(XH.slice());
const xhHead = xh.find((e) => e.line === 0);
ok(!!xhHead && xhHead.text.includes(">10</span>"), "a formula in the header row computes");
const XH2 = XH.slice();
for (const e of xh) XH2[e.line] = e.text;
const xhEcho = planSetCellValue(XH2.slice(), { line: 4, col: 1, expect: null }, "=B1")!;
ok(xhEcho.edits[0].text.includes(">10</span>"), "a header formula's value is addressable as row 1");
const xg2 = tableGrid(XH2, 0)!;
eq(evalFormula("=SUM(B:B)", xg2.rows, gridRowOf(xg2, 4), 1), 20, "B:B spans the header too, Excel-style");
eq(recalcCalcs(XH2).length, 0, "a header formula settles at a fixpoint");

// --- formula cells in recalc: typed "=…" converts, chains recompute ---
const FR = [
	"| A | B |",
	"| - | - |",
	"| 2 | =A2*10 |",
	"| 3 | 5 |",
	'| Total | <span class="ptb" data-calc="sum:col">0</span> |',
];
const fre = recalcCalcs(FR.slice());
const frLine2 = fre.find((e) => e.line === 2);
ok(!!frLine2 && frLine2.text.includes('data-f="=A2*10"') && frLine2.text.includes(">20</span>"), "typed formula converts to live cell with value");
const frTotal = fre.find((e) => e.line === 4);
ok(!!frTotal && frTotal.text.includes(">25</span>"), "column sum includes computed formula value");
const FR2 = FR.slice();
for (const e of fre) FR2[e.line] = e.text;
eq(recalcCalcs(FR2).length, 0, "formula recalc reaches a fixpoint");
const FR3 = FR2.slice();
FR3[2] = FR3[2].replace("| 2 |", "| 4 |");
const fre3 = recalcCalcs(FR3.slice());
ok(fre3.some((e) => e.text.includes(">40</span>")), "editing a referenced cell recomputes the formula");

// --- planSetCellValue ---
const SV = ["| A | B |", "| - | - |", "| 5 | 7 |"];
let sv = planSetCellValue(SV.slice(), { line: 2, col: 1, expect: null }, "=A2*2")!;
ok(sv.edits[0].text.includes('data-f="=A2*2"') && sv.edits[0].text.includes(">10</span>"), "formula bar commit creates live formula");
const SV2 = SV.slice();
SV2[2] = sv.edits[0].text;
sv = planSetCellValue(SV2, { line: 2, col: 1, expect: null }, "plain")!;
eq(sv.edits[0].text, "| 5 | plain |", "plain value replaces formula cell");

// --- planApplyRule ---
const RL = ["| A |", "| - |", "| 5 |", "| -3 |", "| hi |", "| -1 |"];
let rl = planApplyRule(RL.slice(), { line: 2, col: 0, expect: null }, { op: "lt", value: "0", bg: null, fg: "#B42318" })!;
eq(rl.matched, 2, "rule matches negatives");
ok(rl.edits.every((e) => e.text.includes("color:#B42318")), "rule writes text color");
rl = planApplyRule(RL.slice(), { line: 2, col: 0, expect: null }, { op: "contains", value: "h", bg: "#FDF3D7", fg: null })!;
eq(rl.matched, 1, "contains rule matches text");

// --- tableToCsv ---
const CSVT = ["| Name | Amt |", "| - | - |", '| **Bob** | <span class="ptb" style="background:#F00">$5</span> |', '| "Q\\|P" | 7 |'];
const csvOut = tableToCsv(CSVT, 2)!;
eq(csvOut.split("\n")[0], "Name,Amt", "csv header");
eq(csvOut.split("\n")[1], "Bob,$5", "csv strips markup and spans");
ok(csvOut.split("\n")[2].startsWith('"""Q|P"""'), "csv quotes tricky fields and unescapes pipes");

imp = planImportRows(IM.slice(), { line: 2, col: 0, expect: null }, [["X"], ["1"], ["2"]], "replace")!;
{
	const out = IM.slice();
	let off = 0;
	for (const e of [...imp.edits].sort((a, b) => a.line - b.line)) {
		const idx = e.line + off;
		if (e.kind === "insert") {
			out.splice(Math.min(idx, out.length), 0, e.text);
			off++;
		} else if (e.kind === "delete") {
			out.splice(idx, 1);
			off--;
		} else out[idx] = e.text;
	}
	eq(out.join("\n"), "| X |\n| --- |\n| 1 |\n| 2 |", "replace rebuilds the table");
}

// --- shadeVariants (Office-style palette columns) ---
eq(shadeVariants("#FFFFFF")[0], "#F2F2F2", "white column darkens in steps");
eq(shadeVariants("#000000")[0], "#808080", "black column lightens in steps");
eq(shadeVariants("#4472C4")[0], "#DAE3F3", "mid color gets lighter-80% tint first");
eq(shadeVariants("#4472C4").length, 5, "five variants per column");
ok(shadeVariants("notahex").every((c) => c === "notahex"), "non-hex value passes through untouched");

// --- whole-column / whole-row ranges and calc-to-formula display ---
eq(evalFormula("=SUM(A:A)", G, 3, 1), 6, "column range sums all data rows");
eq(evalFormula("=SUM(A:A)", G, 1, 0), 4, "column range excludes the formula's own cell");
eq(evalFormula("=SUM(1:1)", G, 3, 0), 11, "row range sums across the row");
eq(evalFormula("=COUNT(B:B)", G, 3, 0), 3, "count over a column range");
eq(evalFormula("=SUM(A:B)", G, 3, 0), 66.5, "multi-column range");
eq(calcToFormula({ fn: "sum", dir: "column" }, 1, 3), "=SUM(B:B)", "column calc displays as =SUM(B:B)");
eq(calcToFormula({ fn: "avg", dir: "row" }, 0, 2), "=AVG(2:2)", "row calc displays as =AVG(2:2)");
const SVR = ["| A | B |", "| - | - |", "| 5 | 7 |", "| 3 | |"];
const svr = planSetCellValue(SVR.slice(), { line: 3, col: 1, expect: null }, "=SUM(A:A)")!;
ok(svr.edits[0].text.includes(`data-f="=SUM(A:A)"`) && svr.edits[0].text.includes(">8</span>"), "committing =SUM(A:A) creates a live dynamic formula");
// --- emphasis survives live recomputation ---
const EMC = ["| A |", "| - |", "| 2 |", "| 4 |", `| <span class="ptb" data-calc="sum:col">**5**</span> |`];
const emr = recalcCalcs(EMC.slice());
ok(emr.length === 1 && emr[0].text.includes(">**6**</span>"), "bold live calc updates inside the bold marks");
const EMC2 = EMC.slice();
EMC2[4] = `| <span class="ptb" data-calc="sum:col">**6**</span> |`;
eq(recalcCalcs(EMC2).length, 0, "bold live calc at fixpoint is untouched");
const EMF = ["| A | B |", "| - | - |", `| 3 | <span class="ptb" data-f="=A2*2">~~**4**~~</span> |`];
const emf = recalcCalcs(EMF.slice());
ok(emf.length === 1 && emf[0].text.includes(">~~**6**~~</span>"), "nested emphasis survives formula recompute");
const nspec2 = fmtFromTag("n:2:1:minus")!;
ok((formatPiece(" **1644** ", nspec2) ?? "").includes("**1,644.00**"), "sticky formatting keeps the bold wrapper");
// --- selection AutoSum ---
const ASEL = ["| A | B |", "| - | - |", "| x | 98.55 |", "| y | 44.9 |", "| z | |"];
const selT = [{ line: 2, col: 1 }, { line: 3, col: 1 }, { line: 4, col: 1 }];
let asp = planSelectionCalc(ASEL.slice(), selT, "sum")!;
ok(asp.edits[0].text.includes(`data-f="=SUM(B2:B3)"`), "selection sum writes a range formula into the empty cell");
ok(asp.edits[0].text.includes(">143.45</span>"), "selection sum computes the value");
eq(asp.count, 2, "selection sum counts numeric cells");
const ASEL2 = ["| A | B |", "| - | - |", "| x | 10 |", "| y | 20 |", "| | |"];
asp = planSelectionCalc(ASEL2.slice(), [{ line: 2, col: 1 }, { line: 3, col: 1 }], "sum")!;
ok(asp.edits[0].line === 4 && asp.edits[0].text.includes("=SUM(B2:B3)"), "all-numeric selection lands the result just below");
asp = planSelectionCalc(["| A |", "| - |", "| x |", "| |"], [{ line: 2, col: 0 }, { line: 3, col: 0 }], "sum")!;
eq(asp.count, 0, "selection with no numbers reports zero");
const ASEL3 = ["| A | B | C |", "| - | - | - |", "| 5 | 7 | |"];
asp = planSelectionCalc(ASEL3.slice(), [{ line: 2, col: 0 }, { line: 2, col: 1 }, { line: 2, col: 2 }], "avg")!;
ok(asp.edits[0].text.includes(`data-f="=AVG(A2:B2)"`) && asp.edits[0].text.includes(">6</span>"), "horizontal selection trims the range to the left of the result");
// --- structural reference rewriting ---
eq(shiftFormulaRefs("=SUM(D2:D3)", { axis: "row", kind: "insert", at: 2 }), "=SUM(D2:D4)", "an insert inside a range stretches it");
eq(shiftFormulaRefs("=SUM(D2:D3)", { axis: "row", kind: "insert", at: 1 }), "=SUM(D3:D4)", "an insert above a range slides it down");
eq(shiftFormulaRefs("=SUM(D2:D3)", { axis: "row", kind: "insert", at: 3 }), "=SUM(D2:D3)", "an insert below a range leaves it alone");
eq(shiftFormulaRefs("=SUM(D2:D3)", { axis: "row", kind: "delete", at: 1 }), "=SUM(D2:D2)", "a delete inside a range shrinks it");
eq(shiftFormulaRefs("=B3*C3", { axis: "row", kind: "delete", at: 2 }), "=#REF!*#REF!", "deleting the referenced row kills the ref");
eq(shiftFormulaRefs("=B3*C3", { axis: "row", kind: "offset", delta: 1 }), "=B4*C4", "offset is the relative rule a copy follows");
eq(shiftFormulaRefs("=B2*C2", { axis: "col", kind: "insert", at: 1 }), "=C2*D2", "a column insert shifts the letters");
eq(shiftFormulaRefs("=B2*C2", { axis: "col", kind: "delete", at: 1 }), "=#REF!*B2", "a column delete kills the ref that named it");
eq(shiftFormulaRefs("=SUM(B:B)", { axis: "col", kind: "insert", at: 0 }), "=SUM(C:C)", "a whole-column range follows the shift");
eq(shiftFormulaRefs("=SUM(2:3)", { axis: "row", kind: "insert", at: 1 }), "=SUM(3:4)", "a whole-row range follows the shift");
eq(shiftFormulaRefs("=IF(A2='B2', B2, 0)", { axis: "row", kind: "insert", at: 1 }), "=IF(A3='B2', B3, 0)", "text inside quotes is never a reference");
eq(shiftFormulaRefs("=#REF!+B2", { axis: "row", kind: "insert", at: 1 }), "=#REF!+B3", "an already dead ref stays dead");
const PERM = { axis: "row" as const, kind: "permute" as const, map: [0, 2, 1, 3] };
eq(shiftFormulaRefs("=B2*C2", PERM), "=B3*C3", "a permuted ref follows its row");
eq(shiftFormulaRefs("=SUM(D2:D3)", PERM), "=SUM(D2:D3)", "a range permuted within itself still covers the block");
eq(formulaErrorText(new Error("#REF!")), "#REF!", "a named formula error keeps its name");
eq(formulaErrorText(new Error("bad token")), "#ERR", "any other failure is the generic error");

// end to end: the structural planners keep formulas pointing where they should
const SREF = [
	"| Item | Qty | Price | Total |",
	"| - | - | - | - |",
	"| a | 2 | 10 | =B2*C2 |",
	"| b | 3 | 20 | =B3*C3 |",
	"| Total | | | =SUM(D2:D3) |",
];
const SREFS = applyPlan(SREF, { edits: recalcCalcs(SREF.slice()) });
ok(SREFS[2].includes(">20<") && SREFS[3].includes(">60<") && SREFS[4].includes(">80<"), "baseline table computes 20, 60, 80");
const settle = (ls: string[]) => applyPlan(ls, { edits: recalcCalcs(ls.slice()) });

const insR = settle(applyPlan(SREFS, planInsertRow(SREFS.slice(), { line: 3, col: 0, expect: null }, "above")));
ok(insR[5].includes("=SUM(D2:D4)") && insR[5].includes(">80<"), "inserting a row stretches the total and keeps its value");
ok(insR[4].includes("=B4*C4") && insR[4].includes(">60<"), "a row pushed down still points at its own cells");

const delR = settle(applyPlan(SREFS, planDeleteRow(SREFS.slice(), { line: 2, col: 0, expect: null })));
ok(delR[3].includes("=SUM(D2:D2)") && delR[3].includes(">60<"), "deleting a row shrinks the range instead of dropping a row silently");

const dupR = settle(applyPlan(SREFS, planDuplicateRow(SREFS.slice(), { line: 2, col: 0, expect: null })));
ok(dupR[3].includes("=B3*C3") && dupR[3].includes(">20<"), "a duplicated row computes from its own cells, not the original's");
ok(dupR[5].includes(">100<"), "and the total picks the duplicate up");

const mvR = settle(applyPlan(SREFS, planMoveRow(SREFS.slice(), { line: 2, col: 0, expect: null }, 1)));
ok(mvR[2].includes(">60<") && mvR[3].includes(">20<"), "moving a row carries its references with it");

const srtR = settle(applyPlan(SREFS, planSort(SREFS.slice(), { line: 2, col: 1, expect: null }, "desc")));
ok(srtR[2].includes(">60<") && srtR[3].includes(">20<"), "sorting leaves every row computing its own numbers");
ok(srtR[4].includes(">80<"), "and the total still covers the whole block");

const insC = settle(applyPlan(SREFS, planInsertColumn(SREFS.slice(), { line: 2, col: 1, expect: null }, "left")));
ok(insC[2].includes("=C2*D2") && insC[2].includes(">20<"), "inserting a column shifts every letter past it");

const delC = settle(applyPlan(SREFS, planDeleteColumn(SREFS.slice(), { line: 2, col: 1, expect: null })));
ok(delC[2].includes("#REF!"), "deleting a referenced column reports #REF! instead of a wrong number");

// --- $ anchoring ---
eq(evalFormula("=$B$2", G, 5, 5), 20, "an anchored ref resolves to the same cell as a plain one");
eq(evalFormula("=SUM($A$1:$A$3)", G, 3, 0), 6, "anchors are ignored inside a range");
eq(evalFormula("=SUM($A:$A)", G, 3, 1), 6, "an anchored whole-column range still works");
eq(evalFormula("=SUM($1:$1)", G, 3, 0), 11, "an anchored whole-row range still works");
ok(looksLikeFormula("=$B$2*2"), "an anchored formula is still detected as one");
eq(shiftFormulaRefs("=$B$2*C3", { axis: "row", kind: "offset", delta: 1 }), "=$B$2*C4", "a fill leaves an anchored row alone");
eq(shiftFormulaRefs("=$B2*C3", { axis: "col", kind: "offset", delta: 1 }), "=$B2*D3", "a fill leaves an anchored column alone");
eq(shiftFormulaRefs("=B$2*C3", { axis: "row", kind: "offset", delta: 2 }), "=B$2*C5", "a mixed ref pins only its anchored half");
eq(shiftFormulaRefs("=SUM($D$2:D3)", { axis: "row", kind: "offset", delta: 1 }), "=SUM($D$2:D4)", "an anchored range end holds while the other travels");
eq(shiftFormulaRefs("=$B$2", { axis: "row", kind: "insert", at: 1 }), "=$B$3", "an insert moves an anchored ref too, since the cell itself moved");

// --- fill down and fill right ---
const FILL = [
	"| Item | Qty | Price | Total |",
	"| - | - | - | - |",
	"| a | 2 | 10 | =B2*C2 |",
	"| b | 3 | 20 | |",
	"| c | 4 | 30 | |",
];
const FILLS = applyPlan(FILL, { edits: recalcCalcs(FILL.slice()) });
const fillDown = settle(
	applyPlan(FILLS, planFill(FILLS.slice(), [{ line: 2, col: 3 }, { line: 3, col: 3 }, { line: 4, col: 3 }], "down"))
);
ok(fillDown[3].includes("=B3*C3") && fillDown[3].includes(">60<"), "fill down re-points the formula at each row");
ok(fillDown[4].includes("=B4*C4") && fillDown[4].includes(">120<"), "and carries on to the end of the selection");
const fillOne = settle(applyPlan(FILLS, planFill(FILLS.slice(), [{ line: 3, col: 3 }], "down")));
ok(fillOne[3].includes("=B3*C3") && fillOne[3].includes(">60<"), "a lone cell fills from the row above it");
eq(planFill(FILLS.slice(), [{ line: 0, col: 3 }], "down"), null, "the header has nothing above it to fill from");

const RATE = ["| Item | Price | Tax |", "| - | - | - |", "| rate | 0.1 | |", "| a | 100 | =B3*$B$2 |", "| b | 200 | |"];
const RATES = applyPlan(RATE, { edits: recalcCalcs(RATE.slice()) });
const fillAnchored = settle(applyPlan(RATES, planFill(RATES.slice(), [{ line: 3, col: 2 }, { line: 4, col: 2 }], "down")));
ok(fillAnchored[4].includes("=B4*$B$2"), "a fill moves the relative ref and pins the anchored one");
ok(fillAnchored[4].includes(">20<"), "so the filled row reads its own price against the shared rate");

const SIDE = ["| A | B | C |", "| - | - | - |", "| 5 | =A2*2 | |"];
const SIDES = applyPlan(SIDE, { edits: recalcCalcs(SIDE.slice()) });
const fillRight = settle(applyPlan(SIDES, planFill(SIDES.slice(), [{ line: 2, col: 1 }, { line: 2, col: 2 }], "right")));
ok(fillRight[2].includes("=B2*2") && fillRight[2].includes(">20<"), "fill right shifts the column letter");

// --- copy / cut / paste a block of cells ---
const CP = [
	"| Item | Qty | Price | Total |",
	"| - | - | - | - |",
	'| <span class="ptb" style="background:#0F0">a</span> | 2 | 10 | =B2*C2 |',
	"| b | 3 | 20 | |",
	"| c | 4 | 30 | |",
	"| d | 5 | 40 | |",
];
const CPS = applyPlan(CP, { edits: recalcCalcs(CP.slice()) });

const clip1 = planCopyCells(CPS.slice(), [{ line: 2, col: 3 }])!;
eq(clip1.rows.length, 1, "a one-cell copy takes one row");
eq(clip1.row, 1, "and reports its grid row, the header being row 0");
eq(clip1.refs, "shift", "a copy shifts the references of what it carries");
const paste1 = settle(applyPlan(CPS, planPasteCells(CPS.slice(), [{ line: 3, col: 3 }], clip1)));
ok(paste1[3].includes("=B3*C3") && paste1[3].includes(">60<"), "pasting a formula one row down re-points it");

const block = planCopyCells(CPS.slice(), [{ line: 2, col: 0 }, { line: 2, col: 1 }, { line: 3, col: 0 }, { line: 3, col: 1 }])!;
eq(block.rows.length, 2, "a dragged block takes every row it spans");
eq(block.rows[0].length, 2, "and every column");
const paste2 = applyPlan(CPS, planPasteCells(CPS.slice(), [{ line: 4, col: 0 }], block));
ok(paste2[4].includes("| a |") || paste2[4].includes(">a<"), "the block's top-left lands on the targeted cell");
ok(paste2[5].includes("| b |"), "and the rest follows below it");
ok(paste2[4].includes("#0F0"), "a whole-cell paste carries the fill with it");

// paste special
const vals = applyPlan(CPS, planPasteCells(CPS.slice(), [{ line: 4, col: 0 }], block, "values"));
ok(!vals[4].includes("#0F0"), "values only leaves the destination's own formatting alone");
const fcopy = planCopyCells(CPS.slice(), [{ line: 2, col: 3 }])!;
const valsF = settle(applyPlan(CPS, planPasteCells(CPS.slice(), [{ line: 3, col: 3 }], fcopy, "values")));
ok(!valsF[3].includes("data-f"), "values only drops the formula");
eq(valsF[3].split("|")[4].trim(), "20", "and lands the number the formula was showing, as plain text");
const fmts = applyPlan(CPS, planPasteCells(CPS.slice(), [{ line: 4, col: 0 }], block, "formats"));
ok(fmts[4].includes("#0F0") && fmts[4].includes(">c<"), "formats only repaints the cell and keeps its value");
const forms = settle(applyPlan(CPS, planPasteCells(CPS.slice(), [{ line: 3, col: 3 }], fcopy, "formulas")));
ok(forms[3].includes("=B3*C3"), "formulas only still re-points what it carries");

// transpose
const strip = planCopyCells(CPS.slice(), [{ line: 2, col: 0 }, { line: 3, col: 0 }, { line: 4, col: 0 }])!;
const trans = applyPlan(CPS, planPasteCells(CPS.slice(), [{ line: 5, col: 0 }], strip, "values", true));
ok(trans[5].includes("| a | b | c |"), "a transposed paste turns the column into a row");

// growing and clamping
const grow = planPasteCells(CPS.slice(), [{ line: 5, col: 0 }], block)!;
eq(grow.added, 1, "a block running off the bottom grows the table by what it needs");
const grown = applyPlan(CPS, grow);
ok(grown.length === CPS.length + 1 && grown[6].includes("| b |"), "and the new row holds the rest of the block");
const wide = planCopyCells(CPS.slice(), [{ line: 2, col: 0 }, { line: 2, col: 1 }])!;
const clamp = planPasteCells(CPS.slice(), [{ line: 3, col: 3 }], wide)!;
eq(clamp.clamped, 1, "a block running off the right is clamped rather than widening the table");

// tiling, the way Excel fills a selection from a smaller copy
const one = planCopyCells(CPS.slice(), [{ line: 2, col: 1 }])!;
const tiled = applyPlan(CPS, planPasteCells(CPS.slice(), [{ line: 3, col: 1 }, { line: 4, col: 1 }, { line: 5, col: 1 }], one));
ok(tiled[3].includes("| 2 |") && tiled[5].includes("| 2 |"), "one cell tiles over the whole selection");

// cut
const cut = planCopyCells(CPS.slice(), [{ line: 2, col: 1 }], { cut: true, path: "n.md" })!;
eq(cut.refs, "hold", "a cut moves cells, so their references hold still");
const moved = planPasteCells(CPS.slice(), [{ line: 5, col: 1 }], cut)!;
eq(moved.cleared, 1, "the source empties as part of the same edit, so a move is one undo");
const movedLines = applyPlan(CPS, moved);
ok(movedLines[5].includes("| 2 |"), "the value arrives at the destination");
ok(/\|\s+\|/.test(movedLines[2].replace(/<[^>]*>/g, "")), "and is gone from where it was");
const stale = { ...cut, rows: [["  999  "]] };
eq(planPasteCells(CPS.slice(), [{ line: 5, col: 1 }], stale)!.cleared, 0, "a cut whose source has changed since pastes without clearing anything");

// an overlapping move has to clear before it writes, or it erases itself
const ov = planCopyCells(CPS.slice(), [{ line: 2, col: 1 }, { line: 3, col: 1 }], { cut: true, path: "n.md" })!;
const ovLines = applyPlan(CPS, planPasteCells(CPS.slice(), [{ line: 3, col: 1 }], ov)!);
ok(ovLines[3].includes("| 2 |") && ovLines[4].includes("| 3 |"), "an overlapping cut-paste lands what it moved");
ok(/\|\s+\|/.test(ovLines[2]), "and clears only the part it left behind");

// text arriving from outside
const outside = clipFromRows([["x", "1"], ["y", "2"]])!;
eq(outside.refs, "hold", "text from outside has no source coordinates to shift against");
const pasted = applyPlan(CPS, planPasteCells(CPS.slice(), [{ line: 4, col: 0 }], outside));
ok(pasted[4].includes("| x |") && pasted[4].includes("| 1 |"), "and lands as plain values");
eq(clipToTsv(block), "a\t2\nb\t3", "a block leaves as tab-separated text, wrappers stripped");
eq(planPasteCells(CPS.slice(), [{ line: 1, col: 0 }], block), null, "the divider row is not somewhere a paste can land");

// --- AutoFilter ---
const FLT = [
	"| Region | Amount | Status |",
	"| - | - | - |",
	"| East | 100 | Done |",
	"| West | 250 | Open |",
	"| East | 75 | Open |",
	"| North |  | Done |",
];
const T0 = { line: 2, col: 0, expect: null };

eq(filterTag({ op: "in", value: "East~West" }), "in:East~West", "a value list stores the values it shows");
eq(filterTag({ op: "ex", value: "" }), null, "an empty exclusion list is not a filter");
eq(filterTag({ op: "in", value: "" }), null, "and neither is an empty inclusion list, which would hide the column");
eq(parseFilterTag("gt:100")?.op, "gt", "a condition filter reads back its operator");
eq(parseFilterTag("in:a~b")?.value, "a~b", "and a list filter its values");
eq(parseFilterTag("nonsense:1"), null, "an unreadable tag is no filter at all");
eq(fltSafe('a;b|c"d:e~f'), "a b c d e f", "the characters that would break the tag or the list are traded for spaces");

ok(filterHit("East", { op: "in", value: "East~West" }), "an included value stays on screen");
ok(!filterHit("North", { op: "in", value: "East~West" }), "one that is not included goes");
ok(!filterHit("East", { op: "ex", value: "East" }), "an excluded value goes");
ok(filterHit("South", { op: "ex", value: "East" }), "and a value that arrived after the list was built stays, which is why ex exists");
ok(filterHit("250", { op: "gt", value: "100" }), "a condition filter compares numbers as numbers");
ok(!filterHit("75", { op: "gt", value: "100" }), "and hides what fails it");
ok(filterHit("Open", { op: "starts", value: "op" }), "begins-with is case insensitive");
ok(filterHit("Open", { op: "ends", value: "EN" }), "and so is ends-with");
ok(filterHit("**East**", { op: "in", value: "East" }), "emphasis in the cell does not change the value it holds");
ok(filterHit("anything", null), "no filter hides nothing");

// a blank is a value people filter by, and an empty segment is how "no filter"
// is written, so it has to ride as something a real value can never be
eq(fltValue(""), " ", "a blank value stores as a single space");
eq(fltValue("  East  "), "East", "and a real one stores trimmed, which is why the space is free to mean blank");
eq(filterTag({ op: "in", value: fltValue("") }), "in: ", "so ticking only the blanks is a filter, not a clear");
ok(filterHit("", { op: "in", value: " " }), "a blank cell passes a blank-only filter");
ok(!filterHit("East", { op: "in", value: " " }), "and anything with text in it does not");
ok(!filterHit("", { op: "ex", value: " " }), "excluding blanks hides the empty cells");
ok(filterHit("East", { op: "in", value: "East~ " }), "a list can hold blanks alongside real values");
ok(filterHit("", { op: "in", value: "East~ " }), "and both sides of it match");

const set = applyPlan(FLT, planSetColumnFilter(FLT.slice(), T0, { op: "in", value: "East" }));
ok(set[0].includes('data-flt="in:East"'), "the filter is stored on the column's header cell");
ok(set[2] === FLT[2] && set[5] === FLT[5], "and no row is rewritten: filtering hides on screen, it does not edit");
eq(columnFilterAt(set, T0)?.value, "East", "which is where it reads back from");
const cleared = applyPlan(set, planSetColumnFilter(set.slice(), T0, null));
ok(!cleared[0].includes("data-flt"), "clearing takes the attribute back off");
eq(planSetColumnFilter(set.slice(), T0, { op: "in", value: "East" })!.edits.length, 0, "setting the filter it already has writes nothing");

// the header carries other column markers; a filter must not displace them
const MARKED = ['| <span class="ptb" data-w="140" data-rule="lt:0:-:#F00">Region</span> | Amount |', "| - | - |", "| East | 1 |"];
const withFlt = applyPlan(MARKED, planSetColumnFilter(MARKED.slice(), { line: 2, col: 0, expect: null }, { op: "ex", value: "West" }));
ok(withFlt[0].includes('data-w="140"') && withFlt[0].includes("data-rule="), "storing a filter keeps the column's width and rules");
const widened = applyPlan(withFlt, planSetColumnWidth(withFlt.slice(), { line: 2, col: 0, expect: null }, 200));
ok(widened[0].includes('data-flt="ex:West"'), "and setting the width keeps the filter");
const ruled = applyPlan(withFlt, planSetColumnRules(withFlt.slice(), { line: 2, col: 0, expect: null }, [{ op: "gt", value: "5", bg: "#0F0", fg: null }]));
ok(ruled[0].includes('data-flt="ex:West"'), "as does setting the color rules");

const many = applyPlan(set, planSetColumnFilter(set.slice(), { line: 2, col: 1, expect: null }, { op: "gt", value: "50" }));
eq(planClearFilters(many.slice(), T0)!.cleared, 2, "clear-all takes every column's filter off in one edit");
ok(!applyPlan(many, planClearFilters(many.slice(), T0)!)[0].includes("data-flt"), "leaving no filter behind");

// --- operators: ^ & % ---
const errOf = (f: () => unknown): string => {
	try {
		f();
		return "(no error)";
	} catch (e) {
		return formulaErrorText(e);
	}
};
eq(evalFormula("=A2^3", G, 5, 5), 8, "^ raises to a power");
eq(evalFormula("=2^3^2", [[""]], 5, 5), 512, "^ is right associative, as in Excel");
eq(evalFormula("=-2^2", [[""]], 5, 5), 4, "unary minus binds tighter than ^, as in Excel");
eq(evalFormula("=A2*50%", G, 5, 5), 1, "% is a postfix hundredth");
eq(evalFormula("=-50%", [[""]], 5, 5), -0.5, "% applies after the sign");
eq(evalFormula("='Total: '&A2", G, 5, 5), "Total: 2", "& joins text to a number");
eq(evalFormula("=A2&B2", G, 5, 5), "220", "& stringifies both sides");
eq(evalFormula("=1&2='12'", [[""]], 5, 5), 1, "& binds tighter than comparison");
eq(errOf(() => evalFormula("=1/0", [[""]], 5, 5)), "#DIV/0!", "dividing by zero says which error it is");

// --- new functions ---
eq(evalFormula("=MEDIAN(A1:A3)", G, 5, 5), 2, "MEDIAN");
eq(evalFormula("=PRODUCT(A1:A3)", G, 5, 5), 6, "PRODUCT");
eq(evalFormula("=SUMPRODUCT(A1:A3,B1:B3)", G, 5, 5), 141.5, "SUMPRODUCT pairs the ranges off position by position");
eq(evalFormula("=STDEV(A1:A3)", G, 5, 5), 1, "STDEV is the sample deviation");
eq(evalFormula("=POWER(2,10)", [[""]], 5, 5), 1024, "POWER");
eq(evalFormula("=SQRT(144)", [[""]], 5, 5), 12, "SQRT");
eq(evalFormula("=INT(2.9)", [[""]], 5, 5), 2, "INT floors");
eq(evalFormula("=MOD(-3,5)", [[""]], 5, 5), 2, "MOD takes the divisor's sign, as Excel does");
eq(evalFormula("=ROUNDUP(2.01,1)", [[""]], 5, 5), 2.1, "ROUNDUP");
eq(evalFormula("=ROUNDDOWN(2.09,1)", [[""]], 5, 5), 2, "ROUNDDOWN");
eq(evalFormula("=ROUNDDOWN(-2.09,1)", [[""]], 5, 5), -2, "ROUNDDOWN goes toward zero");
eq(evalFormula("=COUNTA(A1:A4)", G, 5, 5), 3, "COUNTA skips the blank");
eq(evalFormula("=COUNTBLANK(A1:A4)", G, 5, 5), 1, "COUNTBLANK counts only the blank");
eq(evalFormula("=AND(1,1)", [[""]], 5, 5), 1, "AND");
eq(evalFormula("=AND(1,0)", [[""]], 5, 5), 0, "AND is false when any argument is");
eq(evalFormula("=OR(0,1)", [[""]], 5, 5), 1, "OR");
eq(evalFormula("=NOT(0)", [[""]], 5, 5), 1, "NOT");
eq(evalFormula("=AVERAGEIF(A1:A3,'>1')", G, 5, 5), 2.5, "AVERAGEIF");
eq(evalFormula("=IFERROR(1/0,'safe')", [[""]], 5, 5), "safe", "IFERROR catches a first argument that throws");
eq(evalFormula("=IFERROR(A2,'safe')", G, 5, 5), 2, "IFERROR passes a good value straight through");
eq(evalFormula("=IFERROR(1/0,A2)", G, 5, 5), 2, "IFERROR can fall back to a reference");
eq(evalFormula("=IFERROR(SUM(A1:A3),0)", G, 5, 5), 6, "IFERROR handles a nested call in its first argument");

// text
eq(evalFormula("=LEN('abcd')", [[""]], 5, 5), 4, "LEN");
eq(evalFormula("=LEFT('abcd',2)", [[""]], 5, 5), "ab", "LEFT");
eq(evalFormula("=RIGHT('abcd',2)", [[""]], 5, 5), "cd", "RIGHT");
eq(evalFormula("=MID('abcd',2,2)", [[""]], 5, 5), "bc", "MID counts from 1, like Excel");
eq(evalFormula("=TRIM('  a   b  ')", [[""]], 5, 5), "a b", "TRIM collapses runs of spaces");
eq(evalFormula("=UPPER('ab')", [[""]], 5, 5), "AB", "UPPER");
eq(evalFormula("=LOWER('AB')", [[""]], 5, 5), "ab", "LOWER");
eq(evalFormula("=CONCAT('a',A2)", G, 5, 5), "a2", "CONCAT takes values and ranges");

// lookups
const LK = [["Widget", "10"], ["Gadget", "20"], ["Doohickey", "30"]];
eq(evalFormula("=VLOOKUP('Gadget',A1:B3,2)", LK, 5, 5), 20, "VLOOKUP finds the row and reads across it");
eq(evalFormula("=VLOOKUP('gadget',A1:B3,2)", LK, 5, 5), 20, "VLOOKUP matches case-insensitively, as Excel does");
eq(errOf(() => evalFormula("=VLOOKUP('nope',A1:B3,2)", LK, 5, 5)), "#N/A", "VLOOKUP reports a miss as #N/A");
eq(errOf(() => evalFormula("=VLOOKUP('Gadget',A1:B3,9)", LK, 5, 5)), "#REF!", "VLOOKUP past the range's last column is #REF!");
eq(evalFormula("=MATCH('Doohickey',A1:A3)", LK, 5, 5), 3, "MATCH gives the position in the range");
eq(evalFormula("=INDEX(A1:B3,2,2)", LK, 5, 5), 20, "INDEX reads by position");
eq(evalFormula("=INDEX(B1:B3,MATCH('Widget',A1:A3))", LK, 5, 5), 10, "INDEX and MATCH compose");
eq(errOf(() => evalFormula("=VLOOKUP('Widget',A1:B3,2)", LK, 1, 1)), "#CIRC!", "a lookup over its own cell is refused");

// --- error taxonomy: each failure says which kind of wrong it is ---
eq(errOf(() => evalFormula("=A1+1", [["text"]], 5, 5)), "#VALUE!", "text in arithmetic is #VALUE!");
eq(errOf(() => evalFormula("=ABS('x')", [[""]], 5, 5)), "#VALUE!", "a text argument where a number belongs is #VALUE!");
eq(errOf(() => evalFormula("=A1>1", [["text"]], 5, 5)), "#VALUE!", "comparing text to a number is #VALUE!");
eq(errOf(() => evalFormula("=NOSUCHFN(1)", [[""]], 5, 5)), "#NAME?", "an unknown function is #NAME?");
eq(errOf(() => evalFormula("=SUM(", [[""]], 5, 5)), "#NAME?", "unparseable input is #NAME?");
eq(errOf(() => evalFormula("=1 2", [[""]], 5, 5)), "#NAME?", "trailing junk is #NAME?");
eq(errOf(() => evalFormula("=Z9", [["1"]], 5, 5)), "#REF!", "a reference off the end of the table is #REF!");
eq(errOf(() => evalFormula("=A1", [["1"]], 0, 0)), "#CIRC!", "a cell referring to itself is #CIRC!");
eq(errOf(() => evalFormula("=SQRT(-1)", [[""]], 5, 5)), "#NUM!", "an impossible number is #NUM!");
eq(errOf(() => evalFormula("=AVG(A1:A2)", [["x"], ["y"]], 5, 5)), "#DIV/0!", "averaging nothing is #DIV/0!");
eq(errOf(() => evalFormula("=MEDIAN(A1:A2)", [["x"], ["y"]], 5, 5)), "#NUM!", "a median of nothing is #NUM!");

// Excel returns a value, not an error, when an aggregate finds nothing to work on
eq(evalFormula("=SUM(A1:A2)", [["x"], ["y"]], 5, 5), 0, "summing an empty column is 0, as in Excel");
eq(evalFormula("=MIN(A1:A2)", [["x"], ["y"]], 5, 5), 0, "MIN of nothing is 0, as in Excel");
eq(evalFormula("=MAX(A1:A2)", [["x"], ["y"]], 5, 5), 0, "MAX of nothing is 0, as in Excel");
eq(evalFormula("=COUNT(A1:A2)", [["x"], ["y"]], 5, 5), 0, "COUNT of nothing is 0");
eq(evalFormula("=IFERROR(NOSUCHFN(1),'caught')", [[""]], 5, 5), "caught", "IFERROR still catches a #NAME? underneath");

// dates read off a cell
eq(evalFormula("=YEAR(A1)", [["3/14/2012"]], 5, 5), 2012, "YEAR reads a date cell");
eq(evalFormula("=MONTH(A1)", [["3/14/2012"]], 5, 5), 3, "MONTH");
eq(evalFormula("=DAY(A1)", [["3/14/2012"]], 5, 5), 14, "DAY");
ok(looksLikeFormula("=VLOOKUP('a',A1:B2,2)") && looksLikeFormula("=LEN(A2)"), "the new functions register as formulas");
ok(!looksLikeFormula("=hello world"), "plain text still is not a formula");

// --- the autocomplete list and the parser cannot drift apart ---
ok(FORMULA_FUNCTIONS.length === 42, "every registered function name is offered for completion");
ok(
	FORMULA_FUNCTIONS.every((f, i) => i === 0 || FORMULA_FUNCTIONS[i - 1] <= f),
	"the suggestion list is alphabetical"
);
// A name in the list with no implementation behind it parses and then dies as
// #NAME?, which reads as a broken formula rather than a missing feature. Probe
// each one with a spread of argument shapes: a real implementation answers at
// least one of them with something other than #NAME?.
const FN_SHAPES = ["A1:A3", "A1:A3,'>0'", "A1:B3,2,2", "'3/14/2012'", "'abcd',2,2", "1,1", "144", "A1:A3,B1:B3"];
const FN_GRID = [["1", "2"], ["3", "4"], ["5", "6"]];
const unimplemented = FORMULA_FUNCTIONS.filter((f) =>
	FN_SHAPES.every((a) => errOf(() => evalFormula(`=${f}(${a})`, FN_GRID, 9, 9)) === "#NAME?")
);
eq(unimplemented.join(",") || "(none)", "(none)", "every suggested name reaches a real implementation");

// what the formula bar offers while you type
eq(completionsAt("=VL", 3).join(","), "VLOOKUP", "typing the start of a name suggests it");
eq(completionsAt("=SUM", 4).join(","), "SUM,SUMIF,SUMPRODUCT", "a name that is also a prefix keeps its longer siblings");
eq(completionsAt("=vlo", 4).join(","), "VLOOKUP", "matching ignores case");
eq(completionsAt("=MEDIAN", 7).length, 0, "an exact and only match has nothing left to offer");
eq(completionsAt("=A2+", 4).length, 0, "nothing is suggested where a name is not being typed");
eq(completionsAt("plain text", 5).length, 0, "and never outside a formula");
eq(completionsAt("=SUM(B2:B4)+AV", 14).join(","), "AVERAGE,AVERAGEIF,AVG", "the word at the caret is what counts, not the whole line");
const comp = applyCompletion("=SUM(B2:B4)+AV", 14, "AVG");
eq(comp.text, "=SUM(B2:B4)+AVG(", "accepting a suggestion writes the name and its open paren");
eq(comp.caret, 16, "and leaves the caret inside the parentheses");
const compMid = applyCompletion("=LE)", 3, "LEFT");
eq(compMid.text, "=LEFT()", "text after the caret is kept");

// where a cell click inserts a reference instead of retargeting
ok(refInsertAllowed("=", 1), "right after the leading = a click points");
ok(refInsertAllowed("=SUM(", 5), "and after an opening paren");
ok(refInsertAllowed("=A2+", 4), "and after an operator");
ok(refInsertAllowed("=SUM(A2,", 8), "and after a comma");
ok(!refInsertAllowed("=A2", 3), "but not in the middle of a reference already typed");
ok(!refInsertAllowed("plain", 5), "and not when the cell holds plain text");

// --- planPrettify ---
const PR = ["| A | Bee |", "| - | ---: |", "| xx | 1 |", `| <span class="ptb" style="color:#F00">y</span> | 22 |`, "| z |"];
const pr = planPrettify(PR.slice(), { line: 2, col: 0, expect: null })!;
const prOut = PR.slice();
for (const e of pr.edits) prOut[e.line] = e.text;
ok(prOut.every((l) => l.length === prOut[0].length), "prettify pads every line to the same width");
ok(/\| -+: \|$/.test(prOut[1]), "right alignment survives in the stretched delimiter");
ok(prOut[2].includes("| xx ") && / {2,}1 \|$/.test(prOut[2]), "right-aligned cells pad on the left");
eq(parseRow(prOut[4])!.cellCount, 2, "ragged short row gains its missing cell");
eq(planPrettify(prOut, { line: 2, col: 0, expect: null })!.rows, 0, "prettify is idempotent");
// --- expanded formula engine: IF, comparisons, ROUND, ABS, SUMIF, COUNTIF, text ---
const GF = [
	["Widget", "120"],
	["Gadget", "80"],
	["Widget", "40"],
];
eq(evalFormula("=IF(A1>100, 1, 0)", [["150"]], 5, 5), 1, "IF with numeric comparison");
eq(evalFormula("=IF(B1>100, 'High', 'Low')", GF, 5, 5), "High", "IF returns text");
eq(evalFormula("=IF(A1='widget', 10, 20)", GF, 5, 5), 10, "text comparison is case-insensitive");
eq(evalFormula("=ROUND(2.678, 2)", [[""]], 5, 5), 2.68, "ROUND with digits");
eq(evalFormula("=ROUND(2.5)", [[""]], 5, 5), 3, "ROUND default digits");
eq(evalFormula("=ABS(0-7)", [[""]], 5, 5), 7, "ABS");
eq(evalFormula("=SUMIF(B1:B3, '>50')", GF, 5, 5), 200, "SUMIF numeric criteria");
eq(evalFormula("=SUMIF(A1:A3, 'Widget', B1:B3)", GF, 5, 5), 160, "SUMIF with separate sum range");
eq(evalFormula("=COUNTIF(A1:A3, 'Widget')", GF, 5, 5), 2, "COUNTIF equality");
eq(evalFormula("=COUNTIF(B1:B3, '<>80')", GF, 5, 5), 2, "COUNTIF not-equal");
eq(evalFormula("=1>2", [[""]], 5, 5), 0, "bare comparison yields 0/1");
let ferr = 0;
try { evalFormula("='a'+1", [[""]], 5, 5); } catch { ferr++; }
try { evalFormula("=IF(1>0)", [[""]], 5, 5); } catch { ferr++; }
eq(ferr, 2, "text arithmetic and short IF throw");
ok(matchCriteria("**$150**", ">100"), "criteria sees through emphasis and currency");
ok(looksLikeFormula("=IF(A1>1,'x','y')") && looksLikeFormula("=COUNTIF(A:A,'x')"), "detection knows the new functions");
const SVF = ["| A | B |", "| - | - |", "| 5 | |"];
const svf = planSetCellValue(SVF.slice(), { line: 2, col: 1, expect: null }, "=IF(A2>3, 'Big', 'Small')")!;
ok(svf.edits[0].text.includes(">Big</span>"), "text formula result lands in the cell");

// --- live rules ---
const LR = ["| A | Amt |", "| - | --- |", "| x | 5 |", "| y | -3 |", "| z | 2 |"];
const lr = planSetColumnRules(LR.slice(), { line: 2, col: 1, expect: null }, [
	{ op: "lt", value: "0", bg: null, fg: "#B42318" },
])!;
const LR2 = LR.slice();
for (const e of lr.edits) LR2[e.line] = e.text;
ok(LR2[0].includes(`data-rule="lt:0:-:#B42318"`), "live rule stored on the header cell");
ok(LR2[3].includes("color:#B42318"), "matching cell painted on apply");
// value changes: -3 becomes 3 (rule color removed), 2 becomes -2 (painted)
const LR3 = LR2.slice();
LR3[3] = LR3[3].replace("-3", "3");
LR3[4] = LR3[4].replace(" 2 ", " -2 ");
const lrEdits = applyLiveRules(LR3.slice());
const LR4 = LR3.slice();
for (const e of lrEdits) LR4[e.line] = e.text;
ok(!LR4[3].includes("#B42318"), "cell that stops matching loses the rule color");
ok(LR4[4].includes("color:#B42318"), "cell that starts matching gains the rule color");
eq(applyLiveRules(LR4.slice()).length, 0, "live rules are idempotent");
// manual colors survive
const LR5 = LR2.slice();
LR5[4] = LR5[4].replace(" 2 ", ` <span class="ptb" style="color:#0B6BCB">-9</span> `);
const LR6 = LR5.slice();
for (const e of applyLiveRules(LR5.slice())) LR6[e.line] = e.text;
ok(LR6[4].includes("color:#0B6BCB"), "hand-painted colors are not overwritten by the rule");
// one-shot apply paints its matches but leaves stored rules alone
const oneShot = planApplyRule(LR2.slice(), { line: 2, col: 1, expect: null }, { op: "gt", value: "4", bg: "#F6E8B9", fg: null })!;
const LR7 = LR2.slice();
for (const e of oneShot.edits) LR7[e.line] = e.text;
ok(LR7[0].includes(`data-rule="lt:0:-:#B42318"`), "one-shot apply leaves the stored live rule in place");
ok(LR7[2].includes("background:#F6E8B9"), "one-shot apply painted its matches");
eq(oneShot.matched, 1, "one-shot apply reports its match count");

// --- rule editing: read back and remove ---
const prt = parseRuleTag("lt:0:-:#B42318")!;
ok(prt.op === "lt" && prt.value === "0" && prt.bg === null && prt.fg === "#B42318", "parseRuleTag decodes ops, values, and dash colors");
eq(parseRuleTag("nope"), null, "parseRuleTag rejects junk");
eq(parseRuleTags("lt:0:-:#F00;gt:9:#FF0:-").length, 2, "parseRuleTags splits a semicolon list");
eq(parseRuleTags("lt:0:-:#F00;junk").length, 1, "parseRuleTags drops malformed parts");
const cra = columnRulesAt(LR2, { line: 3, col: 1, expect: null });
ok(cra.length === 1 && cra[0].op === "lt" && cra[0].value === "0" && cra[0].fg === "#B42318", "columnRulesAt reads the stored rule from any cell in the column");
eq(columnRulesAt(LR2, { line: 3, col: 0, expect: null }).length, 0, "columnRulesAt is empty for a column without a rule");
const pcr = planClearColumnRule(LR2.slice(), { line: 3, col: 1, expect: null })!;
const LR8 = LR2.slice();
for (const e of pcr.edits) LR8[e.line] = e.text;
ok(!LR8[0].includes("data-rule"), "planClearColumnRule strips the header tag");
ok(LR8[3].includes("color:#B42318"), "planClearColumnRule leaves painted colors in place");
eq(planClearColumnRule(LR8.slice(), { line: 3, col: 1, expect: null })!.edits.length, 0, "clearing a column without a rule is a no-op");

// --- multiple rules per column: first match wins ---
const MR = ["| A | Amt |", "| - | --- |", "| x | 500 |", "| y | 44 |", "| z | 80 |"];
const mrTarget = { line: 2, col: 1, expect: null };
const mr = planSetColumnRules(MR.slice(), mrTarget, [
	{ op: "gt", value: "100", bg: "#F6E8B9", fg: null },
	{ op: "lt", value: "75", bg: "#FBD5D0", fg: null },
])!;
const MR2 = MR.slice();
for (const e of mr.edits) MR2[e.line] = e.text;
ok(MR2[0].includes(`data-rule="gt:100:#F6E8B9:-;lt:75:#FBD5D0:-"`), "rule list stored semicolon-joined on the header");
ok(MR2[2].includes("background:#F6E8B9"), "first rule painted its match");
ok(MR2[3].includes("background:#FBD5D0"), "second rule painted its match");
ok(!MR2[4].includes("background"), "cell matching no rule stays unpainted");
eq(columnRulesAt(MR2, { line: 3, col: 1, expect: null }).length, 2, "columnRulesAt reads the whole list back");
// a value moving from one rule's range to the other repaints
const MR3 = MR2.slice();
MR3[3] = MR3[3].replace("44", "500");
const MR4 = MR3.slice();
for (const e of applyLiveRules(MR3.slice())) MR4[e.line] = e.text;
ok(MR4[3].includes("background:#F6E8B9") && !MR4[3].includes("#FBD5D0"), "cell repaints when a different rule wins");
// both rules hit: the earlier one wins
const FM = ["| A |", "| - |", "| 10 |"];
const fmr = planSetColumnRules(FM.slice(), { line: 2, col: 0, expect: null }, [
	{ op: "gt", value: "5", bg: "#F6E8B9", fg: null },
	{ op: "gt", value: "1", bg: "#FBD5D0", fg: null },
])!;
const FM2 = FM.slice();
for (const e of fmr.edits) FM2[e.line] = e.text;
ok(FM2[2].includes("#F6E8B9") && !FM2[2].includes("#FBD5D0"), "the first matching rule wins");
// deleting one rule keeps the other; orphaned colors stay put
const mrOne = planSetColumnRules(MR2.slice(), mrTarget, [{ op: "gt", value: "100", bg: "#F6E8B9", fg: null }])!;
const MR5 = MR2.slice();
for (const e of mrOne.edits) MR5[e.line] = e.text;
ok(MR5[0].includes(`data-rule="gt:100:#F6E8B9:-"`) && !MR5[0].includes("lt:75"), "removing one rule rewrites the list");
ok(MR5[3].includes("#FBD5D0"), "colors a removed rule painted stay in place");

// --- new rule conditions ---
ok(ruleHit("15", "between", "10~20") && ruleHit("10", "between", "10~20"), "between is inclusive");
ok(!ruleHit("25", "between", "10~20") && !ruleHit("x", "between", "10~20"), "between skips out-of-range and text");
ok(ruleHit("  ", "empty", "") && !ruleHit("x", "empty", ""), "is empty matches blank cells only");
ok(ruleHit("x", "notempty", "") && !ruleHit("", "notempty", ""), "is not empty is the inverse");
ok(ruleHit("F-150 Lariat", "regex", "^f-?150") && !ruleHit("Ranger", "regex", "^f-?150"), "patterns match case-insensitively");
ok(!ruleHit("abc", "regex", "["), "a broken pattern never matches");

// --- color scales ---
eq(parseRuleTag("scale:#000000~#FFFFFF:-:-")?.op, "scale", "scale tag parses");
eq(lerpHex("#000000", "#FFFFFF", 0.5), "#808080", "lerp midpoint");
const SCL = ["| A |", "| - |", "| 10 |", "| 20 |", "| x |"];
const scp = planApplyRule(
	SCL.slice(),
	{ line: 2, col: 0, expect: null },
	{ op: "scale", value: "#000000~#FFFFFF", bg: null, fg: null }
)!;
eq(scp.matched, 2, "scale colors only numeric cells");
ok(scp.edits.some((e) => e.line === 2 && e.text.includes("background:#000")), "column minimum gets the low color");
ok(scp.edits.some((e) => e.line === 3 && e.text.includes("background:#FFF")), "column maximum gets the high color");
const SLV = ['| <span class="ptb" data-rule="scale:#000000~#FFFFFF:-:-">A</span> |', "| - |", "| 10 |", "| 20 |"];
const sle = applyLiveRules(SLV.slice());
eq(sle.length, 2, "a stored scale rule paints its column");
const SLV2 = SLV.slice();
for (const e of sle) SLV2[e.line] = e.text;
eq(applyLiveRules(SLV2).length, 0, "scale enforcement is idempotent");

// --- totals row ---
const TR = ["| Item | Q1 | Note |", "| - | - | - |", "| A | 10 | x |", "| B | 20 | y |"];
const trp = planTotalsRow(TR.slice(), { line: 2, col: 0, expect: null })!;
eq(trp.added, 1, "totals row sums the numeric column only");
eq(trp.edits[0].text, '| Total | <span class="ptb" data-calc="sum:col">0</span> |   |', "totals row shape");
const TR2 = TR.concat([trp.edits[0].text]);
const trc = recalcCalcs(TR2.slice());
ok(trc.some((e) => e.text.includes(">30<")), "recalc fills the live total");
const trp2 = planTotalsRow(TR2.slice(), { line: 2, col: 0, expect: null })!;
eq(trp2.added, 0, "a table with a totals row is left alone");

// --- per-table appearance flags ---
eq(tableFlagTag(parseTableFlagTag("striped,noguides")), "noguides,striped", "flag tag round-trips (canonical order)");
eq(tableFlagTag({}), null, "empty flag map means no tag");
eq(tableFlagTag(parseTableFlagTag("noheaderfill,striped")), "striped,noheaderfill", "headerfill round-trips with the others");
eq(parseTableFlagTag("headerfill").headerfill, true, "headerfill parses as a force-on token");
eq(tableFlagTag(parseTableFlagTag("nofilters,sticky")), "sticky,nofilters", "sticky and filters round-trip (canonical order)");
const TFL = ["| A | B |", "| - | - |", "| 1 | 2 |"];
const tfTarget = { line: 2, col: 0, expect: null };
const tf1 = planSetTableFlag(TFL.slice(), tfTarget, "striped", true)!;
const TFL2 = TFL.slice();
for (const e of tf1.edits) TFL2[e.line] = e.text;
ok(TFL2[0].includes(`data-tbl="striped"`), "flag stored on the header cell");
eq(tableFlagsAt(TFL2, tfTarget).striped, true, "tableFlagsAt reads the override back");
const tf2 = planSetTableFlag(TFL2.slice(), tfTarget, "compact", false)!;
const TFL3 = TFL2.slice();
for (const e of tf2.edits) TFL3[e.line] = e.text;
ok(TFL3[0].includes(`data-tbl="striped,nocompact"`), "flags combine on one header cell");
const tf3 = planSetTableFlag(TFL3.slice(), tfTarget, "striped", null)!;
const TFL4 = TFL3.slice();
for (const e of tf3.edits) TFL4[e.line] = e.text;
ok(TFL4[0].includes(`data-tbl="nocompact"`) && !TFL4[0].includes("striped"), "clearing an override removes its token");
const tf4 = planSetTableFlag(TFL4.slice(), tfTarget, "compact", null)!;
const TFL5 = TFL4.slice();
for (const e of tf4.edits) TFL5[e.line] = e.text;
ok(!TFL5[0].includes("data-tbl") && !TFL5[0].includes("<span"), "last override cleared removes the wrapper entirely");
// flags survive a column move (the marker rides its header cell)
const TFC = ["| A | B |", "| - | - |", "| 1 | 2 |"];
const tfc = planSetTableFlag(TFC.slice(), { line: 2, col: 0, expect: null }, "compact", true)!;
const TFC2 = TFC.slice();
for (const e of tfc.edits) TFC2[e.line] = e.text;
const mvPlan = planMoveColumn(TFC2.slice(), { line: 2, col: 0, expect: null }, 1)!;
const TFC3 = TFC2.slice();
for (const e of mvPlan.edits) TFC3[e.line] = e.text;
eq(tableFlagsAt(TFC3, { line: 2, col: 0, expect: null }).compact, true, "flags survive a column move");
// colored header cell keeps its color when a flag lands on it
const TFX = ["| <span class=\"ptb\" style=\"background:#F6E8B9\">A</span> | B |", "| - | - |", "| 1 | 2 |"];
const tfx = planSetTableFlag(TFX.slice(), tfTarget, "guides", false)!;
const TFX2 = TFX.slice();
for (const e of tfx.edits) TFX2[e.line] = e.text;
ok(TFX2[0].includes("background:#F6E8B9") && TFX2[0].includes(`data-tbl="noguides"`), "flag coexists with header colors");

// --- selection stats ---
const SST = ["| A |", "| - |", "| $10.50 |", "| $4.50 |", "| text |"];
const sst = selectionStats(SST, [{ line: 2, col: 0 }, { line: 3, col: 0 }, { line: 4, col: 0 }])!;
eq(sst.count, 2, "stats count numeric cells only");
eq(sst.sum, "$15.00", "stats sum keeps currency");
eq(sst.avg, "$7.50", "stats average");
ok(selectionStats(SST, [{ line: 2, col: 0 }]) === null, "fewer than two numbers means no chip");
// --- text highlight (ptb-hl) ---
eq(
	buildCellContent("x", "#BEE9CF", null, null, null, null, null, true),
	`<span class="ptb ptb-hl" style="background:#BEE9CF">x</span>`,
	"highlight builds marker class"
);
const phl = parseCellContent(`<span class="ptb ptb-hl" style="background:#BEE9CF">hi</span>`);
ok(phl.hl && phl.bg === "#BEE9CF", "highlight parses");
const HLT = ["| A |", "| - |", "| v |"];
let hp = planEdits(HLT.slice(), { line: 2, col: 0, expect: null }, { bg: "#BEE9CF", hl: true }, "cell")!;
ok(hp.edits[0].text.includes(`class="ptb ptb-hl"`), "highlight patch marks span");
const HLT2 = HLT.slice();
HLT2[2] = hp.edits[0].text;
hp = planEdits(HLT2.slice(), { line: 2, col: 0, expect: null }, { fg: "#B42318" }, "cell")!;
ok(hp.edits[0].text.includes("ptb-hl"), "text-color patch keeps highlight");
hp = planEdits(HLT2.slice(), { line: 2, col: 0, expect: null }, { bg: "#FDF3D7" }, "cell")!;
ok(!hp.edits[0].text.includes("ptb-hl"), "plain fill patch clears highlight");
hp = planEdits(HLT2.slice(), { line: 2, col: 0, expect: null }, { bg: null }, "cell")!;
ok(!hp.edits[0].text.includes("ptb-hl"), "clearing bg clears highlight");

// --- checkboxes ---
const CHK = ["| Task |", "| - |", "| Buy milk |"];
let chk = planToggleCheckbox(CHK.slice(), { line: 2, col: 0, expect: null }, "cell")!;
eq(chk.edits[0].text, "| [ ] Buy milk |", "checkbox added");
const CHK2 = CHK.slice();
CHK2[2] = chk.edits[0].text;
chk = planSetChecked(CHK2.slice(), { line: 2, col: 0, expect: null }, true)!;
eq(chk.edits[0].text, "| [x] Buy milk |", "checkbox ticks");
chk = planSetChecked(CHK2.slice(), { line: 2, col: 0, expect: null }, false)!;
eq(chk.edits.length, 0, "unticking an unticked box is a no-op");
const CHK3 = CHK.slice();
CHK3[2] = "| [x] Buy milk |";
chk = planToggleCheckbox(CHK3.slice(), { line: 2, col: 0, expect: null }, "cell")!;
eq(chk.edits[0].text, "| Buy milk |", "checkbox removed");
const CHK4 = ["| Task |", "| - |", `| <span class="ptb" style="background:#F00">[ ] paint</span> |`];
chk = planSetChecked(CHK4.slice(), { line: 2, col: 0, expect: null }, true)!;
ok(chk.edits[0].text.includes(`>[x] paint</span>`), "checkbox state changes inside colored span");
eq(normalizeText("[x] Buy milk"), "Buy milk", "normalizeText drops checkbox marker");

// --- column width ---
const CW = ["| A | B |", "| - | - |", "| 1 | 2 |"];
let wp = planSetColumnWidth(CW.slice(), { line: 2, col: 1, expect: null }, 220)!;
ok(wp.edits[0].line === 0 && wp.edits[0].text.includes(`data-w="220"`), "width stored on the header cell");
const CW2 = CW.slice();
CW2[0] = wp.edits[0].text;
eq(parseCellContent(parseRow(CW2[0])!.pieces[2]).w, "220", "width parses back");
wp = planSetColumnWidth(CW2.slice(), { line: 2, col: 1, expect: null }, null)!;
eq(wp.edits[0].text, "| A | B |", "width cleared restores plain header");
wp = planSetColumnWidth(CW.slice(), { line: 2, col: 0, expect: null }, 10)!;
ok(wp.edits[0].text.includes(`data-w="48"`), "width clamps to a sane minimum");

// --- auto-fit column widths ---
const AF = ["| A | B | C |", "| - | - | - |", "| 1 | 2 | 3 |"];
const afp = planAutoFitColumnWidths(AF.slice(), { line: 2, col: 0, expect: null }, [120, 30, 1500])!;
eq(afp.edits.length, 1, "auto-fit rewrites only the header line");
eq(afp.edits[0].line, 0, "auto-fit targets the header row");
const afr = parseRow(afp.edits[0].text)!;
eq(parseCellContent(afr.pieces[1]).w, "120", "auto-fit stores each measured width");
eq(parseCellContent(afr.pieces[2]).w, "48", "auto-fit clamps tiny widths up to the minimum");
eq(parseCellContent(afr.pieces[3]).w, "1200", "auto-fit clamps huge widths down to the maximum");
eq(afp.cursorLine, 2, "auto-fit keeps the cursor on the starting line");
const AF2 = AF.slice();
AF2[0] = '| <span class="ptb" style="background:#EFEAFC" data-w="90">A</span> | B | C |';
const afp2 = planAutoFitColumnWidths(AF2.slice(), { line: 2, col: 1, expect: null }, [200, null, 150, 500])!;
const afr2 = parseRow(afp2.edits[0].text)!;
eq(parseCellContent(afr2.pieces[1]).w, "200", "auto-fit overwrites an existing stored width");
eq(parseCellContent(afr2.pieces[1]).bg, "#EFEAFC", "auto-fit keeps the header cell's color");
eq(parseCellContent(afr2.pieces[2]).w, null, "a null width leaves that column untouched");
eq(parseCellContent(afr2.pieces[3]).w, "150", "widths map to columns by index; extras are ignored");
const afp3 = planAutoFitColumnWidths(AF2.slice(), { line: 2, col: 0, expect: null }, [90, null, null])!;
eq(afp3.edits.length, 0, "widths that match what's stored are a no-op");
ok(
	planAutoFitColumnWidths(AF.slice(), { line: 2, col: 0, expect: null }, [null, null, null]) === null,
	"no usable widths yields no plan"
);

// --- mergeForSave: data.json is synced, so a save must not clobber a device ---
// eq() here compares with ===, so objects are compared as JSON.
{
	// A device holding an old snapshot changes one thing. Its save must not carry
	// the rest of that snapshot over what another device set since.
	const idleBaseline = { palette: [] as string[], lastUsed: "old" };
	const idleMemory = { palette: [] as string[], lastUsed: "new" };
	const disk = { palette: ["#fff", "#000"], lastUsed: "old" };
	eq(
		JSON.stringify(mergeForSave(idleMemory, idleBaseline, disk)),
		JSON.stringify({ palette: ["#fff", "#000"], lastUsed: "new" }),
		"an idle device keeps another device's setting and carries only its own change"
	);
}
eq(JSON.stringify(mergeForSave({ k: "new" }, { k: "old" }, { k: "other" })), JSON.stringify({ k: "new" }), "our own change still wins over disk");
eq(JSON.stringify(mergeForSave({ k: "" }, { k: "had" }, { k: "had" })), JSON.stringify({ k: "" }), "clearing on purpose is a change and sticks");
eq(
	JSON.stringify(mergeForSave({ k: "ours", n: 1 }, { k: "ours", n: 1 }, { n: 2 } as { k?: string; n?: number })),
	JSON.stringify({ k: "ours", n: 2 }),
	"a key absent from disk keeps ours"
);
eq(JSON.stringify(mergeForSave({ k: 1 }, { k: 1 }, null)), JSON.stringify({ k: 1 }), "no disk state yet = write ours");

{
	// A key holding one value per item is a whole vault's worth of settings behind
	// a single name. Changing ONE of them used to publish ALL of them, erasing
	// every item another device had configured since this one last read.
	type M = { map: Record<string, number[]> };
	const baseline: M = { map: { A: [1] } };
	const ours: M = { map: { A: [2] } };
	const disk: M = { map: { A: [1], B: [9] } };
	eq(JSON.stringify(mergeForSave(ours, baseline, disk)), JSON.stringify({ map: { A: [2], B: [9] } }), "one entry's change publishes that entry, not the whole map");
	eq(JSON.stringify(mergeForSave({ map: { A: [1] } } as M, { map: { A: [1], B: [9] } } as M, { map: { A: [1], B: [9] } } as M)), JSON.stringify({ map: { A: [1] } }), "an entry we removed stays removed");
	eq(JSON.stringify(mergeForSave({ map: { A: [1] } } as M, { map: { A: [1] } } as M, { map: { A: [7] } } as M)), JSON.stringify({ map: { A: [7] } }), "an entry we did not touch takes the disk's");
	eq(JSON.stringify(mergeForSave({ list: ["a"] }, { list: ["a", "b"] }, { list: ["a", "b"] })), JSON.stringify({ list: ["a"] }), "an array is a value, still merged whole");
}

if (failures) {
	console.error(failures + " failure(s)");
	process.exit(1);
}
console.log("All tests passed.");


// --- the deploy guard ---
// Two sessions building this plugin at once is enough for the second to
// overwrite the first with an older build, silently. The comparison is where a
// bug would disable the guard without failing anything, so it is pinned here.
{
	const { compareVersions, isDowngrade, versionFromManifest } = require("../deploy-guard.mjs");

	eq(compareVersions("1.89.1", "1.89.0") > 0, true, "a later patch sorts after");
	eq(compareVersions("1.89.0", "1.89.1") < 0, true, "and an earlier one before");
	eq(compareVersions("1.89.1", "1.89.1"), 0, "the same version ties");
	// the whole reason this compares numbers: as strings, "1.9.0" sorts after
	// "1.10.0", which is exactly backwards
	eq(compareVersions("1.10.0", "1.9.0") > 0, true, "10 is a later minor than 9, not an earlier one");
	eq(compareVersions("1.88.10", "1.88.9") > 0, true, "and the same holds for the patch");
	eq(compareVersions("2.0.0", "1.99.99") > 0, true, "a major bump outranks everything under it");
	eq(compareVersions("1.89", "1.89.0"), 0, "a missing part counts as zero");
	eq(compareVersions("", ""), 0, "two unreadable versions tie rather than throwing");

	eq(isDowngrade("1.89.1", "1.88.1"), true, "deploying an older build over a newer one is the collision this catches");
	eq(isDowngrade("1.88.1", "1.89.1"), false, "the ordinary direction is not");
	eq(isDowngrade("1.89.1", "1.89.1"), false, "and neither is redeploying the same version, which is what developing looks like");
	eq(isDowngrade(null, "1.89.1"), false, "a vault with nothing installed has nothing to lose");
	eq(isDowngrade("", "1.89.1"), false, "nor one whose version could not be read");

	eq(versionFromManifest("{ not json"), null, "a manifest too broken to parse names no version");
	eq(versionFromManifest("{}"), null, "and neither does one with no version key");
	eq(versionFromManifest('{"version":"1.2.3"}'), "1.2.3", "otherwise the version is read off it");
	eq(versionFromManifest('{"version":"  "}'), null, "a blank version is no version");
}
