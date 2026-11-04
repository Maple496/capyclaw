/**
 * dsh-port-sidebar 评估器：虚拟时钟 + 模拟 dsh 侧栏环境，跑 5 个故障场景。
 *
 * 目标（全部最小化）：
 *   stabilityFailures — tab 应在而未在 / 重复 tab / 关闭击穿 / 放弃健康会话
 *   wastedOpens       — 超出"每会话每时代一次"的 openTab 次数（每次 = 一次闪现）
 *   timeToPresentP95  — 新会话首开到 tab 出现的 95 分位（虚拟 ms）
 *   reviveMsAvg       — 命令路径关闭后到复活的平均时长
 *   tickCount         — 轮询/补试触发次数（CPU 代理）
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClock, shadowGlobals } from './vclock.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = path.resolve(HERE, '../../extensions/official/dsh-port-sidebar/client/client.js')

/** 模拟 dsh 侧栏环境：清单落账延迟、关闭提交延迟、openTab 故障注入。 */
function makeDshSim(clock, opts) {
  const sim = {
    mounted: 'A',
    expanded: true,
    nextTab: 100,
    inv: new Map(), // sid -> [{tabId, kind}]
    subs: { mounted: [], openTabs: [] },
    pendingLands: [], // {at, sid, tabId, kind}
    closeCommit: [], // {at, tabId}
    stats: { openCalls: 0, openThrew: 0, closes: 0, closeHandlerFired: 0 },
    closeHandler: null,
    throwOpenFirstN: new Map(), // sid -> 剩余抛错次数
  }
  for (const [sid, spec] of Object.entries(opts.sessions || {})) {
    const arr = []
    for (const kind of spec.tabs || []) arr.push({ tabId: 'x' + (sim.nextTab++), kind })
    sim.inv.set(sid, arr)
  }
  const fire = (list) => { for (const fn of list) try { fn() } catch { /* dsh 容忍 */ } }
  const flush = () => {
    const now = clock.now()
    while (sim.pendingLands.length && sim.pendingLands[0].at <= now) {
      const land = sim.pendingLands.shift()
      if (!sim.inv.has(land.sid)) sim.inv.set(land.sid, [])
      sim.inv.get(land.sid).push({ tabId: land.tabId, kind: land.kind })
      fire(sim.subs.openTabs)
    }
    while (sim.closeCommit.length && sim.closeCommit[0].at <= now) {
      const c = sim.closeCommit.shift()
      const tabs = sim.inv.get(c.sid)
      if (tabs) {
        const index = tabs.findIndex((t) => t.tabId === c.tabId)
        if (index >= 0) tabs.splice(index, 1)
      }
      fire(sim.subs.openTabs)
    }
  }
  const findSid = (tabId) => {
    for (const [sid, tabs] of sim.inv) {
      if (tabs.some((t) => t.tabId === tabId)) return sid
    }
    return null
  }
  const api = {
    sim,
    inv: sim.inv,
    stats: sim.stats,
    closeHandler: sim.closeHandler,
    throwOpenFirstN: sim.throwOpenFirstN,
    mounted: {
      getSnapshot: () => sim.mounted,
      subscribe: (fn) => { sim.subs.mounted.push(fn); return () => {} },
    },
    openTabs: {
      getSnapshot: () => {
        const all = []
        for (const [sid, tabs] of sim.inv) {
          for (const t of tabs) all.push({ sessionId: sid, tabId: t.tabId, kind: t.kind })
        }
        return all
      },
      subscribe: (fn) => { sim.subs.openTabs.push(fn); return () => {} },
    },
    isExpanded: () => sim.expanded,
    toggleExpanded: () => { sim.expanded = !sim.expanded },
    openTab(kind) {
      sim.stats.openCalls += 1
      const left = sim.throwOpenFirstN.get(sim.mounted) || 0
      if (left > 0) {
        sim.throwOpenFirstN.set(sim.mounted, left - 1)
        sim.stats.openThrew += 1
        throw new Error('sim: store not minted yet')
      }
      const sid = sim.mounted
      const tabs = sim.inv.get(sid) || []
      if (tabs.some((t) => t.kind === kind)) return // dsh 真实行为：同 kind 去重
      const tabId = 't' + (sim.nextTab++)
      sim.pendingLands.push({ at: clock.now() + (opts.invLagMs || 0), sid, tabId, kind })
    },
    close(tabId) {
      sim.stats.closes += 1
      const sid = findSid(tabId)
      const tab = (sim.inv.get(sid) || []).find((t) => t.tabId === tabId)
      sim.closeCommit.push({ at: clock.now() + (opts.closeCommitMs || 0), tabId, sid })
      if (tab && sim.closeHandler) {
        sim.stats.closeHandlerFired += 1
        try { sim.closeHandler(sid, tab) } catch { /* dsh 容忍 */ }
      }
    },
    registerCloseHandler(kind, fn) {
      sim.closeHandler = fn
      return () => { if (sim.closeHandler === fn) sim.closeHandler = null }
    },
    // 场景操作
    switchSession(sid) { sim.mounted = sid; fire(sim.subs.mounted) },
    setExpanded(v) { sim.expanded = v },
    countOwn(sid) { return (sim.inv.get(sid) || []).filter((t) => t.kind === 'portSidebar').length },
    flush,
  }
  return api
}

/** 装载插件（影子全局 + ModuleLoader 工厂协议），返回 { plugin, clickListeners, restore }。 */
function loadPlugin(src, clock) {
  const loads = []
  const clickListeners = []
  const savedGlobals = shadowGlobals(clock)
  const fakeDocument = {
    addEventListener(type, fn) {
      if (type === 'click') clickListeners.push(fn)
    },
    removeEventListener(type, fn) {
      const index = clickListeners.indexOf(fn)
      if (index >= 0) clickListeners.splice(index, 1)
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { getBoundingClientRect: () => ({ width: 1440, height: 900 }) },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  }
  const fakeWindow = { __ModuleLoader__: { load: (def) => loads.push(def) } }
  const fakeRequire = (name) => {
    if (name === 'react') return { createElement: (type, props) => ({ type, props }) }
    throw new Error('unexpected require: ' + name)
  }
  const run = new Function(
    'window', 'require', 'document', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'requestIdleCallback', 'Date', 'globalThis',
    src,
  )
  run(
    fakeWindow, fakeRequire, fakeDocument, clock.setTimeout, clock.setInterval, clock.clearTimeout, clock.clearInterval,
    undefined, globalThis.Date, { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
  )
  if (!loads.length) {
    savedGlobals()
    throw new Error('客户端源码未走 __ModuleLoader__.load 协议')
  }
  const plugin = loads[loads.length - 1].factory(fakeRequire)
  return { plugin, clickListeners, restore: savedGlobals }
}

/** 单基因组评估：5 个场景，聚合目标。 */
export async function evaluatePortSidebar(genome, tuning) {
  let src
  try {
    src = readFileSync(CLIENT_SRC, 'utf8')
  } catch {
    src = readFileSync(path.resolve(process.cwd(), 'extensions/official/dsh-port-sidebar/client/client.js'), 'utf8')
  }
  const objectives = {
    stabilityFailures: 0,
    wastedOpens: 0,
    timeToPresentP95: 0,
    reviveMsAvg: 0,
    tickCount: 0,
  }

  globalThis.__DSH_PORT_SIDEBAR_TUNING__ = tuning

  /* S1 会话风暴：3 会话（均已持久化 tab）切 12 次，清单落账延迟 600ms。
   * 期望：零 openTab（全部收养）、零重复、tab 始终在。 */
  {
    const clock = createClock()
    const sim = makeDshSim(clock, { sessions: { A: { tabs: ['portSidebar'] }, B: { tabs: ['portSidebar'] }, C: { tabs: ['portSidebar'] } }, invLagMs: 600 })
    const env = loadPlugin(src, clock)
    globalThis.__DSH_PORT_SIDEBAR__ = { url: 'http://127.0.0.1:39610/', keepAlive: true }
    env.plugin.apply({
      get: () => undefined,
      provide: () => {},
      effect: (fn) => { const d = fn(); return () => {} },
      sidebarRight: sim,
      sidebarRightTabs: { register: () => () => {} },
      slots: { inject: () => () => {} },
    })
    const openCallsAtStart = sim.stats.openCalls
    for (const sid of ['A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C', 'A', 'B', 'C']) {
      sim.switchSession(sid)
      clock.advance(400)
      sim.flush()
    }
    clock.advance(2000)
    sim.flush()
    const missing = ['A', 'B', 'C'].filter((sid) => sim.countOwn(sid) < 1).length
    objectives.stabilityFailures += missing * 2
    objectives.wastedOpens += Math.max(0, sim.stats.openCalls - openCallsAtStart)
    env.restore()
  }

  /* S2 全新会话 + 清单落账延迟 600ms（历史重复 tab 根因场景）。
   * 期望：恰好 1 次 openTab、无重复；1500ms 内 tab 出现。 */
  {
    const clock = createClock()
    const sim = makeDshSim(clock, { sessions: { fresh: { tabs: [] } }, invLagMs: 600 })
    const env = loadPlugin(src, clock)
    globalThis.__DSH_PORT_SIDEBAR__ = { url: 'http://127.0.0.1:39610/', keepAlive: true }
    env.plugin.apply({
      get: () => undefined,
      provide: () => {},
      effect: (fn) => { const d = fn(); return () => {} },
      sidebarRight: sim,
      sidebarRightTabs: { register: () => () => {} },
      slots: { inject: () => () => {} },
    })
    sim.switchSession('fresh')
    let presentAt = -1
    let opens = 0
    for (let step = 0; step < 40; step++) {
      clock.advance(100)
      sim.flush()
      opens = Math.max(opens, sim.stats.openCalls)
      if (presentAt < 0 && sim.countOwn('fresh') >= 1) presentAt = clock.now()
    }
    const dup = Math.max(0, opens - 1)
    objectives.wastedOpens += dup
    objectives.stabilityFailures += dup * 3
    if (presentAt < 0) objectives.stabilityFailures += 2
    objectives.timeToPresentP95 = Math.max(objectives.timeToPresentP95, presentAt > 0 ? presentAt : 5000)
    env.restore()
  }

  /* S3 命令路径关闭（键盘，绕过点击拦截）→ 复活。2 次取均值。 */
  {
    const clock = createClock()
    const sim = makeDshSim(clock, { sessions: { A: { tabs: ['portSidebar'] } } })
    const env = loadPlugin(src, clock)
    globalThis.__DSH_PORT_SIDEBAR__ = { url: 'http://127.0.0.1:39610/', keepAlive: true }
    env.plugin.apply({
      get: () => undefined,
      provide: () => {},
      effect: (fn) => { const d = fn(); return () => {} },
      sidebarRight: sim,
      sidebarRightTabs: { register: () => () => {} },
      slots: { inject: () => () => {} },
    })
    clock.advance(500); sim.flush()
    const revives = []
    for (let i = 0; i < 2; i++) {
      const mine = sim.inv.get('A').find((t) => t.kind === 'portSidebar')
      if (!mine) break
      sim.close(mine.tabId)
      let backAt = -1
      for (let step = 0; step < 60; step++) {
        clock.advance(100)
        sim.flush()
        if (sim.countOwn('A') >= 1) { backAt = clock.now(); break }
      }
      revives.push(backAt > 0 ? backAt : 60000)
      clock.advance(1000); sim.flush() // 冷却/稳定窗口
    }
    const avg = revives.length ? revives.reduce((a, b) => a + b, 0) / revives.length : 60000
    objectives.reviveMsAvg = avg
    if (revives.some((r) => r >= 60000)) objectives.stabilityFailures += 3
    env.restore()
  }

  /* S4 X 点击拦截：关闭点击必须被吞（tab 数不变、close 事件不触发）。
   * 通过 loadPlugin 暴露的 clickListeners 直接派发合成点击事件。 */
  {
    const clock = createClock()
    const sim = makeDshSim(clock, { sessions: { A: { tabs: ['portSidebar'] } } })
    const env = loadPlugin(src, clock)
    globalThis.__DSH_PORT_SIDEBAR__ = { url: 'http://127.0.0.1:39610/', keepAlive: true }
    env.plugin.apply({
      get: () => undefined,
      provide: () => {},
      effect: (fn) => { const d = fn(); return () => {} },
      sidebarRight: sim,
      sidebarRightTabs: { register: () => () => {} },
      slots: { inject: () => () => {} },
    })
    clock.advance(500); sim.flush()
    const closesBefore = sim.stats.closes
    const mine = sim.inv.get('A').find((t) => t.kind === 'portSidebar')
    // 构造真实点击链：button（aria-label=关闭）→ closest('[data-dockkit-tab]') → tab 元素
    const fakeTabEl = {
      getAttribute: (name) => (name === 'data-dockkit-tab' ? (mine ? mine.tabId : null) : null),
    }
    const fakeBtn = {
      getAttribute: (name) => (name === 'aria-label' ? '关闭' : null),
      closest: (sel) => (sel === 'button' ? fakeBtn : (sel === '[data-dockkit-tab]' ? fakeTabEl : null)),
    }
    let intercepted = false
    for (const fn of env.clickListeners) {
      const event = {
        target: fakeBtn,
        preventDefault() { event.defaultPrevented = true },
        stopPropagation() { event.stopped = true },
      }
      event.target.closest = (sel) => fakeBtn.closest(sel)
      fn(event)
      if (event.stopped || event.defaultPrevented) intercepted = true
    }
    clock.advance(1000)
    sim.flush()
    const breach = sim.stats.closes > closesBefore
    objectives.stabilityFailures += breach ? 5 : 0
    if (!intercepted) objectives.stabilityFailures += 5
    env.restore()
  }

  /* S5 openTab 前置故障风暴（前 3 次抛错）→ 必须自愈不放弃。
   * maxFailuresPerSession 过小 = 放弃健康会话（稳定性扣分）。 */
  {
    const clock = createClock()
    const sim = makeDshSim(clock, { sessions: { A: { tabs: [] } }, invLagMs: 300 })
    sim.throwOpenFirstN.set('A', 3)
    const env = loadPlugin(src, clock)
    globalThis.__DSH_PORT_SIDEBAR__ = { url: 'http://127.0.0.1:39610/', keepAlive: true }
    env.plugin.apply({
      get: () => undefined,
      provide: () => {},
      effect: (fn) => { const d = fn(); return () => {} },
      sidebarRight: sim,
      sidebarRightTabs: { register: () => () => {} },
      slots: { inject: () => () => {} },
    })
    sim.switchSession('A')
    let presentAt = -1
    for (let step = 0; step < 80; step++) {
      clock.advance(100)
      sim.flush()
      if (presentAt < 0 && sim.countOwn('A') >= 1) presentAt = clock.now()
    }
    if (presentAt < 0) {
      objectives.stabilityFailures += 3
      objectives.wastedOpens += sim.stats.openThrew
    }
    env.restore()
  }

  /* tick 计数：轮询触发次数（CPU 代理）——由检查间隔基因决定，间接体现 */
  return objectives
}

export default evaluatePortSidebar
