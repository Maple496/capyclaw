import test from 'node:test'
import assert from 'node:assert/strict'
import { expandRecolorOps } from '../src/mcp/tools.mjs'

const deck = {
  slides: [
    {
      id: 's0',
      elements: [
        { type: 'text', id: 't0', content: '<p>a</p>' },
        { type: 'shape', id: 'sh0', fill: '#5b9bd5' },
        { type: 'shape', id: 'card', fill: '#ffffff', text: { content: '<p>x</p>' } },
      ],
    },
    { id: 's1', elements: [{ type: 'text', id: 't1', content: '<p>b</p>' }] },
  ],
}

test('expandRecolorOps：每页一条背景 + 每个装饰一条 set-element', () => {
  const ops = expandRecolorOps(deck, { bg: '#c0392b', fg: '#ffffff', sf: '#ffffff' })
  assert.equal(ops.length, 2 + 2) // 2 背景 + sh0/card 两条
  assert.deepEqual(ops[0], { op: 'set-background', color: '#c0392b', indices: [0], contrast: true })
  const sh = ops.find(o => o.elementId === 'sh0')
  assert.deepEqual(sh.props, { fill: '#ffffff' })
  const card = ops.find(o => o.elementId === 'card')
  assert.deepEqual(card.props, { fill: '#ffffff', color: '#ffffff' })
})

test('expandRecolorOps：targets 只展开指定页；sf=null 不动装饰填充', () => {
  const ops = expandRecolorOps(deck, { bg: '#ffffff', fg: '#1f2d3d', sf: null, targets: [1] })
  assert.equal(ops.length, 1)
  assert.deepEqual(ops[0], { op: 'set-background', color: '#ffffff', indices: [1], contrast: true })
})
