/**
 * dsh-port-sidebar 冒烟测试（node:test，无外部依赖）。
 *
 * 覆盖三类契约：
 * 1. 包清单：dsh.client 声明、exports["./client"]、bundle patch、files;
 * 2. 浏览器半：__ModuleLoader__ 装载协议、id 与包名一致、注入面与行为关键路径;
 * 3. 宿主半：地址解析（config/环境变量/协议白名单）与入口形状。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

test('package.json 声明满足 client-modules 扫描契约', () => {
  const pkg = readJson(join(packageDir, 'package.json'))
  assert.equal(pkg.name, '@capyclaw/port-sidebar')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, './lib/host.mjs')

  // dsh.client：web 平台 + 开机立即装载
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)

  // exports["./client"] 指向真实存在的浏览器半文件（字符串或 { default } 均可）
  const clientExport = pkg.exports['./client']
  const clientRel = typeof clientExport === 'string' ? clientExport : clientExport.default
  assert.equal(typeof clientRel, 'string')
  assert.ok(existsSync(join(packageDir, clientRel)), `浏览器半文件不存在: ${clientRel}`)

  // bundle patch 与宿主入口真实存在
  assert.ok(readFileSync(join(packageDir, pkg.dsh.bundle.patch), 'utf8').includes('@capyclaw/port-sidebar'))
  assert.ok(readFileSync(join(packageDir, pkg.main), 'utf8').length > 0)
})

test('client.js 遵循 __ModuleLoader__ 装载协议且插件形状正确', () => {
  const pkg = readJson(join(packageDir, 'package.json'))
  const source = readFileSync(join(packageDir, pkg.exports['./client']), 'utf8')
  assert.ok(source.includes('window.__ModuleLoader__.load'), '缺少装载协议调用')
  assert.ok(source.includes(`id: '${pkg.name}'`), 'factory id 必须与包名一致')
  assert.ok(source.includes("inject: ['slots', 'sidebarRight', 'sidebarRightTabs']"), '必须声明注入 slots/sidebarRight/sidebarRightTabs')
  assert.ok(source.includes('return module.exports;'), 'factory 必须返回 module.exports')
  assert.ok(source.includes('__DSH_PORT_SIDEBAR__'), '必须读取宿主半注入的全局')
  assert.ok(source.includes('sidebarRightTabs.register'), '必须注册自有 tab 类型')
  assert.ok(source.includes("kind: TAB_KIND"), '必须使用自有 kind')
  assert.ok(source.includes('registerCloseHandler'), '必须注册关闭钩子做保活')
  assert.ok(source.includes('checkAndRevive'), '必须带保活检查')
  assert.ok(source.includes('hasOwnTab'), '关闭判定必须以会话级清单为权威')
  assert.ok(source.includes('isExpanded'), '折叠时不得抢布局')
  assert.ok(source.includes('guardCloseClicks'), '必须在 UI 层拦截关闭点击')
  assert.ok(source.includes("addEventListener('click', guardCloseClicks, true)"), '拦截必须在 capture 阶段')
  assert.ok(source.includes('ensured.add'), '必须防止重复首次打开')
  assert.ok(source.includes('keepAlive'), '保活必须可配置')
  assert.ok(!/\bimport\s/.test(source), '浏览器半不允许静态 import')
  assert.ok(!/export\s+(default|const|function|let|var)\b/.test(source), '浏览器半不允许 ESM 导出')
})

test('宿主半入口形状正确', async () => {
  const pkg = readJson(join(packageDir, 'package.json'))
  const host = await import(`file://${join(packageDir, pkg.main).replace(/\\/g, '/')}`)
  assert.equal(host.name, pkg.name)
  assert.equal(typeof host.apply, 'function')
  assert.equal(host.BOOT_GLOBAL, '__DSH_PORT_SIDEBAR__')
})

test('resolveTarget：默认 127.0.0.1:39600', async () => {
  const { resolveTarget } = await import('../lib/url.mjs')
  const target = resolveTarget({}, {})
  assert.equal(target.url, 'http://127.0.0.1:39600/')
  assert.equal(target.restoreOnBoot, true)
})

test('resolveTarget：config 优先于环境变量', async () => {
  const { resolveTarget } = await import('../lib/url.mjs')
  const target = resolveTarget({ port: 5000 }, { DSH_PORT_SIDEBAR_PORT: '6000' })
  assert.equal(target.url, 'http://127.0.0.1:5000/')
  assert.equal(
    resolveTarget({ url: 'http://localhost:7000/app' }, { DSH_PORT_SIDEBAR_URL: 'http://x:1/' }).url,
    'http://localhost:7000/app',
  )
})

test('resolveTarget：环境变量端口生效', async () => {
  const { resolveTarget } = await import('../lib/url.mjs')
  assert.equal(resolveTarget({}, { DSH_PORT_SIDEBAR_PORT: '4173' }).url, 'http://127.0.0.1:4173/')
})

test('resolveTarget：非 http/https 被拒绝', async () => {
  const { resolveTarget } = await import('../lib/url.mjs')
  assert.equal(resolveTarget({ url: 'file:///etc/passwd' }, {}), undefined)
  assert.equal(resolveTarget({ url: 'not a url' }, {}), undefined)
})

test('resolveTarget：restoreOnBoot 可被 config 与环境变量关闭', async () => {
  const { resolveTarget } = await import('../lib/url.mjs')
  assert.equal(resolveTarget({ restoreOnBoot: false }, {}).restoreOnBoot, false)
  assert.equal(resolveTarget({}, { DSH_PORT_SIDEBAR_RESTORE: 'false' }).restoreOnBoot, false)
  assert.equal(resolveTarget({}, { DSH_PORT_SIDEBAR_RESTORE: '0' }).restoreOnBoot, false)
  assert.equal(resolveTarget({ restoreOnBoot: false }, { DSH_PORT_SIDEBAR_RESTORE: 'true' }).restoreOnBoot, true)
})

test('resolveTarget：keepAlive 默认开启，可被 config 与环境变量关闭', async () => {
  const { resolveTarget } = await import('../lib/url.mjs')
  assert.equal(resolveTarget({}, {}).keepAlive, true)
  assert.equal(resolveTarget({ keepAlive: false }, {}).keepAlive, false)
  assert.equal(resolveTarget({}, { DSH_PORT_SIDEBAR_KEEP_ALIVE: 'false' }).keepAlive, false)
  assert.equal(resolveTarget({ keepAlive: false }, { DSH_PORT_SIDEBAR_KEEP_ALIVE: '1' }).keepAlive, true)
})
