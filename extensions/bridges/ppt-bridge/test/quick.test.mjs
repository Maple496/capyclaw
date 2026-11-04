import test from 'node:test'
import assert from 'node:assert/strict'
import { parseQuick, resolveColor, simpleSlide } from '../src/core/quick.js'

test('颜色名最长匹配：淡黄 不被 黄 抢走', () => {
  assert.equal(resolveColor('淡黄'), '#fffacd')
  assert.equal(resolveColor('黄'), '#ffe066')
  assert.equal(resolveColor('#123456'), '#123456')
})

test('快捷：所有页背景改天蓝', () => {
  const cmds = parseQuick('把所有页背景改成天蓝色')
  assert.deepEqual(cmds, [{ op: 'set-background', color: '#87ceeb', contrast: true }])
})

test('快捷：用户原话「背景改成白色」/「把背景全部改成红色」', () => {
  assert.deepEqual(parseQuick('背景改成白色'),
    [{ op: 'set-background', color: '#ffffff', contrast: true }])
  assert.deepEqual(parseQuick('把背景全部改成红色'),
    [{ op: 'set-background', color: '#d14424', contrast: true }])
  assert.deepEqual(parseQuick('背景改成粉色'),
    [{ op: 'set-background', color: '#ffc0cb', contrast: true }])
})

test('快捷：第 2 页背景改深蓝只作用该页', () => {
  const cmds = parseQuick('第2页背景改成深蓝')
  assert.deepEqual(cmds, [{ op: 'set-background', color: '#1e3a8a', contrast: true, indices: [1] }])
})

test('快捷：第2页标题改成 X', () => {
  const cmds = parseQuick('第2页标题改成季度复盘')
  assert.deepEqual(cmds, [{ op: 'set-text', id: 1, text: '季度复盘' }])
})

test('快捷：加一页', () => {
  const cmds = parseQuick('加一页 公司福利')
  assert.equal(cmds.length, 1)
  assert.equal(cmds[0].op, 'add-slide')
  assert.equal(cmds[0].slide.elements[0].type, 'text')
  assert.match(cmds[0].slide.elements[0].content, /公司福利/)
})

test('快捷：无法识别返回 null', () => {
  assert.equal(parseQuick('帮我分析一下这份财报'), null)
})

test('simpleSlide 标题做 HTML 转义', () => {
  const s = simpleSlide('<b>x</b>')
  assert.ok(s.elements[0].content.includes('&lt;b&gt;'))
})

test('快捷：蓝色 → #5b9bd5，天蓝色仍为 #87ceeb', () => {
  assert.deepEqual(parseQuick('背景改成蓝色'), [{ op: 'set-background', color: '#5b9bd5', contrast: true }])
  assert.deepEqual(parseQuick('把所有页背景改成天蓝色'), [{ op: 'set-background', color: '#87ceeb', contrast: true }])
})
