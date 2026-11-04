/**
 * 虚拟时钟 + 全局影子工具：评估器用它把插件的小时级时序压到毫秒级仿真。
 *
 * 原理：把 globalThis 的 Date.now / setTimeout / setInterval / clearTimeout /
 * clearInterval 影子成时钟实现，场景推进用 clock.advance(ms)（按到期顺序
 * 同步执行到期回调）。用完必须 restore()，避免污染同进程其他测试。
 */

export function createClock(startAt = 1793550000000) {
  let now = startAt
  let seq = 1
  const timers = new Map() // id -> { at, fn, interval }

  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = seq++
      timers.set(id, { id, at: now + Math.max(0, Number(ms) || 0), fn, interval: 0 })
      return id
    },
    setInterval(fn, ms) {
      const id = seq++
      timers.set(id, { id, at: now + Math.max(1, Number(ms) || 1), fn, interval: Math.max(1, Number(ms) || 1) })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    clearInterval(id) { timers.delete(id) },
    /** 推进虚拟时间：执行 (now, now+ms] 内到期的定时器（到期顺序）。 */
    advance(ms) {
      const until = now + ms
      for (;;) {
        let next = null
        for (const t of timers.values()) {
          if (t.at <= until && (next === null || t.at < next.at)) next = t
        }
        if (next === null) break
        now = Math.max(now, next.at)
        if (next.interval > 0) next.at = now + next.interval
        else timers.delete(next.id)
        next.fn()
      }
      now = until
    },
  }
}

/**
 * 用时钟影子全局定时器与 Date.now，返回 restore()。
 * 影子期间被 import/调用的模块全部走虚拟时钟。
 */
export function shadowGlobals(clock) {
  const g = globalThis
  const saved = {
    Date: g.Date,
    setTimeout: g.setTimeout,
    setInterval: g.setInterval,
    clearTimeout: g.clearTimeout,
    clearInterval: g.clearInterval,
    requestIdleCallback: g.requestIdleCallback,
  }
  function FakeDate(...args) {
    return args.length ? new saved.Date(...args) : new saved.Date(clock.now())
  }
  FakeDate.now = () => clock.now()
  FakeDate.parse = saved.Date.parse
  FakeDate.UTC = saved.Date.UTC
  FakeDate.prototype = saved.Date.prototype
  g.Date = FakeDate
  g.setTimeout = (fn, ms, ...rest) => clock.setTimeout(fn, ms, ...rest)
  g.setInterval = (fn, ms, ...rest) => clock.setInterval(fn, ms, ...rest)
  g.clearTimeout = (id) => clock.clearTimeout(id)
  g.clearInterval = (id) => clock.clearInterval(id)
  // 插件里的 whenIdle 分支：浏览器 rIC 缺席时走 setTimeout（已影子化）
  g.requestIdleCallback = undefined
  return function restore() {
    g.Date = saved.Date
    g.setTimeout = saved.setTimeout
    g.setInterval = saved.setInterval
    g.clearTimeout = saved.clearTimeout
    g.clearInterval = saved.clearInterval
    if (saved.requestIdleCallback !== undefined) g.requestIdleCallback = saved.requestIdleCallback
    else delete g.requestIdleCallback
  }
}

/**
 * 装载 dsh-port-sidebar 的浏览器半（__ModuleLoader__ 工厂协议）。
 * 影子在 restore() 前持续生效（场景推进期间插件的定时器/时间读取都走时钟）。
 */
export function loadSidebarPlugin(src, clock) {
  const loads = []
  const listeners = { click: [] }
  const fakeDocument = {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn) },
    removeEventListener(type, fn) {
      const list = listeners[type] || []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { getBoundingClientRect: () => ({ width: 1440, height: 900 }) },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  }
  const savedGlobals = shadowGlobals(clock)
  const savedConsole = globalThis.console
  const logs = []
  globalThis.console = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')), error: () => {} }
  const savedComputed = globalThis.getComputedStyle
  globalThis.getComputedStyle = () => ({ backgroundColor: 'rgb(24, 26, 27)' })
  const fakeWindow = { __ModuleLoader__: { load: (def) => loads.push(def) } }
  const fakeRequire = (name) => {
    if (name === 'react') {
      return { createElement: (type, props) => ({ type, props }) }
    }
    throw new Error('unexpected require: ' + name)
  }
  const run = new Function(
    'window', 'require', 'document', 'getComputedStyle', 'console',
    'requestIdleCallback', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'Date', 'globalThis',
    src,
  )
  run(
    fakeWindow, fakeRequire, fakeDocument, globalThis.getComputedStyle, globalThis.console,
    undefined, clock.setTimeout, clock.setInterval, clock.clearTimeout, clock.clearInterval,
    globalThis.Date, { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
  )
  if (!loads.length) {
    savedGlobals()
    globalThis.console = savedConsole
    globalThis.getComputedStyle = savedComputed
    throw new Error('客户端源码未走 __ModuleLoader__.load 协议')
  }
  const plugin = loads[loads.length - 1].factory(fakeRequire)
  return {
    plugin,
    logs,
    /** 派发一次合成点击（用于 X 关闭拦截验证）。target.closest 按 closestSel 解析。 */
    dispatchClick(targetChain) {
      const button = targetChain.find((node) => node.__isButton) || targetChain[0]
      const event = {
        target: button,
        preventDefault() { event.defaultPrevented = true },
        stopPropagation() { event.stopped = true },
      }
      event.target.closest = (sel) => {
        if (sel !== 'button') return null
        return targetChain.find((node) => node.__isButton) || null
      }
      for (const fn of listeners.click) fn(event)
      return { intercepted: !!event.stopped || !!event.defaultPrevented }
    },
    restore() {
      savedGlobals()
      globalThis.console = savedConsole
      globalThis.getComputedStyle = savedComputed
    },
  }
}
