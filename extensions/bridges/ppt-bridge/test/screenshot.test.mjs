import test from 'node:test'
import assert from 'node:assert/strict'
import { composeTiles } from '../src/editor/screenshot.js'

test('composeTiles：按 2 列网格排版并返回 data URL', () => {
  const draw = []
  const ctx = {
    fillStyle: '',
    fillRect() {},
    drawImage(_image, x, y, width, height) { draw.push({ x, y, width, height }) },
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toDataURL: () => 'data:image/jpeg;base64,ok',
  }
  const value = composeTiles([{}, {}, {}], {
    cols: 2, width: 100, height: 50, gap: 4, createCanvas: () => canvas,
  })
  assert.equal(value, 'data:image/jpeg;base64,ok')
  assert.equal(canvas.width, 2 * 100 + 3 * 4)
  assert.equal(canvas.height, 2 * 50 + 3 * 4)
  assert.equal(draw.length, 3)
  assert.deepEqual(draw[1], { x: 108, y: 4, width: 100, height: 50 })
  assert.deepEqual(draw[2], { x: 4, y: 58, width: 100, height: 50 })
})
