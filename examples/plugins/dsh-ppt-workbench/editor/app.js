(() => {
  // src/core/text.js
  var escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  var fontSizeOf = (html) => {
    const m = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(String(html || ""));
    return m ? Number(m[1]) : 0;
  };
  function textHolder(el) {
    if (!el) return null;
    if (el.type === "text") return el;
    if (el.type === "shape" && el.text && typeof el.text.content === "string") return el.text;
    return null;
  }
  var htmlOf = (el) => {
    const h = textHolder(el);
    return h ? String(h.content || "") : "";
  };
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
  function textHtml(current, props, st2) {
    let inner = props.html;
    if (inner == null) {
      if (props.text != null) inner = escapeHtml(String(props.text));
      else inner = String(current || "").replace(/<p[^>]*>/i, "").replace(/<\/p>\s*$/i, "");
    }
    let body = inner;
    if (st2 && st2.bold) body = "<strong>" + body + "</strong>";
    const size = st2 && st2.fontSize != null ? Number(st2.fontSize) : 28;
    let style = "font-size: " + size + "px;";
    if (st2 && st2.color) style += " color: " + String(st2.color) + ";";
    if (st2 && st2.align) style += " text-align: " + String(st2.align) + ";";
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
    if (type !== "text" && type !== "shape" && type !== "image") {
      throw new Error("不支持的 element.type: " + type + "（只支持 text / shape / image）");
    }
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
  function contrast(slide, bg) {
    const rgb = parseColor(bg);
    if (!rgb) return;
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    const fg = lum > 0.62 ? "#1f2d3d" : "#ffffff";
    (slide.elements || []).forEach((el) => {
      if (el.type !== "text") return;
      el.defaultColor = fg;
      if (typeof el.content === "string") {
        el.content = el.content.replace(/color:\s*[^;"']+/g, "color: " + fg);
      }
    });
  }

  // src/core/templates.js
  var clone = (v) => JSON.parse(JSON.stringify(v));
  var T = (s) => (s.elements || []).filter((e) => textHolder(e));
  var setEl = (e, text) => {
    const h = textHolder(e);
    if (h) h.content = setPlainText(h.content, text);
  };
  var plain = (e) => htmlOf(e).replace(/<[^>]+>/g, "").trim();
  var joined = (s) => T(s).map(plain).join(" ");
  var maxFont = (s) => Math.max(0, ...T(s).map((e) => fontSizeOf(htmlOf(e))));
  var isEndText = (s) => /谢谢|THANKS|感谢/i.test(joined(s));
  var isTocText = (s) => /目\s*录/.test(joined(s)) || /CONTENTS?/i.test(joined(s)) && T(s).length >= 3;
  var isContentText = (s) => !/过渡/.test(joined(s)) && (/内容项|在此输入|输入标题|内容页/.test(joined(s)) || T(s).length >= 4 && !isTocText(s));
  var isSectionText = (s) => /过渡/.test(joined(s)) || T(s).length <= 4 && !isTocText(s) && (T(s).some((e) => /^0?\d{1,2}$/.test(plain(e))) || maxFont(s) >= 40);
  var isTocEntry = (e) => {
    const t = plain(e);
    if (!t) return false;
    if (/^(目\s*录|CONTENTS?|C|ONTENT|0?\d{1,2}|[·—\-–])$/i.test(t)) return false;
    return true;
  };
  function classifyTemplate(slides) {
    const n = slides.length;
    const ends = [], tocs = [], covers = [], sections = [], contents = [];
    slides.forEach((s, i) => {
      if (isEndText(s)) ends.push(i);
    });
    slides.forEach((s, i) => {
      if (!isEndText(s) && isTocText(s)) tocs.push(i);
    });
    const firstToc = tocs.length ? tocs[0] : n;
    const lastToc = tocs.length ? tocs[tocs.length - 1] : -1;
    slides.forEach((s, i) => {
      if (ends.includes(i) || tocs.includes(i)) return;
      if (i < firstToc) {
        covers.push(i);
        return;
      }
      if (i <= lastToc) return;
      if (isSectionText(s)) {
        sections.push(i);
        return;
      }
      if (isContentText(s)) {
        contents.push(i);
        return;
      }
      contents.push(i);
    });
    if (!covers.length) covers.push(0);
    if (!ends.length) {
      ends.push(n - 1);
      for (let k = covers.length - 1; k >= 0; k--) if (covers[k] === n - 1) covers.splice(k, 1);
    }
    if (!contents.length) {
      slides.forEach((s, i) => {
        if (i > lastToc && !ends.includes(i)) contents.push(i);
      });
    }
    return { covers, tocs, sections, contents, ends };
  }
  var tocEntryCount = (slides, i) => T(slides[i]).filter(isTocEntry).length;
  var pickPage = (slides, pool, need, cnt) => {
    if (!pool.length) return null;
    const cands = pool.map((i) => ({ i, n: cnt(i) })).filter((x) => x.n >= need);
    if (cands.length) return slides[cands.sort((a, b) => a.n - b.n)[0].i];
    return slides[pool.map((i) => ({ i, n: cnt(i) })).sort((a, b) => b.n - a.n)[0].i];
  };
  var fillCoverEnd = (s, d) => {
    const ts = T(s).slice().sort((a, b) => fontSizeOf(htmlOf(b)) - fontSizeOf(htmlOf(a)));
    const titleEl = ts[0];
    const presenterEl = ts.find((e) => /演讲人|汇报人|作者|presenter/i.test(plain(e)));
    const subtitleEl = ts.find((e) => e !== titleEl && e !== presenterEl);
    if (titleEl && d.title) setEl(titleEl, d.title);
    if (subtitleEl && d.subtitle) setEl(subtitleEl, d.subtitle);
    if (presenterEl) setEl(presenterEl, d.presenter || "");
  };
  var fillToc = (s, entries) => {
    const ts = T(s).filter(isTocEntry);
    ts.forEach((e, k) => {
      if (k < entries.length) setEl(e, entries[k]);
    });
  };
  var fillSection = (s, title, num) => {
    T(s).forEach((e) => {
      const p = plain(e);
      if (/^0?\d{1,2}$/.test(p)) {
        setEl(e, String(num).padStart(2, "0"));
      }
    });
    const rest = T(s).filter((e) => !/^0?\d{1,2}$/.test(plain(e)));
    const titleEl = rest.slice().sort((a, b) => fontSizeOf(htmlOf(b)) - fontSizeOf(htmlOf(a)))[0];
    if (titleEl) setEl(titleEl, title);
    rest.filter((e) => e !== titleEl && /过渡|副标题|小节/.test(plain(e))).forEach((e) => setEl(e, ""));
  };
  var fillContent = (s, d) => {
    const ts = T(s);
    const titleEl = ts.find((e) => /内容页标题|在此输入标题|内容页/.test(plain(e))) || ts.slice().sort((a, b) => fontSizeOf(htmlOf(b)) - fontSizeOf(htmlOf(a)))[0];
    if (titleEl) setEl(titleEl, d.title || "");
    const bullets = d.bullets || [];
    const textOf = (b) => b && typeof b === "object" ? b.text || "" : b || "";
    const detailOf = (b) => b && typeof b === "object" ? b.detail || "" : "";
    const items = ts.filter((e) => e !== titleEl && /内容项标题|在此输入标题|输入标题/.test(plain(e)));
    if (items.length) {
      const bodies = ts.filter((e) => e !== titleEl && /内容项正文|请输入正文|在此输入正文/.test(plain(e)));
      items.forEach((e, k) => setEl(e, textOf(bullets[k])));
      bodies.forEach((e, k) => setEl(e, detailOf(bullets[k])));
      return;
    }
    const slots = ts.filter((e) => e !== titleEl && !/^0?\d{1,2}$/.test(plain(e))).sort((a, b) => (Number(a.top) || 0) - (Number(b.top) || 0) || (Number(a.left) || 0) - (Number(b.left) || 0));
    const rows = [];
    for (const e of slots) {
      const last = rows[rows.length - 1];
      if (last && Math.abs((Number(e.top) || 0) - (Number(last[0].top) || 0)) <= 26) last.push(e);
      else rows.push([e]);
    }
    if (rows.length >= bullets.length) {
      rows.forEach((row, k) => {
        const b = bullets[k];
        if (row[0]) setEl(row[0], textOf(b));
        if (row[1]) setEl(row[1], detailOf(b));
        row.slice(2).forEach((e) => setEl(e, ""));
      });
      return;
    }
    const pair = bullets.every((b) => typeof b === "object" && b.detail) && slots.length >= bullets.length * 2;
    slots.forEach((e, k) => {
      if (pair) {
        const b = bullets[Math.floor(k / 2)];
        setEl(e, k % 2 === 0 ? textOf(b) : detailOf(b));
      } else {
        setEl(e, textOf(bullets[k]));
      }
    });
  };
  function fromTemplate(templates, spec) {
    const tpl = templates && templates[spec.template];
    if (!tpl || !Array.isArray(tpl.slides)) throw new Error("模板不存在: " + spec.template);
    const src = clone(tpl.slides);
    const idx = classifyTemplate(src);
    if (!idx.covers.length) throw new Error("模板结构异常：无封面页");
    const out = [];
    const cv = clone(src[idx.covers[Math.min(
      Math.max(0, Number(spec.coverVariant) || 0),
      idx.covers.length - 1
    )]]);
    fillCoverEnd(cv, spec.cover || {});
    out.push(cv);
    const secs = Array.isArray(spec.sections) ? spec.sections : [];
    if (spec.toc !== false && secs.length) {
      const tp = pickPage(src, idx.tocs, secs.length, (i) => tocEntryCount(src, i));
      if (tp) {
        const t = clone(tp);
        fillToc(t, secs.map((s) => s.title));
        out.push(t);
      }
    }
    secs.forEach((sec, k) => {
      if (idx.sections.length) {
        const s = clone(src[idx.sections[k % idx.sections.length]]);
        fillSection(s, sec.title || "", k + 1);
        out.push(s);
      }
      const cp = pickPage(
        src,
        idx.contents,
        (sec.bullets || []).length,
        (i) => T(src[i]).filter((e) => /内容项标题|在此输入标题|输入标题/.test(plain(e))).length || Math.max(1, T(src[i]).length - 1)
      );
      if (cp) {
        const s = clone(cp);
        fillContent(s, sec);
        out.push(s);
      }
    });
    if (idx.ends.length) {
      const e = clone(src[idx.ends[0]]);
      fillCoverEnd(e, spec.end || {});
      out.push(e);
    }
    return out;
  }

  // src/core/ops.js
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
  async function applyOp(P, c, ctx = {}) {
    if (!P || !P.isMounted()) throw new Error("Keynote 编辑器未就绪");
    const idx = (k) => c[k] != null ? c[k] : c.index;
    const clone2 = (i) => JSON.parse(JSON.stringify(P.getSlides()[i]));
    const templates = () => (ctx.templates ? ctx.templates() : {}) || {};
    switch (c.op) {
      case "load":
        return P.load(c.deck);
      case "set-background": {
        const idxs = Array.isArray(c.indices) ? c.indices : null;
        const n = P.getSlides().length;
        for (let i = 0; i < n; i++) {
          if (idxs && idxs.indexOf(i) < 0) continue;
          const s = clone2(i);
          s.background = { type: "solid", color: String(c.color || "#ffffff") };
          if (c.contrast) contrast(s, String(c.color || "#ffffff"));
          P.updateSlide(i, s);
        }
        return;
      }
      case "set-text": {
        const i = idx("id");
        const s = clone2(i);
        const el = s.elements.find((e) => c.elementId && e.id === c.elementId || !c.elementId && e.type === "text");
        if (!el) throw new Error("set-text 未命中: " + (c.elementId || "首个文本"));
        patchElement(el, c);
        P.updateSlide(i, s);
        return;
      }
      case "set-element": {
        const i = Number(c.slide != null ? c.slide : c.id);
        const s = clone2(i);
        const el = s.elements.find((e) => e.id === c.elementId);
        if (!el) throw new Error("set-element 未命中: " + c.elementId);
        patchElement(el, c.props || {});
        P.updateSlide(i, s);
        return;
      }
      case "add-element": {
        const i = Number(c.slide != null ? c.slide : 0);
        const s = clone2(i);
        const el = makeElement(c.element || {});
        if (el.left != null && el.left >= 1e3 || el.top != null && el.top >= 563 || el.left != null && el.width != null && el.left + el.width <= 0) {
          el.left = Math.max(0, Math.round((1e3 - (el.width || 400)) / 2));
          el.top = Math.max(0, Math.round((562.5 - (el.height || 300)) / 2));
        }
        if (el.type === "image") await shrinkImage(el);
        s.elements.push(el);
        P.updateSlide(i, s);
        return;
      }
      case "remove-element": {
        const i = Number(c.slide != null ? c.slide : 0);
        const s = clone2(i);
        const n = s.elements.length;
        s.elements = s.elements.filter((e) => e.id !== c.elementId);
        if (s.elements.length === n) throw new Error("remove-element 未命中: " + c.elementId);
        P.updateSlide(i, s);
        return;
      }
      case "template": {
        const t = templates()[c.id];
        if (!t || !Array.isArray(t.slides)) throw new Error("模板不存在: " + c.id);
        await P.load({ title: t.title || c.id, slides: JSON.parse(JSON.stringify(t.slides)) });
        if (t.theme) P.setTheme(t.theme);
        return;
      }
      case "fill-slot": {
        const i = Number(c.slide) | 0;
        const s = clone2(i);
        const texts = (s.elements || []).filter((e) => e.type === "text");
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
        return;
      }
      case "template-deck": {
        const slides = fromTemplate(templates(), c);
        return P.load({ title: c.title || "演示文稿", slides });
      }
      case "recolor": {
        const bg = String(c.background || "#ffffff");
        const rgb = parseColor(bg);
        const lum = rgb ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 : 1;
        const fg = c.text ? String(c.text) : lum > 0.62 ? "#1f2d3d" : "#ffffff";
        const shapeFill = c.shapes === null ? null : String(c.shapes != null && c.shapes !== true ? c.shapes : fg);
        const n = P.getSlides().length;
        for (let i = 0; i < n; i++) {
          if (Array.isArray(c.indices) && c.indices.indexOf(i) < 0) continue;
          const s = clone2(i);
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
        return;
      }
      case "add-slide":
        return void P.addSlide(c.slide || {}, c.index);
      case "update-slide": {
        if (!P.updateSlide(idx("id"), c.slide)) throw new Error("update-slide 未命中");
        return;
      }
      case "remove-slide": {
        if (!P.removeSlide(idx("id"))) throw new Error("remove-slide 未命中");
        return;
      }
      case "move-slide": {
        if (!P.moveSlide(c.from, c.to)) throw new Error("move-slide 越界");
        return;
      }
      case "duplicate-slide": {
        if (!P.duplicateSlide(idx("id"))) throw new Error("duplicate-slide 未命中");
        return;
      }
      case "select": {
        if (!P.selectSlide(idx("id"))) throw new Error("select 未命中");
        return;
      }
      case "title":
        return void P.setTitle(String(c.title || ""));
      case "theme": {
        const th = P.getTheme() || {};
        Object.assign(th, c.theme || {});
        P.setTheme(th);
        return;
      }
      case "undo":
        return P.undo();
      case "redo":
        return P.redo();
      case "present":
        return P.present(c.index != null ? c.index : void 0);
      case "exit-present":
        return P.exitPresent();
      case "sleep":
        return new Promise((r) => setTimeout(r, Math.min(3e3, Math.max(0, Number(c.ms) || 600))));
      default:
        throw new Error("未知指令: " + String(c.op || JSON.stringify(c).slice(0, 40)));
    }
  }

  // src/core/quick.js
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
        const idx = t.indexOf(k);
        if (idx < 0) continue;
        if (!best || k.length > best.k.length || k.length === best.k.length && idx < best.idx) best = { k, idx };
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

  // src/editor/main.js
  var TEMPLATES = () => window.__pptTemplates || {};
  var $ = (sel) => document.querySelector(sel);
  function api(path, opts) {
    return fetch("/api/desktop/works/ppt-bridge" + path, opts).then((r) => r.json());
  }
  var st = {
    clientId: "wb_" + Date.now() + "_" + Math.floor(Math.random() * 1e6),
    active: false,
    heartbeat: null,
    heartbeatWorker: null,
    lastSeq: 0,
    lastShotReq: 0,
    busy: false,
    shooting: false,
    pumping: false,
    watching: false,
    onchange: null,
    stateTimer: null,
    shotCache: null,
    // shotCache: 截图首帧缓存
    singletonKey: "ppt-workbench-singleton"
    // localStorage 单例广播键
  };
  var Studio = {
    /* ---- 运行时装载（同源 PPTist bundle，单例复用）---- */
    async ensureRuntime() {
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
    },
    async bootEditor() {
      const box = $("[data-editor]");
      try {
        await Studio.ensureRuntime();
        await window.PptApp.mount(box);
        await Studio.restore();
        const veil = $("[data-veil]");
        if (veil) {
          veil.style.opacity = "0";
          setTimeout(() => veil.remove(), 260);
        }
        Studio.claimLoop();
      } catch (e) {
        const note = $("[data-editor-note]");
        if (note) note.innerHTML = "编辑器装载失败：" + esc(String(e && e.message || e)) + '<br><button data-act="retry" style="margin-top:8px">重试</button>';
      }
    },
    async restore() {
      try {
        const doc = await api("");
        if (doc && doc.deck && Array.isArray(doc.deck.slides) && doc.deck.slides.length) {
          await window.PptApp.load(doc.deck);
        }
        st.lastSeq = Number(doc && doc.seq) || 0;
      } catch (e) {
      }
    },
    async claim() {
      try {
        const r = await api("/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: st.clientId })
        });
        return !!(r && r.ok);
      } catch (e) {
        return false;
      }
    },
    async claimLoop() {
      window.addEventListener("storage", (e) => {
        if (e.key === st.singletonKey && e.newValue && e.newValue !== st.clientId) {
          if (st.active) {
            st.active = false;
            Studio.stopHeartbeatWorker();
            Studio.badge("待命", "wait");
            Studio.note("另一个编辑器窗口接管了这份 deck，本窗口已暂停同步");
          }
        }
      });
      for (; ; ) {
        if (await Studio.claim()) {
          st.active = true;
          try {
            localStorage.setItem(st.singletonKey, st.clientId);
          } catch (e) {
          }
          Studio.badge("已接管", "ok");
          Studio.note("");
          Studio.watch();
          Studio.pump();
          Studio.startHeartbeatWorker();
          return;
        }
        Studio.badge("待命", "wait");
        Studio.note("另一个编辑器窗口正在操作这份 deck，本窗口待命…");
        await new Promise((r) => setTimeout(r, 1e3));
      }
    },
    /* ---- 指令应用：core/ops（唯一分发实现）---- */
    async apply(doc) {
      st.busy = true;
      let applied = 0, error = "";
      try {
        for (const c of doc.cmds) {
          await applyOp(window.PptApp, c, { templates: TEMPLATES });
          applied++;
        }
      } catch (e) {
        error = String(e && e.message || e);
        if (!window.PptApp || !window.PptApp.isMounted()) st.lastSeq = 0;
      }
      try {
        await api("/ack", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ seq: doc.seq, applied, error })
        });
      } catch (e) {
      }
      st.busy = false;
      Studio.note(error ? "第 " + doc.seq + " 队应用失败：" + error : "第 " + doc.seq + " 队已应用（" + applied + " 条）");
      Promise.resolve().then(() => Studio.pushState(doc.seq)).catch(() => {
      });
    },
    async quick(text) {
      const cmds = parseQuick(text);
      if (!cmds) {
        Studio.note("快捷栏只认：背景<颜色> / 第N页标题改成X / 加一页 X —— 其它请在 dsh 会话里说");
        return;
      }
      try {
        for (const c of cmds) await applyOp(window.PptApp, c, { templates: TEMPLATES });
        Studio.pushState();
        Studio.note("已执行（本地直改）");
      } catch (e) {
        Studio.note("快捷执行失败：" + String(e && e.message || e));
      }
    },
    /* ---- 长轮询泵：seq/shot 任一变化即返；优化：3s 超时 + 500ms 重试 ---- */
    async pump() {
      if (st.pumping) return;
      st.pumping = true;
      try {
        for (; ; ) {
          if (!st.active) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          try {
            const doc = await api("/watch?seq=" + st.lastSeq + "&shot=" + st.lastShotReq + "&timeout=3");
            if (doc.shot_req && doc.shot_req > st.lastShotReq) {
              st.lastShotReq = doc.shot_req;
              Studio.shoot(doc.shot_req);
            }
            if (doc.seq !== st.lastSeq) {
              if (!window.PptApp || !window.PptApp.isMounted()) {
                await new Promise((r) => setTimeout(r, 500));
                continue;
              }
              st.lastSeq = doc.seq;
              if (doc.seq > 0) await Studio.apply(doc);
            }
          } catch (e) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      } finally {
        st.pumping = false;
      }
    },
    /* ---- 截图：首帧缓存优先(80ms) + 后台全量刷新(2.5s) ---- */
    async shoot(req) {
      if (st.shooting) return;
      st.shooting = true;
      try {
        if (st.shotCache) {
          await api("/shot-result", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ req, data: st.shotCache })
          });
        }
        let data = "";
        for (let attempt = 0; attempt < 2 && !data; attempt++) {
          try {
            data = await Studio.sheet();
          } catch (e) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        if (!data) throw new Error("画面渲染为空");
        st.shotCache = data;
        await api("/shot-result", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ req, data })
        });
      } catch (e) {
        Studio.note("截图失败：" + String(e && e.message || e));
      } finally {
        st.shooting = false;
      }
    },
    /* ---- 分页截图引擎（单一职责拆分，支持异常跳过）---- */
    async sheet() {
      const P = window.PptApp;
      if (!P || !P.renderSlides) throw new Error("PptApp 未就绪");
      const urls = await Promise.race([
        P.renderSlides({ width: 480, format: "jpeg", quality: 0.6 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("renderSlides 超时")), 8e3))
      ]);
      if (!urls || urls.length === 0) throw new Error("renderSlides 返回空数组");
      const imgs = await Promise.all(urls.map((u, i) => Studio.loadImage(u, i)));
      const live = imgs.filter(Boolean);
      if (live.length === 0) throw new Error("所有页面图片加载失败");
      return Studio.composeTiles(live, { cols: 2, width: 480, height: 270, gap: 8 });
    },
    /* 图片加载器（纯函数，容错返回 null） */
    async loadImage(url, index) {
      if (!url) return null;
      try {
        return await new Promise((res, rej) => {
          const im = new Image();
          const timer = setTimeout(() => {
            im.src = "";
            res(null);
          }, 3e3);
          im.onload = () => {
            clearTimeout(timer);
            res(im);
          };
          im.onerror = () => {
            clearTimeout(timer);
            console.warn(`[screenshot] 页面 ${index + 1} 图片加载失败`);
            res(null);
          };
          im.src = url;
        });
      } catch (e) {
        console.warn(`[screenshot] 页面 ${index + 1} 异常:`, e.message);
        return null;
      }
    },
    /* 拼图组合器（纯函数，2列网格） */
    composeTiles(images, { cols, width, height, gap }) {
      const rows = Math.max(1, Math.ceil(images.length / cols));
      const cv = document.createElement("canvas");
      cv.width = cols * width + (cols + 1) * gap;
      cv.height = rows * height + (rows + 1) * gap;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#222";
      ctx.fillRect(0, 0, cv.width, cv.height);
      images.forEach((im, i) => {
        const x = gap + i % cols * (width + gap);
        const y = gap + Math.floor(i / cols) * (height + gap);
        ctx.drawImage(im, x, y, width, height);
      });
      return cv.toDataURL("image/jpeg", 0.7);
    },
    note(msg) {
      const n = $("[data-note]");
      if (n) n.textContent = msg || "";
    },
    badge(text, kind) {
      const b = $("[data-badge]");
      if (!b) return;
      b.textContent = text;
      b.dataset.kind = kind || "";
    },
    /* ---- 状态镜像：PptApp change → 防抖 POST /state（agent 的「看」）---- */
    watch() {
      if (st.watching || !window.PptApp) return;
      st.watching = true;
      st.onchange = () => {
        clearTimeout(st.stateTimer);
        st.stateTimer = setTimeout(() => Studio.pushState(), 800);
      };
      window.PptApp.on("change", st.onchange);
    },
    async pushState(seq) {
      const P = window.PptApp;
      if (!P || !P.isMounted()) return;
      if (!st.active) return;
      try {
        const body = { deck: P.dump() };
        if (seq != null) body.seq = Number(seq);
        else if (st.lastSeq) body.seq = Number(st.lastSeq);
        await api("/state", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
      } catch (e) {
      }
    },
    release() {
      try {
        const body = new Blob([JSON.stringify({ id: st.clientId })], { type: "application/json" });
        navigator.sendBeacon("/api/desktop/works/ppt-bridge/release", body);
      } catch (e) {
      }
    },
    /* ---- Web Worker 心跳（不受标签页节流影响）---- */
    startHeartbeatWorker() {
      if (st.heartbeatWorker) return;
      try {
        st.heartbeatWorker = new Worker("./heartbeat-worker.js");
        st.heartbeatWorker.onmessage = (e) => {
          const { type, message } = e.data;
          if (type === "error") {
            console.error("[心跳Worker] 错误:", message);
            Studio.stopHeartbeatWorker();
            Studio.startFallbackHeartbeat();
          } else if (type === "heartbeat") {
          }
        };
        st.heartbeatWorker.onerror = (err) => {
          console.error("[心跳Worker] Worker 错误:", err);
          Studio.stopHeartbeatWorker();
          Studio.startFallbackHeartbeat();
        };
        st.heartbeatWorker.postMessage({
          type: "start",
          data: {
            clientId: st.clientId,
            apiBase: "/api/desktop/works/ppt-bridge"
          }
        });
      } catch (e) {
        console.error("[心跳Worker] 创建失败，使用降级方案:", e);
        Studio.startFallbackHeartbeat();
      }
    },
    stopHeartbeatWorker() {
      if (st.heartbeatWorker) {
        st.heartbeatWorker.postMessage({ type: "stop" });
        st.heartbeatWorker.terminate();
        st.heartbeatWorker = null;
      }
      if (st.heartbeat) {
        clearInterval(st.heartbeat);
        st.heartbeat = null;
      }
    },
    /* 降级方案：主线程心跳（受节流影响，但总比没有好）*/
    startFallbackHeartbeat() {
      if (st.heartbeat) return;
      st.heartbeat = setInterval(async () => {
        if (!st.active) return;
        const ok = await Studio.claim();
        if (!ok) {
          st.active = false;
          Studio.badge("待命", "wait");
          Studio.note("另一个编辑器窗口接管了这份 deck，本窗口已暂停同步");
        }
      }, 3e3);
    }
  };
  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  window.addEventListener("pagehide", Studio.release);
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const P = window.PptApp;
    const need = () => {
      if (!P || !P.isMounted()) {
        Studio.note("编辑器未就绪");
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
      if (a) a.exportPPTX();
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
      if (q && q.value.trim()) Studio.quick(q.value.trim());
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = e.target.closest && e.target.closest("[data-quick]");
    if (q && q.value.trim()) {
      e.preventDefault();
      Studio.quick(q.value.trim());
    }
  });
  Studio.bootEditor();
})();
