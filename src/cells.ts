/**
 * Pure Markdown-table cell logic: no Obsidian imports so it can run under Node for tests.
 *
 * Colors are stored inside the cell as a single inline span:
 *   | Queen | <span class="ptb ptb-fill" style="background-color:#00FF00;">$19.60</span> |
 * which keeps the table 100% valid Markdown and degrades to a text highlight
 * if the plugin is ever removed.
 */

export type Scope = "cell" | "row" | "column" | "table";

export interface Patch {
	/** undefined = leave unchanged, null = clear, string = set */
	bg?: string | null;
	fg?: string | null;
	/** with a string bg: true = highlight just the text, false/absent = fill the cell */
	hl?: boolean;
}

export interface CellTargetLoc {
	line: number;
	col: number;
	/**
	 * Rendered text of the clicked cell (Reading view targets). Used to re-locate
	 * the row if lines shifted since render. null = trust `line` (cursor-derived).
	 */
	expect: string | null;
}

export interface ParsedRow {
	prefix: string;
	/** Segments split on unescaped "|": [before-first-pipe, cell0, cell1, ..., after-last-pipe?] */
	pieces: string[];
	hasTrail: boolean;
	isDelim: boolean;
	cellCount: number;
	/** Raw-line index of every unescaped pipe */
	pipeRawPos: number[];
}

export function parseRow(raw: string): ParsedRow | null {
	const m = raw.match(/^(\s*(?:>\s*)*)([\s\S]*)$/);
	if (!m) return null;
	const prefix = m[1];
	const body = m[2];
	if (!body.startsWith("|")) return null;
	const pieces: string[] = [];
	const pipeRawPos: number[] = [];
	let cur = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "\\") {
			cur += ch;
			if (i + 1 < body.length) {
				cur += body[i + 1];
				i++;
			}
			continue;
		}
		if (ch === "|") {
			pieces.push(cur);
			pipeRawPos.push(prefix.length + i);
			cur = "";
			continue;
		}
		cur += ch;
	}
	pieces.push(cur);
	if (pieces.length < 2) return null;
	const hasTrail = pieces[pieces.length - 1].trim() === "";
	const cellCount = pieces.length - 1 - (hasTrail ? 1 : 0);
	if (cellCount < 1) return null;
	const cells = pieces.slice(1, 1 + cellCount);
	const isDelim = cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
	return { prefix, pieces, hasTrail, isDelim, cellCount, pipeRawPos };
}

/** Which cell (0-based) contains character offset `ch` of the raw line. */
export function colFromCh(row: ParsedRow, ch: number): number {
	let n = 0;
	for (const p of row.pipeRawPos) if (p < ch) n++;
	return Math.max(0, Math.min(row.cellCount - 1, n - 1));
}

const SPAN_RE = /^\s*<span class="(ptb[^"]*)"((?:\s+(?:style|data-sum|data-calc|data-f|data-b|data-fmt|data-w|data-rule|data-tbl)="[^"]*")*)\s*>([\s\S]*)<\/span>\s*$/;

export type SumDir = "column" | "row";
export type CalcFn = "sum" | "avg" | "min" | "max" | "count";
export interface CalcSpec {
	fn: CalcFn;
	dir: SumDir;
}

export function parseCellContent(raw: string): {
	bg: string | null;
	fg: string | null;
	calc: CalcSpec | null;
	formula: string | null;
	borders: string | null;
	fmt: string | null;
	hl: boolean;
	w: string | null;
	rule: string | null;
	tbl: string | null;
	inner: string;
} {
	const m = raw.match(SPAN_RE);
	if (!m) {
		return {
			bg: null,
			fg: null,
			calc: null,
			formula: null,
			borders: null,
			fmt: null,
			hl: false,
			w: null,
			rule: null,
			tbl: null,
			inner: raw.trim(),
		};
	}
	const cls = m[1];
	const attrs = m[2] ?? "";
	const style = attrs.match(/style="([^"]*)"/)?.[1] ?? "";
	const bg = style.match(/background(?:-color)?:\s*([^;]+)/)?.[1]?.trim() ?? null;
	const fg = style.match(/(?:^|;)\s*color:\s*([^;]+)/)?.[1]?.trim() ?? null;
	// data-calc="fn:col|row" is the current marker; data-sum="column|row" is
	// the pre-1.5 sum-only form and stays readable forever.
	const calcM = attrs.match(/data-calc="(sum|avg|min|max|count):(col|row)"/);
	const sumM = attrs.match(/data-sum="(column|row)"/);
	const calc: CalcSpec | null = calcM
		? { fn: calcM[1] as CalcFn, dir: calcM[2] === "col" ? "column" : "row" }
		: sumM
			? { fn: "sum", dir: sumM[1] as SumDir }
			: null;
	const formula = attrs.match(/data-f="([^"]*)"/)?.[1] ?? null;
	const borders = attrs.match(/data-b="([^"]*)"/)?.[1] || null;
	const fmt = attrs.match(/data-fmt="([^"]*)"/)?.[1] || null;
	const hl = /\bptb-hl\b/.test(cls);
	const w = attrs.match(/data-w="(\d{2,4})"/)?.[1] ?? null;
	const rule = attrs.match(/data-rule="([^"]*)"/)?.[1] || null;
	const tbl = attrs.match(/data-tbl="([^"]*)"/)?.[1] || null;
	return { bg, fg, calc, formula, borders, fmt, hl, w, rule, tbl, inner: m[3] };
}

/** Compress #RRGGBB to #RGB when possible; leave anything else untouched. */
function shortHex(c: string): string {
	const m = c.trim().match(/^#([0-9a-fA-F]{6})$/);
	if (!m) return c.trim();
	const h = m[1];
	if (h[0] === h[1] && h[2] === h[3] && h[4] === h[5]) return ("#" + h[0] + h[2] + h[4]).toUpperCase();
	return c.trim();
}

export function buildCellContent(
	inner: string,
	bg: string | null,
	fg: string | null,
	calc: CalcSpec | null = null,
	formula: string | null = null,
	borders: string | null = null,
	fmt: string | null = null,
	hl = false,
	w: string | null = null,
	rule: string | null = null,
	tbl: string | null = null
): string {
	const b = borders ? borders.replace(/[^tblrTBLR]/g, "") : "";
	const width = w && /^\d{2,4}$/.test(w) ? w : null;
	if (!bg && !fg && !calc && !formula && !b && !fmt && !width && !rule && !tbl) return inner;
	// Keep the wrapper as short as possible, it is what users see as raw
	// markup when a cell is edited in Source mode. parseCellContent still
	// reads the older, longer formats (class="ptb ptb-sum ptb-fill",
	// background-color:, data-sum=) so existing notes upgrade on touch.
	// hl marks a text-highlight: the background stays on the text instead of
	// being lifted onto the whole cell.
	let attrs = `class="ptb${hl && bg ? " ptb-hl" : ""}"`;
	if (calc) attrs += ` data-calc="${calc.fn}:${calc.dir === "column" ? "col" : "row"}"`;
	if (formula) attrs += ` data-f="${formula.replace(/"/g, "'")}"`;
	if (b) attrs += ` data-b="${b}"`;
	if (fmt) attrs += ` data-fmt="${fmt.replace(/"/g, "")}"`;
	if (width) attrs += ` data-w="${width}"`;
	if (rule) attrs += ` data-rule="${rule.replace(/"/g, "")}"`;
	if (tbl) attrs += ` data-tbl="${tbl.replace(/"/g, "")}"`;
	let style = "";
	if (bg) style += `background:${shortHex(bg)};`;
	if (fg) style += `color:${shortHex(fg)};`;
	if (style) attrs += ` style="${style.slice(0, -1)}"`;
	return `<span ${attrs}>${inner}</span>`;
}

/** Colors travel inside a style="" attribute, strip anything that could break out of it. */
export function sanitizeColor(c: string): string {
	return c.replace(/[^#a-zA-Z0-9(),.%\s-]/g, "").trim();
}

/** Approximate a cell's rendered text from its Markdown source, for matching against td.textContent. */
export function normalizeText(s: string): string {
	return s
		.replace(/<[^>]*>/g, "")
		.replace(/^\s*\[( |x|X)\]\s*/, "")
		.replace(/!?\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
		.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
		.replace(/\\([\\|*_~`])/g, "$1")
		.replace(/[*_~=`$]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Find the file line holding the target cell. Reading-view targets carry the cell's
 * rendered text; if the remembered line no longer matches (note edited since render),
 * search nearby lines, then the whole file, for the row whose cell text matches.
 */
export function locateLine(lines: string[], t: CellTargetLoc): number | null {
	const rowAt = (i: number): ParsedRow | null => {
		if (i < 0 || i >= lines.length) return null;
		const r = parseRow(lines[i]);
		return r && !r.isDelim ? r : null;
	};
	const exact = rowAt(t.line);
	if (t.expect == null) return exact ? t.line : null;
	const want = normalizeText(t.expect);
	if (want) {
		for (const d of [0, -1, 1, -2, 2, -3, 3]) {
			const i = t.line + d;
			const r = rowAt(i);
			if (!r || t.col >= r.cellCount) continue;
			if (normalizeText(r.pieces[t.col + 1]) === want) return i;
		}
		const hits: number[] = [];
		for (let i = 0; i < lines.length; i++) {
			const r = rowAt(i);
			if (!r || t.col >= r.cellCount) continue;
			if (normalizeText(r.pieces[t.col + 1]) === want) hits.push(i);
		}
		if (hits.length > 1) hits.sort((a, b) => Math.abs(a - t.line) - Math.abs(b - t.line));
		if (hits.length) return hits[0];
	}
	return exact && t.col < exact.cellCount ? t.line : null;
}

export type EditKind = "replace" | "insert" | "delete";

export interface EditPlan {
	/** kind defaults to "replace"; "insert" inserts text before `line`; "delete" removes `line`. */
	edits: { line: number; text: string; kind?: EditKind }[];
	cursorLine: number;
	cursorCh: number;
}

export function planEdits(lines: string[], target: CellTargetLoc, patch: Patch, scope: Scope): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	let lineNos: number[] = [ln];
	if (scope === "column" || scope === "table") {
		let start = ln;
		let end = ln;
		while (start > 0 && parseRow(lines[start - 1])) start--;
		while (end < lines.length - 1 && parseRow(lines[end + 1])) end++;
		lineNos = [];
		for (let i = start; i <= end; i++) lineNos.push(i);
	}
	const edits: { line: number; text: string }[] = [];
	for (const li of lineNos) {
		const r = parseRow(lines[li]);
		if (!r || r.isDelim) continue;
		const cols =
			scope === "row" || scope === "table"
				? Array.from({ length: r.cellCount }, (_, i) => i)
				: target.col < r.cellCount
					? [target.col]
					: [];
		let changed = false;
		for (const c of cols) {
			const old = r.pieces[c + 1];
			const parsed = parseCellContent(old);
			const nbg = patch.bg === undefined ? parsed.bg : patch.bg;
			const nfg = patch.fg === undefined ? parsed.fg : patch.fg;
			// highlight flag: text-color-only patches keep it; setting a fill
			// takes the patch's mode (default: whole-cell); clearing bg drops it
			const nhl = patch.bg === undefined ? parsed.hl : patch.bg ? (patch.hl ?? false) : false;
			const next = ` ${buildCellContent(parsed.inner, nbg, nfg, parsed.calc, parsed.formula, parsed.borders, parsed.fmt, nhl, parsed.w, parsed.rule, parsed.tbl)} `;
			if (next !== old) {
				r.pieces[c + 1] = next;
				changed = true;
			}
		}
		if (changed) edits.push({ line: li, text: r.prefix + r.pieces.join("|") });
	}
	// Cursor lands at the start of the target cell's content so repeated
	// toolbar clicks keep hitting the same cell.
	const lnText = edits.find((e) => e.line === ln)?.text ?? lines[ln];
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lnText, target.col) };
}

export function cursorForCol(lineText: string, col: number): number {
	const rr = parseRow(lineText);
	if (!rr) return 0;
	const cIdx = Math.min(col, rr.cellCount - 1);
	let off = rr.prefix.length;
	for (let k = 0; k <= cIdx; k++) off += rr.pieces[k].length + 1;
	const piece = rr.pieces[cIdx + 1];
	const im = piece.match(/^\s*<span[^>]*>/);
	return off + (im ? im[0].length : piece.length - piece.trimStart().length);
}

/**
 * Parse a cell's text as a number. Accepts $/€/£/¥ prefixes, thousands commas,
 * leading minus, and accounting-style (parens) negatives. Rejects anything with
 * extra text so "39 nights" never gets summed.
 */
export function parseNumeric(raw: string): { value: number; decimals: number; currency: string } | null {
	let s = raw
		.replace(/<[^>]*>/g, "")
		.replace(/[*_~=`]/g, "")
		.trim();
	if (!s) return null;
	let neg = false;
	if (/^\(.*\)$/.test(s)) {
		neg = true;
		s = s.slice(1, -1).trim();
	}
	if (s.startsWith("-")) {
		neg = !neg;
		s = s.slice(1).trim();
	}
	let currency = "";
	const cm = s.match(/^(\p{Sc}{1,3})\s*/u);
	if (cm) {
		currency = cm[1];
		s = s.slice(cm[0].length);
	}
	if (s.startsWith("-")) {
		neg = !neg;
		s = s.slice(1).trim();
	}
	let pct = false;
	if (s.endsWith("%")) {
		pct = true;
		s = s.slice(0, -1).trim();
	}
	s = s.replace(/,/g, "");
	if (!/^\d+(\.\d+)?$/.test(s)) return null;
	let decimals = s.includes(".") ? s.split(".")[1].length : 0;
	let value = parseFloat(s);
	if (pct) {
		value = value / 100;
		decimals += 2;
	}
	if (neg) value = -value;
	return { value, decimals, currency };
}

/**
 * Aggregate the numeric cells in the column (all body rows except line `ln`
 * and the header), or, direction "row", the other cells of row `ln`.
 * Output style follows the inputs: max decimal places, shared currency symbol
 * (count is always a bare integer).
 */
export function computeCalc(
	lines: string[],
	ln: number,
	col: number,
	spec: CalcSpec
): { count: number; formatted: string } {
	const rowLn = parseRow(lines[ln]);
	if (!rowLn || rowLn.isDelim) return { count: 0, formatted: "" };

	const nums: { value: number; decimals: number; currency: string }[] = [];
	if (spec.dir === "row") {
		for (let c = 0; c < rowLn.cellCount; c++) {
			if (c === col) continue;
			const n = parseNumeric(parseCellContent(rowLn.pieces[c + 1]).inner);
			if (n) nums.push(n);
		}
	} else {
		let start = ln;
		let end = ln;
		while (start > 0 && parseRow(lines[start - 1])) start--;
		while (end < lines.length - 1 && parseRow(lines[end + 1])) end++;
		let delimIdx = -1;
		for (let i = start; i <= end; i++) {
			const r = parseRow(lines[i]);
			if (r?.isDelim) {
				delimIdx = i;
				break;
			}
		}
		for (let i = start; i <= end; i++) {
			if (i === ln || i <= delimIdx) continue;
			const r = parseRow(lines[i]);
			if (!r || r.isDelim || col >= r.cellCount) continue;
			const n = parseNumeric(parseCellContent(r.pieces[col + 1]).inner);
			if (n) nums.push(n);
		}
	}

	if (!nums.length) return { count: 0, formatted: "" };

	let decimals = 0;
	for (const n of nums) decimals = Math.max(decimals, n.decimals);
	decimals = Math.min(decimals, 4);
	const currency = nums.every((n) => n.currency && n.currency === nums[0].currency) ? nums[0].currency : "";
	const fmt = (v: number, dec: number) => (v < 0 ? "-" : "") + currency + Math.abs(v).toFixed(dec);
	const values = nums.map((n) => n.value);
	const total = values.reduce((a, v) => a + v, 0);

	let formatted: string;
	switch (spec.fn) {
		case "count":
			formatted = String(nums.length);
			break;
		case "avg":
			formatted = fmt(total / nums.length, Math.max(decimals, 2));
			break;
		case "min":
			formatted = fmt(Math.min(...values), decimals);
			break;
		case "max":
			formatted = fmt(Math.max(...values), decimals);
			break;
		default:
			formatted = fmt(total, decimals);
	}
	return { count: nums.length, formatted };
}

export interface CalcTogglePlan extends EditPlan {
	count: number;
	formatted: string;
	toggledOff: boolean;
	switched: boolean;
}

/**
 * Toggle a live calculation on the target cell. Unmarked cell: compute and
 * write the value wrapped in a data-calc marker span (recalcCalcs keeps it
 * fresh). Marked with the SAME fn+dir: remove the marker, freezing the value
 * as plain text. Marked with a different fn/dir: switch to the new one.
 * Colors on the cell are preserved in every case.
 */
export function planToggleCalc(lines: string[], target: CellTargetLoc, spec: CalcSpec): CalcTogglePlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const rowLn = parseRow(lines[ln]);
	if (!rowLn || rowLn.isDelim) return null;
	const col = Math.min(target.col, rowLn.cellCount - 1);
	const parsed = parseCellContent(rowLn.pieces[col + 1]);

	if (parsed.calc && parsed.calc.fn === spec.fn && parsed.calc.dir === spec.dir) {
		rowLn.pieces[col + 1] = ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, null, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
		const text = rowLn.prefix + rowLn.pieces.join("|");
		return {
			edits: [{ line: ln, text }],
			cursorLine: ln,
			cursorCh: cursorForCol(text, col),
			count: -1,
			formatted: parsed.inner,
			toggledOff: true,
			switched: false,
		};
	}

	const res = computeCalc(lines, ln, col, spec);
	if (!res.count) {
		return { edits: [], cursorLine: ln, cursorCh: 0, count: 0, formatted: "", toggledOff: false, switched: false };
	}
	rowLn.pieces[col + 1] = ` ${buildCellContent(res.formatted, parsed.bg, parsed.fg, spec, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
	const text = rowLn.prefix + rowLn.pieces.join("|");
	return {
		edits: [{ line: ln, text }],
		cursorLine: ln,
		cursorCh: cursorForCol(text, col),
		count: res.count,
		formatted: res.formatted,
		toggledOff: false,
		switched: parsed.calc != null,
	};
}

/** Remove a live-calc marker from the target cell, keeping value and colors. */
export function planFreezeCalc(lines: string[], target: CellTargetLoc): CalcTogglePlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const rowLn = parseRow(lines[ln]);
	if (!rowLn || rowLn.isDelim) return null;
	const col = Math.min(target.col, rowLn.cellCount - 1);
	const parsed = parseCellContent(rowLn.pieces[col + 1]);
	if (!parsed.calc) {
		return { edits: [], cursorLine: ln, cursorCh: 0, count: 0, formatted: "", toggledOff: false, switched: false };
	}
	rowLn.pieces[col + 1] = ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, null, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
	const text = rowLn.prefix + rowLn.pieces.join("|");
	return {
		edits: [{ line: ln, text }],
		cursorLine: ln,
		cursorCh: cursorForCol(text, col),
		count: -1,
		formatted: parsed.inner,
		toggledOff: true,
		switched: false,
	};
}

/**
 * Recompute every data-sum-marked cell in the document and return the lines
 * whose text actually changed. Iterates to a fixpoint (sums that feed other
 * sums, e.g. row totals feeding a grand total, settle in a pass per level);
 * capped at 5 passes so pathological circular layouts can't loop forever.
 */
/** The format governing a live cell: its own tag, else its row's, else its column's. */
function stickySpecAt(lines: string[], ln: number, col: number, ownTag: string | null): FmtSpec | null {
	if (ownTag && !ownTag.startsWith("row:")) {
		const s = fmtFromTag(ownTag);
		if (s) return s;
	}
	const r = parseRow(lines[ln]);
	if (r) {
		for (let c = 0; c < r.cellCount; c++) {
			const f = parseCellContent(r.pieces[c + 1]).fmt;
			if (f?.startsWith("row:")) {
				const s = fmtFromTag(f.slice(4));
				if (s) return s;
			}
		}
	}
	const { start, delimIdx } = tableBounds(lines, ln);
	if (delimIdx < 0 || ln <= delimIdx) return null;
	const hr = parseRow(lines[start]);
	if (hr && !hr.isDelim && col < hr.cellCount) {
		const f = parseCellContent(hr.pieces[col + 1]).fmt;
		if (f && !f.startsWith("row:")) return fmtFromTag(f);
	}
	return null;
}

/** Render a live cell's computed value through its format tag, if any. */
function styleLiveValue(
	lines: string[],
	ln: number,
	col: number,
	parsed: ReturnType<typeof parseCellContent>,
	value: string
): { text: string; fg: string | null } {
	const spec = stickySpecAt(lines, ln, col, parsed.fmt);
	let fg = parsed.fg;
	if (!spec || spec.kind === "date" || spec.kind === "time") return { text: value, fg };
	const n = parseNumeric(value);
	if (!n) return { text: value, fg };
	const red = n.value < 0 && (spec.negative === "red" || spec.negative === "redparen");
	if (red) fg = NEG_RED;
	else if ((fg ?? "").toUpperCase() === NEG_RED) fg = null;
	return { text: formatBySpec(n.value, spec), fg };
}

export function recalcCalcs(lines: string[]): { line: number; text: string }[] {
	const work = lines.slice();
	const touched = new Set<number>();
	for (let pass = 0; pass < 5; pass++) {
		let dirty = false;
		for (let i = 0; i < work.length; i++) {
			const quick =
				work[i].includes('data-sum="') ||
				work[i].includes('data-calc="') ||
				work[i].includes('data-f="') ||
				work[i].includes("=");
			if (!quick) continue;
			const r = parseRow(work[i]);
			if (!r || r.isDelim) continue;
			let lineChanged = false;
			let grid: { rows: string[][]; bodyStart: number } | null | undefined;
			for (let c = 0; c < r.cellCount; c++) {
				const parsed = parseCellContent(r.pieces[c + 1]);
				if (parsed.calc) {
					const res = computeCalc(work, i, c, parsed.calc);
					if (!res.count) continue;
					const st = styleLiveValue(work, i, c, parsed, res.formatted);
					// recompute the value but keep whole-value bold/italic/strike
					const em = splitEmphasis(parsed.inner);
					const wrapped = em.lead + st.text + em.trail;
					if (wrapped === parsed.inner && st.fg === parsed.fg) continue;
					r.pieces[c + 1] = ` ${buildCellContent(wrapped, parsed.bg, st.fg, parsed.calc, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
					lineChanged = true;
					continue;
				}
				// live formula cells recompute; plain "=…" cells convert into them
				const formula = parsed.formula ?? (looksLikeFormula(parsed.inner) ? parsed.inner : null);
				if (!formula) continue;
				if (grid === undefined) grid = tableGrid(work, i);
				if (!grid) continue;
				let value = "#ERR";
				try {
					value = formatFormulaResult(evalFormula(formula, grid.rows, i - grid.bodyStart, c));
				} catch {
					value = "#ERR";
				}
				const st = styleLiveValue(work, i, c, parsed, value);
				const emf = splitEmphasis(parsed.formula ? parsed.inner : "");
				const wrappedF = emf.lead + st.text + emf.trail;
				if (parsed.formula && wrappedF === parsed.inner && st.fg === parsed.fg) continue;
				r.pieces[c + 1] = ` ${buildCellContent(wrappedF, parsed.bg, st.fg, null, formula, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
				lineChanged = true;
			}
			if (lineChanged) {
				work[i] = r.prefix + r.pieces.join("|");
				touched.add(i);
				dirty = true;
				grid = undefined;
			}
		}
		if (!dirty) break;
	}
	return [...touched]
		.map((line) => ({ line, text: work[line] }))
		.filter((e) => e.text !== lines[e.line]);
}

/* ---------------- sorting and reordering ---------------- */

const DATE_RE = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$|^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/**
 * Sort key for a cell: numbers (currency-aware) sort before dates (m/d/y or
 * ISO) before text; blanks always go last regardless of direction.
 */
export function sortKey(rawPiece: string): { rank: number; num: number; str: string } {
	const inner = normalizeText(parseCellContent(rawPiece).inner);
	if (!inner) return { rank: 3, num: 0, str: "" };
	const n = parseNumeric(inner);
	if (n) return { rank: 0, num: n.value, str: "" };
	const d = inner.match(DATE_RE);
	if (d) {
		const ts = d[4]
			? Date.UTC(+d[4], +d[5] - 1, +d[6])
			: Date.UTC(+(d[3].length === 2 ? "20" + d[3] : d[3]), +d[1] - 1, +d[2]);
		if (!isNaN(ts)) return { rank: 1, num: ts, str: "" };
	}
	return { rank: 2, num: 0, str: inner.toLowerCase() };
}

export interface SortPlan extends EditPlan {
	rows: number;
}

/**
 * Sort the table's body rows by the target's column. Whole lines move, so
 * colors and live-calc markers travel with their rows. Rows containing any
 * live-calc cell (totals) are pinned to the bottom in their original order;
 * rows whose key cell is blank sort to the end just above them.
 */
export function planSort(lines: string[], target: CellTargetLoc, dir: "asc" | "desc"): SortPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const anchor = parseRow(lines[ln]);
	if (!anchor) return null;
	const col = Math.min(target.col, anchor.cellCount - 1);
	let start = ln;
	let end = ln;
	while (start > 0 && parseRow(lines[start - 1])) start--;
	while (end < lines.length - 1 && parseRow(lines[end + 1])) end++;
	let delimIdx = -1;
	for (let i = start; i <= end; i++) {
		if (parseRow(lines[i])?.isDelim) {
			delimIdx = i;
			break;
		}
	}
	if (delimIdx < 0 || delimIdx >= end) return null;
	const bodyStart = delimIdx + 1;

	interface RowInfo {
		text: string;
		key: { rank: number; num: number; str: string };
		idx: number;
		pinned: boolean;
	}
	const rows: RowInfo[] = [];
	for (let i = bodyStart; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (!r || r.isDelim) return null;
		const pinned = r.pieces.slice(1, 1 + r.cellCount).some((p) => parseCellContent(p).calc != null);
		const piece = col < r.cellCount ? r.pieces[col + 1] : "";
		rows.push({ text: lines[i], key: sortKey(piece), idx: i, pinned });
	}

	const sign = dir === "asc" ? 1 : -1;
	const sortable = rows.filter((r) => !r.pinned);
	sortable.sort((a, b) => {
		const ka = a.key;
		const kb = b.key;
		if ((ka.rank === 3) !== (kb.rank === 3)) return ka.rank === 3 ? 1 : -1;
		let c = 0;
		if (ka.rank !== kb.rank) c = ka.rank - kb.rank;
		else if (ka.rank === 2) c = ka.str < kb.str ? -1 : ka.str > kb.str ? 1 : 0;
		else c = ka.num < kb.num ? -1 : ka.num > kb.num ? 1 : 0;
		if (c === 0) return a.idx - b.idx;
		return c * sign;
	});

	const newOrder = [...sortable, ...rows.filter((r) => r.pinned)];
	const edits: { line: number; text: string }[] = [];
	newOrder.forEach((r, k) => {
		const lineNo = bodyStart + k;
		if (lines[lineNo] !== r.text) edits.push({ line: lineNo, text: r.text });
	});
	const cursorLine = Math.min(Math.max(ln, bodyStart), end);
	return { edits, cursorLine, cursorCh: cursorForCol(lines[cursorLine], col), rows: sortable.length };
}

/** Swap the target's row with the one above/below (body rows only). */
export function planMoveRow(lines: string[], target: CellTargetLoc, delta: -1 | 1): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const r = parseRow(lines[ln]);
	if (!r || r.isDelim) return null;
	const col = Math.min(target.col, r.cellCount - 1);
	let start = ln;
	let end = ln;
	while (start > 0 && parseRow(lines[start - 1])) start--;
	while (end < lines.length - 1 && parseRow(lines[end + 1])) end++;
	let delimIdx = -1;
	for (let i = start; i <= end; i++) {
		if (parseRow(lines[i])?.isDelim) {
			delimIdx = i;
			break;
		}
	}
	const bodyStart = delimIdx >= 0 ? delimIdx + 1 : start + 1;
	const to = ln + delta;
	if (ln < bodyStart || to < bodyStart || to > end) {
		return { edits: [], cursorLine: ln, cursorCh: cursorForCol(lines[ln], col) };
	}
	const edits = [
		{ line: Math.min(ln, to), text: lines[Math.max(ln, to)] },
		{ line: Math.max(ln, to), text: lines[Math.min(ln, to)] },
	];
	return { edits, cursorLine: to, cursorCh: cursorForCol(lines[ln], col) };
}

/** Swap the target's column with its neighbor across every row, delimiter included (alignment travels). */
export function planMoveColumn(lines: string[], target: CellTargetLoc, delta: -1 | 1): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const anchor = parseRow(lines[ln]);
	if (!anchor) return null;
	const col = Math.min(target.col, anchor.cellCount - 1);
	const to = col + delta;
	if (to < 0 || to >= anchor.cellCount) {
		return { edits: [], cursorLine: ln, cursorCh: cursorForCol(lines[ln], col) };
	}
	let start = ln;
	let end = ln;
	while (start > 0 && parseRow(lines[start - 1])) start--;
	while (end < lines.length - 1 && parseRow(lines[end + 1])) end++;
	const edits: { line: number; text: string }[] = [];
	for (let i = start; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (!r || col >= r.cellCount || to >= r.cellCount) continue;
		const tmp = r.pieces[col + 1];
		r.pieces[col + 1] = r.pieces[to + 1];
		r.pieces[to + 1] = tmp;
		const text = r.prefix + r.pieces.join("|");
		if (text !== lines[i]) edits.push({ line: i, text });
	}
	const lnText = edits.find((e) => e.line === ln)?.text ?? lines[ln];
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lnText, to) };
}

/* ---------------- text styling, alignment, number formats ---------------- */

export type TextStyle = "bold" | "italic" | "strike";

function toggleMark(inner: string, style: TextStyle): string {
	if (!inner) return inner;
	if (style === "bold") {
		const m = inner.match(/^\*\*([\s\S]+)\*\*$/);
		return m ? m[1] : `**${inner}**`;
	}
	if (style === "strike") {
		const m = inner.match(/^~~([\s\S]+)~~$/);
		return m ? m[1] : `~~${inner}~~`;
	}
	// Matches *italic* but not **bold**: the inner text may not start or end
	// with a star. Written without lookbehind, which older mobile WebViews
	// reject at parse time (taking the whole bundle down, not just this line).
	const m = inner.match(/^\*([^*]|[^*][\s\S]*[^*])\*$/);
	return m ? m[1] : `*${inner}*`;
}

/** Toggle bold/italic/strike on the cell content (inside the color span if present). */
export function planTextStyle(lines: string[], target: CellTargetLoc, style: TextStyle, scope: Scope): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	let lineNos: number[] = [ln];
	if (scope === "column" || scope === "table") {
		let start = ln;
		let end = ln;
		while (start > 0 && parseRow(lines[start - 1])) start--;
		while (end < lines.length - 1 && parseRow(lines[end + 1])) end++;
		lineNos = [];
		for (let i = start; i <= end; i++) lineNos.push(i);
	}
	const edits: { line: number; text: string }[] = [];
	for (const li of lineNos) {
		const r = parseRow(lines[li]);
		if (!r || r.isDelim) continue;
		const cols =
			scope === "row" || scope === "table"
				? Array.from({ length: r.cellCount }, (_, i) => i)
				: target.col < r.cellCount
					? [target.col]
					: [];
		let changed = false;
		for (const c of cols) {
			const parsed = parseCellContent(r.pieces[c + 1]);
			if (!parsed.inner) continue;
			const next = ` ${buildCellContent(toggleMark(parsed.inner, style), parsed.bg, parsed.fg, parsed.calc, parsed.formula, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
			if (next !== r.pieces[c + 1]) {
				r.pieces[c + 1] = next;
				changed = true;
			}
		}
		if (changed) edits.push({ line: li, text: r.prefix + r.pieces.join("|") });
	}
	const lnText = edits.find((e) => e.line === ln)?.text ?? lines[ln];
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lnText, target.col) };
}

export type ColAlign = "left" | "center" | "right";

/** Set the markdown alignment (delimiter-row colons) for the target's column. */
export function planAlign(lines: string[], target: CellTargetLoc, align: ColAlign): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	let start = ln;
	let end = ln;
	while (start > 0 && parseRow(lines[start - 1])) start--;
	while (end < lines.length - 1 && parseRow(lines[end + 1])) end++;
	let delimIdx = -1;
	for (let i = start; i <= end; i++) {
		if (parseRow(lines[i])?.isDelim) {
			delimIdx = i;
			break;
		}
	}
	if (delimIdx < 0) return null;
	const r = parseRow(lines[delimIdx])!;
	const col = Math.min(target.col, r.cellCount - 1);
	r.pieces[col + 1] = align === "left" ? " :--- " : align === "center" ? " :---: " : " ---: ";
	const text = r.prefix + r.pieces.join("|");
	const edits = text === lines[delimIdx] ? [] : [{ line: delimIdx, text }];
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lines[ln], col) };
}

/** Map an absolute alignment onto the logical direction ("start"/"end") that
 *  Obsidian's Live Preview table widget expects, it resolves start/end against
 *  the table's text direction. */
export function alignToLogical(align: ColAlign, rtl: boolean): "start" | "center" | "end" {
	if (align === "center") return "center";
	return (align === "left") === rtl ? "end" : "start";
}

/** Length of the emphasis markers (**, ~~, *) fully wrapping the text, e.g.
 *  "**~~750~~**" → { lead: 4, trail: 4 }. Only whole-value wrappers count
 *  which is what the panel's B/I/S buttons write; partial emphasis inside the
 *  text is left alone. */
/** Split whole-value emphasis wrappers from the text: "**750**" → lead "**", core "750", trail "**". */
export function splitEmphasis(text: string): { lead: string; core: string; trail: string } {
	const { lead, trail } = emphasisWrap(text);
	return {
		lead: text.slice(0, lead),
		core: text.slice(lead, text.length - trail),
		trail: trail ? text.slice(-trail) : "",
	};
}

export function emphasisWrap(text: string): { lead: number; trail: number } {
	let lead = 0;
	let trail = 0;
	let inner = text;
	for (;;) {
		const m =
			inner.match(/^(\*\*)([\s\S]+)(\*\*)$/) ??
			inner.match(/^(~~)([\s\S]+)(~~)$/) ??
			inner.match(/^(\*)([^*]|[^*][\s\S]*[^*])(\*)$/); // no lookbehind: see parseEmphasis
		if (!m) break;
		lead += m[1].length;
		trail += m[3].length;
		inner = m[2];
	}
	return { lead, trail };
}

export type NumFmt = "auto" | "number" | "currency" | "percent" | "date";

/** Cell-tag equivalents of the quick format buttons, for live calc/formula cells. */
const QUICK_TAGS: Record<NumFmt, string | null> = {
	auto: null,
	number: "n:2:1:minus",
	currency: "c:$:2:minus",
	percent: "p:2",
	date: "d:mdy",
};

function formatValue(value: number, decimals: number, fmt: NumFmt): string {
	const sign = value < 0 ? "-" : "";
	const abs = Math.abs(value);
	switch (fmt) {
		case "number":
			return sign + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
		case "currency":
			return sign + "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
		case "percent":
			return sign + (abs * 100).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "%";
		default:
			return sign + String(abs);
	}
}

/**
 * One-shot number formatting: rewrites numeric cell values in the given
 * style (markdown stays the source of truth, there is no hidden format
 * flag). Non-numeric cells and live-calc cells are left alone.
 */
export function planFormatNumber(lines: string[], target: CellTargetLoc, fmt: NumFmt, scope: Scope): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	let lineNos: number[] = [ln];
	if (scope === "column" || scope === "table") {
		let start = ln;
		let end = ln;
		while (start > 0 && parseRow(lines[start - 1])) start--;
		while (end < lines.length - 1 && parseRow(lines[end + 1])) end++;
		lineNos = [];
		for (let i = start; i <= end; i++) lineNos.push(i);
	}
	const edits: { line: number; text: string }[] = [];
	for (const li of lineNos) {
		const r = parseRow(lines[li]);
		if (!r || r.isDelim) continue;
		const cols =
			scope === "row" || scope === "table"
				? Array.from({ length: r.cellCount }, (_, i) => i)
				: target.col < r.cellCount
					? [target.col]
					: [];
		let changed = false;
		for (const c of cols) {
			const parsed = parseCellContent(r.pieces[c + 1]);
			let next: string;
			if (parsed.calc || parsed.formula) {
				// live cells: store the quick format as a cell tag ("Auto" clears it)
				const tag = QUICK_TAGS[fmt];
				if ((parsed.fmt ?? null) === tag) continue;
				next = ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, parsed.calc, parsed.formula, parsed.borders, tag, parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
			} else if (fmt === "date") {
				const p = parseDateCell(parsed.inner.trim());
				if (!p) continue;
				next = ` ${buildCellContent(formatDateSpec(p, "mdy"), parsed.bg, parsed.fg, null, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
			} else {
				const n = parseNumeric(parsed.inner);
				if (!n) continue;
				next = ` ${buildCellContent(formatValue(n.value, n.decimals, fmt), parsed.bg, parsed.fg, null, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
			}
			if (next !== r.pieces[c + 1]) {
				r.pieces[c + 1] = next;
				changed = true;
			}
		}
		if (changed) edits.push({ line: li, text: r.prefix + r.pieces.join("|") });
	}
	const lnText = edits.find((e) => e.line === ln)?.text ?? lines[ln];
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lnText, target.col) };
}

/* ---------------- Format cells (Excel-lite: number/currency/percent/date/time) ---------------- */

export type NegStyle = "minus" | "red" | "paren" | "redparen";

export interface FmtSpec {
	kind: "number" | "currency" | "percent" | "date" | "time";
	decimals: number;
	thousands: boolean;
	negative: NegStyle;
	symbol: string;
	datePattern: DatePatternId;
	timePattern: TimePatternId;
}

/** The text color written for red negative styles (and cleared when leaving them). */
export const NEG_RED = "#F00";

function grouped(abs: number, decimals: number, thousands: boolean): string {
	return abs.toLocaleString("en-US", {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
		useGrouping: thousands,
	});
}

/** Format a numeric value per spec, text only; red negatives are the caller's color concern. */
export function formatBySpec(value: number, spec: FmtSpec): string {
	const neg = value < 0;
	const abs = Math.abs(value);
	const core =
		spec.kind === "percent"
			? grouped(abs * 100, spec.decimals, false) + "%"
			: spec.kind === "currency"
				? spec.symbol + grouped(abs, spec.decimals, true)
				: grouped(abs, spec.decimals, spec.thousands);
	if (!neg) return core;
	return spec.negative === "paren" || spec.negative === "redparen" ? `(${core})` : `-${core}`;
}

export interface DateParts {
	y: number;
	m: number;
	d: number;
}

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TEXT_DATE_RE = /^(?:[A-Za-z]+,\s+)?([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/;

/** Read a date cell: 3/14/2012, 3-14-12, 2012-03-14, "Mar 14, 2012", "Wednesday, March 14, 2012" … */
export function parseDateCell(raw: string): DateParts | null {
	const s = raw.trim();
	let p: DateParts | null = null;
	const m = s.match(DATE_RE);
	if (m) {
		p = m[4]
			? { y: +m[4], m: +m[5], d: +m[6] }
			: { y: m[3].length === 2 ? +("20" + m[3]) : +m[3], m: +m[1], d: +m[2] };
	} else {
		const t = s.match(TEXT_DATE_RE);
		if (t) {
			const mi = MONTH_NAMES.findIndex((n) => n.toLowerCase().startsWith(t[1].toLowerCase()));
			if (mi >= 0) p = { y: +t[3], m: mi + 1, d: +t[2] };
		}
	}
	if (!p || p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) return null;
	return p;
}

export const DATE_PATTERNS = ["mdy", "mdy2", "mdy0", "iso", "mon", "month", "wkd", "weekday"] as const;
export type DatePatternId = (typeof DATE_PATTERNS)[number];

const pad2 = (n: number) => String(n).padStart(2, "0");

export function formatDateSpec(p: DateParts, pattern: DatePatternId): string {
	const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
	switch (pattern) {
		case "mdy":
			return `${p.m}/${p.d}/${p.y}`;
		case "mdy2":
			return `${p.m}/${p.d}/${pad2(p.y % 100)}`;
		case "mdy0":
			return `${pad2(p.m)}/${pad2(p.d)}/${p.y}`;
		case "iso":
			return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
		case "mon":
			return `${MONTH_NAMES[p.m - 1].slice(0, 3)} ${p.d}, ${p.y}`;
		case "month":
			return `${MONTH_NAMES[p.m - 1]} ${p.d}, ${p.y}`;
		case "wkd":
			return `${WEEKDAY_NAMES[dow].slice(0, 3)}, ${MONTH_NAMES[p.m - 1].slice(0, 3)} ${p.d}, ${p.y}`;
		case "weekday":
			return `${WEEKDAY_NAMES[dow]}, ${MONTH_NAMES[p.m - 1]} ${p.d}, ${p.y}`;
	}
}

export interface TimeParts {
	h: number;
	min: number;
	s: number | null;
}

const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/;

/** Read a time cell: 1:30 PM, 13:30, 1:30:55 pm, 13:30:55 … */
export function parseTimeCell(raw: string): TimeParts | null {
	const m = raw.trim().match(TIME_RE);
	if (!m) return null;
	let h = +m[1];
	const min = +m[2];
	const s = m[3] != null ? +m[3] : null;
	const ap = m[4]?.toLowerCase() ?? null;
	if (ap) {
		if (h < 1 || h > 12) return null;
		h = (h % 12) + (ap.startsWith("p") ? 12 : 0);
	}
	if (h > 23 || min > 59 || (s != null && s > 59)) return null;
	return { h, min, s };
}

export const TIME_PATTERNS = ["h12", "h12s", "h24", "h24s"] as const;
export type TimePatternId = (typeof TIME_PATTERNS)[number];

export function formatTimeSpec(t: TimeParts, pattern: TimePatternId): string {
	const ampm = t.h < 12 ? "AM" : "PM";
	const h12 = t.h % 12 === 0 ? 12 : t.h % 12;
	switch (pattern) {
		case "h12":
			return `${h12}:${pad2(t.min)} ${ampm}`;
		case "h12s":
			return `${h12}:${pad2(t.min)}:${pad2(t.s ?? 0)} ${ampm}`;
		case "h24":
			return `${t.h}:${pad2(t.min)}`;
		case "h24s":
			return `${t.h}:${pad2(t.min)}:${pad2(t.s ?? 0)}`;
	}
}

/** Format one raw cell piece per spec; null = cell doesn't apply (non-matching
 *  value, live-calc, or formula cell). Red negative styles write the text
 *  color; leaving them clears exactly that red so styles round-trip. */
export function formatPiece(piece: string, spec: FmtSpec): string | null {
	const parsed = parseCellContent(piece);
	if (parsed.calc || parsed.formula) return null;
	const clean = parsed.inner
		.replace(/<[^>]*>/g, "")
		.replace(/[*_~=`]/g, "")
		.trim();
	let text: string | null = null;
	let fg = parsed.fg;
	if (spec.kind === "date") {
		const p = parseDateCell(clean);
		if (p) text = formatDateSpec(p, spec.datePattern);
	} else if (spec.kind === "time") {
		const t = parseTimeCell(clean);
		if (t) text = formatTimeSpec(t, spec.timePattern);
	} else {
		const n = parseNumeric(parsed.inner);
		if (n) {
			text = formatBySpec(n.value, spec);
			const red = n.value < 0 && (spec.negative === "red" || spec.negative === "redparen");
			if (red) fg = NEG_RED;
			else if ((fg ?? "").toUpperCase() === NEG_RED) fg = null;
		}
	}
	if (text == null) return null;
	// reformat the value but keep whole-value bold/italic/strike
	const em = splitEmphasis(parsed.inner);
	return ` ${buildCellContent(em.lead + text + em.trail, parsed.bg, fg, null, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
}

/**
 * One-shot Format-cells pass: rewrites every matching cell in scope per the
 * spec (markdown stays the source of truth, like planFormatNumber). Numeric
 * kinds skip non-numeric cells; date/time kinds skip cells that don't parse.
 * Live-calc and formula cells are left alone.
 */
export function planFormatCells(lines: string[], target: CellTargetLoc, spec: FmtSpec, scope: Scope): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	let lineNos: number[] = [ln];
	if (scope === "column" || scope === "table") {
		let start = ln;
		let end = ln;
		while (start > 0 && parseRow(lines[start - 1])) start--;
		while (end < lines.length - 1 && parseRow(lines[end + 1])) end++;
		lineNos = [];
		for (let i = start; i <= end; i++) lineNos.push(i);
	}
	const edits: { line: number; text: string }[] = [];
	for (const li of lineNos) {
		const r = parseRow(lines[li]);
		if (!r || r.isDelim) continue;
		const cols =
			scope === "row" || scope === "table"
				? Array.from({ length: r.cellCount }, (_, i) => i)
				: target.col < r.cellCount
					? [target.col]
					: [];
		let changed = false;
		for (const c of cols) {
			const piece = r.pieces[c + 1];
			const parsed = parseCellContent(piece);
			let next: string | null;
			if (parsed.calc || parsed.formula) {
				// live cells can't hold a one-shot value, store the format on
				// the cell instead; the recalc pass renders through it
				const tag = fmtToTag(spec);
				next =
					(parsed.fmt ?? null) === tag
						? null
						: ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, parsed.calc, parsed.formula, parsed.borders, tag, parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
			} else {
				next = formatPiece(piece, spec);
			}
			if (next != null && next !== piece) {
				r.pieces[c + 1] = next;
				changed = true;
			}
		}
		if (changed) edits.push({ line: li, text: r.prefix + r.pieces.join("|") });
	}
	const lnText = edits.find((e) => e.line === ln)?.text ?? lines[ln];
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lnText, target.col) };
}

/**
 * Run a single-cell plan once per target (the table editor's multi-cell
 * selection) and merge the rewrites into one plan. Only for plans whose edits
 * are pure line replacements, every styling/format/border plan qualifies.
 */
export function planMulti(
	lines: string[],
	targets: CellTargetLoc[],
	make: (lines: string[], t: CellTargetLoc) => EditPlan | null
): EditPlan | null {
	const work = lines.slice();
	const touched = new Set<number>();
	let last: EditPlan | null = null;
	for (const t of targets) {
		const p = make(work, t);
		if (!p) continue;
		last = p;
		for (const e of p.edits) {
			if (e.kind) continue;
			work[e.line] = e.text;
			touched.add(e.line);
		}
	}
	if (!last) return null;
	const edits = [...touched].filter((l) => work[l] !== lines[l]).map((l) => ({ line: l, text: work[l] }));
	return { edits, cursorLine: last.cursorLine, cursorCh: last.cursorCh };
}

/* ---------------- sticky formats (auto-reapplied row/column formats) ---------------- */

const NEG_STYLES: NegStyle[] = ["minus", "red", "paren", "redparen"];
const FMT_DEFAULTS: Omit<FmtSpec, "kind"> = {
	decimals: 2,
	thousands: true,
	negative: "minus",
	symbol: "$",
	datePattern: "mdy",
	timePattern: "h12",
};

/** Serialize a spec into the compact data-fmt tag ("n:2:1:minus", "c:$:2:paren", "d:iso" …). */
export function fmtToTag(spec: FmtSpec): string {
	switch (spec.kind) {
		case "number":
			return `n:${spec.decimals}:${spec.thousands ? 1 : 0}:${spec.negative}`;
		case "currency":
			return `c:${spec.symbol.replace(/[:"]/g, "")}:${spec.decimals}:${spec.negative}`;
		case "percent":
			return `p:${spec.decimals}`;
		case "date":
			return `d:${spec.datePattern}`;
		case "time":
			return `t:${spec.timePattern}`;
	}
}

export function fmtFromTag(tag: string): FmtSpec | null {
	const parts = tag.split(":");
	const dec = (s: string | undefined) => {
		const n = parseInt(s ?? "", 10);
		return Number.isFinite(n) && n >= 0 && n <= 6 ? n : 2;
	};
	const neg = (s: string | undefined): NegStyle => (NEG_STYLES.includes(s as NegStyle) ? (s as NegStyle) : "minus");
	switch (parts[0]) {
		case "n":
			return { ...FMT_DEFAULTS, kind: "number", decimals: dec(parts[1]), thousands: parts[2] !== "0", negative: neg(parts[3]) };
		case "c":
			return { ...FMT_DEFAULTS, kind: "currency", symbol: parts[1] || "$", decimals: dec(parts[2]), negative: neg(parts[3]) };
		case "p":
			return { ...FMT_DEFAULTS, kind: "percent", decimals: dec(parts[1]) };
		case "d":
			return (DATE_PATTERNS as readonly string[]).includes(parts[1])
				? { ...FMT_DEFAULTS, kind: "date", datePattern: parts[1] as DatePatternId }
				: null;
		case "t":
			return (TIME_PATTERNS as readonly string[]).includes(parts[1])
				? { ...FMT_DEFAULTS, kind: "time", timePattern: parts[1] as TimePatternId }
				: null;
	}
	return null;
}

/**
 * Write (or clear, tag=null) a sticky format marker: on the header cell for a
 * column, on the row's anchor cell for a body row. Header cells hold column
 * tags, so the header row itself can't take a row sticky (returns null).
 */
export function planStickyFormat(
	lines: string[],
	target: CellTargetLoc,
	tag: string | null,
	axis: "row" | "column"
): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const { start, delimIdx } = tableBounds(lines, ln);
	let anchorLine = ln;
	if (axis === "column") {
		anchorLine = start;
	} else if (delimIdx >= 0 && ln < delimIdx) {
		return null;
	}
	const r = parseRow(lines[anchorLine]);
	if (!r || r.isDelim) return null;
	let changed = false;
	if (axis === "row") {
		// row tags carry a "row:" prefix (plain tags on body cells are
		// cell-level formats); exactly one anchor per row, clear strays
		const want0 = tag ? `row:${tag}` : null;
		for (let c = 0; c < r.cellCount; c++) {
			const parsed = parseCellContent(r.pieces[c + 1]);
			const cur = parsed.fmt ?? null;
			const want = c === 0 ? want0 : cur?.startsWith("row:") ? null : cur;
			if (cur === want) continue;
			r.pieces[c + 1] = ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, parsed.calc, parsed.formula, parsed.borders, want, parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
			changed = true;
		}
	} else {
		const col = Math.min(target.col, r.cellCount - 1);
		const parsed = parseCellContent(r.pieces[col + 1]);
		if ((parsed.fmt ?? null) !== tag) {
			r.pieces[col + 1] = ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, parsed.calc, parsed.formula, parsed.borders, tag, parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
			changed = true;
		}
	}
	const edits = changed ? [{ line: anchorLine, text: r.prefix + r.pieces.join("|") }] : [];
	const lnText = edits.find((e) => e.line === ln)?.text ?? lines[ln];
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lnText, target.col) };
}

/**
 * Apply every sticky format marker in the document: header-cell tags format
 * their column's body cells, body-cell tags format their whole row (row wins
 * where both apply). `skip` exempts the cell being edited so the debounced
 * pass never fights the cursor. Idempotent, formatted output re-parses to
 * the same value, so the modify events our own write fires settle in one pass.
 */
export function applyStickyFormats(lines: string[], skip?: { line: number; col: number }): { line: number; text: string }[] {
	const out: { line: number; text: string }[] = [];
	let i = 0;
	while (i < lines.length) {
		if (!parseRow(lines[i])) {
			i++;
			continue;
		}
		let end = i;
		while (end < lines.length - 1 && parseRow(lines[end + 1])) end++;
		const colSpecs = new Map<number, FmtSpec>();
		const hr = parseRow(lines[i]);
		if (hr && !hr.isDelim) {
			for (let c = 0; c < hr.cellCount; c++) {
				const f = parseCellContent(hr.pieces[c + 1]).fmt;
				const spec = f && !f.startsWith("row:") ? fmtFromTag(f) : null;
				if (spec) colSpecs.set(c, spec);
			}
		}
		let delimSeen = false;
		for (let li = i; li <= end; li++) {
			const r = parseRow(lines[li]);
			if (!r) continue;
			if (r.isDelim) {
				delimSeen = true;
				continue;
			}
			if (!delimSeen) continue; // header zone, labels stay as typed
			let rowSpec: FmtSpec | null = null;
			for (let c = 0; c < r.cellCount && !rowSpec; c++) {
				const f = parseCellContent(r.pieces[c + 1]).fmt;
				if (f?.startsWith("row:")) rowSpec = fmtFromTag(f.slice(4));
			}
			let changed = false;
			for (let c = 0; c < r.cellCount; c++) {
				if (skip && skip.line === li && skip.col === c) continue;
				const own = parseCellContent(r.pieces[c + 1]).fmt;
				const ownSpec = own && !own.startsWith("row:") ? fmtFromTag(own) : null;
				const spec = ownSpec ?? rowSpec ?? colSpecs.get(c);
				if (!spec) continue;
				const next = formatPiece(r.pieces[c + 1], spec);
				if (next != null && next !== r.pieces[c + 1]) {
					r.pieces[c + 1] = next;
					changed = true;
				}
			}
			if (changed) out.push({ line: li, text: r.prefix + r.pieces.join("|") });
		}
		i = end + 1;
	}
	return out;
}

/* ---------------- cell borders ---------------- */

export type BorderAction = "top" | "bottom" | "left" | "right" | "none" | "all" | "outside" | "thickoutside";

type Edge = "top" | "bottom" | "left" | "right";
const EDGE_CHARS: Record<Edge, string> = { top: "t", bottom: "b", left: "l", right: "r" };

/** Merge edges into a border string ("tblr", uppercase = thick); an explicit
 *  set replaces that edge's weight. Canonical order t, b, l, r. */
export function mergeBorders(existing: string | null, add: { edge: Edge; thick: boolean }[]): string | null {
	const state = new Map<string, boolean>();
	for (const ch of existing ?? "") {
		const lower = ch.toLowerCase();
		if ("tblr".includes(lower)) state.set(lower, state.get(lower) || ch !== lower);
	}
	for (const a of add) state.set(EDGE_CHARS[a.edge], a.thick);
	let out = "";
	for (const c of ["t", "b", "l", "r"]) if (state.has(c)) out += state.get(c) ? c.toUpperCase() : c;
	return out || null;
}

/**
 * Excel-style border actions over the Apply-to scope, treated as a selection
 * rectangle: single edges land on that side of the selection (bottom of a
 * column hits only its last cell), "all" grids every cell, "outside" draws the
 * selection's perimeter, "none" clears. Stored as data-b on the cell span and
 * painted onto the <td> by CSS.
 */
export function planBorders(lines: string[], target: CellTargetLoc, action: BorderAction, scope: Scope): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const { start, end } = tableBounds(lines, ln);
	const rowsAll: number[] = [];
	for (let i = start; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (r && !r.isDelim) rowsAll.push(i);
	}
	const anchor = parseRow(lines[ln]);
	if (!anchor || anchor.isDelim) return null;
	const col = Math.min(target.col, anchor.cellCount - 1);
	const rows = scope === "column" || scope === "table" ? rowsAll : [ln];
	const edits: { line: number; text: string }[] = [];
	for (const li of rows) {
		const r = parseRow(lines[li]);
		if (!r || r.isDelim) continue;
		const cols =
			scope === "row" || scope === "table"
				? Array.from({ length: r.cellCount }, (_, i) => i)
				: col < r.cellCount
					? [col]
					: [];
		if (!cols.length) continue;
		let changed = false;
		for (const c of cols) {
			const parsed = parseCellContent(r.pieces[c + 1]);
			const firstRow = li === rows[0];
			const lastRow = li === rows[rows.length - 1];
			const firstCol = c === cols[0];
			const lastCol = c === cols[cols.length - 1];
			let nb: string | null;
			if (action === "none") nb = null;
			else if (action === "all") nb = "tblr";
			else if (action === "outside" || action === "thickoutside") {
				const thick = action === "thickoutside";
				const adds: { edge: Edge; thick: boolean }[] = [];
				if (firstRow) adds.push({ edge: "top", thick });
				if (lastRow) adds.push({ edge: "bottom", thick });
				if (firstCol) adds.push({ edge: "left", thick });
				if (lastCol) adds.push({ edge: "right", thick });
				nb = adds.length ? mergeBorders(parsed.borders, adds) : parsed.borders;
			} else {
				const onSide =
					action === "top" ? firstRow : action === "bottom" ? lastRow : action === "left" ? firstCol : lastCol;
				nb = onSide ? mergeBorders(parsed.borders, [{ edge: action, thick: false }]) : parsed.borders;
			}
			const next = ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, parsed.calc, parsed.formula, nb, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
			if (next !== r.pieces[c + 1]) {
				r.pieces[c + 1] = next;
				changed = true;
			}
		}
		if (changed) edits.push({ line: li, text: r.prefix + r.pieces.join("|") });
	}
	const lnText = edits.find((e) => e.line === ln)?.text ?? lines[ln];
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lnText, col) };
}

/* ---------------- structure: insert/delete/duplicate rows & columns ---------------- */

export function tableBounds(lines: string[], ln: number): { start: number; end: number; delimIdx: number } {
	let start = ln;
	let end = ln;
	while (start > 0 && parseRow(lines[start - 1])) start--;
	while (end < lines.length - 1 && parseRow(lines[end + 1])) end++;
	let delimIdx = -1;
	for (let i = start; i <= end; i++) {
		if (parseRow(lines[i])?.isDelim) {
			delimIdx = i;
			break;
		}
	}
	return { start, end, delimIdx };
}

function emptyRow(prefix: string, cellCount: number): string {
	return prefix + "|" + Array(cellCount).fill("   ").join("|") + "|";
}

export function planInsertRow(lines: string[], target: CellTargetLoc, where: "above" | "below"): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const r = parseRow(lines[ln]);
	if (!r) return null;
	const { delimIdx } = tableBounds(lines, ln);
	// header target: new rows always go just below the delimiter
	let at = where === "above" ? ln : ln + 1;
	if (delimIdx >= 0 && at <= delimIdx) at = delimIdx + 1;
	const text = emptyRow(r.prefix, r.cellCount);
	return { edits: [{ line: at, text, kind: "insert" }], cursorLine: at, cursorCh: cursorForCol(text, Math.min(target.col, r.cellCount - 1)) };
}

/** Append a live totals row: "Total" under the first column and a live column
 *  sum under every other column with numeric cells. If the table's body already
 *  holds a column-wise live calc (an existing totals row), nothing is added. */
export function planTotalsRow(lines: string[], target: CellTargetLoc): (EditPlan & { added: number }) | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const { start, end, delimIdx } = tableBounds(lines, ln);
	if (delimIdx < 0 || delimIdx >= end) return null;
	const hr = parseRow(lines[start]);
	if (!hr || hr.isDelim) return null;
	const none = { edits: [], cursorLine: ln, cursorCh: cursorForCol(lines[ln], target.col), added: 0 };
	const numeric: boolean[] = new Array(hr.cellCount).fill(false);
	for (let i = delimIdx + 1; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (!r || r.isDelim) continue;
		for (let c = 0; c < Math.min(r.cellCount, hr.cellCount); c++) {
			const parsed = parseCellContent(r.pieces[c + 1]);
			if (parsed.calc?.dir === "column") return none;
			if (!parsed.calc && parseNumeric(parsed.inner)) numeric[c] = true;
		}
	}
	const pieces = [""];
	let added = 0;
	for (let c = 0; c < hr.cellCount; c++) {
		if (c === 0) pieces.push(" Total ");
		else if (numeric[c]) {
			pieces.push(` ${buildCellContent("0", null, null, { fn: "sum", dir: "column" })} `);
			added++;
		} else pieces.push("   ");
	}
	pieces.push("");
	if (!added) return none;
	return {
		edits: [{ line: end + 1, text: hr.prefix + pieces.join("|"), kind: "insert" }],
		cursorLine: end + 1,
		cursorCh: 2,
		added,
	};
}

export function planDeleteRow(lines: string[], target: CellTargetLoc): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const r = parseRow(lines[ln]);
	if (!r || r.isDelim) return null;
	const { delimIdx } = tableBounds(lines, ln);
	if (delimIdx >= 0 && ln < delimIdx) return { edits: [], cursorLine: ln, cursorCh: 0 };
	return { edits: [{ line: ln, text: "", kind: "delete" }], cursorLine: Math.max(0, ln - 1), cursorCh: 2 };
}

export function planDuplicateRow(lines: string[], target: CellTargetLoc): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const r = parseRow(lines[ln]);
	if (!r || r.isDelim) return null;
	return {
		edits: [{ line: ln + 1, text: lines[ln], kind: "insert" }],
		cursorLine: ln + 1,
		cursorCh: cursorForCol(lines[ln], Math.min(target.col, r.cellCount - 1)),
	};
}

export function planInsertColumn(lines: string[], target: CellTargetLoc, where: "left" | "right"): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const anchor = parseRow(lines[ln]);
	if (!anchor) return null;
	const col = Math.min(target.col, anchor.cellCount - 1);
	const to = where === "left" ? col : col + 1;
	const { start, end } = tableBounds(lines, ln);
	const edits: { line: number; text: string }[] = [];
	for (let i = start; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (!r) continue;
		const at = Math.min(to, r.cellCount);
		r.pieces.splice(at + 1, 0, r.isDelim ? " --- " : "   ");
		edits.push({ line: i, text: r.prefix + r.pieces.join("|") });
	}
	const lnText = edits.find((e) => e.line === ln)?.text ?? lines[ln];
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lnText, to) };
}

export function planDeleteColumn(lines: string[], target: CellTargetLoc): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const anchor = parseRow(lines[ln]);
	if (!anchor || anchor.cellCount < 2) return null;
	const col = Math.min(target.col, anchor.cellCount - 1);
	const { start, end } = tableBounds(lines, ln);
	const edits: { line: number; text: string }[] = [];
	for (let i = start; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (!r || col >= r.cellCount) continue;
		r.pieces.splice(col + 1, 1);
		edits.push({ line: i, text: r.prefix + r.pieces.join("|") });
	}
	const lnText = edits.find((e) => e.line === ln)?.text ?? lines[ln];
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lnText, Math.max(0, col - 1)) };
}

/** Clear cell values (keeps colors, drops live-calc markers). */
export function planClearContents(lines: string[], target: CellTargetLoc, scope: Scope): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	let lineNos: number[] = [ln];
	if (scope === "column" || scope === "table") {
		const { start, end } = tableBounds(lines, ln);
		lineNos = [];
		for (let i = start; i <= end; i++) lineNos.push(i);
	}
	const edits: { line: number; text: string }[] = [];
	for (const li of lineNos) {
		const r = parseRow(lines[li]);
		if (!r || r.isDelim) continue;
		const cols =
			scope === "row" || scope === "table"
				? Array.from({ length: r.cellCount }, (_, i) => i)
				: target.col < r.cellCount
					? [target.col]
					: [];
		let changed = false;
		for (const c of cols) {
			const parsed = parseCellContent(r.pieces[c + 1]);
			const rebuilt = buildCellContent("", parsed.bg, parsed.fg, null, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl);
			const next = rebuilt ? ` ${rebuilt} ` : "   ";
			if (next !== r.pieces[c + 1]) {
				r.pieces[c + 1] = next;
				changed = true;
			}
		}
		if (changed) edits.push({ line: li, text: r.prefix + r.pieces.join("|") });
	}
	const lnText = edits.find((e) => e.line === ln)?.text ?? lines[ln];
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lnText, target.col) };
}

/* ---------------- CSV / TSV import ---------------- */

export function parseDelimited(text: string): string[][] {
	const rows = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim().length);
	if (!rows.length) return [];
	const delim = rows[0].includes("\t") ? "\t" : ",";
	return rows.map((line) => {
		const out: string[] = [];
		let cur = "";
		let inQ = false;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (inQ) {
				if (ch === '"') {
					if (line[i + 1] === '"') {
						cur += '"';
						i++;
					} else inQ = false;
				} else cur += ch;
			} else if (ch === '"' && cur === "") inQ = true;
			else if (ch === delim) {
				out.push(cur.trim());
				cur = "";
			} else cur += ch;
		}
		out.push(cur.trim());
		return out;
	});
}

function csvCell(v: string): string {
	return v.replace(/\|/g, "\\|");
}

/** Build fresh markdown table lines from parsed rows (first row = header). */
export function tableFromRows(rows: string[][]): string[] {
	const width = Math.max(...rows.map((r) => r.length), 1);
	const pad = (r: string[]) => "| " + Array.from({ length: width }, (_, i) => csvCell(r[i] ?? "")).join(" | ") + " |";
	const out = [pad(rows[0] ?? []), "|" + Array(width).fill(" --- ").join("|") + "|"];
	for (const r of rows.slice(1)) out.push(pad(r));
	return out;
}

/**
 * Import parsed rows into the target's table: "replace" swaps the whole
 * table (first row becomes the header), "append" adds every row to the
 * bottom, sized to the table's column count.
 */
export function planImportRows(
	lines: string[],
	target: CellTargetLoc,
	rows: string[][],
	mode: "replace" | "append"
): (EditPlan & { imported: number }) | null {
	if (!rows.length) return null;
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const anchor = parseRow(lines[ln]);
	if (!anchor) return null;
	const { start, end } = tableBounds(lines, ln);
	const edits: { line: number; text: string; kind?: EditKind }[] = [];

	if (mode === "append") {
		const width = anchor.cellCount;
		for (const r of rows) {
			const text = "| " + Array.from({ length: width }, (_, i) => csvCell(r[i] ?? "")).join(" | ") + " |";
			edits.push({ line: end + 1, text, kind: "insert" });
		}
		return { edits, cursorLine: end + 1, cursorCh: 2, imported: rows.length };
	}

	const fresh = tableFromRows(rows);
	const oldCount = end - start + 1;
	const common = Math.min(oldCount, fresh.length);
	for (let i = 0; i < common; i++) {
		if (fresh[i] !== lines[start + i]) edits.push({ line: start + i, text: fresh[i] });
	}
	for (let i = common; i < fresh.length; i++) edits.push({ line: end + 1, text: fresh[i], kind: "insert" });
	for (let i = start + common; i <= end; i++) edits.push({ line: i, text: "", kind: "delete" });
	return { edits, cursorLine: start, cursorCh: 2, imported: rows.length - 1 };
}

/* ---------------- formulas: =SUM(C1:C4), =C1*1.08 ---------------- */

/** Body-row cell texts for the table containing line `ln` (header excluded). */
export function tableGrid(lines: string[], ln: number): { rows: string[][]; bodyStart: number } | null {
	const { end, delimIdx } = tableBounds(lines, ln);
	if (delimIdx < 0) return null;
	const rows: string[][] = [];
	for (let i = delimIdx + 1; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (!r || r.isDelim) continue;
		rows.push(Array.from({ length: r.cellCount }, (_, c) => parseCellContent(r.pieces[c + 1]).inner));
	}
	return { rows, bodyStart: delimIdx + 1 };
}

function colIndexOf(letters: string): number {
	let n = 0;
	for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

export function colLetterOf(n: number): string {
	let s = "";
	do {
		s = String.fromCharCode(65 + (n % 26)) + s;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return s;
}

/**
 * The formula equivalent of a live calc marker, for the formula bar: a column
 * calc at column B reads =SUM(B:B), a row calc on data row 3 reads =SUM(3:3).
 * Committing that text back produces a formula cell with identical behavior
 * (whole-column/row ranges re-expand every recalc and exclude the cell itself).
 */
export function calcToFormula(calc: CalcSpec, col: number, bodyRow: number): string {
	const fn = calc.fn.toUpperCase();
	if (calc.dir === "column") {
		const L = colLetterOf(col);
		return `=${fn}(${L}:${L})`;
	}
	return `=${fn}(${bodyRow}:${bodyRow})`;
}

type FTok =
	| { t: "num"; v: number }
	| { t: "str"; v: string }
	| { t: "op"; v: string }
	| { t: "fn"; v: string }
	| { t: "ref"; col: number; row: number }
	| { t: "range"; c1: number; r1: number; c2: number; r2: number }
	| { t: "colrange"; c1: number; c2: number }
	| { t: "rowrange"; r1: number; r2: number }
	| { t: "lp" }
	| { t: "rp" }
	| { t: "comma" };

/** A formula value: numbers for math, text for IF results and comparisons. */
export type FVal = number | string;

function tokenizeFormula(src: string): FTok[] {
	const out: FTok[] = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (ch === " ") {
			i++;
			continue;
		}
		const two = src.slice(i, i + 2);
		if (two === ">=" || two === "<=" || two === "<>") {
			out.push({ t: "op", v: two });
			i += 2;
			continue;
		}
		if ("+-*/><=".includes(ch)) {
			out.push({ t: "op", v: ch });
			i++;
			continue;
		}
		// string literal: 'text' or "text" (data-f storage converts " to ')
		if (ch === "'" || ch === '"') {
			const close = src.indexOf(ch, i + 1);
			if (close < 0) throw new Error("unterminated string");
			out.push({ t: "str", v: src.slice(i + 1, close) });
			i = close + 1;
			continue;
		}
		if (ch === "(") {
			out.push({ t: "lp" });
			i++;
			continue;
		}
		if (ch === ")") {
			out.push({ t: "rp" });
			i++;
			continue;
		}
		if (ch === ",") {
			out.push({ t: "comma" });
			i++;
			continue;
		}
		if (/\d/.test(ch)) {
			// Excel-style whole-row range: 3:3 (all columns of data row 3)
			const rr = /^(\d+):(\d+)(?![\d.])/.exec(src.slice(i));
			if (rr) {
				out.push({ t: "rowrange", r1: +rr[1] - 1, r2: +rr[2] - 1 });
				i += rr[0].length;
				continue;
			}
			const m = /^\d+(\.\d+)?/.exec(src.slice(i))!;
			out.push({ t: "num", v: parseFloat(m[0]) });
			i += m[0].length;
			continue;
		}
		const fn = /^(SUMIF|COUNTIF|SUM|AVERAGE|AVG|MIN|MAX|COUNT|IF|ROUND|ABS)\s*\(/i.exec(src.slice(i));
		if (fn) {
			out.push({ t: "fn", v: fn[1].toUpperCase() === "AVERAGE" ? "AVG" : fn[1].toUpperCase() });
			out.push({ t: "lp" });
			i += fn[0].length;
			continue;
		}
		const range = /^([A-Za-z]{1,2})(\d+):([A-Za-z]{1,2})(\d+)/.exec(src.slice(i));
		if (range) {
			out.push({
				t: "range",
				c1: colIndexOf(range[1]),
				r1: +range[2] - 1,
				c2: colIndexOf(range[3]),
				r2: +range[4] - 1,
			});
			i += range[0].length;
			continue;
		}
		// Excel-style whole-column range: B:B (all data rows of column B)
		const cr = /^([A-Za-z]{1,2}):([A-Za-z]{1,2})(?!\d)/.exec(src.slice(i));
		if (cr) {
			out.push({ t: "colrange", c1: colIndexOf(cr[1]), c2: colIndexOf(cr[2]) });
			i += cr[0].length;
			continue;
		}
		const ref = /^([A-Za-z]{1,2})(\d+)/.exec(src.slice(i));
		if (ref) {
			out.push({ t: "ref", col: colIndexOf(ref[1]), row: +ref[2] - 1 });
			i += ref[0].length;
			continue;
		}
		throw new Error("bad token");
	}
	return out;
}

/** Strip whole-value emphasis and markup noise from a cell's text for matching. */
function plainCellText(raw: string): string {
	return raw.replace(/[*~_`]/g, "").trim();
}

/** Excel-style criteria: ">100", "<=5", "<>x", "=text", bare text, or a number. */
export function matchCriteria(raw: string, crit: FVal): boolean {
	const text = plainCellText(raw);
	if (typeof crit === "number") {
		const n = parseNumeric(text);
		return !!n && n.value === crit;
	}
	const m = crit.match(/^(>=|<=|<>|>|<|=)?\s*([\s\S]*)$/)!;
	const op = m[1] ?? "=";
	const rhsRaw = m[2].trim();
	const lhsN = parseNumeric(text);
	const rhsN = parseNumeric(rhsRaw);
	if (lhsN && rhsN) {
		const a = lhsN.value;
		const b = rhsN.value;
		if (op === ">") return a > b;
		if (op === "<") return a < b;
		if (op === ">=") return a >= b;
		if (op === "<=") return a <= b;
		if (op === "<>") return a !== b;
		return a === b;
	}
	const a = text.toLowerCase();
	const b = rhsRaw.toLowerCase();
	if (op === ">") return a > b;
	if (op === "<") return a < b;
	if (op === ">=") return a >= b;
	if (op === "<=") return a <= b;
	if (op === "<>") return a !== b;
	return a === b;
}

/**
 * Evaluate a "=…" formula against the table's body rows. Cell refs are
 * letter+1-based-data-row (C2 = third column, second data row; the header is
 * not addressable). The formula's own cell is excluded from ranges and is an
 * error as a direct ref (circularity guard on top of the recalc pass cap).
 * Numbers flow through math; text flows through refs, IF, and comparisons.
 * Throws on any invalid input, callers render #ERR.
 */
export function evalFormula(src: string, rows: string[][], selfRow: number, selfCol: number): FVal {
	const toks = tokenizeFormula(src.replace(/^=/, ""));
	let p = 0;
	const peek = () => toks[p];
	const next = () => toks[p++];
	const numAt = (row: number, col: number): number | null => {
		const n = parseNumeric(rows[row]?.[col] ?? "");
		return n ? n.value : null;
	};
	const refValue = (row: number, col: number): FVal => {
		if (row === selfRow && col === selfCol) throw new Error("self reference");
		if (row < 0 || row >= rows.length) throw new Error("out of range");
		const n = numAt(row, col);
		if (n != null) return n;
		return plainCellText(rows[row]?.[col] ?? "");
	};
	const rangeCells = (r1: number, r2: number, c1: number, c2: number) => {
		const cells: { r: number; c: number }[] = [];
		for (let r = Math.max(0, Math.min(r1, r2)); r <= Math.min(rows.length - 1, Math.max(r1, r2)); r++) {
			for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
				if (r === selfRow && c === selfCol) continue;
				cells.push({ r, c });
			}
		}
		return cells;
	};

	type Arg = { cells: { r: number; c: number }[] } | { v: FVal };

	function fnArgs(): Arg[] {
		const args: Arg[] = [];
		if (peek()?.t === "rp") {
			next();
			return args;
		}
		for (;;) {
			const t = peek();
			if (t?.t === "range") {
				next();
				args.push({ cells: rangeCells(t.r1, t.r2, t.c1, t.c2) });
			} else if (t?.t === "colrange") {
				next();
				args.push({ cells: rangeCells(0, rows.length - 1, t.c1, t.c2) });
			} else if (t?.t === "rowrange") {
				next();
				const width = Math.max(0, ...rows.map((r) => r.length)) - 1;
				args.push({ cells: rangeCells(t.r1, t.r2, 0, width) });
			} else {
				args.push({ v: cmp() });
			}
			const sep = next();
			if (sep?.t === "rp") break;
			if (sep?.t !== "comma") throw new Error("expected , or )");
		}
		return args;
	}

	function fnCall(name: string): FVal {
		const args = fnArgs();
		const nums = (): number[] => {
			const out: number[] = [];
			for (const a of args) {
				if ("cells" in a) {
					for (const { r, c } of a.cells) {
						const v = numAt(r, c);
						if (v != null) out.push(v);
					}
				} else if (typeof a.v === "number") out.push(a.v);
				else throw new Error("text where a number was expected");
			}
			return out;
		};
		const asNum = (a: Arg | undefined): number => {
			if (!a || "cells" in a || typeof a.v !== "number") throw new Error("expected a number");
			return a.v;
		};
		switch (name) {
			case "SUM": {
				const v = nums();
				if (!v.length) throw new Error("no values");
				return v.reduce((x, y) => x + y, 0);
			}
			case "AVG": {
				const v = nums();
				if (!v.length) throw new Error("no values");
				return v.reduce((x, y) => x + y, 0) / v.length;
			}
			case "MIN": {
				const v = nums();
				if (!v.length) throw new Error("no values");
				return Math.min(...v);
			}
			case "MAX": {
				const v = nums();
				if (!v.length) throw new Error("no values");
				return Math.max(...v);
			}
			case "COUNT":
				return nums().length;
			case "ABS":
				return Math.abs(asNum(args[0]));
			case "ROUND": {
				const v = asNum(args[0]);
				const d = args.length > 1 ? asNum(args[1]) : 0;
				const f = Math.pow(10, Math.round(d));
				return Math.round(v * f) / f;
			}
			case "IF": {
				if (args.length < 2 || "cells" in args[0]) throw new Error("IF(condition, then, else)");
				const cond = args[0].v;
				const truthy = typeof cond === "number" ? cond !== 0 : cond.length > 0;
				const pick = truthy ? args[1] : (args[2] ?? { v: "" });
				if ("cells" in pick) throw new Error("IF branches must be values");
				return pick.v;
			}
			case "SUMIF": {
				const range = args[0];
				const crit = args[1];
				if (!range || !("cells" in range) || !crit || "cells" in crit) {
					throw new Error("SUMIF(range, criteria, optional sum range)");
				}
				const sumRange = args[2] && "cells" in args[2] ? args[2].cells : range.cells;
				let total = 0;
				for (let k = 0; k < range.cells.length; k++) {
					const { r, c } = range.cells[k];
					if (!matchCriteria(rows[r]?.[c] ?? "", crit.v)) continue;
					const cell = sumRange[k] ?? range.cells[k];
					const v = numAt(cell.r, cell.c);
					if (v != null) total += v;
				}
				return total;
			}
			case "COUNTIF": {
				const range = args[0];
				const crit = args[1];
				if (!range || !("cells" in range) || !crit || "cells" in crit) {
					throw new Error("COUNTIF(range, criteria)");
				}
				let n = 0;
				for (const { r, c } of range.cells) if (matchCriteria(rows[r]?.[c] ?? "", crit.v)) n++;
				return n;
			}
			default:
				throw new Error("unknown fn");
		}
	}

	function factor(): FVal {
		const t = next();
		if (!t) throw new Error("unexpected end");
		if (t.t === "num") return t.v;
		if (t.t === "str") return t.v;
		if (t.t === "ref") return refValue(t.row, t.col);
		if (t.t === "op" && (t.v === "-" || t.v === "+")) {
			const v = factor();
			if (typeof v !== "number") throw new Error("text in arithmetic");
			return t.v === "-" ? -v : v;
		}
		if (t.t === "fn") {
			const lp = next();
			if (lp?.t !== "lp") throw new Error("expected (");
			return fnCall(t.v);
		}
		if (t.t === "lp") {
			const v = cmp();
			if (next()?.t !== "rp") throw new Error("expected )");
			return v;
		}
		throw new Error("unexpected token");
	}

	function term(): FVal {
		let v = factor();
		for (;;) {
			const t = peek();
			if (t?.t === "op" && (t.v === "*" || t.v === "/")) {
				next();
				const rhs = factor();
				if (typeof v !== "number" || typeof rhs !== "number") throw new Error("text in arithmetic");
				v = t.v === "*" ? v * rhs : v / rhs;
			} else return v;
		}
	}

	function add(): FVal {
		let v = term();
		for (;;) {
			const t = peek();
			if (t?.t === "op" && (t.v === "+" || t.v === "-")) {
				next();
				const rhs = term();
				if (typeof v !== "number" || typeof rhs !== "number") throw new Error("text in arithmetic");
				v = t.v === "+" ? v + rhs : v - rhs;
			} else return v;
		}
	}

	function cmp(): FVal {
		const a = add();
		const t = peek();
		if (t?.t === "op" && [">", "<", ">=", "<=", "=", "<>"].includes(t.v)) {
			next();
			const b = add();
			let res: boolean;
			if (typeof a === "number" && typeof b === "number") {
				res =
					t.v === ">" ? a > b : t.v === "<" ? a < b : t.v === ">=" ? a >= b : t.v === "<=" ? a <= b : t.v === "=" ? a === b : a !== b;
			} else if (typeof a === "string" && typeof b === "string") {
				const x = a.toLowerCase();
				const y = b.toLowerCase();
				res =
					t.v === ">" ? x > y : t.v === "<" ? x < y : t.v === ">=" ? x >= y : t.v === "<=" ? x <= y : t.v === "=" ? x === y : x !== y;
			} else throw new Error("mixed comparison");
			return res ? 1 : 0;
		}
		return a;
	}

	const result = cmp();
	if (p !== toks.length) throw new Error("trailing tokens");
	if (typeof result === "number" && !isFinite(result)) throw new Error("not finite");
	return result;
}

export function formatFormulaResult(v: FVal): string {
	if (typeof v === "string") return v.replace(/\|/g, "\\|");
	return String(Math.round(v * 10000) / 10000);
}

/** Does this raw cell text look like an attempted formula? (Casual "=text" cells are left alone.) */
export function looksLikeFormula(inner: string): boolean {
	return /^=\s*(?:SUMIF|COUNTIF|SUM|AVERAGE|AVG|MIN|MAX|COUNT|IF|ROUND|ABS|\(|-|\d|['"]|[A-Za-z]{1,2}\d)/i.test(inner);
}

/**
 * Set a cell's raw value from the formula bar. "=…" input becomes a live
 * formula cell (value stored, formula in data-f); anything else becomes plain
 * text, replacing any formula or live calc, keeping colors.
 */
export function planSetCellValue(lines: string[], target: CellTargetLoc, raw: string): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const r = parseRow(lines[ln]);
	if (!r || r.isDelim) return null;
	const col = Math.min(target.col, r.cellCount - 1);
	const parsed = parseCellContent(r.pieces[col + 1]);
	const t = raw.trim().replace(/\|/g, "\\|");
	let rebuilt: string;
	if (t.startsWith("=")) {
		const g = tableGrid(lines, ln);
		let value = "#ERR";
		if (g) {
			try {
				value = formatFormulaResult(evalFormula(t, g.rows, ln - g.bodyStart, col));
			} catch {
				value = "#ERR";
			}
		}
		rebuilt = buildCellContent(value, parsed.bg, parsed.fg, null, t, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl);
	} else {
		rebuilt = buildCellContent(t, parsed.bg, parsed.fg, null, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl);
	}
	r.pieces[col + 1] = rebuilt ? ` ${rebuilt} ` : "   ";
	const text = r.prefix + r.pieces.join("|");
	return { edits: text === lines[ln] ? [] : [{ line: ln, text }], cursorLine: ln, cursorCh: cursorForCol(text, col) };
}

/* ---------------- conditional rule (bulk apply) ---------------- */

export type RuleOp = "gt" | "lt" | "eq" | "contains" | "between" | "empty" | "notempty" | "regex" | "scale";

/** "10~20" → [10, 20] (order-insensitive); nulls when either side isn't numeric. */
function betweenBounds(value: string): [number | null, number | null] {
	const parts = value.split("~");
	if (parts.length !== 2) return [null, null];
	const a = parseNumeric(parts[0].trim());
	const b = parseNumeric(parts[1].trim());
	if (!a || !b) return [null, null];
	return [Math.min(a.value, b.value), Math.max(a.value, b.value)];
}

/** A scale rule's "#lo~#hi" value → [lo, hi]; null unless both are hex colors. */
export function scaleColors(value: string): [string, string] | null {
	const parts = value.split("~");
	if (parts.length !== 2) return null;
	const ok = (s: string) => /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.test(s.trim());
	return ok(parts[0]) && ok(parts[1]) ? [parts[0].trim(), parts[1].trim()] : null;
}

export function lerpHex(lo: string, hi: string, t: number): string {
	const a = hexToRgb(lo);
	const b = hexToRgb(hi);
	if (!a || !b) return lo;
	const k = Math.max(0, Math.min(1, t));
	return rgbToHex(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
}

/** Whether a cell color could have been written by a lo→hi scale: every RGB
 *  channel sits between the endpoints. Such colors are safe to repaint as
 *  values shift; anything outside counts as hand-painted and wins. */
export function scaleOwns(color: string | null, lo: string, hi: string): boolean {
	if (!color) return false;
	const c = hexToRgb(color);
	const a = hexToRgb(lo);
	const b = hexToRgb(hi);
	if (!c || !a || !b) return false;
	return c.every((v, i) => v >= Math.min(a[i], b[i]) && v <= Math.max(a[i], b[i]));
}

/**
 * Apply a coloring rule to every matching body cell in the target's column.
 * This is a one-shot bulk action writing real colors into the markdown, no
 * hidden rule state to drift out of sync; rerun it after data changes.
 */
/** Does a cell value satisfy a rule? Shared by one-shot apply and live rules. */
export function ruleHit(inner: string, op: RuleOp, value: string): boolean {
	const n = parseNumeric(inner);
	const vn = parseNumeric(value);
	if (op === "contains") return !!value && normalizeText(inner).toLowerCase().includes(value.toLowerCase());
	if (op === "gt" || op === "lt") return !!n && !!vn && (op === "gt" ? n.value > vn.value : n.value < vn.value);
	if (op === "empty") return !normalizeText(inner).trim();
	if (op === "notempty") return !!normalizeText(inner).trim();
	if (op === "between") {
		const [lo, hi] = betweenBounds(value);
		return lo != null && hi != null && !!n && n.value >= lo && n.value <= hi;
	}
	if (op === "regex") {
		if (!value) return false;
		try {
			return new RegExp(value, "i").test(normalizeText(inner));
		} catch {
			return false;
		}
	}
	if (op === "scale") return !!n;
	return n && vn ? n.value === vn.value : normalizeText(inner).toLowerCase() === value.toLowerCase();
}

/** One-shot conditional coloring: paint every matching cell in the target's
 *  column right now. Stored live rules are managed by planSetColumnRules. */
export function planApplyRule(
	lines: string[],
	target: CellTargetLoc,
	rule: { op: RuleOp; value: string; bg: string | null; fg: string | null }
): (EditPlan & { matched: number }) | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const anchor = parseRow(lines[ln]);
	if (!anchor) return null;
	const col = Math.min(target.col, anchor.cellCount - 1);
	const { end, delimIdx } = tableBounds(lines, ln);
	if (delimIdx < 0) return null;
	// scale rules paint by position between the column's min and max
	let sb: { lo: string; hi: string; min: number; max: number } | null = null;
	if (rule.op === "scale") {
		const cols = scaleColors(rule.value);
		if (!cols) return null;
		let min = Infinity;
		let max = -Infinity;
		for (let i = delimIdx + 1; i <= end; i++) {
			const r = parseRow(lines[i]);
			if (!r || r.isDelim || col >= r.cellCount) continue;
			const n = parseNumeric(parseCellContent(r.pieces[col + 1]).inner);
			if (n) {
				min = Math.min(min, n.value);
				max = Math.max(max, n.value);
			}
		}
		if (min === Infinity) return { edits: [], cursorLine: ln, cursorCh: cursorForCol(lines[ln], col), matched: 0 };
		sb = { lo: cols[0], hi: cols[1], min, max };
	}
	const edits: { line: number; text: string }[] = [];
	let matched = 0;
	for (let i = delimIdx + 1; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (!r || r.isDelim || col >= r.cellCount) continue;
		const parsed = parseCellContent(r.pieces[col + 1]);
		if (!ruleHit(parsed.inner, rule.op, rule.value)) continue;
		matched++;
		const bg = sb
			? lerpHex(sb.lo, sb.hi, sb.max > sb.min ? (parseNumeric(parsed.inner)!.value - sb.min) / (sb.max - sb.min) : 0.5)
			: (rule.bg ?? parsed.bg);
		const next = ` ${buildCellContent(parsed.inner, bg, rule.fg ?? parsed.fg, parsed.calc, parsed.formula, parsed.borders, parsed.fmt, rule.bg || sb ? false : parsed.hl, parsed.w, parsed.rule, parsed.tbl)} `;
		if (next !== r.pieces[col + 1]) {
			r.pieces[col + 1] = next;
			edits.push({ line: i, text: r.prefix + r.pieces.join("|") });
		}
	}
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lines[ln], col), matched };
}

/** Decode a data-rule header tag: "lt:0:-:#F00" → { op, value, bg, fg }. */
export function parseRuleTag(tag: string): { op: RuleOp; value: string; bg: string | null; fg: string | null } | null {
	const m = tag.match(/^(gt|lt|eq|contains|between|empty|notempty|regex|scale):([^:]*):([^:]*):([^:]*)$/);
	if (!m) return null;
	return { op: m[1] as RuleOp, value: m[2], bg: m[3] === "-" ? null : m[3], fg: m[4] === "-" ? null : m[4] };
}

/** Decode a data-rule header tag holding one or more rules, semicolon-joined:
 *  "lt:0:-:#F00;gt:100:#FF0:-". Single-rule tags from older versions parse as
 *  a list of one. Malformed parts are dropped, never fatal. */
export function parseRuleTags(tag: string): { op: RuleOp; value: string; bg: string | null; fg: string | null }[] {
	const out: { op: RuleOp; value: string; bg: string | null; fg: string | null }[] = [];
	for (const part of tag.split(";")) {
		const r = parseRuleTag(part.trim());
		if (r) out.push(r);
	}
	return out;
}

/** The live rules stored on the target's column header, in priority order. */
export function columnRulesAt(
	lines: string[],
	target: CellTargetLoc
): { op: RuleOp; value: string; bg: string | null; fg: string | null }[] {
	const ln = locateLine(lines, target);
	if (ln == null) return [];
	const anchor = parseRow(lines[ln]);
	if (!anchor) return [];
	const col = Math.min(target.col, anchor.cellCount - 1);
	const { start, delimIdx } = tableBounds(lines, ln);
	if (delimIdx <= start) return [];
	const hr = parseRow(lines[start]);
	if (!hr || hr.isDelim || col >= hr.cellCount) return [];
	const tag = parseCellContent(hr.pieces[col + 1]).rule;
	return tag ? parseRuleTags(tag) : [];
}

/** Replace the target column's stored rule list (empty list removes the tag),
 *  then enforce the new rules immediately so the change is visible without
 *  waiting for the next settle pass. Colors a removed rule already painted
 *  stay in place. */
export function planSetColumnRules(
	lines: string[],
	target: CellTargetLoc,
	rules: { op: RuleOp; value: string; bg: string | null; fg: string | null }[]
): (EditPlan & { active: number }) | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const anchor = parseRow(lines[ln]);
	if (!anchor) return null;
	const col = Math.min(target.col, anchor.cellCount - 1);
	const { start, delimIdx } = tableBounds(lines, ln);
	if (delimIdx <= start) return null;
	const hr = parseRow(lines[start]);
	if (!hr || hr.isDelim || col >= hr.cellCount) return null;
	const hp = parseCellContent(hr.pieces[col + 1]);
	const tag = rules.length
		? rules.map((r) => `${r.op}:${r.value.replace(/[:"|;]/g, " ").trim()}:${r.bg ?? "-"}:${r.fg ?? "-"}`).join(";")
		: null;
	const edits: { line: number; text: string }[] = [];
	if ((hp.rule ?? null) !== tag) {
		const rebuilt = buildCellContent(hp.inner, hp.bg, hp.fg, hp.calc, hp.formula, hp.borders, hp.fmt, hp.hl, hp.w, tag, hp.tbl);
		hr.pieces[col + 1] = rebuilt ? ` ${rebuilt} ` : "   ";
		edits.push({ line: start, text: hr.prefix + hr.pieces.join("|") });
	}
	const work = lines.slice();
	for (const e of edits) work[e.line] = e.text;
	edits.push(...applyLiveRules(work));
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lines[ln], col), active: rules.length };
}

/** Remove all live rules from the target's column, leaving colors as they are. */
export function planClearColumnRule(lines: string[], target: CellTargetLoc): EditPlan | null {
	return planSetColumnRules(lines, target, []);
}

/**
 * Enforce live rules (data-rule tags on header cells) across their columns:
 * matching cells receive the rule's colors unless the user painted them
 * something else by hand; cells that stop matching lose the rule's colors
 * (and only those). Idempotent, so the recalc loop settles in one pass.
 */
export function applyLiveRules(lines: string[]): { line: number; text: string }[] {
	const out: { line: number; text: string }[] = [];
	const norm = (x: string | null) => (x ? shortHex(x).toUpperCase() : null);
	let i = 0;
	while (i < lines.length) {
		if (!parseRow(lines[i])) {
			i++;
			continue;
		}
		let end = i;
		while (end < lines.length - 1 && parseRow(lines[end + 1])) end++;
		let delimIdx = -1;
		for (let k = i; k <= end; k++) {
			if (parseRow(lines[k])?.isDelim) {
				delimIdx = k;
				break;
			}
		}
		const hr = delimIdx > i ? parseRow(lines[i]) : null;
		if (hr && !hr.isDelim) {
			const rules = new Map<number, { op: RuleOp; value: string; bg: string | null; fg: string | null }[]>();
			for (let c = 0; c < hr.cellCount; c++) {
				const tag = parseCellContent(hr.pieces[c + 1]).rule;
				const specs = tag ? parseRuleTags(tag) : [];
				if (specs.length) rules.set(c, specs);
			}
			if (rules.size) {
				// column min/max context for scale rules, computed once per table
				const scaleCtx = new Map<number, { lo: string; hi: string; min: number; max: number }>();
				for (const [c, specs] of rules) {
					const sc = specs.find((s) => s.op === "scale");
					const cols = sc ? scaleColors(sc.value) : null;
					if (!cols) continue;
					let min = Infinity;
					let max = -Infinity;
					for (let li = delimIdx + 1; li <= end; li++) {
						const r = parseRow(lines[li]);
						if (!r || r.isDelim || c >= r.cellCount) continue;
						const n = parseNumeric(parseCellContent(r.pieces[c + 1]).inner);
						if (n) {
							min = Math.min(min, n.value);
							max = Math.max(max, n.value);
						}
					}
					if (min !== Infinity) scaleCtx.set(c, { lo: cols[0], hi: cols[1], min, max });
				}
				for (let li = delimIdx + 1; li <= end; li++) {
					const r = parseRow(lines[li]);
					if (!r || r.isDelim) continue;
					let changed = false;
					for (const [c, specs] of rules) {
						if (c >= r.cellCount) continue;
						const parsed = parseCellContent(r.pieces[c + 1]);
						// Rules are checked in stored order; the first hit colors the
						// cell. A color counts as rule-owned (safe to repaint or clear)
						// if ANY of the column's rules could have written it, anything
						// else is hand-painted and wins. For scale rules the winning
						// fill is interpolated, and any color between the endpoints
						// counts as owned.
						const winner = specs.find((s) => ruleHit(parsed.inner, s.op, s.value)) ?? null;
						let winBg = winner?.bg ?? null;
						if (winner?.op === "scale") {
							const sc = scaleCtx.get(c);
							const n = parseNumeric(parsed.inner);
							winBg =
								sc && n
									? lerpHex(sc.lo, sc.hi, sc.max > sc.min ? (n.value - sc.min) / (sc.max - sc.min) : 0.5)
									: null;
						}
						const scb = scaleCtx.get(c);
						const bgOwned =
							parsed.bg != null &&
							(specs.some((s) => norm(s.bg) === norm(parsed.bg)) ||
								(scb != null && scaleOwns(parsed.bg, scb.lo, scb.hi)));
						const fgOwned = parsed.fg != null && specs.some((s) => norm(s.fg) === norm(parsed.fg));
						let nbg = parsed.bg;
						let nfg = parsed.fg;
						if (winBg) {
							if (parsed.bg == null || bgOwned) nbg = winBg;
						} else if (bgOwned) {
							nbg = null;
						}
						if (winner?.fg) {
							if (parsed.fg == null || fgOwned) nfg = winner.fg;
						} else if (fgOwned) {
							nfg = null;
						}
						if (norm(nbg) === norm(parsed.bg) && norm(nfg) === norm(parsed.fg)) continue;
						const rebuilt = buildCellContent(
							parsed.inner,
							nbg,
							nfg,
							parsed.calc,
							parsed.formula,
							parsed.borders,
							parsed.fmt,
							winBg && norm(nbg) === norm(winBg) ? false : parsed.hl,
							parsed.w,
							parsed.rule,
							parsed.tbl
						);
						r.pieces[c + 1] = rebuilt ? ` ${rebuilt} ` : "   ";
						changed = true;
					}
					if (changed) out.push({ line: li, text: r.prefix + r.pieces.join("|") });
				}
			}
		}
		i = end + 1;
	}
	return out;
}

/** Value fixpoint plus live-rule enforcement: the full document maintenance pass. */
export function recalcDocument(lines: string[]): { line: number; text: string }[] {
	const work = lines.slice();
	for (const e of recalcCalcs(work)) work[e.line] = e.text;
	for (const e of applyLiveRules(work)) work[e.line] = e.text;
	const out: { line: number; text: string }[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (work[i] !== lines[i]) out.push({ line: i, text: work[i] });
	}
	return out;
}

/** Sum/Avg/Count of the numeric cells in a multi-cell selection, for the stats chip. */
export function selectionStats(
	lines: string[],
	targets: { line: number; col: number }[]
): { count: number; sum: string; avg: string } | null {
	const nums: { value: number; decimals: number; currency: string }[] = [];
	for (const t of targets) {
		const r = parseRow(lines[t.line] ?? "");
		if (!r || r.isDelim || t.col >= r.cellCount) continue;
		const n = parseNumeric(parseCellContent(r.pieces[t.col + 1]).inner);
		if (n) nums.push(n);
	}
	if (nums.length < 2) return null;
	let decimals = 0;
	for (const n of nums) decimals = Math.max(decimals, n.decimals);
	decimals = Math.min(decimals, 4);
	const currency = nums.every((n) => n.currency && n.currency === nums[0].currency) ? nums[0].currency : "";
	const fmt = (v: number, dec: number) => (v < 0 ? "-" : "") + currency + Math.abs(v).toFixed(dec);
	const total = nums.reduce((a, n) => a + n.value, 0);
	return { count: nums.length, sum: fmt(total, decimals), avg: fmt(total / nums.length, Math.min(4, Math.max(decimals, 2))) };
}

/* ---------------- copy table as CSV ---------------- */

function csvDisplayText(piece: string): string {
	let v = parseCellContent(piece).inner;
	for (let i = 0; i < 3; i++) {
		v = v.replace(/^\*\*([\s\S]+)\*\*$/, "$1").replace(/^\*([^*]|[^*][\s\S]*[^*])\*$/, "$1").replace(/^~~([\s\S]+)~~$/, "$1");
	}
	v = v.replace(/\\\|/g, "|").trim();
	return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function tableToCsv(lines: string[], ln: number): string | null {
	const { start, end } = tableBounds(lines, ln);
	const out: string[] = [];
	for (let i = start; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (!r || r.isDelim) continue;
		out.push(Array.from({ length: r.cellCount }, (_, c) => csvDisplayText(r.pieces[c + 1])).join(","));
	}
	return out.length ? out.join("\n") : null;
}

/* ---------------- color math for the Office-style palette ---------------- */

export function hexToRgb(hex: string): [number, number, number] | null {
	const m = hex.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
	if (!m) return null;
	const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
	const n = parseInt(h, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
	const h = (v: number) =>
		Math.round(Math.max(0, Math.min(255, v)))
			.toString(16)
			.padStart(2, "0");
	return ("#" + h(r) + h(g) + h(b)).toUpperCase();
}

function mixToward(rgb: [number, number, number], target: number, f: number): string {
	return rgbToHex(
		rgb[0] + (target - rgb[0]) * f,
		rgb[1] + (target - rgb[1]) * f,
		rgb[2] + (target - rgb[2]) * f
	);
}

/**
 * Office-style tint/shade column for a theme color: light colors darken in
 * steps, dark colors lighten, and mid colors get 3 tints + 2 shades, the
 * same shape as Word's shading picker.
 */
export function shadeVariants(base: string): string[] {
	const rgb = hexToRgb(base);
	if (!rgb) return [base, base, base, base, base];
	const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
	if (lum >= 0.95) return [0.05, 0.15, 0.25, 0.35, 0.5].map((f) => mixToward(rgb, 0, f));
	if (lum <= 0.08) return [0.5, 0.35, 0.25, 0.15, 0.05].map((f) => mixToward(rgb, 255, f));
	if (lum >= 0.8) return [0.1, 0.25, 0.5, 0.75, 0.9].map((f) => mixToward(rgb, 0, f));
	return [
		mixToward(rgb, 255, 0.8),
		mixToward(rgb, 255, 0.6),
		mixToward(rgb, 255, 0.4),
		mixToward(rgb, 0, 0.25),
		mixToward(rgb, 0, 0.5),
	];
}

/* ---------------- checkboxes and column width ---------------- */

export const CHECKBOX_RE = /^\[( |x|X)\] ?/;

/** Add or remove a leading "[ ] " checkbox on the cell(s) at the given scope. */
export function planToggleCheckbox(lines: string[], target: CellTargetLoc, scope: Scope): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	let lineNos: number[] = [ln];
	if (scope === "column" || scope === "table") {
		const { start, end } = tableBounds(lines, ln);
		lineNos = [];
		for (let i = start; i <= end; i++) lineNos.push(i);
	}
	const edits: { line: number; text: string }[] = [];
	for (const li of lineNos) {
		const r = parseRow(lines[li]);
		if (!r || r.isDelim) continue;
		const cols =
			scope === "row" || scope === "table"
				? Array.from({ length: r.cellCount }, (_, i) => i)
				: target.col < r.cellCount
					? [target.col]
					: [];
		let changed = false;
		for (const c of cols) {
			const parsed = parseCellContent(r.pieces[c + 1]);
			const inner = CHECKBOX_RE.test(parsed.inner)
				? parsed.inner.replace(CHECKBOX_RE, "")
				: `[ ] ${parsed.inner}`.trimEnd();
			const rebuilt = buildCellContent(
				inner,
				parsed.bg,
				parsed.fg,
				parsed.calc,
				parsed.formula,
				parsed.borders,
				parsed.fmt,
				parsed.hl,
				parsed.w,
				parsed.rule,
				parsed.tbl
			);
			const next = rebuilt ? ` ${rebuilt} ` : "   ";
			if (next !== r.pieces[c + 1]) {
				r.pieces[c + 1] = next;
				changed = true;
			}
		}
		if (changed) edits.push({ line: li, text: r.prefix + r.pieces.join("|") });
	}
	const lnText = edits.find((e) => e.line === ln)?.text ?? lines[ln];
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lnText, target.col) };
}

/** Tick/untick the cell's leading checkbox (adds one when missing). */
export function planSetChecked(lines: string[], target: CellTargetLoc, checked: boolean): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const r = parseRow(lines[ln]);
	if (!r || r.isDelim) return null;
	const col = Math.min(target.col, r.cellCount - 1);
	const parsed = parseCellContent(r.pieces[col + 1]);
	const mark = checked ? "[x] " : "[ ] ";
	const inner = CHECKBOX_RE.test(parsed.inner)
		? parsed.inner.replace(CHECKBOX_RE, mark)
		: `${mark}${parsed.inner}`.trimEnd();
	const rebuilt = buildCellContent(
		inner,
		parsed.bg,
		parsed.fg,
		parsed.calc,
		parsed.formula,
		parsed.borders,
		parsed.fmt,
		parsed.hl,
		parsed.w,
		parsed.rule,
		parsed.tbl
	);
	r.pieces[col + 1] = ` ${rebuilt} `;
	const text = r.prefix + r.pieces.join("|");
	return { edits: text === lines[ln] ? [] : [{ line: ln, text }], cursorLine: ln, cursorCh: cursorForCol(text, col) };
}

/** Store (or clear, width=null) a column's pixel width as data-w on its header cell. */
export function planSetColumnWidth(lines: string[], target: CellTargetLoc, width: number | null): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const anchor = parseRow(lines[ln]);
	if (!anchor) return null;
	const col = Math.min(target.col, anchor.cellCount - 1);
	const { start, delimIdx } = tableBounds(lines, ln);
	const headerLn = delimIdx > start ? start : ln;
	const hr = parseRow(lines[headerLn]);
	if (!hr || hr.isDelim || col >= hr.cellCount) return null;
	const parsed = parseCellContent(hr.pieces[col + 1]);
	const w = width == null ? null : String(Math.max(48, Math.min(1200, Math.round(width))));
	if ((parsed.w ?? null) === w) return { edits: [], cursorLine: ln, cursorCh: cursorForCol(lines[ln], col) };
	const rebuilt = buildCellContent(
		parsed.inner,
		parsed.bg,
		parsed.fg,
		parsed.calc,
		parsed.formula,
		parsed.borders,
		parsed.fmt,
		parsed.hl,
		w,
		parsed.rule,
		parsed.tbl
	);
	hr.pieces[col + 1] = rebuilt ? ` ${rebuilt} ` : "   ";
	const text = hr.prefix + hr.pieces.join("|");
	return { edits: [{ line: headerLn, text }], cursorLine: ln, cursorCh: cursorForCol(lines[ln], col) };
}

/** Excel-style AutoFit: store a measured pixel width for every column in one
 *  header-row edit. widths[c] sizes column c (same 48..1200 clamp as a drag);
 *  a null/missing entry leaves that column's stored width untouched. */
export function planAutoFitColumnWidths(
	lines: string[],
	target: CellTargetLoc,
	widths: (number | null)[]
): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const { start, delimIdx } = tableBounds(lines, ln);
	const hr = parseRow(lines[delimIdx > start ? start : ln]);
	if (!hr || hr.isDelim) return null;
	const targets: CellTargetLoc[] = [];
	for (let c = 0; c < Math.min(widths.length, hr.cellCount); c++) {
		if (widths[c] != null) targets.push({ line: ln, col: c, expect: null });
	}
	if (!targets.length) return null;
	const plan = planMulti(lines, targets, (ls, t) => planSetColumnWidth(ls, t, widths[t.col]));
	// keep the cursor in the cell the action started from, not the last column set
	return plan && { ...plan, cursorLine: ln, cursorCh: cursorForCol(lines[ln], target.col) };
}

/* ---------------- per-table appearance flags ---------------- */

export const TABLE_FLAGS = ["guides", "striped", "compact", "headerfill", "sticky", "filters"] as const;
export type TableFlag = (typeof TABLE_FLAGS)[number];

/** Decode a data-tbl tag: "striped,noguides" → { striped: true, guides: false }. */
export function parseTableFlagTag(tag: string): Partial<Record<TableFlag, boolean>> {
	const out: Partial<Record<TableFlag, boolean>> = {};
	for (const tok of tag.split(",")) {
		const s = tok.trim().toLowerCase();
		const off = s.startsWith("no");
		const key = (off ? s.slice(2) : s) as TableFlag;
		if ((TABLE_FLAGS as readonly string[]).includes(key)) out[key] = !off;
	}
	return out;
}

/** Encode a flag map back to a data-tbl tag; null when nothing is overridden. */
export function tableFlagTag(flags: Partial<Record<TableFlag, boolean>>): string | null {
	const toks: string[] = [];
	for (const f of TABLE_FLAGS) {
		if (flags[f] === true) toks.push(f);
		else if (flags[f] === false) toks.push("no" + f);
	}
	return toks.length ? toks.join(",") : null;
}

/** Per-table appearance overrides stored on the target table's header row. */
export function tableFlagsAt(lines: string[], target: CellTargetLoc): Partial<Record<TableFlag, boolean>> {
	const ln = locateLine(lines, target);
	if (ln == null) return {};
	const { start, delimIdx } = tableBounds(lines, ln);
	if (delimIdx <= start) return {};
	const hr = parseRow(lines[start]);
	if (!hr || hr.isDelim) return {};
	for (let c = 0; c < hr.cellCount; c++) {
		const tbl = parseCellContent(hr.pieces[c + 1]).tbl;
		if (tbl) return parseTableFlagTag(tbl);
	}
	return {};
}

/** Set (true/false) or clear (null) one per-table appearance override. The tag
 *  lives on whichever header cell already holds one, else the first, so it
 *  rides along through sorts and column moves like the other header markers. */
export function planSetTableFlag(
	lines: string[],
	target: CellTargetLoc,
	flag: TableFlag,
	value: boolean | null
): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const { start, delimIdx } = tableBounds(lines, ln);
	if (delimIdx <= start) return null;
	const hr = parseRow(lines[start]);
	if (!hr || hr.isDelim) return null;
	let cell = 0;
	for (let c = 0; c < hr.cellCount; c++) {
		if (parseCellContent(hr.pieces[c + 1]).tbl) {
			cell = c;
			break;
		}
	}
	const parsed = parseCellContent(hr.pieces[cell + 1]);
	const flags = parsed.tbl ? parseTableFlagTag(parsed.tbl) : {};
	if (value == null) delete flags[flag];
	else flags[flag] = value;
	const tag = tableFlagTag(flags);
	if ((parsed.tbl ?? null) === tag) {
		return { edits: [], cursorLine: ln, cursorCh: cursorForCol(lines[ln], target.col) };
	}
	const rebuilt = buildCellContent(
		parsed.inner,
		parsed.bg,
		parsed.fg,
		parsed.calc,
		parsed.formula,
		parsed.borders,
		parsed.fmt,
		parsed.hl,
		parsed.w,
		parsed.rule,
		tag
	);
	hr.pieces[cell + 1] = rebuilt ? ` ${rebuilt} ` : "   ";
	return {
		edits: [{ line: start, text: hr.prefix + hr.pieces.join("|") }],
		cursorLine: ln,
		cursorCh: cursorForCol(lines[ln], target.col),
	};
}

/* ---------------- selection AutoSum: Sum/Avg/... over a drag-selected range ---------------- */

/**
 * Excel-style AutoSum for a multi-cell selection: the result is a live range
 * formula (=SUM(B4:B5)) written into the selection's last empty cell, or into
 * the empty cell just below the selection when every selected cell has a
 * value. count -1 means no result cell was available; 0 means the selection
 * held no numbers. The result cell is trimmed off the range when that keeps
 * a clean rectangle; self-exclusion covers the rest.
 */
export function planSelectionCalc(
	lines: string[],
	targets: { line: number; col: number }[],
	fn: CalcFn
): (EditPlan & { formatted: string; count: number; ref: string }) | null {
	if (!targets.length) return null;
	const ln0 = targets[0].line;
	const { end, delimIdx } = tableBounds(lines, ln0);
	if (delimIdx < 0) return null;
	const bodyStart = delimIdx + 1;
	const cells = targets.filter((t) => t.line >= bodyStart && t.line <= end);
	if (!cells.length) return null;
	const r1 = Math.min(...cells.map((t) => t.line));
	const r2 = Math.max(...cells.map((t) => t.line));
	const c1 = Math.min(...cells.map((t) => t.col));
	const c2 = Math.max(...cells.map((t) => t.col));

	const emptyAt = (line: number, col: number): boolean => {
		const r = parseRow(lines[line]);
		if (!r || r.isDelim || col >= r.cellCount) return false;
		return parseCellContent(r.pieces[col + 1]).inner.trim() === "";
	};

	let result: { line: number; col: number } | null = null;
	for (const t of [...cells].sort((a, b) => a.line - b.line || a.col - b.col)) {
		if (emptyAt(t.line, t.col)) result = { line: t.line, col: t.col };
	}
	if (!result && r2 + 1 <= end && emptyAt(r2 + 1, c2)) result = { line: r2 + 1, col: c2 };
	if (!result) return { edits: [], cursorLine: ln0, cursorCh: 0, formatted: "", count: -1, ref: "" };

	let rr2 = r2;
	let cc2 = c2;
	if (c1 === c2 && result.col === c1 && result.line === r2) rr2 = r2 - 1;
	else if (r1 === r2 && result.line === r1 && result.col === c2) cc2 = c2 - 1;
	if (rr2 < r1 || cc2 < c1) return { edits: [], cursorLine: ln0, cursorCh: 0, formatted: "", count: 0, ref: "" };

	const refOf = (line: number, col: number) => `${colLetterOf(col)}${line - delimIdx}`;
	const a = refOf(r1, c1);
	const b = refOf(rr2, cc2);
	const range = a === b ? a : `${a}:${b}`;

	const grid = tableGrid(lines, ln0);
	if (!grid) return null;
	let count = 0;
	for (let l = r1; l <= rr2; l++) {
		for (let c = c1; c <= cc2; c++) {
			if (l === result.line && c === result.col) continue;
			if (parseNumeric(grid.rows[l - bodyStart]?.[c] ?? "")) count++;
		}
	}
	if (!count) return { edits: [], cursorLine: ln0, cursorCh: 0, formatted: "", count: 0, ref: range };

	const formula = `=${fn.toUpperCase()}(${range})`;
	const base = planSetCellValue(lines, { line: result.line, col: result.col, expect: null }, formula);
	if (!base) return null;
	let formatted = "";
	const edited = base.edits.find((e) => e.line === result.line);
	if (edited) {
		const r = parseRow(edited.text);
		if (r) formatted = parseCellContent(r.pieces[Math.min(result.col, r.cellCount - 1) + 1]).inner;
	}
	return { ...base, formatted, count, ref: range };
}

/* ---------------- prettify: re-pad cells so the raw pipes line up ---------------- */

/**
 * Reformat the table's raw markdown the way Obsidian's own editor does:
 * every cell padded to its column's widest content, delimiter dashes
 * stretched to match, right/center alignment reflected in the padding, and
 * ragged rows normalized to the full column count. Purely cosmetic in the
 * source; rendering is unchanged.
 */
export function planPrettify(lines: string[], target: CellTargetLoc): (EditPlan & { rows: number }) | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const { start, end, delimIdx } = tableBounds(lines, ln);
	if (delimIdx < 0) return null;

	const dr = parseRow(lines[delimIdx])!;
	const aligns: ("left" | "center" | "right" | "none")[] = [];
	for (let c = 0; c < dr.cellCount; c++) {
		const p = dr.pieces[c + 1].trim();
		const l = p.startsWith(":");
		const r = p.endsWith(":");
		aligns.push(l && r ? "center" : r ? "right" : l ? "left" : "none");
	}

	const widths: number[] = [];
	for (let i = start; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (!r || r.isDelim) continue;
		for (let c = 0; c < r.cellCount; c++) {
			widths[c] = Math.max(widths[c] ?? 3, r.pieces[c + 1].trim().length, 3);
		}
	}
	if (!widths.length) return null;

	const edits: { line: number; text: string }[] = [];
	let rows = 0;
	for (let i = start; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (!r) continue;
		const cells: string[] = [];
		for (let c = 0; c < widths.length; c++) {
			const w = widths[c];
			const a = aligns[c] ?? "none";
			if (r.isDelim) {
				let bar = "-".repeat(w);
				if (a === "left") bar = ":" + "-".repeat(Math.max(1, w - 1));
				else if (a === "right") bar = "-".repeat(Math.max(1, w - 1)) + ":";
				else if (a === "center") bar = ":" + "-".repeat(Math.max(1, w - 2)) + ":";
				cells.push(` ${bar} `);
			} else {
				const content = c < r.cellCount ? r.pieces[c + 1].trim() : "";
				const pad = Math.max(0, w - content.length);
				if (a === "right") cells.push(` ${" ".repeat(pad)}${content} `);
				else if (a === "center") {
					cells.push(` ${" ".repeat(Math.floor(pad / 2))}${content}${" ".repeat(Math.ceil(pad / 2))} `);
				} else cells.push(` ${content}${" ".repeat(pad)} `);
			}
		}
		const text = r.prefix + "|" + cells.join("|") + "|";
		if (text !== lines[i]) {
			edits.push({ line: i, text });
			rows++;
		}
	}
	return { edits, cursorLine: ln, cursorCh: 2, rows };
}

/**
 * Merge our settings over what is on disk RIGHT NOW, for a save.
 *
 * data.json is synced. Other devices write it, and a device that has been idle
 * still holds whatever it read when its plugin loaded, so writing that whole
 * object back reverts every change made anywhere else since. Settings that are
 * set once and never touched again are the casualty: nothing rewrites them
 * afterwards, so a single revert loses them for good and silently.
 *
 * A save may only carry the keys we changed. `baseline` is the state we last
 * read from or wrote to disk, so anything differing from it is ours: those
 * overwrite. Every untouched key takes the disk's value. A key absent from disk
 * was written by a version that did not know it, and keeps ours rather than
 * resetting to a default.
 */
export function mergeForSave<T extends object>(ours: T, baseline: T, disk: Partial<T> | null): T {
	const out = { ...ours };
	if (!disk) return out;
	for (const k of Object.keys(ours) as (keyof T)[]) {
		if (!(k in disk)) continue; // disk has never heard of this key; ours stands
		const o = ours[k];
		const b = baseline[k];
		const d = disk[k];
		if (isRecord(o) && isRecord(b) && isRecord(d)) {
			out[k] = mergeEntries(o, b, d) as T[keyof T];
			continue;
		}
		const changedByUs = JSON.stringify(o) !== JSON.stringify(b);
		if (!changedByUs) out[k] = d as T[keyof T];
	}
	return out;
}

/** A per-item map, as opposed to a value that means something whole. Arrays are
 *  values here: a list's order and membership are the thing itself. */
function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The same three-way rule, entry by entry.
 *
 * A key holding one value per item (per folder, per field, per speaker) is a
 * whole vault's worth of settings behind a single name, and merging it whole
 * meant changing ONE of them published all of them. Every item another device
 * configured since this one last read was erased by a device that had never
 * seen it.
 *
 * Start from the disk, so anything another device set survives; drop only what
 * we deliberately removed (present in the baseline, gone from ours); then lay
 * our own changed entries over the top. Two devices editing the SAME item still
 * settles last-writer-wins, but that is one item losing a race rather than
 * everything losing it.
 */
function mergeEntries(
	ours: Record<string, unknown>,
	baseline: Record<string, unknown>,
	disk: Record<string, unknown>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(disk)) {
		const removedByUs = k in baseline && !(k in ours);
		if (!removedByUs) out[k] = disk[k];
	}
	for (const k of Object.keys(ours)) {
		const changedByUs = JSON.stringify(ours[k]) !== JSON.stringify(baseline[k]);
		if (changedByUs || !(k in disk)) out[k] = ours[k];
	}
	return out;
}
