(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // ../../../packages/dsh-document-workbench/src/ops/index.mjs
  function normalizeDefinition(name, raw2) {
    if (!raw2 || typeof raw2 !== "object") throw new Error(`op "${name}" 定义不合法`);
    const fn = raw2.run || raw2.apply;
    if (typeof fn !== "function") throw new Error(`op "${name}" 需要 run 函数`);
    return {
      ...raw2,
      name,
      run: fn,
      mutates: raw2.mutates !== false,
      view: raw2.view === true,
      description: raw2.description || ""
    };
  }
  function mergeOpModules(modules = {}) {
    const out = {};
    for (const table of Object.values(modules)) {
      Object.assign(out, table);
    }
    return out;
  }
  function createOpRegistry({
    ops = {},
    modules = null,
    snapshot = null,
    assertReady = null,
    unknownMessage = null
  } = {}) {
    const source = modules ? mergeOpModules(modules) : ops;
    const definitions = {};
    for (const [name, raw2] of Object.entries(source)) {
      if (Object.hasOwn(definitions, name)) throw new Error(`重复的 op: ${name}`);
      definitions[name] = normalizeDefinition(name, raw2);
    }
    const names = Object.keys(definitions);
    const viewNames = names.filter((name) => definitions[name].view);
    async function apply(target, cmd, ctx = {}) {
      if (assertReady) assertReady(target);
      else if (target && typeof target.isMounted === "function" && !target.isMounted()) {
        throw new Error("编辑器未就绪");
      }
      const name = cmd && cmd.op;
      const def = definitions[name];
      if (!def) {
        const detail = unknownMessage ? unknownMessage(name) : "未知指令: " + String(name || JSON.stringify(cmd).slice(0, 40));
        throw new Error(detail);
      }
      if (def.mutates && snapshot) snapshot(target);
      return def.run(target, cmd || {}, ctx);
    }
    function isViewOp(cmdOrName) {
      const name = typeof cmdOrName === "string" ? cmdOrName : cmdOrName && cmdOrName.op;
      return !!(name && definitions[name] && definitions[name].view);
    }
    return {
      definitions,
      names,
      viewNames,
      has: (name) => Object.hasOwn(definitions, name),
      isViewOp,
      apply
    };
  }

  // src/core/ops/deck.js
  var deckOps = {
    load: {
      run(P, c) {
        return P.load(c.deck);
      }
    },
    title: {
      run(P, c) {
        P.setTitle(String(c.title || ""));
      }
    },
    theme: {
      run(P, c) {
        const th = P.getTheme() || {};
        Object.assign(th, c.theme || {});
        P.setTheme(th);
      }
    },
    /* 只压一条服务端历史快照，不改 deck。导入这类“绕过 op 内核”的
     * 编辑器级操作前调用，保证 ppt_history undo 能回到导入前。 */
    snapshot: {
      run() {
      }
    }
  };

  // src/core/color.js
  var COLORS = {
    蓝: "#5b9bd5",
    蓝色: "#5b9bd5",
    天蓝: "#87ceeb",
    淡蓝: "#add8e6",
    浅蓝: "#b3e5fc",
    深蓝: "#1e3a8a",
    白: "#ffffff",
    白色: "#ffffff",
    黑: "#000000",
    黑色: "#000000",
    灰: "#cccccc",
    灰色: "#cccccc",
    深灰: "#333333",
    浅灰: "#f2f2f2",
    黄: "#ffe066",
    淡黄: "#fffacd",
    浅黄: "#fffacd",
    米色: "#f5f5dc",
    红: "#d14424",
    红色: "#d14424",
    绿: "#2e7d32",
    绿色: "#2e7d32",
    紫: "#7e57c2",
    紫色: "#7e57c2",
    橙: "#f0a030",
    橙色: "#f0a030",
    粉: "#ffc0cb",
    粉色: "#ffc0cb",
    青: "#20b2aa",
    青色: "#20b2aa",
    棕: "#8d6e63",
    棕色: "#8d6e63"
  };
  function parseColor(v) {
    const s = String(v || "").trim();
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
    if (m) return [+m[1], +m[2], +m[3]];
    return null;
  }
  function luminance(rgb) {
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }
  function relativeLuminance(bg) {
    const rgb = parseColor(bg);
    return rgb ? luminance(rgb) / 255 : 1;
  }
  function contrastColor(bg) {
    return relativeLuminance(bg) > 0.62 ? "#1f2d3d" : "#ffffff";
  }

  // src/core/chart.js
  var CHART_TYPES = ["bar", "column", "line", "area", "pie", "ring", "radar", "scatter"];
  var SINGLE_SERIES_TYPES = ["pie", "ring"];
  var DEFAULT_CHART_COLORS = [
    "#5b9bd5",
    "#ed7d31",
    "#a5a5a5",
    "#ffc000",
    "#4472c4",
    "#70ad47",
    "#264478",
    "#9e480e",
    "#636363",
    "#997300"
  ];
  var isNum = (v) => typeof v === "number" && isFinite(v);
  var isNumArr = (a) => Array.isArray(a) && a.length > 0 && a.every(isNum);
  function fail(msg) {
    throw new Error("图表数据格式错误：" + msg);
  }
  function normalizeSeriesInput(series) {
    if (!Array.isArray(series) || series.length === 0) fail("series 不能为空");
    const legends = [];
    const out = [];
    for (const s of series) {
      if (isNumArr(s)) {
        out.push(s.slice());
        legends.push(`系列${out.length}`);
        continue;
      }
      if (s && isNumArr(s.values)) {
        out.push(s.values.slice());
        legends.push(String(s.name != null && s.name !== "" ? s.name : `系列${out.length + 1}`));
        continue;
      }
      fail("series 每项必须是数字数组或 {name, values}");
    }
    return { legends, series: out };
  }
  var autoLabels = (n) => Array.from({ length: n }, (_, i) => `类别${i + 1}`);
  function normalizeChartData(raw2, chartType = "bar") {
    if (!raw2 || typeof raw2 !== "object") fail("data 必须是对象");
    let labels = [];
    let legends = [];
    let series = [];
    if (Array.isArray(raw2.series)) {
      const norm = normalizeSeriesInput(raw2.series);
      legends = raw2.legends && Array.isArray(raw2.legends) && raw2.legends.length ? norm.series.map((_, i) => String(raw2.legends[i] != null ? raw2.legends[i] : norm.legends[i])) : norm.legends;
      series = norm.series;
      labels = Array.isArray(raw2.labels) && raw2.labels.length ? raw2.labels.map(String) : autoLabels(series[0].length);
    } else if (Array.isArray(raw2.values)) {
      if (!isNumArr(raw2.values)) fail("values 必须是非空数字数组");
      series = [raw2.values.slice()];
      legends = [String(raw2.name || "值")];
      labels = Array.isArray(raw2.labels) && raw2.labels.length ? raw2.labels.map(String) : autoLabels(series[0].length);
    } else if (Array.isArray(raw2.rows) || Array.isArray(raw2.headers)) {
      if (!Array.isArray(raw2.rows) || raw2.rows.length === 0) fail("rows 不能为空");
      const width = raw2.rows[0].length;
      if (width < 2) fail("rows 每行至少 2 列（首列类目 + 至少 1 列数值）");
      const heads = Array.isArray(raw2.headers) && raw2.headers.length ? raw2.headers.map(String) : null;
      labels = [];
      const cols = Array.from({ length: width - 1 }, () => []);
      for (const row of raw2.rows) {
        if (!Array.isArray(row) || row.length !== width) fail(`rows 每行长度必须一致（${width}）`);
        labels.push(String(row[0]));
        for (let c = 1; c < width; c++) {
          const v = Number(row[c]);
          if (!isFinite(v)) fail(`第 ${labels.length} 行第 ${c + 1} 列不是数字：${JSON.stringify(row[c])}`);
          cols[c - 1].push(v);
        }
      }
      legends = cols.map((_, i) => heads && heads[i + 1] || `系列${i + 1}`);
      series = cols;
    } else if (Array.isArray(raw2.items)) {
      labels = [];
      const values = [];
      for (const it of raw2.items) {
        const [name, value] = Array.isArray(it) ? it : [it && it.name, it && it.value];
        if (name == null || !isFinite(Number(value))) fail("items 每项必须是 [name, value] 或 {name, value}");
        labels.push(String(name));
        values.push(Number(value));
      }
      series = [values];
      legends = [String(raw2.name || "值")];
    } else {
      fail("无法识别的 data 格式（支持 labels+series / labels+values / headers+rows / items）");
    }
    if (labels.length === 0) fail("labels 不能为空");
    for (const s of series) {
      if (s.length !== labels.length) {
        fail(`系列长度(${s.length})与类目数(${labels.length})不一致`);
      }
    }
    if (SINGLE_SERIES_TYPES.includes(chartType) && series.length > 1) {
      fail(`${chartType} 图只支持 1 个系列（收到 ${series.length} 个），请改用 bar/line 等`);
    }
    return { labels, legends, series };
  }
  var CHART_OPTION_KEYS = ["lineSmooth", "stack", "horizontalBars"];
  function normalizeChartOptions(options) {
    if (options == null) return void 0;
    if (typeof options !== "object") fail("options 必须是对象");
    const out = {};
    for (const k of CHART_OPTION_KEYS) {
      if (options[k] != null) out[k] = Boolean(options[k]);
    }
    return Object.keys(out).length ? out : void 0;
  }
  function geometry(e) {
    const width = Number(e.width != null ? e.width : 560);
    const height = Number(e.height != null ? e.height : 360);
    return {
      width,
      height,
      left: Number(e.left != null ? e.left : Math.round((1e3 - width) / 2)),
      top: Number(e.top != null ? e.top : 110),
      rotate: Number(e.rotate || 0)
    };
  }
  function makeChartElement(e, deckThemeColors2) {
    if (!e || typeof e !== "object") fail("图表元素必须是对象");
    const chartType = String(e.chartType || (e.type && e.type !== "chart" ? e.type : "bar"));
    if (!CHART_TYPES.includes(chartType)) {
      fail(`不支持的 chartType: ${chartType}（支持 ${CHART_TYPES.join(" / ")}）`);
    }
    const data2 = normalizeChartData(e.data, chartType);
    const colors = Array.isArray(e.colors) && e.colors.length ? e.colors.map(String) : Array.isArray(e.themeColors) && e.themeColors.length ? e.themeColors.map(String) : Array.isArray(deckThemeColors2) && deckThemeColors2.length ? deckThemeColors2 : DEFAULT_CHART_COLORS;
    const g = geometry(e);
    const el = {
      type: "chart",
      id: e.id || `chart_${Date.now()}_${Math.floor(Math.random() * 1e3)}`,
      ...g,
      chartType,
      data: data2,
      themeColors: colors,
      textColor: String(e.textColor || "#333333")
    };
    const options = normalizeChartOptions(e.options);
    if (options) el.options = options;
    return el;
  }

  // src/core/table.js
  var DEFAULT_TABLE_COLOR = "#5b9bd5";
  var isNum2 = (v) => typeof v === "number" && isFinite(v);
  var cellId = (r, c) => `c${r + 1}_${c + 1}`;
  function tint(color, ratio = 0.85) {
    const rgb = parseColor(String(color || DEFAULT_TABLE_COLOR));
    if (!rgb) return "#f2f6fc";
    const mix = (ch) => Math.round(ch + (255 - ch) * ratio);
    const to2 = (n) => n.toString(16).padStart(2, "0");
    return `#${to2(mix(rgb[0]))}${to2(mix(rgb[1]))}${to2(mix(rgb[2]))}`;
  }
  var CELL_STYLE_KEYS = ["bold", "italic", "underline", "strikethrough", "color", "backcolor", "align", "fontsize", "fontname"];
  function normalizeCell(input, r, c) {
    const base = { id: input && input.id ? String(input.id) : cellId(r, c), colspan: 1, rowspan: 1, text: "" };
    if (input == null) return base;
    if (typeof input === "string" || isNum2(input)) {
      base.text = String(input);
      return base;
    }
    if (typeof input !== "object") throw new Error(`表格单元格格式错误（第 ${r + 1} 行第 ${c + 1} 列）`);
    base.text = String(input.text != null ? input.text : "");
    if (Number(input.colspan) > 1) base.colspan = Math.floor(Number(input.colspan));
    if (Number(input.rowspan) > 1) base.rowspan = Math.floor(Number(input.rowspan));
    const style = {};
    for (const k of CELL_STYLE_KEYS) {
      if (input[k] != null) style[k] = input[k];
    }
    if (Object.keys(style).length) base.style = style;
    return base;
  }
  function buildTableData(rows, opts = {}) {
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("表格数据 rows 不能为空");
    if (!Array.isArray(rows[0]) || rows[0].length === 0) throw new Error("表格 rows 必须是二维数组");
    const width = rows[0].length;
    const themeColor = opts.themeColor ? String(opts.themeColor) : DEFAULT_TABLE_COLOR;
    const header = Boolean(opts.header);
    return rows.map((row, r) => {
      if (!Array.isArray(row) || row.length !== width) {
        throw new Error(`表格第 ${r + 1} 行列数(${Array.isArray(row) ? row.length : 0})与首行(${width})不一致`);
      }
      return row.map((input, c) => {
        const cell = normalizeCell(input, r, c);
        if (opts.header && r === 0) {
          cell.style = {
            bold: true,
            backcolor: tint(themeColor, 0.88),
            ...cell.style && typeof cell.style === "object" ? cell.style : {}
          };
        }
        return cell;
      });
    });
  }
  function normalizeColWidths(colWidths, cols) {
    if (!Array.isArray(colWidths) || colWidths.length === 0) {
      return Array.from({ length: cols }, () => 1 / cols);
    }
    if (colWidths.length !== cols) {
      throw new Error(`colWidths 长度(${colWidths.length})与列数(${cols})不一致`);
    }
    const nums = colWidths.map(Number);
    if (nums.some((n) => !isFinite(n) || n <= 0)) throw new Error("colWidths 必须是正数");
    const sum = nums.reduce((a, b) => a + b, 0);
    if (sum <= 1.5) {
      return nums.map((n) => n / sum);
    }
    return nums.map((n) => n / sum);
  }
  function makeTableElement(e) {
    if (!e || typeof e !== "object") throw new Error("表格元素必须是对象");
    const rows = e.rows;
    const header = Boolean(e.header);
    const data2 = buildTableData(rows, { header, themeColor: e.themeColor });
    const cols = data2[0].length;
    const nRows = data2.length;
    const themeColor = e.themeColor ? String(e.themeColor) : DEFAULT_TABLE_COLOR;
    const cellMinHeight = Number(e.cellMinHeight != null ? e.cellMinHeight : 36);
    const width = Number(e.width != null ? e.width : 640);
    const height = Number(e.height != null ? e.height : nRows * cellMinHeight);
    const el = {
      type: "table",
      id: e.id || `table_${Date.now()}_${Math.floor(Math.random() * 1e3)}`,
      left: Number(e.left != null ? e.left : Math.round((1e3 - width) / 2)),
      top: Number(e.top != null ? e.top : 110),
      width,
      height,
      rotate: Number(e.rotate || 0),
      outline: e.outline && typeof e.outline === "object" ? {
        style: String(e.outline.style || "solid"),
        width: Number(e.outline.width != null ? e.outline.width : 1),
        color: String(e.outline.color || "#d9d9d9")
      } : { style: "solid", width: 1, color: "#d9d9d9" },
      theme: {
        color: themeColor,
        rowHeader: header,
        rowFooter: false,
        colHeader: Boolean(e.colHeader),
        colFooter: false
      },
      colWidths: normalizeColWidths(e.colWidths, cols),
      cellMinHeight,
      data: data2
    };
    if (Array.isArray(e.rowHeights) && e.rowHeights.length === nRows) {
      el.rowHeights = e.rowHeights.map(Number);
    }
    return el;
  }
  function normalizeCellPatches(cells) {
    if (!Array.isArray(cells) || cells.length === 0) throw new Error("cells 不能为空");
    return cells.map((c, i) => {
      if (!c || typeof c !== "object" || !isNum2(Number(c.row)) || !isNum2(Number(c.col))) {
        throw new Error(`cells[${i}] 需要 row / col`);
      }
      const patch = { row: Math.floor(Number(c.row)), col: Math.floor(Number(c.col)) };
      if (c.text != null) patch.text = String(c.text);
      const style = {};
      for (const k of CELL_STYLE_KEYS) {
        if (c[k] != null) style[k] = c[k];
      }
      if (Object.keys(style).length) patch.style = style;
      return patch;
    });
  }

  // src/core/hfmath/hershey.js
  var ordR = "R".charCodeAt(0);
  function HERSHEY(i) {
    if (i === void 0) return;
    if (data[i] === null || data[i] === void 0) {
      const extended = extensions[i]?.();
      if (extended) {
        const points = extended.polylines.flat();
        data[i] = {
          ...extended,
          xmin: Math.min(...points.map(([x]) => x)),
          xmax: Math.max(...points.map(([x]) => x)),
          ymin: Math.min(...points.map(([, y]) => y)),
          ymax: Math.max(...points.map(([, y]) => y))
        };
      } else {
        compile(i);
      }
    }
    return data[i];
  }
  function strokes(id, dx = 0, dy = 0, sx = 1, sy = 1) {
    return HERSHEY(id).polylines.map((line) => line.map(([x, y]) => [x * sx + dx, y * sy + dy]));
  }
  function negated(id) {
    const glyph = HERSHEY(id);
    return { w: glyph.w, polylines: [...strokes(id), [[glyph.w * 0.25, 12], [glyph.w * 0.75, -14]]] };
  }
  function multipleIntegral(count) {
    return { w: 30 + (count - 1) * 16, polylines: Array.from({ length: count }, (_, i) => strokes(2412, i * 16)).flat() };
  }
  function ellipsis(offsets, width) {
    return { w: width, polylines: offsets.flatMap(([x, y]) => strokes(2236, x, y)) };
  }
  function circled(lines) {
    return { w: 20, polylines: [strokes(1284)[0], ...lines] };
  }
  var doubleArrow = [
    [[4, -2], [20, -2]],
    [[4, 2], [20, 2]],
    [[14, -8], [22, 0], [14, 8]]
  ];
  var extensions = {
    5e3: () => ({ w: 20, polylines: strokes(2027, 0, -3, 1, -1) }),
    // forall
    5001: () => negated(2279),
    // nexists
    5002: () => negated(2260),
    // notin
    5003: () => ({ w: 24, polylines: strokes(2260, 24, 0, -1) }),
    // ni
    5004: () => negated(2015),
    // emptyset
    5005: () => ({ w: 24, polylines: [...strokes(2256), [[4, 12], [20, 12]]] }),
    // subseteq
    5006: () => ({ w: 24, polylines: [...strokes(2258), [[4, 12], [20, 12]]] }),
    // supseteq
    5007: () => negated(5005),
    // nsubseteq
    5008: () => negated(5006),
    // nsupseteq
    5009: () => ({ w: 24, polylines: [[[4, 8], [12, -9], [20, 8]]] }),
    // land
    5010: () => ({ w: 24, polylines: [[[4, -9], [12, 8], [20, -9]]] }),
    // lor
    5011: () => ({ w: 24, polylines: [...strokes(2246, 0, -4), ...strokes(2246, 0, 4)] }),
    // approx
    5012: () => ({ w: 24, polylines: [...strokes(2246, 0, -4), [[3, 6], [21, 6]]] }),
    // simeq
    5013: () => ({ w: 24, polylines: [[[3, -3], [21, -3], [21, 6]]] }),
    // neg
    5014: () => ({ w: 18, polylines: [[[5, -10], [13, 10]]] }),
    // setminus
    5015: () => ({ w: 26, polylines: [...strokes(2261), ...strokes(2263)] }),
    // leftrightarrow
    5016: () => ({ w: 26, polylines: doubleArrow }),
    // Rightarrow
    5017: () => ({ w: 26, polylines: doubleArrow.map((line) => line.map(([x, y]) => [26 - x, y])) }),
    // Leftarrow
    5018: () => ({ w: 26, polylines: [...doubleArrow, [[12, -8], [4, 0], [12, 8]]] }),
    // Leftrightarrow
    5019: () => ({ w: 26, polylines: [...strokes(2261), [[4, -8], [4, 8]]] }),
    // mapsto
    5020: () => multipleIntegral(2),
    5021: () => multipleIntegral(3),
    5022: () => multipleIntegral(4),
    5030: () => ellipsis([[0, 8], [10, 8], [20, 8]], 30),
    // ldots
    5031: () => ellipsis([[0, 0], [10, 0], [20, 0]], 30),
    // cdots
    5032: () => ellipsis([[0, -8], [0, 0], [0, 8]], 10),
    // vdots
    5033: () => ellipsis([[0, -8], [10, 0], [20, 8]], 30),
    // ddots
    5034: () => ellipsis([[-1, 0], [7, 0]], 16),
    // ddot
    5035: () => circled([[[5, -5], [15, 5]], [[5, 5], [15, -5]]]),
    // otimes
    5036: () => circled([[[3, 0], [17, 0]]]),
    // ominus
    5037: () => circled([[[5, 5], [15, -5]]]),
    // oslash
    5038: () => ({ w: 24, polylines: [...strokes(2257), [[12, -6], [12, 2]], [[8, -2], [16, -2]]] }),
    // uplus
    5039: () => ({ w: 18, polylines: [[[8, -10], [4, 10]], [[14, -10], [10, 10]]] }),
    // parallel
    5040: () => ({ w: 18, polylines: [...strokes(5039), [[1, 9], [17, -9]]] }),
    // nparallel
    5041: () => ({ w: 16, polylines: [...strokes(2229, 4), [[2, 9], [14, -9]]] }),
    // nmid
    5042: () => ({ w: 32, polylines: [...strokes(2241, 0, 0, 0.75), ...strokes(2241, 12, 0, 0.75)] }),
    // ll
    5043: () => ({ w: 32, polylines: [...strokes(2242, 0, 0, 0.75), ...strokes(2242, 12, 0, 0.75)] }),
    // gg
    5044: () => ({ w: 24, polylines: [...strokes(2246, 0, -6), [[3, 3], [21, 3]], [[3, 9], [21, 9]]] }),
    // cong
    5045: () => ({ w: 24, polylines: [strokes(2257, 0, -5, 1, 0.3)[0].slice(1, -1), strokes(2259, 0, 5, 1, 0.3)[0].slice(1, -1)] }),
    // asymp
    5046: () => ({ w: 24, polylines: [[[20, -9], [16, -8], [11, -6], [7, -3], [4, 0], [7, 3], [11, 6], [16, 8], [20, 9]]] }),
    // prec
    5047: () => ({ w: 24, polylines: strokes(5046, 24, 0, -1) }),
    // succ
    5048: () => ({ w: 24, polylines: [...strokes(5046, 0, -2, 1, 0.8), [[4, 10], [20, 10]]] }),
    // preceq
    5049: () => ({ w: 24, polylines: strokes(5048, 24, 0, -1) }),
    // succeq
    5050: () => ({ w: 16, polylines: [[[0, -16], [16, -16], [16, 16], [0, 16], [0, -16]]] }),
    // boxed
    5051: () => ({ w: 14, polylines: [[[4, -16], [4, 16], [12, 16]]] }),
    // lfloor
    5052: () => ({ w: 14, polylines: [[[10, -16], [10, 16], [2, 16]]] }),
    // rfloor
    5053: () => ({ w: 14, polylines: [[[4, 16], [4, -16], [12, -16]]] }),
    // lceil
    5054: () => ({ w: 14, polylines: [[[10, 16], [10, -16], [2, -16]]] }),
    // rceil
    5055: () => ({ w: 22, polylines: strokes(2220, 22, 0, -1) }),
    // backslash
    5056: () => ({ w: 24, polylines: [[[4, -10], [4, 10]], [[4, 0], [21, 0]]] }),
    // vdash
    5057: () => ({ w: 24, polylines: strokes(5056, 24, 0, -1) }),
    // dashv
    5058: () => ({ w: 24, polylines: [[[4, -10], [4, 10]], [[4, -3], [21, -3]], [[4, 3], [21, 3]]] }),
    // models
    5059: () => ({ w: 22, polylines: strokes(2247, 0, 0, 1, -1) }),
    // check
    5060: () => ({ w: 12, polylines: strokes(902, 3.5, 0, 0.5, 0.5) })
    // mathring
  };
  function compile(i) {
    const entry = raw[i];
    if (entry === null || entry === void 0) {
      return;
    }
    const bound = entry.substring(3, 5);
    const xmin = 1 * bound.charCodeAt(0) - ordR;
    const xmax = 1 * bound.charCodeAt(1) - ordR;
    const content = entry.substring(5);
    const polylines = [[]];
    let ymin = Infinity;
    let ymax = -Infinity;
    let zmin = Infinity;
    let zmax = -Infinity;
    let j = 0;
    while (j < content.length) {
      const digit = content.substring(j, j + 2);
      if (digit === " R") {
        polylines.push([]);
      } else {
        const x = digit.charCodeAt(0) - ordR - xmin;
        const y = digit.charCodeAt(1) - ordR;
        ymin = Math.min(y, ymin);
        ymax = Math.max(y, ymax);
        zmin = Math.min(x, zmin);
        zmax = Math.max(x, zmax);
        polylines[polylines.length - 1].push([x, y]);
      }
      j += 2;
    }
    data[i] = {
      w: xmax - xmin,
      xmin: zmin,
      xmax: zmax,
      ymin,
      ymax,
      polylines
    };
  }
  var data = {};
  var raw = {
    1: "  9MWRMNV RRMVV RPSTS",
    2: " 16MWOMOV ROMSMUNUPSQ ROQSQURUUSVOV",
    3: " 11MXVNTMRMPNOPOSPURVTVVU",
    4: " 12MWOMOV ROMRMTNUPUSTURVOV",
    5: " 12MWOMOV ROMUM ROQSQ ROVUV",
    6: "  9MVOMOV ROMUM ROQSQ",
    7: " 15MXVNTMRMPNOPOSPURVTVVUVR RSRVR",
    8: "  9MWOMOV RUMUV ROQUQ",
    9: "  3PTRMRV",
    10: "  7NUSMSTRVPVOTOS",
    11: "  9MWOMOV RUMOS RQQUV",
    12: "  6MVOMOV ROVUV",
    13: " 12LXNMNV RNMRV RVMRV RVMVV",
    14: "  9MWOMOV ROMUV RUMUV",
    15: " 14MXRMPNOPOSPURVSVUUVSVPUNSMRM",
    16: " 10MWOMOV ROMSMUNUQSROR",
    17: " 17MXRMPNOPOSPURVSVUUVSVPUNSMRM RSTVW",
    18: " 13MWOMOV ROMSMUNUQSROR RRRUV",
    19: " 13MWUNSMQMONOOPPTRUSUUSVQVOU",
    20: "  6MWRMRV RNMVM",
    21: "  9MXOMOSPURVSVUUVSVM",
    22: "  6MWNMRV RVMRV",
    23: " 12LXNMPV RRMPV RRMTV RVMTV",
    24: "  6MWOMUV RUMOV",
    25: "  7MWNMRQRV RVMRQ",
    26: "  9MWUMOV ROMUM ROVUV",
    27: "  9MWRMNV RRMVV RPSTS",
    28: " 16MWOMOV ROMSMUNUPSQ ROQSQURUUSVOV",
    29: "  6MVOMOV ROMUM",
    30: "  9MWRMNV RRMVV RNVVV",
    31: " 12MWOMOV ROMUM ROQSQ ROVUV",
    32: "  9MWUMOV ROMUM ROVUV",
    33: "  9MWOMOV RUMUV ROQUQ",
    34: " 20MXRMPNOPOSPURVSVUUVSVPUNSMRM RQQTR RTQQR",
    35: "  3PTRMRV",
    36: "  9MWOMOV RUMOS RQQUV",
    37: "  6MWRMNV RRMVV",
    38: " 12LXNMNV RNMRV RVMRV RVMVV",
    39: "  9MWOMOV ROMUV RUMUV",
    40: " 12MWOMUM RPQTR RTQPR ROVUV",
    41: " 14MXRMPNOPOSPURVSVUUVSVPUNSMRM",
    42: "  9MWOMOV RUMUV ROMUM",
    43: " 10MWOMOV ROMSMUNUQSROR",
    44: " 10MWOMRQOV ROMUM ROVUV",
    45: "  6MWRMRV RNMVM",
    46: " 15MWNONNOMPMQNRPRV RVOVNUMTMSNRP",
    47: " 13LXRMRV RPONPNSPTTTVSVPTOPO",
    48: "  6MWOMUV RUMOV",
    49: " 12LXRMRV RNOOPOSQTSTUSUPVO",
    50: " 13MXOVQVOROPPNRMSMUNVPVRTVVV",
    200: " 12MWRMPNOPOSPURVTUUSUPTNRM",
    201: "  4MWPORMRV",
    202: "  9MWONQMSMUNUPTROVUV",
    203: " 15MWONQMSMUNUPSQ RRQSQURUUSVQVOU",
    204: "  7MWSMSV RSMNSVS",
    205: " 14MWPMOQQPRPTQUSTURVQVOU RPMTM",
    206: " 14MWTMRMPNOPOSPURVTUUSTQRPPQOS",
    207: "  6MWUMQV ROMUM",
    208: " 19MWQMONOPQQSQUPUNSMQM RQQOROUQVSVUUURSQ",
    209: " 14MWUPTRRSPROPPNRMTNUPUSTURVPV",
    210: "  6PURURVSVSURU",
    211: "  7PUSVRVRUSUSWRY",
    212: " 12PURPRQSQSPRP RRURVSVSURU",
    213: " 13PURPRQSQSPRP RSVRVRUSUSWRY",
    214: " 12PURMRR RSMSR RRURVSVSURU",
    215: " 17NWPNRMSMUNUPRQRRSRSQUP RRURVSVSURU",
    216: "  3PTRMRQ",
    217: "  6NVPMPQ RTMTQ",
    218: " 10NVQMPNPPQQSQTPTNSMQM",
    219: " 16MWUNSMQMONOPQQTRUSUUSVQVOU RRLRW",
    220: "  3MWVLNW",
    221: "  7OVTLRNQPQSRUTW",
    222: "  7NUPLRNSPSSRUPW",
    223: "  3PTRLRW",
    224: "  3LXNRVR",
    225: "  6LXRNRV RNRVR",
    226: "  6LXNPVP RNTVT",
    227: "  6MWOOUU RUOOU",
    228: "  9MWRORU ROPUT RUPOT",
    229: "  6PURQRRSRSQRQ",
    230: "  7PUSMRORQSQSPRP",
    231: "  7PUSNRNRMSMSORQ",
    232: "  7LXSOVRSU RNRVR",
    233: " 12MXRLPW RULSW ROPVP ROSVS",
    234: " 21LXVRURTSSURVOVNUNSORRQSPSNRMPMONOPQSSUUVVV",
    235: " 20LXNNOQOSNV RVNUQUSVV RNNQOSOVN RNVQUSUVV",
    501: "  9I[RFJ[ RRFZ[ RMTWT",
    502: " 24G\\KFK[ RKFTFWGXHYJYLXNWOTP RKPTPWQXRYTYWXYWZT[K[",
    503: " 19H]ZKYIWGUFQFOGMILKKNKSLVMXOZQ[U[WZYXZV",
    504: " 16G\\KFK[ RKFRFUGWIXKYNYSXVWXUZR[K[",
    505: " 12H[LFL[ RLFYF RLPTP RL[Y[",
    506: "  9HZLFL[ RLFYF RLPTP",
    507: " 23H]ZKYIWGUFQFOGMILKKNKSLVMXOZQ[U[WZYXZVZS RUSZS",
    508: "  9G]KFK[ RYFY[ RKPYP",
    509: "  3NVRFR[",
    510: " 11JZVFVVUYTZR[P[NZMYLVLT",
    511: "  9G\\KFK[ RYFKT RPOY[",
    512: "  6HYLFL[ RL[X[",
    513: " 12F^JFJ[ RJFR[ RZFR[ RZFZ[",
    514: "  9G]KFK[ RKFY[ RYFY[",
    515: " 22G]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF",
    516: " 14G\\KFK[ RKFTFWGXHYJYMXOWPTQKQ",
    517: " 25G]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF RSWY]",
    518: " 17G\\KFK[ RKFTFWGXHYJYLXNWOTPKP RRPY[",
    519: " 21H\\YIWGTFPFMGKIKKLMMNOOUQWRXSYUYXWZT[P[MZKX",
    520: "  6JZRFR[ RKFYF",
    521: " 11G]KFKULXNZQ[S[VZXXYUYF",
    522: "  6I[JFR[ RZFR[",
    523: " 12F^HFM[ RRFM[ RRFW[ R\\FW[",
    524: "  6H\\KFY[ RYFK[",
    525: "  7I[JFRPR[ RZFRP",
    526: "  9H\\YFK[ RKFYF RK[Y[",
    527: "  9I[RFJ[ RRFZ[ RMTWT",
    528: " 24G\\KFK[ RKFTFWGXHYJYLXNWOTP RKPTPWQXRYTYWXYWZT[K[",
    529: "  6HYLFL[ RLFXF",
    530: "  9I[RFJ[ RRFZ[ RJ[Z[",
    531: " 12H[LFL[ RLFYF RLPTP RL[Y[",
    532: "  9H\\YFK[ RKFYF RK[Y[",
    533: "  9G]KFK[ RYFY[ RKPYP",
    534: " 25G]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF ROPUP",
    535: "  3NVRFR[",
    536: "  9G\\KFK[ RYFKT RPOY[",
    537: "  6I[RFJ[ RRFZ[",
    538: " 12F^JFJ[ RJFR[ RZFR[ RZFZ[",
    539: "  9G]KFK[ RKFY[ RYFY[",
    540: "  9I[KFYF ROPUP RK[Y[",
    541: " 22G]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF",
    542: "  9G]KFK[ RYFY[ RKFYF",
    543: " 14G\\KFK[ RKFTFWGXHYJYMXOWPTQKQ",
    544: " 10I[KFRPK[ RKFYF RK[Y[",
    545: "  6JZRFR[ RKFYF",
    546: " 19I[KKKILGMFOFPGQIRMR[ RYKYIXGWFUFTGSIRM",
    547: " 21H\\RFR[ RPKMLLMKOKRLTMUPVTVWUXTYRYOXMWLTKPK",
    548: "  6H\\KFY[ RK[YF",
    549: " 18G]RFR[ RILJLKMLQMSNTQUSUVTWSXQYMZL[L",
    550: " 17H\\K[O[LTKPKLLINGQFSFVGXIYLYPXTU[Y[",
    551: " 20G[G[IZLWOSSLVFV[UXSUQSNQLQKRKTLVNXQZT[Y[",
    552: " 41F]SHTITLSPRSQUOXMZK[J[IZIWJRKOLMNJPHRGUFXFZG[I[KZMYNWOTP RSPTPWQXRYTYWXYWZU[R[PZOX",
    553: " 24H\\TLTMUNWNYMZKZIYGWFTFQGOIMLLNKRKVLYMZO[Q[TZVXWV",
    554: " 35G^TFRGQIPMOSNVMXKZI[G[FZFXGWIWKXMZP[S[VZXXZT[O[KZHYGWFTFRHRJSMUPWRZT\\U",
    555: " 28H\\VJVKWLYLZKZIYGVFRFOGNINLONPOSPPPMQLRKTKWLYMZP[S[VZXXYV",
    556: " 28H\\RLPLNKMINGQFTFXG[G]F RXGVNTTRXPZN[L[JZIXIVJULUNV RQPZP",
    557: " 29G^G[IZMVPQQNRJRGQFPFOGNINLONQOUOXNYMZKZQYVXXVZS[O[LZJXIVIT",
    558: " 38F^MMKLJJJIKGMFNFPGQIQKPONULYJ[H[GZGX RMRVOXN[L]J^H^G]F\\FZHXLVRUWUZV[W[YZZY\\V",
    559: " 25IZWVUTSQROQLQIRGSFUFVGWIWLVQTVSXQZO[M[KZJXJVKUMUOV",
    560: " 25JYT^R[PVOPOJPGRFTFUGVJVMURR[PaOdNfLgKfKdLaN^P\\SZWX",
    561: " 39F^MMKLJJJIKGMFNFPGQIQKPONULYJ[H[GZGX R^I^G]F\\FZGXIVLTNROPO RROSQSXTZU[V[XZYY[V",
    562: " 29I\\MRORSQVOXMYKYHXFVFUGTISNRSQVPXNZL[J[IZIXJWLWNXQZT[V[YZ[X",
    563: " 45@aEMCLBJBICGEFFFHGIIIKHPGTE[ RGTJLLHMGOFPFRGSISKRPQTO[ RQTTLVHWGYFZF\\G]I]K\\PZWZZ[[\\[^Z_YaV",
    564: " 32E]JMHLGJGIHGJFKFMGNINKMPLTJ[ RLTOLQHRGTFVFXGYIYKXPVWVZW[X[ZZ[Y]V",
    565: " 29H]TFQGOIMLLNKRKVLYMZO[Q[TZVXXUYSZOZKYHXGVFTFRHRKSNUQWSZU\\V",
    566: " 31F_SHTITLSPRSQUOXMZK[J[IZIWJRKOLMNJPHRGUFZF\\G]H^J^M]O\\PZQWQUPTO",
    567: " 32H^ULTNSOQPOPNNNLOIQGTFWFYGZIZMYPWSSWPYNZK[I[HZHXIWKWMXPZS[V[YZ[X",
    568: " 38F_SHTITLSPRSQUOXMZK[J[IZIWJRKOLMNJPHRGUFYF[G\\H]J]M\\O[PYQVQSPTQUSUXVZX[ZZ[Y]V",
    569: " 28H\\H[JZLXOTQQSMTJTGSFRFQGPIPKQMSOVQXSYUYWXYWZT[P[MZKXJVJT",
    570: " 25H[RLPLNKMINGQFTFXG[G]F RXGVNTTRXPZN[L[JZIXIVJULUNV",
    571: " 33E]JMHLGJGIHGJFKFMGNINKMOLRKVKXLZN[P[RZSYUUXMZF RXMWQVWVZW[X[ZZ[Y]V",
    572: " 32F]KMILHJHIIGKFLFNGOIOKNOMRLVLYM[O[QZTWVTXPYMZIZGYFXFWGVIVKWNYP[Q",
    573: " 25C_HMFLEJEIFGHFIFKGLILLK[ RUFK[ RUFS[ RaF_G\\JYNVTS[",
    574: " 36F^NLLLKKKILGNFPFRGSISLQUQXRZT[V[XZYXYVXUVU R]I]G\\FZFXGVITLPUNXLZJ[H[GZGX",
    575: " 38F]KMILHJHIIGKFLFNGOIOKNOMRLVLXMZN[P[RZTXVUWSYM R[FYMVWT]RbPfNgMfMdNaP^S[VY[V",
    576: " 40H]ULTNSOQPOPNNNLOIQGTFWFYGZIZMYPWTTWPZN[K[JZJXKWNWPXQYR[R^QaPcNfLgKfKdLaN^Q[TYZV",
    583: "  9I[JFR[ RZFR[ RJFZF",
    601: " 18I\\XMX[ RXPVNTMQMONMPLSLUMXOZQ[T[VZXX",
    602: " 18H[LFL[ RLPNNPMSMUNWPXSXUWXUZS[P[NZLX",
    603: " 15I[XPVNTMQMONMPLSLUMXOZQ[T[VZXX",
    604: " 18I\\XFX[ RXPVNTMQMONMPLSLUMXOZQ[T[VZXX",
    605: " 18I[LSXSXQWOVNTMQMONMPLSLUMXOZQ[T[VZXX",
    606: "  9MYWFUFSGRJR[ ROMVM",
    607: " 23I\\XMX]W`VaTbQbOa RXPVNTMQMONMPLSLUMXOZQ[T[VZXX",
    608: " 11I\\MFM[ RMQPNRMUMWNXQX[",
    609: "  9NVQFRGSFREQF RRMR[",
    610: " 12MWRFSGTFSERF RSMS^RaPbNb",
    611: "  9IZMFM[ RWMMW RQSX[",
    612: "  3NVRFR[",
    613: " 19CaGMG[ RGQJNLMOMQNRQR[ RRQUNWMZM\\N]Q][",
    614: " 11I\\MMM[ RMQPNRMUMWNXQX[",
    615: " 18I\\QMONMPLSLUMXOZQ[T[VZXXYUYSXPVNTMQM",
    616: " 18H[LMLb RLPNNPMSMUNWPXSXUWXUZS[P[NZLX",
    617: " 18I\\XMXb RXPVNTMQMONMPLSLUMXOZQ[T[VZXX",
    618: "  9KXOMO[ ROSPPRNTMWM",
    619: " 18J[XPWNTMQMNNMPNRPSUTWUXWXXWZT[Q[NZMX",
    620: "  9MYRFRWSZU[W[ ROMVM",
    621: " 11I\\MMMWNZP[S[UZXW RXMX[",
    622: "  6JZLMR[ RXMR[",
    623: " 12G]JMN[ RRMN[ RRMV[ RZMV[",
    624: "  6J[MMX[ RXMM[",
    625: " 10JZLMR[ RXMR[P_NaLbKb",
    626: "  9J[XMM[ RMMXM RM[X[",
    627: " 24H]QMONMPLRKUKXLZN[P[RZUWWTYPZM RQMSMTNUPWXXZY[Z[",
    628: " 31I\\UFSGQIOMNPMTLZKb RUFWFYHYKXMWNUORO RROTPVRWTWWVYUZS[Q[OZNYMV",
    629: " 17I\\JPLNNMOMQNROSRSVR[ RZMYPXRR[P_Ob",
    630: " 24I[TMQMONMPLSLVMYNZP[R[TZVXWUWRVOTMRKQIQGRFTFVGXI",
    631: " 19JZWOVNTMQMONOPPRSS RSSOTMVMXNZP[S[UZWX",
    632: " 23JYTFRGQHQIRJUKXK RXKTMQONRMUMWNYP[S]T_TaSbQbP`",
    633: " 19H\\IQJOLMNMONOPNTL[ RNTPPRNTMVMXOXRWWTb",
    634: " 27G\\HQIOKMMMNNNPMUMXNZO[Q[SZUWVUWRXMXJWGUFSFRHRJSMUPWRZT",
    635: "  9LWRMPTOXOZP[R[TYUW",
    636: " 19I[OMK[ RYNXMWMUNQROSNS RNSPTQUSZT[U[VZ",
    637: "  9JZKFMFOGPHX[ RRML[",
    638: " 21H]OMIb RNQMVMYO[Q[SZUXWT RYMWTVXVZW[Y[[Y\\W",
    639: " 14I[LMOMNSMXL[ RYMXPWRUURXOZL[",
    640: " 29JZTFRGQHQIRJUKXK RUKRLPMOOOQQSTTVT RTTPUNVMXMZO\\S^T_TaRbPb",
    641: " 18J[RMPNNPMSMVNYOZQ[S[UZWXXUXRWOVNTMRM",
    642: " 13G]PML[ RUMVSWXX[ RIPKNNM[M",
    643: " 19I[MSMVNYOZQ[S[UZWXXUXRWOVNTMRMPNNPMSIb",
    644: " 18I][MQMONMPLSLVMYNZP[R[TZVXWUWRVOUNSM",
    645: "  8H\\SMP[ RJPLNOMZM",
    646: " 16H\\IQJOLMNMONOPMVMYO[Q[TZVXXTYPYM",
    647: " 21G]ONMOKQJTJWKYLZN[Q[TZWXYUZRZOXMVMTORSPXMb",
    648: " 14I[KMMMOOU`WbYb RZMYOWRM]K`Jb",
    649: " 20F]VFNb RGQHOJMLMMNMPLULXMZO[Q[TZVXXUZP[M",
    650: " 23F]NMLNJQITIWJZK[M[OZQW RRSQWRZS[U[WZYWZTZQYNXM",
    651: " 22L\\UUTSRRPRNSMTLVLXMZO[Q[SZTXVRUWUZV[W[YZZY\\V",
    652: " 23M[MVOSRNSLTITGSFQGPIOMNTNZO[P[RZTXUUURVVWWYW[V",
    653: " 14MXTTTSSRQROSNTMVMXNZP[S[VYXV",
    654: " 24L\\UUTSRRPRNSMTLVLXMZO[Q[SZTXZF RVRUWUZV[W[YZZY\\V",
    655: " 17NXOYQXRWSUSSRRQROSNUNXOZQ[S[UZVYXV",
    656: " 24OWOVSQUNVLWIWGVFTGSIQQNZKaJdJfKgMfNcOZP[R[TZUYWV",
    657: " 28L[UUTSRRPRNSMTLVLXMZO[Q[SZTY RVRTYPdOfMgLfLdMaP^S\\U[XY[V",
    658: " 29M\\MVOSRNSLTITGSFQGPIOMNSM[ RM[NXOVQSSRURVSVUUXUZV[W[YZZY\\V",
    659: " 16PWSMSNTNTMSM RPVRRPXPZQ[R[TZUYWV",
    660: " 20PWSMSNTNTMSM RPVRRLdKfIgHfHdIaL^O\\Q[TYWV",
    661: " 33M[MVOSRNSLTITGSFQGPIOMNSM[ RM[NXOVQSSRURVSVUTVQV RQVSWTZU[V[XZYY[V",
    662: " 18OWOVQSTNULVIVGUFSGRIQMPTPZQ[R[TZUYWV",
    663: " 33E^EVGSIRJSJTIXH[ RIXJVLSNRPRQSQTPXO[ RPXQVSSURWRXSXUWXWZX[Y[[Z\\Y^V",
    664: " 23J\\JVLSNROSOTNXM[ RNXOVQSSRURVSVUUXUZV[W[YZZY\\V",
    665: " 23LZRRPRNSMTLVLXMZO[Q[SZTYUWUUTSRRQSQURWTXWXYWZV",
    666: " 24KZKVMSNQMUGg RMUNSPRRRTSUUUWTYSZQ[ RMZO[R[UZWYZV",
    667: " 27L[UUTSRRPRNSMTLVLXMZO[Q[SZ RVRUUSZPaOdOfPgRfScS\\U[XY[V",
    668: " 15MZMVOSPQPSSSTTTVSYSZT[U[WZXYZV",
    669: " 16NYNVPSQQQSSVTXTZR[ RNZP[T[VZWYYV",
    670: " 16OXOVQSSO RVFPXPZQ[S[UZVYXV RPNWN",
    671: " 19L[LVNRLXLZM[O[QZSXUU RVRTXTZU[V[XZYY[V",
    672: " 17L[LVNRMWMZN[O[RZTXUUUR RURVVWWYW[V",
    673: " 25I^LRJTIWIYJ[L[NZPX RRRPXPZQ[S[UZWXXUXR RXRYVZW\\W^V",
    674: " 20JZJVLSNRPRQSQZR[U[XYZV RWSVRTRSSOZN[L[KZ",
    675: " 23L[LVNRLXLZM[O[QZSXUU RVRPdOfMgLfLdMaP^S\\U[XY[V",
    676: " 23LZLVNSPRRRTTTVSXQZN[P\\Q^QaPdOfMgLfLdMaP^S\\WYZV",
    677: " 22J\\K[NZQXSVUSWOXKXIWGUFSGRHQJPOPTQXRZT[V[XZYY",
    683: " 26I[WUWRVOUNSMQMONMPLSLVMYNZP[R[TZVXWUXPXKWHVGTFRFPGNI",
    684: " 16JZWNUMRMPNNPMSMVNYOZQ[T[VZ RMTUT",
    685: " 23J[TFRGPJOLNOMTMXNZO[Q[SZUWVUWRXMXIWGVFTF RNPWP",
    686: " 21H\\VFNb RQMNNLPKSKVLXNZQ[S[VZXXYUYRXPVNSMQM",
    687: " 16I[XOWNTMQMNNMOLQLSMUOWSZT\\T^S_Q_",
    700: " 18H\\QFNGLJKOKRLWNZQ[S[VZXWYRYOXJVGSFQF",
    701: "  5H\\NJPISFS[",
    702: " 15H\\LKLJMHNGPFTFVGWHXJXLWNUQK[Y[",
    703: " 16H\\MFXFRNUNWOXPYSYUXXVZS[P[MZLYKW",
    704: "  7H\\UFKTZT RUFU[",
    705: " 18H\\WFMFLOMNPMSMVNXPYSYUXXVZS[P[MZLYKW",
    706: " 24H\\XIWGTFRFOGMJLOLTMXOZR[S[VZXXYUYTXQVOSNRNOOMQLT",
    707: "  6H\\YFO[ RKFYF",
    708: " 30H\\PFMGLILKMMONSOVPXRYTYWXYWZT[P[MZLYKWKTLRNPQOUNWMXKXIWGTFPF",
    709: " 24H\\XMWPURRSQSNRLPKMKLLINGQFRFUGWIXMXRWWUZR[P[MZLX",
    710: "  6MWRYQZR[SZRY",
    711: "  9MWSZR[QZRYSZS\\R^Q_",
    712: " 12MWRMQNROSNRM RRYQZR[SZRY",
    713: " 15MWRMQNROSNRM RSZR[QZRYSZS\\R^Q_",
    714: "  9MWRFRT RRYQZR[SZRY",
    715: " 21I[LKLJMHNGPFTFVGWHXJXLWNVORQRT RRYQZR[SZRY",
    716: "  3NVRFRM",
    717: "  6JZNFNM RVFVM",
    718: " 14KYQFOGNINKOMQNSNUMVKVIUGSFQF",
    719: " 27H\\PBP_ RTBT_ RYIWGTFPFMGKIKKLMMNOOUQWRXSYUYXWZT[P[MZKX",
    720: "  3G][BIb",
    721: " 11KYVBTDRGPKOPOTPYR]T`Vb",
    722: " 11KYNBPDRGTKUPUTTYR]P`Nb",
    723: "  3NVRBRb",
    724: "  3E_IR[R",
    725: "  6E_RIR[ RIR[R",
    726: "  6E_IO[O RIU[U",
    727: "  6G]KKYY RYKKY",
    728: "  9JZRLRX RMOWU RWOMU",
    729: "  6MWRQQRRSSRRQ",
    730: "  8MWSFRGQIQKRLSKRJ",
    731: "  8MWRHQGRFSGSIRKQL",
    732: "  9E_UMXP[RXTUW RIR[R",
    733: " 12H]SBLb RYBRb RLOZO RKUYU",
    734: " 35E_\\O\\N[MZMYNXPVUTXRZP[L[JZIYHWHUISJRQNRMSKSIRGPFNGMIMKNNPQUXWZY[[[\\Z\\Y",
    735: " 28G]IIJKKOKUJYI[ R[IZKYOYUZY[[ RIIKJOKUKYJ[I RI[KZOYUYYZ[[",
    737: "  6KYOBO[ RUBU[",
    738: "  6F^RBR[ RI[[[",
    739: "  4F^[BI[[[",
    740: " 18E_RIQJRKSJRI RIYHZI[JZIY R[YZZ[[\\Z[Y",
    741: " 33F^RHNLKPJSJUKWMXOXQWRU RRHVLYPZSZUYWWXUXSWRU RRUQYP\\ RRUSYT\\ RP\\T\\",
    742: " 26F^RNQKPINHMHKIJKJOKRLTNWR\\ RRNSKTIVHWHYIZKZOYRXTVWR\\",
    743: " 20F^RGPJLOIR RRGTJXO[R RIRLUPZR] R[RXUTZR]",
    744: " 48F^RTTWVXXXZW[U[SZQXPVPSQ RSQUOVMVKUISHQHOINKNMOOQQ RQQNPLPJQISIUJWLXNXPWRT RRTQYP\\ RRTSYT\\ RP\\T\\",
    745: " 55F^RRR[Q\\ RRVQ\\ RRIQHOHNINKONRR RRISHUHVIVKUNRR RRRNOLNJNIOIQJR RRRVOXNZN[O[QZR RRRNULVJVIUISJR RRRVUXVZV[U[SZR",
    746: " 55F^ISJSLTMVMXLZ RISIRJQLQMRNTNWMYLZ RRGPIOLOOQUQXPZR\\ RRGTIULUOSUSXTZR\\ R[S[RZQXQWRVTVWWYXZ R[SZSXTWVWXXZ RKVYV",
    750: " 18PSSRRSQSPRPQQPRPSQSSRUQV RQQQRRRRQQQ",
    751: " 16PTQPPQPSQTSTTSTQSPQP RRQQRRSSRRQ",
    752: "  9NVPOTU RTOPU RNRVR",
    753: " 28MWRKQMOPMR RRKSMUPWR RRMOQ RRMUQ RROPQ RROTQ RQQSQ RMRWR",
    754: " 26MWMRMQNOONQMSMUNVOWQWR RPNTN ROOUO RNPVP RNQVQ RMRWR",
    755: " 14LRLFLRRRLF RLIPQ RLLOR RLOMQ",
    756: " 10MWRKQMOPMR RRKSMUPWR",
    757: " 11MWWRWQVOUNSMQMONNOMQMR",
    758: " 13G]]R]P\\MZJWHTGPGMHJJHMGPGR",
    759: " 11MWMRMSNUOVQWSWUVVUWSWR",
    760: "  7LXLPNRQSSSVRXP",
    761: "  6RURUTTURTPRO",
    762: "  7RVRRUPVNVLUKTK",
    763: "  7NRRROPNNNLOKPK",
    764: " 21MWWHVGTFQFOGNHMJMLNNOOUSVTWVWXVZU[S\\P\\N[MZ",
    765: " 21G]IWHVGTGQHOINKMMMONPOTUUVWWYW[V\\U]S]P\\N[M",
    766: " 31G]RRTUUVWWYW[V\\U]S]Q\\O[NYMWMUNTOPUOVMWKWIVHUGSGQHOINKMMMONPORR",
    767: " 22H\\KFK[ RHF[FQP[Z RZV[Y\\[ RZVZY RWYZY RWYZZ\\[",
    768: " 30KYUARBPCNELHKLKRLUNWQXSXVWXUYR RKPLMNKQJSJVKXMYPYVXZV]T_R`Oa",
    796: "  3>f>RfR",
    797: "  3D`D``D",
    798: "  3RRR>Rf",
    799: "  3D`DD``",
    800: "  3D`DR`R",
    801: "  3F^FY^K",
    802: "  3KYK^YF",
    803: "  3RRRDR`",
    804: "  3KYKFY^",
    805: "  3F^FK^Y",
    806: "  3KYKRYR",
    807: "  3MWMWWM",
    808: "  3RRRKRY",
    809: "  3MWMMWW",
    810: "  8GRRGPGMHJJHMGPGR",
    811: "  8GRGRGTHWJZM\\P]R]",
    812: "  8R]R]T]W\\ZZ\\W]T]R",
    813: "  8R]]R]P\\MZJWHTGRG",
    814: "  9D`DOGQKSPTTTYS]Q`O",
    815: "  9PUUDSGQKPPPTQYS]U`",
    816: "  9OTODQGSKTPTTSYQ]O`",
    817: "  9D`DUGSKQPPTPYQ]S`U",
    818: "  5KYRJYNKVRZ",
    819: "  5JZJRNKVYZR",
    820: "  5KYKVKNYVYN",
    821: "  5JZLXJPZTXL",
    822: " 23JZJ]L]O\\Q[TXUVVSVOULTJSIQIPJOLNONSOVPXS[U\\X]Z]",
    823: " 23I]]Z]X\\U[SXPVOSNONLOJPIQISJTLUOVSVVUXT[Q\\O]L]J",
    824: " 23JZZGXGUHSIPLONNQNUOXPZQ[S[TZUXVUVQUNTLQIOHLGJG",
    825: " 23G[GJGLHOIQLTNUQVUVXUZT[S[QZPXOUNQNNOLPISHUGXGZ",
    826: " 21E[EPFRHTJUMVQVUUXSZP[NZLWLSMQNNPLSKVKYL\\M^",
    827: " 19EYETHVKWPWSVVTXQYNYLXKVKSLPNNQMTMYN\\P_",
    828: " 26OUQOOQOSQUSUUSUQSOQO RQPPQPSQTSTTSTQSPQP RRQQRRSSRRQ",
    829: " 11RWRMSMUNVOWQWSVUUVSWRW",
    830: "  9D`DRJR RORUR RZR`R",
    831: "  5D`DUDO`O`U",
    832: "  6JZRDJR RRDZR",
    833: "  9D`DR`R RJYZY RP`T`",
    834: "  9D`DR`R RDRRb R`RRb",
    840: " 18KYQKNLLNKQKSLVNXQYSYVXXVYSYQXNVLSKQK",
    841: "  6LXLLLXXXXLLL",
    842: "  5KYRJKVYVRJ",
    843: "  6LXRHLRR\\XRRH",
    844: " 12JZRIPOJOOSMYRUWYUSZOTORI",
    845: "  6KYRKRY RKRYR",
    846: "  6MWMMWW RWMMW",
    847: "  9MWRLRX RMOWU RWOMU",
    850: " 35NVQNOONQNSOUQVSVUUVSVQUOSNQN ROQOS RPPPT RQOQU RRORU RSOSU RTPTT RUQUS",
    851: " 27NVNNNVVVVNNN ROOOU RPOPU RQOQU RRORU RSOSU RTOTU RUOUU",
    852: " 17MWRLMUWURL RROOT RROUT RRRQT RRRST",
    853: " 17LULRUWUMLR RORTU RORTO RRRTS RRRTQ",
    854: " 17MWRXWOMORX RRUUP RRUOP RRRSP RRRQP",
    855: " 17OXXROMOWXR RURPO RURPU RRRPQ RRRPS",
    856: " 22LXRLNWXPLPVWRL RRRRL RRRLP RRRNW RRRVW RRRXP",
    857: " 11RYRKRY RRKYNRQ RSMVNSO",
    860: " 13MWRLRX ROOUO RMUOWQXSXUWWU",
    861: " 11LXRLRX RLQMOWOXQ RPWTW",
    862: " 14KYMNWX RWNMX ROLLOKQ RULXOYQ",
    863: " 18I[NII[ RVI[[ RMM[[ RWMI[ RNIVI RMMWM",
    864: " 21I[RGRV RMJWP RWJMP RIVL\\ R[VX\\ RIV[V RL\\X\\",
    865: " 11G[MJSV RKPSL RG\\[\\[RG\\",
    866: " 14LXPLPPLPLTPTPXTXTTXTXPTPTLPL",
    867: " 32KYYPXNVLSKQKNLLNKQKSLVNXQYSYVXXVYT RYPWNUMSMQNPOOQOSPUQVSWUWWVYT",
    868: " 10KYRJKVYVRJ RRZYNKNRZ",
    869: " 34G]PIPGQFSFTGTI RGZHXJVKTLPLKMJOIUIWJXKXPYTZV\\X]Z RGZ]Z RQZP[Q\\S\\T[SZ",
    870: " 64JZRMRS RRSQ\\ RRSS\\ RQ\\S\\ RRMQJPHNG RQJNG RRMSJTHVG RSJVG RRMNKLKJM RPLLLJM RRMVKXKZM RTLXLZM RRMPNOOOR RRMPOOR RRMTNUOUR RRMTOUR",
    871: " 94JZRIRK RRNRP RRSRU RRYQ\\ RRYS\\ RQ\\S\\ RRGQIPJ RRGSITJ RPJRITJ RRKPNNOMN RRKTNVOWN RNOPORNTOVO RRPPSNTLTKRKSLT RRPTSVTXTYRYSXT RNTPTRSTTVT RRUPXOYMZLZKYJWJYLZ RRUTXUYWZXZYYZWZYXZ RMZOZRYUZWZ",
    872: " 40JZRYQ\\ RRYS\\ RQ\\S\\ RRYUZXZZXZUYTWTYRZOYMWLUMVJUHSGQGOHNJOMMLKMJOKRMTKTJUJXLZOZRY",
    873: " 32JZRYQ\\ RRYS\\ RQ\\S\\ RRYVXVVXUXRZQZLYIXHVHTGPGNHLHKIJLJQLRLUNVNXRY",
    874: " 15I[IPKR RLKNP RRGRO RXKVP R[PYR",
    899: "  6QSRQQRRSSRRQ",
    900: " 10PTQPPQPSQTSTTSTQSPQP",
    901: " 14NVQNOONQNSOUQVSVUUVSVQUOSNQN",
    902: " 18MWQMONNOMQMSNUOVQWSWUVVUWSWQVOUNSMQM",
    903: " 18KYQKNLLNKQKSLVNXQYSYVXXVYSYQXNVLSKQK",
    904: " 22G]PGMHJJHMGPGTHWJZM\\P]T]W\\ZZ\\W]T]P\\MZJWHTGPG",
    905: " 34AcPALBJCGEEGCJBLAPATBXCZE]G_JaLbPcTcXbZa]__]aZbXcTcPbLaJ_G]EZCXBTAPA",
    906: " 34<hP<K=G?DAAD?G=K<P<T=Y?]A`DcGeKgPhThYg]e`cc`e]gYhThPgKeGcD`A]?Y=T<P<",
    907: " 50){O)I*E+@-;073370;-@+E*I)O)U*[+_-d0i3m7q;t@wEyIzO{U{[z_ydwitmqqmtiwdy_z[{U{OzIyEw@t;q7m3i0d-_+[*U)O)",
    908: " 34>fRAPCMDJDGCEA>H@JAMAZB]D_G`M`PaRc RRATCWDZD]C_AfHdJcMcZb]`_]`W`TaRc",
    909: " 33AcRAPCMDJDGCEABGAKAPBTDXG\\L`Rc RRATCWDZD]C_AbGcKcPbT`X]\\X`Rc RBHbH",
    997: "  3MWMXWX",
    998: "  3JZJZZZ",
    999: "  3JZJ]Z]",
    1001: " 18KYRKMX RRNVX RRKWX ROTTT RKXPX RTXYX",
    1002: " 35JZNKNX ROKOX RLKSKVLWNVPSQ RSKULVNUPSQ ROQSQVRWTWUVWSXLX RSQURVTVUUWSX",
    1003: " 24KYVLWKWOVLTKQKOLNMMPMSNVOWQXTXVWWU RQKOMNPNSOVQX",
    1004: " 26JZNKNX ROKOX RLKSKVLWMXPXSWVVWSXLX RSKULVMWPWSVVUWSX",
    1005: " 22JYNKNX ROKOX RSOSS RLKVKVOUK ROQSQ RLXVXVTUX",
    1006: " 20JXNKNX ROKOX RSOSS RLKVKVOUK ROQSQ RLXQX",
    1007: " 36K[VLWKWOVLTKQKOLNMMPMSNVOWQXTXVW RQKOMNPNSOVQX RTXUWVU RVSVX RWSWX RTSYS",
    1008: " 27J[NKNX ROKOX RVKVX RWKWX RLKQK RTKYK ROQVQ RLXQX RTXYX",
    1009: " 12NWRKRX RSKSX RPKUK RPXUX",
    1010: " 19LXSKSURWQX RTKTUSWQXPXNWMUNTOUNV RQKVK",
    1011: " 27JZNKNX ROKOX RWKOS RQQVX RRQWX RLKQK RTKYK RLXQX RTXYX",
    1012: " 14KXOKOX RPKPX RMKRK RMXWXWTVX",
    1013: " 30I\\MKMX RNNRX RNKRU RWKRX RWKWX RXKXX RKKNK RWKZK RKXOX RUXZX",
    1014: " 21JZNKNX ROMVX ROKVV RVKVX RLKOK RTKXK RLXPX",
    1015: " 32KZQKOLNMMPMSNVOWQXTXVWWVXSXPWMVLTKQK RQKOMNPNSOVQX RTXVVWSWPVMTK",
    1016: " 25JYNKNX ROKOX RLKSKVLWNWOVQSROR RSKULVNVOUQSR RLXQX",
    1017: " 47KZQKOLNMMPMSNVOWQXTXVWWVXSXPWMVLTKQK RQKOMNPNSOVQX RTXVVWSWPVMTK RPWPUQTSTTUUZV[W[XZ RTUUXVZW[",
    1018: " 37JZNKNX ROKOX RLKSKVLWNWOVQSROR RSKULVNVOUQSR RLXQX RSRTSUWVXWXXW RSRUSVWWX",
    1019: " 32KZVMWKWOVMULSKQKOLNMNOOPQQTRVSWT RNNOOQPTQVRWSWVVWTXRXPWOVNTNXOV",
    1020: " 16KZRKRX RSKSX RNKMOMKXKXOWK RPXUX",
    1021: " 20J[NKNUOWQXTXVWWUWK ROKOUPWQX RLKQK RUKYK",
    1022: " 15KYMKRX RNKRU RWKRX RKKPK RTKYK",
    1023: " 24I[LKOX RMKOT RRKOX RRKUX RSKUT RXKUX RJKOK RVKZK",
    1024: " 21KZNKVX ROKWX RWKNX RLKQK RTKYK RLXQX RTXYX",
    1025: " 20LYNKRRRX ROKSR RWKSRSX RLKQK RTKYK RPXUX",
    1026: " 16LYVKNX RWKOX ROKNONKWK RNXWXWTVX",
    1027: " 18KYRKMX RRNVX RRKWX ROTTT RKXPX RTXYX",
    1028: " 35JZNKNX ROKOX RLKSKVLWNVPSQ RSKULVNUPSQ ROQSQVRWTWUVWSXLX RSQURVTVUUWSX",
    1029: " 14KXOKOX RPKPX RMKWKWOVK RMXRX",
    1030: " 15KYRKLX RRMWX RRKXX RMWVW RLXXX",
    1031: " 22JYNKNX ROKOX RSOSS RLKVKVOUK ROQSQ RLXVXVTUX",
    1032: " 16LYVKNX RWKOX ROKNONKWK RNXWXWTVX",
    1033: " 27J[NKNX ROKOX RVKVX RWKWX RLKQK RTKYK ROQVQ RLXQX RTXYX",
    1034: " 44KZQKOLNMMPMSNVOWQXTXVWWVXSXPWMVLTKQK RQKOMNPNSOVQX RTXVVWSWPVMTK RQOQT RTOTT RQQTQ RQRTR",
    1035: " 12NWRKRX RSKSX RPKUK RPXUX",
    1036: " 27JZNKNX ROKOX RWKOS RQQVX RRQWX RLKQK RTKYK RLXQX RTXYX",
    1037: " 15KYRKMX RRNVX RRKWX RKXPX RTXYX",
    1038: " 30I\\MKMX RNNRX RNKRU RWKRX RWKWX RXKXX RKKNK RWKZK RKXOX RUXZX",
    1039: " 21JZNKNX ROMVX ROKVV RVKVX RLKOK RTKXK RLXPX",
    1040: " 36JZMJLM RXJWM RPPOS RUPTS RMVLY RXVWY RMKWK RMLWL RPQTQ RPRTR RMWWW RMXWX",
    1041: " 32KZQKOLNMMPMSNVOWQXTXVWWVXSXPWMVLTKQK RQKOMNPNSOVQX RTXVVWSWPVMTK",
    1042: " 21J[NKNX ROKOX RVKVX RWKWX RLKYK RLXQX RTXYX",
    1043: " 25JYNKNX ROKOX RLKSKVLWNWOVQSROR RSKULVNVOUQSR RLXQX",
    1044: " 20K[MKRQ RNKSQMX RMKWKXOVK RNWWW RMXWXXTVX",
    1045: " 16KZRKRX RSKSX RNKMOMKXKXOWK RPXUX",
    1046: " 33KZMONLOKPKQLRORX RXOWLVKUKTLSOSX RMONMOLPLQMRO RXOWMVLULTMSO RPXUX",
    1047: " 40KZRKRX RSKSX RQNNOMQMRNTQUTUWTXRXQWOTNQN RQNOONQNROTQU RTUVTWRWQVOTN RPKUK RPXUX",
    1048: " 21KZNKVX ROKWX RWKNX RLKQK RTKYK RLXQX RTXYX",
    1049: " 33J[RKRX RSKSX RLPMONOOSQU RTUVSWOXOYP RMONROTQUTUVTWRXO RPKUK RPXUX",
    1050: " 35KZMVNXQXMRMONMOLQKTKVLWMXOXRTXWXXV ROUNRNOOMQK RTKVMWOWRVU RNWPW RUWWW",
    1051: " 18KYTKKX RSMTX RTKUX RNTTT RIXNX RRXWX",
    1052: " 34JYPKLX RQKMX RNKUKWLWNVPSQ RUKVLVNUPSQ ROQRQTRUSUUTWQXJX RRQTSTUSWQX",
    1053: " 25KXVLWLXKWNVLTKRKPLOMNOMRMUNWPXRXTWUU RRKPMOONRNVPX",
    1054: " 26JYPKLX RQKMX RNKTKVLWNWQVTUVTWQXJX RTKULVNVQUTTVSWQX",
    1055: " 22JYPKLX RQKMX RSORS RNKXKWNWK ROQRQ RJXTXUUSX",
    1056: " 20JXPKLX RQKMX RSORS RNKXKWNWK ROQRQ RJXOX",
    1057: " 33KYVLWLXKWNVLTKRKPLOMNOMRMUNWPXRXTWUVVS RRKPMOONRNVPX RRXTVUS RSSXS",
    1058: " 27J[PKLX RQKMX RXKTX RYKUX RNKSK RVK[K ROQVQ RJXOX RRXWX",
    1059: " 12NWTKPX RUKQX RRKWK RNXSX",
    1060: " 19LXUKRUQWPX RVKSURWPXOXMWLUMTNUMV RSKXK",
    1061: " 27JZPKLX RQKMX RYKOR RRPTX RSPUX RNKSK RVK[K RJXOX RRXWX",
    1062: " 14KXQKMX RRKNX ROKTK RKXUXVUTX",
    1063: " 30I\\OKKX ROMPX RPKQV RYKPX RYKUX RZKVX RMKPK RYK\\K RIXMX RSXXX",
    1064: " 21JZPKLX RPKTX RQKTU RXKTX RNKQK RVKZK RJXNX",
    1065: " 32KYRKPLOMNOMRMUNWPXRXTWUVVTWQWNVLTKRK RRKPMOONRNVPX RRXTVUTVQVMTK",
    1066: " 24JYPKLX RQKMX RNKUKWLXMXOWQTROR RUKWMWOVQTR RJXOX",
    1067: " 46KYRKPLOMNOMRMUNWPXRXTWUVVTWQWNVLTKRK RRKPMOONRNVPX RRXTVUTVQVMTK ROWOVPUQURVRZS[T[UZ RRVSZT[",
    1068: " 35JZPKLX RQKMX RNKUKWLXMXOWQTROR RUKWMWOVQTR RSRTWUXVXWW RSRTSUWVX RJXOX",
    1069: " 28KZWLXLYKXNWLUKRKPLOMOOPPUSVT RONPOURVSVVUWSXPXNWMULXMWNW",
    1070: " 16KZTKPX RUKQX RPKNNOKZKYNYK RNXSX",
    1071: " 20J[PKMUMWOXSXUWVUYK RQKNUNWOX RNKSK RWK[K",
    1072: " 15KYOKPX RPKQV RYKPX RMKRK RVK[K",
    1073: " 24I[NKMX ROKNV RTKMX RTKSX RUKTV RZKSX RLKQK RXK\\K",
    1074: " 21KZPKTX RQKUX RYKLX RNKSK RVK[K RJXOX RRXWX",
    1075: " 20LYPKRQPX RQKSQ RYKSQQX RNKSK RVK[K RNXSX",
    1076: " 16LYXKLX RYKMX RQKONPKYK RLXUXVUTX",
    1101: " 32LZQOPPPQOQOPQOTOVQVWWXXX RTOUQUWWX RURRSPTOUOWPXSXTWUU RRSPUPWQX",
    1102: " 29JYNKNX ROKOX RORPPROTOVPWRWUVWTXRXPWOU RTOUPVRVUUWTX RLKOK",
    1103: " 24LXVQUQURVRVQUPSOQOOPNRNUOWQXSXUWVV RQOPPOROUPWQX",
    1104: " 32L[VKVX RWKWX RVRUPSOQOOPNRNUOWQXSXUWVU RQOPPOROUPWQX RTKWK RVXYX",
    1105: " 26LXOSVSVRUPSOQOOPNRNUOWQXSXUWVV RUSUQSO RQOPPOROUPWQX",
    1106: " 20LWTKULUMVMVLTKRKPMPX RRKQMQX RNOSO RNXSX",
    1107: " 42LYQOOQOSQUSUUSUQSOQO RQOPQPSQU RSUTSTQSO RTPUOVO RPTOUOXPYTYVZ ROWPXTXVYV[T\\P\\N[NYPX",
    1108: " 28J[NKNX ROKOX RORPPROTOVPWRWX RTOUPVRVX RLKOK RLXQX RTXYX",
    1109: " 18NWRKRLSLSKRK RRORX RSOSX RPOSO RPXUX",
    1110: " 23NWSKSLTLTKSK RSOSZR\\ RTOTZR\\P\\O[OZPZP[O[ RQOTO",
    1111: " 27JZNKNX ROKOX RWOOU RRSVX RSSWX RLKOK RTOYO RLXQX RTXYX",
    1112: " 12NWRKRX RSKSX RPKSK RPXUX",
    1113: " 44F_JOJX RKOKX RKRLPNOPORPSRSX RPOQPRRRX RSRTPVOXOZP[R[X RXOYPZRZX RHOKO RHXMX RPXUX RXX]X",
    1114: " 28J[NONX ROOOX RORPPROTOVPWRWX RTOUPVRVX RLOOO RLXQX RTXYX",
    1115: " 28LYQOOPNRNUOWQXTXVWWUWRVPTOQO RQOPPOROUPWQX RTXUWVUVRUPTO",
    1116: " 32JYNON\\ ROOO\\ RORPPROTOVPWRWUVWTXRXPWOU RTOUPVRVUUWTX RLOOO RL\\Q\\",
    1117: " 29KYUOU\\ RVOV\\ RURTPROPONPMRMUNWPXRXTWUU RPOOPNRNUOWPX RS\\X\\",
    1118: " 22KXOOOX RPOPX RPRQPSOUOVPVQUQUPVP RMOPO RMXRX",
    1119: " 26LYTOUPUQVQVPTOQOOPORQSTTVU ROQQRTSVTVWTXQXOWOVPVPWQX",
    1120: " 14LWPKPVRXTXUWUV RQKQVRX RNOTO",
    1121: " 28J[NONUOWQXSXUWVU ROOOUPWQX RVOVX RWOWX RLOOO RTOWO RVXYX",
    1122: " 15KYNORX ROORV RVORX RLOQO RTOXO",
    1123: " 24I[LOOX RMOOU RROOX RROUX RSOUU RXOUX RJOOO RVOZO",
    1124: " 21KYNOUX ROOVX RVONX RLOQO RTOXO RLXPX RSXXX",
    1125: " 23KYNORX ROORV RVORXP[N\\M\\L[LZMZM[L[ RLOQO RTOXO",
    1126: " 16LXUONX RVOOX ROONQNOVO RNXVXVVUX",
    1127: " 32K[QOOPNQMSMUNWPXQXSWUUWRXO RQOOQNSNUOWPX RQOSOUPWWXX RSOTPVWXXYX",
    1128: " 40KXRKPMOOMUK\\ RQLPNNTL\\ RRKTKVLVNUPRQ RTKULUNTPRQ RRQTRUTUVTWRXQXOWNT RRQSRTTTVRX",
    1129: " 19KYLQNOPORPSSSXR\\ RLQNPPPRQSS RWOVRSXQ\\",
    1130: " 39KYSOQOOPNQMSMUNWPXRXTWUVVTVRUPRNQLQKRJTJUKVM RQOOQNSNVPX RRXTVUTUQSO RQLRKTKVM",
    1131: " 27LXVPTOQOOPOQPRRS RQOPPPQRS RRSOTNUNWPXSXUW RRSPTOUOWPX",
    1132: " 28LWRKQLQMSNVNVMSNPOOPNRNTOVPWRXSYS[R\\P\\O[ RSNQOPPOROTPVRX",
    1133: " 26IYJRKPLONOOPOQMX RMONPNQLX ROQPPROTOVPVRS\\ RTOUPURR\\",
    1134: " 35IYJSKQLPNPOQOVPX RMPNQNUOWPXQXSWTVUTVQVNULTKRKQLQNRPURWS RQXSVTTUQUNTK",
    1135: " 13NWROPVPWQXSXUWVU RSOQVQWRX",
    1136: " 26KYOOLX RPOMX RUOVPWPVOTORQOR RORPSRWTXVWWU RORQSSWTX",
    1137: " 15LXLKNKPLWX RNKOLVX RRPMX RRPNX",
    1138: " 26KZOOK\\ RPOL\\ RNUNWOXQXSWTV RVOTVTWUXWXXWYU RWOUVUWVX",
    1139: " 19JYNOMX ROONUMX RVRVOWOVRTUQWNXMX RLOOO",
    1140: " 36MXRKQLQMSNVN RTNQOPPPRRSUS RTNROQPQRRS RSSPTOUOWQXSYTZT[S\\Q\\ RSSQTPUPWQX",
    1141: " 28KXQOOPNQMSMUNWPXRXTWUVVTVRUPSOQO RQOOQNSNVPX RRXTVUTUQSO",
    1142: " 20IZPPMX RPPNX RTPSX RTPTX RKQMOXO RKQMPXP",
    1143: " 29JXSOQOOPNQMSJ\\ RQOOQNSK\\ RSOUPVRVTUVTWRXPXNWMU RSOUQUTTVRX",
    1144: " 28K[YOQOOPNQMSMUNWPXRXTWUVVTVRUPYP RQOOQNSNVPX RRXTVUTUQSO",
    1145: " 14KZSPQX RSPRX RMQOOXO RMQOPXP",
    1146: " 24JXKRLPMOOOPPPROUOWPX RNOOPORNUNWPXQXSWUUVRVOUOVP",
    1147: " 35KZOPNQMSMUNWPXRXUWWUXRXPWOUOTPSRRUO\\ RMUNVPWRWUVWTXR RXQWPUPSR RRUQXP\\",
    1148: " 17KXMONOPPS[T\\ RNOOPR[T\\U\\ RVOTRNYL\\",
    1149: " 28I[TKQ\\ RUKP\\ RJRKPLONOOPOVPWSWUVWT RMONPNTOWPXSXUWWTXRYO",
    1150: " 36JZNPPPPONPMQLSLUMWNXPXQWRUSR RLUNWPWRU RRRRWSXUXWVXTXRWPVOVPWP RRUSWUWWV",
    1151: " 32KZVOTVTWUXWXXWYU RWOUVUWVX RUSUQSOQOOPNQMSMUNWPXRXTV RQOOQNSNVPX",
    1152: " 32JXOKMR RPKNRNVPX RNROPQOSOUPVRVTUVTWRXPXNWMUMR RSOUQUTTVRX RMKPK",
    1153: " 22KXUPUQVQUPSOQOOPNQMSMUNWPXRXTWUV RQOOQNSNVPX",
    1154: " 35KZWKTVTWUXWXXWYU RXKUVUWVX RUSUQSOQOOPNQMSMUNWPXRXTV RQOOQNSNVPX RUKXK",
    1155: " 23KWNURTTSURUPSOQOOPNQMSMUNWPXRXTWUV RQOOQNSNVPX",
    1156: " 23MXWKXLXKVKTLSNPYO[N\\ RVKULTNQYP[N\\L\\L[M\\ RPOVO",
    1157: " 34KYVOTVSYR[ RWOUVTYR[P\\M\\L[M[N\\ RUSUQSOQOOPNQMSMUNWPXRXTV RQOOQNSNVPX",
    1158: " 29KZPKLX RQKMX ROQPPROTOVPVRUUUWVX RTOUPURTUTWUXWXXWYU RNKQK",
    1159: " 26MWSKSLTLTKSK RNROPPOROSPSRRURWSX RQORPRRQUQWRXTXUWVU",
    1160: " 26MWTKTLULUKTK RORPPQOSOTPTRRYQ[O\\M\\M[N\\ RROSPSRQYP[O\\",
    1161: " 32KXPKLX RQKMX RVPUQVQVPUOTORQPROR RORPSQWRXTXUWVU RORQSRWSX RNKQK",
    1162: " 16NVSKPVPWQXSXTWUU RTKQVQWRX RQKTK",
    1163: " 46F^GRHPIOKOLPLQJX RJOKPKQIX RLQMPOOQOSPSQQX RQORPRQPX RSQTPVOXOZPZRYUYWZX RXOYPYRXUXWYX[X\\W]U",
    1164: " 33J[KRLPMOOOPPPQNX RNOOPOQMX RPQQPSOUOWPWRVUVWWX RUOVPVRUUUWVXXXYWZU",
    1165: " 28KXQOOPNQMSMUNWPXRXTWUVVTVRUPSOQO RQOOQNSNVPX RRXTVUTUQSO",
    1166: " 35JYKRLPMOOOPPPQM\\ RNOOPOQL\\ RPQROTOVPWRWTVVUWSXQXOVOT RTOVQVTUVSX RJ\\O\\",
    1167: " 28KYVOR\\ RWOS\\ RUSUQSOQOOPNQMSMUNWPXRXTV RQOOQNSNVPX RP\\U\\",
    1168: " 22LXMRNPOOQORPRQPX RPOQPQQOX RRQSPUOVOWPWQVQWP",
    1169: " 24LYVPVQWQVPTOQOOPORQSTTVU ROQQRTSVTVWTXQXOWNVOVOW",
    1170: " 16NWSKPVPWQXSXTWUU RTKQVQWRX RPOUO",
    1171: " 33IZJRKPLONOOPORNUNWOX RMONPNRMUMWOXQXSWTV RVOTVTWUXWXXWYU RWOUVUWVX",
    1172: " 24JXKRLPMOOOPPPROUOWPX RNOOPORNUNWPXQXSWUUVRVOUOVP",
    1173: " 37H\\IRJPKOMONPNRMUMWNX RLOMPMRLULWNXOXQWRV RTORVRWTX RUOSVSWTXUXWWYUZRZOYOZP",
    1174: " 38JZMRNPPOROSPSR RQORPRRQUPWNXMXLWLVMVLW RXPWQXQXPWOVOTPSRRURWSX RQUQWRXTXVWWU",
    1175: " 35IYJRKPLONOOPORNUNWOX RMONPNRMUMWOXQXSWTV RVOTVSYR[ RWOUVTYR[P\\M\\L[M[N\\",
    1176: " 27KYWOWPVQNVMWMX RNQOOROUQ ROPRPUQVQ RNVOVRWUW ROVRXUXVV",
    1177: " 39H[RKSLSMTMTLRKOKMLLNLX ROKNLMNMX RXKYLYMZMZLXKVKTMTX RVKUMUX RJOWO RJXOX RRXWX",
    1178: " 29J[UKVLWLWKQKOLNNNX RQKPLONOX RVOVX RWOWX RLOWO RLXQX RTXYX",
    1179: " 27J[WKQKOLNNNX RQKPLONOX RUKVLVX RWKWX RLOVO RLXQX RTXYX",
    1180: " 48F_PKQLQMRMRLPKMKKLJNJX RMKLLKNKX RYKZL[L[KUKSLRNRX RUKTLSNSX RZOZX R[O[X RHO[O RHXMX RPXUX RXX]X",
    1181: " 46F_PKQLQMRMRLPKMKKLJNJX RMKLLKNKX R[KUKSLRNRX RUKTLSNSX RYKZLZX R[K[X RHOZO RHXMX RPXUX RXX]X",
    1182: " 12NWRORX RSOSX RPOSO RPXUX",
    1184: " 21LXVPTOROPPOQNSNUOWQXSXUW RROPQOSOVQX ROSSS",
    1185: " 35LYSKQLPMOONRNUOWPXRXTWUVVTWQWNVLUKSK RSKQMPOOSOVPX RRXTVUTVPVMUK ROQVQ",
    1186: " 34KZTKQ\\ RUKP\\ RQONPMRMUNWQXTXWWXUXRWPTOQO RQOOPNRNUOWQX RTXVWWUWRVPTO",
    1187: " 22LXUPVRVQUPSOQOOPNRNTOVRX RQOOQOTPVRXSYS[R\\P\\",
    1191: " 45I[VKWLXLVKSKQLPMOOLYK[J\\ RSKQMPOMYL[J\\H\\H[I\\ RZK[L[KYKWLVNSYR[Q\\ RYKXLWNTYS[Q\\O\\O[P\\ RLOYO",
    1192: " 38IZVKWLXLXKSKQLPMOOLYK[J\\ RSKQMPOMYL[J\\H\\H[I\\ RVOTVTWUXWXXWYU RWOUVUWVX RLOWO",
    1193: " 38IZVKWL RXKSKQLPMOOLYK[J\\ RSKQMPOMYL[J\\H\\H[I\\ RWKTVTWUXWXXWYU RXKUVUWVX RLOVO",
    1194: " 63F^SKTLTM RULSKPKNLMMLOIYH[G\\ RPKNMMOJYI[G\\E\\E[F\\ RZK[L\\L\\KWKUL RTMSOPYO[N\\ RWKUMTOQYP[N\\L\\L[M\\ RZOXVXWYX[X\\W]U R[OYVYWZX RIO[O",
    1195: " 63F^SKTLTM RULSKPKNLMMLOIYH[G\\ RPKNMMOJYI[G\\E\\E[F\\ RZK[L R\\KWKUL RTMSOPYO[N\\ RWKUMTOQYP[N\\L\\L[M\\ R[KXVXWYX[X\\W]U R\\KYVYWZX RIOZO",
    1196: " 20MWNROPPOROSPSRRURWSX RQORPRRQUQWRXTXUWVU",
    1200: " 28LYQKOLNONTOWQXTXVWWTWOVLTKQK RQKPLOOOTPWQX RTXUWVTVOULTK",
    1201: " 10LYPNSKSX RRLRX ROXVX",
    1202: " 35LYOMONNNNMOLQKTKVLWNVPTQQROSNUNX RTKULVNUPTQ RNWOVPVSWVWWV RPVSXVXWVWU",
    1203: " 39LYOMONNNNMOLQKTKVLWNVPTQ RTKULVNUPTQ RRQTQVRWTWUVWTXQXOWNVNUOUOV RTQURVTVUUWTX",
    1204: " 13LYSMSX RTKTX RTKMTXT RQXVX",
    1205: " 33LYOKNQ ROKVK ROLSLVK RNQOPQOTOVPWRWUVWTXQXOWNVNUOUOV RTOUPVRVUUWTX",
    1206: " 36LYVMVNWNWMVLTKRKPLOMNPNUOWQXTXVWWUWSVQTPQPNR RRKPMOPOUPWQX RTXUWVUVSUQTP",
    1207: " 22LYNKNO RVMRTPX RWKTQQX RNMPKRKUM RNMPLRLUMVM",
    1208: " 51LYQKOLNNOPQQTQVPWNVLTKQK RQKPLONPPQQ RTQUPVNULTK RQQORNTNUOWQXTXVWWUWTVRTQ RQQPROTOUPWQX RTXUWVUVTURTQ",
    1209: " 36LYOVOUNUNVOWQXSXUWVVWSWNVLTKQKOLNNNPORQSTSWQ RSXUVVSVNULTK RQKPLONOPPRQS",
    1210: "  6NVRVQWRXSWRV",
    1211: "  8NVSWRXQWRVSWSYQ[",
    1212: " 12NVROQPRQSPRO RRVQWRXSWRV",
    1213: " 14NVROQPRQSPRO RSWRXQWRVSWSYQ[",
    1214: " 15NVRKQLRSSLRK RRLRO RRVQWRXSWRV",
    1215: " 29LYNNONOONONNOLQKTKVLWNWOVQSRRSRTST RTKVMVPUQSR RRWRXSXSWRW",
    1216: "  6OVRKRP RSKRP",
    1217: " 12LXOKOP RPKOP RUKUP RVKUP",
    1218: " 10MWQKPLPNQOSOTNTLSKQK",
    1219: "  9MWRJRP ROKUO RUKOO",
    1220: "  3KZXHM\\",
    1221: " 16MWUHSJQMPPPTQWSZU\\ RSJRLQPQTRXSZ",
    1222: " 16MWOHQJSMTPTTSWQZO\\ RQJRLSPSTRXQZ",
    1223: " 12MWPHP\\ RQHQ\\ RPHUH RP\\U\\",
    1224: " 12MWSHS\\ RTHT\\ ROHTH RO\\T\\",
    1225: " 38LWSHQIPJPLRNSP RQIPL RSNRQ RPJQLSNSPRQPRRSSTSVQXPZ RRSSV RPXQ[ RSTRVPXPZQ[S\\",
    1226: " 38MXQHSITJTLRNQP RSITL RQNRQ RTJSLQNQPRQTRRSQTQVSXTZ RRSQV RTXS[ RQTRVTXTZS[Q\\",
    1227: "  4MWTHPRT\\",
    1228: "  4MWPHTRP\\",
    1229: "  3OURHR\\",
    1230: "  6MWPHP\\ RTHT\\",
    1231: "  3I[LRXR",
    1232: "  6I[RLRX RLRXR",
    1233: "  9JZRMRX RMRWR RMXWX",
    1234: "  9JZRMRX RMMWM RMRWR",
    1235: "  6JZMMWW RWMMW",
    1236: "  6NVRQQRRSSRRQ",
    1237: " 15I[RLQMRNSMRL RLRXR RRVQWRXSWRV",
    1238: "  6I[LPXP RLTXT",
    1239: "  9I[WLMX RLPXP RLTXT",
    1240: "  9I[LNXN RLRXR RLVXV",
    1241: "  4JZWLMRWX",
    1242: "  4JZMLWRMX",
    1243: " 10JZWKMOWS RMTWT RMXWX",
    1244: " 10JZMKWOMS RMTWT RMXWX",
    1245: " 21H[YUWUUTTSRPQOONNNLOKQKRLTNUOUQTRSTPUOWNYN",
    1246: " 16JZLTLRMPOPUSWSXR RLRMQOQUTWTXRXP",
    1247: "  8JZMSRPWS RMSRQWS",
    1248: "  7NVSKPO RSKTLPO",
    1249: "  7NVQKTO RQKPLTO",
    1250: " 14LXNKOMQNSNUMVK RNKONQOSOUNVK",
    1251: "  8NVSLRMQLRKSLSNQP",
    1252: "  8NVSKQMQORPSORNQO",
    1253: "  8NVQLRMSLRKQLQNSP",
    1254: "  8NVQKSMSORPQORNSO",
    1256: " 11JZWMQMONNOMQMSNUOVQWWW",
    1257: " 11JZMMMSNUOVQWSWUVVUWSWM",
    1258: " 11JZMMSMUNVOWQWSVUUVSWMW",
    1259: " 11JZMWMQNOONQMSMUNVOWQWW",
    1260: " 14JZWMQMONNOMQMSNUOVQWWW RMRUR",
    1261: " 13I[TOUPXRUTTU RUPWRUT RLRWR",
    1262: " 13MWRMRX ROPPORLTOUP RPORMTO",
    1263: " 13I[POOPLROTPU ROPMROT RMRXR",
    1264: " 13MWRLRW ROTPURXTUUT RPURWTU",
    1265: " 37KYVSUPSOQOOPNQMSMUNWPXRXTWUVVTWQWNVLTKQKPLQLRK RQOOQNSNVPX RRXTVUTVQVNULTK",
    1266: " 15JZLKRX RMKRV RXKRX RLKXK RNLWL",
    1267: " 10G[IOLORW RKORX R[FRX",
    1268: " 26I[XIXJYJYIXHVHTJSLROQUPYO[ RUITKSORUQXPZN\\L\\K[KZLZL[",
    1269: " 40I[XIXJYJYIXHVHTJSLROQUPYO[ RUITKSORUQXPZN\\L\\K[KZLZL[ RQNOONQNSOUQVSVUUVSVQUOSNQN",
    1270: " 26H\\ZRYTWUVUTTSSQPPONNMNKOJQJRKTMUNUPTQSSPTOVNWNYOZQZR",
    1271: " 26JZXKLX ROKPLPNOOMOLNLLMKOKSLVLXK RUTTUTWUXWXXWXUWTUT",
    1272: " 41J[YPXPXQYQYPXOWOVPUTTVSWQXOXMWLVLTMSORRPSNSLRKPKOLONPQUWWXXXYW ROXMVMTOR RONPPVWWX",
    1273: " 29J[UPSOQOPQPRQTSTUS RUOUSVTXTYRYQXNVLSKRKOLMNLQLRMUOWRXSXVW",
    1274: " 34KZQHQ\\ RTHT\\ RWLVLVMWMWLUKPKNLNNOPVSWT RNNOOVRWTWVVWTXQXOWNVNUOUOVNV",
    1275: " 12KYRKN\\ RVKR\\ RNQWQ RMVVV",
    1276: " 40LXTLSLSMTMTLSKQKPLPNQPTRUS RPNQOTQUSUUSW RQPOROTPVSXTY ROTPUSWTYT[S\\Q\\P[PZQZQ[P[",
    1277: " 29LXRKQLRMSLRK RRMRQ RRQQSRVSSRQ RRVR\\ RPOONNOOPPOTOUNVOUPTO",
    1278: " 42LXRMSLRKQLRMRQQRSURV RRQSRQURVRZQ[R\\S[RZ RPOONNOOPPOTOUNVOUPTO RPXOWNXOYPXTXUWVXUYTX",
    1279: " 12LYVKVX RNKVK RQQVQ RNXVX",
    1281: " 24H\\QKNLLNKQKSLVNXQYSYVXXVYSYQXNVLSKQK RRQQRRSSRRQ",
    1282: " 33LYQKPLPMQN RTKULUMTN RRNPOOQORPTRUSUUTVRVQUOSNRN RRURY RSUSY ROWVW",
    1283: " 23LYRKPLONOOPQRRSRUQVOVNULSKRK RRRRX RSRSX ROUVU",
    1284: " 24H\\QKNLLNKQKSLVNXQYSYVXXVYSYQXNVLSKQK RRKRY RKRYR",
    1285: " 25JYRRPQOQMRLTLUMWOXPXRWSUSTRR RWMRR RRMWMWR RRMVNWR",
    1286: " 25JZLLMKOKQLRNRPQRPSNT ROKPLQNQQPS RVKUX RWKTX RNTXT",
    1287: " 27JYNKNU ROKNR RNROPQOSOUPVQVTTVTXUYVYWX RSOUQUTTV RLKOK",
    1288: " 27LYONRKRQ RVNSKSQ RRQPROTOUPWRXSXUWVUVTURSQ RRTRUSUSTRT",
    1289: " 27JZRKRY RMKMPNRPSTSVRWPWK RLMMKNM RQMRKSM RVMWKXM ROVUV",
    1290: " 27JYNKNX ROKOX RLKSKVLWNWOVQSROR RSKULVNVOUQSR RLXVXVUUX",
    1291: " 20LYWKTKQLONNQNSOVQXTYWY RWKTLRNQQQSRVTXWY",
    1292: " 23JZRRPQOQMRLTLUMWOXPXRWSUSTRR RSLQQ RWMRR RXQSS",
    1293: " 12KYPMTW RTMPW RMPWT RWPMT",
    1294: " 34J[OUMULVLXMYOYPXPVNTMRMONMOLQKTKVLWMXOXRWTUVUXVYXYYXYVXUVU RNMPLULWM",
    1295: " 34J[OOMOLNLLMKOKPLPNNPMRMUNWOXQYTYVXWWXUXRWPUNULVKXKYLYNXOVO RNWPXUXWW",
    1401: " 21F^KHK\\ RLHL\\ RXHX\\ RYHY\\ RHH\\H RH\\O\\ RU\\\\\\",
    1402: " 20H]KHRQJ\\ RJHQQ RJHYHZMXH RK[X[ RJ\\Y\\ZWX\\",
    1403: " 20KYVBTDRGPKOPOTPYR]T`Vb RTDRHQKPPPTQYR\\T`",
    1404: " 20KYNBPDRGTKUPUTTYR]P`Nb RPDRHSKTPTTSYR\\P`",
    1405: " 12KYOBOb RPBPb ROBVB RObVb",
    1406: " 12KYTBTb RUBUb RNBUB RNbUb",
    1407: " 40KYTBRCQDPFPHQJRKSMSOQQ RRCQEQGRISJTLTNSPORSTTVTXSZR[Q]Q_Ra RQSSUSWRYQZP\\P^Q`RaTb",
    1408: " 40KYPBRCSDTFTHSJRKQMQOSQ RRCSESGRIQJPLPNQPURQTPVPXQZR[S]S_Ra RSSQUQWRYSZT\\T^S`RaPb",
    1409: " 24KYU@RCPFOIOLPOSVTYT\\S_Ra RRCQEPHPKQNTUUXU[T^RaOd",
    1410: " 24KYO@RCTFUIULTOQVPYP\\Q_Ra RRCSETHTKSNPUOXO[P^RaUd",
    1411: " 13AXCRGRR` RGSRa RFSRb RX:Rb",
    1412: " 32F^[CZD[E\\D\\C[BYBWCUETGSJRNPZO^N` RVDUFTJRVQZP]O_MaKbIbHaH`I_J`Ia",
    2001: " 18H\\RFK[ RRFY[ RRIX[ RMUVU RI[O[ RU[[[",
    2002: " 45G]LFL[ RMFM[ RIFUFXGYHZJZLYNXOUP RUFWGXHYJYLXNWOUP RMPUPXQYRZTZWYYXZU[I[ RUPWQXRYTYWXYWZU[",
    2003: " 32G\\XIYLYFXIVGSFQFNGLIKKJNJSKVLXNZQ[S[VZXXYV RQFOGMILKKNKSLVMXOZQ[",
    2004: " 30G]LFL[ RMFM[ RIFSFVGXIYKZNZSYVXXVZS[I[ RSFUGWIXKYNYSXVWXUZS[",
    2005: " 22G\\LFL[ RMFM[ RSLST RIFYFYLXF RMPSP RI[Y[YUX[",
    2006: " 20G[LFL[ RMFM[ RSLST RIFYFYLXF RMPSP RI[P[",
    2007: " 40G^XIYLYFXIVGSFQFNGLIKKJNJSKVLXNZQ[S[VZXX RQFOGMILKKNKSLVMXOZQ[ RXSX[ RYSY[ RUS\\S",
    2008: " 27F^KFK[ RLFL[ RXFX[ RYFY[ RHFOF RUF\\F RLPXP RH[O[ RU[\\[",
    2009: " 12MXRFR[ RSFS[ ROFVF RO[V[",
    2010: " 20KZUFUWTZR[P[NZMXMVNUOVNW RTFTWSZR[ RQFXF",
    2011: " 27F\\KFK[ RLFL[ RYFLS RQOY[ RPOX[ RHFOF RUF[F RH[O[ RU[[[",
    2012: " 14I[NFN[ ROFO[ RKFRF RK[Z[ZUY[",
    2013: " 30F_KFK[ RLFRX RKFR[ RYFR[ RYFY[ RZFZ[ RHFLF RYF]F RH[N[ RV[][",
    2014: " 21G^LFL[ RMFYY RMHY[ RYFY[ RIFMF RVF\\F RI[O[",
    2015: " 44G]QFNGLIKKJOJRKVLXNZQ[S[VZXXYVZRZOYKXIVGSFQF RQFOGMILKKOKRLVMXOZQ[ RS[UZWXXVYRYOXKWIUGSF",
    2016: " 29G]LFL[ RMFM[ RIFUFXGYHZJZMYOXPUQMQ RUFWGXHYJYMXOWPUQ RI[P[",
    2017: " 64G]QFNGLIKKJOJRKVLXNZQ[S[VZXXYVZRZOYKXIVGSFQF RQFOGMILKKOKRLVMXOZQ[ RS[UZWXXVYRYOXKWIUGSF RNYNXOVQURUTVUXV_W`Y`Z^Z] RUXV\\W^X_Y_Z^",
    2018: " 45G]LFL[ RMFM[ RIFUFXGYHZJZLYNXOUPMP RUFWGXHYJYLXNWOUP RI[P[ RRPTQURXYYZZZ[Y RTQUSWZX[Z[[Y[X",
    2019: " 34H\\XIYFYLXIVGSFPFMGKIKKLMMNOOUQWRYT RKKMMONUPWQXRYTYXWZT[Q[NZLXKUK[LX",
    2020: " 16I\\RFR[ RSFS[ RLFKLKFZFZLYF RO[V[",
    2021: " 23F^KFKULXNZQ[S[VZXXYUYF RLFLUMXOZQ[ RHFOF RVF\\F",
    2022: " 15H\\KFR[ RLFRX RYFR[ RIFOF RUF[F",
    2023: " 24F^JFN[ RKFNV RRFN[ RRFV[ RSFVV RZFV[ RGFNF RWF]F",
    2024: " 21H\\KFX[ RLFY[ RYFK[ RIFOF RUF[F RI[O[ RU[[[",
    2025: " 20H]KFRQR[ RLFSQS[ RZFSQ RIFOF RVF\\F RO[V[",
    2026: " 16H\\XFK[ RYFL[ RLFKLKFYF RK[Y[YUX[",
    2027: " 18H\\RFK[ RRFY[ RRIX[ RMUVU RI[O[ RU[[[",
    2028: " 45G]LFL[ RMFM[ RIFUFXGYHZJZLYNXOUP RUFWGXHYJYLXNWOUP RMPUPXQYRZTZWYYXZU[I[ RUPWQXRYTYWXYWZU[",
    2029: " 14I[NFN[ ROFO[ RKFZFZLYF RK[R[",
    2030: " 15H\\RFJ[ RRFZ[ RRIY[ RKZYZ RJ[Z[",
    2031: " 22G\\LFL[ RMFM[ RSLST RIFYFYLXF RMPSP RI[Y[YUX[",
    2032: " 16H\\XFK[ RYFL[ RLFKLKFYF RK[Y[YUX[",
    2033: " 27F^KFK[ RLFL[ RXFX[ RYFY[ RHFOF RUF\\F RLPXP RH[O[ RU[\\[",
    2034: " 56G]QFNGLIKKJOJRKVLXNZQ[S[VZXXYVZRZOYKXIVGSFQF RQFOGMILKKOKRLVMXOZQ[ RS[UZWXXVYRYOXKWIUGSF ROMOT RUMUT ROPUP ROQUQ",
    2035: " 12MXRFR[ RSFS[ ROFVF RO[V[",
    2036: " 27F\\KFK[ RLFL[ RYFLS RQOY[ RPOX[ RHFOF RUF[F RH[O[ RU[[[",
    2037: " 15H\\RFK[ RRFY[ RRIX[ RI[O[ RU[[[",
    2038: " 30F_KFK[ RLFRX RKFR[ RYFR[ RYFY[ RZFZ[ RHFLF RYF]F RH[N[ RV[][",
    2039: " 21G^LFL[ RMFYY RMHY[ RYFY[ RIFMF RVF\\F RI[O[",
    2040: " 36G]KEJJ RZEYJ RONNS RVNUS RKWJ\\ RZWY\\ RKGYG RKHYH ROPUP ROQUQ RKYYY RKZYZ",
    2041: " 44G]QFNGLIKKJOJRKVLXNZQ[S[VZXXYVZRZOYKXIVGSFQF RQFOGMILKKOKRLVMXOZQ[ RS[UZWXXVYRYOXKWIUGSF",
    2042: " 21F^KFK[ RLFL[ RXFX[ RYFY[ RHF\\F RH[O[ RU[\\[",
    2043: " 29G]LFL[ RMFM[ RIFUFXGYHZJZMYOXPUQMQ RUFWGXHYJYMXOWPUQ RI[P[",
    2044: " 20H]KFRPJ[ RJFQP RJFYFZLXF RKZXZ RJ[Y[ZUX[",
    2045: " 16I\\RFR[ RSFS[ RLFKLKFZFZLYF RO[V[",
    2046: " 33I\\KKKILGMFOFPGQIRMR[ RKIMGOGQI RZKZIYGXFVFUGTISMS[ RZIXGVGTI RO[V[",
    2047: " 48H]RFR[ RSFS[ RPKMLLMKOKRLTMUPVUVXUYTZRZOYMXLUKPK RPKNLMMLOLRMTNUPV RUVWUXTYRYOXMWLUK ROFVF RO[V[",
    2048: " 21H\\KFX[ RLFY[ RYFK[ RIFOF RUF[F RI[O[ RU[[[",
    2049: " 41G^RFR[ RSFS[ RIMJLLMMQNSOTQU RJLKMLQMSNTQUTUWTXSYQZM[L RTUVTWSXQYM[L\\M ROFVF RO[V[",
    2050: " 43G]JXK[O[MWKSJPJLKIMGPFTFWGYIZLZPYSWWU[Y[ZX RMWLTKPKLLINGPF RTFVGXIYLYPXTWW RKZNZ RVZYZ",
    2051: " 18H\\UFH[ RUFV[ RTHU[ RLUUU RF[L[ RR[X[",
    2052: " 41F^OFI[ RPFJ[ RLFWFZG[I[KZNYOVP RWFYGZIZKYNXOVP RMPVPXQYSYUXXVZR[F[ RVPWQXSXUWXUZR[",
    2053: " 34H]ZH[H\\F[L[JZHYGWFTFQGOIMLLOKSKVLYMZP[S[UZWXXV RTFRGPINLMOLSLVMYNZP[",
    2054: " 30F]OFI[ RPFJ[ RLFUFXGYHZKZOYSWWUYSZO[F[ RUFWGXHYKYOXSVWTYRZO[",
    2055: " 22F]OFI[ RPFJ[ RTLRT RLF[FZLZF RMPSP RF[U[WVT[",
    2056: " 20F\\OFI[ RPFJ[ RTLRT RLF[FZLZF RMPSP RF[M[",
    2057: " 42H^ZH[H\\F[L[JZHYGWFTFQGOIMLLOKSKVLYMZP[R[UZWXYT RTFRGPINLMOLSLVMYNZP[ RR[TZVXXT RUT\\T",
    2058: " 27E_NFH[ ROFI[ R[FU[ R\\FV[ RKFRF RXF_F RLPXP RE[L[ RR[Y[",
    2059: " 12LYUFO[ RVFP[ RRFYF RL[S[",
    2060: " 21I[XFSWRYQZO[M[KZJXJVKULVKW RWFRWQYO[ RTF[F",
    2061: " 27F]OFI[ RPFJ[ R]FLS RSOW[ RROV[ RLFSF RYF_F RF[M[ RS[Y[",
    2062: " 14H\\QFK[ RRFL[ RNFUF RH[W[YUV[",
    2063: " 30E`NFH[ RNFO[ ROFPY R\\FO[ R\\FV[ R]FW[ RKFOF R\\F`F RE[K[ RS[Z[",
    2064: " 21F_OFI[ ROFVX ROIV[ R\\FV[ RLFOF RYF_F RF[L[",
    2065: " 42G]SFPGNILLKOJSJVKYLZN[Q[TZVXXUYRZNZKYHXGVFSF RSFQGOIMLLOKSKVLYN[ RQ[SZUXWUXRYNYKXHVF",
    2066: " 27F]OFI[ RPFJ[ RLFXF[G\\I\\K[NYPUQMQ RXFZG[I[KZNXPUQ RF[M[",
    2067: " 61G]SFPGNILLKOJSJVKYLZN[Q[TZVXXUYRZNZKYHXGVFSF RSFQGOIMLLOKSKVLYN[ RQ[SZUXWUXRYNYKXHVF RLYLXMVOUPURVSXS_T`V`W^W] RSXT^U_V_W^",
    2068: " 42F^OFI[ RPFJ[ RLFWFZG[I[KZNYOVPMP RWFYGZIZKYNXOVP RRPTQURVZW[Y[ZYZX RURWYXZYZZY RF[M[",
    2069: " 35G^ZH[H\\F[L[JZHYGVFRFOGMIMKNMONVRXT RMKOMVQWRXTXWWYVZS[O[LZKYJWJUI[JYKY",
    2070: " 16H]UFO[ RVFP[ ROFLLNF]F\\L\\F RL[S[",
    2071: " 25F_NFKQJUJXKZN[R[UZWXXU\\F ROFLQKUKXLZN[ RKFRF RYF_F",
    2072: " 15H\\NFO[ ROFPY R\\FO[ RLFRF RXF^F",
    2073: " 24E_MFK[ RNFLY RUFK[ RUFS[ RVFTY R]FS[ RJFQF RZF`F",
    2074: " 21G]NFU[ ROFV[ R\\FH[ RLFRF RXF^F RF[L[ RR[X[",
    2075: " 20H]NFRPO[ ROFSPP[ R]FSP RLFRF RYF_F RL[S[",
    2076: " 16G][FH[ R\\FI[ ROFLLNF\\F RH[V[XUU[",
    2077: " 46H\\KILKXWYYY[ RLLXX RKIKKLMXYY[ RPPLTKVKXLZK[ RKVMZ RLTLVMXMZK[ RSSXN RVIVLWNYNYLWKVI RVIWLYN",
    2101: " 39I]NONPMPMONNPMTMVNWOXQXXYZZ[ RWOWXXZZ[[[ RWQVRPSMTLVLXMZP[S[UZWX RPSNTMVMXNZP[",
    2102: " 33G\\LFL[ RMFM[ RMPONQMSMVNXPYSYUXXVZS[Q[OZMX RSMUNWPXSXUWXUZS[ RIFMF",
    2103: " 28H[WPVQWRXQXPVNTMQMNNLPKSKULXNZQ[S[VZXX RQMONMPLSLUMXOZQ[",
    2104: " 36H]WFW[ RXFX[ RWPUNSMQMNNLPKSKULXNZQ[S[UZWX RQMONMPLSLUMXOZQ[ RTFXF RW[[[",
    2105: " 31H[LSXSXQWOVNTMQMNNLPKSKULXNZQ[S[VZXX RWSWPVN RQMONMPLSLUMXOZQ[",
    2106: " 22KXUGTHUIVHVGUFSFQGPIP[ RSFRGQIQ[ RMMUM RM[T[",
    2107: " 60I\\QMONNOMQMSNUOVQWSWUVVUWSWQVOUNSMQM RONNPNTOV RUVVTVPUN RVOWNYMYNWN RNUMVLXLYM[P\\U\\X]Y^ RLYMZP[U[X\\Y^Y_XaUbObLaK_K^L\\O[",
    2108: " 28G]LFL[ RMFM[ RMPONRMTMWNXPX[ RTMVNWPW[ RIFMF RI[P[ RT[[[",
    2109: " 18MXRFQGRHSGRF RRMR[ RSMS[ ROMSM RO[V[",
    2110: " 25MXSFRGSHTGSF RTMT_SaQbObNaN`O_P`Oa RSMS_RaQb RPMTM",
    2111: " 27G\\LFL[ RMFM[ RWMMW RRSX[ RQSW[ RIFMF RTMZM RI[P[ RT[Z[",
    2112: " 12MXRFR[ RSFS[ ROFSF RO[V[",
    2113: " 44BcGMG[ RHMH[ RHPJNMMOMRNSPS[ ROMQNRPR[ RSPUNXMZM]N^P^[ RZM\\N]P][ RDMHM RD[K[ RO[V[ RZ[a[",
    2114: " 28G]LML[ RMMM[ RMPONRMTMWNXPX[ RTMVNWPW[ RIMMM RI[P[ RT[[[",
    2115: " 36H\\QMNNLPKSKULXNZQ[S[VZXXYUYSXPVNSMQM RQMONMPLSLUMXOZQ[ RS[UZWXXUXSWPUNSM",
    2116: " 36G\\LMLb RMMMb RMPONQMSMVNXPYSYUXXVZS[Q[OZMX RSMUNWPXSXUWXUZS[ RIMMM RIbPb",
    2117: " 33H\\WMWb RXMXb RWPUNSMQMNNLPKSKULXNZQ[S[UZWX RQMONMPLSLUMXOZQ[ RTb[b",
    2118: " 23IZNMN[ ROMO[ ROSPPRNTMWMXNXOWPVOWN RKMOM RK[R[",
    2119: " 32J[WOXMXQWOVNTMPMNNMOMQNRPSUUWVXW RMPNQPRUTWUXVXYWZU[Q[OZNYMWM[NY",
    2120: " 16KZPFPWQZS[U[WZXX RQFQWRZS[ RMMUM",
    2121: " 28G]LMLXMZP[R[UZWX RMMMXNZP[ RWMW[ RXMX[ RIMMM RTMXM RW[[[",
    2122: " 15I[LMR[ RMMRY RXMR[ RJMPM RTMZM",
    2123: " 24F^JMN[ RKMNX RRMN[ RRMV[ RSMVX RZMV[ RGMNM RWM]M",
    2124: " 21H\\LMW[ RMMX[ RXML[ RJMPM RTMZM RJ[P[ RT[Z[",
    2125: " 22H[LMR[ RMMRY RXMR[P_NaLbKbJaK`La RJMPM RTMZM",
    2126: " 16I[WML[ RXMM[ RMMLQLMXM RL[X[XWW[",
    2127: " 40G^QMNNLPKRJUJXKZN[P[RZUWWTYPZM RQMONMPLRKUKXLZN[ RQMSMUNVPXXYZZ[ RSMTNUPWXXZZ[[[",
    2128: " 57G\\TFQGOIMMLPKTJZIb RTFRGPINMMPLTKZJb RTFVFXGYHYKXMWNTOPO RVFXHXKWMVNTO RPOTPVRWTWWVYUZR[P[NZMYLV RPOSPURVTVWUYTZR[",
    2129: " 28H\\IPKNMMOMQNROSRSVRZOb RJOLNPNRO RZMYPXRSYP^Nb RYMXPWRSY",
    2130: " 44I\\VNTMRMONMQLTLWMYNZP[R[UZWWXTXQWOSJRHRFSEUEWFYH RRMPNNQMTMXNZ RR[TZVWWTWPVNTKSISGTFVFYH",
    2131: " 32I[XPVNTMPMNNNPPRSS RPMONOPQRSS RSSNTLVLXMZP[S[UZWX RSSOTMVMXNZP[",
    2132: " 31I[TFRGQHQIRJUKZKZJWKSMPOMRLULWMYP[S]T_TaSbQbPa RULQONRMUMWNYP[",
    2133: " 32G]HQIOKMNMONOPNTL[ RMMNNNPMTK[ RNTPPRNTMVMXNYOYRXWUb RVMXOXRWWTb",
    2134: " 44F]GQHOJMMMNNNPMUMXNZO[ RLMMNMPLULXMZO[Q[SZUXWUXRYMYIXGVFTFRHRJSMUPWRZT RSZUWVUWRXMXIWGVF",
    2135: " 15LXRMPTOXOZP[S[UYVW RSMQTPXPZQ[",
    2136: " 29H\\NMJ[ ROMK[ RXMYNZNYMWMUNQROSMS ROSQTSZT[ ROSPTRZS[U[WZYW",
    2137: " 23H\\KFMFOGPHQJWXXZY[ RMFOHPJVXWZY[Z[ RRMJ[ RRMK[",
    2138: " 28F]MMGb RNMHb RMPLVLYN[P[RZTXVU RXMUXUZV[Y[[Y\\W RYMVXVZW[",
    2139: " 24H\\NML[ ROMNSMXL[ RYMXQVU RZMYPXRVUTWQYOZL[ RKMOM",
    2140: " 45IZTFRGQHQIRJUKXK RUKQLOMNONQPSSTVT RUKRLPMOOOQQSST RSTOUMVLXLZN\\S^T_TaRbPb RSTPUNVMXMZO\\S^",
    2141: " 32I[RMONMQLTLWMYNZP[R[UZWWXTXQWOVNTMRM RRMPNNQMTMXNZ RR[TZVWWTWPVN",
    2142: " 22G]PNL[ RPNM[ RVNV[ RVNW[ RIPKNNM[M RIPKONN[N",
    2143: " 31H[LVMYNZP[R[UZWWXTXQWOVNTMRMONMQLTHb RR[TZVWWTWPVN RRMPNNQMTIb",
    2144: " 35H][MQMNNLQKTKWLYMZO[Q[TZVWWTWQVOUNSM RQMONMQLTLXMZ RQ[SZUWVTVPUN RUN[N",
    2145: " 16H\\SNP[ RSNQ[ RJPLNOMZM RJPLOONZN",
    2146: " 31H\\IQJOLMOMPNPPNVNYP[ RNMONOPMVMYNZP[Q[TZVXXUYRYOXMWNXOYR RXUYO",
    2147: " 37G]ONMOKQJTJWKYLZN[Q[TZWXYUZRZOXMVMTORSPXMb RJWLYNZQZTYWWYU RZOXNVNTPRSPYNb",
    2148: " 23I[KMMMONPPU_VaWb RMMNNOPT_UaWbYb RZMYOWRM]K`Jb",
    2149: " 34F]UFOb RVFNb RGQHOJMMMNNNPMUMXOZRZTYWVYS RLMMNMPLULXMZO[R[TZVXXUYS[M",
    2150: " 44F]JQLOONNMLNJQITIWJZK[M[OZQWRT RIWJYKZMZOYQW RQTQWRZS[U[WZYWZTZQYNXMWNYOZQ RQWRYSZUZWYYW",
    2151: " 39H]XMVTUXUZV[Y[[Y\\W RYMWTVXVZW[ RVTVQUNSMQMNNLQKTKWLYMZO[Q[SZUWVT RQMONMQLTLXMZ",
    2152: " 36H[PFLSLVMYNZ RQFMS RMSNPPNRMTMVNWOXQXTWWUZR[P[NZMWMS RVNWPWTVWTZR[ RMFQF",
    2153: " 25I[WPWQXQXPWNUMRMONMQLTLWMYNZP[R[UZWW RRMPNNQMTMXNZ",
    2154: " 42H]ZFVTUXUZV[Y[[Y\\W R[FWTVXVZW[ RVTVQUNSMQMNNLQKTKWLYMZO[Q[SZUWVT RQMONMQLTLXMZ RWF[F",
    2155: " 26I[MVQUTTWRXPWNUMRMONMQLTLWMYNZP[R[UZWX RRMPNNQMTMXNZ",
    2156: " 35KZZGYHZI[H[GZFXFVGUHTJSMP[O_Na RXFVHUJTNRWQ[P^O`NaLbJbIaI`J_K`Ja ROMYM",
    2157: " 43H\\YMU[T^RaObLbJaI`I_J^K_J` RXMT[S^QaOb RVTVQUNSMQMNNLQKTKWLYMZO[Q[SZUWVT RQMONMQLTLXMZ",
    2158: " 31H]PFJ[ RQFK[ RMTOPQNSMUMWNXOXQVWVZW[ RUMWOWQUWUZV[Y[[Y\\W RMFQF",
    2159: " 26LYUFTGUHVGUF RMQNOPMSMTNTQRWRZS[ RRMSNSQQWQZR[U[WYXW",
    2160: " 32LYVFUGVHWGVF RNQOOQMTMUNUQR[Q^P`OaMbKbJaJ`K_L`Ka RSMTNTQQ[P^O`Mb",
    2161: " 34H\\PFJ[ RQFK[ RXNWOXPYOYNXMWMUNQROSMS ROSQTSZT[ ROSPTRZS[U[WZYW RMFQF",
    2162: " 18MYUFQTPXPZQ[T[VYWW RVFRTQXQZR[ RRFVF",
    2163: " 52AbBQCOEMHMINIPHTF[ RGMHNHPGTE[ RHTJPLNNMPMRNSOSQP[ RPMRORQO[ RRTTPVNXMZM\\N]O]Q[W[Z\\[ RZM\\O\\QZWZZ[[^[`YaW",
    2164: " 37F]GQHOJMMMNNNPMTK[ RLMMNMPLTJ[ RMTOPQNSMUMWNXOXQVWVZW[ RUMWOWQUWUZV[Y[[Y\\W",
    2165: " 32I[RMONMQLTLWMYNZP[R[UZWWXTXQWOVNTMRM RRMPNNQMTMXNZ RR[TZVWWTWPVN",
    2166: " 42G\\HQIOKMNMONOPNTJb RMMNNNPMTIb RNTOQQNSMUMWNXOYQYTXWVZS[Q[OZNWNT RWNXPXTWWUZS[ RFbMb",
    2167: " 33H\\XMRb RYMSb RVTVQUNSMQMNNLQKTKWLYMZO[Q[SZUWVT RQMONMQLTLXMZ RObVb",
    2168: " 26IZJQKOMMPMQNQPPTN[ ROMPNPPOTM[ RPTRPTNVMXMYNYOXPWOXN",
    2169: " 28J[XOXPYPYOXNUMRMONNONQORVVWW RNPOQVUWVWYVZS[P[MZLYLXMXMY",
    2170: " 18KYTFPTOXOZP[S[UYVW RUFQTPXPZQ[ RNMWM",
    2171: " 37F]GQHOJMMMNNNQLWLYN[ RLMMNMQKWKYLZN[P[RZTXVT RXMVTUXUZV[Y[[Y\\W RYMWTVXVZW[",
    2172: " 26H\\IQJOLMOMPNPQNWNYP[ RNMONOQMWMYNZP[Q[TZVXXUYQYMXMYO",
    2173: " 41C`DQEOGMJMKNKQIWIYK[ RIMJNJQHWHYIZK[M[OZQXRV RTMRVRYSZU[W[YZ[X\\V]R]M\\M]O RUMSVSYU[",
    2174: " 42H\\KQMNOMRMSOSR RQMRORRQVPXNZL[K[JZJYKXLYKZ RQVQYR[U[WZYW RYNXOYPZOZNYMXMVNTPSRRVRYS[",
    2175: " 41G\\HQIOKMNMONOQMWMYO[ RMMNNNQLWLYMZO[Q[SZUXWT RZMV[U^SaPbMbKaJ`J_K^L_K` RYMU[T^RaPb",
    2176: " 31H\\YMXOVQNWLYK[ RLQMOOMRMVO RMOONRNVOXO RLYNYRZUZWY RNYR[U[WYXW",
    2177: " 43G^VGUHVIWHWGUFRFOGMILLL[ RRFPGNIMLM[ R\\G[H\\I]H]G\\FZFXGWIW[ RZFYGXIX[ RIM[M RI[P[ RT[[[",
    2178: " 33G]WGVHWIXHWGUFRFOGMILLL[ RRFPGNIMLM[ RWMW[ RXMX[ RIMXM RI[P[ RT[[[",
    2179: " 35G]VGUHVIWHWGUF RXFRFOGMILLL[ RRFPGNIMLM[ RWHW[ RXFX[ RIMWM RI[P[ RT[[[",
    2180: " 54BcRGQHRISHRGPFMFJGHIGLG[ RMFKGIIHLH[ R]G\\H]I^H]G[FXFUGSIRLR[ RXFVGTISLS[ R]M][ R^M^[ RDM^M RD[K[ RO[V[ RZ[a[",
    2181: " 56BcRGQHRISHRGPFMFJGHIGLG[ RMFKGIIHLH[ R\\G[H\\I]H]G[F R^FXFUGSIRLR[ RXFVGTISLS[ R]H][ R^F^[ RDM]M RD[K[ RO[V[ RZ[a[",
    2182: " 12MXRMR[ RSMS[ ROMSM RO[V[",
    2184: " 25IZWNUMRMONMPLSLVMYNZQ[T[VZ RRMPNNPMSMVNYOZQ[ RMTUT",
    2185: " 43I\\TFQGOJNLMOLTLXMZO[Q[TZVWWUXRYMYIXGVFTF RTFRGPJOLNOMTMXNZO[ RQ[SZUWVUWRXMXIWGVF RNPWP",
    2186: " 42G]UFOb RVFNb RQMMNKPJSJVKXMZP[S[WZYXZUZRYPWNTMQM RQMNNLPKSKVLXNZP[ RS[VZXXYUYRXPVNTM",
    2187: " 27I[TMVNXPXOWNTMQMNNMOLQLSMUOWSZ RQMONNOMQMSNUSZT\\T^S_Q_",
    2190: " 45G]LMKNJPJRKUOYP[ RJRKTOXP[P]O`MbLbKaJ_J\\KXMTOQRNTMVMYNZPZTYXWZU[T[SZSXTWUXTY RVMXNYPYTXXWZ",
    2191: " 69E_YGXHYIZHYGWFTFQGOINKMNLRJ[I_Ha RTFRGPIOKNNLWK[J^I`HaFbDbCaC`D_E`Da R_G^H_I`H`G_F]F[GZHYJXMU[T_Sa R]F[HZJYNWWV[U^T`SaQbObNaN`O_P`Oa RIM^M",
    2192: " 52F^[GZH[I\\H[GXFUFRGPIOKNNMRK[J_Ia RUFSGQIPKONMWL[K^J`IaGbEbDaD`E_F`Ea RYMWTVXVZW[Z[\\Y]W RZMXTWXWZX[ RJMZM",
    2193: " 54F^YGXHYIZHZGXF R\\FUFRGPIOKNNMRK[J_Ia RUFSGQIPKONMWL[K^J`IaGbEbDaD`E_F`Ea R[FWTVXVZW[Z[\\Y]W R\\FXTWXWZX[ RJMYM",
    2194: " 86@cTGSHTIUHTGRFOFLGJIIKHNGRE[D_Ca ROFMGKIJKINGWF[E^D`CaAb?b>a>`?_@`?a R`G_H`IaH`G]FZFWGUITKSNRRP[O_Na RZFXGVIUKTNRWQ[P^O`NaLbJbIaI`J_K`Ja R^M\\T[X[Z\\[_[aYbW R_M]T\\X\\Z][ RDM_M",
    2195: " 88@cTGSHTIUHTGRFOFLGJIIKHNGRE[D_Ca ROFMGKIJKINGWF[E^D`CaAb?b>a>`?_@`?a R^G]H^I_H_G]F RaFZFWGUITKSNRRP[O_Na RZFXGVIUKTNRWQ[P^O`NaLbJbIaI`J_K`Ja R`F\\T[X[Z\\[_[aYbW RaF]T\\X\\Z][ RDM^M",
    2196: " 20LYMQNOPMSMTNTQRWRZS[ RRMSNSQQWQZR[U[WYXW",
    2200: " 40H\\QFNGLJKOKRLWNZQ[S[VZXWYRYOXJVGSFQF RQFOGNHMJLOLRMWNYOZQ[ RS[UZVYWWXRXOWJVHUGSF",
    2201: " 11H\\NJPISFS[ RRGR[ RN[W[",
    2202: " 45H\\LJMKLLKKKJLHMGPFTFWGXHYJYLXNUPPRNSLUKXK[ RTFVGWHXJXLWNTPPR RKYLXNXSZVZXYYX RNXS[W[XZYXYV",
    2203: " 47H\\LJMKLLKKKJLHMGPFTFWGXIXLWNTOQO RTFVGWIWLVNTO RTOVPXRYTYWXYWZT[P[MZLYKWKVLUMVLW RWQXTXWWYVZT[",
    2204: " 13H\\THT[ RUFU[ RUFJUZU RQ[X[",
    2205: " 39H\\MFKP RKPMNPMSMVNXPYSYUXXVZS[P[MZLYKWKVLUMVLW RSMUNWPXSXUWXUZS[ RMFWF RMGRGWF",
    2206: " 48H\\WIVJWKXJXIWGUFRFOGMILKKOKULXNZQ[S[VZXXYUYTXQVOSNRNOOMQLT RRFPGNIMKLOLUMXOZQ[ RS[UZWXXUXTWQUOSN",
    2207: " 31H\\KFKL RKJLHNFPFUIWIXHYF RLHNGPGUI RYFYIXLTQSSRVR[ RXLSQRSQVQ[",
    2208: " 63H\\PFMGLILLMNPOTOWNXLXIWGTFPF RPFNGMIMLNNPO RTOVNWLWIVGTF RPOMPLQKSKWLYMZP[T[WZXYYWYSXQWPTO RPONPMQLSLWMYNZP[ RT[VZWYXWXSWQVPTO",
    2209: " 48H\\XMWPURRSQSNRLPKMKLLINGQFSFVGXIYLYRXVWXUZR[O[MZLXLWMVNWMX RQSORMPLMLLMIOGQF RSFUGWIXLXRWVVXTZR[",
    2210: "  6MWRYQZR[SZRY",
    2211: "  8MWR[QZRYSZS\\R^Q_",
    2212: " 12MWRMQNROSNRM RRYQZR[SZRY",
    2213: " 14MWRMQNROSNRM RR[QZRYSZS\\R^Q_",
    2214: " 15MWRFQHRTSHRF RRHRN RRYQZR[SZRY",
    2215: " 32I[MJNKMLLKLJMHNGPFSFVGWHXJXLWNVORQRT RSFUGVHWJWLVNTP RRYQZR[SZRY",
    2216: "  6NVRFQM RSFQM",
    2217: " 12JZNFMM ROFMM RVFUM RWFUM",
    2218: " 14KYQFOGNINKOMQNSNUMVKVIUGSFQF",
    2219: "  9JZRFRR RMIWO RWIMO",
    2220: "  3G][BIb",
    2221: " 20KYVBTDRGPKOPOTPYR]T`Vb RTDRHQKPPPTQYR\\T`",
    2222: " 20KYNBPDRGTKUPUTTYR]P`Nb RPDRHSKTPTTSYR\\P`",
    2223: " 12KYOBOb RPBPb ROBVB RObVb",
    2224: " 12KYTBTb RUBUb RNBUB RNbUb",
    2225: " 40KYTBRCQDPFPHQJRKSMSOQQ RRCQEQGRISJTLTNSPORSTTVTXSZR[Q]Q_Ra RQSSUSWRYQZP\\P^Q`RaTb",
    2226: " 40KYPBRCSDTFTHSJRKQMQOSQ RRCSESGRIQJPLPNQPURQTPVPXQZR[S]S_Ra RSSQUQWRYSZT\\T^S`RaPb",
    2227: "  4KYUBNRUb",
    2228: "  4KYOBVROb",
    2229: "  3NVRBRb",
    2230: "  6KYOBOb RUBUb",
    2231: "  3E_IR[R",
    2232: "  6E_RIR[ RIR[R",
    2233: "  9F^RJR[ RJRZR RJ[Z[",
    2234: "  9F^RJR[ RJJZJ RJRZR",
    2235: "  6G]KKYY RYKKY",
    2236: "  6MWRQQRRSSRRQ",
    2237: " 15E_RIQJRKSJRI RIR[R RRYQZR[SZRY",
    2238: "  6E_IO[O RIU[U",
    2239: "  9E_YIK[ RIO[O RIU[U",
    2240: "  9E_IM[M RIR[R RIW[W",
    2241: "  4F^ZIJRZ[",
    2242: "  4F^JIZRJ[",
    2243: " 10F^ZFJMZT RJVZV RJ[Z[",
    2244: " 10F^JFZMJT RJVZV RJ[Z[",
    2245: " 21F_[WYWWVUTRPQOONMNKOJQJSKUMVOVQURTUPWNYM[M",
    2246: " 24F^IUISJPLONOPPTSVTXTZS[Q RISJQLPNPPQTTVUXUZT[Q[O",
    2247: "  8G]JTROZT RJTRPZT",
    2248: "  7LXTFOL RTFUGOL",
    2249: "  7LXPFUL RPFOGUL",
    2250: " 18H\\KFLHNJQKSKVJXHYF RKFLINKQLSLVKXIYF",
    2251: "  8MWRHQGRFSGSIRKQL",
    2252: "  8MWSFRGQIQKRLSKRJ",
    2253: "  8MWRHSGRFQGQIRKSL",
    2254: "  8MWQFRGSISKRLQKRJ",
    2255: " 10E[HMLMRY RKMR[ R[BR[",
    2256: " 13F^ZJSJOKMLKNJQJSKVMXOYSZZZ",
    2257: " 13F^JJJQKULWNYQZSZVYXWYUZQZJ",
    2258: " 13F^JJQJUKWLYNZQZSYVWXUYQZJZ",
    2259: " 13F^JZJSKOLMNKQJSJVKXMYOZSZZ",
    2260: " 16F^ZJSJOKMLKNJQJSKVMXOYSZZZ RJRVR",
    2261: " 11E_XP[RXT RUMZRUW RIRZR",
    2262: " 11JZPLRITL RMORJWO RRJR[",
    2263: " 11E_LPIRLT ROMJROW RJR[R",
    2264: " 11JZPXR[TX RMURZWU RRIRZ",
    2265: " 44I\\XRWOVNTMRMONMQLTLWMYNZP[R[UZWXXUYPYKXHWGUFRFPGOHOIPIPH RRMPNNQMTMXNZ RR[TZVXWUXPXKWHUF",
    2266: " 15H\\JFR[ RKFRY RZFR[ RJFZF RKGYG",
    2267: " 10AbDMIMRY RHNR[ Rb:R[",
    2268: " 32F^[CZD[E\\D\\C[BYBWCUETGSJRNPZO^N` RVDUFTJRVQZP]O_MaKbIbHaH`I_J`Ia",
    2269: " 50F^[CZD[E\\D\\C[BYBWCUETGSJRNPZO^N` RVDUFTJRVQZP]O_MaKbIbHaH`I_J`Ia RQKNLLNKQKSLVNXQYSYVXXVYSYQXNVLSKQK",
    2270: " 26F_\\S[UYVWVUUTTQPPONNLNJOIQISJULVNVPUQTTPUOWNYN[O\\Q\\S",
    2271: " 32F^[FI[ RNFPHPJOLMMKMIKIIJGLFNFPGSHVHYG[F RWTUUTWTYV[X[ZZ[X[VYTWT",
    2272: " 49F_[NZO[P\\O\\N[MZMYNXPVUTXRZP[M[JZIXIUJSPORMSKSIRGPFNGMIMKNNPQUXWZZ[[[\\Z\\Y RM[KZJXJUKSMQ RMKNMVXXZZ[",
    2273: " 56E`WNVLTKQKOLNMMPMSNUPVSVUUVS RQKOMNPNSOUPV RWKVSVUXVZV\\T]Q]O\\L[JYHWGTFQFNGLHJJILHOHRIUJWLYNZQ[T[WZYYZX RXKWSWUXV",
    2274: " 42H\\PBP_ RTBT_ RXIWJXKYJYIWGTFPFMGKIKKLMMNOOUQWRYT RKKMMONUPWQXRYTYXWZT[P[MZKXKWLVMWLX",
    2275: " 12H]SFLb RYFRb RLQZQ RKWYW",
    2276: " 46JZUITJUKVJVIUGSFQFOGNINKOMQOVR ROMTPVRWTWVVXTZ RPNNPMRMTNVPXU[ RNVSYU[V]V_UaSbQbOaN_N^O]P^O_",
    2277: " 30JZRFQHRJSHRF RRFRb RRQQTRbSTRQ RLMNNPMNLLM RLMXM RTMVNXMVLTM",
    2278: " 56JZRFQHRJSHRF RRFRT RRPQRSVRXQVSRRP RRTRb RR^Q`RbS`R^ RLMNNPMNLLM RLMXM RTMVNXMVLTM RL[N\\P[NZL[ RL[X[ RT[V\\X[VZT[",
    2279: " 12I\\XFX[ RKFXF RPPXP RK[X[",
    2281: " 38E`QFNGKIILHOHRIUKXNZQ[T[WZZX\\U]R]O\\LZIWGTFQF RROQPQQRRSRTQTPSORO RRPRQSQSPRP",
    2282: " 45J[PFNGOIQJ RPFOGOI RUFWGVITJ RUFVGVI RQJOKNLMNMQNSOTQUTUVTWSXQXNWLVKTJQJ RRUR[ RSUS[ RNXWX",
    2283: " 27I\\RFOGMILLLMMPORRSSSVRXPYMYLXIVGSFRF RRSR[ RSSS[ RNWWW",
    2284: " 28D`PFMGJIHLGOGSHVJYM[P\\T\\W[ZY\\V]S]O\\LZIWGTFPF RRFR\\ RGQ]Q",
    2285: " 31G`PMMNKPJSJTKWMYPZQZTYVWWTWSVPTNQMPM R]GWG[HUN R]G]M\\IVO R\\HVN",
    2286: " 28F\\IIJGLFOFQGRIRLQOPQNSKU ROFPGQIQMPPNS RVFT[ RWFS[ RKUYU",
    2287: " 30I\\MFMU RNFMQ RMQNOONQMTMWNXPXRWTUV RTMVNWPWRTXTZU[W[YY RKFNF",
    2288: " 44I\\RNOOMQLTLUMXOZR[S[VZXXYUYTXQVOSNRN RRHNJRFRN RSHWJSFSN RRSQTQURVSVTUTTSSRS RRTRUSUSTRT",
    2289: " 37G^QHRFR[ RTHSFS[ RJHKFKMLPNRQSRS RMHLFLNMQ R[HZFZMYPWRTSSS RXHYFYNXQ RNWWW",
    2290: " 31G]LFL[ RMFM[ RIFUFXGYHZJZMYOXPUQMQ RUFWGXHYJYMXOWPUQ RI[Y[YVX[",
    2291: " 24H[YGUGQHNJLMKPKSLVNYQ[U\\Y\\ RYGVHSJQMPPPSQVSYV[Y\\",
    2292: " 27F_OQMQKRJSIUIWJYKZM[O[QZRYSWSURSQROQ RSHPQ RZJRR R\\QST",
    2293: " 12H\\OKUY RUKOY RKOYU RYOKU",
    2294: " 48F^NVLUKUIVHXHYI[K\\L\\N[OYOXNVKRJOJMKJMHPGTGWHYJZMZOYRVVUXUYV[X\\Y\\[[\\Y\\X[VYUXUVV RJMKKMIPHTHWIYKZM",
    2295: " 48F^NMLNKNIMHKHJIHKGLGNHOJOKNMKQJTJVKYM[P\\T\\W[YYZVZTYQVMUKUJVHXGYG[H\\J\\K[MYNXNVM RJVKXMZP[T[WZYXZV",
    2301: " 40F_JMILIJJHLGNGPHQIRKSP RIJKHMHOIPJQLRPR[ R[M\\L\\J[HYGWGUHTISKRP R\\JZHXHVIUJTLSPS[",
    2302: " 51F^IGJKKMMOPPTPWOYMZK[G RIGJJKLMNPOTOWNYLZJ[G RPONPMQLSLVMXOZQ[S[UZWXXVXSWQVPTO RPPNQMSMVNY RVYWVWSVQTP",
    2303: " 30F^MJMV RNKNU RVKVU RWJWV RIGKIMJPKTKWJYI[G RIYKWMVPUTUWVYW[Y",
    2304: " 48F^[ILIJJILINJPLQNQPPQNQLPJ[J RIMJOKPMQ RQMPKOJMI RIXXXZW[U[SZQXPVPTQSSSUTWIW R[TZRYQWP RSTTVUWWX",
    2305: " 48F]OUMTLTJUIWIXJZL[M[OZPXPWOUJPINIKJILHOGSGWHYJZLZOYRVUUWUYV[X[YZZX RMSKPJNJKKILH RSGVHXJYLYOXRVU",
    2306: " 48G_HKKHMKMV RJILLLV RMKPHRKRU ROIQLQU RRKUHWKW[ RTIVLV[ RWKZH[J\\M\\P[SZUXWUYP[ RYIZJ[M[PZSYUWWTYP[",
    2307: " 41F^ISMSLRKOKMLJNHQGSGVHXJYMYOXRWS[S RITOTMRLOLMMJOHQG RSGUHWJXMXOWRUT[T RKXYX RKYYY",
    2308: " 30F_GLJIMLMX RIJLMLX RMLPISLSX ROJRMRX RSLVIYLYW[Y RUJXMXXZZ]W",
    2309: " 33G]ZIJY RZIWJQJ RXKUKQJ RZIYLYR RXKXNYR RQRJR RPSMSJR RQRQY RPSPVQY",
    2310: " 33F^HOJKOU RJMOWRPWPZO[M[KZIXHWHUITKTMUPVRWUWXUZ RWHVIUKUMWQXTXWWYUZ",
    2311: " 36F^IOLLPN RKMOORLUN RQMTOWLYN RVMXO[L RIULRPT RKSOURRUT RQSTUWRYT RVSXU[R",
    2312: " 48F^JHNJPLQOQRPUNWJY RJHMIOJQLRO RRRQUOWMXJY RZHWIUJSLRO RRRSUUWWXZY RZHVJTLSOSRTUVWZY RIP[P RIQ[Q",
    2317: " 12NVQQQSSSSQQQ RQQSS RSQQS",
    2318: " 18JZMPQRTTVVWYW[V]U^ RMQST RMRPSTUVWWY",
    2319: " 18JZWKVMTOPQMR RSPMS RUFVGWIWKVNTPQRMT",
    2320: " 36H\\SMONLPKRKTLVNWQWUVXTYRYPXNVMSM RXNSM RVMQNLP RONKR RLVQW RNWSVXT RUVYR",
    2321: " 36H\\SMONLPKRKTLVNWQWUVXTYRYPXNVMSM RXNSM RVMQNLP RONKR RLVQW RNWSVXT RUVYR",
    2322: " 34J[SMPNNPMRMTNVPWRWUVWTXRXPWNUMSM ROPUM RNRVN RMTWO RNUXP ROVWR RPWVT",
    2323: " 18JZOGO^ RUFU] RMNWL RMOWM RMWWU RMXWV",
    2324: " 18JZNFNX RVLV^ RNNVL RNOVM RNWVU RNXVV",
    2325: " 25JZNBNW RNNQLTLVMWOWQVSSUQVNW RNNQMTMVN RUMVOVQUSSU",
    2326: " 18E_HIHL R\\I\\L RHI\\I RHJ\\J RHK\\K RHL\\L",
    2327: " 18JZMNMQ RWNWQ RMNWN RMOWO RMPWP RMQWQ",
    2328: " 49JZMLWX RMLONQOTOVNWMWKUKUMTO RONTO RQOWM RVKVN RULWL RWXUVSUPUNVMWMYOYOWPU RUVPU RSUMW RNVNY RMXOX",
    2329: " 26JZPOOMOKMKMMNNPOSOUNWL RNKNN RMLOL RMMSO RPOUN RWLWY",
    2330: " 86A^GfHfIeIdHcGcFdFfGhIiKiNhPfQdR`RUQ;Q4R/S-U,V,X-Y/Y3X6W8U;P?JCHEFHEJDNDREVGYJ[N\\R\\V[XZZW[T[PZMYKWITHPHMIKKJNJRKUMW RGdGeHeHdGd RU;Q?LCIFGIFKENERFVGXJ[ RR\\U[WZYWZTZPYMXKVITH",
    2331: "103EfNSOUQVSVUUVSVQUOSNQNOONPMSMVNYP[S\\V\\Y[[Y\\W]T]P\\MZJXIUHRHOIMJKLIOHSHXI]KaMcPeTfYf]e`cba RKLJNIRIXJ\\L`NbQdUeYe]d_cba RPOTO ROPUP RNQVQ RNRVR RNSVS ROTUT RPUTU RaLaNcNcLaL RbLbN RaMcM RaVaXcXcVaV RbVbX RaWcW",
    2332: " 30D`H@Hd RM@Md RW@Wd R\\@\\d RMMWK RMNWL RMOWM RMWWU RMXWV RMYWW",
    2367: " 12NVQQQSSSSQQQ RQQSS RSQQS",
    2368: " 18JZMPQRTTVVWYW[V]U^ RMQST RMRPSTUVWWY",
    2369: " 18JZWKVMTOPQMR RSPMS RUFVGWIWKVNTPQRMT",
    2370: " 32H\\PMMNLOKQKSLUMVPWTWWVXUYSYQXOWNTMPM RMNLPLSMUNVPW RWVXTXQWOVNTM",
    2371: " 36H\\SMONLPKRKTLVNWQWUVXTYRYPXNVMSM RXNSM RVMQNLP RONKR RLVQW RNWSVXT RUVYR",
    2372: " 34J[SMPNNPMRMTNVPWRWUVWTXRXPWNUMSM ROPUM RNRVN RMTWO RNUXP ROVWR RPWVT",
    2373: " 18JZOGO^ RUFU] RMNWL RMOWM RMWWU RMXWV",
    2374: " 18JZNFNX RVLV^ RNNVL RNOVM RNWVU RNXVV",
    2375: " 25JZNBNW RNNQLTLVMWOWQVSSUQVNW RNNQMTMVN RUMVOVQUSSU",
    2376: " 18E_HIHL R\\I\\L RHI\\I RHJ\\J RHK\\K RHL\\L",
    2377: " 18JZMNMQ RWNWQ RMNWN RMOWO RMPWP RMQWQ",
    2378: " 36JZQCVMRTRU RULQS RTITKPRRUUY RW\\UYSXQXOYN[N]O_Ra RW\\UZSYOYO]P_Ra RSXPZN]",
    2379: " 26JZPOOMOKMKMMNNPOSOUNWL RNKNN RMLOL RMMSO RPOUN RWLSY",
    2380: " 86A^GfHfIeIdHcGcFdFfGhIiKiNhPfQdR`RUQ;Q4R/S-U,V,X-Y/Y3X6W8U;P?JCHEFHEJDNDREVGYJ[N\\R\\V[XZZW[T[PZMYKWITHPHMIKKJNJRKUMW RGdGeHeHdGd RU;Q?LCIFGIFKENERFVGXJ[ RR\\U[WZYWZTZPYMXKVITH",
    2381: " 89IjNQOOQNSNUOVQVSUUSVQVOUNTMQMNNKPISHWH[I^K`NaRaW`[_]]`ZcVfQiMk RWHZI]K_N`R`W_[^]\\`YcTgQi RPOTO ROPUP RNQVQ RNRVR RNSVS ROTUT RPUTU ReLeNgNgLeL RfLfN ReMgM ReVeXgXgVeV RfVfX ReWgW",
    2382: " 85D`H>Hf RI>If RM>Mf RQBSBSDQDQAR?T>W>Y?[A\\D\\I[LYNWOUOSNRLQNOQNROSQVRXSVUUWUYV[X\\[\\`[cYeWfTfReQcQ`S`SbQb RRBRD RQCSC RY?ZA[D[IZLYN RRLRNPQNRPSRVRX RYVZX[[[`ZcYe RR`Rb RQaSa",
    2401: " 21AcHBHb RIBIb R[B[b R\\B\\b RDB`B RDbMb RWb`b",
    2402: " 23BaGBQPFb RFBPP REBPQ REB\\B^I[B RGa\\a RFb\\b^[[b",
    2403: " 28I[X+U1R8P=OANFMNMVN^OcPgRlUsXy RU1S6Q<P@OFNNNVO^PdQhSnUs",
    2404: " 28I[L+O1R8T=UAVFWNWVV^UcTgRlOsLy RO1Q6S<T@UFVNVVU^TdShQnOs",
    2405: " 14I[M+MRMy RN+NRNy RM+X+ RMyXy",
    2406: " 14I[V+VRVy RW+WRWy RL+W+ RLyWy",
    2407: " 48I[V+S-Q/P1O4O8P<TDUGUJTMRP RS-Q0P4P8Q;UCVGVJUMRPNRRTUWVZV]UaQiPlPpQtSw RRTTWUZU]T`PhOlOpPsQuSwVy",
    2408: " 48I[N+Q-S/T1U4U8T<PDOGOJPMRP RQ-S0T4T8S;OCNGNJOMRPVRRTOWNZN]OaSiTlTpStQw RRTPWOZO]P`ThUlUpTsSuQwNy",
    2409: " 32I[V.S1Q4O8N=NCOIPMSXT\\UbUgTlSoQs RS1Q5P8O=OBPHQLTWU[VaVgUlSpQsNv",
    2410: " 32I[N.Q1S4U8V=VCUITMQXP\\ObOgPlQoSs RQ1S5T8U=UBTHSLPWO[NaNgOlQpSsVv",
    2411: ' 147Z:RARRo R@RQo R?RRr RZ"VJRr',
    2412: " 57Ca].\\.[/[0\\1]1^0^.],[+Y+W,U.T0S3R:QJQjPsOv R\\/\\0]0]/\\/ RR:Rj RU.T1S:SZRjQqPtOvMxKyIyGxFvFtGsHsItIuHvGv RGtGuHuHtGt",
    2501: " 20H\\RFJ[ RRIK[J[ RRIY[Z[ RRFZ[ RMUWU RLVXV",
    2502: " 44H\\LFL[ RMGMZ RLFTFWGXHYJYMXOWPTQ RMGTGWHXJXMWOTP RMPTPWQXRYTYWXYWZT[L[ RMQTQWRXTXWWYTZMZ",
    2503: " 38H]ZKYIWGUFQFOGMILKKNKSLVMXOZQ[U[WZYXZV RZKYKXIWHUGQGOHMKLNLSMVOYQZUZWYXXYVZV",
    2504: " 32H]LFL[ RMGMZ RLFSFVGXIYKZNZSYVXXVZS[L[ RMGSGVHWIXKYNYSXVWXVYSZMZ",
    2505: " 27I\\MFM[ RNGNZ RMFYF RNGYGYF RNPTPTQ RNQTQ RNZYZY[ RM[Y[",
    2506: " 21I[MFM[ RNGN[M[ RMFYF RNGYGYF RNPTPTQ RNQTQ",
    2507: " 44H]ZKYIWGUFQFOGMILKKNKSLVMXOZQ[U[WZYXZVZRUR RZKYKXIWHUGQGOHNIMKLNLSMVNXOYQZUZWYXXYVYSUSUR",
    2508: " 22G]KFK[ RKFLFL[K[ RYFXFX[Y[ RYFY[ RLPXP RLQXQ",
    2509: "  8NWRFR[S[ RRFSFS[",
    2510: " 20J[VFVVUYSZQZOYNVMV RVFWFWVVYUZS[Q[OZNYMV",
    2511: " 22H]LFL[M[ RLFMFM[ RZFYFMR RZFMS RPOY[Z[ RQOZ[",
    2512: " 14IZMFM[ RMFNFNZ RNZYZY[ RM[Y[",
    2513: " 26F^JFJ[ RKKK[J[ RKKR[ RJFRX RZFRX RYKR[ RYKY[Z[ RZFZ[",
    2514: " 20G]KFK[ RLIL[K[ RLIY[ RKFXX RXFXX RXFYFY[",
    2515: " 40G]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF RQGNHLKKNKSLVNYQZSZVYXVYSYNXKVHSGQG",
    2516: " 27H\\LFL[ RMGM[L[ RLFUFWGXHYJYMXOWPUQMQ RMGUGWHXJXMWOUPMP",
    2517: " 48G]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF RQGNHLKKNKSLVNYQZSZVYXVYSYNXKVHSGQG RSXX]Y] RSXTXY]",
    2518: " 34H\\LFL[ RMGM[L[ RLFTFWGXHYJYMXOWPTQMQ RMGTGWHXJXMWOTPMP RRQX[Y[ RSQY[",
    2519: " 43H\\YIWGTFPFMGKIKKLMMNOOTQVRWSXUXXWYTZPZNYMXKX RYIWIVHTGPGMHLILKMMONTPVQXSYUYXWZT[P[MZKX",
    2520: " 15J[RGR[ RSGS[R[ RLFYFYG RLFLGYG",
    2521: " 24G]KFKULXNZQ[S[VZXXYUYF RKFLFLUMXNYQZSZVYWXXUXFYF",
    2522: " 14H\\JFR[ RJFKFRX RZFYFRX RZFR[",
    2523: " 26E_GFM[ RGFHFMX RRFMX RRIM[ RRIW[ RRFWX R]F\\FWX R]FW[",
    2524: " 16H\\KFX[Y[ RKFLFY[ RYFXFK[ RYFL[K[",
    2525: " 17I\\KFRPR[S[ RKFLFSP RZFYFRP RZFSPS[",
    2526: " 20H\\XFK[ RYFL[ RKFYF RKFKGXG RLZYZY[ RK[Y[",
    2551: " 38E\\XFVHTKQPOSLWIZG[E[DZDXEWFXEY RXFWJUTT[ RXFU[ RT[TYSVRTPRNQLQKRKTLWOZR[V[XZ",
    2552: " 70F^UGTHSJQOOUNWLZJ[ RTHSKQSPVOXMZJ[H[GZGXHWIXHY ROLNNMOKOJNJLKJMHOGRFXFZG[I[KZMXNTORO RXFYGZIZKYMXN RTOWPXQYSYVXYWZU[S[RZRXSU RTOVPWQXSXVWYU[",
    2553: " 41H]KHJJJLKNNOQOUNWMYKZIZGYFWFTGQJOMMQLULXMZP[R[UZWXXVXTWRURSSRU RWFUGRJPMNQMUMXNZP[",
    2554: " 43F]UGTHSJQOOUNWLZJ[ RTHSKQSPVOXMZJ[H[GZGXHWJWLXNZP[S[UZWXYTZOZLYIWGUFPFMGKIJKJMKNMNNMOK",
    2555: " 49I\\WIVJVLWMYMZKZIYGWFTFRGQHPJPLQNSO RTFRHQJQMSO RSOQONPLRKTKWLYMZO[R[UZWXXVXTWRURSSRU RQOOPMRLTLXMZ",
    2556: " 46G\\WHVJTORUQWOZM[ RQLPNNOLOKMKKLINGQF[FXGWHVKTSSVRXPZM[K[IZHYHXIWJXIY RSFWGXG ROSPRRQVQXPZMXT",
    2557: " 53G]JIIKIMJOLPOPROTNWKXHXGWFVFTGRIQKPNPQQSSTUTWSYQZO RWFUGSIRKQNQRST RZOYSWWUYSZO[L[JZIXIWJVKWJX RYSWVUXRZO[",
    2558: " 55F^LLKKKILGOFRFOQMWLYKZI[G[FZFXGWHXGY RRFOONRLWKYI[ RJTKSMRVOXN[L]J^H^G]F\\FZGXJWLURTVTYV[W[YZ[X R\\FZHXLVRUVUYV[",
    2559: " 33IYWHUKSPQUPWNZL[ RYLWNTOQOONNLNJOHQGUFYFWHVJTPRVQXOZL[J[IZIXJWKXJY",
    2560: " 34IZYFWHUKSPPYN] RYMWOTPQPOONMNKOIQGUFYFWIVKSTQXPZN]M^K_J^J\\KZMXOWRVVU",
    2561: " 59F^LLKKKIMGPFRFOQMWLYKZI[G[FZFXGWHXGY RRFOONRLWKYI[ RZGWKUMSNPO R]G\\H]I^H^G]F\\FZGWLVMTNPO RPOSPTRUYV[ RPORPSRTYV[W[YZ[X",
    2562: " 40I[MILKLMMOOPRPUOWNZK[H[GZFYFWGVHTKPUOWMZK[ RVHTLRSQVPXNZK[I[HZHXIWKWMXPZR[U[WZYX",
    2563: " 49D`RFNOKUIXGZE[C[BZBXCWDXCY RRFPMOQNVNZP[ RRFQJPOOVOZP[ R[FWORXP[ R[FYMXQWVWZY[Z[\\Z^X R[FZJYOXVXZY[",
    2564: " 38G^RFQJOPMULWJZH[F[EZEXFWGXFY RRFRKSVT[ RRFSKTVT[ R`G_H`IaHaG`F^F\\GZJYLWQUWT[",
    2565: " 34H]SFQGOIMLLNKRKVLYMZO[Q[TZVXXUYSZOZKYHXGWGUHSJQNPSPV RQGOJMNLRLVMYO[",
    2566: " 53F]UGTHSJQOOUNWLZJ[ RTHSKQSPVOXMZJ[H[GZGXHWIXHY ROLNNMOKOJNJLKJMHOGRFVFYGZH[J[MZOYPVQTQRP RVFXGYHZJZMYOXPVQ",
    2567: " 43H]UJULTNSOQPOPNNNLOIQGTFWFYGZIZMYPWSSWPYNZK[I[HZHXIWKWMXPZS[V[XZZX RWFXGYIYMXPVSSVOYK[",
    2568: " 65F^UGTHSJQOOUNWLZJ[ RTHSKQSPVOXMZJ[H[GZGXHWIXHY ROLNNMOKOJNJLKJMHOGRFWFZG[I[KZMYNVORO RWFYGZIZKYMXNVO RROUPVRWYX[ RROTPURVYX[Y[[Z]X",
    2569: " 36H\\NIMKMMNOPPSPVOXN[K\\H\\G[FZFXGWHVJUMSTRWPZN[ RVJUNTUSXQZN[K[IZHXHWIVJWIX",
    2570: " 38I[YHXJVOTUSWQZO[ RSLRNPONOMMMKNIPGSF\\FZGYHXKVSUVTXRZO[M[KZJYJXKWLXKY RUFYGZG",
    2571: " 39G]HJJGLFMFOHOKNNKVKYL[ RMFNHNKKSJVJYL[N[PZSWUTVR RZFVRUVUYW[X[ZZ\\X R[FWRVVVYW[",
    2572: " 36G\\HJJGLFMFOHOKNOLVLYM[ RMFNHNKLRKVKYM[N[QZTWVTXPYMZIZGYFXFWGVIVLWNYP[Q]Q",
    2573: " 41F]ILHLGKGIHGJFNFMHLLKUJ[ RLLLUK[ RVFTHRLOUMYK[ RVFUHTLSUR[ RTLTUS[ R`F^G\\IZLWUUYS[",
    2574: " 52H\\PKOLMLLKLIMGOFQFSGTITLSPQUOXMZJ[H[GZGXHWIXHY RQFRGSISLRPPUNXLZJ[ R]G\\H]I^H^G]F[FYGWIULSPRURXSZT[U[WZYX",
    2575: " 42G]JJLGNFOFQGQIOOORPT ROFPGPINONRPTRTUSWQYNZL R\\FZLWTUX R]F[LYQWUUXSZP[L[JZIXIWJVKWJX",
    2576: " 44G\\ZHYJWOVRUTSWQYOZL[ RSLRNPONOMMMKNIPGSF]F[GZHYKXOVUTXQZL[H[GZGXHWJWLXOZQ[T[WZYX RVFZG[G",
    2601: " 36H\\WMW[X[ RWMXMX[ RWPUNSMPMNNLPKSKULXNZP[S[UZWX RWPSNPNNOMPLSLUMXNYPZSZWX",
    2602: " 36H\\LFL[M[ RLFMFM[ RMPONQMTMVNXPYSYUXXVZT[Q[OZMX RMPQNTNVOWPXSXUWXVYTZQZMX",
    2603: " 32I[XPVNTMQMONMPLSLUMXOZQ[T[VZXX RXPWQVOTNQNOONPMSMUNXOYQZTZVYWWXX",
    2604: " 36H\\WFW[X[ RWFXFX[ RWPUNSMPMNNLPKSKULXNZP[S[UZWX RWPSNPNNOMPLSLUMXNYPZSZWX",
    2605: " 36I[MTXTXQWOVNTMQMONMPLSLUMXOZQ[T[VZXX RMSWSWQVOTNQNOONPMSMUNXOYQZTZVYWWXX",
    2606: " 24LZWFUFSGRJR[S[ RWFWGUGSH RTGSJS[ ROMVMVN ROMONVN",
    2607: " 48H\\XMWMW\\V_U`SaQaO`N_L_ RXMX\\W_UaSbPbNaL_ RWPUNSMPMNNLPKSKULXNZP[S[UZWX RWPSNPNNOMPLSLUMXNYPZSZWX",
    2608: " 25H\\LFL[M[ RLFMFM[ RMQPNRMUMWNXQX[ RMQPORNTNVOWQW[X[",
    2609: " 24NWRFQGQHRISITHTGSFRF RRGRHSHSGRG RRMR[S[ RRMSMS[",
    2610: " 24NWRFQGQHRISITHTGSFRF RRGRHSHSGRG RRMRbSb RRMSMSb",
    2611: " 22H[LFL[M[ RLFMFM[ RXMWMMW RXMMX RPTV[X[ RQSX[",
    2612: "  8NWRFR[S[ RRFSFS[",
    2613: " 42CbGMG[H[ RGMHMH[ RHQKNMMPMRNSQS[ RHQKOMNONQORQR[S[ RSQVNXM[M]N^Q^[ RSQVOXNZN\\O]Q][^[",
    2614: " 25H\\LML[M[ RLMMMM[ RMQPNRMUMWNXQX[ RMQPORNTNVOWQW[X[",
    2615: " 36I\\QMONMPLSLUMXOZQ[T[VZXXYUYSXPVNTMQM RQNOONPMSMUNXOYQZTZVYWXXUXSWPVOTNQN",
    2616: " 36H\\LMLbMb RLMMMMb RMPONQMTMVNXPYSYUXXVZT[Q[OZMX RMPQNTNVOWPXSXUWXVYTZQZMX",
    2617: " 36H\\WMWbXb RWMXMXb RWPUNSMPMNNLPKSKULXNZP[S[UZWX RWPSNPNNOMPLSLUMXNYPZSZWX",
    2618: " 21KYOMO[P[ ROMPMP[ RPSQPSNUMXM RPSQQSOUNXNXM",
    2619: " 50J[XPWNTMQMNNMPNRPSUUWV RVUWWWXVZ RWYTZQZNY ROZNXMX RXPWPVN RWOTNQNNO RONNPOR RNQPRUTWUXWXXWZT[Q[NZMX",
    2620: " 16MXRFR[S[ RRFSFS[ ROMVMVN ROMONVN",
    2621: " 25H\\LMLWMZO[R[TZWW RLMMMMWNYPZRZTYWW RWMW[X[ RWMXMX[",
    2622: " 14JZLMR[ RLMMMRY RXMWMRY RXMR[",
    2623: " 26F^IMN[ RIMJMNX RRMNX RRPN[ RRPV[ RRMVX R[MZMVX R[MV[",
    2624: " 16I[LMW[X[ RLMMMX[ RXMWML[ RXMM[L[",
    2625: " 17JZLMR[ RLMMMRY RXMWMRYNb RXMR[ObNb",
    2626: " 20I[VNL[ RXMNZ RLMXM RLMLNVN RNZXZX[ RL[X[",
    2651: " 33K[UUTSRRPRNSMTLVLXMZO[Q[SZTX RPRNTMVMYO[ RVRTXTZV[XZYY[V RWRUXUZV[",
    2652: " 23LZLVNSPO RSFMXMZO[P[RZTXUUURVVWWXWZV RTFNXNZO[",
    2653: " 22LXTSSTTTTSSRQROSNTMVMXNZP[S[VYXV RQROTNVNYP[",
    2654: " 33K[UUTSRRPRNSMTLVLXMZO[Q[SZTX RPRNTMVMYO[ RZFTXTZV[XZYY[V R[FUXUZV[",
    2655: " 23LXOYQXRWSUSSRRQROSNTMVMXNZP[S[VYXV RQROTNVNYP[",
    2656: " 27OXRRUOWLXIXGWFUGTIKdKfLgNfOcPZQ[S[UZVYXV RTISNRRO[M`Kd",
    2657: " 38K[UUTSRRPRNSMTLVLXMZO[Q[SZTX RPRNTMVMYO[ RVRPd RWRT[R`PdOfMgLfLdMaO_R]V[YY[V",
    2658: " 30L[LVNSPO RSFL[ RTFM[ ROUQSSRTRVSVUUXUZV[ RTRUSUUTXTZV[XZYY[V",
    2659: " 19NVSLRMSNTMSL RQROXOZQ[SZTYVV RRRPXPZQ[",
    2660: " 24NVSLRMSNTMSL RQRKd RRRO[M`KdJfHgGfGdHaJ_M]Q[TYVV",
    2661: " 31LZLVNSPO RSFL[ RTFM[ RURUSVSURTRRTOU ROURVSZT[ ROUQVRZT[U[XYZV",
    2662: " 17NVNVPSRO RUFOXOZQ[SZTYVV RVFPXPZQ[",
    2663: " 45E^EVGSIRKSKUI[ RIRJSJUH[ RKUMSORPRRSRUP[ RPRQSQUO[ RRUTSVRWRYSYUXXXZY[ RWRXSXUWXWZY[[Z\\Y^V",
    2664: " 32I[IVKSMROSOUM[ RMRNSNUL[ ROUQSSRTRVSVUUXUZV[ RTRUSUUTXTZV[XZYY[V",
    2665: " 29KYRRPRNSMTLVLXMZO[Q[SZTYUWUUTSRRQSQURWTXVXXWYV RPRNTMVMYO[",
    2666: " 30L[LVNSPO RQLHg RRLIg ROUQSSRTRVSVUUXUZV[ RTRUSUUTXTZV[XZYY[V",
    2667: " 35K[UUTSRRPRNSMTLVLXMZO[Q[SZ RPRNTMVMYO[ RVRPdPfQgSfTcT[V[YY[V RWRT[R`Pd",
    2668: " 24LZLVNSPRRSRUP[ RPRQSQUO[ RRUTSVRWRVU RVRVUWWXWZV",
    2669: " 22NZNVPSQQQSTUUWUYTZR[ RQSSUTWTYR[ RNZP[U[XYZV",
    2670: " 20NVNVPSRO RUFOXOZQ[SZTYVV RVFPXPZQ[ RPNVN",
    2671: " 27K[NRLXLZN[O[QZSXUU RORMXMZN[ RVRTXTZV[XZYY[V RWRUXUZV[",
    2672: " 23KZNRMTLWLZN[O[RZTXUUUR RORNTMWMZN[ RURVVWWXWZV",
    2673: " 36H]LRJTIWIZK[L[NZPX RMRKTJWJZK[ RRRPXPZR[S[UZWXXUXR RSRQXQZR[ RXRYVZW[W]V",
    2674: " 42JZJVLSNRPRQSQUPXOZM[L[KZKYLYKZ RWSVTWTWSVRURSSRUQXQZR[U[XYZV RQSRU RSSQU RPXQZ RQXOZ",
    2675: " 32K[NRLXLZN[O[QZSXUU RORMXMZN[ RVRPd RWRT[R`PdOfMgLfLdMaO_R]V[YY[V",
    2676: " 38LYLVNSPRRRTSTVSXPZN[ RRRSSSVRXPZ RN[P\\Q^QaPdNfLgKfKdLaO^R\\VYYV RN[O\\P^PaOdNf",
    2700: " 42H\\QFNGLJKOKRLWNZQ[S[VZXWYRYOXJVGSFQF ROGMJLOLRMWOZ RNYQZSZVY RUZWWXRXOWJUG RVHSGQGNH",
    2701: " 12H\\NJPISFS[ RNJNKPJRHR[S[",
    2702: " 34H\\LKLJMHNGPFTFVGWHXJXLWNUQL[ RLKMKMJNHPGTGVHWJWLVNTQK[ RLZYZY[ RK[Y[",
    2703: " 48H\\MFXFQO RMFMGWG RWFPO RQNSNVOXQYTYUXXVZS[P[MZLYKWLW RPOSOVPXS RTOWQXTXUWXTZ RXVVYSZPZMYLW ROZLX",
    2704: " 18H\\UIU[V[ RVFV[ RVFKVZV RUILV RLUZUZV",
    2705: " 53H\\MFLO RNGMN RMFWFWG RNGWG RMNPMSMVNXPYSYUXXVZS[P[MZLYKWLW RLOMOONSNVOXR RTNWPXSXUWXTZ RXVVYSZPZMYLW ROZLX",
    2706: " 62H\\VGWIXIWGTFRFOGMJLOLTMXOZR[S[VZXXYUYTXQVOSNRNOOMQ RWHTGRGOH RPGNJMOMTNXQZ RMVOYRZSZVYXV RTZWXXUXTWQTO RXSVPSOROOPMS RQONQMT",
    2707: " 12H\\KFYFO[ RKFKGXG RXFN[O[",
    2708: " 68H\\PFMGLILKMMNNPOTPVQWRXTXWWYTZPZMYLWLTMRNQPPTOVNWMXKXIWGTFPF RNGMIMKNMPNTOVPXRYTYWXYWZT[P[MZLYKWKTLRNPPOTNVMWKWIVG RWHTGPGMH RLXOZ RUZXX",
    2709: " 62H\\WPURRSQSNRLPKMKLLINGQFRFUGWIXMXRWWUZR[P[MZLXMXNZ RWMVPSR RWNUQRRQRNQLN RPRMPLMLLMIPG RLKNHQGRGUHWK RSGVIWMWRVWTZ RUYRZPZMY",
    2710: " 16MXRXQYQZR[S[TZTYSXRX RRYRZSZSYRY",
    2711: " 24MXTZS[R[QZQYRXSXTYT\\S^Q_ RRYRZSZSYRY RS[T\\ RTZS^",
    2712: " 32MXRMQNQORPSPTOTNSMRM RRNROSOSNRN RRXQYQZR[S[TZTYSXRX RRYRZSZSYRY",
    2713: " 40MXRMQNQORPSPTOTNSMRM RRNROSOSNRN RTZS[R[QZQYRXSXTYT\\S^Q_ RRYRZSZSYRY RS[T\\ RTZS^",
    2714: " 24MXRFRTST RRFSFST RRXQYQZR[S[TZTYSXRX RRYRZSZSYRY",
    2715: " 58I\\LKLJMHNGQFTFWGXHYJYLXNWOUPRQ RLKMKMJNHQGTGWHXJXLWNUORP RMIPG RUGXI RXMTP RRPRTSTSP RRXQYQZR[S[TZTYSXRX RRYRZSZSYRY",
    2716: " 24MXTFRGQIQLRMSMTLTKSJRJQK RRKRLSLSKRK RRGQK RQIRJ",
    2717: " 24MXTHSIRIQHQGRFSFTGTJSLQM RRGRHSHSGRG RSITJ RTHSL",
    2718: " 71F_\\MZMXNWPUVTXSYQZMZKYJWJUKSLRQOSMTKTISGQFPFNGMIMKNNPQUWXZZ[\\[ R\\M\\NZNXO RYNXPVVUXSZQ[M[KZJYIWIUJSLQQNRMSKSIRG RSHQGPGNH ROGNINKONQQVWXYZZ\\Z\\[",
    2719: " 51I\\RBR_S_ RRBSBS_ RWIYIWGTFQFNGLILKMMNNVRWSXUXWWYTZQZOYNX RWIVHTGQGNHMIMKNMVQXSYUYWXYWZT[Q[NZLXNX RXXUZ",
    2720: "  8G^[BIbJb R[B\\BJb",
    2721: " 24KYUBSDQGOKNPNTOYQ]S`UbVb RUBVBTDRGPKOPOTPYR]T`Vb",
    2722: " 24KYNBPDRGTKUPUTTYR]P`NbOb RNBOBQDSGUKVPVTUYS]Q`Ob",
    2723: " 39JZRFQGSQRR RRFRR RRFSGQQRR RMINIVOWO RMIWO RMIMJWNWO RWIVINOMO RWIMO RWIWJMNMO",
    2724: "  8F_JQ[Q[R RJQJR[R",
    2725: " 16F_RIRZSZ RRISISZ RJQ[Q[R RJQJR[R",
    2726: " 16F_JM[M[N RJMJN[N RJU[U[V RJUJV[V",
    2727: " 11NWSFRGRM RSGRM RSFTGRM",
    2728: " 22I[NFMGMM RNGMM RNFOGMM RWFVGVM RWGVM RWFXGVM",
    2729: " 30KYQFOGNINKOMQNSNUMVKVIUGSFQF RQFNIOMSNVKUGQF RSFOGNKQNUMVISF",
    2750: " 42H]TFQGOIMLLOKSKVLYMZO[Q[TZVXXUYRZNZKYHXGVFTF RTFRGPINLMOLSLVMYO[ RQ[SZUXWUXRYNYKXHVF",
    2751: " 15H]TJO[ RVFP[ RVFSIPKNL RUIQKNL",
    2752: " 42H]OJPKOLNKNJOHPGSFVFYGZIZKYMWOTQPSMUKWI[ RVFXGYIYKXMVOPS RJYKXMXRZUZWYXW RMXR[U[WZXW",
    2753: " 50H]OJPKOLNKNJOHPGSFVFYGZIZKYMVOSP RVFXGYIYKXMVO RQPSPVQWRXTXWWYVZS[O[LZKYJWJVKULVKW RSPUQVRWTWWVYUZS[",
    2754: " 10H]XGR[ RYFS[ RYFJUZU",
    2755: " 39H]QFLP RQF[F RQGVG[F RLPMOPNSNVOWPXRXUWXUZR[O[LZKYJWJVKULVKW RSNUOVPWRWUVXTZR[",
    2756: " 46H]YIXJYKZJZIYGWFTFQGOIMLLOKSKWLYMZO[R[UZWXXVXSWQVPTOQOOPMRLT RTFRGPINLMOLSLXMZ RR[TZVXWVWRVP",
    2757: " 30H]NFLL R[FZIXLSRQUPWO[ RXLRRPUOWN[ RMIPFRFWI RNHPGRGWIYIZH[F",
    2758: " 63H]SFPGOHNJNMOOQPTPXOYNZLZIYGVFSF RSFQGPHOJOMPOQP RTPWOXNYLYIXGVF RQPMQKSJUJXKZN[R[VZWYXWXTWRVQTP RQPNQLSKUKXLZN[ RR[UZVYWWWSVQ",
    2759: " 46H]YMXOVQTRQROQNPMNMKNIPGSFVFXGYHZJZNYRXUVXTZQ[N[LZKXKWLVMWLX ROQNONKOIQGSF RXGYIYNXRWUUXSZQ[",
    2760: "  6MXPYOZP[QZPY",
    2761: "  8MXP[OZPYQZQ[P]N_",
    2762: " 11MXSMRNSOTNSM RPYOZP[QZ",
    2763: " 14MXSMRNSOTNSM RP[OZPYQZQ[P]N_",
    2764: " 17MXUFTGRS RUGRS RUFVGRS RPYOZP[QZPY",
    2765: " 34H]OJPKOLNKNJOHPGSFWFZG[I[KZMYNSPQQQSRTTT RWFYGZIZKYMXNVO RPYOZP[QZPY",
    2766: "  8MXVFTHSJSKTLUKTJ",
    2767: "  8MXUHTGUFVGVHUJSL",
    2768: " 55E_\\N[O\\P]O]N\\M[MYNWPRXPZN[K[HZGXGVHTISKRPPROTMUKUITGRFPGOIOLPRQUSXUZW[Y[ZYZX RK[IZHXHVITJSPP ROLPQQTSWUYWZYZZY",
    2769: " 41H]TBL_ RYBQ_ RZJYKZL[K[JZHYGVFRFOGMIMKNMONVRXT RMKOMVQWRXTXWWYVZS[O[LZKYJWJVKULVKW",
    2770: "  3G]_BEb",
    2771: " 20KZZBVESHQKOONTNXO]P`Qb RVESIQMPPOUOZP_Qb",
    2772: " 20JYSBTDUGVLVPUUSYQ\\N_Jb RSBTEUJUOTTSWQ[N_",
    2773: "  9J[TFTR ROIYO RYIOO",
    2774: "  3E_IR[R",
    2775: "  6E_RIR[ RIR[R",
    2776: "  6E_IO[O RIU[U",
    2777: "  6NWUFSM RVFSM",
    2778: " 12I[PFNM RQFNM RYFWM RZFWM",
    2779: " 14KZSFQGPIPKQMSNUNWMXKXIWGUFSF",
    2801: " 18H\\RFK[ RRFY[ RRIX[ RMUVU RI[O[ RU[[[",
    2802: " 31G]LFL[ RMFM[ RIFYFYLXF RMPUPXQYRZTZWYYXZU[I[ RUPWQXRYTYWXYWZU[",
    2803: " 45G]LFL[ RMFM[ RIFUFXGYHZJZLYNXOUP RUFWGXHYJYLXNWOUP RMPUPXQYRZTZWYYXZU[I[ RUPWQXRYTYWXYWZU[",
    2804: " 14I[NFN[ ROFO[ RKFZFZLYF RK[R[",
    2805: " 31F^NFNLMTLXKZJ[ RXFX[ RYFY[ RKF\\F RG[\\[ RG[Gb RH[Gb R[[\\b R\\[\\b",
    2806: " 22G\\LFL[ RMFM[ RSLST RIFYFYLXF RMPSP RI[Y[YUX[",
    2807: " 71CbRFR[ RSFS[ ROFVF RGGHHGIFHFGGFHFIGJIKMLONPWPYOZM[I\\G]F^F_G_H^I]H^G RNPLQKSJXIZH[ RNPMQLSKXJZI[G[FZEX RWPYQZS[X\\Z][ RWPXQYSZX[Z\\[^[_Z`X RO[V[",
    2808: " 45H\\LIKFKLLINGPFTFWGXIXLWNTOQO RTFVGWIWLVNTO RTOVPXRYTYWXYWZT[O[MZLYKWKVLUMVLW RWQXTXWWYVZT[",
    2809: " 27F^KFK[ RLFL[ RXFX[ RYFY[ RHFOF RUF\\F RXHLY RH[O[ RU[\\[",
    2810: " 37F^KFK[ RLFL[ RXFX[ RYFY[ RHFOF RUF\\F RXHLY RH[O[ RU[\\[ RN@N?M?M@NBPCTCVBW@",
    2811: " 43F^KFK[ RLFL[ RHFOF RLPSPUOVMWIXGYFZF[G[HZIYHZG RSPUQVSWXXZY[ RSPTQUSVXWZX[Z[[Z\\X RH[O[",
    2812: " 25E^MFMLLTKXJZI[H[GZGYHXIYHZ RXFX[ RYFY[ RJF\\F RU[\\[",
    2813: " 30F_KFK[ RLFRX RKFR[ RYFR[ RYFY[ RZFZ[ RHFLF RYF]F RH[N[ RV[][",
    2814: " 27F^KFK[ RLFL[ RXFX[ RYFY[ RHFOF RUF\\F RLPXP RH[O[ RU[\\[",
    2815: " 44G]QFNGLIKKJOJRKVLXNZQ[S[VZXXYVZRZOYKXIVGSFQF RQFOGMILKKOKRLVMXOZQ[ RS[UZWXXVYRYOXKWIUGSF",
    2816: " 21F^KFK[ RLFL[ RXFX[ RYFY[ RHF\\F RH[O[ RU[\\[",
    2817: " 29G]LFL[ RMFM[ RIFUFXGYHZJZMYOXPUQMQ RUFWGXHYJYMXOWPUQ RI[P[",
    2818: " 32G\\XIYLYFXIVGSFQFNGLIKKJNJSKVLXNZQ[S[VZXXYV RQFOGMILKKNKSLVMXOZQ[",
    2819: " 16I\\RFR[ RSFS[ RLFKLKFZFZLYF RO[V[",
    2820: " 24H]KFRV RLFSV RZFSVQYPZN[M[LZLYMXNYMZ RIFOF RVF\\F",
    2821: " 48F_RFR[ RSFS[ ROFVF RPILJJLIOIRJULWPXUXYW[U\\R\\O[LYJUIPI RPIMJKLJOJRKUMWPX RUXXWZU[R[OZLXJUI RO[V[",
    2822: " 21H\\KFX[ RLFY[ RYFK[ RIFOF RUF[F RI[O[ RU[[[",
    2823: " 27F^KFK[ RLFL[ RXFX[ RYFY[ RHFOF RUF\\F RH[\\[ R[[\\b R\\[\\b",
    2824: " 28F]KFKQLSOTRTUSWQ RLFLQMSOT RWFW[ RXFX[ RHFOF RTF[F RT[[[",
    2825: " 30BcGFG[ RHFH[ RRFR[ RSFS[ R]F][ R^F^[ RDFKF ROFVF RZFaF RD[a[",
    2826: " 36BcGFG[ RHFH[ RRFR[ RSFS[ R]F][ R^F^[ RDFKF ROFVF RZFaF RD[a[ R`[ab Ra[ab",
    2827: " 31F`PFP[ RQFQ[ RIFHLHFTF RQPXP[Q\\R]T]W\\Y[ZX[M[ RXPZQ[R\\T\\W[YZZX[",
    2828: " 41CaHFH[ RIFI[ REFLF RIPPPSQTRUTUWTYSZP[E[ RPPRQSRTTTWSYRZP[ R[F[[ R\\F\\[ RXF_F RX[_[",
    2829: " 29H]MFM[ RNFN[ RJFQF RNPUPXQYRZTZWYYXZU[J[ RUPWQXRYTYWXYWZU[",
    2830: " 39H]LIKFKLLINGQFSFVGXIYKZNZSYVXXVZS[P[MZLYKWKVLUMVLW RSFUGWIXKYNYSXVWXUZS[ RPPYP",
    2831: " 59CbHFH[ RIFI[ REFLF RE[L[ RVFSGQIPKOOORPVQXSZV[X[[Z]X^V_R_O^K]I[GXFVF RVFTGRIQKPOPRQVRXTZV[ RX[ZZ\\X]V^R^O]K\\IZGXF RIPOP",
    2832: " 45G]WFW[ RXFX[ R[FOFLGKHJJJLKNLOOPWP ROFMGLHKJKLLNMOOP RRPPQORLYKZJZIY RPQOSMZL[J[IYIX RT[[[",
    2901: " 39I]NONPMPMONNPMTMVNWOXQXXYZZ[ RWOWXXZZ[[[ RWQVRPSMTLVLXMZP[S[UZWX RPSNTMVMXNZP[",
    2902: " 48H\\XFWGQINKLNKQKULXNZQ[S[VZXXYUYSXPVNSMQMNNLPKS RXFWHUIQJNLLN RQMONMPLSLUMXOZQ[ RS[UZWXXUXSWPUNSM",
    2903: " 37H\\MMM[ RNMN[ RJMUMXNYPYQXSUT RUMWNXPXQWSUT RNTUTXUYWYXXZU[J[ RUTWUXWXXWZU[",
    2904: " 14HZMMM[ RNMN[ RJMXMXRWM RJ[Q[",
    2905: " 22F]NMNQMWLZK[ RWMW[ RXMX[ RKM[M RI[H`H[[[[`Z[",
    2906: " 31H[LSXSXQWOVNTMQMNNLPKSKULXNZQ[S[VZXX RWSWPVN RQMONMPLSLUMXOZQ[",
    2907: " 59E`RMR[ RSMS[ ROMVM RJNIOHNIMJMKNMRNSPTUTWSXRZN[M\\M]N\\O[N RPTNUMVKZJ[ RPTNVLZK[I[HZGX RUTWUXVZZ[[ RUTWVYZZ[\\[]Z^X RO[V[",
    2908: " 42I[MOLMLQMONNPMTMWNXPXQWSTT RTMVNWPWQVSTT RQTTTWUXWXXWZT[P[MZLXLWMVNWMX RTTVUWWWXVZT[",
    2909: " 27G]LML[ RMMM[ RWMW[ RXMX[ RIMPM RTM[M RI[P[ RT[[[ RWNMZ",
    2910: " 37G]LML[ RMMM[ RWMW[ RXMX[ RIMPM RTM[M RI[P[ RT[[[ RWNMZ ROGOFNFNGOIQJSJUIVG",
    2911: " 38H\\MMM[ RNMN[ RJMQM RNTPTSSTRVNWMXMYNXOWN RPTSUTVVZW[ RPTRUSVUZV[X[YZZX RJ[Q[",
    2912: " 22G]NMNQMWLZK[J[IZJYKZ RWMW[ RXMX[ RKM[M RT[[[",
    2913: " 30G^LML[ RLMR[ RMMRY RXMR[ RXMX[ RYMY[ RIMMM RXM\\M RI[O[ RU[\\[",
    2914: " 27G]LML[ RMMM[ RWMW[ RXMX[ RIMPM RTM[M RMTWT RI[P[ RT[[[",
    2915: " 36H\\QMNNLPKSKULXNZQ[S[VZXXYUYSXPVNSMQM RQMONMPLSLUMXOZQ[ RS[UZWXXUXSWPUNSM",
    2916: " 21G]LML[ RMMM[ RWMW[ RXMX[ RIM[M RI[P[ RT[[[",
    2917: " 36G\\LMLb RMMMb RMPONQMSMVNXPYSYUXXVZS[Q[OZMX RSMUNWPXSXUWXUZS[ RIMMM RIbPb",
    2918: " 28H[WPVQWRXQXPVNTMQMNNLPKSKULXNZQ[S[VZXX RQMONMPLSLUMXOZQ[",
    2919: " 16I\\RMR[ RSMS[ RMMLRLMYMYRXM RO[V[",
    2920: " 22I[LMR[ RMMRY RXMR[P_NaLbKbJaK`La RJMPM RTMZM",
    2921: " 52H]RFRb RSFSb ROFSF RRPQNPMNMLNKQKWLZN[P[QZRX RNMMNLQLWMZN[ RWMXNYQYWXZW[ RSPTNUMWMYNZQZWYZW[U[TZSX RObVb",
    2922: " 21H\\LMW[ RMMX[ RXML[ RJMPM RTMZM RJ[P[ RT[Z[",
    2923: " 23G]LML[ RMMM[ RWMW[ RXMX[ RIMPM RTM[M RI[[[[`Z[",
    2924: " 28G]LMLTMVPWRWUVWT RMMMTNVPW RWMW[ RXMX[ RIMPM RTM[M RT[[[",
    2925: " 30CbHMH[ RIMI[ RRMR[ RSMS[ R\\M\\[ R]M][ REMLM ROMVM RYM`M RE[`[",
    2926: " 32CbHMH[ RIMI[ RRMR[ RSMS[ R\\M\\[ R]M][ REMLM ROMVM RYM`M RE[`[``_[",
    2927: " 27H]QMQ[ RRMR[ RLMKRKMUM RRTVTYUZWZXYZV[N[ RVTXUYWYXXZV[",
    2928: " 37E_JMJ[ RKMK[ RGMNM RKTOTRUSWSXRZO[G[ ROTQURWRXQZO[ RYMY[ RZMZ[ RVM]M RV[][",
    2929: " 25J[OMO[ RPMP[ RLMSM RPTTTWUXWXXWZT[L[ RTTVUWWWXVZT[",
    2930: " 34I\\MOLMLQMONNPMSMVNXPYSYUXXVZS[P[NZLXLWMVNWMX RSMUNWPXSXUWXUZS[ RRTXT",
    2931: " 51DaIMI[ RJMJ[ RFMMM RF[M[ RVMSNQPPSPUQXSZV[X[[Z]X^U^S]P[NXMVM RVMTNRPQSQURXTZV[ RX[ZZ\\X]U]S\\PZNXM RJTPT",
    2932: " 40G\\VMV[ RWMW[ RZMOMLNKPKQLSOTVT ROMMNLPLQMSOT RTTQUPVNZM[ RTTRUQVOZN[L[KZJX RS[Z[",
    3001: " 36H\\RFKZ RQIW[ RRIX[ RRFY[ RMUVU RI[O[ RT[[[ RKZJ[ RKZM[ RWZU[ RWYV[ RXYZ[",
    3002: " 78G]LFL[ RMGMZ RNFN[ RIFUFXGYHZJZLYNXOUP RXHYJYLXN RUFWGXIXMWOUP RNPUPXQYRZTZWYYXZU[I[ RXRYTYWXY RUPWQXSXXWZU[ RJFLG RKFLH ROFNH RPFNG RLZJ[ RLYK[ RNYO[ RNZP[",
    3003: " 37G\\XIYFYLXIVGTFQFNGLIKKJNJSKVLXNZQ[T[VZXXYV RMILKKNKSLVMX RQFOGMJLNLSMWOZQ[",
    3004: " 62G]LFL[ RMGMZ RNFN[ RIFSFVGXIYKZNZSYVXXVZS[I[ RWIXKYNYSXVWX RSFUGWJXNXSWWUZS[ RJFLG RKFLH ROFNH RPFNG RLZJ[ RLYK[ RNYO[ RNZP[",
    3005: " 83G\\LFL[ RMGMZ RNFN[ RIFYFYL RNPTP RTLTT RI[Y[YU RJFLG RKFLH ROFNH RPFNG RTFYG RVFYH RWFYI RXFYL RTLSPTT RTNRPTR RTOPPTQ RLZJ[ RLYK[ RNYO[ RNZP[ RT[YZ RV[YY RW[YX RX[YU",
    3006: " 70G[LFL[ RMGMZ RNFN[ RIFYFYL RNPTP RTLTT RI[Q[ RJFLG RKFLH ROFNH RPFNG RTFYG RVFYH RWFYI RXFYL RTLSPTT RTNRPTR RTOPPTQ RLZJ[ RLYK[ RNYO[ RNZP[",
    3007: " 60G^XIYFYLXIVGTFQFNGLIKKJNJSKVLXNZQ[T[VZXZY[YS RMILKKNKSLVMX RQFOGMJLNLSMWOZQ[ RXTXY RWSWYVZ RTS\\S RUSWT RVSWU RZSYU R[SYT",
    3008: " 81F^KFK[ RLGLZ RMFM[ RWFW[ RXGXZ RYFY[ RHFPF RTF\\F RMPWP RH[P[ RT[\\[ RIFKG RJFKH RNFMH ROFMG RUFWG RVFWH RZFYH R[FYG RKZI[ RKYJ[ RMYN[ RMZO[ RWZU[ RWYV[ RYYZ[ RYZ[[",
    3009: " 39LXQFQ[ RRGRZ RSFS[ RNFVF RN[V[ ROFQG RPFQH RTFSH RUFSG RQZO[ RQYP[ RSYT[ RSZU[",
    3010: " 45JYSFSWRZQ[ RTGTWSZ RUFUWTZQ[O[MZLXLVMUNUOVOWNXMX RMVMWNWNVMV RPFXF RQFSG RRFSH RVFUH RWFUG",
    3011: " 69F\\KFK[ RLGLZ RMFM[ RXGMR RPPW[ RQPX[ RQNY[ RHFPF RUF[F RH[P[ RT[[[ RIFKG RJFKH RNFMH ROFMG RWFXG RZFXG RKZI[ RKYJ[ RMYN[ RMZO[ RWYU[ RWYZ[",
    3012: " 52I[NFN[ ROGOZ RPFP[ RKFSF RK[Z[ZU RLFNG RMFNH RQFPH RRFPG RNZL[ RNYM[ RPYQ[ RPZR[ RU[ZZ RW[ZY RX[ZX RY[ZU",
    3013: " 63E_JFJZ RJFQ[ RKFQX RLFRX RXFQ[ RXFX[ RYGYZ RZFZ[ RGFLF RXF]F RG[M[ RU[][ RHFJG R[FZH R\\FZG RJZH[ RJZL[ RXZV[ RXYW[ RZY[[ RZZ\\[",
    3014: " 39F^KFKZ RKFY[ RLFXX RMFYX RYGY[ RHFMF RVF\\F RH[N[ RIFKG RWFYG R[FYG RKZI[ RKZM[",
    3015: " 54G]QFNGLIKKJOJRKVLXNZQ[S[VZXXYVZRZOYKXIVGSFQF RMILKKNKSLVMX RWXXVYSYNXKWI RQFOGMJLNLSMWOZQ[ RS[UZWWXSXNWJUGSF",
    3016: " 59G]LFL[ RMGMZ RNFN[ RIFUFXGYHZJZMYOXPUQNQ RXHYJYMXO RUFWGXIXNWPUQ RI[Q[ RJFLG RKFLH ROFNH RPFNG RLZJ[ RLYK[ RNYO[ RNZP[",
    3017: " 77G]QFNGLIKKJOJRKVLXNZQ[S[VZXXYVZRZOYKXIVGSFQF RMILKKNKSLVMX RWXXVYSYNXKWI RQFOGMJLNLSMWOZQ[ RS[UZWWXSXNWJUGSF RNXOVQURUTVUXV^W`Y`Z^Z\\ RV\\W^X_Y_ RUXW]X^Y^Z]",
    3018: " 80G]LFL[ RMGMZ RNFN[ RIFUFXGYHZJZLYNXOUPNP RXHYJYLXN RUFWGXIXMWOUP RRPTQUSWYX[Z[[Y[W RWWXYYZZZ RTQURXXYYZY[X RI[Q[ RJFLG RKFLH ROFNH RPFNG RLZJ[ RLYK[ RNYO[ RNZP[",
    3019: " 44H\\XIYFYLXIVGSFPFMGKIKLLNOPURWSXUXXWZ RLLMNOOUQWRXT RMGLILKMMONUPXRYTYWXYWZT[Q[NZLXKUK[LX",
    3020: " 57H\\JFJL RQFQ[ RRGRZ RSFS[ RZFZL RJFZF RN[V[ RKFJL RLFJI RMFJH ROFJG RUFZG RWFZH RXFZI RYFZL RQZO[ RQYP[ RSYT[ RSZU[",
    3021: " 45F^KFKULXNZQ[S[VZXXYUYG RLGLVMX RMFMVNYOZQ[ RHFPF RVF\\F RIFKG RJFKH RNFMH ROFMG RWFYG R[FYG",
    3022: " 34H\\KFR[ RLFRXR[ RMFSX RYGR[ RIFPF RUF[F RJFLH RNFMH ROFMG RWFYG RZFYG",
    3023: " 55F^JFN[ RKFNVN[ RLFOV RRFOVN[ RRFV[ RSFVVV[ RTFWV RZGWVV[ RGFOF RRFTF RWF]F RHFKG RIFKH RMFLH RNFLG RXFZG R\\FZG",
    3024: " 54H\\KFW[ RLFX[ RMFY[ RXGLZ RIFPF RUF[F RI[O[ RT[[[ RJFMH RNFMH ROFMG RVFXG RZFXG RLZJ[ RLZN[ RWZU[ RWYV[ RWYZ[",
    3025: " 48G]JFQQQ[ RKFRQRZ RLFSQS[ RYGSQ RHFOF RVF\\F RN[V[ RIFKG RNFLG RWFYG R[FYG RQZO[ RQYP[ RSYT[ RSZU[",
    3026: " 41H\\YFKFKL RWFK[ RXFL[ RYFM[ RK[Y[YU RLFKL RMFKI RNFKH RPFKG RT[YZ RV[YY RW[YX RX[YU",
    3051: " 38H\\UFIZ RSJT[ RTHUZ RUFUHVYV[ RLUTU RF[L[ RQ[X[ RIZG[ RIZK[ RTZR[ RTYS[ RVYW[",
    3052: " 78F^OFI[ RPFJ[ RQFK[ RLFWFZG[I[KZNYOVP RYGZIZKYNXO RWFXGYIYKXNVP RNPVPXQYSYUXXVZR[F[ RWQXSXUWXUZ RVPWRWUVXTZR[ RMFPG RNFOH RRFPH RSFPG RJZG[ RJYH[ RKYL[ RJZM[",
    3053: " 41H]ZH[H\\F[L[JZHYGWFTFQGOIMLLOKSKVLYMZP[S[UZWXXV RQHOJNLMOLSLWMY RTFRGPJOLNOMSMXNZP[",
    3054: " 63F]OFI[ RPFJ[ RQFK[ RLFUFXGYHZKZOYSWWUYSZO[F[ RWGXHYKYOXSVWTY RUFWHXKXOWSUWRZO[ RMFPG RNFOH RRFPH RSFPG RJZG[ RJYH[ RKYL[ RJZM[",
    3055: " 80F]OFI[ RPFJ[ RQFK[ RULST RLF[FZL RNPTP RF[U[WV RMFPG RNFOH RRFPH RSFPG RWFZG RXFZH RYFZI RZFZL RULSPST RTNRPSR RTOQPSQ RJZG[ RJYH[ RKYL[ RJZM[ RP[UZ RR[UY RUYWV",
    3056: " 70F\\OFI[ RPFJ[ RQFK[ RULST RLF[FZL RNPTP RF[N[ RMFPG RNFOH RRFPH RSFPG RWFZG RXFZH RYFZI RZFZL RULSPST RTNRPSR RTOQPSQ RJZG[ RJYH[ RKYL[ RJZM[",
    3057: " 65H^ZH[H\\F[L[JZHYGWFTFQGOIMLLOKSKVLYMZP[R[UZWXYT RQHOJNLMOLSLWMY RVXWWXT RTFRGPJOLNOMSMXNZP[ RR[TZVWWT RTT\\T RUTWU RVTWW RZTXV R[TXU",
    3058: " 81E_NFH[ ROFI[ RPFJ[ RZFT[ R[FU[ R\\FV[ RKFSF RWF_F RLPXP RE[M[ RQ[Y[ RLFOG RMFNH RQFOH RRFOG RXF[G RYFZH R]F[H R^F[G RIZF[ RIYG[ RJYK[ RIZL[ RUZR[ RUYS[ RVYW[ RUZX[",
    3059: " 39KYTFN[ RUFO[ RVFP[ RQFYF RK[S[ RRFUG RSFTH RWFUH RXFUG ROZL[ ROYM[ RPYQ[ ROZR[",
    3060: " 47I\\WFRWQYO[ RXFTSSVRX RYFUSSXQZO[M[KZJXJVKULUMVMWLXKX RKVKWLWLVKV RTF\\F RUFXG RVFWH RZFXH R[FXG",
    3061: " 72F]OFI[ RPFJ[ RQFK[ R\\GMR RQOU[ RROV[ RSNWZ RLFTF RYF_F RF[N[ RR[Y[ RMFPG RNFOH RRFPH RSFPG RZF\\G R^F\\G RJZG[ RJYH[ RKYL[ RJZM[ RUZS[ RUYT[ RVYX[",
    3062: " 49H\\QFK[ RRFL[ RSFM[ RNFVF RH[W[YU ROFRG RPFQH RTFRH RUFRG RLZI[ RLYJ[ RMYN[ RLZO[ RR[WZ RT[XX RV[YU",
    3063: " 68D`MFGZ RMGNYN[ RNFOY ROFPX R[FPXN[ R[FU[ R\\FV[ R]FW[ RJFOF R[F`F RD[J[ RR[Z[ RKFMG RLFMH R^F\\H R_F\\G RGZE[ RGZI[ RVZS[ RVYT[ RWYX[ RVZY[",
    3064: " 43F_OFIZ ROFV[ RPFVX RQFWX R\\GWXV[ RLFQF RYF_F RF[L[ RMFPG RNFPH RZF\\G R^F\\G RIZG[ RIZK[",
    3065: " 56G]SFPGNILLKOJSJVKYLZN[Q[TZVXXUYRZNZKYHXGVFSF ROIMLLOKSKWLY RUXWUXRYNYJXH RSFQGOJNLMOLSLXMZN[ RQ[SZUWVUWRXNXIWGVF",
    3066: " 60F]OFI[ RPFJ[ RQFK[ RLFXF[G\\I\\K[NYPUQMQ RZG[I[KZNXP RXFYGZIZKYNWPUQ RF[N[ RMFPG RNFOH RRFPH RSFPG RJZG[ RJYH[ RKYL[ RJZM[",
    3067: " 78G]SFPGNILLKOJSJVKYLZN[Q[TZVXXUYRZNZKYHXGVFSF ROIMLLOKSKWLY RUXWUXRYNYJXH RSFQGOJNLMOLSLXMZN[ RQ[SZUWVUWRXNXIWGVF RLXMVOUPURVSXT]U^V^W] RT^U_V_ RSXS_T`V`W]W\\",
    3068: " 78F^OFI[ RPFJ[ RQFK[ RLFWFZG[I[KZNYOVPNP RYGZIZKYNXO RWFXGYIYKXNVP RRPTQURWXXYYYZX RWYXZYZ RURVZW[Y[ZXZW RF[N[ RMFPG RNFOH RRFPH RSFPG RJZG[ RJYH[ RKYL[ RJZM[",
    3069: " 44G^ZH[H\\F[L[JZHYGVFRFOGMIMLNNPPVSWUWXVZ RNLONVRWT ROGNINKOMUPWRXTXWWYVZS[O[LZKYJWJUI[JYKY",
    3070: " 54G]TFN[ RUFO[ RVFP[ RMFKL R]F\\L RMF]F RK[S[ RNFKL RPFLI RRFMG RYF\\G RZF\\H R[F\\I R\\F\\L ROZL[ ROYM[ RPYQ[ ROZR[",
    3071: " 48F_NFKQJUJXKZN[R[UZWXXU\\G ROFLQKUKYLZ RPFMQLULYN[ RKFSF RYF_F RLFOG RMFNH RQFOH RRFOG RZF\\G R^F\\G",
    3072: " 35H\\NFNHOYO[ ROGPX RPFQW R[GO[ RLFSF RXF^F RMFNH RQFPH RRFOG RYF[G R]F[G",
    3073: " 57E_MFMHKYK[ RNGLX ROFMW RUFMWK[ RUFUHSYS[ RVGTX RWFUW R]GUWS[ RJFRF RUFWF RZF`F RKFNG RLFMH RPFNI RQFNG R[F]G R_F]G",
    3074: " 54G]NFT[ ROFU[ RPFV[ R[GIZ RLFSF RXF^F RF[L[ RQ[X[ RMFOH RQFPH RRFPG RYF[G R]F[G RIZG[ RIZK[ RTZR[ RTYS[ RUYW[",
    3075: " 51G]MFQPN[ RNFRPO[ ROFSPP[ R\\GSP RKFRF RYF_F RK[S[ RLFNG RPFOH RQFNG RZF\\G R^F\\G ROZL[ ROYM[ RPYQ[ ROZR[",
    3076: " 35G]ZFH[ R[FI[ R\\FJ[ R\\FNFLL RH[V[XU ROFLL RPFMI RRFNG RR[VZ RT[WX RU[XU",
    3101: " 54I]NPNOOOOQMQMONNPMTMVNWOXQXXYZZ[ RVOWQWXXZ RTMUNVPVXWZZ[[[ RVRUSPTMULWLXMZP[S[UZVX RNUMWMXNZ RUSQTOUNWNXOZP[",
    3102: " 47G\\LFL[MZOZ RMGMY RIFNFNZ RNPONQMSMVNXPYSYUXXVZS[Q[OZNX RWPXRXVWX RSMUNVOWRWVVYUZS[ RJFLG RKFLH",
    3103: " 34H[WQWPVPVRXRXPVNTMQMNNLPKSKULXNZQ[S[VZXX RMPLRLVMX RQMONNOMRMVNYOZQ[",
    3104: " 52H]VFV[[[ RWGWZ RSFXFX[ RVPUNSMQMNNLPKSKULXNZQ[S[UZVX RMPLRLVMX RQMONNOMRMVNYOZQ[ RTFVG RUFVH RXYY[ RXZZ[",
    3105: " 41H[MSXSXQWOVNSMQMNNLPKSKULXNZQ[S[VZXX RWRWQVO RMPLRLVMX RVSVPUNSM RQMONNOMRMVNYOZQ[",
    3106: " 40KYWHWGVGVIXIXGWFTFRGQHPKP[ RRHQKQZ RTFSGRIR[ RMMVM RM[U[ RPZN[ RPYO[ RRYS[ RRZT[",
    3107: " 89I\\XNYOZNYMXMVNUO RQMONNOMQMSNUOVQWSWUVVUWSWQVOUNSMQM ROONQNSOU RUUVSVQUO RQMPNOPOTPVQW RSWTVUTUPTNSM RNUMVLXLYM[N\\Q]U]X^Y_ RN[Q\\U\\X] RLYMZP[U[X\\Y^Y_XaUbObLaK_K^L\\O[ RObMaL_L^M\\O[",
    3108: " 65G^LFL[ RMGMZ RIFNFN[ RNQOOPNRMUMWNXOYRY[ RWOXRXZ RUMVNWQW[ RI[Q[ RT[\\[ RJFLG RKFLH RLZJ[ RLYK[ RNYO[ RNZP[ RWZU[ RWYV[ RYYZ[ RYZ[[",
    3109: " 43LXQFQHSHSFQF RRFRH RQGSG RQMQ[ RRNRZ RNMSMS[ RN[V[ ROMQN RPMQO RQZO[ RQYP[ RSYT[ RSZU[",
    3110: " 41KXRFRHTHTFRF RSFSH RRGTG RRMR^QaPb RSNS]R` ROMTMT]S`RaPbMbLaL_N_NaMaM` RPMRN RQMRO",
    3111: " 61G]LFL[ RMGMZ RIFNFN[ RWNNW RRSY[ RRTX[ RQTW[ RTM[M RI[Q[ RT[[[ RJFLG RKFLH RUMWN RZMWN RLZJ[ RLYK[ RNYO[ RNZP[ RWYU[ RVYZ[",
    3112: " 31LXQFQ[ RRGRZ RNFSFS[ RN[V[ ROFQG RPFQH RQZO[ RQYP[ RSYT[ RSZU[",
    3113: " 99AcFMF[ RGNGZ RCMHMH[ RHQIOJNLMOMQNROSRS[ RQORRRZ ROMPNQQQ[ RSQTOUNWMZM\\N]O^R^[ R\\O]R]Z RZM[N\\Q\\[ RC[K[ RN[V[ RY[a[ RDMFN REMFO RFZD[ RFYE[ RHYI[ RHZJ[ RQZO[ RQYP[ RSYT[ RSZU[ R\\ZZ[ R\\Y[[ R^Y_[ R^Z`[",
    3114: " 65G^LML[ RMNMZ RIMNMN[ RNQOOPNRMUMWNXOYRY[ RWOXRXZ RUMVNWQW[ RI[Q[ RT[\\[ RJMLN RKMLO RLZJ[ RLYK[ RNYO[ RNZP[ RWZU[ RWYV[ RYYZ[ RYZ[[",
    3115: " 46H\\QMNNLPKSKULXNZQ[S[VZXXYUYSXPVNSMQM RMPLRLVMX RWXXVXRWP RQMONNOMRMVNYOZQ[ RS[UZVYWVWRVOUNSM",
    3116: " 60G\\LMLb RMNMa RIMNMNb RNPONQMSMVNXPYSYUXXVZS[Q[OZNX RWPXRXVWX RSMUNVOWRWVVYUZS[ RIbQb RJMLN RKMLO RLaJb RL`Kb RN`Ob RNaPb",
    3117: " 55H\\VNVb RWOWa RUNWNXMXb RVPUNSMQMNNLPKSKULXNZQ[S[UZVX RMPLRLVMX RQMONNOMRMVNYOZQ[ RSb[b RVaTb RV`Ub RX`Yb RXaZb",
    3118: " 43IZNMN[ RONOZ RKMPMP[ RWOWNVNVPXPXNWMUMSNQPPS RK[S[ RLMNN RMMNO RNZL[ RNYM[ RPYQ[ RPZR[",
    3119: " 43J[WOXMXQWOVNTMPMNNMOMQNSPTUUWVXY RNNMQ RNRPSUTWU RXVWZ RMONQPRUSWTXVXYWZU[Q[OZNYMWM[NY",
    3120: " 22KZPHPVQYRZT[V[XZYX RQHQWRY RPHRFRWSZT[ RMMVM",
    3121: " 43G^LMLVMYNZP[S[UZVYWW RMNMWNY RIMNMNWOZP[ RWMW[\\[ RXNXZ RTMYMY[ RJMLN RKMLO RYYZ[ RYZ[[",
    3122: " 31I[LMR[ RMMRY RNMSY RXNSYR[ RJMQM RTMZM RKMNO RPMNN RVMXN RYMXN",
    3123: " 45F^JMN[ RKMNX RLMOX RRMOXN[ RRMV[ RSMVX RRMTMWX RZNWXV[ RGMOM RWM]M RHMKN RNMLN RXMZN R\\MZN",
    3124: " 48H\\LMV[ RMMW[ RNMX[ RWNMZ RJMQM RTMZM RJ[P[ RS[Z[ RKMMN RPMNN RUMWN RYMWN RMZK[ RMZO[ RVZT[ RWZY[",
    3125: " 40H[LMR[ RMMRY RNMSY RXNSYP_NaLbJbIaI_K_KaJaJ` RJMQM RTMZM RKMNO RPMNN RVMXN RYMXN",
    3126: " 41I[VML[ RWMM[ RXMN[ RXMLMLQ RL[X[XW RMMLQ RNMLP ROMLO RQMLN RS[XZ RU[XY RV[XX RW[XW",
    3151: " 50G]WMUTUXVZW[Y[[Y\\W RXMVTVZ RWMYMWTVX RUTUQTNRMPMMNKQJTJVKYLZN[P[RZSYTWUT RNNLQKTKWLY RPMNOMQLTLWMZN[",
    3152: " 52I\\PFNMMSMWNYOZQ[S[VZXWYTYRXOWNUMSMQNPOOQNT RQFOMNQNWOZ RVYWWXTXQWO RMFRFPMNT RS[UYVWWTWQVNUM RNFQG ROFPH",
    3153: " 34I[WQWPVPVRXRXPWNUMRMONMQLTLVMYNZP[R[UZWW ROONQMTMWNY RRMPOOQNTNWOZP[",
    3154: " 58G]YFVQUUUXVZW[Y[[Y\\W RZFWQVUVZ RVF[FWTVX RUTUQTNRMPMMNKQJTJVKYLZN[P[RZSYTWUT RMOLQKTKWLY RPMNOMQLTLWMZN[ RWFZG RXFYH",
    3155: " 33I[MVQUTTWRXPWNUMRMONMQLTLVMYNZP[R[UZWX ROONQMTMWNY RRMPOOQNTNWOZP[",
    3156: " 45JZZHZGYGYI[I[GZFXFVGTISKRNQRO[N^M`Kb RTJSMRRP[O^ RXFVHUJTMSRQZP]O_MaKbIbHaH_J_JaIaI` RNMYM",
    3157: " 57H]XMT[S^QaOb RYMU[S_ RXMZMV[T_RaObLbJaI`I^K^K`J`J_ RVTVQUNSMQMNNLQKTKVLYMZO[Q[SZTYUWVT RNOMQLTLWMY RQMOONQMTMWNZO[",
    3158: " 41G]OFI[K[ RPFJ[ RLFQFK[ RMTOPQNSMUMWNXPXSVX RWNWRVVVZ RWPUUUXVZW[Y[[Y\\W RMFPG RNFOH",
    3159: " 35KXSFSHUHUFSF RTFTH RSGUG RLQMOOMQMRNSPSSQX RRNRRQVQZ RRPPUPXQZR[T[VYWW",
    3160: " 45KXUFUHWHWFUF RVFVH RUGWG RMQNOPMRMSNTPTSRZQ]P_NaLbJbIaI_K_KaJaJ` RSNSSQZP]O_ RSPRTP[O^N`Lb",
    3161: " 49G]OFI[K[ RPFJ[ RLFQFK[ RYOYNXNXPZPZNYMWMUNQROS RMSOSQTRUTYUZWZ RQUSYTZ ROSPTRZS[U[WZYW RMFPG RNFOH",
    3162: " 26LXTFQQPUPXQZR[T[VYWW RUFRQQUQZ RQFVFRTQX RRFUG RSFTH",
    3163: " 61@cAQBODMFMGNHPHSF[ RGNGSE[ RGPFTD[F[ RHSJPLNNMPMRNSPSSQ[ RRNRSP[ RRPQTO[Q[ RSSUPWNYM[M]N^P^S\\X R]N]R\\V\\Z R]P[U[X\\Z][_[aYbW",
    3164: " 42F^GQHOJMLMMNNPNSL[ RMNMSK[ RMPLTJ[L[ RNSPPRNTMVMXNYPYSWX RXNXRWVWZ RXPVUVXWZX[Z[\\Y]W",
    3165: " 46H\\QMNNLQKTKVLYMZP[S[VZXWYTYRXOWNTMQM RNOMQLTLWMY RVYWWXTXQWO RQMOONQMTMWNZP[ RS[UYVWWTWQVNTM",
    3166: " 66G]HQIOKMMMNNOPOSNWKb RNNNSMWJb RNPMTIb ROTPQQORNTMVMXNYOZRZTYWWZT[R[PZOWOT RXOYQYTXWWY RVMWNXQXTWWVYT[ RFbNb RJaGb RJ`Hb RK`Lb RJaMb",
    3167: " 57G\\WMQb RXMRb RWMYMSb RUTUQTNRMPMMNKQJTJVKYLZN[P[RZSYTWUT RMOLQKTKWLY RPMNOMQLTLWMZN[ RNbVb RRaOb RR`Pb RS`Tb RRaUb",
    3168: " 30I[JQKOMMOMPNQPQTO[ RPNPTN[ RPPOTM[O[ RYOYNXNXPZPZNYMWMUNSPQT",
    3169: " 47J[XPXOWOWQYQYOXNUMRMONNONQOSQTTUVVWX RONNQ RORQSTTVU RWVVZ RNOOQQRTSVTWVWXVZS[P[MZLYLWNWNYMYMX",
    3170: " 23KYTFQQPUPXQZR[T[VYWW RUFRQQUQZ RTFVFRTQX RNMXM",
    3171: " 42F^GQHOJMLMMNNPNSLX RMNMRLVLZ RMPKUKXLZN[P[RZTXVU RXMVUVXWZX[Z[\\Y]W RYMWUWZ RXMZMXTWX",
    3172: " 29H\\IQJOLMNMONPPPSNX RONORNVNZ ROPMUMXNZP[R[TZVXXUYQYMXMXNYP",
    3173: " 48CaDQEOGMIMJNKPKSIX RJNJRIVIZ RJPHUHXIZK[M[OZQXRU RTMRURXSZU[W[YZ[X]U^Q^M]M]N^P RUMSUSZ RTMVMTTSX",
    3174: " 51G]JQLNNMPMRNSPSR RPMQNQRPVOXMZK[I[HZHXJXJZIZIY RRORRQVQY RZOZNYNYP[P[NZMXMVNTPSRRVRZS[ RPVPXQZS[U[WZYW",
    3175: " 49G]HQIOKMMMNNOPOSMX RNNNRMVMZ RNPLULXMZO[Q[SZUXWT RYMU[T^RaPb RZMV[T_ RYM[MW[U_SaPbMbKaJ`J^L^L`K`K_",
    3176: " 39H\\YMXOVQNWLYK[ RXOOOMPLR RVORNONNO RVORMOMMOLR RLYUYWXXV RNYRZUZVY RNYR[U[WYXV",
    3200: " 50H\\QFNGLJKOKRLWNZQ[S[VZXWYRYOXJVGSFQF RNHMJLNLSMWNY RVYWWXSXNWJVH RQFOGNIMNMSNXOZQ[ RS[UZVXWSWNVIUGSF",
    3201: " 28H\\QHQ[ RRHRZ RSFS[ RSFPINJ RM[W[ RQZO[ RQYP[ RSYT[ RSZU[",
    3202: " 62H\\LJLKMKMJLJ RLIMINJNKMLLLKKKJLHMGPFTFWGXHYJYLXNUPPRNSLUKXK[ RWHXJXLWN RTFVGWJWLVNTPPR RKYLXNXSYWYYX RNXSZWZXY RNXS[W[XZYXYV",
    3203: " 76H\\LJLKMKMJLJ RLIMINJNKMLLLKKKJLHMGPFTFWGXIXLWNTO RVGWIWLVN RSFUGVIVLUNSO RQOTOVPXRYTYWXYWZT[P[MZLYKWKVLUMUNVNWMXLX RWRXTXWWY RSOUPVQWTWWVZT[ RLVLWMWMVLV",
    3204: " 28H\\SIS[ RTHTZ RUFU[ RUFJUZU RP[X[ RSZQ[ RSYR[ RUYV[ RUZW[",
    3205: " 55H\\MFKPMNPMSMVNXPYSYUXXVZS[P[MZLYKWKVLUMUNVNWMXLX RWPXRXVWX RSMUNVOWRWVVYUZS[ RLVLWMWMVLV RMFWF RMGUG RMHQHUGWF",
    3206: " 69H\\VIVJWJWIVI RWHVHUIUJVKWKXJXIWGUFRFOGMILKKOKULXNZQ[S[VZXXYUYTXQVOSNQNOONPMR RNIMKLOLUMXNY RWXXVXSWQ RRFPGOHNJMNMUNXOZQ[ RS[UZVYWVWSVPUOSN",
    3207: " 43H\\KFKL RYFYIXLTQSSRWR[ RSRRTQWQ[ RXLSQQTPWP[R[ RKJLHNFPFUIWIXHYF RMHNGPGRH RKJLINHPHUI",
    3208: " 79H\\PFMGLILLMNPOTOWNXLXIWGTFPF RNGMIMLNN RVNWLWIVG RPFOGNINLONPO RTOUNVLVIUGTF RPOMPLQKSKWLYMZP[T[WZXYYWYSXQWPTO RMQLSLWMY RWYXWXSWQ RPONPMSMWNZP[ RT[VZWWWSVPTO",
    3209: " 69H\\MWMXNXNWMW RWOVQURSSQSNRLPKMKLLINGQFSFVGXIYLYRXVWXUZR[O[MZLXLWMVNVOWOXNYMY RMPLNLKMI RVHWIXLXRWVVX RQSORNQMNMKNHOGQF RSFUGVIWLWSVWUYTZR[",
    3210: " 16MXRXQYQZR[S[TZTYSXRX RRYRZSZSYRY",
    3211: " 24MXTZS[R[QZQYRXSXTYT\\S^Q_ RRYRZSZSYRY RS[T\\ RTZS^",
    3212: " 32MXRMQNQORPSPTOTNSMRM RRNROSOSNRN RRXQYQZR[S[TZTYSXRX RRYRZSZSYRY",
    3213: " 40MXRMQNQORPSPTOTNSMRM RRNROSOSNRN RTZS[R[QZQYRXSXTYT\\S^Q_ RRYRZSZSYRY RS[T\\ RTZS^",
    3214: " 34MXRFQGQIRQ RRFRTST RRFSFST RSFTGTISQ RRXQYQZR[S[TZTYSXRX RRYRZSZSYRY",
    3215: " 52I\\MKMJNJNLLLLJMHNGPFTFWGXHYJYLXNWOSQ RWHXIXMWN RTFVGWIWMVOUP RRQRTSTSQRQ RRXQYQZR[S[TZTYSXRX RRYRZSZSYRY",
    3216: " 24MXTFRGQIQLRMSMTLTKSJRJQK RRKRLSLSKRK RRGQK RQIRJ",
    3217: " 24MXTHSIRIQHQGRFSFTGTJSLQM RRGRHSHSGRG RSITJ RTHSL",
    3218: " 74E_[O[NZNZP\\P\\N[MZMYNXPVUTXRZP[L[JZIXIUJSPORMSKSIRGPFNGMIMLNOPRTWWZY[[[\\Y\\X RKZJXJUKSLR RRMSI RSKRG RNGMK RNNPQTVWYYZ RN[LZKXKULSPO RMINMQQUVXYZZ[Z\\Y",
    3219: " 56H\\PBP_ RTBT_ RXKXJWJWLYLYJXHWGTFPFMGKIKLLNOPURWSXUXXWZ RLLMNOOUQWRXT RMGLILKMMONUPXRYTYWXYWZT[P[MZLYKWKUMUMWLWLV",
    3220: "  8G^[BIbJb R[B\\BJb",
    3221: " 27KYUBSDQGOKNPNTOYQ]S`Ub RQHPKOOOUPYQ\\ RSDRFQIPOPUQ[R^S`",
    3222: " 27KYOBQDSGUKVPVTUYS]Q`Ob RSHTKUOUUTYS\\ RQDRFSITOTUS[R^Q`",
    3223: " 39JZRFQGSQRR RRFRR RRFSGQQRR RMINIVOWO RMIWO RMIMJWNWO RWIVINOMO RWIMO RWIWJMNMO",
    3224: "  8F_JQ[Q[R RJQJR[R",
    3225: " 16F_RIRZSZ RRISISZ RJQ[Q[R RJQJR[R",
    3226: " 16F_JM[M[N RJMJN[N RJU[U[V RJUJV[V",
    3227: " 11NWSFRGRM RSGRM RSFTGRM",
    3228: " 22I[NFMGMM RNGMM RNFOGMM RWFVGVM RWGVM RWFXGVM",
    3229: " 30KYQFOGNINKOMQNSNUMVKVIUGSFQF RQFNIOMSNVKUGQF RSFOGNKQNUMVISF",
    3250: " 58H]TFQGOIMLLOKSKVLYMZO[Q[TZVXXUYRZNZKYHXGVFTF RQHOJNLMOLSLWMY RTYVWWUXRYNYJXH RTFRGPJOLNOMSMXNZO[ RQ[SZUWVUWRXNXIWGVF",
    3251: " 20H]TJO[Q[ RWFUJP[ RWFQ[ RWFTIQKOL RTJRKOL",
    3252: " 52H]OKOJPJPLNLNJOHPGSFVFYGZIZKYMWOMUKWI[ RXGYIYKXMVOSQ RVFWGXIXKWMUOMU RJYKXMXRYWYXX RMXRZWZ RMXR[U[WZXXXW",
    3253: " 64H]OKOJPJPLNLNJOHPGSFVFYGZIZKYMXNVOSP RXGYIYKXMWN RVFWGXIXKWMUOSP RQPSPVQWRXTXWWYUZR[O[LZKYJWJULULWKWKV RVRWTWWVY RSPUQVSVWUYTZR[",
    3254: " 15H]WJR[T[ RZFXJS[ RZFT[ RZFJUZU",
    3255: " 49H]QFLP RQF[F RQGYG RPHUHYG[F RLPMOPNSNVOWPXRXUWXUZQ[N[LZKYJWJULULWKWKV RVPWRWUVXTZ RSNUOVQVUUXSZQ[",
    3256: " 61H]YJYIXIXKZKZIYGWFTFQGOIMLLOKSKVLYMZO[R[UZWXXVXSWQVPTOQOOPNQMS RPINLMOLSLWMY RVXWVWSVQ RTFRGPJOLNOMSMXNZO[ RR[TZUYVVVRUPTO",
    3257: " 39H]NFLL R[FZIXLTQRTQWP[ RRSPWO[ RXLRRPUOWN[P[ RMIPFRFWI ROGRGWI RMIOHRHWIYIZH[F",
    3258: "104H]SFPGOHNJNMOOQPTPWOYNZLZIYGWFSF RUFPG RPHOJONPO ROORP RSPWO RXNYLYIXG RYGUF RSFQHPJPNQP RTPVOWNXLXHWF RQPMQKSJUJXKZN[R[VZWYXWXTWRVQTP RRPMQ RNQLSKUKXLZ RKZP[VZ RVYWWWTVR RVQSP RQPOQMSLULXMZN[ RR[TZUYVWVSUQTP",
    3259: " 61H]XNWPVQTRQROQNPMNMKNIPGSFVFXGYHZKZNYRXUVXTZQ[N[LZKXKVMVMXLXLW ROPNNNKOI RXHYJYNXRWUUX RQRPQOOOKPHQGSF RVFWGXIXNWRVUUWSZQ[",
    3260: " 16MXPXOYOZP[Q[RZRYQXPX RPYPZQZQYPY",
    3261: " 22MXQ[P[OZOYPXQXRYR[Q]P^N_ RPYPZQZQYPY RQ[Q\\P^",
    3262: " 32MXSMRNROSPTPUOUNTMSM RSNSOTOTNSN RPXOYOZP[Q[RZRYQXPX RPYPZQZQYPY",
    3263: " 38MXSMRNROSPTPUOUNTMSM RSNSOTOTNSN RQ[P[OZOYPXQXRYR[Q]P^N_ RPYPZQZQYPY RQ[Q\\P^",
    3264: " 34MXVFUFTGRT RVGUGRT RVGVHRT RVFWGWHRT RPXOYOZP[Q[RZRYQXPX RPYPZQZQYPY",
    3265: " 59H]OKOJPJPLNLNJOHPGSFWFZG[I[KZMYNWOSPQQQSSTTT RUFZG RYGZIZKYMXNVO RWFXGYIYKXMWNSPRQRSST RPXOYOZP[Q[RZRYQXPX RPYPZQZQYPY",
    3266: " 22MXWFUGTHSJSLTMUMVLVKUJTJ RUGTITJ RTKTLULUKTK",
    3267: " 22MXVIUITHTGUFVFWGWIVKULSM RUGUHVHVGUG RVIVJUL",
    3268: " 72E_\\O\\N[N[P]P]N\\M[MYNWPRXPZN[K[HZGXGVHTISKRPPROTMUKUITGRFPGOIOLPRQURWTZV[X[YYYX RL[HZ RIZHXHVITJSLR RPPQSTYVZ RK[JZIXIVJTKSMRRO ROLPOQRSVUYWZXZYY",
    3269: " 52H]TBL_ RYBQ_ RZKZJYJYL[L[JZHYGVFRFOGMIMLNNPPVSWUWXVZ RNLONVRWT ROGNINKOMUPWRXTXWWYVZS[O[LZKYJWJULULWKWKV",
    3270: "  8G^_BEbFb R_B`BFb",
    3271: " 32JZZBXCUERHPKNOMSMXN\\O_Qb RSHQKOONTN\\ RZBWDTGRJQLPOOSN\\ RNTO]P`Qb",
    3272: " 32JZSBUEVHWLWQVUTYR\\O_LaJb RVHVPUUSYQ\\ RSBTDUGVP RVHUQTUSXRZP]M`Jb",
    3273: " 39J[TFSGUQTR RTFTR RTFUGSQTR ROIPIXOYO ROIYO ROIOJYNYO RYIXIPOOO RYIOO RYIYJONOO",
    3274: "  8F_JQ[Q[R RJQJR[R",
    3275: " 16F_RIRZSZ RRISISZ RJQ[Q[R RJQJR[R",
    3276: " 16F_JM[M[N RJMJN[N RJU[U[V RJUJV[V",
    3277: " 11MWUFTGRM RUGRM RUFVGRM",
    3278: " 22H\\PFOGMM RPGMM RPFQGMM RZFYGWM RZGWM RZF[GWM",
    3279: " 30KZSFQGPIPKQMSNUNWMXKXIWGUFSF RSFPIQMUNXKWGSF RUFQGPKSNWMXIUF",
    3301: " 62F^IHJIIJHIIGKFMFOGPHQKQOPRNTLUIV ROHPKPPOR RMFNGOJOPNSLU RLVOY RKVOZ RIVN[UV R\\G[H\\H\\G[FYFWGVHUJUYW[[W RWHVJVXXZ RYFXGWJWWYY",
    3302: "101E_GQGRHSJSLRLOKMIJIHKF RKOIK RJSKRKPIMHKHIIGKFNFPGQHRJRRQUOW RPHQJQT RNFOGPJPUOW RRISGUFWFYGZH[J\\K RYHZJ RWFXGYJZK\\K R\\KRP RYM[O\\R\\U[XYZV[S[PZJWIWHX RXNYN[P RVNYO[Q\\S RTZRZLWKW RZYXZUZRYNWKVIVHXHZI[JZIY",
    3303: " 79F^RHPFNFLGJJINIRJVLYNZQ[T[WZYY[W RLHKJJMJRKVMYPZ RNFMGLIKMKQLUMWOYRZUZXY[W RUFRHQIPKPLQNTPURUT RQKQLUPUQ RQIQJRLUNVPVRUTSURUPTOR RUFVGXHZH RUGVHWH RTGVIXIZH[G",
    3304: " 79E_HLHKIIKGNFRFUGWHYJ[M\\Q\\U[XYZV[S[PZJWIWHX RKHMGRGUHWIYK[N RTZRZLWKW RHKJIMHRHUIWJYL[O\\R RZYXZUZRYNWKVIVHXHZI[JZIY RPHMKLMLONSNU RMNMONQNR RMKMMOQOSNUMVKVJUJT",
    3305: " 95F^RHPFNFLGJJINIRJVLYNZQ[T[WZYY[W RLHKJJMJRKVMYPZ RNFMGLIKMKQLUMWOYRZUZXY[W RUFRHQIPKPLQNTPURUT RQKQLUPUQ RQIQJRLUNVPVRUTSURUPTOR RUFVGXHZH RUGVHWH RTGVIXIZH[G RUNYK RYKZL\\L RXLYMZM RWMXNZN\\L",
    3306: " 94F^MNKMJKJIKGNFQFTGXI RKHMGRGUH RJKKIMHRHXIZI[H[GZFYF RSHRIQKQMROVSWVWYV\\U]S^ RTPWSXVXYW[ RQMSOVQXSYVYYX[V]S^O^L]K\\JZJWLTLRKQ RL\\K[KWLU RO^M]L[LWMTMRLQJQIRIS RUPYL RYLZM\\M RXMYNZN RWNXOZO\\M",
    3307: " 99E_UJTHSGQFNFKGIJHNHRIUJWLYNZQ[T[WZYY[W\\T\\Q[NYL RKHJJIMIRJUKW RZW[U[QZNYM RNFLGKIJMJRKVLXNZ RWZYXZUZQYOWM RUFRHPJOLOMPOSQTSTU RPLPMTQTR RPJPKQMTOUQUSTURVQVOUNS RTOYLZJ R\\FZJ RYG]I R\\F[GYGZHZJ[I]I\\H\\F",
    3308: " 92F_RFPGNIMKMMNOPQQSQU RNLNMQQQR RNINKOMQORQRSQUPVNWLWJVIUHSHQIPJQIR RRFTHVHXG RQGSH RPGQHSIUIXG RRPYK RYK[N\\Q\\T[WYYVZR[ RXLZN[Q[UZW RVMWMYOZRZVYXXYVZ RVZTZRYPYNZM\\N^P_R_T^ RSZQZ RR[PZNZ",
    3309: " 83F_PPNPLOKNJLJJKHLGOFQFTGWJYK RLHNGRGTHUI RJJKIMHQHTIVJYK[K\\J\\H[GYG RJXKYJZIYIWJVLVNWPYR\\T^ RNXOYQ\\R] RLVMWNYP\\Q]S^V^X]Y\\ZZZWYUWRVPVO RYXYWVRVQ RX]Y[YYXWVTURUPWNYNZOZP",
    3310: " 83F_PPNPLOKNJLJJKHLGOFQFTGWJYK RLHNGRGTHUI RJJKIMHQHTIVJYK[K\\J\\H[GYG RJXKYJZIYIWJVLVNWPYR\\T^ RNXOYQ\\R] RLVMWNYP\\Q]S^V^X]Y\\ZZZWYUWRVPVO RYXYWVRVQ RX]Y[YYXWVTURUPWNYNZOZP",
    3311: " 81E_[KZIXGUFRFOGMILKLNMQPWPYN[ RMNMOPUPV RNHMJMMNOPSQVQXPZN[L[JZ RHVJZ RGYKW RHVHXGYIYJZJXKWIWHV RNONMOKQJTJVKXMYM RUKWM RRJTKULVN RYMPQ RUOYXZY[Y RTPXXZZ RSPWYY[\\X",
    3312: " 73G^ZSYTVTUSUQVOXLYJYH RVQVPYLYK RWTVSVRWPYNZLZJYHXGUFPFMGLHKJKLLNNQOSOTNV RLKLLOQOR RLHLJMLOOPQPSOUMWJY RMWOWRYUZXZZY RNXOXSZTZ RJYLXMXQZT[V[YZZY[W",
    3313: "128BbEQERFSHSJRJOIMGJGHIF RIOGK RHSIRIPGMFKFIGGIFKFMGOIPLPROUNWLYI[HZGZ RNIOLORNUMW RJZIYHY RKFMHNKNRMVLXKYJXIXF[ RNGPFRFTGVIWLWRVUUWSYQ[PZOZ RUIVLVRUV RRZQYPY RRFTHUKUSTWSYRXQXN[ RUHVGXFZF\\G]H^J_K R\\H]J RZF[G\\J]K_K R_K\\M[NZQZT[X][`X R\\N[P[T\\W^Z R_K]M\\O\\S]W_Y",
    3314: " 96D`GQGRHSJSLRLOKMIJIHKF RKOIK RJSKRKPIMHKHIIGKFNFPGRISLSRRUQWOYL[KZIZG[ RQIRKRRQUPWOX RMZKYIY RNFPHQKQRPVNYLXJXG[ RRHSGUFWFYGZH[J\\K RYHZJ RWFXGYJZK\\K R\\KYMXNWQWTXXZ[]X RYNXPXTYW[Z R\\KZMYOYSZW\\Y",
    3315: " 72D`PFNGLIKKKMMQMS RLLLMMOMP RLILKNONQMSLTJTISIR RPFQGWIZK[M\\P\\S[VZXXZU[R[OZIWHWGX RPGQHWJYKZL RPFPHQIWKYL[N\\P RSZQZKWJW RYYWZTZQYMWJVHVGXGZH[IZHY",
    3316: "100E`HQHRISKSMRMOLMJJJHLF RLOJK RKSLRLPJMIKIIJGLFOFQGRHSJSU RSWS\\R^P_M_L^L\\M[N\\M] RQHRJR\\Q^ ROFPGQJQU RQWQ\\P^O_ RSJXF RXFZI[K\\O\\R[UYXV[ RWGZK[N[O RVHXJZM[P[SZVYX RWYUVSU RQUOVMX RWZUWSVPV RV[TXSW RQWOWMX",
    3317: " 88D`PFNGLIKKKMMQMS RLLLMMOMP RLILKNONQMSLTJTISIR RPFQGWIZK[M\\P\\S[VZX RXZU[R[OZIWHWGX RPGQHWJYKZL RPFPHQIWKYL[N\\P RSZQZKWJW RXZTZQYMWJVHVGXGZH[IZHY RTXVVXV\\Z]Z RWWXW[Z RUWVWZ[\\[^Y",
    3318: " 96D`GQGRHSJSLRLOKMIJIHKF RKOIK RJSKRKPIMHKHIIGKFNFPGQHRJRVQXOZM[K[IZ RPHQJQVPX RNFOGPJPVOYM[ RGVIZ RFYJW RGVGXFYHYIZIXJWHWGV RRISGUFWFYGZH[J\\K RYHZJ RWFXGYJZK\\K R\\KRP RTOXYZ[]X RUOYX[Z RVNZX[Y\\Y",
    3319: " 83E`\\H[G\\F]G]I\\KZKVISHOHKIIK RYJVHSGOGLH R]I\\JZJVGSFOFLGJIIKHNHRIUJWLYNZQ[U[XZZY\\W]T]Q\\OZNWNUOSRQSOS RLXNYQZUZYY RIUKWMXPYUYYX[W\\V]T RXOWOSSRS R]Q[OYOWPUSSTQTOSNQNOOMQL",
    3320: " 81F_LNJMIKIIJGMFRFUGYJ[J\\I RJHLGRGUHXJ RIKJILHRHUIYK[K\\I\\G[FZG[H RUIRLQNQPSTSV RRORPSRSS RRLRNTRTTSVRWPWOVOT RJYKZJ[IZIXJVLVOWSYVZYZ[Y RLWMWSZUZ RIXJWKWMXQZT[W[ZZ\\X",
    3321: " 45G]JHKHLILWJX RKGMHMXPZ RIILFNHNWPYRY RJXKXMYO[RYVV RTHUHVIVYX[[X RUGWHWYYZ RSIVFYHXIXXYYZY",
    3322: "100D`GQGRHSJSLRLOKMIJIHKF RKOIK RJSKRKPIMHKHIIGKFNFPGQHRJRRQUOW RPHQJQT RNFOGPJPUOW RRISGUFWFYG[J\\K RYHZJ RWFXGYJZK\\K RZKXKWLWNXP[R\\T RXO[Q RWMXN[P\\R\\V[XYZW[S[PZJWIWHX RTZRZLWKW RZYXZUZRYNWKVIVHXHZI[JZIY",
    3323: "143BcEQERFSHSJRJOIMGJGHIF RIOGK RHSIRIPGMFKFIGGIFLFNGOHPJPNOQMTKV RNHOJOONR RLFMGNJNOMSKV RNGPFSFUG RWFTGSISMTPVSWUWWVY RTMTNWSWT RWFUGTITLUNWQXTXVWXUZS[O[MZKXIWGWFX RNZKWJW RQ[OZLWJVGVFXFZG[HZGY RWFZF\\G^J_K R\\H]J RZF[G\\J]K_K R]K[KZLZN[P^R_T R[O^Q RZM[N^P_R_W^Y]Z[[X[UZ RYZXZVY R^Y\\ZZZXYWX",
    3324: " 86F^KHMHOIPJQMQO RQQQUPXM[KZI[ RNZLYKY ROYNYLXI[ RMGPHQIRLRUSWUYWZ RIINFPGRISLSO RSQSTTWUXWYYY RQURXTZV[[X RSLTIWFYG[F RVGXHYH RUHVHXI[F RKSMOQO RSOWOYM RMPWP RKSMQQQ RSQWQYM",
    3325: " 74E_HQHRISKSMRMOLMJJJHLF RLOJK RKSLRLPJMIKIIJGLFOFQGRHSJSORRQTQUSWTW RQHRJRPQSPUSX ROFPGQJQPPTOVRYUV RSJ[F RYGYZX] RZGZXY[ R[F[VZZY\\W^T_P_M^K\\JZKYLZK[",
    3326: " 74F^NIOGQFTFVGWHXJXMWOVPTQ RQQOPNN RVHWIWNVO RTFUGVIVNUPTQ RMUNSORQQTQWRYTZVZZY\\W^T_P_N^KZJY RXTYVYZX\\ RTQWSXUX[W]V^T_ RO^N]LZKY RR_P^O]MZLYIYHZH\\I]J]",
    3401: " 46J[TMQNOONPMSMVNYO[UX RNVOYPZ RQNOPNSNUOXQZ RRNSOUPUYW[ZX RSNVPVXXZ RTMUNWOXO RWPXO RWPWXXYYY",
    3402: " 50J[LHMINK RTFQGOINKNXMY RPIOKOXRZ RTFRGQHPKPXRYSZ RMYNYPZQ[TZ RPPVMWOXRXUWXVYTZ RUNVOWQ RTNVPWSWUVXTZ",
    3403: " 27KXRNTPVOTMRNOPNRNWOYQ[UY RSNUO RPPOROWPYQZ RQOPQPVQXSZ",
    3404: " 47J[QFNINKOLSNVPWRWUVXTZ ROJOKSMVOWP ROHOIPJUMWOXRXUWXTZQ[ RRNNPNXMY ROPOXRZ RPOPXRYSZ RMYNYPZQ[",
    3405: " 27KXPUVQSMOPNRNWOYQ[UY RUQRN RPPOROWPYQZ RTRROQOPQPVQXSZ",
    3406: " 49LYXFWGUGSFQFPHPMOONP RVHTHRGQG RXFWHVITIRHQHPI RPKQMRNTOVOVP RNPPP RRPVP RPPPTQ` RSOPOQNQ[ RRPRTQ`",
    3407: " 53J[TMQNOONPMSMVNYO[UX RNWOYPZ RQNOPNSNUOXQZ RRNSOUPUXV[V]U_ RSNVPVZ RTMUNWOXO RWPXO RWPW\\V^U_S`P`N_M^M]N]N^",
    3408: " 50J[LHMINK RTFQGOINKNXMY RPIOKOYPZ RTFRGQHPKPXQYRY RMYOZP[SX RPPVMWOXSXWWZV\\T^Q` RUNVOWR RTNVQWTWWV[T^",
    3409: " 39MWRFQGQHRISHSGRF RQGSH RQHSG ROOPOQPQYS[VX RPNRORXTZ RNPQMRNTO RSPTO RSPSXTYUY",
    3410: " 45MWRFQGQHRISHSGRF RQGSH RQHSG ROOPOQPQ[P^O_M` RPNROR[Q] RNPQMRNTO RSPTO RSPS[R]P_M` RS[T]U^",
    3411: " 63KYNHOIPK RUFSGQIPKPMOONP RPPPXOY RRIQKQM RQOPOQMQXSZ RUFSHRKRO RRPRXSYTY ROYQZR[UX RRLVIWJWLUNSO RUJVKVLUN RROWOWP RNPPP RRPWP",
    3412: " 29MWOHPIQK RWFTGRIQKQXPY RSIRKRYTZ RWFUGTHSKSXTYUY RPYRZS[VX",
    3413: " 74E_GOHOIPIXHYJ[ RHNJPJXIYJZKYJX RFPIMKOKXLYJ[ RNNPOQQQXPYR[ RPNQORQRXQYRZSYRX RKPNNPMRNSPSXTYR[ RVNWOYPYY[[^X RWNZPZX\\Z RSPVNXMYN[O\\O R[P\\O R[P[X\\Y]Y",
    3414: " 49I[KOLOMPMXLYN[ RLNNPNXMYNZOYNX RJPMMOOOXPYN[ RRNSOUPUYW[ZX RSNVPVXXZ ROPRNTMUNWOXO RWPXO RWPWXXYYY",
    3415: " 41J[NPNXMY ROPOXRZ RQOPPPXRYSZ RMYNYPZQ[TZ RNPQOVMWOXRXUWXVYTZ RUNVOWQ RTNVPWSWUVXTZ",
    3416: " 57J[OJMLMNNQNXLZ RNYO` RNMNNOQO[ RNKNLONPQPXQXSYTZ RPYO` RSZQY RTZR[PY RNYLZ RPPVMWOXRXUWXVYTZ RUNVOWQ RTNVPWSWUVXTZ",
    3417: " 43J[TMQNOONPMSMVNYO[UX RNWOYPZ RQNOPNSNUOXQZ RRNSOUPUXV` RSNVPV[ RTMUNWOXO RWPXO RWPWXV`",
    3418: " 32KYNOOOPPPXOY RONQPQYSZ RMPPMRORXSYTY ROYQZR[UX RTNUPWOVMRO RUNVO",
    3419: " 42LWXFWGUGSFQFPHPMOONP RVHTHRGQG RXFWHVITIRHQHPI RPKRP RPPPTQ` RQOPOQNQ[ RRPRTQ` RNPPP",
    3420: " 37LXSIRLQNPONP RSISOVOVP RNPQP RSPVP RQPQXPY RROQORMRXTZ RSPSXTYUY RPYRZS[VX",
    3421: " 47I[KOLOMPMXLY RLNNPNXPZ RJPMMOOOXQYRZ RLYMYOZP[RZUX RVMTOUPUYW[ZX RVPWOVNUOVPVXXZ RVMXOWPWXXYYY",
    3422: " 47J[OKMMMONRNXMY RNNNOOROXRZ RNLNMOOPRPXRYSZ RMYNYPZQ[TZ RPPVMWOXRXUWXVYTZ RUNVOWQ RTNVPWSWUVXTZ",
    3423: " 72F_KKIMIOJRJXIYK[ RJNJOKRKXJYKZLYKX RJLJMKOLRLXMYK[ RONQORQRXQY RQNROSQSXVZ RLPONQMSNTPTXVYWZ RQYRYTZU[XZ RTPZM[O\\R\\T[XZYXZ RYNZO[Q RXNZP[S[UZXXZ",
    3424: " 44KZOOPOQPQXPXNYM[M]N_P`S`V_V^U^U_ RPNRPRXUZ RNPQMSOSXUYVZ RXYT[SZQYOYM[ RUNVPXOWMSO RVNWO",
    3425: " 47J[OKMMMONRNXMY RNNNOOROYQZ RNLNMOOPRPXQYRY RMYOZP[SX RPPVMWOXSXWWZV\\T^Q` RUNVOWR RTNVQWTWWV[T^",
    3426: " 43KYNPSMUNVPVRUTQV RSNUO RRNTOUQURTTSU RSUUWVYV]U_S`Q`O_N]N[OYQXWV RRVTWUY RQVTXUZU]T_S`",
    3427: " 61JZRMPNMPMRNU RNPNROT RPNOOORPT RPNROTOVNWMWKVJTJ RQNSN RRMTNVN RNUVRWUWWVYR[ RUSVUVXUY RTSUUUXTZ RTZRYOYL[ RSZQZ RR[PZNZL[",
    3428: " 78J[VFUGSGQFOFNHNMMOLP RTHRHPGOG RVFUHTIRIPHOHNI RNKPP RNPNTO` ROONOONO[ RPPPTO` RLPNP RPPUMWNXPXRWTSV RUNWO RTNVOWQWRVTUU RUUWVXXX[W]U_R` RUVWW RSVTVVWWYW\\V^",
    3429: " 62J[PIOLNNMOKP RPIPXQYO[ ROONOONOXNYOZPYOX RKPNPNXMYO[ RPPUMWNXPXRWTSV RUNWO RTNVOWQWRVTUU RUUWVXXX[W]U_R` RUVWW RSVTVVWWYW\\V^",
    3501: " 60G]LINGPFRFSGZW[X]X RQGRHYXZZ[YYX RNGPGQHXXYZZ[[[]X RLMMLOKPKQL RPLPM RMLOLPN RG[IYKXNXPY RJYNYOZ RG[JZMZN[PY RRJLX RNSVS",
    3502: "110F^HHJFMFOGQF RKGNG RHHJGLHOHQF RMKLLKNKOIOHPHRIQKQKW RLMLU RIPLP RMKMTLVKW RRIQJPLPU RQKQS RRIRRQTPU RRIXFZG[I[KYMUO RXGZIZK RVGXHYIYLWN RWNZP[R[X RYPZRZW RWNXOYQYX RJ[MYPXTXWY RLZOYTYVZ RJ[NZSZU[WYYX[X RUOUX RURYR RUUYU",
    3503: " 69E]NGLHJJILHOHSIVJXMZP[S[VZXYZW[U RJKINISKWNYQZTZWY RNGLIKKJNJRKUNXQYTYWXYW[U RPJPV RQJQT RRIRSQUPV RPJRIUFWGYGZF RTGVHXH RSHUIWIYHZF RWIWX",
    3504: " 72G^IFWFYGZIZX RKGWGYIYW RIFJGLHWHXIXX ROKNLMNMOKOJPJRKQMQMV RNMNT RKPNP ROKOSNUMV RI[LYOXSXVY RKZNYSYUZ RI[MZRZT[VYXXZX RRHRX RRMTNVNXM RRSTRVRXS",
    3505: " 94G]IHKFMFOGQF RLGNG RIHKGMHOHQF RNKMLLNLOJOIPIRJQLQLW RMMMU RJPMP RNKNTMVLW RQMRJSHTGVFXF[G RTHVGXGZH RRJSIUHWHYI[G RQURRSPTOVOXP RTPVPWQ RRRSQUQVRXP RK[NYRXWX[Y RMZPYWYZZ RK[OZVZY[[Y RQMQX",
    3506: " 91F]JHLFOFQGSF RMGPG RJHLGNHQHSF RPKOLNNNOLOKPKRLQNQNV ROMOT RLPOP RPKPSOUNV RSJSYRZQZMXKXIYG[ RTJTX RTPXP RPZOZMYJY RUIUOXO RXQUQUWTYP[N[LZJZG[ RSJUIXFZG\\G]F RWGYH[H RVHXIZI\\H]F RXIXW",
    3507: " 87E^NGLHJJILHOHRIUJWLYNZQ[U[XZZX[V[SZQYPWOUO RJKINISJV RNGLIKKJNJSKVLXNZ RYXZWZSYQ RU[WZXYYWYSXQWPUO RPJPW RQJQU RRIRTQVPW RPJRIUFWGYGZF RTGVHXH RSHUIWIYHZF RYHUOU[ RUSYS RUVYV",
    3508: "112F^HHJFMFOGQF RKGNG RHHJGLHOHQF RMKLLKNKOIOHPHRIQKQKW RLMLU RIPLP RMKMTLVKW RJ[MYPXSXUY RLZOYRYTZ RJ[NZQZS[UY RRIQJPLPU RQKQS RRIRRQTPU RRITGVFXFZG RWGXGYH RTGVGXIZG RUOWNYLZM[P[TZXX[ RXMYNZPZUYX RWNXNYPYUX[ RUOUY RURYR RUUYU",
    3509: " 67I\\LHNFQFTGVF ROGSG RLHNGQHTHVF RSKRLQNQOOONPNROQQQQV RRMRT ROPRP RSKSSRUQV RYHWJVMVXUZSZOXMXKYI[ RWKWW RRZQZOYLY RYHXJXVWXUZS[P[NZKZI[",
    3510: " 65H\\LHNFQFTGVF ROGSG RLHNGQHTHVF RSKRLQNQOOONPNROQQQQV RRMRT ROPRP RSKSSRUQV RYHWJVMVXUZ RWKWW RYHXJXVWXUZR[O[LZJXJVKULUMVLWKW RJVMV",
    3511: "115F^HHJFMFOGQF RKGNG RHHJGLHOHQF RMKLLKNKOIOHPHRIQKQKW RLMLU RIPLP RMKMTLVKW RJ[MYPXSXUY RLZNYRYTZ RJ[NZQZS[UY RRIQJPLPU RQKQS RRIRRQTPU RRITGVFXFZG RWGXGYH RTGVGXIZG RUOXLYM[N RWMYN[N R[NYQWSUU RWSYTZX[Z\\Z RYVZZ RWSXTYZZ[[[\\Z RUOUY",
    3512: " 85G]IHKFNFPGRF RLGOG RIHKGMHPHRF RNKMLLNLOJOIPIRJQLQLW RMMMU RJPMP RNKNTMVLW RK[NYRXWX[Y RMZPYWYZZ RK[OZVZY[[Y RSIRJQLQU RRKRS RSISRRTQU RSIUGWFYF[G RXGYGZH RUGWGYI[G RWGWX",
    3513: "107D`LJKKJMJOHOGPGRHQJQJU RKLKS RHPKP RLJLRKTJU RE[GYIXKXMYNYOX RHYKYMZ RE[GZJZL[M[NZOX RLJPFTJTWUYVY RPGSJSXRYSZTYSX RPPSP RNHOHRKROOO ROQRQRXQYS[VYWX RTJXF\\J\\W]Y^Y RXG[J[X]Z RXP[P RVHWHZKZOWO RWQZQZY\\[^Y ROHOX RWHWX",
    3514: " 84E^GIIGKFMFOGQJVUXXYY RMGOIPKVWYZ RIGKGMHOKTVVYWZY[ RVHXIZI\\H]F RWGYH[H RVHXFZG\\G]F RKOIOHPHRIQKQ RIPKP RG[IYKXNXPY RJYMYOZ RG[JZMZN[PY RKGKX RYIY[ RRLSMUNWNYM RKTMSQSST",
    3515: " 79E_NFLGJIIKHNHRIUJWLYNZQ[S[VZXYZW[U\\R\\N[KZIXGVFUGRIOJ RJJIMISJV RNFLHKJJMJSKVLXNZ RZV[S[MYIXH RVZXXYVZSZMYKWHUG ROJOW RPJPU RQJQTPVOW RUGUZ RUMWNXNZM RUSWRXRZS",
    3516: " 70H^KFLGMIMOKOJPJRKQMQMYJ[MZMbO` RMHNJN` RKPNP RKFMGNHOJO` ROKRIVFZJZX RVGYJYX RTHUHXKXY RRXUXXY RSYUYWZ RRZTZV[XYZX RRIR_ RRMTNVNXM RRSTRVRXS",
    3517: " 99E_NFLGJIIKHNHRIUJWLYNZP[T[VZXYZW[U\\R\\N[KZIXGVFUGRIOJ RJJIMISJV RNFLHKJJMJSKVLXNZ RZV[S[MYIXH RVZXXYVZSZMYKWHUG ROJOW RPJPU RQJQTPVOW RUGUZ RUMWNXNZM RUSWRXRZS RP[QZRZT[X`Za[a RT\\V_XaYa RRZS[VaXbZb[a",
    3518: "108F^HHJFMFOGQF RKGNG RHHJGLHOHQF RMKLLKNKOIOHPHRIQKQKW RLMLU RIPLP RMKMTLVKW RJ[MYPXRXUY RLZNYRYTZ RJ[NZQZS[UY RRIQJPLPU RQKQS RRIRRQTPU RRIUGWFYGZIZLYNXOTQRR RWGXGYIYMXN RUGWHXJXMWOTQ RTQVRWSZX[Y\\Y RWTYX[Z RTQVSXYZ[\\Y",
    3519: " 94G^UITHRGOF RVHTG RWGSFOFLGKHJJKLLMONWNYOZPZRYU RKKLLOMXMZN[O[QZS RKHKJLKOLYL[M\\O\\QYUU[ RIOJPLQUQVRVSUU RJQLRTRUS RIOIPJRLSSSUTUU RI[LYPXSXVY RKZNYRYUZ RI[MZRZU[ RWGUISL RRNPQ ROSMUKVJVJUKV",
    3520: " 71E]JJILHOHSIVKYMZP[S[VZXYZW[U RISJVLXNYQZTZWY RJJIMIQJTLWNXQYTYWXYW[U RHIIGKFOFUGYG[F RPGTHXH RHIIHKGNGTIWIYH[F RSIRJPKPV RQKQT RRJRSQUPV RWIWX",
    3521: " 89F^HHJFLFOGQF RKGNG RHHJGMHOHQF RKJJLIOISJVKXMZP[S[VZXYZ[\\Y RJSKVNYQZTZ RKJJNJQKTLVNXQYUYXX RUIQJPLPV RQKQT RRJRSQUPV RUIWHYFZG\\HZIZW[Y\\Y RYIZHYGXHYIYX[Z RWHXIXX RUIUY RUNXN RURXR",
    3522: " 72G^JFKGLILOJOIPIRJQLQLXJY RLHMJMX RJPMP RNYQYSZ RJFLGMHNJNXRXUY RJYMYPZR[UYXXZX RRJUIWHYFZG\\HZIZX RYIZHYGXHYIYW RWHXIXX RRJRX RRMTNVNXM RRSTRVRXS",
    3523: " 95E`HFIGJIJOHOGPGRHQJQJXHY RJHKJKX RHPKP RLYNYPZ RHFJGKHLJLXOXQY RHYKYNZO[QYTXVYW[YY\\X ROHRFTHTXWXYY RRGSHSX ROHQHRIRXQY RWYXZ RWHZF\\H\\X RZG[H[X RWHYHZIZXYY ROHOX RWHWX RONRN RORRR RWNZN RWRZR",
    3524: " 65G]HIJGLFNFOGWYXZZZ RMGNHVYWZ RJGLGMHUZV[X[ZZ\\X RWFYG[G\\F RWGXHZH RVHWIYI[H\\F RH[IYKXMXNY RJYLYMZ RH[IZKZM[ RWFSO RQRM[ RLPPP RSPXP",
    3525: " 86G^JFKGLILOJOIPIRJQLQLXJY RLHMJMX RJPMP RNYQYSZ RJFLGMHNJNXRXUY RJYMYPZR[UYXX RRJUIWHYFZG\\HZIZ^Y`WbUaQ`L` RYIZHYGXHYIYY RWHXIXXZ[ RXaV`S` RY`V_P_L` RRJRX RRMTNVNXM RRSTRVRXS",
    3526: " 57H\\XGWIROOSMWJ[ RVKNV RZFWJUNRRMXLZ RJHLFOGUGZF RKGOHSHWG RJHNIRIVHXG RLZNYRXVXZY RMZQYUYYZ RJ[OZUZX[ZY RMPQP RTPXP",
    3601: " 53J[PRNTMVMXNZP[RYUX RMVNXOYQZ RNTNVOXQYRY RNPPPSOUNVMXOWPWXXYYY RONNOQO RTOWOVNVYWZ RMOOMPNROUPUYW[YY RMORT",
    3602: " 44I[LHMJMXKY RNJMHNGNXQZ RLHOFOXQYRZ RKYMYOZP[RZUYWY ROPROTNUMVNXOYOWPWY RTNVOVX RROSOUPUY",
    3603: " 35JXNONXLYMYOZP[ ROOOYQZ RPOPXRYSYQZP[ RNORNTMUNWOXO RSNTOVO RPORNTPVPXO",
    3604: " 41IZRMPNMOMXKY RNONXQZ RRMOOOXQYRZ RKYMYOZP[RZUYWY RMHPFQIWOWY RPINHOGPIVOVX RMHUPUY",
    3605: " 32JXNONXLYMYOZP[ ROOOYQZ RPOPXRYSYQZP[ RNORNTMWQURPU RSNVQ RPORNUR",
    3606: " 41JWNHNXLYMYOZP[ ROHOYQZ RPHPXRYSYQZP[ RNHQGSFTGVHWH RRGSHUH RPHQGSIUIWH RKMNM RPMTM",
    3607: " 56I[MOMXKYLYNZO[PZRYUX RNPNYPZ ROOOXQYRY RMOOORNTMUNWOYOWPW\\V_TaRbQaO`M` RSNVPV\\ RSaQ`P` RRNSOUPUZV]V_ RTaS`Q_O_M`",
    3608: " 47I[LHMJMXKYLYNZO[ RNJMHNGNYPZ RLHOFOXQYO[ ROPROTNUMVNXOYOWPWYU[T] RTNVOVYU[ RROSOUPUYT]T`UbVbT`",
    3609: " 35MWRFPHRITHRF RRGQHSHRG RRMQNOOQPQYS[UY RRPSORNQORPRYSZ RRMSNUOSPSXTYUY",
    3610: " 39MWRFPHRITHRF RRGQHSHRG RRMQNOOQPQYS[T] RRPSORNQORPRYS[ RRMSNUOSPSYT]T`RbPbPaRb",
    3611: " 50IZLHMJMXKYLYNZO[ RNJMHNGNYPZ RLHOFOXQYO[ ROPRNTMVPSROU RSNUP RRNTQ RSRTSVXWYXY RSSTTUYVZ RRSSTTYV[XY",
    3612: " 22MWPHQJQXOYPYRZS[ RRJQHRGRYTZ RPHSFSXUYVYTZS[",
    3613: " 67E_GOHOIPIXGYHYJZK[ RINJOJYLZ RGOIMKOKXMYK[ RKPNOPNQMSOSXUYS[ RPNRORYTZ RNOOOQPQXPYRZS[ RSPVOXNYMZN\\O]O[P[X\\Y]Y RXNZOZY[Z RVOWOYPYY[[]Y",
    3614: " 45I[KOLOMPMXKYLYNZO[ RMNNONYPZ RKOMMOOOXQYO[ ROPROTNUMVNXOYOWPWXXYYY RTNVOVYWZ RROSOUPUYW[YY",
    3615: " 40I[MOMXKY RNPNXQZ ROOOXQYRZ RKYMYOZP[RZUYWY RMOOORNTMUNWOYOWPWY RSNVPVX RRNSOUPUY",
    3616: " 54I[LMMOMXKYMYMb RMNNONaO`N^ RNYOYQZ RLMNNOOOXQYRZ ROZP[RZUYWY ROZO^P`Mb ROPROTNUMVNXOYOWPWY RTNVOVX RROSOUPUY",
    3617: " 44I[MOMXKY RNPNYPZ ROOOXQYRY RKYLYNZO[PZRYUX RMOOORNTMUNWOYOWPWb RSNVPVaU`V^ RRNSOUPU^T`Wb",
    3618: " 38JXLOMONPNXLYMYOZP[ RMNOOOYQZ RLONMPOPXRYSYQZP[ RPOTMUNWOXO RSNTOVO RRNTPVPXO",
    3619: " 59JZMOMSOTUTWUWY RNONS RVUVY RPNOOOSQT RSTUUUYTZ RMOPNRMTNVNWM RQNSN RPNROTOVN RWYTZR[PZNZL[ RSZQZ RTZRYOYL[ RWMVOTROWL[",
    3620: " 28MWPHQJQXOYPYRZS[ RRJQHRGRYTZ RPHSFSXUYVYTZS[ RNMQM RSMVM",
    3621: " 47I[KOLOMPMXKY RLNNONYPZ RKOMMOOOXQYRY RKYLYNZO[PZRYUX RUMVNXOYOWPWXXYYY RTNVOVYWZ RUMSOUPUYW[YY",
    3622: " 36I[LMMOMXP[RYUXWX RMNNONXQZ RLMNNOOOWPXRY RUMVNXOYOWPWX RTNVOVW RUMSOUPUX",
    3623: " 57E_HMIOIXL[NYQX RINJOJXMZ RHMJNKOKWLXNY RQMOOQPQXT[VYYX[X RPNRORXUZ RQMRNTOSPSWTXVY RYMZN\\O]O[P[X RXNZOZW RYMWOYPYX",
    3624: " 59H[KOLONPOQSYTZV[XY RMNOOTYVZ RKOMMONPOTWUXWYXY RRSUMVNXNYM RUNVOWO RTOVPXOYM RQUN[MZKZJ[ RNZMYLY ROYMXKYJ[ RMTPT RSTVT",
    3625: " 60I[KOLOMPMXKY RLNNONYPZ RKOMMOOOXQYRY RKYLYNZO[PZRYUX RUMVNXOYOWPW\\V_TaRbQaO`M` RTNVOV\\ RSaQ`P` RUMSOUPUZV]V_ RTaS`Q_O_M`",
    3626: " 38I[XML[ RLONPQPTOXM RMNOOSO RLONMPNTNXM RL[PYSXVXXY RQYUYWZ RL[PZTZV[XY RNTVT",
    3700: " 42H\\LHLXJY RMIMXPZ RNHNXPYQZ RLHNHSGUF RSGTHVIVY RTGWIWX RUFVGXHZHXIXY RJYLYNZO[QZVYXY",
    3701: " 27H\\OHPIQKQXOY RQIPHQGRIRYTZ ROHRFSHSXUYVY ROYPYRZS[TZVY",
    3702: " 48H\\LHNHPGQFSGVHXH RPHRG RLHNIPIRHSG RVHVP RWIWO RXHXPQPNQLSKVK[ RK[OYSXVXZY RNZQYVYYZ RK[PZUZX[ZY",
    3703: " 57H\\LHMHOGPFRGVHXH ROHQG RLHNIPIRG RVHVO RWIWN RXHXOVOSPQQ RQPSQVRXRXY RWSWX RVRVY RKYMXOXQYRZ ROYQZ RKYMYOZP[RZVYXY",
    3704: " 41H\\UFKPKUTU RVUZU[V[TZU RLPLT RMNMU RTGTXRY RUJVHUGUYWZ RUFWHVJVXXYYY RRYSYUZV[WZYY",
    3705: " 53H\\LFLO RLFXF RMGVG RLHUHWGXF RVLUMSNOOLO RSNTNVOVY RUMWNWX RVLWMYNZNXOXY RKYMXOXQYRZ ROYQZ RKYMYOZP[RZVYXY",
    3706: " 59H\\LHLXJY RMIMXPZ RNHNXPYQZ RLHNHRGTFUGWHXH RSGUH RRGTIVIXH RNPOPSOUNVM RSOTOVPVY RUNWPWX RVMWNYOZOXPXY RJYLYNZO[QZVYXY",
    3707: " 38H\\KHMFPGUGZF RLGOHTHWG RKHOIRIVHZF RZFYHWKSOQRPUPXQ[ RRQQTQWRZ RUMSPRSRVSYQ[",
    3708: " 71H\\LILO RMJMN RNINO RLINISHUGVF RSHTHVIVO RUGWHWN RVFWGYHZHXIXO RLONOVRXR RXOVONRLR RLRLXJY RMSMXPZ RNRNXPYQZ RVRVY RWSWX RXRXY RJYLYNZO[QZVYXY",
    3709: " 60H\\LHLQJR RMIMROS RNHNQPRQR RLHNHSGUF RSGTHVIVY RTGWIWX RUFVGXHZHXIXY RJRKRMSNTOSQRUQVQ RKYMXOXQYRZ ROYQZ RKYMYOZP[RZVYXY",
    3710: " 11LXRXPZR[TZRX RRYQZSZRY",
    3711: " 14LXR^R\\PZRXSZS\\R^P_ RRYQZR[RY",
    3712: " 22LXRMPORPTORM RRNQOSORN RRXPZR[TZRX RRYQZSZRY",
    3713: " 25LXRMPORPTORM RRNQOSORN RR^R\\PZRXSZS\\R^P_ RRYQZR[RY",
    3714: " 30LXRFQGOHQIRT RRISHRGQHRIRT RRFSGUHSIRT RRXPZR[TZRX RRYQZSZRY",
    3715: " 51I[LJMHNGQFSFVGWHXJXLWNUPSQ RMJNH RVHWIWMVN RLJNKNIOGQF RSFUGVIVMUOSQ RRQRTSQQQRT RRXPZR[TZRX RRYQZSZRY",
    3716: " 14LXTFRGQIQKRMTKRIRG RRJRLSKRJ",
    3717: " 14LXRLRJPHRFSHSJRLPM RRGQHRIRG",
    3718: " 62E_YNZO[O\\N RXOYP[P RXPYQZQ[P\\N RYNST RRUL[HVNP ROOSKOFJLPRTXVZX[Z[[Z\\X RLZIV RRKOG RKLPQTWVYXZ[Z RMZIU RRLNG RKKQQUWVXXY[Y\\X",
    3719: " 60H\\PBP_ RTBT_ RTFVGWIWKYJXHWGTFPFMGKIKLLNOPURWSXUXXWZ RXJWH RLLMNOOUQWRXT RMYLW RMGLILKMMONUPXRYTYWXYWZT[P[MZLYKWMVMXNZP[",
    3720: "  8G^[BIbJb R[B\\BJb",
    3721: " 27KYUBSDQGOKNPNTOYQ]S`Ub RQHPKOOOUPYQ\\ RSDRFQIPOPUQ[R^S`",
    3722: " 27KYOBQDSGUKVPVTUYS]Q`Ob RSHTKUOUUTYS\\ RQDRFSITOTUS[R^Q`",
    3723: " 39JZRFQGSQRR RRFRR RRFSGQQRR RMINIVOWO RMIWO RMIMJWNWO RWIVINOMO RWIMO RWIWJMNMO",
    3724: "  8F_JQ[Q[R RJQJR[R",
    3725: " 16F_RIRZSZ RRISISZ RJQ[Q[R RJQJR[R",
    3726: " 16F_JM[M[N RJMJN[N RJU[U[V RJUJV[V",
    3727: " 11NWSFRGRM RSGRM RSFTGRM",
    3728: " 22I[NFMGMM RNGMM RNFOGMM RWFVGVM RWGVM RWFXGVM",
    3729: " 30KYQFOGNINKOMQNSNUMVKVIUGSFQF RQFNIOMSNVKUGQF RSFOGNKQNUMVISF",
    3801: " 52E_NHLIJKIMHPHSIUKV RJLIOISJU RNHLJKLJOJRKVKXJZH[ RVHXHXYVY RYHYY RZGZZ RHFKGQHVHZG\\F RJPXP RH[KZQYVYZZ\\[",
    3802: " 65E_LGLZ RMGMZ RPFNGNZP[ RHJJHLGPFUFXGZIZKYM RXHYIYKXM RUFWGXIXKWL RQUOTNRNPONPMSLVLYM[O\\Q\\T[WYYWZT[P[LZJYHW RZO[Q[UZW RVLYNZQZUYXWZ",
    3803: " 60E_\\F[HZJXHVGSFQFNGLHJJILHOHRIUJWLYNZQ[S[VZXYZW[Y\\[ R[HZMZT[Y RZKYJ RZNYKXIVG RJKINISJV RNGLIKKJNJSKVLXNZ RYWZV RVZXXYVZS",
    3804: " 46E_KGKZ RLGLZ RNFMGMZN[ RHKIIKGNFSFVGXHZJ[L\\O\\R[UZWXYVZS[N[KZIXHV RZK[N[SZV RVGXIYKZNZSYVXXVZ",
    3805: " 86E_\\F[HZJXHVGSFQFNGLHJJILHOHRIUJWLYNZQ[S[VZXYZW[Y\\[ R[HZMZT[Y RZKYJ RZMXIVG RJKINISJV RNGLIKKJNJSKVLXNZ RYWZV RVZXXYVZS RJPKONOUQXQZP RPPRQURWRYQ RMORRUSWSYRZP RZMYLXLWMXNYM",
    3806: " 69E_JHJZ RMGKHKY ROFMGLILYNY RHJJHLGOFSFVGXHYI\\F R\\F[HZLZO[S\\U RZIYK RVGXIYLZO RLPMOOOTPWPYO RQPTQVQXP RNOTRVRXQYOYLXKWKVLWMXL RH[JZNYSYYZ\\[",
    3807: " 90E_\\F[HZJXHVGSFQFNGLHJJILHOHRIUJWLYNZQ[T[VZXYYXZV[Y\\[ R[HZMZT[Y RZKYJ RZNYKXIVG RJKINISJV RNGLIKKJNJSKVLXNZ RXXYVYR RVZWYXVXQ RKSLRMSLTKTJS RJPKNMMOMRNUPWQ RKOMNONROTP RJPLOOOUQYQZP",
    3808: " 50E_JGJZH[ RKHKZ RNHLHLZ RHFJGNHSHYG\\F RLPMNOLRKVKYL[N\\Q\\T[UYV RZN[P[SZU RVKXLYMZOZSYVYXZZ\\[ RH[LZPZU[",
    3809: " 23E_QIQY RRJRX RSISY RHFLHPITIXH\\F RH[KZOYUYYZ\\[",
    3810: " 42E_TIVIVXUZS[ RWIWXVY RXHXY RHFLHPITIXH\\F RIOHQHUIXKZN[S[VZXYZW\\T RIUJXKY RHSJUKXLZN[",
    3811: " 70E_JGJZH[ RKHKZ RNHLHLZ RHFJGNHSHYG\\F RLPMNOLRKUKXLYMYOXPSRQSPTPUQVRUQT RWLXMXOWP RUKWMWOVPSR RSRVRYSZUZWYX RWSYUYW RSRVSXUYXZZ[[\\[ RH[LZPZU[",
    3812: " 45E_JGJZ RKHKY RNHLHLYNY R\\KZNYPXSXUYW[X RZOYRYUZW R\\K[MZQZT[X\\[ RHFJGNHSHYG\\F RH[JZNYSYYZ\\[",
    3813: " 68E_QIQY RRJRX RSISY RNYLWJVIUHRHMIJKHMGPFTFWGYH[J\\M\\R[UZVXWVY RJUIRIMJJ RLWKUJRJLKIMG RZJ[M[RZU RWGYIZLZRYUXW RHFLHPITIXH\\F RH[KZOYUYYZ\\[",
    3814: " 48E_JHJZH[ RLHKIKZ ROFMGLILZ RHJJHLGOFSFVGXHZJ[L\\O\\S[UYV RZK[N[RZU RVGXIYKZNZRYVYXZZ[[\\[ RH[LZPZU[",
    3815: " 54E_QFNGLHJJILHOHRIUJWLYNZQ[S[VZXYZW[U\\R\\O[LZJXHVGSFQF RJKINISJV RNGLIKKJNJSKVLXNZ RZV[S[NZK RVZXXYVZSZNYKXIVG",
    3816: " 51E_JIJZ RMHKJKY RQFOGMILKLYNY RHKJINGQFTFWGYH[J\\M\\O[RYTVURUOTMRLO RZJ[L[PZR RWGYIZLZPYSVU RH[JZNYSYYZ\\[",
    3817: " 74E_QFNGLHJJILHOHRIUJWLYNZQ[S[VZXYZW[U\\R\\O[LZJXHVGSFQF RJKINISJV RNGLIKKJNJSKVLXNZ RZV[S[NZK RVZXXYVZSZNYKXIVG RJSKUNVTW[W\\X\\Z[[[Z\\Y RPWRW RKUNWQXSXTW",
    3818: " 69E_JIJZH[ RKIKZ RLHLZ RHKJILHNGQFUFYG[I\\K\\N[PZQ RYHZI[K[NZP RUFWGYIZKZOYQ RXRUSRSPRPPROUOXPZR\\U\\W[XZX RXQYR[V[WZT RTOVPXRYTZX[Z\\[ RH[LZPZU[",
    3819: " 94E_TFZG\\F[H[JYHWGTFPFMGJJIMIOJRLTOURUTTUSVQVP R[GZH[J RJPKRLSOTRTTS RKIJKJNKPMRPSRSTRVPWOXO RLQMQNPPNRMUMWNYPZRZUYXWZ RPMRLULXMZO[R[UZW RIWJYIZ RNPNOOMPLRKUKXL[O\\R\\T[WYYWZT[P[MZKYIWIYH[JZP[",
    3820: " 66E_QHMHKIJJILHOHSIVJXKYMZP[S[VZXYZW[U\\R\\N[KYIWH RUHTITKULVKUJ RISJVLXNYQZTZWY RJJINIQJTLWNXQYTYWXYW[T\\R RHFKI RKHLG RIGJGKFMGQHWHZG\\F",
    3821: " 51E_LHJJILHOHRIUJWLYNZQ[U[XZZY RKJJLIOISJV RKILJLKKMJPJSKVLXNZ RVHXHXXWZU[ RYHYXXY RZGZY\\[ RHFKGQHVHZG\\F",
    3822: " 31E_HFR[ RIGJHQWRY RJGKHRWSX R\\FR[ RWNUS RYLUQTTTV RHFJGOHUHZG\\F",
    3823: " 67E_LHJJILHOHRIUJWLYNZQ[S[VZXYZW[U\\R\\O[LZJXH RJLIOIRJUKW RJJKKKLJOJRKVLXNZ RYWZU[R[OZL RVZXXYVZRZOYLYKZJ RQIQ[ RRJRZ RSIS[ RHFLHPITIXH\\F",
    3824: " 41E_HFXYYZ RIGKHZZ RLH\\[ R\\FSP RQRJZ RPSMULW RQRMTLUKWKY RHFLHPITIXH\\F RH[JZNYSYYZ\\[",
    3825: " 47E_XHXZ RYHYY RZGZY RKHIJHMHPISKUMVPWSWVVXU RLUOVUV RHPIRKTNUTUVV RHFLHPITIXH\\F RHWJYLZP[T[XZ\\X",
    3826: " 73E_HFIGKHNHSFVFYGZIZKYM RXGYIYKXM RVFWGXIXL RXNTOROPNPLRKTKXL RTKVLWMVNTO RYM[O\\R\\T[WYYWZT[P[MZKYIWHTHRIOJNLMNMPNPPOQNPOO RXMZO[Q[UZW RXNYOZQZUYXWZ",
    3901: " 42J[PQMTMXP[TY RNTNXPZ ROROWRZ RRSMNNMONNO RONSNUMWOWXXY RUNVOVXUYVZWYVX RSNUPUXTYV[XY",
    3902: " 31IZNHLFMJMXP[UYWX RNHNXPZ RNHPFOJOWRZ ROOTMWPWX RTNVPVX RRNUQUY",
    3903: " 23KWNPNYP[RY ROPOYPZ RPOPXQYRY RNPTMVOTPRN RSNUO",
    3904: " 32JZRMMPMXP[RZUYWY RNPNXPZ ROOOWRZ RPIPFQIWPWY RPIVPVX RPIMIPJUPUY",
    3905: " 25KXNPNYP[RY ROPOYPZ RPOPXQYRY RNPTMWQPU RSNVQ RRNUR",
    3906: " 32KWOIOXNYP[ RPIPXOYPZQYPX RQHQXRYP[ ROIUFWHUISG RTGVH RLMOM RQMUM",
    3907: " 41J[MPMXP[UY RNPNXPZ ROOOWRZ RMPOOTMWPW]V_U`SaQaO`MaObQa RTNVPV]U_ RPaNa RRNUQU^T`Sa",
    3908: " 42I[NHLFMJMXLYN[ RNHNXMYNZOYNX RNHPFOJOXPYN[ ROORNTMWPWYT]T`UbVbT` RTNVPVYU[ RRNUQUZT]",
    3909: " 37MWRFPHRJTHRF RRGQHRISHRG RRMPOQPQXPYR[ RRPSORNQORPRXQYRZSYRX RRMTOSPSXTYR[",
    3910: " 37MWRFPHRJTHRF RRGQHRISHRG RRMPOQPQYT] RRPSORNQORPRYS[ RRMTOSPSZT]T`RbPaPbRb",
    3911: " 51IZNHLFMJMXLYN[ RNHNXMYNZOYNX RNHPFOJOXPYN[ ROPRNTMVPSROU RSNUP RRNTQ RRSSTTYV[XY RSSTUUYVZ RSRTSVXWYXY",
    3912: " 21MWRHPFQJQXPYR[ RRHRXQYRZSYRX RRHTFSJSXTYR[",
    3913: " 66E_GOHOIPIXHYJ[ RINJOJXIYJZKYJX RGOIMKOKXLYJ[ RKONNPMSOSXTYR[ RPNRORXQYRZSYRX RNNQPQXPYR[ RSOVNXM[O[X\\YZ[ RXNZOZXYYZZ[YZX RVNYPYXXYZ[",
    3914: " 44I[KOLOMPMXLYN[ RMNNONXMYNZOYNX RKOMMOOOXPYN[ ROORNTMWOWXXYV[ RTNVOVXUYVZWYVX RRNUPUXTYV[",
    3915: " 28JZMPMXP[UYWX RNPNXPZ ROOOWRZ RMPOOTMWPWX RTNVPVX RRNUQUY",
    3916: " 47IZLMMOMXKYMYM_LbN` RNON` RLMNNOOOXQYRZ RNYOYQZ ROZP[UYWX ROZO_PbN` ROORNTMWPWX RTNVPVX RRNUQUY",
    3917: " 31J[MPMXP[UY RNPNXPZ ROOOWRZ RMPOOTMWPW_XbV` RTNVPV` RRNUQU_TbV`",
    3918: " 31KXMONOOPOXNYP[ RONPOPXOYPZQYPX RMOOMQOQXRYP[ RQOUMWOUPSN RTNVO",
    3919: " 41JZMPMSOUURWTWX RNPNSOT ROOOSPT RUSVTVX RTSUTUY RMPSMVNTOQN RRNUN RWXQ[MYOXSZ ROYQZ",
    3920: " 27MWRHPFQJQXPYR[ RRHRXQYRZSYRX RRHTFSJSXTYR[ RNMQM RSMVM",
    3921: " 40I[KOLOMPMYP[UY RMNNONYPZ RKOMMOOOXRZ RVMXOWPWXXYYY RVPWOVNUOVPVYWZ RVMTOUPUYW[YY",
    3922: " 36I[LMMOMXQ[SYWW RMNNONXQZ RLMNNOOOWRYSY RVMXOWPWW RVPWOVNUOVPVW RVMTOUPUX",
    3923: " 59E_HMIOIXM[OYQX RINJOJXMZ RHMJNKOKWNYOY RRMPOQPQXU[WY[W RRPSORNQORPRXUZ RRMTOSPSWVYWY RZM\\O[P[W RZP[OZNYOZPZW RZMXOYPYX",
    3924: " 39I[LONPUZV[XY RMNOOUYWZ RLONMONVXXY RXMVMVOXOXMVOSS RQUNYL[N[NYLYL[ RNTQT RSTVT",
    3925: " 49I[KOLOMPMYP[UY RMNNONYPZ RKOMMOOOXRZ RVMXOWPW]V_U`SaQaO`MaObQa RVPWOVNUOVPV^U_ RPaNa RVMTOUPU^T`Sa",
    3926: " 43L[RNOPOORNTMWOWSRU RTNVOVS RRNUPUSTT RRUWWW]V_U`SaQaO`MaObQa RVWV^U_ RPaNa RTVUWU^T`Sa"
  };

  // src/core/hfmath/symbols.js
  var SYMB = {
    "\\frac": { glyph: 0, arity: 2, flags: { frac: true } },
    "\\dfrac": { glyph: 0, arity: 2, flags: { frac: true } },
    "\\tfrac": { glyph: 0, arity: 2, flags: { frac: true } },
    "\\binom": { glyph: 0, arity: 2, flags: { binom: true } },
    "\\dbinom": { glyph: 0, arity: 2, flags: { binom: true } },
    "\\tbinom": { glyph: 0, arity: 2, flags: { binom: true } },
    "\\overset": { glyph: 0, arity: 2, flags: { above: true } },
    "\\stackrel": { glyph: 0, arity: 2, flags: { above: true } },
    "\\underset": { glyph: 0, arity: 2, flags: { below: true } },
    "\\xrightarrow": { glyph: 0, arity: 1, flags: { xarrow: true, opt: true } },
    "\\xleftarrow": { glyph: 0, arity: 1, flags: { xarrow: true, opt: true, left: true } },
    "\\operatorname": { glyph: 0, arity: 1, flags: {} },
    "\\operatorname*": { glyph: 0, arity: 1, flags: { big: true } },
    "\\sqrt": { glyph: 2267, arity: 1, flags: { opt: true, xfl: true, yfl: true } },
    "^": { glyph: 0, arity: 1, flags: {} },
    "_": { glyph: 0, arity: 1, flags: {} },
    "(": { glyph: 2221, arity: 0, flags: { yfl: true } },
    ")": { glyph: 2222, arity: 0, flags: { yfl: true } },
    "[": { glyph: 2223, arity: 0, flags: { yfl: true } },
    "]": { glyph: 2224, arity: 0, flags: { yfl: true } },
    "\\langle": { glyph: 2227, arity: 0, flags: { yfl: true } },
    "\\rangle": { glyph: 2228, arity: 0, flags: { yfl: true } },
    "|": { glyph: 2229, arity: 0, flags: { yfl: true } },
    "\\|": { glyph: 2230, arity: 0, flags: { yfl: true } },
    "\\{": { glyph: 2225, arity: 0, flags: { yfl: true } },
    "\\}": { glyph: 2226, arity: 0, flags: { yfl: true } },
    "\\lparen": { glyph: 2221, flags: { yfl: true } },
    "\\rparen": { glyph: 2222, flags: { yfl: true } },
    "\\lbrack": { glyph: 2223, flags: { yfl: true } },
    "\\rbrack": { glyph: 2224, flags: { yfl: true } },
    "\\lbrace": { glyph: 2225, flags: { yfl: true } },
    "\\rbrace": { glyph: 2226, flags: { yfl: true } },
    "\\lvert": { glyph: 2229, flags: { yfl: true } },
    "\\rvert": { glyph: 2229, flags: { yfl: true } },
    "\\vert": { glyph: 2229, flags: { yfl: true } },
    "\\lVert": { glyph: 2230, flags: { yfl: true } },
    "\\rVert": { glyph: 2230, flags: { yfl: true } },
    "\\Vert": { glyph: 2230, flags: { yfl: true } },
    "\\lfloor": { glyph: 5051, flags: { yfl: true } },
    "\\rfloor": { glyph: 5052, flags: { yfl: true } },
    "\\lceil": { glyph: 5053, flags: { yfl: true } },
    "\\rceil": { glyph: 5054, flags: { yfl: true } },
    "\\backslash": { glyph: 5055, flags: { yfl: true } },
    "\\#": { glyph: 2275, arity: 0, flags: {} },
    "\\$": { glyph: 2274, arity: 0, flags: {} },
    "\\&": { glyph: 2273, arity: 0, flags: {} },
    "\\%": { glyph: 2271, arity: 0, flags: {} },
    /* semantics*/
    "\\begin": { glyph: 0, arity: 1, flags: {} },
    "\\end": { glyph: 0, arity: 1, flags: {} },
    "\\left": { glyph: 0, arity: 1, flags: {} },
    "\\right": { glyph: 0, arity: 1, flags: {} },
    "\\middle": { glyph: 0, arity: 1, flags: {} },
    "\\big": { glyph: 0, arity: 1, size: 1.2, flags: {} },
    "\\bigl": { glyph: 0, arity: 1, size: 1.2, flags: {} },
    "\\bigr": { glyph: 0, arity: 1, size: 1.2, flags: {} },
    "\\bigm": { glyph: 0, arity: 1, size: 1.2, flags: {} },
    "\\Big": { glyph: 0, arity: 1, size: 1.6, flags: {} },
    "\\Bigl": { glyph: 0, arity: 1, size: 1.6, flags: {} },
    "\\Bigr": { glyph: 0, arity: 1, size: 1.6, flags: {} },
    "\\Bigm": { glyph: 0, arity: 1, size: 1.6, flags: {} },
    "\\bigg": { glyph: 0, arity: 1, size: 2, flags: {} },
    "\\biggl": { glyph: 0, arity: 1, size: 2, flags: {} },
    "\\biggr": { glyph: 0, arity: 1, size: 2, flags: {} },
    "\\biggm": { glyph: 0, arity: 1, size: 2, flags: {} },
    "\\Bigg": { glyph: 0, arity: 1, size: 2.5, flags: {} },
    "\\Biggl": { glyph: 0, arity: 1, size: 2.5, flags: {} },
    "\\Biggr": { glyph: 0, arity: 1, size: 2.5, flags: {} },
    "\\Biggm": { glyph: 0, arity: 1, size: 2.5, flags: {} },
    /* operators*/
    "\\cdot": { glyph: 2236, arity: 0, flags: {} },
    "\\pm": { glyph: 2233, arity: 0, flags: {} },
    "\\mp": { glyph: 2234, arity: 0, flags: {} },
    "\\times": { glyph: 2235, arity: 0, flags: {} },
    "\\div": { glyph: 2237, arity: 0, flags: {} },
    "\\leqq": { glyph: 2243, arity: 0, flags: {} },
    "\\geqq": { glyph: 2244, arity: 0, flags: {} },
    "\\leq": { glyph: 2243, arity: 0, flags: {} },
    "\\geq": { glyph: 2244, arity: 0, flags: {} },
    "\\propto": { glyph: 2245, arity: 0, flags: {} },
    "\\sim": { glyph: 2246, arity: 0, flags: {} },
    "\\equiv": { glyph: 2240, arity: 0, flags: {} },
    "\\dagger": { glyph: 2277, arity: 0, flags: {} },
    "\\ddagger": { glyph: 2278, arity: 0, flags: {} },
    "\\ell": { glyph: 662, arity: 0, flags: {} },
    "\\otimes": { glyph: 5035, flags: {} },
    "\\ominus": { glyph: 5036, flags: {} },
    "\\oslash": { glyph: 5037, flags: {} },
    "\\uplus": { glyph: 5038, flags: {} },
    "\\parallel": { glyph: 5039, flags: {} },
    "\\nparallel": { glyph: 5040, flags: {} },
    "\\nmid": { glyph: 5041, flags: {} },
    "\\ll": { glyph: 5042, flags: {} },
    "\\gg": { glyph: 5043, flags: {} },
    "\\cong": { glyph: 5044, flags: {} },
    "\\asymp": { glyph: 5045, flags: {} },
    "\\prec": { glyph: 5046, flags: {} },
    "\\succ": { glyph: 5047, flags: {} },
    "\\preceq": { glyph: 5048, flags: {} },
    "\\succeq": { glyph: 5049, flags: {} },
    "\\vdash": { glyph: 5056, flags: {} },
    "\\dashv": { glyph: 5057, flags: {} },
    "\\models": { glyph: 5058, flags: {} },
    /* ellipses: dots selects the baseline or centered form from its context. */
    "\\dots": { glyph: 5030, flags: {} },
    "\\ldots": { glyph: 5030, flags: {} },
    "\\cdots": { glyph: 5031, flags: {} },
    "\\vdots": { glyph: 5032, flags: {} },
    "\\ddots": { glyph: 5033, flags: {} },
    /* accents*/
    "\\vec": { glyph: 2261, arity: 1, flags: { hat: true, xfl: true, yfl: true } },
    "\\overrightarrow": { glyph: 2261, arity: 1, flags: { hat: true, xfl: true, yfl: true } },
    "\\overleftarrow": { glyph: 2263, arity: 1, flags: { hat: true, xfl: true, yfl: true } },
    "\\bar": { glyph: 2231, arity: 1, flags: { hat: true, xfl: true } },
    "\\overline": { glyph: 2231, arity: 1, flags: { hat: true, xfl: true } },
    "\\widehat": { glyph: 2247, arity: 1, flags: { hat: true, xfl: true, yfl: true } },
    "\\hat": { glyph: 2247, arity: 1, flags: { hat: true } },
    "\\acute": { glyph: 2248, arity: 1, flags: { hat: true } },
    "\\grave": { glyph: 2249, arity: 1, flags: { hat: true } },
    "\\breve": { glyph: 2250, arity: 1, flags: { hat: true } },
    "\\tilde": { glyph: 2246, arity: 1, flags: { hat: true } },
    "\\underline": { glyph: 2231, arity: 1, flags: { mat: true, xfl: true } },
    "\\dot": { glyph: 2236, arity: 1, flags: { hat: true } },
    "\\ddot": { glyph: 5034, arity: 1, flags: { hat: true } },
    "\\check": { glyph: 5059, arity: 1, flags: { hat: true } },
    "\\mathring": { glyph: 5060, arity: 1, flags: { hat: true } },
    "\\widetilde": { glyph: 2246, arity: 1, flags: { hat: true, xfl: true, yfl: true } },
    "\\overleftrightarrow": { glyph: 5015, arity: 1, flags: { hat: true, xfl: true, yfl: true } },
    "\\boxed": { glyph: 5050, arity: 1, flags: { xfl: true, yfl: true } },
    "\\overbrace": { glyph: 0, arity: 1, flags: { group: true, brace: true } },
    "\\underbrace": { glyph: 0, arity: 1, flags: { group: true, brace: true, under: true } },
    "\\overparen": { glyph: 0, arity: 1, flags: { group: true } },
    "\\underparen": { glyph: 0, arity: 1, flags: { group: true, under: true } },
    "\\not": { glyph: 2220, arity: 1, flags: {} },
    "\\neq": { glyph: 2239, arity: 0, flags: {} },
    "\\ne": { glyph: 2239, arity: 0, flags: {} },
    "\\le": { glyph: 2243, flags: {} },
    "\\ge": { glyph: 2244, flags: {} },
    "\\approx": { glyph: 5011, flags: {} },
    "\\simeq": { glyph: 5012, flags: {} },
    "\\forall": { glyph: 5e3, flags: {} },
    "\\nexists": { glyph: 5001, flags: {} },
    "\\notin": { glyph: 5002, flags: {} },
    "\\ni": { glyph: 5003, flags: {} },
    "\\owns": { glyph: 5003, flags: {} },
    "\\emptyset": { glyph: 5004, flags: {} },
    "\\varnothing": { glyph: 5004, flags: {} },
    "\\subseteq": { glyph: 5005, flags: {} },
    "\\supseteq": { glyph: 5006, flags: {} },
    "\\nsubseteq": { glyph: 5007, flags: {} },
    "\\nsupseteq": { glyph: 5008, flags: {} },
    "\\land": { glyph: 5009, flags: {} },
    "\\wedge": { glyph: 5009, flags: {} },
    "\\lor": { glyph: 5010, flags: {} },
    "\\vee": { glyph: 5010, flags: {} },
    "\\neg": { glyph: 5013, flags: {} },
    "\\lnot": { glyph: 5013, flags: {} },
    "\\setminus": { glyph: 5014, flags: {} },
    "\\smallsetminus": { glyph: 5014, flags: {} },
    "\\exists": { glyph: 2279, arity: 0, flags: {} },
    "\\in": { glyph: 2260, arity: 0, flags: {} },
    "\\subset": { glyph: 2256, arity: 0, flags: {} },
    "\\supset": { glyph: 2258, arity: 0, flags: {} },
    "\\cup": { glyph: 2257, arity: 0, flags: {} },
    "\\cap": { glyph: 2259, arity: 0, flags: {} },
    "\\infty": { glyph: 2270, arity: 0, flags: {} },
    "\\partial": { glyph: 2265, arity: 0, flags: {} },
    "\\nabla": { glyph: 2266, arity: 0, flags: {} },
    "\\aleph": { glyph: 2077, arity: 0, flags: {} },
    "\\wp": { glyph: 2190, arity: 0, flags: {} },
    "\\therefore": { glyph: 740, arity: 0, flags: {} },
    "\\mid": { glyph: 2229, arity: 0, flags: {} },
    "\\sum": { glyph: 2402, arity: 0, flags: { big: true } },
    "\\prod": { glyph: 2401, arity: 0, flags: { big: true } },
    "\\bigoplus": { glyph: 2284, arity: 0, flags: { big: true } },
    "\\bigodot": { glyph: 2281, arity: 0, flags: { big: true } },
    "\\bigotimes": { glyph: 5035, flags: { big: true, xfl: true, yfl: true } },
    "\\bigcup": { glyph: 2257, flags: { big: true, xfl: true, yfl: true } },
    "\\bigcap": { glyph: 2259, flags: { big: true, xfl: true, yfl: true } },
    "\\bigvee": { glyph: 5010, flags: { big: true, xfl: true, yfl: true } },
    "\\bigwedge": { glyph: 5009, flags: { big: true, xfl: true, yfl: true } },
    "\\biguplus": { glyph: 5038, flags: { big: true, xfl: true, yfl: true } },
    "\\int": { glyph: 2412, arity: 0, flags: { yfl: true, integral: true } },
    "\\oint": { glyph: 2269, arity: 0, flags: { yfl: true, integral: true } },
    "\\iint": { glyph: 5020, flags: { yfl: true, integral: true } },
    "\\iiint": { glyph: 5021, flags: { yfl: true, integral: true } },
    "\\iiiint": { glyph: 5022, flags: { yfl: true, integral: true } },
    "\\oplus": { glyph: 1284, arity: 0, flags: {} },
    "\\odot": { glyph: 1281, arity: 0, flags: {} },
    "\\perp": { glyph: 738, arity: 0, flags: {} },
    "\\angle": { glyph: 739, arity: 0, flags: {} },
    "\\triangle": { glyph: 842, arity: 0, flags: {} },
    "\\Box": { glyph: 841, arity: 0, flags: {} },
    "\\rightarrow": { glyph: 2261, arity: 0, flags: {} },
    "\\to": { glyph: 2261, arity: 0, flags: {} },
    "\\leftarrow": { glyph: 2263, arity: 0, flags: {} },
    "\\gets": { glyph: 2263, arity: 0, flags: {} },
    "\\leftrightarrow": { glyph: 5015, flags: {} },
    "\\Rightarrow": { glyph: 5016, flags: {} },
    "\\implies": { glyph: 5016, flags: {} },
    "\\Leftarrow": { glyph: 5017, flags: {} },
    "\\impliedby": { glyph: 5017, flags: {} },
    "\\Leftrightarrow": { glyph: 5018, flags: {} },
    "\\iff": { glyph: 5018, flags: {} },
    "\\mapsto": { glyph: 5019, flags: {} },
    "\\circ": { glyph: 902, arity: 0, flags: {} },
    "\\bigcirc": { glyph: 904, arity: 0, flags: {} },
    "\\bullet": { glyph: 828, arity: 0, flags: {} },
    "\\star": { glyph: 856, arity: 0, flags: {} },
    "\\diamond": { glyph: 743, arity: 0, flags: {} },
    "\\ast": { glyph: 728, arity: 0, flags: {} },
    /* verbatim symbols*/
    "\\log": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\ln": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\exp": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\mod": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\lim": { glyph: 0, arity: 0, flags: { txt: true, big: true } },
    "\\det": { glyph: 0, flags: { txt: true } },
    "\\gcd": { glyph: 0, flags: { txt: true, big: true } },
    "\\max": { glyph: 0, flags: { txt: true, big: true } },
    "\\min": { glyph: 0, flags: { txt: true, big: true } },
    "\\sup": { glyph: 0, flags: { txt: true, big: true } },
    "\\inf": { glyph: 0, flags: { txt: true, big: true } },
    "\\limsup": { glyph: 0, text: "lim sup", flags: { txt: true, big: true } },
    "\\liminf": { glyph: 0, text: "lim inf", flags: { txt: true, big: true } },
    "\\arg": { glyph: 0, flags: { txt: true } },
    "\\ker": { glyph: 0, flags: { txt: true } },
    "\\dim": { glyph: 0, flags: { txt: true } },
    "\\deg": { glyph: 0, flags: { txt: true } },
    "\\Pr": { glyph: 0, flags: { txt: true, big: true } },
    "\\sin": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\cos": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\tan": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\csc": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\sec": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\cot": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\sinh": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\cosh": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\tanh": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\csch": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\sech": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\coth": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\arcsin": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\arccos": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\arctan": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\arccsc": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\arcsec": { glyph: 0, arity: 0, flags: { txt: true } },
    "\\arccot": { glyph: 0, arity: 0, flags: { txt: true } },
    /* font modes*/
    "\\text": { glyph: 0, arity: 1, flags: {} },
    "\\mathnormal": { glyph: 0, arity: 1, flags: {} },
    "\\mathrm": { glyph: 0, arity: 1, flags: {} },
    "\\mathit": { glyph: 0, arity: 1, flags: {} },
    "\\mathbf": { glyph: 0, arity: 1, flags: {} },
    "\\mathsf": { glyph: 0, arity: 1, flags: {} },
    "\\mathtt": { glyph: 0, arity: 1, flags: {} },
    "\\mathfrak": { glyph: 0, arity: 1, flags: {} },
    "\\mathcal": { glyph: 0, arity: 1, flags: {} },
    "\\mathbb": { glyph: 0, arity: 1, flags: {} },
    "\\mathscr": { glyph: 0, arity: 1, flags: {} },
    "\\rm": { glyph: 0, arity: 1, flags: {} },
    "\\it": { glyph: 0, arity: 1, flags: {} },
    "\\bf": { glyph: 0, arity: 1, flags: {} },
    "\\sf": { glyph: 0, arity: 1, flags: {} },
    "\\tt": { glyph: 0, arity: 1, flags: {} },
    "\\frak": { glyph: 0, arity: 1, flags: {} },
    "\\cal": { glyph: 0, arity: 1, flags: {} },
    "\\bb": { glyph: 0, arity: 1, flags: {} },
    "\\scr": { glyph: 0, arity: 1, flags: {} },
    "\\quad": { glyph: 0, arity: 0, flags: {} },
    "\\qquad": { glyph: 0, flags: {} },
    "\\enspace": { glyph: 0, flags: {} },
    "\\enskip": { glyph: 0, flags: {} },
    "\\thinspace": { glyph: 0, flags: {} },
    "\\medspace": { glyph: 0, flags: {} },
    "\\thickspace": { glyph: 0, flags: {} },
    "\\negthinspace": { glyph: 0, flags: {} },
    "\\,": { glyph: 0, arity: 0, flags: {} },
    "\\.": { glyph: 0, arity: 0, flags: {} },
    "\\;": { glyph: 0, arity: 0, flags: {} },
    "\\!": { glyph: 0, arity: 0, flags: {} },
    /* greek letters*/
    "\\alpha": { glyph: 2127, flags: {} },
    "\\beta": { glyph: 2128, flags: {} },
    "\\gamma": { glyph: 2129, flags: {} },
    "\\delta": { glyph: 2130, flags: {} },
    "\\varepsilon": { glyph: 2131, flags: {} },
    "\\zeta": { glyph: 2132, flags: {} },
    "\\eta": { glyph: 2133, flags: {} },
    "\\vartheta": { glyph: 2134, flags: {} },
    "\\iota": { glyph: 2135, flags: {} },
    "\\kappa": { glyph: 2136, flags: {} },
    "\\lambda": { glyph: 2137, flags: {} },
    "\\mu": { glyph: 2138, flags: {} },
    "\\nu": { glyph: 2139, flags: {} },
    "\\xi": { glyph: 2140, flags: {} },
    "\\omicron": { glyph: 2141, flags: {} },
    "\\pi": { glyph: 2142, flags: {} },
    "\\rho": { glyph: 2143, flags: {} },
    "\\sigma": { glyph: 2144, flags: {} },
    "\\tau": { glyph: 2145, flags: {} },
    "\\upsilon": { glyph: 2146, flags: {} },
    "\\varphi": { glyph: 2147, flags: {} },
    "\\chi": { glyph: 2148, flags: {} },
    "\\psi": { glyph: 2149, flags: {} },
    "\\omega": { glyph: 2150, flags: {} },
    "\\epsilon": { glyph: 2184, flags: {} },
    "\\theta": { glyph: 2185, flags: {} },
    "\\phi": { glyph: 2186, flags: {} },
    "\\varsigma": { glyph: 2187, flags: {} },
    "\\Alpha": { glyph: 2027, flags: {} },
    "\\Beta": { glyph: 2028, flags: {} },
    "\\Gamma": { glyph: 2029, flags: {} },
    "\\Delta": { glyph: 2030, flags: {} },
    "\\Epsilon": { glyph: 2031, flags: {} },
    "\\Zeta": { glyph: 2032, flags: {} },
    "\\Eta": { glyph: 2033, flags: {} },
    "\\Theta": { glyph: 2034, flags: {} },
    "\\Iota": { glyph: 2035, flags: {} },
    "\\Kappa": { glyph: 2036, flags: {} },
    "\\Lambda": { glyph: 2037, flags: {} },
    "\\Mu": { glyph: 2038, flags: {} },
    "\\Nu": { glyph: 2039, flags: {} },
    "\\Xi": { glyph: 2040, flags: {} },
    "\\Omicron": { glyph: 2041, flags: {} },
    "\\Pi": { glyph: 2042, flags: {} },
    "\\Rho": { glyph: 2043, flags: {} },
    "\\Sigma": { glyph: 2044, flags: {} },
    "\\Tau": { glyph: 2045, flags: {} },
    "\\Upsilon": { glyph: 2046, flags: {} },
    "\\Phi": { glyph: 2047, flags: {} },
    "\\Chi": { glyph: 2048, flags: {} },
    "\\Psi": { glyph: 2049, flags: {} },
    "\\Omega": { glyph: 2050, flags: {} }
  };
  function asciiMap(x, mode = "math") {
    const c = x.charCodeAt(0);
    if (65 <= c && c <= 90) {
      const d = c - 65;
      if (mode === "text" || mode === "rm") {
        return d + 2001;
      } else if (mode === "tt") {
        return d + 501;
      } else if (mode === "bf" || mode === "bb") {
        return d + 3001;
      } else if (mode === "sf") {
        return d + 2501;
      } else if (mode === "frak") {
        return d + 3301;
      } else if (mode === "scr" || mode === "cal") {
        return d + 2551;
      }
      return d + 2051;
    }
    if (97 <= c && c <= 122) {
      const d = c - 97;
      if (mode === "text" || mode === "rm") {
        return d + 2101;
      } else if (mode === "tt") {
        return d + 601;
      } else if (mode === "bf" || mode === "bb") {
        return d + 3101;
      } else if (mode === "sf") {
        return d + 2601;
      } else if (mode === "frak") {
        return d + 3401;
      } else if (mode === "scr" || mode === "cal") {
        return d + 2651;
      }
      return d + 2151;
    }
    if (48 <= c && c <= 57) {
      const d = c - 48;
      if (mode === "it") {
        return d + 2750;
      } else if (mode === "bf") {
        return d + 3200;
      } else if (mode === "tt") {
        return d + 700;
      }
      return d + 2200;
    }
    return {
      ".": 2210,
      ",": 2211,
      ":": 2212,
      ";": 2213,
      "!": 2214,
      "?": 2215,
      "'": 2216,
      '"': 2217,
      "*": 2219,
      "/": 2220,
      "-": 2231,
      "+": 2232,
      "=": 2238,
      "<": 2241,
      ">": 2242,
      "~": 2246,
      "@": 2273,
      "\\": 804
    }[x];
  }

  // src/core/hfmath/stretch.js
  function curve(a, b, c, d, steps = 8) {
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      points.push([
        u ** 3 * a[0] + 3 * u ** 2 * t * b[0] + 3 * u * t ** 2 * c[0] + t ** 3 * d[0],
        u ** 3 * a[1] + 3 * u ** 2 * t * b[1] + 3 * u * t ** 2 * c[1] + t ** 3 * d[1]
      ]);
    }
    return points;
  }
  function stretch(kind, width, height, reversed = false) {
    let lines;
    if (kind === "arrow") {
      const head = Math.min(height, width / 2);
      lines = [
        [[0, height / 2], [width, height / 2]],
        [[width - head, 0], [width, height / 2], [width - head, height]]
      ];
    } else if (kind === "brace") {
      const cap = Math.min(width / 4, height * 0.8);
      const mid = width / 2;
      const half = height / 2;
      lines = [[
        ...curve([0, height], [0, half], [cap / 2, half], [cap, half]),
        [mid - cap, half],
        ...curve([mid - cap, half], [mid - cap / 2, half], [mid, half], [mid, 0]).slice(1),
        ...curve([mid, 0], [mid, half], [mid + cap / 2, half], [mid + cap, half]).slice(1),
        [width - cap, half],
        ...curve([width - cap, half], [width - cap / 2, half], [width, half], [width, height]).slice(1)
      ]];
    } else {
      lines = [curve([0, height], [0, -height / 3], [width, -height / 3], [width, height], 32)];
    }
    if (!reversed) return lines;
    return lines.map((line) => line.map(([x, y]) => kind === "arrow" ? [width - x, y] : [x, height - y]));
  }

  // src/core/hfmath/index.js
  var CONFIG = {
    SUB_SUP_SCALE: 0.75,
    SQRT_MAG_SCALE: 0.5,
    FRAC_SCALE: 0.85,
    LINE_SPACING: 0.5,
    FRAC_SPACING: 0.4
  };
  var MATRIX_DELIMITERS = /* @__PURE__ */ new Map([
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
  var hfmath = class {
    constructor(latex) {
      __publicField(this, "_latex");
      __publicField(this, "_tree");
      __publicField(this, "_tokens");
      __publicField(this, "_polylines");
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
%%¥±ë
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
  };

  // src/core/formula.js
  var HF_PADDING = 16;
  function renderFormula(latex) {
    const src = String(latex == null ? "" : latex).trim();
    if (!src) throw new Error("公式内容不能为空");
    let f;
    try {
      f = new hfmath(src);
      f.pathd();
    } catch (err) {
      throw new Error("公式解析失败：" + String(err && err.message || err) + "（请检查 TeX 语法）");
    }
    const d = f.pathd();
    if (!d || !d.trim()) throw new Error("公式渲染结果为空：请检查公式内容");
    const box = f.box();
    const vw = Math.ceil(box.x + box.w + HF_PADDING);
    const vh = Math.ceil(box.y + box.h + HF_PADDING);
    if (!isFinite(vw) || !isFinite(vh) || vw <= 0 || vh <= 0) {
      throw new Error("公式渲染尺寸异常：" + JSON.stringify(box));
    }
    return { path: d, viewBox: [vw, vh], width: vw, height: vh };
  }
  function makeFormulaElement(e) {
    if (!e || typeof e !== "object") throw new Error("公式元素必须是对象");
    const latex = String(e.latex == null ? "" : e.latex).trim();
    if (!latex) throw new Error("公式内容 latex 不能为空");
    let path = e.path;
    let viewBox = e.viewBox;
    if (!path) {
      const rendered = renderFormula(latex);
      path = rendered.path;
      viewBox = rendered.viewBox;
    }
    const vw = Number(viewBox && viewBox[0] != null ? viewBox[0] : 200);
    const vh = Number(viewBox && viewBox[1] != null ? viewBox[1] : 200);
    if (!isFinite(vw) || !isFinite(vh) || vw <= 0 || vh <= 0) {
      throw new Error("viewBox 无效：应为 [宽, 高] 正数");
    }
    const width = Number(e.width != null ? e.width : vw);
    const height = Number(e.height != null ? e.height : vh);
    return {
      type: "latex",
      id: e.id || `formula_${Date.now()}_${Math.floor(Math.random() * 1e3)}`,
      left: Number(e.left != null ? e.left : Math.round((1e3 - width) / 2)),
      top: Number(e.top != null ? e.top : 140),
      width,
      height,
      rotate: Number(e.rotate || 0),
      fixedRatio: true,
      latex,
      path: String(path),
      color: e.color ? String(e.color) : "#333333",
      strokeWidth: Number(e.strokeWidth != null ? e.strokeWidth : 2),
      viewBox: [vw, vh]
    };
  }

  // src/core/text.js
  var escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function textHolder(el) {
    if (!el) return null;
    if (el.type === "text") return el;
    if (el.type === "shape" && el.text && typeof el.text.content === "string") return el.text;
    return null;
  }
  function setPlainText(current, text) {
    const src = String(current || "");
    const body = escapeHtml(text == null ? "" : text);
    let first = true;
    const out = src.replace(/>([^<>]*)</g, (m, txt) => {
      if (!String(txt).trim()) return m;
      if (first) {
        first = false;
        return ">" + body + "<";
      }
      return "><";
    });
    if (first) return "<p>" + body + "</p>";
    return out;
  }
  function textHtml(current, props, st) {
    let inner = props.html;
    if (inner == null) {
      if (props.text != null) inner = escapeHtml(String(props.text));
      else inner = String(current || "").replace(/<p[^>]*>/i, "").replace(/<\/p>\s*$/i, "");
    }
    let body = inner;
    if (st && st.bold) body = "<strong>" + body + "</strong>";
    const size = st && st.fontSize != null ? Number(st.fontSize) : 28;
    let style = "font-size: " + size + "px;";
    if (st && st.color) style += " color: " + String(st.color) + ";";
    if (st && st.align) style += " text-align: " + String(st.align) + ";";
    return '<p style="' + style + '">' + body + "</p>";
  }
  function patchElement(el, props) {
    ;
    ["left", "top", "width", "height", "rotate", "opacity"].forEach((k) => {
      if (props[k] != null && isFinite(Number(props[k]))) el[k] = Number(props[k]);
    });
    if (props.fill != null) el.fill = String(props.fill);
    if (el.type === "image") {
      if (props.src != null) el.src = String(props.src);
      if (props.clip != null) el.clip = props.clip;
      return;
    }
    if (el.type === "latex") {
      if (props.path != null) el.path = String(props.path);
      if (props.latex != null) el.latex = String(props.latex);
      if (Array.isArray(props.viewBox) && props.viewBox.length === 2 && props.viewBox.every((n) => isFinite(Number(n)) && Number(n) > 0)) {
        el.viewBox = [Number(props.viewBox[0]), Number(props.viewBox[1])];
      }
      if (props.color != null) el.color = String(props.color);
      if (props.strokeWidth != null && isFinite(Number(props.strokeWidth))) {
        el.strokeWidth = Number(props.strokeWidth);
      }
      return;
    }
    const holder = textHolder(el);
    if (!holder) return;
    if (props.color != null && props.text == null && props.html == null && props.fontSize == null && props.bold == null && props.align == null) {
      holder.content = String(holder.content || "").replace(/color:\s*[^;"']+/g, "color: " + String(props.color));
      if (el.type === "text") el.defaultColor = String(props.color);
      return;
    }
    if (props.defaultColor != null && el.type === "text") el.defaultColor = String(props.defaultColor);
    const hasText = props.text != null || props.html != null;
    const hasStyle = props.fontSize != null || props.color != null || props.bold != null || props.align != null;
    if (hasText && !hasStyle) {
      holder.content = setPlainText(holder.content, props.text);
    } else if (hasText || hasStyle) {
      holder.content = textHtml(holder.content, props, hasStyle ? props : null);
    }
  }
  function makeElement(e) {
    const type = String(e.type || "text");
    if (type !== "text" && type !== "shape" && type !== "image" && type !== "chart" && type !== "table" && type !== "line" && type !== "latex") {
      throw new Error("不支持的 element.type: " + type + "（只支持 text / shape / image / chart / table / line / latex）");
    }
    if (type === "line") {
      const sx = e.start ? Number(e.start[0]) : Number(e.x1 != null ? e.x1 : 0);
      const sy = e.start ? Number(e.start[1]) : Number(e.y1 != null ? e.y1 : 0);
      const ex = e.end ? Number(e.end[0]) : Number(e.x2 != null ? e.x2 : 200);
      const ey = e.end ? Number(e.end[1]) : Number(e.y2 != null ? e.y2 : 0);
      if (![sx, sy, ex, ey].every(isFinite)) throw new Error("line 需要 start/end（画布坐标）或 x1/y1/x2/y2");
      const left = Math.min(sx, ex);
      const top = Math.min(sy, ey);
      const pointOf = (v) => v && v !== "none" ? String(v) : "";
      const el = {
        id: e.id || "line_" + Date.now() + "_" + Math.floor(Math.random() * 1e3),
        type,
        left,
        top,
        start: [sx - left, sy - top],
        end: [ex - left, ey - top],
        points: Array.isArray(e.points) ? e.points.map(String) : [pointOf(e.start_point), pointOf(e.end_point)],
        color: e.color || "#5b9bd5",
        style: String(e.style || "solid"),
        width: Number(e.width || e.lineWidth || 2)
      };
      if (Array.isArray(e.broken) && e.broken.length === 2) {
        el.broken = [Number(e.broken[0]) - left, Number(e.broken[1]) - top];
      }
      return el;
    }
    if (type === "chart") return makeChartElement(e);
    if (type === "table") return makeTableElement(e);
    if (type === "latex") return makeFormulaElement(e);
    const id = e.id || "el_" + Date.now() + "_" + Math.floor(Math.random() * 1e3);
    const base = {
      id,
      type,
      left: Number(e.left != null ? e.left : 60),
      top: Number(e.top != null ? e.top : 120),
      width: Number(e.width != null ? e.width : 400),
      height: Number(e.height != null ? e.height : 60),
      rotate: Number(e.rotate || 0),
      fixedRatio: false
    };
    if (type === "shape") {
      return Object.assign(base, {
        path: e.path || "M 0 0 L 200 0 L 200 200 L 0 200 Z",
        viewBox: e.viewBox || [200, 200],
        fill: e.fill || "rgb(209, 68, 36)"
      });
    }
    if (type === "image") {
      const src = String(e.src || "");
      if (!src) throw new Error("image 元素需要 src（请用 ppt_image，支持 attachment_id）");
      if (/^[a-zA-Z]:[\\/]/.test(src) || src.startsWith("file:")) {
        throw new Error("本机路径不能直接插入图片；请用 ppt_image（会自动转 data URL）");
      }
      return Object.assign(base, {
        src,
        clip: e.clip || null,
        ...e.opacity != null ? { opacity: Number(e.opacity) } : {}
      });
    }
    return Object.assign(base, {
      content: e.content || textHtml(
        "",
        { text: e.text || "" },
        { fontSize: e.fontSize || 28, color: e.color || "#333333" }
      ),
      defaultColor: e.color || "#333333",
      defaultFontName: ""
    });
  }
  function contrast(slide, bg) {
    if (!parseColor(bg)) return;
    const fg = contrastColor(bg);
    (slide.elements || []).forEach((el) => {
      if (el.type !== "text") return;
      el.defaultColor = fg;
      if (typeof el.content === "string") {
        el.content = el.content.replace(/color:\s*[^;"']+/g, "color: " + fg);
      }
    });
  }

  // src/core/ops/text.js
  var idx = (c) => c.id != null ? c.id : c.index;
  var clone = (P, i) => JSON.parse(JSON.stringify(P.getSlides()[i]));
  var textOps = {
    "set-text": {
      run(P, c) {
        const i = idx(c);
        const s = clone(P, i);
        const el = s.elements.find((e) => c.elementId && e.id === c.elementId || !c.elementId && e.type === "text") || !c.elementId && s.elements.find((e) => textHolder(e));
        if (!el) throw new Error("set-text 未命中: " + (c.elementId || "首个文本"));
        patchElement(el, c);
        P.updateSlide(i, s);
      }
    },
    "fill-slot": {
      run(P, c) {
        const i = Number(c.slide) | 0;
        const s = clone(P, i);
        const texts = (s.elements || []).filter((e) => textHolder(e));
        const el = texts[Number(c.slot) | 0];
        if (!el) throw new Error("文本槽位不存在: " + c.slot);
        patchElement(el, {
          text: c.text,
          html: c.html,
          fontSize: c.fontSize,
          color: c.color,
          bold: c.bold,
          align: c.align
        });
        P.updateSlide(i, s);
      }
    }
  };

  // src/core/ops/element.js
  function clone2(P, i) {
    const slide = P.getSlides()[i];
    if (!slide) {
      const total = P.getSlides().length;
      throw new Error(`页号越界：第 ${i} 页不存在（共 ${total} 页）`);
    }
    return JSON.parse(JSON.stringify(slide));
  }
  var elementOps = {
    "add-element": {
      async run(P, c, ctx) {
        const i = Number(c.slide != null ? c.slide : 0);
        const s = clone2(P, i);
        const el = makeElement(c.element || {});
        if (el.left != null && el.left >= 1e3 || el.top != null && el.top >= 563 || el.left != null && el.width != null && el.left + el.width <= 0) {
          el.left = Math.max(0, Math.round((1e3 - (el.width || 400)) / 2));
          el.top = Math.max(0, Math.round((562.5 - (el.height || 300)) / 2));
        }
        if (el.type === "image" && ctx.media && typeof ctx.media.prepareImage === "function") {
          await ctx.media.prepareImage(el);
        }
        s.elements.push(el);
        P.updateSlide(i, s);
      }
    },
    "set-element": {
      run(P, c) {
        const i = Number(c.slide != null ? c.slide : c.id);
        const s = clone2(P, i);
        const el = s.elements.find((e) => e.id === c.elementId);
        if (!el) throw new Error("set-element 未命中: " + c.elementId);
        patchElement(el, c.props || {});
        P.updateSlide(i, s);
      }
    },
    "remove-element": {
      run(P, c) {
        const i = Number(c.slide != null ? c.slide : 0);
        const s = clone2(P, i);
        const n = s.elements.length;
        s.elements = s.elements.filter((e) => e.id !== c.elementId);
        if (s.elements.length === n) throw new Error("remove-element 未命中: " + c.elementId);
        P.updateSlide(i, s);
      }
    }
  };

  // src/core/ops/slide.js
  var idx2 = (c) => c.id != null ? c.id : c.index;
  var clone3 = (P, i) => JSON.parse(JSON.stringify(P.getSlides()[i]));
  var slideOps = {
    "set-background": {
      run(P, c) {
        const idxs = Array.isArray(c.indices) ? c.indices : null;
        const n = P.getSlides().length;
        for (let i = 0; i < n; i++) {
          if (idxs && idxs.indexOf(i) < 0) continue;
          const s = clone3(P, i);
          s.background = { type: "solid", color: String(c.color || "#ffffff") };
          if (c.contrast) contrast(s, String(c.color || "#ffffff"));
          P.updateSlide(i, s);
        }
      }
    },
    "add-slide": {
      run(P, c) {
        P.addSlide(c.slide || {}, c.index);
      }
    },
    "update-slide": {
      run(P, c) {
        if (!P.updateSlide(idx2(c), c.slide)) throw new Error("update-slide 未命中");
      }
    },
    "remove-slide": {
      run(P, c) {
        if (!P.removeSlide(idx2(c))) throw new Error("remove-slide 未命中");
      }
    },
    "move-slide": {
      run(P, c) {
        if (!P.moveSlide(c.from, c.to)) throw new Error("move-slide 越界");
      }
    },
    "duplicate-slide": {
      run(P, c) {
        if (!P.duplicateSlide(idx2(c))) throw new Error("duplicate-slide 未命中");
      }
    },
    select: {
      mutates: false,
      view: true,
      run(P, c) {
        if (!P.selectSlide(idx2(c))) throw new Error("select 未命中");
      }
    },
    "set-notes": {
      run(P, c) {
        const i = Number(c.slide != null ? c.slide : idx2(c));
        const s = clone3(P, i);
        s.notes = String(c.notes == null ? "" : c.notes);
        P.updateSlide(i, s);
      }
    }
  };

  // src/core/ops/recolor.js
  var clone4 = (P, i) => JSON.parse(JSON.stringify(P.getSlides()[i]));
  var recolorOps = {
    recolor: {
      run(P, c) {
        const bg = String(c.background || "#ffffff");
        const fg = c.text ? String(c.text) : contrastColor(bg);
        const shapeFill = c.shapes === null ? null : String(c.shapes != null && c.shapes !== true ? c.shapes : fg);
        const n = P.getSlides().length;
        for (let i = 0; i < n; i++) {
          if (Array.isArray(c.indices) && c.indices.indexOf(i) < 0) continue;
          const s = clone4(P, i);
          s.background = { type: "solid", color: bg };
          (s.elements || []).forEach((el) => {
            const holder = textHolder(el);
            if (holder) {
              el.defaultColor = fg;
              if (typeof holder.content === "string") {
                holder.content = holder.content.replace(/color:\s*[^;"']+/g, "color: " + fg);
              }
            }
            if (el.type !== "text" && shapeFill && el.fill != null) el.fill = shapeFill;
          });
          P.updateSlide(i, s);
        }
      }
    }
  };

  // src/core/ops/view.js
  var viewOps = {
    present: {
      mutates: false,
      view: true,
      run(P, c) {
        return P.present(c.index != null ? c.index : void 0);
      }
    },
    "exit-present": {
      mutates: false,
      view: true,
      run(P) {
        return P.exitPresent();
      }
    }
  };

  // src/core/ops/history.js
  var historyOps = {
    undo: {
      mutates: false,
      run(P) {
        return P.undo();
      }
    },
    redo: {
      mutates: false,
      run(P) {
        return P.redo();
      }
    }
  };

  // src/core/ops/playback.js
  var playbackOps = {
    sleep: {
      mutates: false,
      run(P, c) {
        return new Promise((r) => setTimeout(r, Math.min(3e3, Math.max(0, Number(c.ms) || 600))));
      }
    }
  };

  // src/core/ops/chart.js
  function clone5(P, i) {
    const slide = P.getSlides()[i];
    if (!slide) {
      const total = P.getSlides().length;
      throw new Error(`页号越界：第 ${i} 页不存在（共 ${total} 页）`);
    }
    return JSON.parse(JSON.stringify(slide));
  }
  function deckThemeColors(P) {
    try {
      const th = typeof P.getTheme === "function" ? P.getTheme() : null;
      return th && Array.isArray(th.themeColors) ? th.themeColors : void 0;
    } catch {
      return void 0;
    }
  }
  var chartOps = {
    "add-chart": {
      async run(P, c) {
        const i = Number(c.slide != null ? c.slide : 0);
        const s = clone5(P, i);
        const el = makeChartElement(c.element || {}, deckThemeColors(P));
        s.elements.push(el);
        P.updateSlide(i, s);
        return el.id;
      }
    },
    "update-chart": {
      run(P, c) {
        const i = Number(c.slide != null ? c.slide : 0);
        const s = clone5(P, i);
        const el = s.elements.find((e) => e.id === c.elementId);
        if (!el) throw new Error("update-chart 未命中: " + c.elementId);
        if (el.type !== "chart") throw new Error(`元素 ${c.elementId} 不是图表（type=${el.type}）`);
        const p = c.props || {};
        if (p.chartType != null) {
          const ct = String(p.chartType);
          if (!CHART_TYPES.includes(ct)) {
            throw new Error(`不支持的 chartType: ${ct}（支持 ${CHART_TYPES.join(" / ")}）`);
          }
          el.chartType = ct;
        }
        if (p.data != null) el.data = normalizeChartData(p.data, el.chartType);
        if (p.options !== void 0) {
          const options = normalizeChartOptions(p.options);
          if (options) el.options = options;
          else delete el.options;
        }
        if (Array.isArray(p.colors) && p.colors.length) el.themeColors = p.colors.map(String);
        if (p.textColor != null) el.textColor = String(p.textColor);
        for (const k of ["left", "top", "width", "height", "rotate"]) {
          if (p[k] != null && isFinite(Number(p[k]))) el[k] = Number(p[k]);
        }
        P.updateSlide(i, s);
      }
    }
  };

  // src/core/ops/table.js
  function clone6(P, i) {
    const slide = P.getSlides()[i];
    if (!slide) {
      const total = P.getSlides().length;
      throw new Error(`页号越界：第 ${i} 页不存在（共 ${total} 页）`);
    }
    return JSON.parse(JSON.stringify(slide));
  }
  var tableOps = {
    "add-table": {
      run(P, c) {
        const i = Number(c.slide != null ? c.slide : 0);
        const s = clone6(P, i);
        const el = makeTableElement(c.element || {});
        s.elements.push(el);
        P.updateSlide(i, s);
        return el.id;
      }
    },
    "update-table": {
      run(P, c) {
        const i = Number(c.slide != null ? c.slide : 0);
        const s = clone6(P, i);
        const el = s.elements.find((e) => e.id === c.elementId);
        if (!el) throw new Error("update-table 未命中: " + c.elementId);
        if (el.type !== "table") throw new Error(`元素 ${c.elementId} 不是表格（type=${el.type}）`);
        const p = c.props || {};
        if (p.themeColor != null) el.theme = { ...el.theme, color: String(p.themeColor) };
        if (p.rowHeader != null) el.theme.rowHeader = Boolean(p.rowHeader);
        if (p.colHeader != null) el.theme.colHeader = Boolean(p.colHeader);
        if (p.outline && typeof p.outline === "object") {
          el.outline = {
            style: String(p.outline.style || el.outline.style || "solid"),
            width: Number(p.outline.width != null ? p.outline.width : el.outline.width),
            color: String(p.outline.color || el.outline.color || "#d9d9d9")
          };
        }
        if (Array.isArray(p.colWidths)) {
          const sum = p.colWidths.reduce((a, b) => a + Number(b || 0), 0);
          if (!isFinite(sum) || sum <= 0) throw new Error("colWidths 无效");
          el.colWidths = p.colWidths.map((n) => Number(n) / sum);
        }
        if (Array.isArray(p.rowHeights)) {
          if (p.rowHeights.length !== el.data.length) throw new Error("rowHeights 长度与行数不一致");
          el.rowHeights = p.rowHeights.map(Number);
        }
        if (p.cellMinHeight != null) el.cellMinHeight = Number(p.cellMinHeight);
        for (const k of ["left", "top", "width", "height", "rotate"]) {
          if (p[k] != null && isFinite(Number(p[k]))) el[k] = Number(p[k]);
        }
        P.updateSlide(i, s);
      }
    },
    "set-table-cells": {
      run(P, c) {
        const i = Number(c.slide != null ? c.slide : 0);
        const s = clone6(P, i);
        const el = s.elements.find((e) => e.id === c.elementId);
        if (!el) throw new Error("set-table-cells 未命中: " + c.elementId);
        if (el.type !== "table") throw new Error(`元素 ${c.elementId} 不是表格（type=${el.type}）`);
        const patches = normalizeCellPatches(c.cells || []);
        for (const p of patches) {
          const row = el.data[p.row];
          if (!row) throw new Error(`行越界：第 ${p.row} 行不存在（共 ${el.data.length} 行）`);
          const cell = row[p.col];
          if (!cell) throw new Error(`列越界：第 ${p.col} 列不存在（共 ${row.length} 列）`);
          if (p.text != null) cell.text = p.text;
          if (p.style) {
            cell.style = { ...cell.style || {}, ...p.style };
            if (Object.keys(cell.style).length === 0) delete cell.style;
          }
        }
        if (c.themeColor != null && c.themeColor !== "") {
          el.theme = { ...el.theme, color: String(c.themeColor || DEFAULT_TABLE_COLOR) };
        }
        P.updateSlide(i, s);
      }
    }
  };

  // src/core/ops/import.js
  var importOps = {
    "import-pptx": {
      mutates: false,
      view: true,
      description: "导入 PPTX（仅编辑器页面执行）",
      async run(P, c, ctx = {}) {
        if (!P || typeof P.importFile !== "function") {
          throw new Error("当前编辑器不支持 PPTX 导入：PptApp.importFile 不可用");
        }
        const req = String(c.req || "");
        const apiBase = String(ctx.apiBase || "").replace(/\/+$/, "");
        const resultUrl = String(c.resultUrl || (apiBase ? `${apiBase}/import-result` : "/api/desktop/works/ppt-bridge/import-result"));
        const doFetch = ctx.fetch || (typeof fetch === "function" ? fetch : null);
        const notify = async (body) => {
          if (!doFetch) return;
          try {
            await doFetch(resultUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ req, id: String(c.id || ""), ...body })
            });
          } catch {
          }
        };
        try {
          if (!doFetch) throw new Error("当前环境不支持 fetch，无法读取待导入文件");
          const base = ctx.baseUrl || (typeof location !== "undefined" ? location.href : "http://127.0.0.1/");
          const sourceUrl = new URL(String(c.url || ""), base).href;
          const response = await doFetch(sourceUrl);
          if (!response || !response.ok) {
            throw new Error(`读取待导入文件失败：HTTP ${response ? response.status : "no response"}`);
          }
          const blob = await response.blob();
          const FileCtor = ctx.File || (typeof File !== "undefined" ? File : null);
          if (!FileCtor) throw new Error("当前环境不支持 File 构造器，无法导入 PPTX");
          const name = String(c.name || "import.pptx");
          const file = new FileCtor([blob], name, {
            type: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          });
          const mode = c.mode === "append" ? "append" : "replace";
          const beforeSlides = typeof P.getSlides === "function" ? P.getSlides() || [] : [];
          const previousIds = mode === "replace" ? beforeSlides.map((slide) => slide.id).filter(Boolean) : [];
          const imported = await P.importFile(file);
          for (const id of previousIds) {
            try {
              P.removeSlide(id);
            } catch {
            }
          }
          const finalCount = typeof P.getSlides === "function" ? (P.getSlides() || []).length : imported?.slideCount;
          const rawCount = Number(imported?.slideCount || 0);
          const contributed = mode === "append" ? Math.max(0, Number(finalCount || 0) - beforeSlides.length) : Number(finalCount || rawCount || 0);
          const summary = {
            ...imported && typeof imported === "object" ? imported : {},
            slideCount: Number(finalCount || rawCount || 0),
            import: {
              mode,
              before: beforeSlides.length,
              imported: contributed,
              final: Number(finalCount || 0)
            }
          };
          await notify({ ok: true, summary });
          return summary;
        } catch (error) {
          await notify({ ok: false, error: String(error && error.message || error) });
          throw error;
        }
      }
    }
  };

  // src/core/ops/index.js
  var OP_MODULES = {
    deck: deckOps,
    text: textOps,
    element: elementOps,
    slide: slideOps,
    recolor: recolorOps,
    view: viewOps,
    history: historyOps,
    playback: playbackOps,
    chart: chartOps,
    table: tableOps,
    importer: importOps
  };
  var registry = createOpRegistry({
    modules: OP_MODULES,
    snapshot: (P) => P.snapshot?.()
  });
  var OP_DEFINITIONS = registry.definitions;
  var OP_NAMES = registry.names;
  var VIEW_OP_NAMES = registry.viewNames;
  var applyOp = registry.apply;

  // src/core/ops/browser.js
  async function shrinkImage(el) {
    if (typeof document === "undefined") return el;
    const src = String(el.src || "");
    if (!/^data:image\//i.test(src) || src.length < 25e4) return el;
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = src;
      });
      const maxW = 1600;
      const scale = Math.min(1, maxW / (img.width || maxW));
      if (scale >= 1 && src.length < 9e5) return el;
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round((img.width || maxW) * scale));
      cv.height = Math.max(1, Math.round((img.height || maxW) * scale));
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      el.src = cv.toDataURL("image/jpeg", 0.85);
    } catch (e) {
    }
    return el;
  }

  // ../../../packages/dsh-document-workbench/src/client/index.mjs
  var DEFAULTS = {
    pollTimeoutSec: 3,
    claimRetryMs: 800,
    activeClaimRetryMs: 1500,
    heartbeatMs: 3e3,
    stateDebounceMs: 800,
    errorRetryMs: 500,
    shotIdleMs: 3e3
  };
  var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function createEditorClient({
    api,
    apiBase = "",
    clientId,
    adapter,
    authority = "server",
    documentKey = "document",
    documentPath = "/document",
    storage = typeof localStorage !== "undefined" ? localStorage : null,
    workerFactory = null,
    heartbeatWorkerUrl = "./heartbeat-worker.js",
    singletonKey = "document-workbench-singleton",
    intervals = {},
    onStatus = () => {
    },
    onNote = () => {
    }
  } = {}) {
    if (typeof api !== "function") throw new Error("createEditorClient 需要 api(path, init)");
    if (!adapter || typeof adapter.load !== "function" || typeof adapter.dump !== "function") {
      throw new Error("createEditorClient 需要 adapter.load / adapter.dump");
    }
    if (authority !== "server" && authority !== "editor") {
      throw new Error("authority 只能是 server 或 editor");
    }
    const timing = { ...DEFAULTS, ...intervals };
    const st = {
      clientId,
      active: false,
      stopped: false,
      heartbeat: null,
      heartbeatWorker: null,
      lastSeq: 0,
      lastShotReq: 0,
      lastUiSeq: 0,
      busy: false,
      shooting: false,
      pumping: false,
      watching: false,
      onchange: null,
      unsubscribe: null,
      stateTimer: null,
      shotCache: null,
      singletonKey,
      pendingShotReq: null
    };
    const note = (message, kind = "") => onNote(message, kind);
    const badge = (text, kind = "") => onStatus(text, kind);
    function request(path, init) {
      return api(path, init);
    }
    function post(path, body) {
      return request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    }
    async function claim(force) {
      try {
        const meta = typeof adapter.meta === "function" ? adapter.meta() : null;
        const result = await post("/claim", {
          id: st.clientId,
          force: !!force,
          ...meta && typeof meta === "object" ? { meta } : {}
        });
        return !!(result && result.ok);
      } catch {
        return false;
      }
    }
    async function ensureLinked() {
      for (; ; ) {
        if (await claim(true)) return;
        await sleep(600);
      }
    }
    async function restore() {
      try {
        const doc = await request("");
        const value = doc && doc[documentKey];
        if (value !== void 0 && value !== null) await adapter.load(value);
        st.lastSeq = Number(doc && doc.seq) || 0;
        st.lastUiSeq = Number(doc && doc.ui_seq) || 0;
        return doc;
      } catch {
        return null;
      }
    }
    async function activate() {
      if (st.active) return;
      st.stopped = false;
      st.active = true;
      try {
        storage?.setItem(st.singletonKey, st.clientId);
      } catch {
      }
      badge("", "ok");
      note("");
      watch();
      pump();
      startHeartbeatWorker();
      try {
        const status = await request("/status");
        if (status && status.shot_req > 0 && (!status.shot || (status.shot.req | 0) < status.shot_req)) {
          st.lastShotReq = status.shot_req;
          shoot(status.shot_req);
        }
      } catch {
      }
    }
    async function claimLoop() {
      if (storage && typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("storage", (event) => {
          if (event.key === st.singletonKey && event.newValue && event.newValue !== st.clientId) {
            if (st.active) {
              st.active = false;
              stopHeartbeatWorker();
              badge("", "standby");
              note("");
            }
          }
        });
      }
      let firstClaim = true;
      for (; ; ) {
        if (st.stopped) break;
        if (!st.active) {
          if (await claim(firstClaim)) {
            firstClaim = false;
            await activate();
          } else {
            firstClaim = false;
            badge("", "standby");
            note("");
          }
        }
        await sleep(st.active ? timing.activeClaimRetryMs : timing.claimRetryMs);
      }
    }
    async function apply(doc) {
      st.busy = true;
      let applied = 0;
      let error = "";
      try {
        applied = await adapter.apply(doc.cmds || []);
        if (!Number.isFinite(applied)) applied = (doc.cmds || []).length;
      } catch (caught) {
        error = String(caught && caught.message || caught);
        if (!adapter.isMounted?.()) st.lastSeq = 0;
      }
      try {
        await post("/ack", { seq: doc.seq, applied, error });
      } catch {
      }
      st.busy = false;
      note(error ? `第 ${doc.seq} 队应用失败：${error}` : `第 ${doc.seq} 队已应用（${applied} 条）`, error ? "error" : "ok");
      Promise.resolve().then(() => pushState(doc.seq)).catch(() => {
      });
    }
    async function applyLocal(commands) {
      st.busy = true;
      try {
        await adapter.apply(commands || []);
        await pushState();
      } finally {
        st.busy = false;
      }
    }
    async function pumpOnce() {
      if (!st.active) return false;
      const doc = await request(`/watch?seq=${st.lastSeq}&shot=${st.lastShotReq}&ui=${st.lastUiSeq}&timeout=${timing.pollTimeoutSec}`);
      if (!doc) return false;
      if ((doc.shot_req | 0) < (st.lastShotReq | 0)) st.lastShotReq = doc.shot_req | 0;
      if (doc.shot_req && doc.shot_req > st.lastShotReq) {
        st.lastShotReq = doc.shot_req;
        shoot(doc.shot_req);
      }
      if ((doc.seq | 0) !== (st.lastSeq | 0)) {
        st.lastSeq = doc.seq | 0;
        if (authority === "editor") {
          if (doc.cmds && doc.cmds.length) await apply(doc);
        } else if (st.lastSeq > 0) {
          st.busy = true;
          try {
            const mirror = await request(documentPath);
            const value = mirror && mirror[documentKey];
            if (value !== void 0) await adapter.load(value);
          } catch {
          } finally {
            st.busy = false;
          }
        }
      }
      if ((doc.ui_seq | 0) > (st.lastUiSeq | 0)) {
        st.lastUiSeq = doc.ui_seq | 0;
        st.busy = true;
        try {
          const uiDoc = await request("/ui");
          await adapter.applyUi?.(uiDoc.ui || []);
        } catch {
        } finally {
          st.busy = false;
        }
      }
      return true;
    }
    async function pump() {
      if (st.pumping) return;
      st.pumping = true;
      try {
        for (; ; ) {
          if (st.stopped) break;
          if (!st.active) {
            await sleep(1500);
            continue;
          }
          try {
            await pumpOnce();
          } catch {
            await sleep(timing.errorRetryMs);
          }
        }
      } finally {
        st.pumping = false;
      }
    }
    async function shoot(req) {
      if (st.shooting) {
        st.pendingShotReq = req;
        return;
      }
      st.shooting = true;
      try {
        const idleDeadline = Date.now() + timing.shotIdleMs;
        while (st.busy && Date.now() < idleDeadline) await sleep(100);
        let current = req;
        for (; ; ) {
          let data2 = "";
          for (let attempt = 0; attempt < 2 && !data2; attempt++) {
            try {
              data2 = await adapter.renderScreenshot();
            } catch {
              await sleep(400);
            }
          }
          if (!data2) {
            try {
              await post("/shot-result", { req: current, data: "" });
            } catch {
            }
            throw new Error("画面渲染为空");
          }
          st.shotCache = data2;
          await post("/shot-result", { req: current, data: data2 });
          if (st.pendingShotReq && st.pendingShotReq !== current) {
            current = st.pendingShotReq;
            st.pendingShotReq = null;
            continue;
          }
          break;
        }
      } catch (caught) {
        badge("", "error");
        note("截图失败：" + String(caught && caught.message || caught));
      } finally {
        st.shooting = false;
        st.pendingShotReq = null;
      }
    }
    function watch() {
      if (st.watching || typeof adapter.onChange !== "function") return;
      st.watching = true;
      st.onchange = () => {
        clearTimeout(st.stateTimer);
        st.stateTimer = setTimeout(() => {
          pushState().catch(() => {
          });
        }, timing.stateDebounceMs);
      };
      st.unsubscribe = adapter.onChange(st.onchange) || null;
    }
    async function pushState(seq) {
      if (!st.active) return;
      if (adapter.isMounted && !adapter.isMounted()) return;
      try {
        const body = { [documentKey]: adapter.dump() };
        if (seq != null) body.seq = Number(seq);
        else if (st.lastSeq) body.seq = Number(st.lastSeq);
        await post("/state", body);
      } catch {
      }
    }
    function release() {
      try {
        if (typeof navigator !== "undefined" && navigator.sendBeacon) {
          const body = new Blob([JSON.stringify({ id: st.clientId })], { type: "application/json" });
          navigator.sendBeacon(apiBase + "/release", body);
          return;
        }
        post("/release", { id: st.clientId }).catch(() => {
        });
      } catch {
      }
    }
    function startHeartbeatWorker() {
      if (st.heartbeatWorker) return;
      try {
        const worker = workerFactory ? workerFactory() : typeof Worker !== "undefined" ? new Worker(heartbeatWorkerUrl) : null;
        if (!worker) {
          startFallbackHeartbeat();
          return;
        }
        st.heartbeatWorker = worker;
        if (st.heartbeat) {
          clearInterval(st.heartbeat);
          st.heartbeat = null;
        }
        worker.onmessage = (event) => {
          if ((event.data || {}).type === "error") {
            stopHeartbeatWorker();
            startFallbackHeartbeat();
          }
        };
        worker.onerror = () => {
          stopHeartbeatWorker();
          startFallbackHeartbeat();
        };
        worker.postMessage({ type: "start", data: { clientId: st.clientId, apiBase } });
      } catch {
        startFallbackHeartbeat();
      }
    }
    function stopHeartbeatWorker() {
      if (st.heartbeatWorker) {
        try {
          st.heartbeatWorker.postMessage({ type: "stop" });
        } catch {
        }
        try {
          st.heartbeatWorker.terminate();
        } catch {
        }
        st.heartbeatWorker = null;
      }
      if (st.heartbeat) {
        clearInterval(st.heartbeat);
        st.heartbeat = null;
      }
    }
    function startFallbackHeartbeat() {
      if (st.heartbeat) return;
      st.heartbeat = setInterval(async () => {
        if (!st.active) return;
        const ok = await claim();
        if (!ok) {
          st.active = false;
          badge("", "standby");
          note("");
        }
      }, timing.heartbeatMs);
    }
    function stop() {
      st.stopped = true;
      st.active = false;
      clearTimeout(st.stateTimer);
      st.stateTimer = null;
      stopHeartbeatWorker();
      try {
        st.unsubscribe?.();
      } catch {
      }
      st.unsubscribe = null;
      st.watching = false;
    }
    return {
      state: st,
      claim,
      ensureLinked,
      restore,
      activate,
      claimLoop,
      apply,
      applyLocal,
      pumpOnce,
      pump,
      shoot,
      watch,
      pushState,
      release,
      startHeartbeatWorker,
      stopHeartbeatWorker,
      startFallbackHeartbeat,
      stop,
      note,
      badge
    };
  }

  // src/core/quick.js
  function simpleSlide(title) {
    const ts = Date.now();
    return {
      id: "quick_" + ts,
      background: { type: "solid", color: "#ffffff" },
      elements: [{
        type: "text",
        id: "quick_t_" + ts,
        left: 60,
        top: 50,
        width: 880,
        height: 76,
        content: '<p style="font-size: 34px;"><strong>' + escapeHtml(title) + "</strong></p>",
        defaultColor: "#333333",
        defaultFontName: "",
        fixedRatio: false,
        rotate: 0
      }]
    };
  }
  function parseQuick(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const pageMatch = /第\s*([0-9]+|[一二三四五六七八九十])\s*页/.exec(t);
    const page = pageMatch ? (cn[pageMatch[1]] || parseInt(pageMatch[1], 10)) - 1 : null;
    const setText = /第\s*(?:[0-9]+|[一二三四五六七八九十])\s*页.*?(?:标题|文字|文本|内容).*?(?:改成|换成|改为|设为)\s*(.+)$/.exec(t);
    if (setText) return [{ op: "set-text", id: page, text: setText[1].trim() }];
    const add = /(?:加|新增|添加)一页\s*(.*)$/.exec(t);
    if (add) return [{ op: "add-slide", slide: simpleSlide(add[1].trim() || "新一页") }];
    if (/背景/.test(t)) {
      let hex = null;
      let best = null;
      for (const k of Object.keys(COLORS)) {
        const idx3 = t.indexOf(k);
        if (idx3 < 0) continue;
        if (!best || k.length > best.k.length || k.length === best.k.length && idx3 < best.idx) best = { k, idx: idx3 };
      }
      if (best) hex = COLORS[best.k];
      const hexMatch = /#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(t);
      if (hexMatch) hex = hexMatch[0];
      if (hex) {
        const cmd = { op: "set-background", color: hex, contrast: true };
        if (page != null) cmd.indices = [page];
        return [cmd];
      }
    }
    return null;
  }

  // src/editor/session.js
  var API_BASE = "/api/desktop/works/ppt-bridge";
  function createEditorSession({
    api,
    applyOp: applyOp2,
    opsContext,
    ui: ui2,
    renderSheet: renderSheet2,
    clientId,
    getPptApp = () => window.PptApp,
    apiBase = API_BASE
  }) {
    const adapter = {
      isMounted() {
        const P = getPptApp();
        return !!(P && P.isMounted && P.isMounted());
      },
      meta() {
        return {
          app: "pptist-editor",
          capabilities: ["import-pptx", "save-pptx"]
        };
      },
      async load(deck) {
        await getPptApp().load(deck);
      },
      dump() {
        return getPptApp().dump();
      },
      async apply(commands) {
        const P = getPptApp();
        for (const command of commands || []) await applyOp2(P, command, opsContext);
        return (commands || []).length;
      },
      async applyUi(commands) {
        const P = getPptApp();
        for (const command of commands || []) await applyOp2(P, command, opsContext);
        return (commands || []).length;
      },
      onChange(handler) {
        const P = getPptApp();
        if (!P || typeof P.on !== "function") return null;
        P.on("change", handler);
        return () => {
          try {
            P.off?.("change", handler);
          } catch {
          }
        };
      },
      renderScreenshot() {
        return renderSheet2(getPptApp());
      }
    };
    const client = createEditorClient({
      api,
      apiBase,
      clientId,
      adapter,
      authority: "server",
      documentKey: "deck",
      documentPath: "/deck",
      storage: typeof localStorage !== "undefined" ? localStorage : null,
      heartbeatWorkerUrl: "./heartbeat-worker.js",
      singletonKey: "ppt-workbench-singleton",
      onStatus: ui2.badge,
      onNote: ui2.note
    });
    async function quick(text) {
      const cmds = parseQuick(text);
      if (!cmds) {
        client.note("快捷栏只认：背景<颜色> / 第N页标题改成X / 加一页 X —— 其它请在 dsh 会话里说");
        return;
      }
      try {
        await client.applyLocal(cmds);
        client.note("已执行（本地直改）");
      } catch (error) {
        client.note("快捷执行失败：" + String(error && error.message || error));
      }
    }
    return { ...client, quick };
  }

  // src/editor/runtime.js
  var ASSET_RE = /^\/assets\/[a-f0-9]{64}$/i;
  async function assetToDataUrl(src) {
    if (typeof src !== "string" || !ASSET_RE.test(src)) return src;
    const res = await fetch(src, { cache: "force-cache" });
    if (!res.ok) throw new Error("导出时读取图片对象失败: " + src + " HTTP " + res.status);
    const buf = await res.arrayBuffer();
    const blob = new Blob([buf], { type: res.headers.get("content-type") || "image/png" });
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("图片编码失败"));
      reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
      reader.readAsDataURL(blob);
    });
    return "data:" + (blob.type || "image/png") + ";base64," + base64;
  }
  async function materializeDeckAssets(deck) {
    if (!deck || !Array.isArray(deck.slides)) return deck;
    const copy = JSON.parse(JSON.stringify(deck));
    let changed = false;
    const resolve = async (holder) => {
      if (!holder || typeof holder !== "object" || !ASSET_RE.test(String(holder.src || ""))) return;
      holder.src = await assetToDataUrl(holder.src);
      changed = true;
    };
    for (const slide of copy.slides) {
      if (slide.background && slide.background.type === "image") await resolve(slide.background.image || {});
      for (const element of slide.elements || []) {
        if (element && element.type === "image") await resolve(element);
      }
    }
    return changed ? copy : deck;
  }
  function createRuntime({ getPptApp = () => window.PptApp } = {}) {
    async function ensureRuntime() {
      if (window.PptApp) return;
      if (window.Ppt && window.Ppt.pending) {
        await window.Ppt.pending;
        return;
      }
      const hadWork = "Work" in window;
      const host = hadWork ? window.Work : void 0;
      Object.defineProperty(window, "Work", { value: { register() {
      } }, configurable: true });
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "./ppt-full-app.js";
          s.onload = resolve;
          s.onerror = () => reject(new Error("运行时资产加载失败（relay 的 editor/ 产物缺失？）"));
          document.head.appendChild(s);
        });
      } finally {
        if (hadWork) Object.defineProperty(window, "Work", { value: host, configurable: true });
        else delete window.Work;
      }
      if (!window.PptApp) throw new Error("window.PptApp 未就绪");
    }
    function wrapAssetExport() {
      const P = getPptApp();
      if (!P || typeof P.exportPPTX !== "function" || P.__pptAssetExportWrapped) return;
      const original = P.exportPPTX.bind(P);
      P.exportPPTX = async (...args) => {
        const before = P.dump();
        const materialized = await materializeDeckAssets(before);
        if (materialized === before) return original(...args);
        await P.load(materialized, { resetHistory: false });
        try {
          return await original(...args);
        } finally {
          await P.load(before, { resetHistory: false });
        }
      };
      P.__pptAssetExportWrapped = true;
    }
    return { ensureRuntime, wrapAssetExport };
  }

  // src/editor/transport.js
  function createTransport(basePath, fetchImpl = (...args) => fetch(...args)) {
    const api = (path, options) => fetchImpl(basePath + path, options).then((response) => response.json());
    return {
      api,
      get: (path) => api(path),
      post: (path, body) => api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
    };
  }

  // ../../../packages/dsh-document-workbench/src/client/screenshot.mjs
  async function composeContactSheet({
    renderSlides,
    slideCount = 0,
    columns = 2,
    width,
    aspectRatio = 9 / 16,
    gap = 8,
    background = "#222",
    quality = 0.7,
    format = "jpeg",
    renderQuality,
    timeoutMs,
    loadImage: loadImage2 = defaultLoadImage,
    createCanvas = defaultCreateCanvas
  } = {}) {
    if (typeof renderSlides !== "function") throw new Error("composeContactSheet 需要 renderSlides");
    const total = Number(slideCount) || 0;
    const large = total > 8;
    const tileWidth = width ?? (large ? 320 : 480);
    const encodeQuality = renderQuality ?? (large ? 0.4 : 0.6);
    const timeout = timeoutMs ?? Math.max(3e4, total * 800);
    const urls = await Promise.race([
      renderSlides({ width: tileWidth, format, quality: encodeQuality }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("renderSlides 超时")), timeout))
    ]);
    if (!urls || urls.length === 0) throw new Error("renderSlides 返回空数组");
    const images = await Promise.all(urls.map((url, index) => loadImage2(url, index)));
    const live = images.filter(Boolean);
    if (live.length === 0) throw new Error("所有页面图片加载失败");
    return composeTiles(live, {
      cols: columns,
      width: tileWidth,
      height: Math.round(tileWidth * aspectRatio),
      gap,
      background,
      quality,
      createCanvas
    });
  }
  async function defaultLoadImage(url, index) {
    if (!url || typeof Image === "undefined") return null;
    try {
      return await new Promise((resolve) => {
        const image = new Image();
        const timer = setTimeout(() => {
          image.src = "";
          resolve(null);
        }, 3e3);
        image.onload = () => {
          clearTimeout(timer);
          resolve(image);
        };
        image.onerror = () => {
          clearTimeout(timer);
          console.warn(`[screenshot] 页面 ${index + 1} 图片加载失败`);
          resolve(null);
        };
        image.src = url;
      });
    } catch (error) {
      console.warn(`[screenshot] 页面 ${index + 1} 异常:`, error.message);
      return null;
    }
  }
  function composeTiles(images, {
    cols = 2,
    width,
    height,
    gap = 8,
    background = "#222",
    quality = 0.7,
    createCanvas = defaultCreateCanvas
  } = {}) {
    const rows = Math.max(1, Math.ceil(images.length / cols));
    const canvas = createCanvas();
    canvas.width = cols * width + (cols + 1) * gap;
    canvas.height = rows * height + (rows + 1) * gap;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    images.forEach((image, index) => {
      const x = gap + index % cols * (width + gap);
      const y = gap + Math.floor(index / cols) * (height + gap);
      ctx.drawImage(image, x, y, width, height);
    });
    return canvas.toDataURL("image/jpeg", quality);
  }
  function defaultCreateCanvas() {
    if (typeof document === "undefined") throw new Error("缺少 createCanvas");
    return document.createElement("canvas");
  }

  // src/editor/screenshot.js
  async function renderSheet(PptApp) {
    if (!PptApp || !PptApp.renderSlides) throw new Error("PptApp 未就绪");
    const total = typeof PptApp.getSlides === "function" ? PptApp.getSlides().length : 0;
    return composeContactSheet({
      renderSlides: (options) => PptApp.renderSlides(options),
      slideCount: total,
      columns: 2,
      gap: 8,
      aspectRatio: 9 / 16
    });
  }

  // src/editor/ui.js
  function createUi({ root = document } = {}) {
    let timer = null;
    const find = (selector) => root.querySelector(selector);
    return {
      note(message) {
        const element = find("[data-note]");
        if (!element) return;
        element.textContent = message || "";
        clearTimeout(timer);
        if (message && !/失败|错误|未连接|未就绪|不能/.test(message)) {
          timer = setTimeout(() => {
            if (element.textContent === message) element.textContent = "";
          }, 4e3);
        }
      },
      badge(text, kind) {
        const element = find("[data-badge]");
        if (!element) return;
        element.textContent = text || "";
        element.dataset.kind = kind || "";
      }
    };
  }

  // src/editor/main.js
  var API_BASE2 = "/api/desktop/works/ppt-bridge";
  var OPS_CTX = { apiBase: API_BASE2, media: { prepareImage: shrinkImage } };
  var $ = (sel) => document.querySelector(sel);
  var transport = createTransport(API_BASE2);
  var ui = createUi();
  var runtime = createRuntime();
  var session = createEditorSession({
    api: transport.api,
    applyOp,
    opsContext: OPS_CTX,
    ui,
    renderSheet,
    clientId: "wb_" + Date.now() + "_" + Math.floor(Math.random() * 1e6)
  });
  var Studio = {
    async bootEditor() {
      const box = $("[data-editor]");
      try {
        await runtime.ensureRuntime();
        await window.PptApp.mount(box);
        runtime.wrapAssetExport();
        await session.restore();
        await session.ensureLinked();
        await session.activate();
        const veil = $("[data-veil]");
        if (veil) {
          veil.style.opacity = "0";
          setTimeout(() => veil.remove(), 260);
        }
        session.claimLoop();
      } catch (e) {
        const note = $("[data-editor-note]");
        if (note) note.innerHTML = "编辑器装载失败：" + esc(String(e && e.message || e)) + '<br><button data-act="retry" style="margin-top:8px">重试</button>';
      }
    },
    note: session.note,
    badge: session.badge
  };
  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  window.addEventListener("pagehide", session.release);
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const P = window.PptApp;
    const need = () => {
      if (!P || !P.isMounted()) {
        session.note("编辑器未就绪");
        return null;
      }
      return P;
    };
    const act = t.dataset.act;
    if (act === "retry") {
      location.reload();
      return;
    }
    if (act === "pptx") {
      const a = need();
      if (a) {
        fetch(API_BASE2 + "/save-pptx", { method: "POST" }).then(async (response) => {
          const body = await response.json().catch(() => ({}));
          if (response.ok && body.ok) {
            session.note("已保存回 " + body.path + (body.backup ? "（备份 " + body.backup + "）" : ""));
          } else {
            session.note("保存失败：" + (body.error || "HTTP " + response.status));
          }
        }).catch((error) => session.note("保存失败：" + String(error && error.message || error)));
      }
    }
    if (act === "json") {
      const a = need();
      if (a) a.saveJSON();
    }
    if (act === "present") {
      const a = need();
      if (a) a.present(0);
    }
    if (act === "exit-present") {
      const a = need();
      if (a) a.exitPresent();
    }
    if (act === "quick") {
      const q = $("[data-quick]");
      if (q && q.value.trim()) session.quick(q.value.trim());
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = e.target.closest && e.target.closest("[data-quick]");
    if (q && q.value.trim()) {
      e.preventDefault();
      session.quick(q.value.trim());
    }
  });
  window.__PPT_DEBUG = {
    get state() {
      const { shotCache, ...rest } = session.state;
      return { ...rest, shotCache: shotCache ? "[cached]" : null, heartbeatWorker: !!session.state.heartbeatWorker };
    },
    Studio,
    session
  };
  Studio.bootEditor();
})();
