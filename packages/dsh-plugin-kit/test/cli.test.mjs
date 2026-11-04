/** cli 脚手架测试：解析语义与导入守卫。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, isMain } from '../src/cli.mjs'

test('parseArgs：位置参数、--flag value、布尔旗标、--flag=value 混排', () => {
  const { positional, flags } = parseArgs([
    'install', 'chain-smoke', '--from', './x/index.json', '--auto-install', '--version=2.0.0',
  ])
  assert.deepEqual(positional, ['install', 'chain-smoke'])
  assert.equal(flags.from, './x/index.json')
  assert.equal(flags['auto-install'], true)
  assert.equal(flags.version, '2.0.0')
})

test('parseArgs：--flag 后随另一个 -- 项时视为布尔，值继续被下一旗标贪心捕获（与仓库既有 CLI 惯例一致）', () => {
  const { positional, flags } = parseArgs(['--from', '--auto', 'name'])
  assert.deepEqual(positional, [])
  assert.equal(flags.from, true)
  assert.equal(flags.auto, 'name')
  // 布尔旗标放尾部才是安全写法
  const tail = parseArgs(['name', '--auto-install'])
  assert.deepEqual(tail.positional, ['name'])
  assert.equal(tail['auto-install'], undefined)
  assert.equal(tail.flags['auto-install'], true)
})

test('parseArgs：空输入与空字符串值', () => {
  assert.deepEqual(parseArgs([]), { positional: [], flags: {} })
  const { flags } = parseArgs(['--out', ''])
  assert.equal(flags.out, '')
})

test('isMain：直接执行为真、被导入为假', () => {
  const self = pathToFileURL(process.argv[1] || 'x.mjs').href
  assert.equal(isMain(self), true)
  assert.equal(isMain('file:///elsewhere/tool.mjs'), false)
})

test('fail：真实验证以非零码退出（子进程）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-fail-'))
  try {
    const cliSrc = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs')).href
    const script = path.join(dir, 'boom.mjs')
    fs.writeFileSync(script, `import { fail } from ${JSON.stringify(cliSrc)}; fail("boom")\n`)
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000 })
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /✗ boom/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
