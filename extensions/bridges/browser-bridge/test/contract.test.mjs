/**
 * 工具面契约单测：15 个 browser_* 工具、TOOL_META 一致性、能力清单形状。
 * 全部离线：registry 派生不触碰引擎（未 setEngine 时调用才报 ENGINE_UNBOUND）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const { TOOLS, TOOL_IMPL, TOOL_META, FEATURES, CAPABILITIES, createRegistry } = await import('../src/mcp/tools.mjs')

const EXPECTED_TOOLS = [
  'browser_capabilities', 'browser_status', 'browser_navigate', 'browser_snapshot',
  'browser_click', 'browser_fill', 'browser_press', 'browser_select', 'browser_scroll',
  'browser_tabs', 'browser_screenshot', 'browser_wait', 'browser_history',
  'browser_close', 'browser_evaluate',
]

test('工具面 = 15 个 browser_* 工具，名字精确匹配', () => {
  assert.equal(TOOLS.length, 15)
  const names = TOOLS.map((t) => t.name).sort()
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort())
})

test('TOOL_META 与 TOOLS 一一对应，kind/since 合法', () => {
  for (const tool of TOOLS) {
    const meta = TOOL_META[tool.name]
    assert.ok(meta, `${tool.name} 缺 TOOL_META`)
    assert.ok(['read', 'write', 'control'].includes(meta.kind), `${tool.name} kind=${meta.kind}`)
    assert.match(meta.since, /^\d+\.\d+\.\d+$/, `${tool.name} since`)
    assert.ok(meta.capability, `${tool.name} 缺 capability 归属`)
    assert.ok(TOOL_IMPL[tool.name], `${tool.name} 缺实现`)
  }
})

test('每个工具都有描述与 inputSchema（object 类型）', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description && tool.description.length >= 20, `${tool.name} 描述过短`)
    assert.equal(tool.inputSchema.type, 'object')
    assert.ok('properties' in tool.inputSchema, `${tool.name} 缺 properties`)
  }
})

test('能力清单：8 个能力，工具全部归属且无重复', () => {
  assert.equal(CAPABILITIES.length, 8)
  const seen = new Set()
  for (const cap of CAPABILITIES) {
    assert.ok(cap.id && cap.title, `能力 ${cap.id} 缺 id/title`)
    for (const name of cap.tools) {
      assert.ok(!seen.has(name), `工具 ${name} 重复归属`)
      seen.add(name)
    }
  }
  assert.equal(seen.size, 15)
  assert.ok(FEATURES.includes('browser.snapshot'))
})

test('引擎未绑定时调用报 ENGINE_UNBOUND（不崩溃）', async () => {
  const reg = createRegistry(CAPABILITIES)
  const out = await TOOL_IMPL.browser_status({}, reg.ctx)
  assert.equal(out.isError, true)
  assert.ok(out.content[0].text.includes('ENGINE_UNBOUND'))
})

test('契约快照与派生工具面一致（构建产物对账）', async () => {
  const contract = JSON.parse(await readFile(path.join(ROOT, 'contract', 'browser-contract.json'), 'utf8'))
  assert.equal(contract.contractVersion, '1.0.0')
  assert.equal(contract.toolCount, 15)
  const snapNames = contract.tools.map((t) => t.name).sort()
  assert.deepEqual(snapNames, TOOLS.map((t) => t.name).sort())
})

test('安全默认如实写进契约：evaluate 能力存在且工具面有门控描述', () => {
  const evaluate = TOOLS.find((t) => t.name === 'browser_evaluate')
  assert.ok(evaluate.description.includes('默认关闭'))
})
