/** 命令白名单与契约：对账 discovery 产物 + registry 派生面。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMMAND_NAMES, validateCommand, validateCommands, commandCatalog,
  isViewCommand, isBridgeCommand,
} from '../src/core/commands.js'

const HERE = join(dirname_(import.meta.url))

function dirname_(u) {
  return join(fileURLToPath(u), '..')
}

test('canvas_exec 白名单覆盖 discovery 探测的全部已注册命令', () => {
  const api = JSON.parse(readFileSync(join(HERE, '..', 'contract', 'canvas-api.json'), 'utf8'))
  const registered = api.registeredCommands
  assert.ok(registered.length >= 90, `探测命令数异常: ${registered.length}`)
  /* 顶层 API（mount/load/dump…）不走 exec；setValue/appendElementList 是桥层合成。 */
  const missing = registered.filter((name) => !COMMAND_NAMES.has(name))
  assert.deepEqual(missing, [], '白名单缺少已注册命令')
})

test('白名单不包含探测确认未知的命令', () => {
  const api = JSON.parse(readFileSync(join(HERE, '..', 'contract', 'canvas-api.json'), 'utf8'))
  const unknown = new Set(Object.entries(api.execProbe)
    .filter(([, v]) => !v.ok && v.error.includes('未知命令'))
    .map(([k]) => k))
  const leaked = [...unknown].filter((name) => COMMAND_NAMES.has(name))
  assert.deepEqual(leaked, [], '白名单混入了未注册命令')
})

test('validateCommand：形状/白名单/参数上限', () => {
  assert.equal(validateCommand({ cmd: 'bold', args: [true] }).ok, true)
  assert.equal(validateCommand({ cmd: 'bold' }).cmd.args.length, 0)
  assert.equal(validateCommand('bold').ok, false)
  assert.equal(validateCommand({ cmd: 'nope' }).ok, false)
  assert.equal(validateCommand({ cmd: 'bold', args: 'x' }).ok, false)
  const huge = validateCommand({ cmd: 'setValue', args: [{ main: 'x'.repeat(5 * 1024 * 1024) }] })
  assert.equal(huge.ok, false)
  assert.match(huge.error, /上限/)
})

test('validateCommands：批量上限与短路', () => {
  assert.equal(validateCommands([]).ok, false)
  assert.equal(validateCommands([{ cmd: 'undo' }]).ok, true)
  assert.equal(validateCommands([{ cmd: 'nope' }]).ok, false)
  const tooMany = Array.from({ length: 101 }, () => ({ cmd: 'undo' }))
  assert.match(validateCommands(tooMany).error, /最多/)
})

test('viewOnly 与桥层合成命令分类', () => {
  assert.ok(isViewCommand('pageMode'))
  assert.ok(isViewCommand('print'))
  assert.ok(!isViewCommand('setValue'))
  /* setValue/appendElementList 属于 doc 域（编辑器 adapter 拦截解释），
   * svc 组的 clear 是显式桥层合成命令。 */
  assert.ok(isBridgeCommand('clear'))
  assert.ok(!isBridgeCommand('setValue'))
  assert.ok(!isBridgeCommand('bold'))
})

test('commandCatalog 分组完整', () => {
  const groups = commandCatalog()
  const ids = groups.map((g) => g.id)
  for (const id of ['doc', 'table', 'text', 'page', 'history', 'image', 'view']) {
    assert.ok(ids.includes(id), `缺少分组 ${id}`)
  }
  const total = groups.reduce((n, g) => n + g.count, 0)
  assert.equal(total, COMMAND_NAMES.size)
})

test('registry 工具面与 TOOL_META 对账（同一真源派生）', async () => {
  process.env.CANVAS_BRIDGE_URL = 'http://127.0.0.1:9/api/desktop/works/canvas-bridge'
  const tools = await import('../src/mcp/tools.mjs')
  assert.equal(tools.TOOLS.length, 22)
  assert.deepEqual(
    tools.TOOLS.map((t) => t.name).sort(),
    Object.keys(tools.TOOL_META).sort(),
  )
  for (const name of tools.TOOLS.map((t) => t.name)) {
    assert.match(name, /^canvas_[a-z0-9_]+$/)
    const tool = tools.TOOLS.find((t) => t.name === name)
    assert.equal(tool.inputSchema.type, 'object')
  }
})

test('contract 快照与运行时一致', async () => {
  process.env.CANVAS_BRIDGE_URL = 'http://127.0.0.1:9/api/desktop/works/canvas-bridge'
  const snapPath = join(HERE, '..', 'contract', 'canvas-contract.json')
  assert.ok(existsSync(snapPath), '契约快照不存在（先跑 build-plugin）')
  const snapshot = JSON.parse(readFileSync(snapPath, 'utf8'))
  const { CONTRACT_VERSION, PACKAGE_VERSION } = await import('../src/mcp/contract.mjs')
  assert.equal(snapshot.contractVersion, CONTRACT_VERSION)
  assert.equal(snapshot.packageVersion, PACKAGE_VERSION)
  const tools = await import('../src/mcp/tools.mjs')
  assert.equal(snapshot.toolCount, tools.TOOLS.length)
  assert.deepEqual(
    snapshot.tools.map((t) => t.name).sort(),
    tools.TOOLS.map((t) => t.name).sort(),
  )
})
