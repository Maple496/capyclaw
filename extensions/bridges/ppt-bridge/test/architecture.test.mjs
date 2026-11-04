import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CAPABILITIES, TOOLS, TOOL_META, TOOL_IMPL, createRegistry,
} from '../src/mcp/tools.mjs'
import { defineCapability, defineTool } from '../src/mcp/tools/kernel/define.mjs'
import { OP_NAMES } from '../src/core/ops.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CAP_DIR = join(ROOT, 'src', 'mcp', 'tools', 'capabilities')
const contract = JSON.parse(readFileSync(join(ROOT, 'contract', 'ops.json'), 'utf8'))

test('capability 之间零 import：只允许 kernel / domains / core', () => {
  const files = readdirSync(CAP_DIR).filter((name) => name.endsWith('.mjs') && name !== 'index.mjs')
  assert.ok(files.length >= 10, 'capabilities 目录异常')
  for (const file of files) {
    const src = readFileSync(join(CAP_DIR, file), 'utf8')
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue
      const ok = spec.startsWith('../kernel/') || spec.startsWith('../domains/') || spec.startsWith('../../../core/')
      assert.ok(ok, `${file} 违规 import：${spec}（能力模块只能依赖 kernel/domains/core）`)
    }
  }
})

test('capability / 工具名唯一，且每个工具都归属一个能力', () => {
  const ids = new Set()
  const names = new Set()
  for (const cap of CAPABILITIES) {
    assert.ok(!ids.has(cap.id), `重复 capability: ${cap.id}`)
    ids.add(cap.id)
    for (const tool of cap.tools) {
      assert.ok(!names.has(tool.name), `重复 tool: ${tool.name}`)
      names.add(tool.name)
    }
  }
  assert.deepEqual([...names].sort(), TOOLS.map((tool) => tool.name).sort())
  for (const tool of TOOLS) {
    assert.ok(TOOL_IMPL[tool.name], `缺少实现: ${tool.name}`)
    assert.ok(TOOL_META[tool.name], `缺少元数据: ${tool.name}`)
    assert.ok(ids.has(TOOL_META[tool.name].capability), `未知能力归属: ${tool.name}`)
  }
})

test('op 契约与 core 注册表双相一致', () => {
  const declared = contract.ops.map((item) => item.op).sort()
  assert.deepEqual([...OP_NAMES].sort(), declared)
})

test('扩展烟测：新增一个 capability 文件即可多出工具，无需改 schema/registry', () => {
  const fake = defineCapability({
    id: 'test-extension',
    title: '扩展测试',
    requires: ['deck'],
    features: ['test.extension'],
    tools: [
      defineTool({
        name: 'ppt_test_extension',
        description: 'test only',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        kind: 'read',
        since: 'test',
        handler: async () => ({ text: 'ok' }),
      }),
    ],
  })
  const registry = createRegistry([...CAPABILITIES, fake])
  assert.equal(registry.TOOLS.length, TOOLS.length + 1)
  assert.equal(registry.TOOL_IMPL.ppt_test_extension !== undefined, true)
  assert.ok(registry.FEATURES.includes('test.extension'))
  assert.ok(registry.CAPABILITIES.some((cap) => cap.id === 'test-extension'))
})

test('能力选择：enabled 只装载指定能力，并自动带上 dependsOn', () => {
  const textOnly = createRegistry(CAPABILITIES, { enabled: ['text'] })
  assert.deepEqual(textOnly.TOOLS.map((tool) => tool.name).sort(), ['ppt_fill', 'ppt_text'])

  const element = createRegistry(CAPABILITIES, { enabled: ['element'] })
  assert.deepEqual(element.TOOLS.map((tool) => tool.name).sort(), ['ppt_element', 'ppt_image'])
})
