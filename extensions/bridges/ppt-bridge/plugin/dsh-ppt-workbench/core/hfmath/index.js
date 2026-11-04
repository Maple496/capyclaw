import { HERSHEY } from "./hershey.js";
import { SYMB, asciiMap } from "./symbols.js";
import { stretch } from "./stretch.js";
const CONFIG = {
  SUB_SUP_SCALE: 0.75,
  SQRT_MAG_SCALE: 0.5,
  FRAC_SCALE: 0.85,
  LINE_SPACING: 0.5,
  FRAC_SPACING: 0.4
};
const MATRIX_DELIMITERS = /* @__PURE__ */ new Map([
  ["matrix", []],
  ["bmatrix", ["[", "]"]],
  ["pmatrix", ["(", ")"]],
  ["Bmatrix", ["\\{", "\\}"]],
  ["vmatrix", ["\\lvert", "\\rvert"]],
  ["Vmatrix", ["\\lVert", "\\rVert"]],
  ["cases", ["\\{"]]
]);
function tokenize(str) {
  return str.match(/\\[A-Za-z]+|\\[^\r\n]|[A-Za-z0-9.]+|[^\s]/g) ?? [];
}
function parseAtom(x) {
  return { type: SYMB[x] ? "symb" : "char", mode: "math", text: x, chld: [], bbox: null };
}
function parse(tokens) {
  const input = tokens.slice();
  let i = 0;
  function empty() {
    return { type: "node", text: "", mode: "math", chld: [], bbox: null };
  }
  function delimited(open, close) {
    const start = ++i;
    let depth = 1;
    let braces = 0;
    while (i < input.length) {
      const token = input[i];
      if (open === "[" && token === "{") braces++;
      if (open === "[" && token === "}") braces--;
      if (!braces && token === open) depth++;
      if (!braces && token === close && --depth === 0) break;
      i++;
    }
    const result = parse(input.slice(start, i));
    if (i < input.length) i++;
    return result;
  }
  function atom(argument = false) {
    if (i >= input.length || argument && input[i] === "}") return empty();
    if (input[i] === "{") {
      const child = delimited("{", "}");
      if (argument) return child;
      return { ...empty(), chld: [child] };
    }
    let token = input[i++];
    if (argument && /^[A-Za-z0-9.]{2,}$/.test(token)) {
      input.splice(i, 0, token.slice(1));
      token = token[0];
    }
    if (token === "\\operatorname" && input[i] === "*") {
      token += input[i++];
    }
    const expr2 = parseAtom(token);
    const symbol = SYMB[token];
    if (symbol?.arity) {
      expr2.type = "func";
      const optional = symbol.flags.opt && input[i] === "[" ? delimited("[", "]") : null;
      for (let n = 0; n < symbol.arity; n++) expr2.chld.push(atom(true));
      if (optional) expr2.chld.push(optional);
    }
    if (token === "\\begin" && expr2.chld[0]?.text === "array" && input[i] === "{") {
      let end = i + 1;
      while (end < input.length && /^[lcr]+$/.test(input[end])) end++;
      if (end > i + 1 && input[end] === "}") {
        expr2.columns = input.slice(i + 1, end).join("");
        i = end + 1;
      }
    }
    if (symbol?.flags.brace) {
      while (input[i] === "^" || input[i] === "_") expr2.chld.push(atom());
    }
    return expr2;
  }
  const expr = empty();
  while (i < input.length) expr.chld.push(atom());
  return expr.chld.length === 1 ? expr.chld[0] : expr;
}
function environments(exprs) {
  let i = 0;
  while (i < exprs.length) {
    if (exprs[i].text === "\\begin") {
      let j = i + 1;
      let depth = 1;
      for (; j < exprs.length; j++) {
        if (exprs[j].text === "\\begin") depth++;
        if (exprs[j].text === "\\end" && --depth === 0) break;
      }
      if (j === exprs.length) {
        i++;
        continue;
      }
      const es = exprs.splice(i + 1, j - (i + 1));
      environments(es);
      exprs[i].text = exprs[i].chld[0].text;
      exprs[i].chld = es;
      exprs.splice(i + 1, 1);
    } else {
      environments(exprs[i].chld);
    }
    i++;
  }
}
function transform(expr, sclx, scly, x, y, notFirst) {
  if (scly === null || scly === void 0) {
    scly = sclx;
  }
  if (!expr.bbox) return;
  if (notFirst) {
    expr.bbox.x *= sclx;
    expr.bbox.y *= scly;
  }
  expr.bbox.w *= sclx;
  expr.bbox.h *= scly;
  for (let i = 0; i < expr.chld.length; i++) {
    transform(expr.chld[i], sclx, scly, 0, 0, true);
  }
  expr.bbox.x += x;
  expr.bbox.y += y;
}
function computeBbox(exprs) {
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (let i = 0; i < exprs.length; i++) {
    if (!exprs[i].bbox) {
      continue;
    }
    xmin = Math.min(xmin, exprs[i].bbox.x);
    ymin = Math.min(ymin, exprs[i].bbox.y);
    xmax = Math.max(xmax, exprs[i].bbox.x + exprs[i].bbox.w);
    ymax = Math.max(ymax, exprs[i].bbox.y + exprs[i].bbox.h);
  }
  return xmin === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin };
}
function group(exprs) {
  if (!exprs.length) {
    return null;
  }
  const bbox = computeBbox(exprs);
  for (let i = 0; i < exprs.length; i++) {
    if (!exprs[i].bbox) {
      continue;
    }
    exprs[i].bbox.x -= bbox.x;
    exprs[i].bbox.y -= bbox.y;
  }
  const expr = {
    type: "node",
    text: "",
    mode: "math",
    chld: exprs,
    bbox
  };
  return expr;
}
function align(exprs, alignment = "center") {
  for (let i = 0; i < exprs.length; i++) {
    if (exprs[i].text === "^" || exprs[i].text === "'") {
      let h = 0;
      let j = i;
      while (j > 0 && (exprs[j].text === "^" || exprs[j].text === "_" || exprs[j].text === "'")) {
        j--;
      }
      h = exprs[j].bbox.y;
      if (exprs[i].text === "'") {
        exprs[i].bbox.y = h;
      } else {
        transform(exprs[i], CONFIG.SUB_SUP_SCALE, null, 0, 0);
        if (SYMB[exprs[j].text] && SYMB[exprs[j].text].flags.big) {
          exprs[i].bbox.y = h - exprs[i].bbox.h;
        } else if (SYMB[exprs[j].text]?.flags.integral) {
          exprs[i].bbox.y = h;
        } else {
          exprs[i].bbox.y = h - exprs[i].bbox.h / 2;
        }
      }
    } else if (exprs[i].text === "_") {
      let h = 1;
      let j = i;
      while (j > 0 && (exprs[j].text === "^" || exprs[j].text === "_" || exprs[j].text === "'")) {
        j--;
      }
      h = exprs[j].bbox.y + exprs[j].bbox.h;
      transform(exprs[i], CONFIG.SUB_SUP_SCALE, null, 0, 0);
      if (SYMB[exprs[j].text] && SYMB[exprs[j].text].flags.big) {
        exprs[i].bbox.y = h;
      } else if (SYMB[exprs[j].text]?.flags.integral) {
        exprs[i].bbox.y = h - exprs[i].bbox.h;
      } else {
        exprs[i].bbox.y = h - exprs[i].bbox.h / 2;
      }
    }
  }
  function searchHigh(i, l, r, dir, lvl0) {
    let j = i;
    let lvl = lvl0;
    let ymin = Infinity;
    let ymax = -Infinity;
    while (dir > 0 ? j < exprs.length : j >= 0) {
      if (exprs[j].text === l) {
        lvl++;
      } else if (exprs[j].text === r) {
        lvl--;
        if (lvl === 0) {
          break;
        }
      } else if (exprs[j].text === "^" || exprs[j].text === "_") {
      } else if (exprs[j].bbox) {
        ymin = Math.min(ymin, exprs[j].bbox.y);
        ymax = Math.max(ymax, exprs[j].bbox.y + exprs[j].bbox.h);
      }
      j += dir;
    }
    return [ymin, ymax];
  }
  for (let i = 0; i < exprs.length; i++) {
    if (exprs[i].text === "\\left") {
      const [ymin, ymax] = searchHigh(i, "\\left", "\\right", 1, 0);
      if (ymin !== Infinity && ymax !== -Infinity) {
        exprs[i].bbox.y = ymin;
        transform(exprs[i], 1, (ymax - ymin) / exprs[i].bbox.h, 0, 0);
      }
    } else if (exprs[i].text === "\\right") {
      const [ymin, ymax] = searchHigh(i, "\\right", "\\left", -1, 0);
      if (ymin !== Infinity && ymax !== -Infinity) {
        exprs[i].bbox.y = ymin;
        transform(exprs[i], 1, (ymax - ymin) / exprs[i].bbox.h, 0, 0);
      }
    } else if (exprs[i].text === "\\middle") {
      const [lmin, lmax] = searchHigh(i, "\\right", "\\left", -1, 1);
      const [rmin, rmax] = searchHigh(i, "\\left", "\\right", 1, 1);
      const ymin = Math.min(lmin, rmin);
      const ymax = Math.max(lmax, rmax);
      if (ymin !== Infinity && ymax !== -Infinity) {
        exprs[i].bbox.y = ymin;
        transform(exprs[i], 1, (ymax - ymin) / exprs[i].bbox.h, 0, 0);
      }
    }
  }
  if (!exprs.some((x) => x.text === "&" || x.text === "\\\\")) {
    return;
  }
  const rows = [];
  let row = [];
  let cell = [];
  for (let i = 0; i < exprs.length; i++) {
    if (exprs[i].text === "&") {
      row.push(cell);
      cell = [];
    } else if (exprs[i].text === "\\\\") {
      row.push(cell);
      cell = [];
      rows.push(row);
      row = [];
    } else {
      cell.push(exprs[i]);
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
  }
  if (row.length) {
    rows.push(row);
  }
  const colws = [];
  const erows = [];
  for (let i = 0; i < rows.length; i++) {
    const erow = [];
    const cells = rows[i].map(group);
    const rowY = cells.reduce((y, cell2) => cell2 ? Math.min(y, cell2.bbox.y) : y, Infinity);
    for (let j = 0; j < cells.length; j++) {
      const e = cells[j] ?? {
        type: "node",
        text: "",
        mode: "math",
        chld: [],
        bbox: { x: 0, y: Number.isFinite(rowY) ? rowY : 0, w: 0, h: 2 }
      };
      colws[j] = Math.max(e.bbox.w + 1, colws[j] ?? 0);
      erow[j] = e;
    }
    erows.push(erow);
  }
  const ybds = [];
  for (let i = 0; i < erows.length; i++) {
    let ymin = Infinity;
    let ymax = -Infinity;
    for (let j = 0; j < erows[i].length; j++) {
      const e = erows[i][j];
      ymin = Math.min(ymin, e.bbox.y);
      ymax = Math.max(ymax, e.bbox.y + e.bbox.h);
    }
    ybds.push([ymin, ymax]);
  }
  for (let i = 0; i < ybds.length; i++) {
    if (!Number.isFinite(ybds[i][0]) || !Number.isFinite(ybds[i][1])) {
      ybds[i][0] = i === 0 ? 0 : ybds[i - 1][1];
      ybds[i][1] = ybds[i][0] + 2;
    }
  }
  for (let i = 1; i < erows.length; i++) {
    const shft = ybds[i - 1][1] - ybds[i][0] + CONFIG.LINE_SPACING;
    for (let j = 0; j < erows[i].length; j++) {
      const e = erows[i][j];
      e.bbox.y += shft;
    }
    ybds[i][0] += shft;
    ybds[i][1] += shft;
  }
  exprs.splice(0, exprs.length);
  for (let i = 0; i < erows.length; i++) {
    let dx = 0;
    for (let j = 0; j < erows[i].length; j++) {
      const e = erows[i][j];
      e.bbox.x += dx;
      dx += colws[j] - e.bbox.w;
      if (alignment === "center") {
        e.bbox.x += (colws[j] - e.bbox.w) / 2;
      } else if (alignment === "left") {
      } else if (alignment === "right") {
        e.bbox.x += colws[j] - e.bbox.w;
      } else if (alignment === "equation") {
        if (j !== erows[i].length - 1) {
          e.bbox.x += colws[j] - e.bbox.w;
        }
      }
      exprs.push(e);
    }
  }
}
function planLabel(label, mode) {
  if (!label) return;
  plan(label, mode);
  transform(label, CONFIG.SUB_SUP_SCALE, null, 0, 0);
  if (!label.bbox.w) label.bbox.h = 0;
}
function planGroup(expr, mode) {
  const body = expr.chld[0];
  const upper = expr.chld.slice(1).find((child) => child.text === "^");
  const lower = expr.chld.slice(1).find((child) => child.text === "_");
  plan(body, mode);
  planLabel(upper, mode);
  planLabel(lower, mode);
  const bodyY = body.bbox.y;
  const gap = 0.2;
  const height = SYMB[expr.text].flags.brace ? 0.65 : 0.45;
  const decorationWidth = Math.max(body.bbox.w, 1.2);
  const width = Math.max(decorationWidth, upper?.bbox.w ?? 0, lower?.bbox.w ?? 0);
  const above = !SYMB[expr.text].flags.under;
  const top = upper?.bbox.h ? upper.bbox.h + gap : 0;
  const bottom = lower?.bbox.h ? lower.bbox.h + gap : 0;
  const blockHeight = body.bbox.h + height + gap;
  const decoration = {
    type: "stretch",
    text: expr.text,
    mode,
    chld: [],
    bbox: {
      x: (width - decorationWidth) / 2,
      y: top + (above ? 0 : body.bbox.h + gap),
      w: decorationWidth,
      h: height
    }
  };
  body.bbox.x = (width - body.bbox.w) / 2;
  body.bbox.y = top + (above ? height + gap : 0);
  if (upper) {
    upper.bbox.x = (width - upper.bbox.w) / 2;
    upper.bbox.y = 0;
  }
  if (lower) {
    lower.bbox.x = (width - lower.bbox.w) / 2;
    lower.bbox.y = top + blockHeight + gap;
  }
  expr.bbox = { x: 0, y: bodyY - body.bbox.y, w: width, h: top + blockHeight + bottom };
  expr.type = "node";
  expr.chld = [decoration, body, ...[upper, lower].filter((label) => !!label)];
}
function planArrow(expr, mode) {
  const [upper, lower] = expr.chld;
  planLabel(upper, mode);
  planLabel(lower, mode);
  const gap = 0.2;
  const side = 0.25;
  const height = 0.6;
  const arrowTop = 1 - height / 2;
  const width = Math.max(3, Math.max(upper?.bbox.w ?? 0, lower?.bbox.w ?? 0) + 1);
  const top = Math.min(0, upper?.bbox.h ? arrowTop - gap - upper.bbox.h : 0);
  const bottom = Math.max(2, lower?.bbox.h ? arrowTop + height + gap + lower.bbox.h : 2);
  const arrow = {
    type: "stretch",
    text: expr.text,
    mode,
    chld: [],
    bbox: { x: side, y: arrowTop - top, w: width, h: height }
  };
  if (upper) {
    upper.bbox.x = side + (width - upper.bbox.w) / 2;
    upper.bbox.y = arrowTop - gap - upper.bbox.h - top;
  }
  if (lower) {
    lower.bbox.x = side + (width - lower.bbox.w) / 2;
    lower.bbox.y = arrowTop + height + gap - top;
  }
  expr.bbox = { x: 0, y: top, w: width + 2 * side, h: bottom - top };
  expr.type = "node";
  expr.chld = [arrow, ...[upper, lower].filter((label) => !!label)];
}
function isGrid(expr) {
  return expr.text === "gathered" && expr.type !== "char" || expr.text === "array" && !!expr.columns;
}
function planGrid(expr, mode) {
  const gathered = expr.text === "gathered";
  const rows = [];
  let row = [[]];
  let pending = false;
  for (const child of expr.chld) {
    if (child.text === "\\\\") {
      rows.push(row);
      row = [[]];
      pending = false;
    } else if (child.text === "&") {
      if (!gathered) {
        row.push([]);
        pending = true;
      }
    } else {
      row[row.length - 1].push(child);
      pending = true;
    }
  }
  if (pending || !rows.length) rows.push(row);
  const columnCount = rows.reduce((count, cells2) => Math.max(count, cells2.length), expr.columns?.length ?? 1);
  const widths = Array(columnCount).fill(0);
  const cells = rows.map((contents) => Array.from({ length: columnCount }, (_, column) => {
    const cell = { type: "node", text: "", mode, chld: contents[column] ?? [], bbox: null };
    plan(cell, mode, true);
    widths[column] = Math.max(widths[column], cell.bbox.w);
    return cell;
  }));
  const columnGap = 1;
  const width = widths.reduce((sum, value) => sum + value, 0) + columnGap * (columnCount - 1);
  let y = 0;
  for (const cellsInRow of cells) {
    let top = 0;
    let bottom = 2;
    for (const cell of cellsInRow) {
      top = Math.min(top, cell.bbox.y);
      bottom = Math.max(bottom, cell.bbox.y + cell.bbox.h);
    }
    let x = 0;
    for (let column = 0; column < columnCount; column++) {
      const cell = cellsInRow[column];
      const alignment = gathered ? "c" : expr.columns?.[column] ?? "l";
      const remaining = widths[column] - cell.bbox.w;
      cell.bbox.x = x + (alignment === "r" ? remaining : alignment === "c" ? remaining / 2 : 0);
      cell.bbox.y += y - top;
      x += widths[column] + columnGap;
    }
    y += bottom - top + CONFIG.LINE_SPACING;
  }
  const height = y - CONFIG.LINE_SPACING;
  expr.bbox = { x: 0, y: (2 - height) / 2, w: width, h: height };
  expr.type = "node";
  expr.chld = cells.flat();
}
function plan(source, mode = "math", preserveBaseline = false) {
  const delimiters = MATRIX_DELIMITERS.get(source.text);
  if (delimiters && !source.chld.length) {
    source.chld.push({ type: "node", text: "", mode: "math", chld: [], bbox: null });
  }
  const expr = source;
  const tmd = {
    "\\text": "text",
    "\\operatorname": "rm",
    "\\operatorname*": "rm",
    "\\mathnormal": "math",
    "\\mathrm": "rm",
    "\\mathit": "it",
    "\\mathbf": "bf",
    "\\mathsf": "sf",
    "\\mathtt": "tt",
    "\\mathfrak": "frak",
    "\\mathcal": "cal",
    "\\mathbb": "bb",
    "\\mathscr": "scr",
    "\\rm": "rm",
    "\\it": "it",
    "\\bf": "bf",
    "\\sf": "tt",
    "\\tt": "tt",
    "\\frak": "frak",
    "\\cal": "cal",
    "\\bb": "bb",
    "\\scr": "scr"
  }[expr.text] ?? mode;
  if (isGrid(expr)) {
    planGrid(expr, tmd);
    return;
  }
  if (!expr.chld.length) {
    if (SYMB[expr.text]) {
      if (SYMB[expr.text].flags.txt) {
        let w = 0;
        const text = SYMB[expr.text].text ?? expr.text.slice(1);
        for (const char of text) {
          w += char === " " ? 8 : HERSHEY(asciiMap(char, "text")).w;
        }
        w /= 16;
        expr.bbox = { x: 0, y: 0, w: expr.text === "\\lim" ? 3.5 : w, h: 2 };
      } else if (SYMB[expr.text].flags.big) {
        expr.bbox = { x: 0, y: -0.5, w: 3, h: 3 };
      } else if (SYMB[expr.text].glyph) {
        let w = HERSHEY(SYMB[expr.text].glyph).w;
        w /= 16;
        if (SYMB[expr.text].flags.integral) {
          expr.bbox = { x: 0, y: -1.5, w, h: 5 };
        } else {
          expr.bbox = { x: 0, y: 0, w, h: 2 };
        }
      } else {
        expr.bbox = { x: 0, y: 0, w: 1, h: 2 };
      }
    } else {
      let w = 0;
      for (let i = 0; i < expr.text.length; i++) {
        const glyph = HERSHEY(asciiMap(expr.text[i], tmd));
        if (!glyph) {
          continue;
        }
        if (tmd === "tt") {
          w += 16;
        } else {
          w += glyph.w;
        }
      }
      w /= 16;
      expr.bbox = { x: 0, y: 0, w, h: 2 };
    }
    expr.mode = tmd;
    return;
  }
  if (SYMB[expr.text]?.flags.group) {
    planGroup(expr, tmd);
  } else if (SYMB[expr.text]?.flags.xarrow) {
    planArrow(expr, tmd);
  } else if (SYMB[expr.text]?.flags.frac) {
    const a = expr.chld[0];
    const b = expr.chld[1];
    const s = expr.text === "\\dfrac" ? 1 : expr.text === "\\tfrac" ? 0.65 : CONFIG.FRAC_SCALE;
    plan(a, tmd);
    plan(b, tmd);
    a.bbox.x = 0;
    a.bbox.y = 0;
    b.bbox.x = 0;
    b.bbox.y = 0;
    const mw = Math.max(a.bbox.w, b.bbox.w) * s;
    transform(a, s, null, (mw - a.bbox.w * s) / 2, 0);
    transform(b, s, null, (mw - b.bbox.w * s) / 2, a.bbox.h + CONFIG.FRAC_SPACING);
    expr.bbox = { x: 0, y: -a.bbox.h + 1 - CONFIG.FRAC_SPACING / 2, w: mw, h: a.bbox.h + b.bbox.h + CONFIG.FRAC_SPACING };
  } else if (SYMB[expr.text]?.flags.binom) {
    const a = expr.chld[0];
    const b = expr.chld[1];
    const s = expr.text === "\\tbinom" ? 0.7 : 1;
    plan(a, tmd);
    plan(b, tmd);
    a.bbox.x = 0;
    a.bbox.y = 0;
    b.bbox.x = 0;
    b.bbox.y = 0;
    const mw = Math.max(a.bbox.w, b.bbox.w) * s;
    transform(a, s, null, (mw - a.bbox.w * s) / 2 + s, 0);
    transform(b, s, null, (mw - b.bbox.w * s) / 2 + s, a.bbox.h);
    expr.bbox = { x: 0, y: -a.bbox.h + 1, w: mw + 2 * s, h: a.bbox.h + b.bbox.h };
  } else if (SYMB[expr.text]?.flags.above || SYMB[expr.text]?.flags.below) {
    const [label, base] = expr.chld;
    plan(label, tmd);
    plan(base, tmd);
    transform(label, CONFIG.SUB_SUP_SCALE, null, 0, 0);
    const above = SYMB[expr.text].flags.above;
    const gap = 0.2;
    const width = Math.max(label.bbox.w, base.bbox.w);
    const baseY = base.bbox.y;
    label.bbox.x = (width - label.bbox.w) / 2;
    base.bbox.x = (width - base.bbox.w) / 2;
    label.bbox.y = above ? 0 : base.bbox.h + gap;
    base.bbox.y = above ? label.bbox.h + gap : 0;
    expr.bbox = { x: 0, y: baseY - base.bbox.y, w: width, h: base.bbox.h + label.bbox.h + gap };
    expr.type = "node";
  } else if (SYMB[expr.text]?.size) {
    const child = expr.chld[0];
    const size = SYMB[expr.text].size;
    plan(child, tmd);
    transform(child, 1, size, 0, 0);
    child.bbox.y = 0;
    expr.bbox = { x: 0, y: 1 - child.bbox.h / 2, w: child.bbox.w, h: child.bbox.h };
    expr.type = "node";
  } else if (expr.text === "\\boxed") {
    const child = expr.chld[0];
    plan(child, tmd);
    const padding = 0.3;
    const childY = child.bbox.y;
    child.bbox.x = padding;
    child.bbox.y = padding;
    expr.bbox = { x: 0, y: childY - padding, w: child.bbox.w + 2 * padding, h: child.bbox.h + 2 * padding };
  } else if (expr.text === "\\sqrt") {
    const e = expr.chld[0];
    plan(e, tmd);
    const f = expr.chld[1];
    let pl = 0;
    if (f) {
      plan(f);
      pl = Math.max(f.bbox.w * CONFIG.SQRT_MAG_SCALE - 0.5, 0);
      transform(f, CONFIG.SQRT_MAG_SCALE, null, 0, 0.5);
    }
    if (SYMB[e.text]?.flags.group || SYMB[e.text]?.flags.xarrow || isGrid(e)) e.bbox.y = 0;
    transform(e, 1, null, 1 + pl, 0.5);
    expr.bbox = { x: 0, y: 2 - e.bbox.h - 0.5, w: e.bbox.w + 1 + pl, h: e.bbox.h + 0.5 };
  } else if (SYMB[expr.text] && SYMB[expr.text].flags.hat) {
    const e = expr.chld[0];
    const localAccent = ["\\dot", "\\ddot", "\\check", "\\mathring", "\\widetilde", "\\overleftrightarrow"].includes(expr.text);
    plan(e, localAccent ? tmd : "math");
    const y0 = e.bbox.y - 0.5;
    e.bbox.y = 0.5;
    expr.bbox = { x: 0, y: y0, w: e.bbox.w, h: e.bbox.h + 0.5 };
  } else if (SYMB[expr.text] && SYMB[expr.text].flags.mat) {
    const e = expr.chld[0];
    plan(e);
    expr.bbox = { x: 0, y: 0, w: e.bbox.w, h: e.bbox.h + 0.5 };
  } else {
    if (expr.text === "\\operatorname" || expr.text === "\\operatorname*") expr.type = "node";
    let dx = 0;
    let dy = 0;
    let mh = 1;
    for (let i = 0; i < expr.chld.length; i++) {
      const c = expr.chld[i];
      const spac = {
        "\\quad": 2,
        "\\qquad": 4,
        "\\enspace": 1,
        "\\enskip": 1,
        "\\,": 2 * 3 / 18,
        "\\thinspace": 2 * 3 / 18,
        "\\:": 2 * 4 / 18,
        "\\medspace": 2 * 4 / 18,
        "\\;": 2 * 5 / 18,
        "\\thickspace": 2 * 5 / 18,
        "\\!": 2 * -3 / 18,
        "\\negthinspace": 2 * -3 / 18
      }[c.text] ?? null;
      if (c.text === "\\\\") {
        dy += mh;
        dx = 0;
        mh = 1;
        continue;
      } else if (c.text === "&") {
        continue;
      } else if (spac !== null && spac !== void 0) {
        dx += spac;
        continue;
      } else {
        if (c.text === "\\dots") {
          const before = expr.chld[i - 1]?.text ?? "";
          const after = expr.chld[i + 1]?.text ?? "";
          const centered = /^(?:[+*=<>-]|\\(?:cdot|times|div|pm|mp|otimes|oplus|odot|ominus|oslash|cup|cap|uplus|land|lor|wedge|vee|leq?|geq?|neq?|approx|sim|simeq|equiv|cong|ll|gg|prec|succ|preceq|succeq|subset|supset|subseteq|supseteq))$/;
          c.text = before === "," || after === "," ? "\\ldots" : centered.test(before) || centered.test(after) ? "\\cdots" : "\\ldots";
        }
        plan(c, tmd);
        transform(c, 1, null, dx, dy);
        if (c.text === "^" || c.text === "_" || c.text === "'") {
          let j = i;
          while (j > 0 && (expr.chld[j].text === "^" || expr.chld[j].text === "_" || expr.chld[j].text === "'")) {
            j--;
          }
          const wasBig = SYMB[expr.chld[j].text] && SYMB[expr.chld[j].text].flags.big;
          if (c.text === "'") {
            let k = j + 1;
            let nth = 0;
            while (k < i) {
              if (expr.chld[k].text === "'") {
                nth++;
              }
              k++;
            }
            c.bbox.x = expr.chld[j].bbox.x + expr.chld[j].bbox.w + c.bbox.w * nth;
            dx = Math.max(dx, c.bbox.x + c.bbox.w);
          } else {
            if (wasBig) {
              const ex = expr.chld[j].bbox.x + (expr.chld[j].bbox.w - c.bbox.w * CONFIG.SUB_SUP_SCALE) / 2;
              c.bbox.x = ex;
              dx = Math.max(dx, expr.chld[j].bbox.x + expr.chld[j].bbox.w + (c.bbox.w * CONFIG.SUB_SUP_SCALE - expr.chld[j].bbox.w) / 2);
            } else {
              c.bbox.x = expr.chld[j].bbox.x + expr.chld[j].bbox.w;
              dx = Math.max(dx, c.bbox.x + c.bbox.w * CONFIG.SUB_SUP_SCALE);
            }
          }
        } else {
          dx += c.bbox.w;
        }
        if (mode === "text") {
          dx += 1;
        }
        mh = Math.max(c.bbox.y + c.bbox.h - dy, mh);
      }
    }
    dy += mh;
    const alt = {
      "bmatrix": "center",
      "pmatrix": "center",
      "Bmatrix": "center",
      "vmatrix": "center",
      "Vmatrix": "center",
      "cases": "left",
      "matrix": "center",
      "aligned": "equation"
    }[expr.text] ?? "left";
    const hasLp = !!delimiters?.length;
    const hasRp = !!delimiters && delimiters.length > 1;
    align(expr.chld, alt);
    const bb = computeBbox(expr.chld);
    if (expr.text === "\\text") {
      bb.x -= 1;
      bb.w += 2;
    }
    for (let i = 0; i < expr.chld.length; i++) {
      transform(expr.chld[i], 1, null, -bb.x + (hasLp ? 1.5 : 0), -bb.y);
    }
    expr.bbox = { x: 0, y: preserveBaseline ? bb.y : 0, w: bb.w + 1.5 * Number(hasLp) + 1.5 * Number(hasRp), h: bb.h };
    if (hasLp) {
      expr.chld.unshift({
        type: "symb",
        text: delimiters[0],
        mode: expr.mode,
        chld: [],
        bbox: { x: 0, y: 0, w: 1, h: bb.h }
      });
    }
    if (hasRp) {
      expr.chld.push({
        type: "symb",
        text: delimiters[1],
        mode: expr.mode,
        chld: [],
        bbox: { x: bb.w + 2, y: 0, w: 1, h: bb.h }
      });
    }
    if (hasLp || hasRp || expr.text === "matrix") {
      expr.type = "node";
      expr.text = "";
      expr.bbox.y -= (expr.bbox.h - 2) / 2;
    }
  }
}
function flatten(expr) {
  function flat(expr2, dx, dy) {
    const ff = [];
    if (expr2.bbox) {
      dx += expr2.bbox.x;
      dy += expr2.bbox.y;
      if (SYMB[expr2.text]?.flags.frac) {
        const h = expr2.chld[1].bbox.y - (expr2.chld[0].bbox.y + expr2.chld[0].bbox.h);
        const e = {
          type: "symb",
          mode: expr2.mode,
          text: "\\bar",
          bbox: {
            x: dx,
            y: dy + (expr2.chld[1].bbox.y - h / 2) - h / 2,
            w: expr2.bbox.w,
            h
          },
          chld: []
        };
        ff.push(e);
      } else if (expr2.text === "\\sqrt") {
        const h = expr2.chld[0].bbox.y;
        const xx = Math.max(0, expr2.chld[0].bbox.x - expr2.chld[0].bbox.h / 2);
        const e = {
          type: "symb",
          mode: expr2.mode,
          text: "\\sqrt",
          bbox: {
            x: dx + xx,
            y: dy + h / 2,
            w: expr2.chld[0].bbox.x - xx,
            h: expr2.bbox.h - h / 2
          },
          chld: []
        };
        ff.push(e);
        ff.push({
          type: "symb",
          text: "\\bar",
          mode: expr2.mode,
          bbox: {
            x: dx + expr2.chld[0].bbox.x,
            y: dy,
            w: expr2.bbox.w - expr2.chld[0].bbox.x,
            h
          },
          chld: []
        });
      } else if (SYMB[expr2.text]?.flags.binom) {
        const w = Math.min(expr2.chld[0].bbox.x, expr2.chld[1].bbox.x);
        const e = {
          type: "symb",
          mode: expr2.mode,
          text: "(",
          bbox: {
            x: dx,
            y: dy,
            w,
            h: expr2.bbox.h
          },
          chld: []
        };
        ff.push(e);
        ff.push({
          type: "symb",
          text: ")",
          mode: expr2.mode,
          bbox: {
            x: dx + expr2.bbox.w - w,
            y: dy,
            w,
            h: expr2.bbox.h
          },
          chld: []
        });
      } else if (SYMB[expr2.text] && SYMB[expr2.text].flags.hat) {
        const h = expr2.chld[0].bbox.y;
        const e = {
          type: "symb",
          mode: expr2.mode,
          text: expr2.text,
          bbox: {
            x: dx,
            y: dy,
            w: expr2.bbox.w,
            h
          },
          chld: []
        };
        ff.push(e);
      } else if (SYMB[expr2.text] && SYMB[expr2.text].flags.mat) {
        const h = expr2.chld[0].bbox.h;
        const e = {
          type: "symb",
          text: expr2.text,
          mode: expr2.mode,
          bbox: {
            x: dx,
            y: dy + h,
            w: expr2.bbox.w,
            h: expr2.bbox.h - h
          },
          chld: []
        };
        ff.push(e);
      } else if (expr2.type !== "node" && expr2.text !== "^" && expr2.text !== "_") {
        const e = {
          type: expr2.type === "func" ? "symb" : expr2.type,
          text: expr2.text,
          mode: expr2.mode,
          bbox: {
            x: dx,
            y: dy,
            w: expr2.bbox.w,
            h: expr2.bbox.h
          },
          chld: []
        };
        ff.push(e);
      }
    }
    for (let i = 0; i < expr2.chld.length; i++) {
      const f2 = flat(expr2.chld[i], dx, dy);
      ff.push(...f2);
    }
    return ff;
  }
  const f = flat(expr, -expr.bbox.x, -expr.bbox.y);
  expr.type = "node";
  expr.text = "";
  expr.chld = f;
}
function render(expr) {
  const o = [];
  for (let i = 0; i < expr.chld.length; i++) {
    const e = expr.chld[i];
    if (e.type === "stretch") {
      const flags = SYMB[e.text].flags;
      const kind = flags.xarrow ? "arrow" : flags.brace ? "brace" : "paren";
      const lines = stretch(kind, e.bbox.w, e.bbox.h, flags.xarrow ? flags.left : flags.under);
      for (const line of lines) o.push(line.map(([x, y]) => [x + e.bbox.x, y + e.bbox.y]));
      continue;
    }
    let s = e.bbox.h / 2;
    let isSmallHat = false;
    if (SYMB[e.text] && SYMB[e.text].flags.hat && !SYMB[e.text].flags.xfl && !SYMB[e.text].flags.yfl) {
      s *= 4;
      isSmallHat = true;
    }
    if (SYMB[e.text] && SYMB[e.text].glyph) {
      const d = HERSHEY(SYMB[e.text].glyph);
      for (let j = 0; j < d.polylines.length; j++) {
        const l = [];
        for (let k = 0; k < d.polylines[j].length; k++) {
          let x = d.polylines[j][k][0];
          let y = d.polylines[j][k][1];
          if (SYMB[e.text].flags.xfl) {
            x = (x - d.xmin) / Math.max(d.xmax - d.xmin, 1) * e.bbox.w;
            x += e.bbox.x;
          } else if (d.w / 16 * s > e.bbox.w) {
            x = x / Math.max(d.w, 1) * e.bbox.w;
            x += e.bbox.x;
          } else {
            x = x / 16 * s;
            const p = (e.bbox.w - d.w / 16 * s) / 2;
            x += e.bbox.x + p;
          }
          if (SYMB[e.text].flags.yfl) {
            y = (y - d.ymin) / Math.max(d.ymax - d.ymin, 1) * e.bbox.h;
            y += e.bbox.y;
          } else {
            y = y / 16 * s;
            if (isSmallHat) {
              const p = (d.ymax + d.ymin) / 2;
              y -= p / 16 * s;
            }
            y += e.bbox.y + e.bbox.h / 2;
          }
          l.push([x, y]);
        }
        o.push(l);
      }
    } else if (SYMB[e.text] && SYMB[e.text].flags.txt || e.type === "char") {
      let x0 = e.bbox.x;
      const isVerb = !!(SYMB[e.text] && SYMB[e.text].flags.txt);
      const text = isVerb ? SYMB[e.text].text ?? e.text.slice(1) : e.text;
      for (let n = 0; n < text.length; n++) {
        if (isVerb && text[n] === " ") {
          x0 += 0.5 * s;
          continue;
        }
        const d = HERSHEY(asciiMap(text[n], isVerb ? "text" : e.mode));
        if (!d) {
          console.warn("unmapped character: " + text[n]);
          continue;
        }
        for (let j = 0; j < d.polylines.length; j++) {
          const l = [];
          for (let k = 0; k < d.polylines[j].length; k++) {
            let x = d.polylines[j][k][0];
            let y = d.polylines[j][k][1];
            x /= 16;
            y /= 16;
            x *= s;
            y *= s;
            if (e.mode === "tt") {
              if (d.w > 16) {
                x *= 16 / d.w;
              } else {
                x += (16 - d.w) / 2 / 16;
              }
            }
            x += x0;
            y += e.bbox.y + e.bbox.h / 2;
            l.push([x, y]);
          }
          o.push(l);
        }
        if (e.mode === "tt") {
          x0 += s;
        } else {
          x0 += d.w / 16 * s;
        }
      }
    } else {
    }
  }
  return o;
}
function nf(x) {
  return Math.round(x * 100) / 100;
}
class hfmath {
  _latex;
  _tree;
  _tokens;
  _polylines;
  constructor(latex) {
    this._latex = latex;
    this._tokens = tokenize(latex);
    const tree = parse(this._tokens);
    environments(tree.chld);
    plan(tree);
    this._tree = tree;
    flatten(this._tree);
    this._polylines = render(this._tree);
  }
  resolveScale(opt) {
    if (opt === null || opt === void 0) {
      return [16, 16, 16, 16];
    }
    let sclx = opt.SCALE_X ?? 16;
    let scly = opt.SCALE_Y ?? 16;
    if (opt.MIN_CHAR_H !== null && opt.MIN_CHAR_H !== void 0) {
      let mh = Infinity;
      for (let i = 0; i < this._tree.chld.length; i++) {
        const c = this._tree.chld[i];
        if (c.type === "char" || SYMB[c.text] && (SYMB[c.text].flags.txt || !Object.keys(SYMB[c.text].flags).length)) {
          if (c.bbox.h > 0) mh = Math.min(c.bbox.h, mh);
        }
      }
      if (Number.isFinite(mh) && scly !== 0) {
        const s = Math.max(1, opt.MIN_CHAR_H / (mh * Math.abs(scly)));
        sclx *= s;
        scly *= s;
      }
    }
    if (opt.MAX_W !== null && opt.MAX_W !== void 0 && this._tree.bbox.w > 0 && sclx !== 0) {
      const s0 = sclx;
      sclx = Math.min(sclx, opt.MAX_W / this._tree.bbox.w);
      scly *= sclx / s0;
    }
    if (opt.MAX_H !== null && opt.MAX_H !== void 0 && this._tree.bbox.h > 0 && scly !== 0) {
      const s0 = scly;
      scly = Math.min(scly, opt.MAX_H / this._tree.bbox.h);
      sclx *= scly / s0;
    }
    const px = opt.MARGIN_X ?? sclx;
    const py = opt.MARGIN_Y ?? scly;
    return [px, py, sclx, scly];
  }
  polylines(opt) {
    if (!opt) opt = {};
    const polylines = [];
    const [px, py, sclx, scly] = this.resolveScale(opt);
    for (let i = 0; i < this._polylines.length; i++) {
      polylines.push([]);
      for (let j = 0; j < this._polylines[i].length; j++) {
        const [x, y] = this._polylines[i][j];
        polylines[polylines.length - 1].push([px + x * sclx, py + y * scly]);
      }
    }
    return polylines;
  }
  pathd(opt) {
    if (!opt) opt = {};
    let d = "";
    const [px, py, sclx, scly] = this.resolveScale(opt);
    for (let i = 0; i < this._polylines.length; i++) {
      for (let j = 0; j < this._polylines[i].length; j++) {
        const [x, y] = this._polylines[i][j];
        d += !j ? "M" : "L";
        d += `${nf(px + x * sclx)} ${nf(py + y * scly)}`;
      }
    }
    return d;
  }
  svg(opt) {
    if (!opt) opt = {};
    const [px, py, sclx, scly] = this.resolveScale(opt);
    const w = nf(this._tree.bbox.w * sclx + px * 2);
    const h = nf(this._tree.bbox.h * scly + py * 2);
    let o = `<svg 
      xmlns="http://www.w3.org/2000/svg" 
      width="${w}" height="${h}"
      fill="none" stroke="${opt.FG_COLOR ?? "black"}" stroke-width="${opt.STROKE_W ?? 1}" 
      stroke-linecap="round" stroke-linejoin="round"
    >`;
    if (opt.BG_COLOR) {
      o += `<rect x="${0}" y="${0}" width="${w}" height="${h}" fill="${opt.BG_COLOR}" stroke="none"></rect>`;
    }
    o += `<path d="`;
    for (let i = 0; i < this._polylines.length; i++) {
      o += "M";
      for (let j = 0; j < this._polylines[i].length; j++) {
        const [x, y] = this._polylines[i][j];
        o += nf(px + x * sclx) + " " + nf(py + y * scly) + " ";
      }
    }
    o += `"/>`;
    o += `</svg>`;
    return o;
  }
  pdf(opt) {
    if (!opt) opt = {};
    const [px, py, sclx, scly] = this.resolveScale(opt);
    const width = nf(this._tree.bbox.w * sclx + px * 2);
    const height = nf(this._tree.bbox.h * scly + py * 2);
    let head = `%PDF-1.1
%%\xA5\xB1\xEB
1 0 obj
<< /Type /Catalog
/Pages 2 0 R
>>endobj
    2 0 obj
<< /Type /Pages
/Kids [3 0 R]
/Count 1
/MediaBox [0 0 ${width} ${height}]
>>
endobj
    3 0 obj
<< /Type /Page
/Parent 2 0 R
/Resources
<< /Font
<< /F1
<< /Type /Font
    /Subtype /Type1
/BaseFont /Times-Roman
>>
>>
>>
/Contents [`;
    let pdf = "";
    let count = 4;
    for (let i = 0; i < this._polylines.length; i++) {
      pdf += `${count} 0 obj 
<< /Length 0 >>
 stream
 1 j 1 J ${opt.STROKE_W ?? 1} w
`;
      for (let j = 0; j < this._polylines[i].length; j++) {
        const [x, y] = this._polylines[i][j];
        pdf += `${nf(px + x * sclx)} ${nf(height - (py + y * scly))} ${j ? "l" : "m"} `;
      }
      pdf += "\nS\nendstream\nendobj\n";
      head += `${count} 0 R `;
      count++;
    }
    head += "]\n>>\nendobj\n";
    pdf += "\ntrailer\n<< /Root 1 0 R \n /Size 0\n >>startxref\n\n%%EOF\n";
    return head + pdf;
  }
  boxes(opt) {
    if (!opt) opt = {};
    const [px, py, sclx, scly] = this.resolveScale(opt);
    const bs = [];
    for (let i = 0; i < this._tree.chld.length; i++) {
      const { x, y, w, h } = this._tree.chld[i].bbox;
      bs.push({ x: px + x * sclx, y: py + y * scly, w: w * sclx, h: h * scly });
    }
    return bs;
  }
  box(opt) {
    if (!opt) opt = {};
    const [px, py, sclx, scly] = this.resolveScale(opt);
    return {
      x: px + this._tree.bbox.x * sclx,
      y: py + this._tree.bbox.y * scly,
      w: this._tree.bbox.w * sclx,
      h: this._tree.bbox.h * scly
    };
  }
}
const _impl = { tokenize, parse, environments, plan, flatten, render };
export {
  CONFIG,
  _impl,
  hfmath
};
