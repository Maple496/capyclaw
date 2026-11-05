/**
 * L3 服务/MCP 冒烟层（双 bridge 对称）：
 *   - 双 relay：/healthz（pid/contractsOk）+ /mcp 握手（initialize/tools/list/能力探测）
 *     + 编辑器页 + /assets 上传回读，干净关停
 *   - ppt 旧 stdio 入口管道握手
 *   - skills-service：/healthz（providers=8）+ /skills + SKILL 正文
 *   - scrapling 爬虫工作台：独立服务 + /healthz/metrics + 离线自爬 + 二次提取 + 单测
 *   - workbench host.mjs 模板产物：mock ctx 调 apply() 真实拉起 relay 再 dispose
 *   - 12 个 skill 包：mock ctx 注册 provider，list/get 与契约 note 豁免规则
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { ROOT, Recorder, randomPort, run, startService, tempDir, waitFor, getJson, mcpCaller, mcpText } from './harness.mjs'

const RELAYS = [
  {
    ns: 'browser',
    dir: path.join(ROOT, 'extensions/bridges/browser-bridge/plugin/capyclaw-browser-workbench'),
    toolCount: 15,
    capTool: 'browser_capabilities',
    editorFiles: ['/index.html', '/app.js', '/style.css', '/demo/form.html'],
  },
  {
    ns: 'ppt',
    dir: path.join(ROOT, 'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-workbench'),
    toolCount: 27,
    capTool: 'ppt_capabilities',
    editorFiles: ['/index.html', '/app.js', '/ppt-full-app.js'],
  },
  {
    ns: 'canvas',
    dir: path.join(ROOT, 'extensions/bridges/canvas-bridge/plugin/capyclaw-canvas-workbench'),
    toolCount: 22,
    capTool: 'canvas_capabilities',
    editorFiles: ['/index.html', '/app.js', '/canvas-full-app.js'],
  },
]

async function relaySmoke(rec, { ns, dir, toolCount, capTool, editorFiles }) {
  const port = randomPort()
  const state = tempDir(`l3-${ns}`)
  const relay = path.join(dir, 'server/relay.mjs')
  const svc = await startService(process.execPath, [relay, '--port', String(port), '--dir', state], {
    logFile: path.join(state, 'relay.log'),
    timeoutMs: 30000,
    readyFn: async () => {
      const h = await getJson(`http://127.0.0.1:${port}/healthz`, 3000).catch(() => null)
      return h?.ok === true ? h : null
    },
  })
  try {
    const h = await getJson(`http://127.0.0.1:${port}/healthz`)
    rec.check(`${ns} relay /healthz ok + pid + contractsOk`, h.ok === true && typeof h.pid === 'number' && h.contractsOk === true,
      JSON.stringify({ ok: h.ok, pid: h.pid, contractsOk: h.contractsOk }))

    const rpc = mcpCaller(port)
    const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {} })
    rec.check(`${ns} /mcp initialize`, init?.result?.serverInfo?.name === `${ns}-workbench` || !!init?.result,
      JSON.stringify(init?.result?.serverInfo || init).slice(0, 120))

    const listed = await rpc('tools/list')
    const names = (listed?.result?.tools || []).map((t) => t.name)
    rec.check(`${ns} /mcp tools/list = ${toolCount} 个工具`, names.length === toolCount, `实际 ${names.length}`)

    const cap = JSON.parse(mcpText(await rpc('tools/call', { name: capTool, arguments: {} })))
    rec.check(`${ns} ${capTool} 真实调用（contractVersion + toolCount）`,
      typeof cap.contractVersion === 'string' && cap.toolCount === toolCount,
      JSON.stringify({ contractVersion: cap.contractVersion, toolCount: cap.toolCount }))

    for (const file of editorFiles) {
      const r = await fetch(`http://127.0.0.1:${port}${file}`, { signal: AbortSignal.timeout(8000) })
      rec.check(`${ns} 编辑器静态 ${file}`, r.status === 200, `HTTP ${r.status}`)
    }

    const payload = Buffer.from('e2e-asset-roundtrip-' + ns)
    const up = await fetch(`http://127.0.0.1:${port}/assets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: payload.toString('base64'), contentType: 'text/plain' }),
      signal: AbortSignal.timeout(8000),
    })
    const upJson = await up.json().catch(() => ({}))
    const id = upJson.id || (upJson.url || '').split('/').pop()
    let roundtripOk = false
    if (id) {
      const down = await fetch(`http://127.0.0.1:${port}/assets/${id}`, { signal: AbortSignal.timeout(8000) })
      const body = Buffer.from(await down.arrayBuffer())
      roundtripOk = down.status === 200 && body.equals(payload)
    }
    rec.check(`${ns} /assets 上传回读（sha256 去重）`, roundtripOk, `POST→${up.status} id=${String(id).slice(0, 12)}`)
  } finally {
    await svc.stop()
    fs.rmSync(state, { recursive: true, force: true })
  }
}

async function pptStdioHandshake(rec) {
  const entry = path.join(ROOT, 'extensions/bridges/ppt-bridge/src/mcp/index.mjs')
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
  ]
  const proc = Stdio.spawnNode(entry, frames.map((f) => JSON.stringify(f)).join('\n'))
  try {
    const out = await proc.done(20000)
    const lines = out.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l))
    const byId = new Map(lines.filter((l) => l.id != null).map((l) => [l.id, l]))
    const init = byId.get(1)
    const ping = byId.get(2)
    const tools = byId.get(3)
    rec.check('ppt stdio initialize（serverInfo.ppt-bridge）', init?.result?.serverInfo?.name === 'ppt-bridge',
      JSON.stringify(init?.result?.serverInfo || init).slice(0, 120))
    rec.check('ppt stdio ping → {}', ping?.result != null, JSON.stringify(ping))
    const count = (tools?.result?.tools || []).length
    rec.check('ppt stdio tools/list = 27 个工具', count === 27, `实际 ${count}`)
    const noNotificationReply = !lines.some((l) => l.id == null)
    rec.check('ppt stdio 通知无应答（无状态帧）', noNotificationReply)
  } catch (error) {
    rec.check('ppt stdio 管道握手', false, error.message)
  }
}

/* browser-workbench 真浏览器离线冒烟：MCP 全链路 navigate→fill→select→click→验证。
 * 无头模式跑（不打扰桌面）；本机没有可用浏览器时跳过不失败（诚实边界）。 */
async function browserRealSmoke(rec) {
  const port = randomPort()
  const dir = path.join(ROOT, 'extensions/bridges/browser-bridge/plugin/capyclaw-browser-workbench')
  const state = tempDir('l3-browser-real')
  const svc = await startService(process.execPath, [path.join(dir, 'server/relay.mjs'), '--port', String(port), '--dir', state], {
    logFile: path.join(state, 'relay.log'),
    timeoutMs: 30000,
    env: { DSH_BROWSER_HEADLESS: '1' },
    readyFn: async () => {
      const h = await getJson(`http://127.0.0.1:${port}/healthz`, 3000).catch(() => null)
      return h?.ok === true ? h : null
    },
  })
  const rpc = mcpCaller(port)
  try {
    const call = async (name, args) => mcpText(await rpc('tools/call', { name, arguments: args }))
    const findRef = (text, label) => {
      const line = text.split('\n').find((l) => l.includes(label) && l.includes('[ref='))
      return line ? (/\[ref=(e\d+)\]/.exec(line) || [])[1] : null
    }

    let nav
    try {
      nav = await call('browser_navigate', { url: `http://127.0.0.1:${port}/demo/form.html` })
    } catch (error) {
      const msg = String(error.message || error)
      return /ENGINE_LAUNCH_FAILED/.test(msg)
        ? rec.skip('browser 真浏览器全链路', `本机无可用浏览器（${msg.slice(0, 120)}）`)
        : rec.check('browser 真浏览器 navigate', false, msg.slice(0, 200))
    }
    rec.check('browser navigate 演示页（懒启动 + 首屏快照）', nav.includes('演示表单') && nav.includes('[ref='), nav.split('\n')[0])

    const uRef = findRef(nav, 'textbox "用户名"')
    const selRef = findRef(nav, 'combobox "所在城市"')
    const afterFill = uRef ? await call('browser_fill', { ref: uRef, text: 'e2e-冒烟' }) : ''
    rec.check('browser fill 用户名（返回新快照）', !!uRef && afterFill.includes('已填写'), afterFill.split('\n')[0])

    const afterSelect = selRef ? await call('browser_select', { ref: selRef, value: 'shenzhen' }) : ''
    rec.check('browser select 城市=深圳', !!selRef && afterSelect.includes('已选择'), afterSelect.split('\n')[0])

    const submitRef = findRef(afterSelect || nav, 'button "提交注册"')
    const afterSubmit = submitRef ? await call('browser_click', { ref: submitRef }) : ''
    const verified = afterSubmit.includes('已提交注册') && afterSubmit.includes('e2e-冒烟') && afterSubmit.includes('shenzhen')
    rec.check('browser click 提交 + 快照验证结果（role=status 可见）', verified,
      (afterSubmit.split('\n').find((l) => l.includes('已提交注册')) || '').slice(0, 120))

    const shot = await call('browser_screenshot', {})
    rec.check('browser screenshot 落盘', /截图已保存/.test(shot), shot.split('\n')[0])

    const evErr = await rpc('tools/call', { name: 'browser_evaluate', arguments: { script: '1+1' } })
    rec.check('browser evaluate 诚实拒绝（NOT_IMPLEMENTED）',
      evErr.result?.isError === true && /NOT_IMPLEMENTED/.test(evErr.result?.content?.[0]?.text || ''), '')

    await call('browser_close', {})
    const h2 = await getJson(`http://127.0.0.1:${port}/healthz`)
    rec.check('browser close 后 healthz 如实反映（engine.running=false, errors=0）',
      h2.engine.running === false && h2.errors === 0, JSON.stringify({ running: h2.engine.running, errors: h2.errors }))
  } finally {
    await svc.stop()
    fs.rmSync(state, { recursive: true, force: true })
  }
}


/* 极小的「spawn + 写 stdin + 收 stdout」封装（stdio JSON-RPC 用）。 */
const Stdio = {
  spawnNode(entry, stdinText) {
    const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.stdin.write(stdinText + '\n')
    child.stdin.end()
    return {
      async done(timeoutMs) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('stdio 超时: ' + err.slice(0, 200))), timeoutMs)
          child.on('exit', () => { clearTimeout(t); resolve() })
          child.on('error', reject)
        })
        if (!out.trim()) throw new Error('无 stdout，stderr: ' + err.slice(0, 200))
        return out
      },
    }
  },
}

async function skillsServiceSmoke(rec) {
  const port = randomPort()
  const dir = path.join(ROOT, 'extensions/bridges/ppt-bridge/capyclaw-skills-service')
  const state = tempDir('l3-skills')
  const svc = await startService(process.execPath, ['server.mjs', '--port', String(port)], {
    cwd: dir,
    logFile: path.join(state, 'skills.log'),
    readyFn: async () => {
      const h = await getJson(`http://127.0.0.1:${port}/healthz`, 3000).catch(() => null)
      return h?.ok ? h : null
    },
  })
  try {
    const h = await getJson(`http://127.0.0.1:${port}/healthz`)
    rec.check('skills-service /healthz（service=dsh-skills, providers=8）',
      h.service === 'dsh-skills' && h.providers === 8, JSON.stringify({ service: h.service, providers: h.providers }))
    const skills = await getJson(`http://127.0.0.1:${port}/skills`)
    const list = skills.skills || []
    rec.check('skills-service /skills = 8 个技能', list.length === 8, `实际 ${list.length}`)
    const one = list.find((s) => s.name === 'ppt') || list[0]
    const detail = await getJson(`http://127.0.0.1:${port}/skills/${encodeURIComponent(one.name)}`)
    rec.check(`skills-service /skills/${one.name} 返回正文`,
      typeof detail.content === 'string' && detail.content.length > 100, `content ${String(detail.content || '').length} 字`)
  } finally {
    await svc.stop()
    fs.rmSync(state, { recursive: true, force: true })
  }
}

/* scrapling 爬虫工作台：独立服务真实拉起 + 离线自爬演示页全链路。 */
async function scraplingWorkbenchSmoke(rec) {
  const port = randomPort()
  const dir = path.join(ROOT, 'extensions/official/capyclaw-scrapling')
  const state = tempDir('l3-scrapling')
  const svc = await startService(process.execPath, ['server/server.mjs', '--port', String(port)], {
    cwd: dir,
    logFile: path.join(state, 'workbench.log'),
    readyFn: async () => {
      const h = await getJson(`http://127.0.0.1:${port}/healthz`, 3000).catch(() => null)
      return h?.ok ? h : null
    },
  })
  try {
    const base = `http://127.0.0.1:${port}`
    const h = await getJson(`${base}/healthz`)
    rec.check('scrapling /healthz（name + capabilities 诚实边界）',
      h.name === 'scrapling-workbench' && h.capabilities?.http === true && h.capabilities?.browser === false,
      JSON.stringify({ name: h.name, capabilities: h.capabilities }))

    const metrics = await fetch(`${base}/metrics`).then((r) => r.text())
    rec.check('scrapling /metrics Prometheus 文本', /scrapling_up 1/.test(metrics), metrics.split('\n')[0])

    const page = await fetch(`${base}/`)
    const html = await page.text()
    rec.check('scrapling 工作台页面可访问', page.status === 200 && html.includes('DSH 爬虫工作台'), `HTTP ${page.status}`)

    const crawlRes = await fetch(`${base}/api/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${base}/demo/quotes.html`,
        selectors: [
          { key: '名言', selector: '.quote .text::text' },
          { key: '标签链接', selector: '.quote .tag::attr(href)' },
        ],
      }),
    })
    const crawlJson = await crawlRes.json()
    const steps = crawlJson.crawl?.steps?.map((s) => s.id) || []
    rec.check('scrapling 离线自爬（步骤流水线 + 提取）',
      crawlJson.ok === true
        && JSON.stringify(steps) === JSON.stringify(['url', 'request', 'response', 'body', 'dom', 'extract', 'done'])
        && crawlJson.crawl.extracts['名言'].count === 8,
      JSON.stringify({ ok: crawlJson.ok, steps, 名言: crawlJson.crawl?.extracts?.['名言']?.count }))

    const extractRes = await fetch(`${base}/api/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ crawlId: crawlJson.crawl.id, selectors: [{ key: '标题', selector: 'h1::text' }] }),
    })
    const extractJson = await extractRes.json()
    rec.check('scrapling /api/extract 二次提取（免重爬）',
      extractJson.ok === true && extractJson.results['标题'].values[0] === '每日名言',
      JSON.stringify(extractJson.results?.['标题']?.values))

    const browserMode = await fetch(`${base}/api/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${base}/demo/quotes.html`, mode: 'browser' }),
    })
    const browserJson = await browserMode.json()
    rec.check('scrapling 浏览器模式诚实拒绝（NOT_IMPLEMENTED）',
      browserMode.status === 400 && browserJson.error?.code === 'NOT_IMPLEMENTED',
      browserJson.error?.code || '')
  } finally {
    await svc.stop()
    fs.rmSync(state, { recursive: true, force: true })
  }

  /* 插件单测纳入 e2e（parser/selectors/api/plugin/realworld 共 52 项） */
  const unit = run('node', ['--test', 'test/html-parser.test.mjs', 'test/selectors.test.mjs', 'test/api.test.mjs', 'test/plugin.test.mjs', 'test/realworld.test.mjs'], { cwd: dir })
  rec.check('scrapling 单测全绿（html-parser/selectors/api/plugin/realworld）', unit.status === 0, unit.stderr.slice(0, 300))
}

async function hostTemplateSmoke(rec, { ns, dir }) {
  const port = randomPort()
  const state = tempDir(`l3-host-${ns}`)
  const mockCtx = { get: () => null }
  const hostUrl = pathToFileURL(path.join(dir, 'lib/host.mjs')).href
  const host = await import(hostUrl)
  let dispose = null
  try {
    dispose = await host.apply(mockCtx, { port, hostDir: state })
    const h = await waitFor(async () => getJson(`http://127.0.0.1:${port}/healthz`, 3000).catch(() => null), {
      timeoutMs: 25000, label: `${ns} host.apply() relay`,
    })
    rec.check(`${ns} host.mjs 模板 apply() 拉起 relay（兼容入口真实可跑）`, h.ok === true && typeof h.pid === 'number',
      JSON.stringify({ ok: h.ok, pid: h.pid }))
  } catch (error) {
    rec.check(`${ns} host.mjs 模板 apply()`, false, error.message)
  } finally {
    try { if (dispose) await dispose() } catch { /* 尽力回收 */ }
    await new Promise((r) => setTimeout(r, 500))
    fs.rmSync(state, { recursive: true, force: true })
  }
}

async function skillProviderSmoke(rec) {
  const pkgs = [
    ...fs.readdirSync(path.join(ROOT, 'extensions/bridges/ppt-bridge/plugin'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('capyclaw-ppt-skill-'))
      .map((e) => ['ppt', path.join(ROOT, 'extensions/bridges/ppt-bridge/plugin', e.name)]),
    ...fs.readdirSync(path.join(ROOT, 'extensions/bridges/canvas-bridge/plugin'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('capyclaw-canvas-skill-'))
      .map((e) => ['canvas', path.join(ROOT, 'extensions/bridges/canvas-bridge/plugin', e.name)]),
    ...fs.readdirSync(path.join(ROOT, 'extensions/bridges/browser-bridge/plugin'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('capyclaw-browser-skill-'))
      .map((e) => ['browser', path.join(ROOT, 'extensions/bridges/browser-bridge/plugin', e.name)]),
  ]
  let okCount = 0
  const failures = []
  for (const [ns, dir] of pkgs) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, 'lib/index.mjs')).href)
      const registered = []
      mod.apply({ skills: { registerProvider: (fn) => registered.push(fn()) } }, {})
      const provider = registered[0]
      if (!provider) throw new Error('apply() 未注册 provider')
      const list = await provider.list()
      if (!Array.isArray(list) || list.length !== 1) throw new Error(`list() = ${list?.length}`)
      const skill = list[0]
      const detail = await provider.get({ name: skill.name })
      if (typeof detail.content !== 'string' || detail.content.length < 100) throw new Error('get() 正文过短')
      /* 契约 note 豁免：canvas 的 canvas / ppt 的 pptmaster-* / browser 的 browser 不带契约注；其余必须带 */
      const exempt = skill.name === 'canvas' || skill.name === 'browser' || skill.name.startsWith('pptmaster-')
      const hasNote = /契约：.*(Workbench)/.test(detail.content)
      if (exempt && hasNote) throw new Error('豁免技能不应带契约注')
      if (!exempt && !hasNote) throw new Error('非豁免技能缺少契约注')
      okCount++
    } catch (error) {
      failures.push(`${ns}:${path.basename(dir)} — ${error.message}`)
    }
  }
  rec.check(`15 个 skill 包 mock-ctx 加载 + provider list/get + 契约注豁免（通过 ${okCount}/${pkgs.length}）`,
    failures.length === 0, failures.join(' | '))
}

export async function runLayer() {
  const rec = new Recorder('L3 服务/MCP 冒烟层')
  rec.section('三 relay（统一 start:workbench 形态）')
  for (const relay of RELAYS) await relaySmoke(rec, relay)

  rec.section('ppt 旧 stdio 入口（start:standalone 形态）')
  await pptStdioHandshake(rec)

  rec.section('skills-service')
  await skillsServiceSmoke(rec)

  rec.section('scrapling 爬虫工作台（离线全链路）')
  await scraplingWorkbenchSmoke(rec)

  rec.section('browser 真浏览器全链路（离线演示页，无浏览器则跳过）')
  await browserRealSmoke(rec)
  const browserUnit = run('npm', ['--prefix', 'extensions/bridges/browser-bridge', 'test'], { cwd: ROOT })
  rec.check('browser-bridge 单测全绿（engine/contract/relay/host 22 项）', browserUnit.status === 0, browserUnit.stderr.slice(0, 300))

  rec.section('host.mjs 统一模板（进程内兼容入口）')
  for (const relay of RELAYS) await hostTemplateSmoke(rec, relay)

  rec.section('15 个生成 skill 包')
  await skillProviderSmoke(rec)

  return rec.summary()
}
