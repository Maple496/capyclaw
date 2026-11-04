import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS, TOOL_IMPL, TOOL_META, CAPABILITY_LIST } from '../src/mcp/tools.mjs'
import { OP_NAMES } from '../src/core/ops.js'
import { CONTRACT_VERSION } from '../src/mcp/contract.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const contract = JSON.parse(readFileSync(join(ROOT, 'contract', 'ops.json'), 'utf8'))

/* 桌面仓 sanitize.py：仅在显式设置 DESKTOP_ROOT 时做跨仓检查，否则跳过 */
const SANITIZE_PY = process.env.DESKTOP_ROOT
  ? join(process.env.DESKTOP_ROOT, 'backend', 'sanitize.py')
  : null

test('契约 op 与 core op 注册表一致（双向）', () => {
  const declared = contract.ops.map((item) => item.op).sort()
  const implemented = [...OP_NAMES].sort()
  assert.deepEqual(implemented, declared)
})

test('MCP 工具清单：TOOLS / TOOL_IMPL / TOOL_META 三方一致', () => {
  const names = TOOLS.map(t => t.name).sort()
  assert.deepEqual(Object.keys(TOOL_IMPL).sort(), names)
  assert.deepEqual(Object.keys(TOOL_META).sort(), names)
})

test('每个工具都归属一个已注册能力', () => {
  const caps = new Set(CAPABILITY_LIST.map((cap) => cap.id))
  for (const tool of TOOLS) {
    assert.ok(caps.has(TOOL_META[tool.name].capability), `${tool.name} 的 capability 未注册`)
  }
  const seen = new Set()
  for (const cap of CAPABILITY_LIST) {
    for (const name of cap.tools) {
      assert.ok(!seen.has(name), `工具在多个能力中重复: ${name}`)
      seen.add(name)
    }
  }
  assert.deepEqual([...seen].sort(), TOOLS.map(t => t.name).sort())
})

test('MCP 契约快照与源码一致', () => {
  const snapshotPath = join(ROOT, 'contract', 'ppt-contract.json')
  assert.ok(existsSync(snapshotPath), 'contract/ppt-contract.json 不存在，请先运行 node scripts/build-plugin.mjs')
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  assert.equal(snapshot.contractVersion, CONTRACT_VERSION)
  assert.equal(snapshot.toolCount, TOOLS.length)
  assert.deepEqual(snapshot.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name))
  assert.deepEqual(snapshot.capabilities.map((cap) => cap.id).sort(), CAPABILITY_LIST.map((cap) => cap.id).sort())
})

test('包络上限与 sanitize 常量一致', { skip: !SANITIZE_PY && '桌面仓不可见（独立模式），跳过跨仓一致性检查' }, () => {
  const sanitizeSrc = readFileSync(SANITIZE_PY, 'utf8')
  const maxCmds = Number(/_PPT_BRIDGE_MAX_CMDS = (\d+)/.exec(sanitizeSrc)?.[1])
  const maxTotal = Number(/_PPT_BRIDGE_MAX_TOTAL = (\d+) \* 1024 \* 1024/.exec(sanitizeSrc)?.[1]) * 1024 * 1024
  assert.equal(contract.envelope.limits.maxCmds, maxCmds)
  assert.equal(contract.envelope.limits.maxTotalBytes, maxTotal)
})
