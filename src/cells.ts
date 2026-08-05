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
	/** Edge letters as stored in data-b. Same three-way convention as bg. Only
	 *  the format painter sets these; the border tool has its own scoped plan. */
	borders?: string | null;
	/** Number format as stored in data-fmt, same three-way convention. */
	fmt?: string | null;
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

const SPAN_RE = /^\s*<span class="(ptb[^"]*)"((?:\s+(?:style|data-sum|data-calc|data-f|data-b|data-fmt|data-w|data-rule|data-tbl|data-flt|data-list)="[^"]*")*)\s*>([\s\S]*)<\/span>\s*$/;

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
	flt: string | null;
	list: string | null;
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
			flt: null,
			list: null,
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
	const flt = attrs.match(/data-flt="([^"]*)"/)?.[1] || null;
	const list = attrs.match(/data-list="([^"]*)"/)?.[1] || null;
	return { bg, fg, calc, formula, borders, fmt, hl, w, rule, tbl, flt, list, inner: m[3] };
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
	tbl: string | null = null,
	flt: string | null = null,
	list: string | null = null
): string {
	// edge letters, the weight markers "=~.", and a "#colour" suffix all have
	// to survive the scrub; it exists to keep quotes and markup out, not to
	// validate, which mergeBorders already did
	const b = borders ? borders.replace(/[^a-zA-Z=~.#]/g, "") : "";
	const width = w && /^\d{2,4}$/.test(w) ? w : null;
	if (!bg && !fg && !calc && !formula && !b && !fmt && !width && !rule && !tbl && !flt && !list) return inner;
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
	if (flt) attrs += ` data-flt="${flt.replace(/"/g, "")}"`;
	if (list) attrs += ` data-list="${list.replace(/"/g, "")}"`;
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
				// borders and number format travel only when the patch mentions them,
				// so every existing caller keeps preserving whatever the cell already had
				const nborders = patch.borders === undefined ? parsed.borders : patch.borders;
				const nfmt = patch.fmt === undefined ? parsed.fmt : patch.fmt;
			const next = ` ${buildCellContent(parsed.inner, nbg, nfg, parsed.calc, parsed.formula, nborders, nfmt, nhl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
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
		rowLn.pieces[col + 1] = ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, null, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
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
	rowLn.pieces[col + 1] = ` ${buildCellContent(res.formatted, parsed.bg, parsed.fg, spec, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
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
	rowLn.pieces[col + 1] = ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, null, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
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
			let grid: Grid | null | undefined;
			// both are per-line caches: one table's grid and the rows its filters
			// are hiding, worked out once for however many formulas the line holds
			let hidden: ReadonlySet<number> | undefined;
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
					r.pieces[c + 1] = ` ${buildCellContent(wrapped, parsed.bg, st.fg, parsed.calc, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
					lineChanged = true;
					continue;
				}
				// live formula cells recompute; plain "=…" cells convert into them
				const formula = parsed.formula ?? (looksLikeFormula(parsed.inner) ? parsed.inner : null);
				if (!formula) continue;
				if (grid === undefined) grid = tableGrid(work, i);
				if (!grid) continue;
				if (hidden === undefined) hidden = filteredRows(work, i);
				let value = "#ERR";
				try {
					value = formatFormulaResult(evalFormula(formula, grid.rows, gridRowOf(grid, i), c, hidden));
				} catch (e) {
					value = formulaErrorText(e);
				}
				const st = styleLiveValue(work, i, c, parsed, value);
				const emf = splitEmphasis(parsed.formula ? parsed.inner : "");
				const wrappedF = emf.lead + st.text + emf.trail;
				if (parsed.formula && wrappedF === parsed.inner && st.fg === parsed.fg) continue;
				r.pieces[c + 1] = ` ${buildCellContent(wrappedF, parsed.bg, st.fg, null, formula, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
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
	// a sort is a permutation of the body rows: a formula that moved keeps
	// pointing at the cells it pointed at, and a pinned total keeps covering the
	// same block, because the block's ends permute within it
	const hdr = gridRowOfLine(lines, start, bodyStart);
	const map = Array.from({ length: hdr + rows.length }, (_, i) => i);
	newOrder.forEach((r, k) => {
		map[hdr + (r.idx - bodyStart)] = hdr + k;
	});
	const shifted = withRefShift(lines, edits, { start, end }, { axis: "row", kind: "permute", map });
	const cursorLine = Math.min(Math.max(ln, bodyStart), end);
	return { edits: shifted, cursorLine, cursorCh: cursorForCol(lines[cursorLine], col), rows: sortable.length };
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
	const map = Array.from({ length: gridRowOfLine(lines, start, end + 1) }, (_, i) => i);
	const a = gridRowOfLine(lines, start, ln);
	const b = gridRowOfLine(lines, start, to);
	map[a] = b;
	map[b] = a;
	const shifted = withRefShift(lines, edits, { start, end }, { axis: "row", kind: "permute", map });
	return { edits: shifted, cursorLine: to, cursorCh: cursorForCol(lines[ln], col) };
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
	const map = Array.from({ length: Math.max(anchor.cellCount, col + 1, to + 1) }, (_, i) => i);
	map[col] = to;
	map[to] = col;
	const shifted = withRefShift(lines, edits, { start, end }, { axis: "col", kind: "permute", map });
	const lnText = shifted.find((e) => e.line === ln)?.text ?? lines[ln];
	return { edits: shifted, cursorLine: ln, cursorCh: cursorForCol(lnText, to) };
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
			const next = ` ${buildCellContent(toggleMark(parsed.inner, style), parsed.bg, parsed.fg, parsed.calc, parsed.formula, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
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

/** The |---| row of the table holding this line, or -1 when it has none. */
function delimIndexAt(lines: string[], ln: number): number {
	let start = ln;
	let end = ln;
	while (start > 0 && parseRow(lines[start - 1])) start--;
	while (end < lines.length - 1 && parseRow(lines[end + 1])) end++;
	for (let i = start; i <= end; i++) {
		if (parseRow(lines[i])?.isDelim) return i;
	}
	return -1;
}

/**
 * The alignment written on the target's column, or null when its delimiter
 * carries no colons.
 *
 * Unmarked and left are different source even though markdown renders them the
 * same, and a menu that ticks one of three boxes has to be describing the
 * source: ticking "Align left" on a column nobody has aligned would say an
 * edit had already been made when none has.
 */
export function columnAlign(lines: string[], target: CellTargetLoc): ColAlign | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const delimIdx = delimIndexAt(lines, ln);
	if (delimIdx < 0) return null;
	const r = parseRow(lines[delimIdx])!;
	const cell = r.pieces[Math.min(target.col, r.cellCount - 1) + 1].trim();
	const lead = cell.startsWith(":");
	const trail = cell.endsWith(":");
	if (lead && trail) return "center";
	if (lead) return "left";
	if (trail) return "right";
	return null;
}

/** Set the markdown alignment (delimiter-row colons) for the target's column. */
export function planAlign(lines: string[], target: CellTargetLoc, align: ColAlign): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const delimIdx = delimIndexAt(lines, ln);
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

/** "bare" is a URL typed straight into the cell with no markup at all, which
 *  Obsidian still renders as a link. It has no label of its own: the text and
 *  the target are the same string, so editing one moves both. */
export type CellLinkKind = "md" | "wiki" | "bare";
export type CellLink = { label: string; url: string; kind: CellLinkKind };

/** A cell whose whole value is one link, in any of the three forms a table
 *  cell can hold one. A cell with text around the link does not count:
 *  rewriting that would mean guessing which part the user meant. */
export function parseCellLink(raw: string): CellLink | null {
	const s = raw.trim();
	const wiki = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(s);
	if (wiki) return { label: (wiki[2] ?? wiki[1]).trim(), url: wiki[1].trim(), kind: "wiki" };
	// the target is matched greedily so a ")" of its own, as in a Wikipedia
	// title, stays part of the URL instead of cutting it short
	const md = /^\[([^\]]*)\]\((.*)\)$/.exec(s);
	if (md) return { label: md[1].trim(), url: md[2].trim(), kind: "md" };
	// pasting a URL into a cell is how most of them get there, and the result
	// is a working link with no brackets anywhere for a parser to find
	if (/^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)[^\s|<>]+$/i.test(s)) return { label: s, url: s, kind: "bare" };
	return null;
}

/** The markdown for a link, in the flavor asked for. Editing a wikilink writes
 *  a wikilink back: the form a cell is already in is the form its author chose. */
export function buildCellLink(label: string, url: string, kind: CellLinkKind = "md"): string {
	if (kind === "wiki") return label && label !== url ? `[[${url}|${label}]]` : `[[${url}]]`;
	// a plain URL is only plain while it is its own text; giving it text of its
	// own is exactly what turns it into a link with a label
	if (kind === "bare" && label === url) return url;
	return `[${label}](${url})`;
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
				next = ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, parsed.calc, parsed.formula, parsed.borders, tag, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
			} else if (fmt === "date") {
				const p = parseDateCell(parsed.inner.trim());
				if (!p) continue;
				next = ` ${buildCellContent(formatDateSpec(p, "mdy"), parsed.bg, parsed.fg, null, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
			} else {
				const n = parseNumeric(parsed.inner);
				if (!n) continue;
				next = ` ${buildCellContent(formatValue(n.value, n.decimals, fmt), parsed.bg, parsed.fg, null, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
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
	return ` ${buildCellContent(em.lead + text + em.trail, parsed.bg, fg, null, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
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
						: ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, parsed.calc, parsed.formula, parsed.borders, tag, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
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
export const FMT_DEFAULTS: Omit<FmtSpec, "kind"> = {
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
			r.pieces[c + 1] = ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, parsed.calc, parsed.formula, parsed.borders, want, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
			changed = true;
		}
	} else {
		const col = Math.min(target.col, r.cellCount - 1);
		const parsed = parseCellContent(r.pieces[col + 1]);
		if ((parsed.fmt ?? null) !== tag) {
			r.pieces[col + 1] = ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, parsed.calc, parsed.formula, parsed.borders, tag, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
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

export type BorderAction =
	| "top"
	| "bottom"
	| "left"
	| "right"
	| "none"
	| "all"
	| "outside"
	| "thickoutside"
	/* Excel's stacked presets, compositions of the edges above */
	| "thickbottom"
	| "doublebottom"
	| "topbottom"
	| "topthickbottom"
	| "topdoublebottom";

export type Edge = "top" | "bottom" | "left" | "right";
/** What an edge is drawn with. Thin and thick were the original two; the rest
 *  are Excel's, and each needed a marker of its own in the stored string. */
export type EdgeWeight = "thin" | "thick" | "double" | "dashed" | "dotted";
/** Marker written before an edge's letter. Thin has none and thick is the
 *  letter in uppercase, which is how the original two were stored. */
const WEIGHT_MARK: Record<EdgeWeight, string> = {
	thin: "",
	thick: "",
	double: "=",
	dashed: "~",
	dotted: ".",
};
const MARK_WEIGHT: Record<string, EdgeWeight> = { "=": "double", "~": "dashed", ".": "dotted" };

/** The pen colours Draw Borders offers. Names rather than hex, because the
 *  edges are painted by CSS off the attribute and CSS cannot read an arbitrary
 *  value out of one; a fixed set keeps the note portable and readable. */
export const BORDER_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "grey"] as const;
export type BorderColor = (typeof BORDER_COLORS)[number];

/** Split a border string into its edges and its optional "#colour" suffix. */
export function splitBorders(s: string | null): { edges: string; color: BorderColor | null } {
	if (!s) return { edges: "", color: null };
	const at = s.indexOf("#");
	if (at < 0) return { edges: s, color: null };
	const name = s.slice(at + 1);
	return {
		edges: s.slice(0, at),
		color: (BORDER_COLORS as readonly string[]).includes(name) ? (name as BorderColor) : null,
	};
}
const EDGE_CHARS: Record<Edge, string> = { top: "t", bottom: "b", left: "l", right: "r" };

/** The stacked presets, as the edges and weights they stand for. */
const STACKED: Partial<Record<BorderAction, { top?: EdgeWeight; bottom?: EdgeWeight }>> = {
	thickbottom: { bottom: "thick" },
	doublebottom: { bottom: "double" },
	topbottom: { top: "thin", bottom: "thin" },
	topthickbottom: { top: "thin", bottom: "thick" },
	topdoublebottom: { top: "thin", bottom: "double" },
};

/**
 * Merge edges into a border string. One letter per edge in canonical order
 * t, b, l, r: lowercase thin, uppercase thick, and "=" ahead of the letter for
 * double, so "t=b" is a thin top over a double bottom.
 *
 * The "=" prefix rather than a new letter is deliberate: "=b" still contains
 * "b", so the CSS that paints a bottom edge keeps matching and the double rule
 * only overrides its style and width. Strings written by older versions parse
 * unchanged.
 */
export function mergeBorders(
	existing: string | null,
	add: { edge: Edge; weight: EdgeWeight }[],
	color?: BorderColor | null
): string | null {
	const prev = splitBorders(existing);
	const state = new Map<string, EdgeWeight>();
	const s = prev.edges;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		const marked = MARK_WEIGHT[ch];
		if (marked) {
			const next = s[i + 1]?.toLowerCase();
			if (next && "tblr".includes(next)) {
				state.set(next, marked);
				i++;
			}
			continue;
		}
		const lower = ch.toLowerCase();
		if ("tblr".includes(lower)) state.set(lower, ch === lower ? "thin" : "thick");
	}
	for (const a of add) state.set(EDGE_CHARS[a.edge], a.weight);
	let out = "";
	for (const c of ["t", "b", "l", "r"]) {
		const w = state.get(c);
		if (!w) continue;
		out += w === "thick" ? c.toUpperCase() : WEIGHT_MARK[w] + c;
	}
	if (!out) return null;
	// undefined leaves the colour as it was; null clears it back to default
	const keep = color === undefined ? prev.color : color;
	return keep ? `${out}#${keep}` : out;
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
				const weight: EdgeWeight = action === "thickoutside" ? "thick" : "thin";
				const adds: { edge: Edge; weight: EdgeWeight }[] = [];
				if (firstRow) adds.push({ edge: "top", weight });
				if (lastRow) adds.push({ edge: "bottom", weight });
				if (firstCol) adds.push({ edge: "left", weight });
				if (lastCol) adds.push({ edge: "right", weight });
				nb = adds.length ? mergeBorders(parsed.borders, adds) : parsed.borders;
			} else if (STACKED[action]) {
				// a top and/or a bottom on the selection's outer rows, each with
				// its own weight
				const spec = STACKED[action];
				const adds: { edge: Edge; weight: EdgeWeight }[] = [];
				if (spec.top && firstRow) adds.push({ edge: "top", weight: spec.top });
				if (spec.bottom && lastRow) adds.push({ edge: "bottom", weight: spec.bottom });
				nb = adds.length ? mergeBorders(parsed.borders, adds) : parsed.borders;
			} else {
				const onSide =
					action === "top" ? firstRow : action === "bottom" ? lastRow : action === "left" ? firstCol : lastCol;
				nb = onSide
					? mergeBorders(parsed.borders, [{ edge: action as Edge, weight: "thin" }])
					: parsed.borders;
			}
			const next = ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, parsed.calc, parsed.formula, nb, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
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

/**
 * The pen behind Draw Borders. Where planBorders reasons about a scope and
 * works out which cells sit on which side of it, this takes the cells and edges
 * the pointer actually touched and does exactly that, once, for the whole
 * stroke: a drag is one edit rather than one per cell.
 */
export function planDrawBorders(
	lines: string[],
	strokes: { line: number; col: number; edge?: Edge }[],
	pen: { tool: "border" | "grid" | "erase"; weight: EdgeWeight; color: BorderColor | null }
): EditPlan | null {
	if (!strokes.length) return null;
	// gather by line so a row is parsed and rewritten once however many of its
	// cells the stroke crossed
	const byLine = new Map<number, { line: number; col: number; edge?: Edge }[]>();
	for (const s of strokes) {
		const list = byLine.get(s.line) ?? [];
		list.push(s);
		byLine.set(s.line, list);
	}
	const edits: { line: number; text: string }[] = [];
	for (const [li, hits] of byLine) {
		const r = parseRow(lines[li]);
		if (!r || r.isDelim) continue;
		let changed = false;
		for (const hit of hits) {
			const c = hit.col;
			if (c < 0 || c >= r.cellCount) continue;
			const parsed = parseCellContent(r.pieces[c + 1]);
			let nb: string | null;
			if (pen.tool === "erase") nb = null;
			else if (pen.tool === "grid") {
				nb = mergeBorders(
					parsed.borders,
					(["top", "bottom", "left", "right"] as Edge[]).map((edge) => ({ edge, weight: pen.weight })),
					pen.color
				);
			} else {
				if (!hit.edge) continue;
				nb = mergeBorders(parsed.borders, [{ edge: hit.edge, weight: pen.weight }], pen.color);
			}
			const next = ` ${buildCellContent(parsed.inner, parsed.bg, parsed.fg, parsed.calc, parsed.formula, nb, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
			if (next !== r.pieces[c + 1]) {
				r.pieces[c + 1] = next;
				changed = true;
			}
		}
		if (changed) edits.push({ line: li, text: r.prefix + r.pieces.join("|") });
	}
	if (!edits.length) return null;
	const first = strokes[0];
	return { edits, cursorLine: first.line, cursorCh: 0 };
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
	const { start, end, delimIdx } = tableBounds(lines, ln);
	// header target: new rows always go just below the delimiter
	let at = where === "above" ? ln : ln + 1;
	if (delimIdx >= 0 && at <= delimIdx) at = delimIdx + 1;
	const text = emptyRow(r.prefix, r.cellCount);
	const edits = withRefShift(lines, [{ line: at, text, kind: "insert" }], { start, end }, {
		axis: "row",
		kind: "insert",
		at: gridRowOfLine(lines, start, at),
	});
	return { edits, cursorLine: at, cursorCh: cursorForCol(text, Math.min(target.col, r.cellCount - 1)) };
}

/**
 * Append a live totals row: "Total" under the first column and a live column
 * sum under every other column with numeric cells. If the table's body already
 * holds a column-wise live calc (an existing totals row), nothing is added.
 *
 * Over a table that is filtering, the sums are written as `SUBTOTAL(9, …)`
 * instead, which is what AutoSum does in Excel for the same reason: a totals
 * row under a filtered table that reported the whole column would disagree with
 * every number above it. Turning a filter on afterwards does not rewrite a
 * totals row that is already there; that is the user's formula to change.
 */
export function planTotalsRow(lines: string[], target: CellTargetLoc): (EditPlan & { added: number }) | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const { start, end, delimIdx } = tableBounds(lines, ln);
	if (delimIdx < 0 || delimIdx >= end) return null;
	const hr = parseRow(lines[start]);
	if (!hr || hr.isDelim) return null;
	const none = { edits: [], cursorLine: ln, cursorCh: cursorForCol(lines[ln], target.col), added: 0 };
	// Array(n).fill() is typed any[]; build it with a factory so the element
	// type is real
	const numeric: boolean[] = Array.from({ length: hr.cellCount }, () => false);
	for (let i = delimIdx + 1; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (!r || r.isDelim) continue;
		for (let c = 0; c < Math.min(r.cellCount, hr.cellCount); c++) {
			const parsed = parseCellContent(r.pieces[c + 1]);
			if (parsed.calc?.dir === "column") return none;
			if (!parsed.calc && parseNumeric(parsed.inner)) numeric[c] = true;
		}
	}
	// body rows in formula numbering, where the header is row 1: the range has
	// to stop above the totals row about to be appended
	let bodyRows = 0;
	for (let i = delimIdx + 1; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (r && !r.isDelim) bodyRows++;
	}
	const filtering = Array.from({ length: hr.cellCount }, (_, c) => parseCellContent(hr.pieces[c + 1]).flt).some(Boolean);

	const pieces = [""];
	let added = 0;
	for (let c = 0; c < hr.cellCount; c++) {
		if (c === 0) pieces.push(" Total ");
		else if (numeric[c]) {
			const letter = colLetterOf(c);
			pieces.push(
				filtering
					? ` ${buildCellContent("0", null, null, null, `=SUBTOTAL(9,${letter}2:${letter}${bodyRows + 1})`)} `
					: ` ${buildCellContent("0", null, null, { fn: "sum", dir: "column" })} `
			);
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
	const { start, end, delimIdx } = tableBounds(lines, ln);
	if (delimIdx >= 0 && ln < delimIdx) return { edits: [], cursorLine: ln, cursorCh: 0 };
	const edits = withRefShift(lines, [{ line: ln, text: "", kind: "delete" }], { start, end }, {
		axis: "row",
		kind: "delete",
		at: gridRowOfLine(lines, start, ln),
	});
	return { edits, cursorLine: Math.max(0, ln - 1), cursorCh: 2 };
}

export function planDuplicateRow(lines: string[], target: CellTargetLoc): EditPlan | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const r = parseRow(lines[ln]);
	if (!r || r.isDelim) return null;
	const { start, end } = tableBounds(lines, ln);
	// the copy lands one row down, so its own refs move one row down with it:
	// that is the relative rule, and it is why the copy is shifted by offset
	// while every other row is shifted by the insert.
	const copy = shiftRowFormulas(lines[ln], { axis: "row", kind: "offset", delta: 1 });
	const edits = withRefShift(lines, [{ line: ln + 1, text: copy, kind: "insert" }], { start, end }, {
		axis: "row",
		kind: "insert",
		at: gridRowOfLine(lines, start, ln + 1),
	});
	return {
		edits,
		cursorLine: ln + 1,
		cursorCh: cursorForCol(copy, Math.min(target.col, r.cellCount - 1)),
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
	const shifted = withRefShift(lines, edits, { start, end }, { axis: "col", kind: "insert", at: to });
	const lnText = shifted.find((e) => e.line === ln)?.text ?? lines[ln];
	return { edits: shifted, cursorLine: ln, cursorCh: cursorForCol(lnText, to) };
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
	const shifted = withRefShift(lines, edits, { start, end }, { axis: "col", kind: "delete", at: col });
	const lnText = shifted.find((e) => e.line === ln)?.text ?? lines[ln];
	return { edits: shifted, cursorLine: ln, cursorCh: cursorForCol(lnText, Math.max(0, col - 1)) };
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
			const rebuilt = buildCellContent("", parsed.bg, parsed.fg, null, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list);
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

/** A table's cell texts, header row included, with the source line each row
 *  came from. Delimiter lines are not rows and appear in neither array. */
export type Grid = { rows: string[][]; lineNos: number[] };

/**
 * Cell texts for the table containing line `ln`, header row included as row 0.
 * That is what makes refs Excel-literal: A1 is column A's header cell and A2 is
 * its first data row, so the numbers in a formula match the numbers in the
 * gutter and match what the same table would be in a spreadsheet.
 */
export function tableGrid(lines: string[], ln: number): Grid | null {
	const { start, end, delimIdx } = tableBounds(lines, ln);
	if (delimIdx < 0) return null;
	const rows: string[][] = [];
	const lineNos: number[] = [];
	for (let i = start; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (!r || r.isDelim) continue;
		rows.push(Array.from({ length: r.cellCount }, (_, c) => parseCellContent(r.pieces[c + 1]).inner));
		lineNos.push(i);
	}
	return { rows, lineNos };
}

/** The grid row index of a source line, or -1 when that line is not a row of
 *  this table (a delimiter, or outside it). Row 0 is the header. */
export function gridRowOf(g: Grid, line: number): number {
	return g.lineNos.indexOf(line);
}

/** A rectangular block of one table in grid coordinates; row 0 is the header.
 *  Corners come in whatever order the gesture touched them. */
export type CellBlock = { r1: number; r2: number; c1: number; c2: number };

/**
 * Where Ctrl+Arrow lands: Excel's jump to the edge of the data.
 *
 * The rule is the one people have in their fingers even when they cannot say
 * it. From a cell whose neighbour holds something, travel to the last cell of
 * that run. From one whose neighbour is empty, jump the gap and land on the
 * next thing there is. With nothing left in that direction, go to the edge, so
 * the key always moves and the table always has a far side.
 *
 * `grid` is text only, so it can be built from the file or from the screen and
 * neither has to explain itself here.
 */
export function edgeInDirection(
	grid: string[][],
	r: number,
	c: number,
	dr: number,
	dc: number
): { r: number; c: number } {
	const rows = grid.length;
	if (!rows) return { r, c };
	const cols = grid[0]?.length ?? 0;
	const inside = (y: number, x: number) => y >= 0 && y < rows && x >= 0 && x < cols;
	const filled = (y: number, x: number) => inside(y, x) && (grid[y]?.[x] ?? "").trim() !== "";
	if (!inside(r + dr, c + dc)) return { r, c };

	let y = r + dr;
	let x = c + dc;
	if (!filled(y, x)) {
		// over a gap: the next thing there is, or the far edge if there is none
		while (inside(y + dr, x + dc) && !filled(y, x)) {
			y += dr;
			x += dc;
		}
		return { r: y, c: x };
	}
	// along a run: stop on its last cell
	while (filled(y + dr, x + dc)) {
		y += dr;
		x += dc;
	}
	return { r: y, c: x };
}

/**
 * Doc coordinates for every cell of a block, given the table's first line.
 *
 * Row 0 is the header and sits on that first line; body rows clear the |---|
 * divider, so grid row r lands on start + r + 1. The click paths all do that
 * sum, and it lives here so one tested copy answers for all of them.
 */
export function blockTargets(start: number, b: CellBlock): { line: number; col: number; expect: null }[] {
	const out: { line: number; col: number; expect: null }[] = [];
	const c1 = Math.min(b.c1, b.c2);
	const c2 = Math.max(b.c1, b.c2);
	for (let r = Math.min(b.r1, b.r2); r <= Math.max(b.r1, b.r2); r++) {
		const line = start + (r === 0 ? 0 : r + 1);
		for (let c = c1; c <= c2; c++) out.push({ line, col: c, expect: null });
	}
	return out;
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

/* Reference syntax, shared by the evaluator's tokenizer and the structural
   rewriter below so the two can never drift apart. A leading $ anchors a
   coordinate: Excel ignores it when resolving which cell you meant, and honors
   it only when a formula is copied, which is exactly the offset op's rule. */
const RE_RANGE = /^(\$?)([A-Za-z]{1,2})(\$?)(\d+):(\$?)([A-Za-z]{1,2})(\$?)(\d+)/;
const RE_COLRANGE = /^(\$?)([A-Za-z]{1,2}):(\$?)([A-Za-z]{1,2})(?!\$?\d)/;
const RE_ROWRANGE = /^(\$?)(\d+):(\$?)(\d+)(?![\d.])/;
const RE_REF = /^(\$?)([A-Za-z]{1,2})(\$?)(\d+)/;

/* Function names, longest first where one is a prefix of another so SUM cannot
   swallow SUMPRODUCT. One source of truth: the tokenizer matches calls with it
   and looksLikeFormula decides with it, so adding a function here is the whole
   registration. */
const FN_NAMES =
	// Longest first where one name starts another: this alternation is tried in
	// order, so SUMIF ahead of SUMIFS would match the first six letters and
	// leave a stray S behind. Same for COUNTIFS, AVERAGEIFS and IFS.
	"SUBTOTAL|SUMPRODUCT|SUMIFS|SUMIF|SUM|COUNTBLANK|COUNTIFS|COUNTIF|COUNTA|COUNT|AVERAGEIFS|AVERAGEIF|AVERAGE|AVG|" +
	"MEDIAN|PRODUCT|POWER|SQRT|STDEV|INT|MOD|" +
	"ROUNDUP|ROUNDDOWN|ROUND|MIN|MAX|IFERROR|IFS|IF|AND|OR|NOT|ABS|LEN|LEFT|RIGHT|MID|TRIM|UPPER|LOWER|CONCAT|SWITCH|" +
	"XLOOKUP|VLOOKUP|MATCH|INDEX|YEAR|MONTH|DAY";
const RE_FN = new RegExp(`^(${FN_NAMES})\\s*\\(`, "i");

/** Every function the parser knows, alphabetical, for the formula bar's
 *  autocomplete. Same source as the tokenizer, so the list can never offer a
 *  name the parser would then reject. */
export const FORMULA_FUNCTIONS: readonly string[] = FN_NAMES.split("|").sort();

/**
 * Function names worth offering for the word being typed at `caret`. Empty
 * unless the text is a formula, the caret sits at the end of a bare word, and
 * that word still has somewhere to go: once the only match is what you already
 * typed there is nothing left to suggest.
 */
export function completionsAt(text: string, caret: number, limit = 8): string[] {
	if (!text.startsWith("=")) return [];
	const word = /([A-Za-z]+)$/.exec(text.slice(0, caret))?.[1];
	if (!word) return [];
	const upper = word.toUpperCase();
	const hits = FORMULA_FUNCTIONS.filter((f) => f.startsWith(upper));
	if (hits.length === 1 && hits[0] === upper) return [];
	return hits.slice(0, limit);
}

/** Replace the word at `caret` with a chosen function name and its open paren,
 *  leaving the caret inside the parentheses ready for arguments. */
export function applyCompletion(text: string, caret: number, name: string): { text: string; caret: number } {
	const word = /([A-Za-z]+)$/.exec(text.slice(0, caret))?.[1] ?? "";
	const head = text.slice(0, caret - word.length);
	return { text: `${head}${name}(${text.slice(caret)}`, caret: head.length + name.length + 1 };
}

/**
 * Whether a cell click at this caret should insert a reference rather than
 * retarget. True only where a reference could actually go: right after the
 * leading =, an operator, an opening paren, or a comma. Anywhere else a click
 * means "work on that cell instead", so point mode stays out of the way.
 */
export function refInsertAllowed(text: string, caret: number): boolean {
	if (!text.startsWith("=")) return false;
	return /[=+\-*/^&(,:<>%]\s*$/.test(text.slice(0, caret));
}

/* ---------------- structural reference rewriting ----------------
   Inserting, deleting, moving, or sorting rows and columns moves the cells a
   formula points at. Excel rewrites the references so the formula keeps meaning
   what it meant; without that, a stored ref silently addresses whatever landed
   in that slot, which reads as a plausible wrong number rather than an error.
   Coordinates here are the 0-based grid ones tableGrid uses (row 0 is the
   header, column 0 is A). Formula text is 1-based on rows and lettered on
   columns, so the rewriter converts at the edges. */

/** What happened to one axis. */
export type RefOp =
	/** A line appeared at `at`; everything from there on moves down/right one. */
	| { axis: "row" | "col"; kind: "insert"; at: number }
	/** The line at `at` went away. Refs to it die; later ones move back one. */
	| { axis: "row" | "col"; kind: "delete"; at: number }
	/** A reorder (move, sort): map[oldIndex] = newIndex. A range takes the
	 *  min/max of its permuted ends, so a block that was sorted as a unit keeps
	 *  covering that block. */
	| { axis: "row" | "col"; kind: "permute"; map: number[] }
	/** The relative-reference rule a copied formula follows: every ref moves by
	 *  the same distance the formula itself moved, so it keeps pointing the same
	 *  way relative to its own cell. */
	| { axis: "row" | "col"; kind: "offset"; delta: number };

/** What a reference becomes when the cell it named no longer exists. */
export const REF_DEAD = "#REF!";

/* Excel's error values. A formula that fails should say which kind of wrong it
   is, because each one points somewhere different: #VALUE! at an argument,
   #NAME? at what you typed, #REF! at something deleted, #N/A at a lookup that
   found nothing. #CIRC! is the one code Excel does not have: it warns in a
   dialog and leaves the cell reading 0, which we cannot do from here, and a
   silent 0 is the failure mode this plugin is least willing to ship. */
const ERR_VALUE = "#VALUE!";
const ERR_NAME = "#NAME?";
const ERR_DIV0 = "#DIV/0!";
const ERR_NA = "#N/A";
const ERR_NUM = "#NUM!";
const ERR_CIRC = "#CIRC!";

/** What a failed formula shows in its cell. A named error carries its own text,
 *  so a dead reference reads as #REF! and says what to go fix; anything else
 *  falls back to the generic one. */
export function formulaErrorText(e: unknown): string {
	const msg = e instanceof Error ? e.message : "";
	return msg.startsWith("#") ? msg : "#ERR";
}

/** `anchored` is a $ on this coordinate. It holds a copied formula still, and
 *  nothing else: a structural move relocates the cell itself, so an anchored
 *  ref tracks it the same as a relative one, exactly as Excel behaves. */
function moveCoord(v: number, op: RefOp, anchored: boolean): number | null {
	switch (op.kind) {
		case "insert":
			return v >= op.at ? v + 1 : v;
		case "delete":
			return v === op.at ? null : v > op.at ? v - 1 : v;
		case "offset":
			return anchored ? v : v + op.delta;
		case "permute":
			return op.map[v] ?? v;
	}
}

/** Both ends of a range. A delete inside it shrinks it rather than killing it;
 *  only deleting the whole span leaves nothing to point at. */
function moveSpan(a: number, b: number, anchorA: boolean, anchorB: boolean, op: RefOp): [number, number] | null {
	if (op.kind === "delete") {
		const lo = Math.min(a, b);
		const hi = Math.max(a, b);
		const nlo = lo > op.at ? lo - 1 : lo;
		const nhi = hi >= op.at ? hi - 1 : hi;
		return nhi < nlo ? null : [nlo, nhi];
	}
	const na = moveCoord(a, op, anchorA);
	const nb = moveCoord(b, op, anchorB);
	if (na == null || nb == null) return null;
	return na <= nb ? [na, nb] : [nb, na];
}

/**
 * Rewrite every reference in one formula for a structural change. String
 * literals are copied through untouched, and an already-dead #REF! stays dead.
 */
export function shiftFormulaRefs(src: string, op: RefOp): string {
	const cell = (ca: string, c: number, ra: string, r: number) => `${ca}${colLetterOf(c)}${ra}${r + 1}`;
	let out = "";
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (ch === "'" || ch === '"') {
			const close = src.indexOf(ch, i + 1);
			if (close < 0) {
				out += src.slice(i);
				break;
			}
			out += src.slice(i, close + 1);
			i = close + 1;
			continue;
		}
		if (src.startsWith(REF_DEAD, i)) {
			out += REF_DEAD;
			i += REF_DEAD.length;
			continue;
		}
		const rest = src.slice(i);
		const range = RE_RANGE.exec(rest);
		if (range) {
			const [, ac1, l1, ar1, d1, ac2, l2, ar2, d2] = range;
			const c1 = colIndexOf(l1);
			const c2 = colIndexOf(l2);
			const r1 = +d1 - 1;
			const r2 = +d2 - 1;
			const span =
				op.axis === "row" ? moveSpan(r1, r2, !!ar1, !!ar2, op) : moveSpan(c1, c2, !!ac1, !!ac2, op);
			out +=
				span == null
					? REF_DEAD
					: op.axis === "row"
						? `${cell(ac1, c1, ar1, span[0])}:${cell(ac2, c2, ar2, span[1])}`
						: `${cell(ac1, span[0], ar1, r1)}:${cell(ac2, span[1], ar2, r2)}`;
			i += range[0].length;
			continue;
		}
		const colRange = RE_COLRANGE.exec(rest);
		if (colRange) {
			const [, a1, l1, a2, l2] = colRange;
			if (op.axis === "col") {
				const span = moveSpan(colIndexOf(l1), colIndexOf(l2), !!a1, !!a2, op);
				out += span == null ? REF_DEAD : `${a1}${colLetterOf(span[0])}:${a2}${colLetterOf(span[1])}`;
			} else {
				out += colRange[0];
			}
			i += colRange[0].length;
			continue;
		}
		const rowRange = RE_ROWRANGE.exec(rest);
		if (rowRange) {
			const [, a1, d1, a2, d2] = rowRange;
			if (op.axis === "row") {
				const span = moveSpan(+d1 - 1, +d2 - 1, !!a1, !!a2, op);
				out += span == null ? REF_DEAD : `${a1}${span[0] + 1}:${a2}${span[1] + 1}`;
			} else {
				out += rowRange[0];
			}
			i += rowRange[0].length;
			continue;
		}
		const ref = RE_REF.exec(rest);
		if (ref) {
			const [, ac, letters, ar, digits] = ref;
			const c = colIndexOf(letters);
			const r = +digits - 1;
			if (op.axis === "row") {
				const nr = moveCoord(r, op, !!ar);
				out += nr == null ? REF_DEAD : cell(ac, c, ar, nr);
			} else {
				const nc = moveCoord(c, op, !!ac);
				out += nc == null ? REF_DEAD : cell(ac, nc, ar, r);
			}
			i += ref[0].length;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** Rewrite every formula in one table line. Displayed values are left alone;
 *  the recalc pass that follows any edit refreshes them. */
export function shiftRowFormulas(text: string, op: RefOp): string {
	const r = parseRow(text);
	if (!r || r.isDelim) return text;
	let changed = false;
	for (let c = 0; c < r.cellCount; c++) {
		const p = parseCellContent(r.pieces[c + 1]);
		// a stored formula keeps its value; a plain "=…" cell is its own formula
		const src = p.formula ?? (looksLikeFormula(p.inner) ? p.inner : null);
		if (!src) continue;
		const next = shiftFormulaRefs(src, op);
		if (next === src) continue;
		r.pieces[c + 1] = p.formula
			? ` ${buildCellContent(p.inner, p.bg, p.fg, null, next, p.borders, p.fmt, p.hl, p.w, p.rule, p.tbl, p.flt, p.list)} `
			: ` ${buildCellContent(next, p.bg, p.fg, p.calc, null, p.borders, p.fmt, p.hl, p.w, p.rule, p.tbl, p.flt, p.list)} `;
		changed = true;
	}
	return changed ? r.prefix + r.pieces.join("|") : text;
}

/**
 * Fold reference rewriting into a plan's edits. Lines the plan already rewrites
 * get their formulas shifted in the plan's own text; every other line of the
 * table gets an edit only if its formulas actually moved. Line numbers stay in
 * original-document space, which is what both appliers expect, and an insert
 * sorts ahead of an edit on the same line so the two never overlap.
 *
 * Inserted lines are left alone: the op describes what happens to content that
 * was already there, and brand new content is the planner's to write. A planner
 * inserting a copy of an existing row shifts that copy itself, by the offset
 * rule rather than this one.
 */
export function withRefShift(
	lines: string[],
	edits: { line: number; text: string; kind?: EditKind }[],
	bounds: { start: number; end: number },
	op: RefOp
): { line: number; text: string; kind?: EditKind }[] {
	const out = edits.map((e) => (e.kind ? e : { ...e, text: shiftRowFormulas(e.text, op) }));
	const covered = new Set(out.filter((e) => e.kind !== "insert").map((e) => e.line));
	for (let i = bounds.start; i <= bounds.end; i++) {
		if (covered.has(i) || i >= lines.length) continue;
		const next = shiftRowFormulas(lines[i], op);
		if (next !== lines[i]) out.push({ line: i, text: next });
	}
	return out.sort((a, b) => a.line - b.line || (a.kind === "insert" ? -1 : b.kind === "insert" ? 1 : 0));
}

/** The grid row a source line sits at, without building the whole grid. Used by
 *  the structural planners, which know their table's bounds already. */
export function gridRowOfLine(lines: string[], start: number, line: number): number {
	let n = 0;
	for (let i = start; i < line; i++) {
		const r = parseRow(lines[i]);
		if (r && !r.isDelim) n++;
	}
	return n;
}

/**
 * The formula equivalent of a live calc marker, for the formula bar: a column
 * calc at column B reads =SUM(B:B), a row calc on row 3 reads =SUM(3:3), where
 * row 1 is the header. Committing that text back produces a formula cell with
 * the same behavior (whole-column/row ranges re-expand every recalc and exclude
 * the cell itself), with one edge: a live column calc covers the data rows,
 * while B:B is the whole column Excel-style. Only a header holding a number
 * tells them apart, since text never reaches a numeric aggregate.
 */
export function calcToFormula(calc: CalcSpec, col: number, row: number): string {
	const fn = calc.fn.toUpperCase();
	if (calc.dir === "column") {
		const L = colLetterOf(col);
		return `=${fn}(${L}:${L})`;
	}
	return `=${fn}(${row}:${row})`;
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
	| { t: "comma" }
	/** An error the tokenizer saw coming but left for evaluation time, so that
	 *  an IFERROR wrapped around it gets its chance first. */
	| { t: "err"; v: string };

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
		if ("+-*/><=^&%".includes(ch)) {
			out.push({ t: "op", v: ch });
			i++;
			continue;
		}
		// string literal: 'text' or "text" (data-f storage converts " to ')
		if (ch === "'" || ch === '"') {
			const close = src.indexOf(ch, i + 1);
			if (close < 0) throw new Error(ERR_NAME);
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
		// Excel-style whole-row range: 3:3 (all columns of row 3, where row 1 is
		// the header). Checked before plain numbers so "3:3" is not read as 3,
		// and outside the digit branch so "$3:$3" is reached at all.
		const rr = RE_ROWRANGE.exec(src.slice(i));
		if (rr) {
			out.push({ t: "rowrange", r1: +rr[2] - 1, r2: +rr[4] - 1 });
			i += rr[0].length;
			continue;
		}
		if (/\d/.test(ch)) {
			const m = /^\d+(\.\d+)?/.exec(src.slice(i))!;
			out.push({ t: "num", v: parseFloat(m[0]) });
			i += m[0].length;
			continue;
		}
		const fn = RE_FN.exec(src.slice(i));
		if (fn) {
			out.push({ t: "fn", v: fn[1].toUpperCase() === "AVERAGE" ? "AVG" : fn[1].toUpperCase() });
			out.push({ t: "lp" });
			i += fn[0].length;
			continue;
		}
		const range = RE_RANGE.exec(src.slice(i));
		if (range) {
			out.push({
				t: "range",
				c1: colIndexOf(range[2]),
				r1: +range[4] - 1,
				c2: colIndexOf(range[6]),
				r2: +range[8] - 1,
			});
			i += range[0].length;
			continue;
		}
		// Excel-style whole-column range: B:B (every row of column B, header
		// included, exactly as Excel treats it; text cells drop out of numeric
		// aggregates anyway, so this only shows when a header holds a number)
		const cr = RE_COLRANGE.exec(src.slice(i));
		if (cr) {
			out.push({ t: "colrange", c1: colIndexOf(cr[2]), c2: colIndexOf(cr[4]) });
			i += cr[0].length;
			continue;
		}
		const ref = RE_REF.exec(src.slice(i));
		if (ref) {
			out.push({ t: "ref", col: colIndexOf(ref[2]), row: +ref[4] - 1 });
			i += ref[0].length;
			continue;
		}
		// A dead reference, or a name that is not a function: both are errors,
		// but deferred ones. Throwing here would kill the whole formula at
		// tokenize time, before any wrapping IFERROR could run, and in Excel
		// IFERROR does catch #NAME? and #REF!. So emit the error as a token and
		// let it fire when that part of the expression is actually evaluated.
		if (src.startsWith(REF_DEAD, i)) {
			out.push({ t: "err", v: REF_DEAD });
			i += REF_DEAD.length;
			continue;
		}
		const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
		if (name) {
			out.push({ t: "err", v: ERR_NAME });
			i += name[0].length;
			continue;
		}
		throw new Error(ERR_NAME);
	}
	return out;
}

/**
 * Split a cell into the wrappers around its visible text and the text itself.
 * The formula bar shows the text, the way a spreadsheet shows a value rather
 * than how it is stored, and a commit puts the new text back between the same
 * wrappers, so editing 500 into 600 cannot cost you the bold, highlight, or
 * color someone had put on it.
 *
 * Peels from the outside in, so the pieces reassemble in the right order no
 * matter how HTML tags and markdown markers are nested.
 */
export function cellTextParts(inner: string): { lead: string; text: string; trail: string } {
	const MARKS = ["***", "**", "__", "~~", "==", "*", "_", "`"];
	let lead = "";
	let trail = "";
	let s = inner;
	for (;;) {
		const open = /^<[a-zA-Z][^>]*>/.exec(s);
		if (open) {
			lead += open[0];
			s = s.slice(open[0].length);
			continue;
		}
		const mark = MARKS.find((k) => s.length > k.length * 2 && s.startsWith(k) && s.endsWith(k));
		if (mark) {
			lead += mark;
			trail = mark + trail;
			s = s.slice(mark.length, s.length - mark.length);
			continue;
		}
		const close = /<\/[a-zA-Z][^>]*>$/.exec(s);
		if (close) {
			trail = close[0] + trail;
			s = s.slice(0, s.length - close[0].length);
			continue;
		}
		break;
	}
	return { lead, text: s, trail };
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
 * Evaluate a "=…" formula against a table grid. Cell refs are Excel-literal:
 * letter + 1-based row counting the header, so C1 is column C's header cell and
 * C2 is its first data row. A header cell is addressable like any other, which
 * is what lets a formula live in one and be summed from elsewhere.
 * The formula's own cell is excluded from ranges and is an
 * error as a direct ref (circularity guard on top of the recalc pass cap).
 * Numbers flow through math; text flows through refs, IF, and comparisons.
 * Throws on any invalid input, callers render #ERR.
 */
export function evalFormula(
	src: string,
	rows: string[][],
	selfRow: number,
	selfCol: number,
	hidden?: ReadonlySet<number>
): FVal {
	const toks = tokenizeFormula(src.replace(/^=/, ""));
	let p = 0;
	const peek = () => toks[p];
	const next = () => toks[p++];
	const numAt = (row: number, col: number): number | null => {
		const n = parseNumeric(rows[row]?.[col] ?? "");
		return n ? n.value : null;
	};
	const refValue = (row: number, col: number): FVal => {
		if (row === selfRow && col === selfCol) throw new Error(ERR_CIRC);
		if (row < 0 || row >= rows.length) throw new Error(REF_DEAD);
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

	/** A range's clamped rectangle. Aggregates walk `cells`, which drops the
	 *  formula's own cell; lookups need the shape instead, and a hole would
	 *  shift every position after it, so they read the box off the grid. */
	type Box = { r1: number; r2: number; c1: number; c2: number };
	type Arg = { cells: { r: number; c: number }[]; box: Box } | { v: FVal };

	const boxOf = (r1: number, r2: number, c1: number, c2: number): Box => ({
		r1: Math.max(0, Math.min(r1, r2)),
		r2: Math.min(rows.length - 1, Math.max(r1, r2)),
		c1: Math.min(c1, c2),
		c2: Math.max(c1, c2),
	});
	const rangeArg = (r1: number, r2: number, c1: number, c2: number): Arg => ({
		cells: rangeCells(r1, r2, c1, c2),
		box: boxOf(r1, r2, c1, c2),
	});

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
				args.push(rangeArg(t.r1, t.r2, t.c1, t.c2));
			} else if (t?.t === "colrange") {
				next();
				args.push(rangeArg(0, rows.length - 1, t.c1, t.c2));
			} else if (t?.t === "rowrange") {
				next();
				const width = Math.max(0, ...rows.map((r) => r.length)) - 1;
				args.push(rangeArg(t.r1, t.r2, 0, width));
			} else {
				args.push({ v: cmp() });
			}
			const sep = next();
			if (sep?.t === "rp") break;
			if (sep?.t !== "comma") throw new Error(ERR_NAME);
		}
		return args;
	}

	function fnCall(name: string): FVal {
		const args = fnArgs();
		/** `skip` is SUBTOTAL's whole job: the grid rows a filter is hiding drop
		 *  out before anything is added up. Every other function ignores it, the
		 *  way SUM ignores a filter in Excel. */
		const nums = (list: Arg[] = args, skip?: ReadonlySet<number>): number[] => {
			const out: number[] = [];
			for (const a of list) {
				if ("cells" in a) {
					for (const { r, c } of a.cells) {
						if (skip?.has(r)) continue;
						const v = numAt(r, c);
						if (v != null) out.push(v);
					}
				} else if (typeof a.v === "number") out.push(a.v);
				else throw new Error(ERR_VALUE);
			}
			return out;
		};
		const asNum = (a: Arg | undefined): number => {
			if (!a || "cells" in a || typeof a.v !== "number") throw new Error(ERR_VALUE);
			return a.v;
		};
		const asText = (a: Arg | undefined): string => {
			if (!a || "cells" in a) throw new Error(ERR_VALUE);
			return String(a.v);
		};
		/** Excel's truthiness: any nonzero number, any non-empty text. */
		const truthy = (v: FVal): boolean => (typeof v === "number" ? v !== 0 : v.length > 0);
		/**
		 * The range/criteria pairs of a *IFS call, as one test per position.
		 *
		 * Every range has to be the same size as the one being aggregated, which
		 * is what lets a single index answer for all of them: position k is the
		 * same row in every range. Excel refuses a mismatch rather than lining
		 * them up from the top and hoping, and so does this, because the answer
		 * it would otherwise give is wrong without looking wrong.
		 */
		const ifsTest = (pairs: Arg[], len: number): ((k: number) => boolean) => {
			if (!pairs.length || pairs.length % 2) throw new Error(ERR_VALUE);
			const tests: { cells: { r: number; c: number }[]; crit: FVal }[] = [];
			for (let i = 0; i < pairs.length; i += 2) {
				const rng = pairs[i];
				const crit = pairs[i + 1];
				if (!rng || !("cells" in rng) || !crit || "cells" in crit) throw new Error(ERR_VALUE);
				if (rng.cells.length !== len) throw new Error(ERR_VALUE);
				tests.push({ cells: rng.cells, crit: crit.v });
			}
			return (k) => tests.every((t) => matchCriteria(rows[t.cells[k].r]?.[t.cells[k].c] ?? "", t.crit));
		};
		/** A looked-up cell comes back as a number when it reads as one. */
		const cellValue = (r: number, c: number): FVal => {
			const raw = rows[r]?.[c] ?? "";
			const n = parseNumeric(plainCellText(raw));
			return n ? n.value : plainCellText(raw);
		};
		/** Lookups read the grid directly, so they have to refuse a range that
		 *  contains the formula itself rather than quietly reading a stale copy
		 *  of their own output. */
		const guardSelf = (b: Box) => {
			if (selfRow >= b.r1 && selfRow <= b.r2 && selfCol >= b.c1 && selfCol <= b.c2) {
				throw new Error(ERR_CIRC);
			}
		};
		switch (name) {
			case "SUM":
				// Excel sums nothing to 0 rather than complaining; a total over an
				// empty column should read 0, not shout at you
				return nums().reduce((x, y) => x + y, 0);
			case "AVG": {
				const v = nums();
				if (!v.length) throw new Error(ERR_DIV0);
				return v.reduce((x, y) => x + y, 0) / v.length;
			}
			case "MIN": {
				const v = nums();
				if (!v.length) return 0;
				return Math.min(...v);
			}
			case "MAX": {
				const v = nums();
				if (!v.length) return 0;
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
				if (args.length < 2 || "cells" in args[0]) throw new Error(ERR_VALUE);
				const cond = args[0].v;
				const truthy = typeof cond === "number" ? cond !== 0 : cond.length > 0;
				const pick = truthy ? args[1] : (args[2] ?? { v: "" });
				if ("cells" in pick) throw new Error(ERR_VALUE);
				return pick.v;
			}
			case "SUMIFS":
			case "AVERAGEIFS": {
				// Note the argument order, which is Excel's and is the reverse of
				// SUMIF's: the range being totalled comes first, then the
				// condition pairs. Getting this backwards is the single most
				// common mistake with these, so it is worth matching exactly.
				const target = args[0];
				if (!target || !("cells" in target)) throw new Error(ERR_VALUE);
				const pass = ifsTest(args.slice(1), target.cells.length);
				let total = 0;
				let n = 0;
				for (let k = 0; k < target.cells.length; k++) {
					if (!pass(k)) continue;
					const v = numAt(target.cells[k].r, target.cells[k].c);
					if (v != null) {
						total += v;
						n++;
					}
				}
				if (name === "SUMIFS") return total;
				if (!n) throw new Error(ERR_DIV0);
				return total / n;
			}
			case "COUNTIFS": {
				const first = args[0];
				if (!first || !("cells" in first)) throw new Error(ERR_VALUE);
				const pass = ifsTest(args, first.cells.length);
				let n = 0;
				for (let k = 0; k < first.cells.length; k++) if (pass(k)) n++;
				return n;
			}
			case "SUMIF": {
				const range = args[0];
				const crit = args[1];
				if (!range || !("cells" in range) || !crit || "cells" in crit) {
					throw new Error(ERR_VALUE);
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
					throw new Error(ERR_VALUE);
				}
				let n = 0;
				for (const { r, c } of range.cells) if (matchCriteria(rows[r]?.[c] ?? "", crit.v)) n++;
				return n;
			}
			case "AVERAGEIF": {
				const range = args[0];
				const crit = args[1];
				if (!range || !("cells" in range) || !crit || "cells" in crit) {
					throw new Error(ERR_VALUE);
				}
				const avgRange = args[2] && "cells" in args[2] ? args[2].cells : range.cells;
				let total = 0;
				let n = 0;
				for (let k = 0; k < range.cells.length; k++) {
					const { r, c } = range.cells[k];
					if (!matchCriteria(rows[r]?.[c] ?? "", crit.v)) continue;
					const cell = avgRange[k] ?? range.cells[k];
					const v = numAt(cell.r, cell.c);
					if (v != null) {
						total += v;
						n++;
					}
				}
				if (!n) throw new Error(ERR_DIV0);
				return total / n;
			}
			case "MEDIAN": {
				const v = nums().sort((a, b) => a - b);
				if (!v.length) throw new Error(ERR_NUM);
				const mid = Math.floor(v.length / 2);
				return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
			}
			case "PRODUCT": {
				const v = nums();
				if (!v.length) return 0;
				return v.reduce((x, y) => x * y, 1);
			}
			case "STDEV": {
				// the sample deviation, which is Excel's plain STDEV
				const v = nums();
				if (v.length < 2) throw new Error(ERR_DIV0);
				const mean = v.reduce((x, y) => x + y, 0) / v.length;
				return Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1));
			}
			case "SUBTOTAL": {
				// Excel's one function that knows what is on screen. The 1-11 codes
				// and the 101-111 codes differ only over rows hidden by hand, which
				// is not a thing you can do here, so both read the same: skip what
				// the filter is hiding.
				const code = Math.round(asNum(args[0]));
				const rest = args.slice(1);
				if (!rest.length) throw new Error(ERR_VALUE);
				const v = nums(rest, hidden);
				switch (code > 100 ? code - 100 : code) {
					case 1: {
						if (!v.length) throw new Error(ERR_DIV0);
						return v.reduce((x, y) => x + y, 0) / v.length;
					}
					case 2:
						return v.length;
					case 3: {
						let n = 0;
						for (const a of rest) {
							if ("cells" in a) {
								for (const { r, c } of a.cells) {
									if (hidden?.has(r)) continue;
									if (plainCellText(rows[r]?.[c] ?? "") !== "") n++;
								}
							} else if (a.v !== "") n++;
						}
						return n;
					}
					case 4:
						return v.length ? Math.max(...v) : 0;
					case 5:
						return v.length ? Math.min(...v) : 0;
					case 6:
						return v.reduce((x, y) => x * y, 1);
					case 7: {
						if (v.length < 2) throw new Error(ERR_DIV0);
						const mean = v.reduce((x, y) => x + y, 0) / v.length;
						return Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1));
					}
					case 9:
						return v.reduce((x, y) => x + y, 0);
					default:
						// 8, 10 and 11 are STDEVP, VAR and VARP, which this evaluator
						// does not have as functions either; naming a code it cannot
						// compute is an argument error, as it is in Excel
						throw new Error(ERR_VALUE);
				}
			}
			case "SUMPRODUCT": {
				const lists = args.map((a) => {
					if (!("cells" in a)) throw new Error(ERR_VALUE);
					return a.cells.map(({ r, c }) => numAt(r, c) ?? 0);
				});
				if (!lists.length) return 0;
				const n = lists[0].length;
				if (lists.some((l) => l.length !== n)) throw new Error(ERR_VALUE);
				let total = 0;
				for (let k = 0; k < n; k++) total += lists.reduce((x, l) => x * l[k], 1);
				return total;
			}
			case "POWER":
				return Math.pow(asNum(args[0]), asNum(args[1]));
			case "SQRT": {
				const v = asNum(args[0]);
				if (v < 0) throw new Error(ERR_NUM);
				return Math.sqrt(v);
			}
			case "INT":
				return Math.floor(asNum(args[0]));
			case "MOD": {
				const d = asNum(args[1]);
				if (!d) throw new Error(ERR_DIV0);
				// Excel's remainder takes the divisor's sign, unlike JS %
				const n = asNum(args[0]);
				return n - d * Math.floor(n / d);
			}
			case "ROUNDUP":
			case "ROUNDDOWN": {
				const v = asNum(args[0]);
				const d = args.length > 1 ? asNum(args[1]) : 0;
				const f = Math.pow(10, Math.round(d));
				const away = name === "ROUNDUP" ? Math.ceil : Math.floor;
				return ((v < 0 ? -1 : 1) * away(Math.abs(v) * f)) / f;
			}
			case "COUNTA":
			case "COUNTBLANK": {
				const wantBlank = name === "COUNTBLANK";
				let n = 0;
				for (const a of args) {
					if ("cells" in a) {
						for (const { r, c } of a.cells) {
							if ((plainCellText(rows[r]?.[c] ?? "") === "") === wantBlank) n++;
						}
					} else if ((a.v === "") === wantBlank) n++;
				}
				return n;
			}
			case "AND":
			case "OR": {
				const vals: FVal[] = [];
				for (const a of args) {
					if ("cells" in a) for (const { r, c } of a.cells) vals.push(plainCellText(rows[r]?.[c] ?? ""));
					else vals.push(a.v);
				}
				if (!vals.length) throw new Error(ERR_VALUE);
				return (name === "AND" ? vals.every(truthy) : vals.some(truthy)) ? 1 : 0;
			}
			case "NOT": {
				const a = args[0];
				if (!a || "cells" in a) throw new Error(ERR_VALUE);
				return truthy(a.v) ? 0 : 1;
			}
			case "LEN":
				return asText(args[0]).length;
			case "LEFT":
				return asText(args[0]).slice(0, args.length > 1 ? Math.max(0, Math.round(asNum(args[1]))) : 1);
			case "RIGHT": {
				const s = asText(args[0]);
				const n = args.length > 1 ? Math.max(0, Math.round(asNum(args[1]))) : 1;
				return n >= s.length ? s : s.slice(s.length - n);
			}
			case "MID": {
				const s = asText(args[0]);
				const from = Math.round(asNum(args[1]));
				const len = Math.round(asNum(args[2]));
				if (from < 1 || len < 0) throw new Error(ERR_VALUE);
				return s.slice(from - 1, from - 1 + len);
			}
			case "TRIM":
				return asText(args[0]).replace(/\s+/g, " ").trim();
			case "UPPER":
				return asText(args[0]).toUpperCase();
			case "LOWER":
				return asText(args[0]).toLowerCase();
			case "CONCAT": {
				let s = "";
				for (const a of args) {
					if ("cells" in a) for (const { r, c } of a.cells) s += plainCellText(rows[r]?.[c] ?? "");
					else s += String(a.v);
				}
				return s;
			}
			case "XLOOKUP": {
				// What VLOOKUP cannot do: the column you want back does not have
				// to sit to the right of the one you search, because the two are
				// named separately instead of being counted off from each other.
				const key = args[0];
				const look = args[1];
				const ret = args[2];
				if (!key || "cells" in key || !look || !("cells" in look) || !ret || !("cells" in ret)) {
					throw new Error(ERR_VALUE);
				}
				guardSelf(look.box);
				guardSelf(ret.box);
				if (look.cells.length !== ret.cells.length) throw new Error(ERR_VALUE);
				for (let k = 0; k < look.cells.length; k++) {
					const { r, c } = look.cells[k];
					if (!matchCriteria(rows[r]?.[c] ?? "", key.v)) continue;
					return cellValue(ret.cells[k].r, ret.cells[k].c);
				}
				// the fourth argument is the whole reason to reach for this over
				// wrapping a lookup in IFERROR, which would also swallow real errors
				const miss = args[3];
				if (miss && !("cells" in miss)) return miss.v;
				throw new Error(ERR_NA);
			}
			case "IFS": {
				if (args.length < 2 || args.length % 2) throw new Error(ERR_VALUE);
				for (let i = 0; i < args.length; i += 2) {
					const cond = args[i];
					const val = args[i + 1];
					if (!cond || "cells" in cond || !val || "cells" in val) throw new Error(ERR_VALUE);
					if (truthy(cond.v)) return val.v;
				}
				// Excel's answer when nothing matched, and the reason a last
				// condition of TRUE() is how you write an "otherwise"
				throw new Error(ERR_NA);
			}
			case "SWITCH": {
				const subject = args[0];
				if (!subject || "cells" in subject) throw new Error(ERR_VALUE);
				let i = 1;
				for (; i + 1 < args.length; i += 2) {
					const cand = args[i];
					const res = args[i + 1];
					if (!cand || "cells" in cand || !res || "cells" in res) throw new Error(ERR_VALUE);
					const same =
						typeof subject.v === "number" && typeof cand.v === "number"
							? subject.v === cand.v
							: String(subject.v).toLowerCase() === String(cand.v).toLowerCase();
					if (same) return res.v;
				}
				// an argument left over past the pairs is the default, which is
				// how Excel spells "otherwise" here rather than with a TRUE()
				const dflt = args[i];
				if (dflt && !("cells" in dflt)) return dflt.v;
				throw new Error(ERR_NA);
			}
			case "VLOOKUP": {
				const key = args[0];
				const table = args[1];
				if (!key || "cells" in key || !table || !("cells" in table)) {
					throw new Error(ERR_VALUE);
				}
				guardSelf(table.box);
				const at = Math.round(asNum(args[2]));
				if (at < 1 || table.box.c1 + at - 1 > table.box.c2) throw new Error(REF_DEAD);
				for (let r = table.box.r1; r <= table.box.r2; r++) {
					if (!matchCriteria(rows[r]?.[table.box.c1] ?? "", key.v)) continue;
					return cellValue(r, table.box.c1 + at - 1);
				}
				throw new Error(ERR_NA);
			}
			case "MATCH": {
				const key = args[0];
				const range = args[1];
				if (!key || "cells" in key || !range || !("cells" in range)) throw new Error(ERR_VALUE);
				guardSelf(range.box);
				let k = 0;
				for (let r = range.box.r1; r <= range.box.r2; r++) {
					for (let c = range.box.c1; c <= range.box.c2; c++) {
						k++;
						if (matchCriteria(rows[r]?.[c] ?? "", key.v)) return k;
					}
				}
				throw new Error(ERR_NA);
			}
			case "INDEX": {
				const range = args[0];
				if (!range || !("cells" in range)) throw new Error(ERR_VALUE);
				guardSelf(range.box);
				const rr = Math.round(asNum(args[1]));
				const cc = args.length > 2 ? Math.round(asNum(args[2])) : 1;
				const r = range.box.r1 + rr - 1;
				const c = range.box.c1 + cc - 1;
				if (rr < 1 || cc < 1 || r > range.box.r2 || c > range.box.c2) throw new Error(REF_DEAD);
				return cellValue(r, c);
			}
			case "YEAR":
			case "MONTH":
			case "DAY": {
				const d = parseDateCell(asText(args[0]));
				if (!d) throw new Error(ERR_VALUE);
				return name === "YEAR" ? d.y : name === "MONTH" ? d.m : d.d;
			}
			default:
				throw new Error(ERR_NAME);
		}
	}

	/** Walk to the comma or paren that closes the current argument, ignoring
	 *  any nested call's own punctuation. */
	function endOfArg(): FTok | undefined {
		let depth = 0;
		while (p < toks.length) {
			const tk = toks[p];
			if (tk.t === "lp") depth++;
			else if (tk.t === "rp") {
				if (depth === 0) return tk;
				depth--;
			} else if (tk.t === "comma" && depth === 0) return tk;
			p++;
		}
		return undefined;
	}

	/**
	 * IFERROR is the one function that cannot take its arguments eagerly: the
	 * whole point is to survive a first argument that throws. So try it, rewind
	 * on failure, and take the fallback instead. Neither branch evaluates the
	 * side it does not return, which is why both skip rather than parse.
	 */
	function ifErrorCall(): FVal {
		const startP = p;
		let ok = true;
		let value: FVal = "";
		try {
			value = cmp();
		} catch {
			ok = false;
			p = startP;
		}
		if (endOfArg()?.t !== "comma") throw new Error(ERR_VALUE);
		p++;
		if (ok) {
			endOfArg();
			if (next()?.t !== "rp") throw new Error(ERR_NAME);
			return value;
		}
		const fallback = cmp();
		if (next()?.t !== "rp") throw new Error(ERR_NAME);
		return fallback;
	}

	function factor(): FVal {
		const t = next();
		if (!t) throw new Error(ERR_NAME);
		if (t.t === "num") return t.v;
		if (t.t === "str") return t.v;
		if (t.t === "err") throw new Error(t.v);
		if (t.t === "ref") return refValue(t.row, t.col);
		if (t.t === "op" && (t.v === "-" || t.v === "+")) {
			const v = factor();
			if (typeof v !== "number") throw new Error(ERR_VALUE);
			return t.v === "-" ? -v : v;
		}
		if (t.t === "fn") {
			const lp = next();
			if (lp?.t !== "lp") throw new Error(ERR_NAME);
			return t.v === "IFERROR" ? ifErrorCall() : fnCall(t.v);
		}
		if (t.t === "lp") {
			const v = cmp();
			if (next()?.t !== "rp") throw new Error(ERR_NAME);
			return v;
		}
		throw new Error(ERR_NAME);
	}

	/** Excel binds % tighter than ^, and unary minus tighter than both, so -50%
	 *  is -0.5 and -2^2 is 4. factor() already took the sign. */
	function pct(): FVal {
		let v = factor();
		while (peek()?.t === "op" && (peek() as { v: string }).v === "%") {
			next();
			if (typeof v !== "number") throw new Error(ERR_VALUE);
			v = v / 100;
		}
		return v;
	}

	/** Right-associative, as in Excel: 2^3^2 is 2^(3^2). */
	function power(): FVal {
		const base = pct();
		const t = peek();
		if (t?.t === "op" && t.v === "^") {
			next();
			const exp = power();
			if (typeof base !== "number" || typeof exp !== "number") throw new Error(ERR_VALUE);
			return Math.pow(base, exp);
		}
		return base;
	}

	function term(): FVal {
		let v = power();
		for (;;) {
			const t = peek();
			if (t?.t === "op" && (t.v === "*" || t.v === "/")) {
				next();
				const rhs = power();
				if (typeof v !== "number" || typeof rhs !== "number") throw new Error(ERR_VALUE);
				if (t.v === "/" && rhs === 0) throw new Error(ERR_DIV0);
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
				if (typeof v !== "number" || typeof rhs !== "number") throw new Error(ERR_VALUE);
				v = t.v === "+" ? v + rhs : v - rhs;
			} else return v;
		}
	}

	/** Excel's & joins text, looser than arithmetic and tighter than comparison,
	 *  and it stringifies numbers rather than refusing them. */
	function concat(): FVal {
		let v = add();
		for (;;) {
			const t = peek();
			if (t?.t === "op" && t.v === "&") {
				next();
				const rhs = add();
				v = `${v}${rhs}`;
			} else return v;
		}
	}

	function cmp(): FVal {
		const a = concat();
		const t = peek();
		if (t?.t === "op" && [">", "<", ">=", "<=", "=", "<>"].includes(t.v)) {
			next();
			const b = concat();
			let res: boolean;
			if (typeof a === "number" && typeof b === "number") {
				res =
					t.v === ">" ? a > b : t.v === "<" ? a < b : t.v === ">=" ? a >= b : t.v === "<=" ? a <= b : t.v === "=" ? a === b : a !== b;
			} else if (typeof a === "string" && typeof b === "string") {
				const x = a.toLowerCase();
				const y = b.toLowerCase();
				res =
					t.v === ">" ? x > y : t.v === "<" ? x < y : t.v === ">=" ? x >= y : t.v === "<=" ? x <= y : t.v === "=" ? x === y : x !== y;
			} else throw new Error(ERR_VALUE);
			return res ? 1 : 0;
		}
		return a;
	}

	const result = cmp();
	if (p !== toks.length) throw new Error(ERR_NAME);
	if (typeof result === "number" && !isFinite(result)) throw new Error(ERR_NUM);
	return result;
}

export function formatFormulaResult(v: FVal): string {
	if (typeof v === "string") return v.replace(/\|/g, "\\|");
	return String(Math.round(v * 10000) / 10000);
}

/** Does this raw cell text look like an attempted formula? (Casual "=text" cells are left alone.) */
export function looksLikeFormula(inner: string): boolean {
	return new RegExp(`^=\\s*(?:${FN_NAMES}|\\(|-|\\d|['"]|#|\\$|[A-Za-z]{1,2}\\d)`, "i").test(inner);
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
				value = formatFormulaResult(evalFormula(t, g.rows, gridRowOf(g, ln), col, filteredRows(lines, ln)));
			} catch (e) {
				value = formulaErrorText(e);
			}
		}
		rebuilt = buildCellContent(value, parsed.bg, parsed.fg, null, t, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list);
	} else {
		// slot the new text back inside the wrappers the old text wore; clearing
		// the cell outright drops them, since there is nothing left to wrap
		const parts = cellTextParts(parsed.inner);
		const kept = t ? parts.lead + t + parts.trail : "";
		rebuilt = buildCellContent(kept, parsed.bg, parsed.fg, null, null, parsed.borders, parsed.fmt, parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list);
	}
	r.pieces[col + 1] = rebuilt ? ` ${rebuilt} ` : "   ";
	const text = r.prefix + r.pieces.join("|");
	return { edits: text === lines[ln] ? [] : [{ line: ln, text }], cursorLine: ln, cursorCh: cursorForCol(text, col) };
}

/* ---------------- conditional rule (bulk apply) ---------------- */

export type RuleOp = "gt" | "lt" | "eq" | "contains" | "between" | "empty" | "notempty" | "regex" | "scale" | "bar" | "icon";

/**
 * How long each data bar is, as a percentage, given a column's values with
 * nulls where a cell holds nothing numeric.
 *
 * The baseline is zero whenever the column has no negatives, which is nearly
 * always and is what a bar is read as: half the length means half the value.
 * Excel's automatic rule instead stretches the smallest value to a stub and the
 * largest to full width, which makes 99 and 100 look like nothing and
 * everything. A column that does hold negatives has no honest zero to measure
 * from, so that one falls back to spanning its own range.
 */
export const ICON_SETS = ["arrows", "traffic", "symbols"] as const;
export type IconSet = (typeof ICON_SETS)[number];

/**
 * Which band of an icon set each value falls in, 0 being the top one.
 *
 * Excel's rule, and the right one here: the bands are equal slices of the
 * column's own range, so the cut points for three icons are two thirds and one
 * third of the way from the smallest value to the largest. That is different
 * from a data bar on purpose. A bar is a quantity and needs a zero to be read
 * against; an icon is a rank, and ranking against zero would put every icon in
 * the top band the moment a column had no small values in it.
 *
 * A column whose values are all the same is all top band, which is the same
 * answer barPercents gives that column when it makes every bar full.
 */
export function iconBands(values: (number | null)[], bands = 3): (number | null)[] {
	const n = Math.max(2, Math.min(5, Math.round(bands)));
	const nums = values.filter((v): v is number => v != null);
	if (!nums.length) return values.map(() => null);
	const min = Math.min(...nums);
	const max = Math.max(...nums);
	const span = max - min;
	return values.map((v) => {
		if (v == null) return null;
		if (span === 0) return 0;
		const pct = ((v - min) / span) * 100;
		for (let i = 0; i < n - 1; i++) {
			if (pct >= (100 * (n - 1 - i)) / n) return i;
		}
		return n - 1;
	});
}

export function barPercents(values: (number | null)[]): (number | null)[] {
	const nums = values.filter((v): v is number => v != null);
	if (!nums.length) return values.map(() => null);
	const base = Math.min(0, ...nums);
	const top = Math.max(0, ...nums);
	const span = top - base;
	return values.map((v) =>
		v == null ? null : span === 0 ? 100 : Math.max(0, Math.min(100, Math.round(((v - base) / span) * 100)))
	);
}

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
	// A data bar is drawn on screen, not painted into the cell, so it must never
	// count as a match: a rule list is checked top to bottom and the first hit
	// wins, and a bar that "hit" would stop the rules under it ever running.
	if (op === "bar" || op === "icon") return false;
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
		const next = ` ${buildCellContent(parsed.inner, bg, rule.fg ?? parsed.fg, parsed.calc, parsed.formula, parsed.borders, parsed.fmt, rule.bg || sb ? false : parsed.hl, parsed.w, parsed.rule, parsed.tbl, parsed.flt, parsed.list)} `;
		if (next !== r.pieces[col + 1]) {
			r.pieces[col + 1] = next;
			edits.push({ line: i, text: r.prefix + r.pieces.join("|") });
		}
	}
	return { edits, cursorLine: ln, cursorCh: cursorForCol(lines[ln], col), matched };
}

/** Decode a data-rule header tag: "lt:0:-:#F00" → { op, value, bg, fg }. */
export function parseRuleTag(tag: string): { op: RuleOp; value: string; bg: string | null; fg: string | null } | null {
	const m = tag.match(/^(gt|lt|eq|contains|between|empty|notempty|regex|scale|bar|icon):([^:]*):([^:]*):([^:]*)$/);
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

/* ---------------- data validation: a column's list of allowed values ---------------- */

/**
 * A list value rides inside an HTML attribute, in a `~` separated list, so the
 * two characters that would end either one are traded for spaces, and so is the
 * pipe, which would end the cell it is eventually written into.
 *
 * Unlike a filter value this keeps its colons: "Blocked: waiting for legal" is
 * a status somebody will want, and nothing here is parsing an `op:` prefix off
 * the front.
 */
export function listSafe(s: string): string {
	return s.replace(/["|~]/g, " ").replace(/\s+/g, " ").trim();
}

export function listTag(values: string[]): string | null {
	const out: string[] = [];
	for (const v of values) {
		const s = listSafe(v);
		// a list is a set: the same value twice is one entry, and an empty line
		// is somebody's formatting rather than a value
		if (s && !out.includes(s)) out.push(s);
	}
	return out.length ? out.join("~") : null;
}

export function listValues(tag: string | null): string[] {
	return tag ? tag.split("~").filter((v) => v.length) : [];
}

/** The list of allowed values on the target's column, if it has one. */
export function columnListAt(lines: string[], target: CellTargetLoc): string[] {
	const ln = locateLine(lines, target);
	if (ln == null) return [];
	const anchor = parseRow(lines[ln]);
	if (!anchor) return [];
	const col = Math.min(target.col, anchor.cellCount - 1);
	const { start, delimIdx } = tableBounds(lines, ln);
	if (delimIdx <= start) return [];
	const hr = parseRow(lines[start]);
	if (!hr || hr.isDelim || col >= hr.cellCount) return [];
	return listValues(parseCellContent(hr.pieces[col + 1]).list);
}

/** Every distinct value already in the target's column, for seeding a list from
 *  what the column is holding rather than typing it all out again. */
export function columnDistinct(lines: string[], target: CellTargetLoc): string[] {
	const ln = locateLine(lines, target);
	if (ln == null) return [];
	const anchor = parseRow(lines[ln]);
	if (!anchor) return [];
	const col = Math.min(target.col, anchor.cellCount - 1);
	const { end, delimIdx } = tableBounds(lines, ln);
	if (delimIdx < 0) return [];
	const out: string[] = [];
	for (let i = delimIdx + 1; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (!r || r.isDelim || col >= r.cellCount) continue;
		const v = listSafe(normalizeText(parseCellContent(r.pieces[col + 1]).inner));
		if (v && !out.includes(v)) out.push(v);
	}
	return out;
}

/**
 * Store (or clear) a column's list of allowed values, on its header cell where
 * the width, the color rules and the filter already live.
 *
 * The list is an input aid, not a gate. Markdown is the source of truth and a
 * note edited anywhere else can hold whatever it likes, so a value off the list
 * is shown as it is rather than refused; what the list does is put the right
 * values one click away and stop a column growing both "Done" and "done".
 */
export function planSetColumnList(lines: string[], target: CellTargetLoc, values: string[]): EditPlan | null {
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
	const tag = listTag(values);
	if ((hp.list ?? null) === tag) return { edits: [], cursorLine: ln, cursorCh: cursorForCol(lines[ln], col) };
	const rebuilt = buildCellContent(hp.inner, hp.bg, hp.fg, hp.calc, hp.formula, hp.borders, hp.fmt, hp.hl, hp.w, hp.rule, hp.tbl, hp.flt, tag);
	hr.pieces[col + 1] = rebuilt ? ` ${rebuilt} ` : "   ";
	return {
		edits: [{ line: start, text: hr.prefix + hr.pieces.join("|") }],
		cursorLine: ln,
		cursorCh: cursorForCol(lines[ln], col),
	};
}

/* ---------------- AutoFilter: one filter per column, stored on its header ---------------- */

/**
 * A column's filter. `in` and `ex` are the checkbox list, held as whichever
 * side is shorter: `in` shows only the values named, `ex` shows everything
 * except them. Which one a filter uses decides what happens to a value that
 * arrives later, and both answers are wanted: a list built by unticking two of
 * forty should keep showing new arrivals, and one built by ticking a single
 * value should not. The rest are Excel's condition filters and share their
 * meaning, and their matching, with the conditional color rules.
 */
export type FilterOp = "in" | "ex" | "gt" | "lt" | "eq" | "contains" | "starts" | "ends" | "between" | "empty" | "notempty";

export interface ColFilter {
	op: FilterOp;
	/** For in/ex, the values, `~` separated. Otherwise the condition's operand. */
	value: string;
}

const FILTER_OPS = "in|ex|gt|lt|eq|contains|starts|ends|between|empty|notempty";

/**
 * Filter values ride inside an HTML attribute, next to a `~` separated list, so
 * the characters that would end either one are traded for spaces. Cell text
 * goes through the same trade before it is compared, so a value holding one of
 * them still matches itself; two values differing only in those characters
 * become one entry in the list, which is the price of keeping the markup
 * unbreakable.
 */
export function fltSafe(s: string): string {
	return s.replace(/[:"|;~]/g, " ").replace(/\s+/g, " ").trim();
}

export function filterTag(f: ColFilter | null): string | null {
	if (!f) return null;
	// An empty list is not a filter either way round: nothing excluded shows
	// everything, and nothing included would hide the entire column, which is a
	// state to clear rather than to store.
	if ((f.op === "in" || f.op === "ex") && !f.value) return null;
	return `${f.op}:${f.op === "in" || f.op === "ex" ? f.value : f.value.replace(/[:"|;]/g, " ").trim()}`;
}

export function parseFilterTag(tag: string | null): ColFilter | null {
	if (!tag) return null;
	const m = tag.match(new RegExp(`^(${FILTER_OPS}):([\\s\\S]*)$`));
	return m ? { op: m[1] as FilterOp, value: m[2] } : null;
}

/**
 * The values of an `in`/`ex` filter.
 *
 * A blank cell is a value people filter by, and it cannot be stored as an empty
 * segment: a tag whose whole value is empty is how "no filter" is written. It
 * rides as a single space instead, which no real value can be, because fltSafe
 * trims what it is given.
 */
export const FLT_BLANK = " ";

export function filterValues(f: ColFilter): string[] {
	return f.value ? f.value.split("~").map((v) => (v === FLT_BLANK ? "" : v)) : [];
}

/** One value as it is stored in a list. */
export function fltValue(s: string): string {
	return fltSafe(s) || FLT_BLANK;
}

/** Whether a cell's text passes the filter, which is to say whether its row
 *  stays on screen. An unreadable filter hides nothing. */
export function filterHit(inner: string, f: ColFilter | null): boolean {
	if (!f) return true;
	const text = normalizeText(inner).trim();
	if (f.op === "in" || f.op === "ex") {
		const has = filterValues(f).includes(fltSafe(text));
		return f.op === "in" ? has : !has;
	}
	if (f.op === "starts") return !!f.value && text.toLowerCase().startsWith(f.value.toLowerCase());
	if (f.op === "ends") return !!f.value && text.toLowerCase().endsWith(f.value.toLowerCase());
	return ruleHit(inner, f.op as RuleOp, f.value);
}

/** The filter stored on the target's column header, if any. */
export function columnFilterAt(lines: string[], target: CellTargetLoc): ColFilter | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const anchor = parseRow(lines[ln]);
	if (!anchor) return null;
	const col = Math.min(target.col, anchor.cellCount - 1);
	const { start, delimIdx } = tableBounds(lines, ln);
	if (delimIdx <= start) return null;
	const hr = parseRow(lines[start]);
	if (!hr || hr.isDelim || col >= hr.cellCount) return null;
	return parseFilterTag(parseCellContent(hr.pieces[col + 1]).flt);
}

/**
 * Store (or clear) the filter on the target's column header.
 *
 * Filtering hides rows on screen and never rewrites them, so this is the only
 * edit an AutoFilter makes: one attribute on one header cell, which is where
 * the column's width and its color rules already live. Take the plugin away
 * and every row is simply visible again.
 */
export function planSetColumnFilter(lines: string[], target: CellTargetLoc, filter: ColFilter | null): EditPlan | null {
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
	const tag = filterTag(filter);
	if ((hp.flt ?? null) === tag) return { edits: [], cursorLine: ln, cursorCh: cursorForCol(lines[ln], col) };
	const rebuilt = buildCellContent(hp.inner, hp.bg, hp.fg, hp.calc, hp.formula, hp.borders, hp.fmt, hp.hl, hp.w, hp.rule, hp.tbl, tag, hp.list);
	hr.pieces[col + 1] = rebuilt ? ` ${rebuilt} ` : "   ";
	return {
		edits: [{ line: start, text: hr.prefix + hr.pieces.join("|") }],
		cursorLine: ln,
		cursorCh: cursorForCol(lines[ln], col),
	};
}

/**
 * The grid rows an AutoFilter is hiding, row 0 being the header, which never
 * hides. Columns combine with AND: a row has to pass every filter to stay.
 *
 * This is the same answer the screen shows, reached from the file rather than
 * from the DOM, and the two agree because both route their text through
 * normalizeText: it resolves a wiki link to the alias it renders as, a markdown
 * link to its label, and strips emphasis, so markdown and rendered text arrive
 * at the same string. Anything needing this answer without a DOM to read, which
 * is SUBTOTAL and copy, asks here.
 */
export function filteredRows(lines: string[], ln: number): Set<number> {
	const out = new Set<number>();
	const { start, end, delimIdx } = tableBounds(lines, ln);
	if (delimIdx <= start) return out;
	const hr = parseRow(lines[start]);
	if (!hr || hr.isDelim) return out;
	const filters: (ColFilter | null)[] = [];
	let any = false;
	for (let c = 0; c < hr.cellCount; c++) {
		const f = parseFilterTag(parseCellContent(hr.pieces[c + 1]).flt);
		filters.push(f);
		if (f) any = true;
	}
	if (!any) return out;
	let grid = 0;
	for (let i = start; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (!r || r.isDelim) continue;
		if (grid > 0) {
			for (let c = 0; c < filters.length; c++) {
				if (!filters[c] || c >= r.cellCount) continue;
				if (!filterHit(parseCellContent(r.pieces[c + 1]).inner, filters[c])) {
					out.add(grid);
					break;
				}
			}
		}
		grid++;
	}
	return out;
}

/** Clear every column filter in the target's table. */
export function planClearFilters(lines: string[], target: CellTargetLoc): (EditPlan & { cleared: number }) | null {
	const ln = locateLine(lines, target);
	if (ln == null) return null;
	const { start, delimIdx } = tableBounds(lines, ln);
	if (delimIdx <= start) return null;
	const hr = parseRow(lines[start]);
	if (!hr || hr.isDelim) return null;
	let cleared = 0;
	for (let c = 0; c < hr.cellCount; c++) {
		const hp = parseCellContent(hr.pieces[c + 1]);
		if (!hp.flt) continue;
		const rebuilt = buildCellContent(hp.inner, hp.bg, hp.fg, hp.calc, hp.formula, hp.borders, hp.fmt, hp.hl, hp.w, hp.rule, hp.tbl, null, hp.list);
		hr.pieces[c + 1] = rebuilt ? ` ${rebuilt} ` : "   ";
		cleared++;
	}
	const text = hr.prefix + hr.pieces.join("|");
	return {
		edits: cleared ? [{ line: start, text }] : [],
		cursorLine: ln,
		cursorCh: cursorForCol(lines[ln], 0),
		cleared,
	};
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
		const rebuilt = buildCellContent(hp.inner, hp.bg, hp.fg, hp.calc, hp.formula, hp.borders, hp.fmt, hp.hl, hp.w, tag, hp.tbl, hp.flt, hp.list);
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
							parsed.tbl,
							parsed.flt,
							parsed.list
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

/** What a cell reads as once the plugin's wrapper and any whole-value emphasis
 *  markers come off: the text to hand anything leaving the vault. */
function cellDisplayText(piece: string): string {
	let v = parseCellContent(piece).inner;
	for (let i = 0; i < 3; i++) {
		v = v.replace(/^\*\*([\s\S]+)\*\*$/, "$1").replace(/^\*([^*]|[^*][\s\S]*[^*])\*$/, "$1").replace(/^~~([\s\S]+)~~$/, "$1");
	}
	return v.replace(/\\\|/g, "|").trim();
}

function csvDisplayText(piece: string): string {
	const v = cellDisplayText(piece);
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
				parsed.tbl,
				parsed.flt,
				parsed.list
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
		parsed.tbl,
		parsed.flt,
		parsed.list
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
		parsed.tbl,
		parsed.flt,
		parsed.list
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
		tag,
		parsed.flt,
		parsed.list
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
	const grid = tableGrid(lines, ln0);
	if (!grid) return null;
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

	const refOf = (line: number, col: number) => `${colLetterOf(col)}${gridRowOf(grid, line) + 1}`;
	const a = refOf(r1, c1);
	const b = refOf(rr2, cc2);
	const range = a === b ? a : `${a}:${b}`;

	let count = 0;
	for (let l = r1; l <= rr2; l++) {
		for (let c = c1; c <= cc2; c++) {
			if (l === result.line && c === result.col) continue;
			if (parseNumeric(grid.rows[gridRowOf(grid, l)]?.[c] ?? "")) count++;
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

/* ---------------- the fill handle's series ----------------

   Dragging the handle asks one question: what comes after these cells. The
   answer is text in and text out, with no notion of a document, so every rule
   below is testable on its own and the plan that uses them is only plumbing.

   The seed always arrives in fill order, so dragging up or left is the same
   problem as down or right with the seed read backwards, and one function
   answers all four. Whatever no rule can read as a series repeats instead,
   which is also what a spreadsheet does with it. */

/** The step between evenly spaced values, or the average step when they are
 *  not evenly spaced, which continues the line they describe. A lone value has
 *  no step of its own and takes the default its kind is dragged with. */
function seedStep(nums: number[], lone: number): number {
	if (nums.length < 2) return lone;
	return (nums[nums.length - 1] - nums[0]) / (nums.length - 1);
}

const DAY_MS = 86400000;
const dayNumber = (p: DateParts) => Math.round(Date.UTC(p.y, p.m - 1, p.d) / DAY_MS);

function dateFromDayNumber(n: number): DateParts {
	const d = new Date(n * DAY_MS);
	return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isMonthEnd = (p: DateParts) => p.d === lastDayOf(p.y, p.m);

/** Step whole months. A run sitting on month ends stays on them, so Jan 31 goes
 *  to Feb 28 and on to Mar 31; any other run holds its day of the month and
 *  clamps to the month landed in, so the 31st walks to the 30th, not the 1st. */
function addMonths(p: DateParts, k: number, monthEnd: boolean): DateParts {
	const total = p.y * 12 + (p.m - 1) + Math.round(k);
	const y = Math.floor(total / 12);
	const m = (((total % 12) + 12) % 12) + 1;
	const last = lastDayOf(y, m);
	return { y, m, d: monthEnd ? last : Math.min(p.d, last) };
}

/** Which of the date styles wrote this text, so the series keeps writing it. */
function datePatternOf(p: DateParts, sample: string): DatePatternId {
	return DATE_PATTERNS.find((id) => formatDateSpec(p, id) === sample.trim()) ?? "mdy";
}

function timePatternOf(t: TimeParts, sample: string): TimePatternId {
	return TIME_PATTERNS.find((id) => formatTimeSpec(t, id) === sample.trim()) ?? "h12";
}

function dateSeries(seed: string[], count: number): string[] | null {
	const parts = seed.map(parseDateCell);
	if (parts.some((p) => !p)) return null;
	const ps = parts as DateParts[];
	const last = ps[ps.length - 1];
	const pattern = datePatternOf(last, seed[seed.length - 1]);
	// A run that holds its day of the month, or that sits on month ends, is a
	// month series rather than a 28-to-31 day one. Testing that first is what
	// keeps a month-end run from drifting a few days earlier every step, which
	// matters most to the tables people keep months in.
	const monthEnd = ps.every(isMonthEnd);
	const gaps = new Set(ps.slice(1).map((p, i) => p.y * 12 + p.m - (ps[i].y * 12 + ps[i].m)));
	const byMonth = ps.length > 1 && (monthEnd || ps.every((p) => p.d === ps[0].d)) && gaps.size === 1 && !gaps.has(0);
	if (byMonth) {
		const step = [...gaps][0];
		return Array.from({ length: count }, (_, i) =>
			formatDateSpec(addMonths(last, step * (i + 1), monthEnd), pattern)
		);
	}
	const step = seedStep(ps.map(dayNumber), 1);
	const base = dayNumber(last);
	return Array.from({ length: count }, (_, i) => formatDateSpec(dateFromDayNumber(Math.round(base + step * (i + 1))), pattern));
}

function timeSeries(seed: string[], count: number): string[] | null {
	const parts = seed.map(parseTimeCell);
	if (parts.some((t) => !t)) return null;
	const ts = parts as TimeParts[];
	const secs = ts.map((t) => t.h * 3600 + t.min * 60 + (t.s ?? 0));
	// a lone time steps by the hour, the way one dragged in a spreadsheet does
	const step = seedStep(secs, 3600);
	const last = ts[ts.length - 1];
	const pattern = timePatternOf(last, seed[seed.length - 1]);
	const base = secs[secs.length - 1];
	return Array.from({ length: count }, (_, i) => {
		const at = (((Math.round(base + step * (i + 1)) % 86400) + 86400) % 86400);
		return formatTimeSpec({ h: Math.floor(at / 3600), min: Math.floor((at % 3600) / 60), s: last.s == null ? null : at % 60 }, pattern);
	});
}

/**
 * Render a projected number the way the seed wrote its own: same currency, same
 * grouping, same decimals, same percent, same accounting parentheses for a
 * negative. A series that changes how it looks halfway is not one.
 */
function likeNumber(value: number, sample: string): string {
	const s = sample.trim();
	const pct = /%\s*$/.test(s);
	const paren = /^\(.*\)$/.test(s);
	const currency = s.match(/\p{Sc}{1,3}/u)?.[0] ?? "";
	const digits = s.replace(/[^\d.,]/g, "");
	const dot = digits.lastIndexOf(".");
	const decimals = dot < 0 ? 0 : digits.length - dot - 1;
	const shown = pct ? value * 100 : value;
	const body =
		currency +
		Math.abs(shown).toLocaleString("en-US", {
			minimumFractionDigits: decimals,
			maximumFractionDigits: decimals,
			useGrouping: digits.includes(","),
		}) +
		(pct ? "%" : "");
	if (shown >= 0) return body;
	return paren ? `(${body})` : `-${body}`;
}

function numberSeries(seed: string[], count: number): string[] | null {
	const nums = seed.map(parseNumeric);
	if (nums.some((n) => !n)) return null;
	const vs = (nums as { value: number }[]).map((n) => n.value);
	// One number copies. That is the spreadsheet rule, and it is the right one:
	// a column of the same rate is a far more common drag than 1, 2, 3.
	const step = seedStep(vs, 0);
	const last = vs[vs.length - 1];
	const sample = seed[seed.length - 1];
	return Array.from({ length: count }, (_, i) => likeNumber(last + step * (i + 1), sample));
}

/** Where a name sits in its list, matched whole or by its first three letters. */
function nameIndex(list: string[], s: string): number {
	const t = s.trim().toLowerCase();
	if (!t) return -1;
	return list.findIndex((n) => n.toLowerCase() === t || n.slice(0, 3).toLowerCase() === t);
}

/** Re-render a name as the seed wrote it: abbreviated stays abbreviated, and
 *  an all-caps or all-lower seed keeps its case. */
function likeName(full: string, sample: string): string {
	const s = sample.trim();
	const out = s.length <= 3 ? full.slice(0, 3) : full;
	if (s === s.toUpperCase()) return out.toUpperCase();
	if (s === s.toLowerCase()) return out.toLowerCase();
	return out;
}

function nameSeries(seed: string[], count: number): string[] | null {
	for (const list of [WEEKDAY_NAMES, MONTH_NAMES]) {
		const idx = seed.map((s) => nameIndex(list, s));
		if (idx.some((i) => i < 0)) continue;
		// unwrap the wrap: Sat to Sun is +1, not -6
		const walked = idx.slice();
		for (let i = 1; i < walked.length; i++) {
			while (walked[i] < walked[i - 1]) walked[i] += list.length;
		}
		const step = Math.round(seedStep(walked, 1)) || 1;
		const last = walked[walked.length - 1];
		const sample = seed[seed.length - 1];
		return Array.from({ length: count }, (_, i) => {
			const at = (((last + step * (i + 1)) % list.length) + list.length) % list.length;
			return likeName(list[at], sample);
		});
	}
	return null;
}

/* the last run of digits in a cell: ".*?" is lazy, so the only way the tail can
   be all non-digits is for the run it found to be the final one */
const TAIL_NUM_RE = /^(.*?)(\d+)(\D*)$/;

function textNumberSeries(seed: string[], count: number): string[] | null {
	const parts = seed.map((s) => s.match(TAIL_NUM_RE));
	if (parts.some((m) => !m)) return null;
	const ms = parts as RegExpMatchArray[];
	const lead = ms[0][1];
	const trail = ms[0][3];
	if (ms.some((m) => m[1] !== lead || m[3] !== trail)) return null;
	const nums = ms.map((m) => parseInt(m[2], 10));
	const step = Math.round(seedStep(nums, 1)) || 1;
	const last = nums[nums.length - 1];
	const width = ms[ms.length - 1][2].length;
	const padded = ms[ms.length - 1][2].startsWith("0");
	return Array.from({ length: count }, (_, i) => {
		const n = last + step * (i + 1);
		const digits = padded ? String(Math.abs(n)).padStart(width, "0") : String(Math.abs(n));
		return `${lead}${n < 0 ? "-" : ""}${digits}${trail}`;
	});
}

/** No rule read it, so repeat the seed, which is what a spreadsheet does with a
 *  block it cannot extrapolate. */
function cycleSeed(seed: string[], count: number): string[] {
	return Array.from({ length: count }, (_, i) => seed[i % seed.length]);
}

/**
 * The next `count` values after a seed, the way dragging the fill handle
 * projects them. The seed is in fill order; project always continues past its
 * last entry, so a drag up or left passes its seed reversed.
 */
export function fillSeries(seed: string[], count: number): string[] {
	if (count <= 0) return [];
	const clean = seed.map((s) => s.trim());
	if (!clean.length || clean.every((s) => !s)) return Array.from({ length: count }, () => "");
	return (
		dateSeries(clean, count) ??
		timeSeries(clean, count) ??
		numberSeries(clean, count) ??
		nameSeries(clean, count) ??
		textNumberSeries(clean, count) ??
		cycleSeed(clean, count)
	);
}

/**
 * Reformat the table's raw markdown the way Obsidian's own editor does:
 * every cell padded to its column's widest content, delimiter dashes
 * stretched to match, right/center alignment reflected in the padding, and
 * ragged rows normalized to the full column count. Purely cosmetic in the
 * source; rendering is unchanged.
 */
/**
 * Excel's Fill Down and Fill Right. A selection spanning more than one row (or
 * column) uses its leading edge as the source and fills the rest; a single cell
 * fills from the neighbor above (or to the left), which is what Excel does when
 * you press Ctrl+D with nothing else selected.
 *
 * A filled formula moves by the distance it travelled, so relative refs follow
 * it and $-anchored ones hold still: =C2-B2 filled down becomes =C3-B3, while
 * =C2*$B$1 keeps its rate. The whole cell travels, presentation included, minus
 * the markers that describe a column rather than a cell (width, column rules,
 * table flags), which stay with the destination.
 */
export function planFill(
	lines: string[],
	targets: { line: number; col: number }[],
	dir: "down" | "right"
): (EditPlan & { filled: number }) | null {
	if (!targets.length) return null;
	const { start, end, delimIdx } = tableBounds(lines, targets[0].line);
	if (delimIdx < 0) return null;
	const inTable = targets.filter((t) => t.line >= start && t.line <= end && t.line !== delimIdx);
	if (!inTable.length) return null;
	const r1 = Math.min(...inTable.map((t) => t.line));
	const r2 = Math.max(...inTable.map((t) => t.line));
	const c1 = Math.min(...inTable.map((t) => t.col));
	const c2 = Math.max(...inTable.map((t) => t.col));

	// every real row of the table, in order: position k is grid row k, which is
	// what a fill distance has to be measured in (the delimiter is not a row)
	const rowLines: number[] = [];
	for (let i = start; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (r && !r.isDelim) rowLines.push(i);
	}
	const gridIdx = new Map(rowLines.map((l, k) => [l, k]));

	let srcLine = r1;
	let srcCol = c1;
	let dstLines: number[];
	const dstCols: number[] = [];
	if (dir === "down") {
		const span = rowLines.filter((l) => l >= r1 && l <= r2);
		if (span.length > 1) {
			srcLine = span[0];
			dstLines = span.slice(1);
		} else {
			const above = rowLines.filter((l) => l < r1);
			if (!above.length) return null;
			srcLine = above[above.length - 1];
			dstLines = [r1];
		}
		for (let c = c1; c <= c2; c++) dstCols.push(c);
	} else {
		if (c2 > c1) {
			for (let c = c1 + 1; c <= c2; c++) dstCols.push(c);
		} else {
			if (c1 === 0) return null;
			srcCol = c1 - 1;
			dstCols.push(c1);
		}
		dstLines = rowLines.filter((l) => l >= r1 && l <= r2);
	}
	if (!dstLines.length || !dstCols.length) return null;

	const fillCell = (srcPiece: string, dstPiece: string, op: RefOp): string => {
		const s = parseCellContent(srcPiece);
		const d = parseCellContent(dstPiece);
		let inner = s.inner;
		let formula: string | null = null;
		if (s.formula) formula = shiftFormulaRefs(s.formula, op);
		else if (looksLikeFormula(s.inner)) inner = shiftFormulaRefs(s.inner, op);
		const content = buildCellContent(inner, s.bg, s.fg, s.calc, formula, s.borders, s.fmt, s.hl, d.w, d.rule, d.tbl, d.flt, d.list);
		return content ? ` ${content} ` : "   ";
	};

	const edits: { line: number; text: string }[] = [];
	let filled = 0;
	for (const dl of dstLines) {
		const r = parseRow(lines[dl]);
		if (!r) continue;
		for (const dc of dstCols) {
			if (dc >= r.cellCount) continue;
			const sl = dir === "down" ? srcLine : dl;
			const sc = dir === "down" ? dc : srcCol;
			const sr = parseRow(lines[sl]);
			if (!sr || sc >= sr.cellCount) continue;
			const op: RefOp =
				dir === "down"
					? { axis: "row", kind: "offset", delta: (gridIdx.get(dl) ?? 0) - (gridIdx.get(sl) ?? 0) }
					: { axis: "col", kind: "offset", delta: dc - sc };
			const before = r.pieces[dc + 1];
			const after = fillCell(sr.pieces[sc + 1], before, op);
			if (after === before) continue;
			r.pieces[dc + 1] = after;
			filled++;
		}
		const text = r.prefix + r.pieces.join("|");
		if (text !== lines[dl]) edits.push({ line: dl, text });
	}
	const last = dstLines[dstLines.length - 1];
	return { edits, cursorLine: last, cursorCh: cursorForCol(lines[last], dstCols[dstCols.length - 1]), filled };
}

/** One cell a drag of the fill handle would write: where it goes, what lands
 *  in it, and which seed cell it takes its look and its formula from. */
type FillDrop = { line: number; col: number; inner: string; src: { line: number; col: number }; op: RefOp };

/**
 * What a drag of the fill handle from `seed` onto `dest` would write.
 *
 * The axis is settled by where dest sits: outside the seed's rows makes it a
 * row fill, otherwise outside its columns makes it a column fill. Each lane
 * (one column of a row fill, one row of a column fill) is projected on its own
 * from its own seed, which is what makes dragging a block of three columns fill
 * three independent series rather than one repeated.
 *
 * A lane holding a formula or a live calc is not extrapolated. It is copied the
 * way Fill Down copies it, with references shifted by the distance travelled,
 * because "what comes after =C2-B2" is =C3-B3 and no series can say that.
 */
function dragFillDrops(lines: string[], seed: { line: number; col: number }[], dest: { line: number; col: number }): FillDrop[] {
	if (!seed.length) return [];
	const { start, end, delimIdx } = tableBounds(lines, seed[0].line);
	if (delimIdx < 0) return [];
	const rowLines: number[] = [];
	for (let i = start; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (r && !r.isDelim) rowLines.push(i);
	}
	const gridIdx = new Map(rowLines.map((l, k) => [l, k]));
	const inSeed = seed.filter((t) => gridIdx.has(t.line));
	if (!inSeed.length || !gridIdx.has(dest.line)) return [];

	const r1 = Math.min(...inSeed.map((t) => t.line));
	const r2 = Math.max(...inSeed.map((t) => t.line));
	const c1 = Math.min(...inSeed.map((t) => t.col));
	const c2 = Math.max(...inSeed.map((t) => t.col));
	const seedRows = rowLines.filter((l) => l >= r1 && l <= r2);
	const seedCols: number[] = [];
	for (let c = c1; c <= c2; c++) seedCols.push(c);

	// which way the drag went, and how far
	let axis: "row" | "col";
	let dstRows: number[] = [];
	let dstCols: number[] = [];
	if (dest.line < r1 || dest.line > r2) {
		axis = "row";
		dstRows =
			dest.line > r2
				? rowLines.filter((l) => l > r2 && l <= dest.line)
				: rowLines.filter((l) => l >= dest.line && l < r1).reverse();
		dstCols = seedCols;
	} else if (dest.col < c1 || dest.col > c2) {
		axis = "col";
		dstRows = seedRows;
		// nearest the seed first, so a series always projects outward from it
		if (dest.col > c2) for (let c = c2 + 1; c <= dest.col; c++) dstCols.push(c);
		else for (let c = c1 - 1; c >= dest.col; c--) dstCols.push(c);
	} else {
		return [];
	}
	if (!dstRows.length || !dstCols.length) return [];

	const back = axis === "row" ? dest.line < r1 : dest.col < c1;
	const lanes = axis === "row" ? dstCols : dstRows;
	const drops: FillDrop[] = [];
	for (const lane of lanes) {
		// the lane's seed cells, nearest the drag last, so a series always
		// continues past the edge the handle was pulled from
		const along = axis === "row" ? seedRows : seedCols;
		const order = back ? along.slice().reverse() : along;
		const srcCells = order.map((v) =>
			axis === "row" ? { line: v, col: lane } : { line: lane, col: v }
		);
		const pieces = srcCells.map((s) => {
			const r = parseRow(lines[s.line]);
			return r && s.col < r.cellCount ? r.pieces[s.col + 1] : "";
		});
		const parsed = pieces.map(parseCellContent);
		const copying = parsed.some((p) => p.formula || p.calc || looksLikeFormula(p.inner));
		const outs = axis === "row" ? dstRows : dstCols;
		const values = copying ? [] : fillSeries(parsed.map((p) => p.inner), outs.length);
		outs.forEach((v, i) => {
			const at = axis === "row" ? { line: v, col: lane } : { line: lane, col: v };
			// copying cycles the seed so a two-cell block alternates, the same
			// rule the series path falls back on
			const src = copying ? srcCells[i % srcCells.length] : srcCells[srcCells.length - 1];
			const op: RefOp =
				axis === "row"
					? { axis: "row", kind: "offset", delta: (gridIdx.get(at.line) ?? 0) - (gridIdx.get(src.line) ?? 0) }
					: { axis: "col", kind: "offset", delta: at.col - src.col };
			drops.push({ ...at, inner: copying ? "" : values[i], src, op });
		});
	}
	return drops;
}

/** The value the fill handle would drop in `dest`, for the label that follows
 *  the pointer. Null where the drag would write nothing there. */
export function dragFillPreview(
	lines: string[],
	seed: { line: number; col: number }[],
	dest: { line: number; col: number }
): string | null {
	const drop = dragFillDrops(lines, seed, dest).find((d) => d.line === dest.line && d.col === dest.col);
	if (!drop) return null;
	const r = parseRow(lines[drop.src.line]);
	const piece = r && drop.src.col < r.cellCount ? r.pieces[drop.src.col + 1] : "";
	const s = parseCellContent(piece);
	// a copied lane shows the formula it will carry, shifted to where it lands
	if (s.formula) return shiftFormulaRefs(s.formula, drop.op);
	if (looksLikeFormula(s.inner)) return shiftFormulaRefs(s.inner, drop.op);
	if (s.calc) return s.inner;
	return drop.inner;
}

/**
 * Apply a drag of the fill handle. The whole drag is one edit, so it is one
 * undo, however many cells it covered.
 *
 * What travels is the source cell's look, its number format and its borders;
 * what stays behind is everything describing the destination's column rather
 * than its contents (width, column rules, table flags), which is the same
 * division Fill Down makes.
 */
export function planDragFill(
	lines: string[],
	seed: { line: number; col: number }[],
	dest: { line: number; col: number }
): (EditPlan & { filled: number }) | null {
	const drops = dragFillDrops(lines, seed, dest);
	if (!drops.length) return null;
	const byLine = new Map<number, FillDrop[]>();
	for (const d of drops) byLine.set(d.line, [...(byLine.get(d.line) ?? []), d]);

	const edits: { line: number; text: string }[] = [];
	let filled = 0;
	for (const [line, ds] of byLine) {
		const r = parseRow(lines[line]);
		if (!r) continue;
		for (const d of ds) {
			if (d.col >= r.cellCount) continue;
			const sr = parseRow(lines[d.src.line]);
			if (!sr || d.src.col >= sr.cellCount) continue;
			const s = parseCellContent(sr.pieces[d.src.col + 1]);
			const keep = parseCellContent(r.pieces[d.col + 1]);
			let inner = d.inner;
			let formula: string | null = null;
			if (s.formula) formula = shiftFormulaRefs(s.formula, d.op);
			else if (looksLikeFormula(s.inner)) inner = shiftFormulaRefs(s.inner, d.op);
			else if (s.calc) inner = s.inner;
			const content = buildCellContent(
				formula || s.calc ? s.inner : inner,
				s.bg,
				s.fg,
				s.calc,
				formula,
				s.borders,
				s.fmt,
				s.hl,
				keep.w,
				keep.rule,
				keep.tbl,
				keep.flt,
				keep.list
			);
			const after = content ? ` ${content} ` : "   ";
			if (after === r.pieces[d.col + 1]) continue;
			r.pieces[d.col + 1] = after;
			filled++;
		}
		const text = r.prefix + r.pieces.join("|");
		if (text !== lines[line]) edits.push({ line, text });
	}
	if (!filled) return null;
	const lastLine = drops[drops.length - 1].line;
	return { edits, cursorLine: lastLine, cursorCh: cursorForCol(lines[lastLine], drops[drops.length - 1].col), filled };
}

/* ---------------- copy, cut and paste a block of cells ---------------- */

export type PasteMode = "all" | "values" | "formulas" | "formats";

/**
 * A rectangle of cells lifted out of a table.
 *
 * Cells are held as their raw pieces, so the whole cell travels: value,
 * formula, colors, borders, number format. Coordinates are grid coordinates
 * with the header as row 0, because that is the space a relative reference is
 * measured in: a formula pasted three rows down has to move three rows, and
 * the divider is not a row.
 */
export interface CellClip {
	rows: string[][];
	/** Grid row each clip row came from. A filter can hide a row out of the
	 *  middle of a copied block, so these are not always consecutive, and a
	 *  reference shifts by the distance its own cell travelled. */
	srcRows: number[];
	row: number;
	col: number;
	/**
	 * What a pasted formula's references do. A copy shifts them to where the
	 * formula lands, the way Excel's relative references work. A cut moves the
	 * cells themselves, so they keep pointing where they already pointed. Text
	 * arriving from outside has no source coordinates to measure a shift from.
	 */
	refs: "shift" | "hold";
	/** A cut empties its source when the paste lands. */
	cut: boolean;
	/** Where the block came from, so its owner can tell whether a cut is landing
	 *  in the same file it was taken from. Nothing here reads it. */
	path: string;
	/** Document lines the block came from, for that same cut to clear. */
	lineNos: number[];
}

/** Lift the rectangle the targets span out of its table. */
export function planCopyCells(
	lines: string[],
	targets: { line: number; col: number }[],
	opts: { cut?: boolean; path?: string } = {}
): CellClip | null {
	if (!targets.length) return null;
	const { start, end, delimIdx } = tableBounds(lines, targets[0].line);
	if (delimIdx < 0) return null;
	const inTable = targets.filter((t) => t.line >= start && t.line <= end && t.line !== delimIdx);
	if (!inTable.length) return null;
	const r1 = Math.min(...inTable.map((t) => t.line));
	const r2 = Math.max(...inTable.map((t) => t.line));
	const c1 = Math.min(...inTable.map((t) => t.col));
	const c2 = Math.max(...inTable.map((t) => t.col));

	const rowLines: number[] = [];
	for (let i = start; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (r && !r.isDelim) rowLines.push(i);
	}
	// A row an AutoFilter is hiding is not copied, which is what Excel does with
	// a filtered range: what you take is what you can see. It matters most for
	// the selections that never had to be visible to be made, like pressing a
	// column's guide letter.
	const hidden = filteredRows(lines, targets[0].line);
	const lineNos = rowLines.filter((l, k) => l >= r1 && l <= r2 && !hidden.has(k));
	if (!lineNos.length) return null;

	const rows = lineNos.map((l) => {
		const r = parseRow(lines[l])!;
		// a ragged row is short, not broken: the missing cells read as blank
		return Array.from({ length: c2 - c1 + 1 }, (_, k) => (c1 + k < r.cellCount ? r.pieces[c1 + k + 1] : "   "));
	});
	return {
		rows,
		srcRows: lineNos.map((l) => rowLines.indexOf(l)),
		row: rowLines.indexOf(lineNos[0]),
		col: c1,
		refs: opts.cut ? "hold" : "shift",
		cut: !!opts.cut,
		path: opts.path ?? "",
		lineNos,
	};
}

/** The block as tab-separated text, which is what a spreadsheet reads off the
 *  clipboard. Wrappers and emphasis markers come off; a tab or a newline inside
 *  a cell would break the grid it is describing, so those collapse to spaces. */
export function clipToTsv(clip: CellClip): string {
	return clip.rows.map((r) => r.map((p) => cellDisplayText(p).replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n");
}

/** A block that came from outside the vault: plain text, and no source
 *  coordinates to shift a reference against. */
export function clipFromRows(rows: string[][]): CellClip | null {
	if (!rows.length) return null;
	const width = Math.max(...rows.map((r) => r.length), 1);
	return {
		rows: rows.map((r) => Array.from({ length: width }, (_, i) => ` ${csvCell((r[i] ?? "").trim())} `)),
		srcRows: rows.map((_, i) => i),
		row: 0,
		col: 0,
		refs: "hold",
		cut: false,
		path: "",
		lineNos: [],
	};
}

/**
 * One cell of a paste: what the source contributes and what the destination
 * keeps, following Excel's paste-special menu.
 *
 * Markers describing the column rather than the cell (width, column rules,
 * table flags) always stay with the destination, the same division Fill Down
 * makes: they belong to the column, not to whatever landed in it.
 */
function pasteCell(srcPiece: string, dstPiece: string, mode: PasteMode, rowD: number, colD: number): string {
	const s = parseCellContent(srcPiece);
	const d = parseCellContent(dstPiece);
	const shift = (f: string) => {
		let out = f;
		if (rowD) out = shiftFormulaRefs(out, { axis: "row", kind: "offset", delta: rowD });
		if (colD) out = shiftFormulaRefs(out, { axis: "col", kind: "offset", delta: colD });
		return out;
	};
	const wrap = (content: string) => (content ? ` ${content} ` : "   ");

	// Formats: the look travels and the value stays put, which is the format
	// painter's contract applied to a whole block at once.
	if (mode === "formats") {
		return wrap(buildCellContent(d.inner, s.bg, s.fg, d.calc, d.formula, s.borders, s.fmt, s.hl, d.w, d.rule, d.tbl, d.flt, d.list));
	}

	let inner = s.inner;
	let formula = s.formula ? shift(s.formula) : null;
	let calc = s.calc;
	if (mode === "values") {
		// Values only: a live formula lands as the number it was showing, which
		// is what Freeze value does to a single cell. A formula typed but not
		// yet settled has no value to land, so it travels as the formula it
		// still is, re-pointed rather than left reading someone else's cells.
		formula = null;
		calc = null;
	}
	if (looksLikeFormula(inner)) inner = shift(inner);

	// Only a whole-cell paste brings the source's look with it; Values and
	// Formulas land in the destination's own formatting, as they do in Excel.
	const look = mode === "all" ? s : d;
	return wrap(
		buildCellContent(inner, look.bg, look.fg, calc, formula, look.borders, look.fmt, look.hl, d.w, d.rule, d.tbl, d.flt, d.list)
	);
}

/** What a cut leaves behind: an empty cell, keeping only the markers that
 *  describe its column. */
function emptiedCell(piece: string): string {
	const p = parseCellContent(piece);
	const content = buildCellContent("", null, null, null, null, null, null, false, p.w, p.rule, p.tbl, p.flt, p.list);
	return content ? ` ${content} ` : "   ";
}

/**
 * Paste a block at the targeted cell, Excel's way.
 *
 * The block's top-left lands on the top-left of what is targeted. A selection
 * that is a whole multiple of the block tiles it, the way Excel fills a
 * selection from a smaller copy. A block that runs off the bottom grows the
 * table, because rows are cheap in Markdown; one that runs off the right is
 * clamped and the plan says how many cells it had to drop, because columns are
 * structural and silently widening a table is a bigger surprise than a count.
 *
 * A cut's source empties as part of the same edit, so a move is one undo. The
 * clear runs before the paste on the same working rows, which is what makes an
 * overlapping move (cut A2:A4, paste at A3) land correctly instead of erasing
 * what it just wrote.
 */
export function planPasteCells(
	lines: string[],
	targets: { line: number; col: number }[],
	clip: CellClip,
	mode: PasteMode = "all",
	transpose = false
): (EditPlan & { pasted: number; clamped: number; added: number; cleared: number }) | null {
	if (!targets.length || !clip.rows.length) return null;
	const { start, end, delimIdx } = tableBounds(lines, targets[0].line);
	if (delimIdx < 0) return null;
	const inTable = targets.filter((t) => t.line >= start && t.line <= end && t.line !== delimIdx);
	if (!inTable.length) return null;

	const rowLines: number[] = [];
	for (let i = start; i <= end; i++) {
		const r = parseRow(lines[i]);
		if (r && !r.isDelim) rowLines.push(i);
	}
	const top = Math.min(...inTable.map((t) => t.line));
	const bottom = Math.max(...inTable.map((t) => t.line));
	const left = Math.min(...inTable.map((t) => t.col));
	const right = Math.max(...inTable.map((t) => t.col));
	const anchorIdx = rowLines.indexOf(top);
	if (anchorIdx < 0) return null;

	// One working copy per line, shared by the clear and the paste so both see
	// each other's changes and one edit per line comes out at the end.
	const work = new Map<number, ParsedRow>();
	const rowFor = (line: number): ParsedRow | null => {
		const got = work.get(line);
		if (got) return got;
		const r = parseRow(lines[line] ?? "");
		if (!r || r.isDelim) return null;
		work.set(line, r);
		return r;
	};

	// Every cell of the block remembers where it came from: after a transpose no
	// two cells have travelled the same distance, and that distance is what a
	// relative reference moves by.
	const h = clip.rows.length;
	const w = Math.max(...clip.rows.map((r) => r.length), 1);
	const bh = transpose ? w : h;
	const bw = transpose ? h : w;
	const cellAt = (i: number, j: number) => {
		const si = transpose ? j : i;
		const sj = transpose ? i : j;
		return {
			piece: clip.rows[si]?.[sj] ?? "   ",
			row: clip.srcRows?.[si] ?? clip.row + si,
			col: clip.col + sj,
		};
	};

	// Excel tiles a copied block over a selection that is a whole multiple of
	// it, and pastes it once anywhere else.
	const selRows = rowLines.filter((l) => l >= top && l <= bottom).length;
	const selCols = right - left + 1;
	const tall = selRows > bh && selRows % bh === 0 ? selRows / bh : 1;
	const wide = selCols > bw && selCols % bw === 0 ? selCols / bw : 1;
	const needRows = bh * tall;
	const needCols = bw * wide;

	// A cut only clears cells that still hold exactly what was cut. Anything
	// else and the block has moved since, so clearing would take a bystander
	// with it; the paste still lands and the plan reports nothing cleared.
	let cleared = 0;
	if (clip.cut && clip.lineNos.length === clip.rows.length) {
		const intact = clip.lineNos.every((ln, i) => {
			const r = parseRow(lines[ln] ?? "");
			if (!r || r.isDelim) return false;
			return clip.rows[i].every((piece, j) => clip.col + j < r.cellCount && r.pieces[clip.col + j + 1] === piece);
		});
		if (intact) {
			clip.lineNos.forEach((ln, i) => {
				const r = rowFor(ln);
				if (!r) return;
				clip.rows[i].forEach((piece, j) => {
					const c = clip.col + j + 1;
					const next = emptiedCell(piece);
					if (r.pieces[c] === next) return;
					r.pieces[c] = next;
					cleared++;
				});
			});
		}
	}

	// Rows the paste lands on: existing ones first, then as many blank ones as
	// it takes to hold the rest.
	const width = parseRow(lines[delimIdx])?.cellCount ?? 0;
	const prefix = parseRow(lines[start])?.prefix ?? "";
	const dsts: { line: number; row: ParsedRow; insert: boolean }[] = [];
	for (let k = 0; k < needRows; k++) {
		const idx = anchorIdx + k;
		if (idx < rowLines.length) {
			const r = rowFor(rowLines[idx]);
			if (!r) return null;
			dsts.push({ line: rowLines[idx], row: r, insert: false });
		} else {
			// every appended row goes in at the same original line, in order,
			// which is the run of inserts the appliers expect
			const r = parseRow(emptyRow(prefix, width));
			if (!r) return null;
			dsts.push({ line: end + 1, row: r, insert: true });
		}
	}
	const added = dsts.filter((d) => d.insert).length;

	let pasted = 0;
	let clamped = 0;
	for (let k = 0; k < needRows; k++) {
		const d = dsts[k];
		for (let n = 0; n < needCols; n++) {
			const dc = left + n;
			if (dc >= d.row.cellCount) {
				clamped++;
				continue;
			}
			const src = cellAt(k % bh, n % bw);
			const rowD = clip.refs === "shift" ? anchorIdx + k - src.row : 0;
			const colD = clip.refs === "shift" ? dc - src.col : 0;
			const before = d.row.pieces[dc + 1];
			const after = pasteCell(src.piece, before, mode, rowD, colD);
			if (after === before) continue;
			d.row.pieces[dc + 1] = after;
			pasted++;
		}
	}

	const edits: { line: number; text: string; kind?: EditKind }[] = [];
	for (const [line, r] of [...work].sort((a, b) => a[0] - b[0])) {
		const text = r.prefix + r.pieces.join("|");
		if (text !== lines[line]) edits.push({ line, text });
	}
	for (const d of dsts) {
		if (d.insert) edits.push({ line: d.line, text: d.row.prefix + d.row.pieces.join("|"), kind: "insert" });
	}
	if (!edits.length) return null;

	const last = dsts[dsts.length - 1];
	const lastText = last.insert ? last.row.prefix + last.row.pieces.join("|") : (lines[last.line] ?? "");
	return {
		edits,
		cursorLine: last.line,
		cursorCh: cursorForCol(lastText, Math.min(left + needCols - 1, last.row.cellCount - 1)),
		pasted,
		clamped,
		added,
		cleared,
	};
}

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
