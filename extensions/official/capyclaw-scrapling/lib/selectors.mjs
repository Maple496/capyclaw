/**
 * CSS 选择器引擎（Scrapy/parsel 语义子集，纯 Node 实现）。
 *
 * 与 ctx.scrapling.parse(html).css(selector) 配套：
 *   - 复合选择器：tag / * / .class / #id / [attr] / [attr=v] / [attr^=v] /
 *     [attr$=v] / [attr*=v] / [attr~=v] / [attr|=v]
 *   - 结构伪类：:first-child / :last-child / :nth-child(k)（k 从 1 计）
 *   - 组合器：后代（空格）、子代（>）、相邻（+）
 *   - 末端伪元素：::text（元素内文本节点逐条返回）、::attr(name)
 *   - 逗号分组：命中顺序按文档序、去重
 *
 * 作用域语义与 parsel 对齐：wrapper.css() 在元素作用域内匹配后代，
 * 元素自身可作为组合器链上的祖先参与匹配，但不会被选为结果。
 *
 * 能力边界（诚实声明）：不支持 XPath（parse().xpath 抛 NOT_IMPLEMENTED）、
 * 不支持 :not()/:has() 等复杂伪类；超出子集的需求请拆成多个简单选择器。
 */

import { isElement, parseHtml } from './html-parser.mjs'

/** 解析失败时抛出的错误（HTTP 层转 400）。 */
export class SelectorError extends Error {
  constructor(message) {
    super(message)
    this.code = 'SELECTOR_INVALID'
  }
}

/** 按顶层逗号切分选择器分组（跳过 [] 与引号内的逗号）。 */
function splitTopLevel(source) {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (const ch of source) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue }
    if (ch === '[') depth++
    if (ch === ']') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += ch
  }
  parts.push(current)
  return parts
}

/** 解析选择器字符串 → 结构化选择器列表；非法输入抛 SelectorError。 */
export function parseSelectorList(input) {
  const source = String(input ?? '').trim()
  if (!source) throw new SelectorError('选择器为空')
  const parts = splitTopLevel(source)
  return parts.map((part) => parseComplexSelector(part.trim(), source))
}

function parseComplexSelector(source, full) {
  if (!source) throw new SelectorError(`选择器存在空分组: "${full}"`)
  let pseudo = null
  // 末端伪元素只允许出现在整个分组末尾
  const pseudoMatch = /::(text|attr)\s*(?:\(\s*([-\w]+)\s*\))?\s*$/.exec(source)
  if (pseudoMatch) {
    if (pseudoMatch[1] === 'text') pseudo = { kind: 'text' }
    else {
      if (!pseudoMatch[2]) throw new SelectorError(`::attr 需要属性名，如 ::attr(href)：${source}`)
      pseudo = { kind: 'attr', name: pseudoMatch[2].toLowerCase() }
    }
  }
  const body = pseudo ? source.slice(0, source.length - pseudoMatch[0].length).trim() : source
  if (!body) throw new SelectorError(`选择器缺少主体: "${source}"`)

  const compounds = []
  const combinators = []
  let i = 0
  while (i < body.length) {
    const { compound, next } = readCompound(body, i)
    if (!compound) throw new SelectorError(`无法解析选择器（位置 ${i}）: "${source}"`)
    if (compounds.length) combinators.push(compound.__combinator)
    delete compound.__combinator
    compounds.push(compound)
    i = next
  }
  return { compounds, combinators, pseudo, source }
}

/**
 * 读取一个复合选择器；若其与前一个之间有组合器（空白/>/+），
 * 记录在 compound.__combinator（首个复合选择器不使用该值）。
 */
function readCompound(body, start) {
  let i = start
  let combinator = null
  for (;;) {
    while (i < body.length && /\s/.test(body[i])) i++
    if (body[i] === '>' || body[i] === '+') {
      if (combinator) throw new SelectorError(`连续组合器: "${body}"`)
      combinator = body[i] === '>' ? 'child' : 'adjacent'
      i++
      continue
    }
    break
  }
  if (i >= body.length) {
    if (combinator) throw new SelectorError(`选择器以组合器结尾: "${body}"`)
    return { compound: null, next: i }
  }
  if (!combinator && i > start && /\s/.test(body[start])) combinator = 'descendant'

  const compound = {
    tag: '*', classes: [], id: null, attrs: [], pseudoClasses: [],
    __combinator: combinator || 'descendant',
  }
  /* 标识符允许非 ASCII（中文站点类名/ID 常见），与 CSS 标识符规则对齐。 */
  const IDENT = '[-\\w\\u00a0-\\uffff]'
  const tagMatch = new RegExp(`^[a-zA-Z]${IDENT}*`).exec(body.slice(i))
  if (tagMatch) {
    compound.tag = tagMatch[0].toLowerCase()
    i += tagMatch[0].length
  } else if (body[i] === '*') {
    i++
  }

  let consumed = compound.tag !== '*' || body[start] === '*'
  for (;;) {
    const ch = body[i]
    if (ch === '.') {
      const m = new RegExp(`^\\.(${IDENT}+)`).exec(body.slice(i))
      if (!m) throw new SelectorError(`类名不合法（位置 ${i}）: "${body}"`)
      compound.classes.push(m[1])
      i += m[0].length
      consumed = true
      continue
    }
    if (ch === '#') {
      const m = new RegExp(`^#(${IDENT}+)`).exec(body.slice(i))
      if (!m) throw new SelectorError(`ID 不合法（位置 ${i}）: "${body}"`)
      if (compound.id) throw new SelectorError(`重复 ID 选择器: "${body}"`)
      compound.id = m[1]
      i += m[0].length
      consumed = true
      continue
    }
    if (ch === '[') {
      const { attr, next } = readAttrSelector(body, i)
      compound.attrs.push(attr)
      i = next
      consumed = true
      continue
    }
    if (ch === ':') {
      if (body[i + 1] === ':') throw new SelectorError(`伪元素只能出现在选择器末尾: "${body}"`)
      const m = /^:([-\w]+)(?:\(\s*(\d+)\s*\))?/.exec(body.slice(i))
      if (!m) throw new SelectorError(`伪类不合法（位置 ${i}）: "${body}"`)
      const kind = m[1].toLowerCase()
      if (kind === 'first-child') compound.pseudoClasses.push({ kind: 'first-child' })
      else if (kind === 'last-child') compound.pseudoClasses.push({ kind: 'last-child' })
      else if (kind === 'nth-child') {
        if (!m[2]) throw new SelectorError(`:nth-child 需要数字参数，如 :nth-child(2)：${body}`)
        compound.pseudoClasses.push({ kind: 'nth-child', n: Number(m[2]) })
      } else {
        throw new SelectorError(`不支持的伪类 :${kind}（支持 :first-child / :last-child / :nth-child(k)）`)
      }
      i += m[0].length
      consumed = true
      continue
    }
    break
  }
  if (!consumed) throw new SelectorError(`无法解析选择器（位置 ${i}）: "${body}"`)
  return { compound, next: i }
}

/** 读取 [attr] / [attr op value]；op ∈ = ^= $= *= ~= |=。 */
function readAttrSelector(body, start) {
  const close = body.indexOf(']', start)
  if (close < 0) throw new SelectorError(`属性选择器缺少 ']': "${body.slice(start)}"`)
  const inner = body.slice(start + 1, close).trim()
  const m = /^(-?[_a-zA-Z][-\w]*)(?:\s*(=|\^=|\$=|\*=|~=|\|=)\s*(.+))?$/.exec(inner)
  if (!m) throw new SelectorError(`属性选择器不合法: [${inner}]`)
  const name = m[1].toLowerCase()
  const op = m[2] || null
  let value = null
  if (op) {
    value = m[3].trim()
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1)
    }
    if (!value) throw new SelectorError(`属性选择器值不能为空: [${inner}]`)
  }
  return { attr: { name, op, value }, next: close + 1 }
}

/** 单个复合选择器是否匹配节点。 */
function matchCompound(node, compound) {
  if (!isElement(node)) return false
  if (compound.tag !== '*' && node.tag !== compound.tag) return false
  if (compound.id && node.attrs.id !== compound.id) return false
  for (const cls of compound.classes) {
    const list = typeof node.attrs.class === 'string' ? node.attrs.class.split(/\s+/).filter(Boolean) : []
    if (!list.includes(cls)) return false
  }
  for (const { name, op, value } of compound.attrs) {
    const actual = node.attrs[name]
    if (actual === undefined) return false
    if (op === null) continue
    switch (op) {
      case '=': if (actual !== value) return false; break
      case '^=': if (!actual.startsWith(value)) return false; break
      case '$=': if (!actual.endsWith(value)) return false; break
      case '*=': if (!actual.includes(value)) return false; break
      case '~=': if (!actual.split(/\s+/).includes(value)) return false; break
      case '|=': if (actual !== value && !actual.startsWith(`${value}-`)) return false; break
      default: return false
    }
  }
  for (const pseudo of compound.pseudoClasses) {
    const siblings = elementSiblings(node)
    if (pseudo.kind === 'first-child' && siblings[0] !== node) return false
    if (pseudo.kind === 'last-child' && siblings[siblings.length - 1] !== node) return false
    if (pseudo.kind === 'nth-child' && siblings[pseudo.n - 1] !== node) return false
  }
  return true
}

/** 同一父节点下的元素兄弟（含自身）。 */
function elementSiblings(node) {
  const parent = node.parent
  if (!parent) return [node]
  return (parent.children || []).filter(isElement)
}

/** 节点的前一个元素兄弟。 */
function prevElementSibling(node) {
  const siblings = elementSiblings(node)
  const at = siblings.indexOf(node)
  return at > 0 ? siblings[at - 1] : null
}

/**
 * 自右向左验证组合器链：node 已匹配 compounds[index]，
 * 向上验证 compounds[0..index-1]。#document 不参与匹配。
 */
function verifyPrefix(node, selector, index) {
  if (index === 0) return true
  const { compounds, combinators } = selector
  const comb = combinators[index - 1]
  const target = compounds[index - 1]
  if (comb === 'child') {
    const parent = node.parent
    if (!parent) return false
    return matchCompound(parent, target) && verifyPrefix(parent, selector, index - 1)
  }
  if (comb === 'adjacent') {
    const prev = prevElementSibling(node)
    if (!prev) return false
    return matchCompound(prev, target) && verifyPrefix(prev, selector, index - 1)
  }
  // descendant：任何祖先
  let ancestor = node.parent
  while (ancestor) {
    if (matchCompound(ancestor, target) && verifyPrefix(ancestor, selector, index - 1)) return true
    ancestor = ancestor.parent
  }
  return false
}

/** 一个分组是否整体匹配节点。 */
function matchesSelector(node, selector) {
  const last = selector.compounds.length - 1
  return matchCompound(node, selector.compounds[last])
    && verifyPrefix(node, selector, last)
}

/**
 * 在 root 子树内按文档序收集命中节点（不含 root 自身）。
 * selectorList 为空时返回空；selectorOf 为空时每个节点只归属第一个命中的
 * 分组（与浏览器 querySelectorAll 去重一致）。
 */
function matchNodes(root, selectorList, { perSelector = false } = {}) {
  const out = []
  const seen = perSelector ? null : new Set()
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.tag === '#text' || child.tag === '#comment') continue
      for (const selector of selectorList) {
        if (matchesSelector(child, selector)) {
          if (perSelector) out.push([child, selector])
          else if (!seen.has(child)) { seen.add(child); out.push([child, selector]) }
          if (!perSelector) break
        }
      }
      walk(child)
    }
  }
  walk(root)
  return out
}

/** 仅供测试/内部使用：返回命中的原始节点列表。 */
export function selectAll(root, selectorText) {
  return matchNodes(root, parseSelectorList(selectorText)).map(([node]) => node)
}

/** 元素子树内的文本节点对象列表（#text 节点，非字符串），按文档序。 */
function textNodeList(node) {
  const out = []
  const walk = (current) => {
    for (const child of current.children || []) {
      if (child.tag === '#text') out.push(child)
      else if (child.tag !== '#comment') walk(child)
    }
  }
  walk(node)
  return out
}

/** 收集元素（含自身子树）内的全部文本内容，按文档序。 */
export function textNodesOf(node) {
  return textNodeList(node).map((n) => n.text)
}

/** 空白归一化：折叠连续空白为单空格并去首尾。 */
export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 元素包装对象：对服务调用方暴露 Scrapy 风格 API（attrib/text/css）。 */
export function wrapElement(node, options = {}) {
  return {
    get tag() { return node.tag },
    get attrib() { return { ...node.attrs } },
    get text() {
      const joined = textNodesOf(node).join('')
      return options.whitespace === 'keep' ? joined : normalizeText(joined)
    },
    css(selector) { return extract(node, selector, options) },
    /** 原始节点（测试/序列化用，不对外文档化）。 */
    node,
  }
}

/**
 * 执行选择器提取。
 *
 * @param {object} root 解析后的文档/元素节点
 * @param {string} selectorText 选择器（可含 ::text / ::attr(name)，支持逗号分组）
 * @param {object} [options]
 * @param {'normalize'|'keep'} [options.whitespace='normalize'] ::text 的空白处理
 * @returns {Array<string|object>} 字符串（::text/::attr）或元素包装对象
 */
export function extract(root, selectorText, options = {}) {
  const { whitespace = 'normalize' } = options
  const selectorList = parseSelectorList(selectorText)
  const out = []
  for (const [node, selector] of matchNodes(root, selectorList)) {
    if (!selector.pseudo) { out.push(wrapElement(node, options)); continue }
    if (selector.pseudo.kind === 'text') {
      for (const text of textNodesOf(node)) {
        const value = whitespace === 'keep' ? text : normalizeText(text)
        if (whitespace === 'keep' || value) out.push(value)
      }
    } else {
      const value = node.attrs[selector.pseudo.name]
      if (value !== undefined) out.push(value)
    }
  }
  return out
}

/** parse(html) 顶层入口：返回带 css() 的文档包装。 */
export function createSelectorDocument(html, options = {}) {
  const root = parseHtml(html)
  return wrapElement(root, options)
}
