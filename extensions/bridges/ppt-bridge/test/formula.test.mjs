/** 公式能力测试：hfmath 渲染 + 元素构建 + op 行为。 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { applyOp } from '../src/core/ops.js'
import { makeElement, patchElement } from '../src/core/text.js'
import { renderFormula, makeFormulaElement } from '../src/core/formula.js'

function fakeP(slides) {
  const state = { slides: JSON.parse(JSON.stringify(slides)), calls: [] }
  return {
    state,
    getSlides: () => state.slides,
    updateSlide: (i, s) => { state.slides[i] = s; state.calls.push('update:' + i); return true },
    addSlide: (s) => { state.slides.push(s) },
    removeSlide: () => true,
    moveSlide: () => true,
    duplicateSlide: () => true,
    selectSlide: () => true,
    load: async (deck) => { state.slides = JSON.parse(JSON.stringify(deck.slides)) },
    getTheme: () => ({}),
    setTheme: () => {},
    isMounted: () => true,
    setTitle: () => {},
    undo: async () => {},
    redo: async () => {},
    present: () => {},
    exitPresent: () => {},
  }
}

const slide = (id, ...els) => ({ id, background: { type: 'solid', color: '#fff' }, elements: els })

test('formula：渲染 E=mc^2 产出 path + viewBox', () => {
  const r = renderFormula('E=mc^2')
  assert.match(r.path, /^M\d/, 'path 应以 M 命令开头')
  assert.ok(r.path.length > 50, 'path 应有实际笔画')
  assert.ok(r.viewBox[0] > 0 && r.viewBox[1] > 0)
  assert.ok(r.width === r.viewBox[0])
})

test('formula：分式/上下标/求和/积分/希腊字母', () => {
  for (const src of [
    '\\frac{a}{b}',
    'x_i^2 + y^2 = r^2',
    '\\sum_{i=1}^{n} x_i',
    '\\int_0^1 x^2 dx',
    '\\alpha + \\beta = \\gamma',
    '\\sqrt{x^2 + 1}',
  ]) {
    const r = renderFormula(src)
    assert.ok(r.path.length > 20, `${src} 应渲染出笔画`)
  }
})

test('formula：非法输入报错清晰', () => {
  assert.throws(() => renderFormula(''), /公式内容不能为空/)
  assert.throws(() => renderFormula('   '), /不能为空/)
  assert.throws(() => makeFormulaElement({ latex: '' }), /latex 不能为空/)
  // path 已提供时 viewBox 必须合法；viewBox 缺省回落 [200, 200]
  assert.throws(() => makeFormulaElement({ latex: 'x', path: 'M 0 0', viewBox: [-1, 0] }), /viewBox 无效/)
  const fallback = makeFormulaElement({ latex: 'x', path: 'M 0 0 L 9 9' })
  assert.deepEqual(fallback.viewBox, [200, 200])
})

test('makeElement：latex 分支（自动渲染）', () => {
  const el = makeElement({ type: 'latex', latex: 'E=mc^2', left: 100, top: 200 })
  assert.equal(el.type, 'latex')
  assert.equal(el.latex, 'E=mc^2')
  assert.ok(el.path.length > 50)
  assert.equal(el.fixedRatio, true)
  assert.equal(el.strokeWidth, 2)
  assert.deepEqual(el.viewBox.length, 2)
  // 传 path 时直接使用（不重复渲染）
  const el2 = makeElement({ type: 'latex', latex: 'x', path: 'M 0 0 L 10 10', viewBox: [50, 50] })
  assert.equal(el2.path, 'M 0 0 L 10 10')
  assert.deepEqual(el2.viewBox, [50, 50])
  assert.equal(el2.width, 50)
  // 白名单更新
  assert.throws(() => makeElement({ type: 'formula', latex: 'x' }), /不支持的 element\.type/)
})

test('patchElement：latex 字段更新', () => {
  const el = makeFormulaElement({ latex: 'x^2' })
  patchElement(el, {
    latex: 'y^2', path: 'M 1 1 L 2 2', viewBox: [99, 88],
    color: '#ff0000', strokeWidth: 5, left: 10, top: 20,
  })
  assert.equal(el.latex, 'y^2')
  assert.equal(el.path, 'M 1 1 L 2 2')
  assert.deepEqual(el.viewBox, [99, 88])
  assert.equal(el.color, '#ff0000')
  assert.equal(el.strokeWidth, 5)
  assert.equal(el.left, 10)
  // 非法 viewBox 拒绝
  patchElement(el, { viewBox: [-5, 0] })
  assert.deepEqual(el.viewBox, [99, 88])
})

test('set-element op：更新公式元素', async () => {
  const P = fakeP([slide('s0')])
  await applyOp(P, { op: 'add-element', slide: 0, element: { type: 'latex', latex: 'a+b=c' } })
  const el = P.state.slides[0].elements[0]
  assert.equal(el.type, 'latex')
  await applyOp(P, {
    op: 'set-element', slide: 0, elementId: el.id,
    props: { latex: 'd+e=f', path: 'M 0 0 L 9 9', viewBox: [120, 60], color: '#0066cc' },
  })
  const updated = P.state.slides[0].elements[0]
  assert.equal(updated.latex, 'd+e=f')
  assert.deepEqual(updated.viewBox, [120, 60])
  assert.equal(updated.color, '#0066cc')
})
