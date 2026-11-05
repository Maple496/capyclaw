/**
 * 容错 HTML 解析器（纯 Node 内置实现，零外部依赖）。
 *
 * 目的：为 ctx.scrapling.parse() / 选择器引擎提供文档树。
 * 仓库约定不引入 cheerio/jsdom 等依赖，因此这里实现一个
 * 「HTML5 子集 + 常见畸形容错」的单遍解析器：
 *
 *   - void 元素（br/img/input…）不进栈；
 *   - script/style/textarea/title 按 raw text 处理；
 *   - li/p/td/tr/dt/dd/option 等按隐式闭合规则自动补闭；
 *   - 孤立结束标签、未闭合标签、属性引号缺失、大小写混杂均可容忍；
 *   - 文本与属性值做实体解码（常用命名实体 + 数字实体）。
 *
 * 节点形状（普通对象，便于序列化与遍历）：
 *   元素  { tag, attrs, children, parent, sourceSpan? }
 *   文本  { tag: '#text', text, parent }
 *   注释  { tag: '#comment', text, parent }
 */

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** raw text 元素：内容直到对应结束标签，不做标签解析。 */
const RAWTEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title'])

/**
 * 隐式闭合表：遇到 key 开始标签时，栈顶若是 value 集合中的元素则自动弹出。
 * 覆盖真实页面最常见的嵌套错误（li 未闭、td 未闭、p 套 p 等）。
 */
const IMPLICIT_CLOSES = {
  li: new Set(['li']),
  p: new Set(['p']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  td: new Set(['td', 'th']),
  th: new Set(['td', 'th']),
  tr: new Set(['tr', 'td', 'th']),
  thead: new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th']),
  tbody: new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th']),
  tfoot: new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th']),
  option: new Set(['option']),
  optgroup: new Set(['option', 'optgroup']),
}

/** 块级元素开始时会隐式闭合未关闭的 <p>（HTML5 规范子集）。 */
const P_CLOSERS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol',
  'p', 'pre', 'section', 'table', 'ul',
])

/** 常用命名实体（够覆盖真实页面 95%+ 的情况，其余按字面量保留）。 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', copy: '©', reg: '®', trade: '™',
  deg: '°', middot: '·', laquo: '«', raquo: '»', times: '×', divide: '÷',
  plusmn: '±', para: '¶', sect: '§', bull: '•', dagger: '†', euro: '€',
  pound: '£', yen: '¥', cent: '¢', frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', micro: 'µ', shy: '\u00ad', ensp: '\u2002', emsp: '\u2003',
}

const ENTITY_RE = /&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});?/g

/** 实体解码：命名/十进制/十六进制；无法识别时原样保留。 */
export function decodeEntities(input) {
  if (!input || input.indexOf('&') < 0) return input
  return input.replace(ENTITY_RE, (raw, body) => {
    let replacement = null
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { replacement = String.fromCodePoint(code) } catch { replacement = null }
      }
    } else if (raw.endsWith(';')) {
      replacement = NAMED_ENTITIES[body] ?? null
    }
    return replacement ?? raw
  })
}

const TAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9:_.-]*/

/** 解析一段 HTML，返回 #document 根节点。 */
export function parseHtml(html) {
  const source = typeof html === 'string' ? html : String(html ?? '')
  const doc = { tag: '#document', attrs: {}, children: [], parent: null }
  const stack = [doc]
  const top = () => stack[stack.length - 1]

  const appendNode = (node) => {
    node.parent = top()
    top().children.push(node)
  }
  const appendText = (raw, { decode = true } = {}) => {
    if (!raw) return
    appendNode({ tag: '#text', text: decode ? decodeEntities(raw) : raw })
  }

  let pos = 0
  const len = source.length

  while (pos < len) {
    const lt = source.indexOf('<', pos)
    if (lt < 0) { appendText(source.slice(pos)); break }
    if (lt > pos) appendText(source.slice(pos, lt))

    const rest = source.slice(lt)
    if (rest.startsWith('<!--')) {
      const end = source.indexOf('-->', lt + 4)
      const stop = end < 0 ? len : end + 3
      appendNode({ tag: '#comment', text: source.slice(lt + 4, end < 0 ? len : end) })
      pos = stop
      continue
    }
    if (rest.startsWith('<!') || rest.startsWith('<?')) {
      const end = source.indexOf('>', lt)
      pos = end < 0 ? len : end + 1
      continue
    }
    if (rest.startsWith('</')) {
      const after = lt + 2
      const nameMatch = TAG_NAME_RE.exec(source.slice(after))
      if (!nameMatch) {
        // 形如 '</ >' 或 '</3'：当普通文本处理
        appendText('</')
        pos = after
        continue
      }
      const name = nameMatch[0].toLowerCase()
      const closeAt = source.indexOf('>', after)
      pos = closeAt < 0 ? len : closeAt + 1
      // 从栈顶向下找同名开标签；找到则弹到它为止，找不到则忽略（孤立结束标签）
      let idx = -1
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === name) { idx = i; break }
      }
      if (idx > 0) stack.length = idx
      continue
    }

    const nameMatch = TAG_NAME_RE.exec(rest.slice(1))
    if (!nameMatch) {
      // '<' 后不是标签名（如 "3 < 5"）：按文本处理
      appendText('<')
      pos = lt + 1
      continue
    }

    const name = nameMatch[0].toLowerCase()
    const { attrs, selfClosing, nextPos } = readTag(source, lt + 1 + nameMatch[0].length)
    pos = nextPos

    // 隐式闭合：新开始标签触发的栈顶弹出
    const closes = IMPLICIT_CLOSES[name]
    if (closes) {
      while (stack.length > 1 && closes.has(top().tag)) stack.pop()
    } else if (P_CLOSERS.has(name)) {
      while (stack.length > 1 && top().tag === 'p') stack.pop()
    }

    const node = { tag: name, attrs, children: [], parent: null }
    appendNode(node)

    if (selfClosing || VOID_ELEMENTS.has(name)) continue

    if (RAWTEXT_ELEMENTS.has(name)) {
      const { text, nextPos: rawNext } = readRawText(source, pos, name)
      /* raw text 直接挂到当前元素（该元素未入栈，不能用 appendNode） */
      node.children.push({
        tag: '#text',
        text: name === 'script' || name === 'style' ? text : decodeEntities(text),
        parent: node,
      })
      pos = rawNext
      continue
    }

    stack.push(node)
  }

  return doc
}

/**
 * 读取开始标签的属性直到 '>'，返回小写属性表 / 是否自闭合 / 下一个读取位置。
 * 容错：属性值引号可缺失，布尔属性值为空串，重复属性取首个。
 */
function readTag(source, pos) {
  const attrs = {}
  const len = source.length
  let selfClosing = false
  let i = pos

  for (;;) {
    while (i < len && /\s/.test(source[i])) i++
    if (i >= len) return { attrs, selfClosing, nextPos: len }
    const ch = source[i]
    if (ch === '>') return { attrs, selfClosing, nextPos: i + 1 }
    if (ch === '/') {
      // "/>" → 自闭合；孤立的 '/' 当分隔符
      if (source[i + 1] === '>') return { attrs, selfClosing: true, nextPos: i + 2 }
      i++
      continue
    }
    // 属性名
    let start = i
    while (i < len && !/[\s=>/]/.test(source[i])) i++
    const attrName = source.slice(start, i).toLowerCase()
    while (i < len && /\s/.test(source[i])) i++
    let value = ''
    if (source[i] === '=') {
      i++
      while (i < len && /\s/.test(source[i])) i++
      const quote = source[i]
      if (quote === '"' || quote === "'") {
        i++
        const valueEnd = source.indexOf(quote, i)
        const stop = valueEnd < 0 ? len : valueEnd
        value = source.slice(i, stop)
        i = valueEnd < 0 ? len : valueEnd + 1
      } else {
        start = i
        while (i < len && !/[\s>]/.test(source[i])) i++
        value = source.slice(start, i)
      }
    }
    if (attrName && !(attrName in attrs)) attrs[attrName] = decodeEntities(value)
  }
}

/** 读取 raw text 元素内容（直到 </name，大小写不敏感），返回原文与结束位置。 */
function readRawText(source, pos, name) {
  const lower = source.toLowerCase()
  const needle = `</${name}`
  const found = lower.indexOf(needle, pos)
  if (found < 0) return { text: source.slice(pos), nextPos: source.length }
  const closeAt = source.indexOf('>', found)
  return { text: source.slice(pos, found), nextPos: closeAt < 0 ? source.length : closeAt + 1 }
}

/** 判断节点是否为元素（非文本/注释）。 */
export function isElement(node) {
  return !!node && node.tag !== '#text' && node.tag !== '#comment' && node.tag !== '#document'
}

/** 元素的父元素（跳过 #document）。 */
export function parentElement(node) {
  const parent = node?.parent
  return parent && parent.tag !== '#document' ? parent : null
}

/** 收集文档/子树统计信息（元素数、最大深度、纯文本长度、标题）。 */
export function documentStats(doc) {
  let elements = 0
  let maxDepth = 0
  let textLength = 0
  let title = ''
  const walk = (node, depth) => {
    maxDepth = Math.max(maxDepth, depth)
    for (const child of node.children || []) {
      if (child.tag === '#text') { textLength += child.text.length; continue }
      if (child.tag === '#comment') continue
      elements++
      if (child.tag === 'title' && !title) {
        title = (child.children || []).filter((c) => c.tag === '#text').map((c) => c.text).join('').trim()
      }
      walk(child, depth + 1)
    }
  }
  walk(doc, 0)
  return { elements, maxDepth, textLength, title }
}
