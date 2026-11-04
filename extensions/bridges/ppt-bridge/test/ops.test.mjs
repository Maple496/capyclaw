import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOp } from '../src/core/ops.js'

function fakeP(slides) {
  const state = { slides: JSON.parse(JSON.stringify(slides)), theme: {}, title: 't', calls: [] }
  return {
    state,
    isMounted: () => true,
    getSlides: () => state.slides,
    updateSlide: (i, s) => { state.slides[i] = s; state.calls.push('update:' + i); return true },
    addSlide: (s) => { state.slides.push(s); state.calls.push('add-slide') },
    removeSlide: (i) => { state.slides.splice(i, 1); state.calls.push('remove-slide'); return true },
    moveSlide: () => { state.calls.push('move-slide'); return true },
    duplicateSlide: () => { state.calls.push('duplicate-slide'); return true },
    selectSlide: () => { state.calls.push('select'); return true },
    load: async (deck) => { state.slides = JSON.parse(JSON.stringify(deck.slides)); state.calls.push('load') },
    setTitle: (t) => { state.title = t },
    getTheme: () => state.theme,
    setTheme: (t) => { state.theme = t },
    undo: async () => { state.calls.push('undo') },
    redo: async () => { state.calls.push('redo') },
    present: (i) => { state.calls.push('present:' + i) },
    exitPresent: () => { state.calls.push('exit-present') },
  }
}

const textEl = (id, html) => ({ type: 'text', id, left: 0, top: 0, width: 100, height: 40, content: html })
const slide = (id, ...els) => ({ id, background: { type: 'solid', color: '#fff' }, elements: els })

test('set-background：全部页 + 自动对比度', async () => {
  const P = fakeP([slide('s0', textEl('t0', '<p>a</p>')), slide('s1', textEl('t1', '<p>b</p>'))])
  await applyOp(P, { op: 'set-background', color: '#ffffff', contrast: true })
  assert.equal(P.state.slides[0].background.color, '#ffffff')
  assert.equal(P.state.slides[1].elements[0].defaultColor, '#1f2d3d')
})

test('set-background：indices 只作用指定页', async () => {
  const P = fakeP([slide('s0'), slide('s1')])
  await applyOp(P, { op: 'set-background', color: '#0f2740', indices: [1] })
  assert.equal(P.state.slides[0].background.color, '#fff')
  assert.equal(P.state.slides[1].background.color, '#0f2740')
})

test('recolor：背景+文字对比色+装饰形状一次完成', async () => {
  const shape = { type: 'shape', id: 'sh0', left: 0, top: 0, width: 100, height: 4, fill: '#5b9bd5' }
  const P = fakeP([
    slide('s0', textEl('t0', '<p style="font-size: 20px; color: #ffffff;">a</p>'), shape),
    slide('s1', textEl('t1', '<p>b</p>'), { ...shape, id: 'sh1' }),
  ])
  await applyOp(P, { op: 'recolor', background: '#c0392b' })
  assert.equal(P.state.slides[0].background.color, '#c0392b')
  assert.equal(P.state.slides[1].background.color, '#c0392b')
  assert.equal(P.state.slides[0].elements[0].defaultColor, '#ffffff')
  assert.match(P.state.slides[0].elements[0].content, /color: #ffffff/)
  assert.equal(P.state.slides[0].elements[1].fill, '#ffffff')
  assert.equal(P.state.slides[1].elements[1].fill, '#ffffff')
  assert.deepEqual(P.state.calls, ['update:0', 'update:1'])
})

test('recolor：浅底自动深字，shapes=null 不动装饰', async () => {
  const shape = { type: 'shape', id: 'sh0', left: 0, top: 0, width: 100, height: 4, fill: '#d14424' }
  const P = fakeP([slide('s0', textEl('t0', '<p>a</p>'), shape)])
  await applyOp(P, { op: 'recolor', background: '#ffffff', shapes: null })
  assert.equal(P.state.slides[0].elements[0].defaultColor, '#1f2d3d')
  assert.equal(P.state.slides[0].elements[1].fill, '#d14424')
})

test('set-text：改文字保留原字号', async () => {
  const P = fakeP([slide('s0', textEl('t0', '<p><span style="font-size: 54px;">旧标题</span></p>'))])
  await applyOp(P, { op: 'set-text', id: 0, text: '新标题' })
  assert.match(P.state.slides[0].elements[0].content, /font-size: 54px/)
  assert.match(P.state.slides[0].elements[0].content, /新标题/)
})

test('set-element / add-element / remove-element', async () => {
  const P = fakeP([slide('s0', textEl('t0', '<p>a</p>'))])
  await applyOp(P, { op: 'set-element', slide: 0, elementId: 't0', props: { left: 120, fontSize: 30 } })
  assert.equal(P.state.slides[0].elements[0].left, 120)
  assert.match(P.state.slides[0].elements[0].content, /font-size: 30px/)
  await applyOp(P, { op: 'add-element', slide: 0, element: { type: 'shape', fill: '#f00' } })
  assert.equal(P.state.slides[0].elements.length, 2)
  await applyOp(P, { op: 'remove-element', slide: 0, elementId: 't0' })
  assert.equal(P.state.slides[0].elements.length, 1)
})

test('页管理 / 历史 / 放映 / theme 透传', async () => {
  const P = fakeP([slide('s0'), slide('s1')])
  await applyOp(P, { op: 'remove-slide', id: 1 })
  await applyOp(P, { op: 'duplicate-slide', id: 0 })
  await applyOp(P, { op: 'move-slide', from: 0, to: 1 })
  await applyOp(P, { op: 'select', id: 0 })
  await applyOp(P, { op: 'undo' })
  await applyOp(P, { op: 'redo' })
  await applyOp(P, { op: 'present', index: 0 })
  await applyOp(P, { op: 'exit-present' })
  await applyOp(P, { op: 'theme', theme: { fontColor: '#111' } })
  assert.deepEqual(P.state.theme, { fontColor: '#111' })
  assert.ok(P.state.calls.includes('undo') && P.state.calls.includes('redo'))
})

test('fill-slot：能填 shape 文字且不新增元素', async () => {
  const card = {
    type: 'shape', id: 's1', left: 0, top: 0, width: 200, height: 60,
    path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z', viewBox: [200, 200], fill: '#eeeeee',
    text: { content: '<p><span style="font-size: 20px;">旧标题</span></p>' },
  }
  const P = fakeP([slide('s0', card)])
  await applyOp(P, { op: 'fill-slot', slide: 0, slot: 0, text: '新标题' })
  assert.equal(P.state.slides[0].elements.length, 1)
  assert.match(P.state.slides[0].elements[0].text.content, /新标题/)
})

test('set-text：纯 shape 文字页回退到首个文字载体', async () => {
  const card = {
    type: 'shape', id: 's1', left: 0, top: 0, width: 200, height: 60,
    path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z', viewBox: [200, 200], fill: '#eeeeee',
    text: { content: '<p>旧文字</p>' },
  }
  const P = fakeP([slide('s0', card)])
  await applyOp(P, { op: 'set-text', id: 0, text: '新文字' })
  assert.match(P.state.slides[0].elements[0].text.content, /新文字/)
})

test('add-element：image 元素保留 type/src', async () => {
  const P = fakeP([slide('s0')])
  await applyOp(P, { op: 'add-element', slide: 0, element: { type: 'image', src: 'data:image/png;base64,AAA' } })
  assert.equal(P.state.slides[0].elements[0].type, 'image')
  assert.equal(P.state.slides[0].elements[0].src, 'data:image/png;base64,AAA')
})

test('add-element：整体在画布外的元素自动放回画布内', async () => {
  const P = fakeP([slide('s0')])
  await applyOp(P, { op: 'add-element', slide: 0, element: { type: 'image', src: 'data:image/png;base64,AAA', left: 1080, top: 110, width: 391, height: 700 } })
  const el = P.state.slides[0].elements[0]
  assert.ok(el.left < 1000 && el.top < 563, `left=${el.left} top=${el.top}`)
})
