/**
 * 公式（latex 元素）纯函数：hfmath 渲染 + 元素组装。
 *
 * PPTist latex 元素（编辑器以 stroke 渲染，非填充）：
 *   { type:'latex', latex, path, color, strokeWidth, viewBox:[w,h], fixedRatio:true }
 * path 坐标空间 = viewBox（hfmath 输出的单线笔画，空格分隔多子路径）。
 *
 * 渲染引擎 hfmath 是 PPTist 的 fork（零依赖 Hershey 单线字体），
 * 源码转译在 core/hfmath/*.js，node:test 直测。
 */

import { hfmath } from './hfmath/index.js'

/** hfmath 默认渲染 padding（path 坐标与 viewBox 同坐标系）。 */
const HF_PADDING = 16

/**
 * 渲染 TeX 公式 → stroke path。
 * @param {string} latex TeX 语法的数学公式（如 E=mc^2、\frac{a}{b}、x_i^2）
 * @returns {{ path: string, viewBox: [number, number], width: number, height: number }}
 */
export function renderFormula(latex) {
  const src = String(latex == null ? '' : latex).trim()
  if (!src) throw new Error('公式内容不能为空')
  let f
  try {
    f = new hfmath(src)
    f.pathd()
  } catch (err) {
    throw new Error('公式解析失败：' + String((err && err.message) || err) + '（请检查 TeX 语法）')
  }
  const d = f.pathd()
  if (!d || !d.trim()) throw new Error('公式渲染结果为空：请检查公式内容')
  const box = f.box()
  const vw = Math.ceil(box.x + box.w + HF_PADDING)
  const vh = Math.ceil(box.y + box.h + HF_PADDING)
  if (!isFinite(vw) || !isFinite(vh) || vw <= 0 || vh <= 0) {
    throw new Error('公式渲染尺寸异常：' + JSON.stringify(box))
  }
  return { path: d, viewBox: [vw, vh], width: vw, height: vh }
}

/**
 * 构建 latex 元素（path 必须已渲染——没有 path 的公式在编辑器里不可见）。
 * @param {object} e { latex, path?, viewBox?, color?, strokeWidth?, width?, height?, left?, top?, rotate? }
 */
export function makeFormulaElement(e) {
  if (!e || typeof e !== 'object') throw new Error('公式元素必须是对象')
  const latex = String(e.latex == null ? '' : e.latex).trim()
  if (!latex) throw new Error('公式内容 latex 不能为空')
  let path = e.path
  let viewBox = e.viewBox
  if (!path) {
    const rendered = renderFormula(latex)
    path = rendered.path
    viewBox = rendered.viewBox
  }
  const vw = Number(viewBox && viewBox[0] != null ? viewBox[0] : 200)
  const vh = Number(viewBox && viewBox[1] != null ? viewBox[1] : 200)
  if (!isFinite(vw) || !isFinite(vh) || vw <= 0 || vh <= 0) {
    throw new Error('viewBox 无效：应为 [宽, 高] 正数')
  }
  const width = Number(e.width != null ? e.width : vw)
  const height = Number(e.height != null ? e.height : vh)
  return {
    type: 'latex',
    id: e.id || `formula_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    left: Number(e.left != null ? e.left : Math.round((1000 - width) / 2)),
    top: Number(e.top != null ? e.top : 140),
    width,
    height,
    rotate: Number(e.rotate || 0),
    fixedRatio: true,
    latex,
    path: String(path),
    color: e.color ? String(e.color) : '#333333',
    strokeWidth: Number(e.strokeWidth != null ? e.strokeWidth : 2),
    viewBox: [vw, vh],
  }
}
