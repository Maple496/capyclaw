/**
 * dsh-port-sidebar 浏览器半。
 *
 * 装载协议与 tsdown 客户端产物一致：`window.__ModuleLoader__.load({ id, factory })`，
 * factory 内以 CJS 组装 Cordis 插件并返回 module.exports。
 *
 * 设计（0.2.0 实测后确定）：
 * 本插件注册**自己的**右侧边栏 tab 类型（kind `portSidebar`），正文就是一个指向
 * 目标端口的 iframe。不用借 Browser 类型，因为 Browser 声明了 `multiple: true`，
 * 每次 openTab 都是独立新 tab，且它的导航参数依赖 `navigation.params` 在会话
 * store 就绪的那一刻送达——会话刚切换时容易丢，于是留下空白 tab、也无法区分
 * "我的 tab"和用户自己的浏览器 tab。
 *
 * 自有类型带来三点确定性：
 * 1. 正文自己决定 src，不依赖导航参数，不会丢；
 * 2. kind 唯一 => 关闭回调、清单检查都能精确命中"我这一个"；
 * 3. `keepMounted: true`，切 tab/折叠不销毁 iframe，切会话回来页面不重载。
 *
 * 强制保活：默认开启。任何方式关掉（X、关闭命令）都会在关闭回调里立刻重开；
 * 清单变化做兜底。插件不卸载，这个 tab 就关不掉。
 */
window.__ModuleLoader__.load({ id: '@capyclaw/port-sidebar', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;

  /** 本插件在 tab 系统里的实现 id（也是正文/标题插槽的 key）。 */
  var TAB_ID = 'dsh-port-sidebar'
  /** 本插件独占的 tab kind。 */
  var TAB_KIND = 'portSidebar'
  /** tab 标题（未注册标题插槽时的回退文本也用这个）。 */
  var TAB_TITLE = '端口面板'

  var React = require('react')

  /**
   * 调优层（进化搜索 NSGA-II 固化的基线）：评估器经
   * globalThis.__DSH_PORT_SIDEBAR_TUNING__ 注入基因组逐项覆盖；
   * 生产默认值 = founder 基线，进化必须证明优于现状才能替换。
   */
  var TUNING = (function () {
    var base = {
      /** 补试第 2/3 档延迟（避开 mounted→store 铸造窗口）。 */
      retry2Ms: 200,
      retry3Ms: 1000,
      /** 保活轮询步长。 */
      checkIntervalMs: 300,
      /** 打开互斥窗口：openTab 提交后清单落账前不再发第二次打开。 */
      pendingOpenMs: 800,
      /** 复活节流：同会话两次复活最小间隔。 */
      reviveCooldownMs: 400,
      /** 单会话最大连续失败次数。 */
      maxFailuresPerSession: 5,
      /** 折叠门：侧栏折叠时首次打开是否让位（true=不抢布局）。 */
      collapseGate: true,
    }
    try {
      var evo = globalThis.__DSH_PORT_SIDEBAR_TUNING__
      if (evo && typeof evo === 'object') {
        for (var k in base) {
          if (k in evo && evo[k] !== undefined && evo[k] !== null) base[k] = evo[k]
        }
      }
    } catch (error) { /* 调优注入失败按默认跑 */ }
    return base
  })()

  /** 一次失效后的补试时刻（毫秒）：由调优层前两档组成。 */
  var RETRY_DELAYS_MS = [0, TUNING.retry2Ms, TUNING.retry3Ms]
  /** 单会话最大失败次数：超过后放弃并告警一次（如该组合未挂右侧边栏）。 */
  var MAX_FAILURES_PER_SESSION = TUNING.maxFailuresPerSession
  /** 复活节流：同一会话在此窗口内不重复重开。 */
  var REVIVE_COOLDOWN_MS = TUNING.reviveCooldownMs
  /** 打开互斥：提交 openTab 后清单落账前，不再发第二次打开。 */
  var PENDING_OPEN_MS = TUNING.pendingOpenMs
  /** 保活轮询步长（替代旧 CHECK_INTERVAL_MS 常量）。 */
  var CHECK_INTERVAL_MS = TUNING.checkIntervalMs

  /** 正文：目标端口的 iframe。背景取页面主题色，消除加载期的白闪。 */
  function createBody(url) {
    var bg = 'transparent'
    try {
      var cs = getComputedStyle(document.body)
      if (cs && cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') bg = cs.backgroundColor
    } catch (error) { /* 拿不到就用透明 */ }
    return function PortSidebarBody() {
      return React.createElement('iframe', {
        src: url,
        title: TAB_TITLE,
        style: { width: '100%', height: '100%', border: '0', display: 'block', background: bg },
      })
    }
  }

  /** 标题：固定文案，避免显示成内部地址。 */
  function PortSidebarTitle() {
    return React.createElement('span', null, TAB_TITLE)
  }

  module.exports = {
    name: 'dsh-port-sidebar',
    inject: ['slots', 'sidebarRight', 'sidebarRightTabs'],
    apply: function (ctx) {
      var boot = globalThis.__DSH_PORT_SIDEBAR__
      var url = boot && typeof boot.url === 'string' ? boot.url : undefined
      if (url === undefined) {
        console.warn('[dsh-port-sidebar] 页面未收到 __DSH_PORT_SIDEBAR__，请确认宿主半已加载且目标地址可解析')
        return
      }
      var keepAlive = !(boot && boot.keepAlive === false)
      var sidebar = ctx.sidebarRight

      /** 强制校正：即使旧 tab 被恢复，iframe 也必须指向注入的 URL（防错实例）。 */
      function enforceUrl() {
        if (disposed) return
        try {
          var frames = document.querySelectorAll('iframe[title="' + TAB_TITLE + '"]')
          for (var i = 0; i < frames.length; i++) {
            var frame = frames[i]
            if (frame.getAttribute('src') !== url) {
              frame.setAttribute('src', url)
              note('force-src')
            }
          }
        } catch (error) { /* DOM 异常忽略 */ }
      }

      /** 诊断出口：把关键步骤记到全局，便于在页面控制台/自动化里核对。 */
      var diag = { plugin: 'applied', opened: 0, closes: 0, revives: 0, adopted: 0, lastError: null, events: [] }
      globalThis.__DSH_PORT_SIDEBAR_DEBUG__ = diag
      /** 快照（只含原始值，避免自动化读 diag 时的循环引用）。 */
      diag.snapshot = function () {
        var mounted = sidebar.mounted.getSnapshot()
        return {
          mounted: mounted,
          expanded: sidebarExpanded(),
          ensured: Array.from(ensured),
          hasOwnTab: mounted !== undefined ? hasOwnTab(mounted) : null,
          ownTabs: sidebar.openTabs.getSnapshot().filter(function (t) { return t.kind === TAB_KIND }),
          pending: Array.from(pendingOpen.entries()),
          now: Date.now(),
        }
      }
      function note(event) {
        diag.events.push(event + '@' + Date.now())
        if (diag.events.length > 40) diag.events.shift()
      }

      // 1. 注册类型（只做一次，随 fiber 卸载）
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          // multiple: false (默认) → 每个会话每个 pane 最多一个，openTab 去重
          keepMounted: true,
          priority: 'extension',
          title: function () { return TAB_TITLE },
        })
      }, 'dsh-port-sidebar.type')

      // 2. 注册正文与标题插槽
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, createBody(url))
        })
      }, 'dsh-port-sidebar.body')

      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
          return ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, PortSidebarTitle)
        })
      }, 'dsh-port-sidebar.title')

      // 3. 保活：每个屏上会话一个自己的 tab，关掉就重开
      /** 已认领过的会话：每会话每个页面生命周期只"首次打开"一次，杜绝清单延迟造成的重复开。 */
      var ensured = new Set()
      /** 会话 → 上次观测到的"有 tab"状态（用于识别关闭）。 */
      var lastHad = new Map()
      var failureCount = new Map()
      var revivedAt = new Map()
      var pendingOpen = new Map()
      var retryTimers = [null, null, null]
      var disposed = false

      function hasOwnTab(sessionId) {
        return sidebar.openTabs.getSnapshot().some(function (tab) {
          return tab.sessionId === sessionId && tab.kind === TAB_KIND
        })
      }


      function isPendingOpen(sessionId) {
        var at = pendingOpen.get(sessionId)
        return at !== undefined && Date.now() - at < PENDING_OPEN_MS
      }

      /** 侧栏是否展开；拿不到状态时按展开处理（保持旧行为）。 */
      function sidebarExpanded() {
        try {
          return typeof sidebar.isExpanded !== 'function' || sidebar.isExpanded() !== false
        } catch (error) {
          return true
        }
      }

      /** 避开会话切换的渲染帧：把"动布局"的操作推迟到空闲时机。 */
      function whenIdle(fn) {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(function () { if (!disposed) fn() }, { timeout: 600 })
        } else {
          setTimeout(function () { if (!disposed) fn() }, 120)
        }
      }

      var idleScheduled = new Set()
      var collapseNoteAt = 0

      function adopt(sessionId) {
        ensured.add(sessionId)
        diag.adopted = (diag.adopted || 0) + 1
        note('adopt:' + sessionId.slice(0, 12))
      }

      function openPortTab(sessionId) {
        pendingOpen.set(sessionId, Date.now())
        diag.opened += 1
        note('open:' + sessionId.slice(0, 12))
        // revealIfOpened: true → 如果已有就激活，没有就创建（避免去重静默忽略）
        sidebar.openTab(TAB_KIND, { revealIfOpened: true })
        // 认领：此后本会话不再"首次打开"，只允许关闭后复活。
        ensured.add(sessionId)
      }

      function ensureOnce() {
        var sessionId = sidebar.mounted.getSnapshot()
        if (sessionId === undefined) return
        // 关键：已认领过的会话绝不再"首次打开"（这是重复 tab 的根因）。
        if (ensured.has(sessionId)) return
        if (isPendingOpen(sessionId)) return
        // 收养已存在的自有 tab（冷启动恢复出的那个），纳入保活覆盖。
        if (hasOwnTab(sessionId)) {
          adopt(sessionId)
          return
        }
        var count = failureCount.get(sessionId) || 0
        if (count >= MAX_FAILURES_PER_SESSION) return
        // 优化 #3：侧栏折叠时不抢布局；轮询会在用户展开后补开。
        if (TUNING.collapseGate && !sidebarExpanded()) {
          if (Date.now() - collapseNoteAt > 2000) {
            note('defer:collapsed')
            collapseNoteAt = Date.now()
          }
          return
        }
        // 优化 #2：避开切换帧，放到空闲时机再创建。
        if (idleScheduled.has(sessionId)) return
        idleScheduled.add(sessionId)
        whenIdle(function () {
          idleScheduled.delete(sessionId)
          if (disposed || ensured.has(sessionId)) return
          if (hasOwnTab(sessionId)) {
            adopt(sessionId)
            return
          }
          if (!sidebarExpanded()) return
          try {
            openPortTab(sessionId)
          } catch (error) {
            failureCount.set(sessionId, (failureCount.get(sessionId) || 0) + 1)
            if ((failureCount.get(sessionId) || 0) >= MAX_FAILURES_PER_SESSION) {
              console.warn('[dsh-port-sidebar] 放弃为会话注入 tab（连续失败 ' + failureCount.get(sessionId) + ' 次）', error)
            }
          }
        })
      }

      function schedule() {
        for (var i = 0; i < RETRY_DELAYS_MS.length; i++) {
          if (retryTimers[i] !== null) continue
          retryTimers[i] = setTimeout(function (tier) {
            return function () {
              retryTimers[tier] = null
              if (disposed) return
              try {
                ensureOnce()
                checkAndRevive()
              } catch (error) {
                console.warn('[dsh-port-sidebar] 注入检查失败', error)
              }
            }
          }(i), RETRY_DELAYS_MS[i])
        }
      }

      function onInventoryChange() {
        try {
          checkAndRevive()
        } catch (error) {
          console.warn('[dsh-port-sidebar] 保活检查失败', error)
        }
        schedule()
      }

      // 主保活：纯定时轮询（步长走 TUNING.checkIntervalMs）
      var unregisterClose
      if (typeof sidebar.registerCloseHandler === 'function') {
        try {
          unregisterClose = sidebar.registerCloseHandler(TAB_KIND, function (closedSessionId) {
            diag.closes += 1
            note('close:' + closedSessionId.slice(0, 12))
            // 清理 pending 标记（虽然 handler 可能不会再触发，但初始化时能帮助）
            pendingOpen.delete(closedSessionId)
          })
        } catch (error) {
          diag.lastError = String(error)
          console.warn('[dsh-port-sidebar] 无法注册关闭钩子', error)
        }
      }

      function checkAndRevive() {
        if (!keepAlive) return
        var now = Date.now()
        if (now - lastCheckTime < CHECK_INTERVAL_MS) return
        lastCheckTime = now
        var mounted = sidebar.mounted.getSnapshot()
        if (mounted === undefined) return
        // 注意：复活不受折叠门限制——"关不掉"是强制契约；折叠门只管首次打开。

        var hasTab = hasOwnTab(mounted)
        var hasPending = isPendingOpen(mounted)
        var previouslyHad = lastHad.get(mounted) === true
        // 清单是会话级的、权威的；DOM 检查跨会话污染（保留式布局下，
        // 其他会话的隐藏树里也有同名 tab），不能用于关闭判定。
        lastHad.set(mounted, hasTab)

        // 只复活"我们认领过"的会话：没认领过的交给 ensureOnce 首次打开。
        if (!ensured.has(mounted)) return

        // 检测关闭：上次有、这次没有 → 让复活立刻生效。
        if (previouslyHad && !hasTab) {
          note('detected-close:' + mounted.slice(0, 12))
          pendingOpen.delete(mounted)
          hasPending = false
        }

        // pending 过期仍无 tab → 说明上次打开被静默丢弃，允许重试。
        if (hasPending && !hasTab) {
          var pendingAge = now - pendingOpen.get(mounted)
          if (pendingAge > PENDING_OPEN_MS) {
            note('clearStale:' + mounted.slice(0, 12))
            pendingOpen.delete(mounted)
            hasPending = false
          }
        }

        if (hasTab || hasPending) return

        var last = revivedAt.get(mounted)
        if (last !== undefined && now - last < REVIVE_COOLDOWN_MS) return
        revivedAt.set(mounted, now)
        diag.revives += 1
        note('revive:' + mounted.slice(0, 12))
        try {
          openPortTab(mounted)
        } catch (error) {
          diag.lastError = String(error)
          note('openFail:' + String(error).slice(0, 40))
          console.warn('[dsh-port-sidebar] 保活重开失败', error)
        }
      }

      /**
       * 主保活：UI 层拦截。在 capture 阶段吞掉"我们这个 tab"的关闭点击，
       * 让关闭根本不发生（实测 close→revive 会与关闭事务竞态：openTab 落进
       * tab domain 却不渲染，反复重开反而把面板搞没）。键盘关闭命令等
       * 非 click 路径兜不住，由下方轮询复活兜底。
       * 识别方式：按钮带 关闭/close 标签，且位于 [data-dockkit-tab] 内，
       * 该 tab 的 id 与清单里"当前屏上会话的我们这个 kind"的 tabId 一致
       * ——只拦自己的，不碰用户自己开的 tab。
       */
      function guardCloseClicks(event) {
        if (disposed) return
        var target = event.target
        if (!target || typeof target.closest !== 'function') return
        var btn = target.closest('button')
        if (!btn) return
        var label = btn.getAttribute('aria-label') || btn.getAttribute('title') || ''
        if (!/关闭|close/i.test(label)) return
        var tabEl = btn.closest('[data-dockkit-tab]')
        if (!tabEl) return
        var tabId = tabEl.getAttribute('data-dockkit-tab')
        var mounted = sidebar.mounted.getSnapshot()
        if (mounted === undefined) return
        var isMine = sidebar.openTabs.getSnapshot().some(function (t) {
          return t.sessionId === mounted && t.kind === TAB_KIND && t.tabId === tabId
        })
        if (!isMine) return
        event.preventDefault()
        event.stopPropagation()
        diag.blocked = (diag.blocked || 0) + 1
        note('blocked:' + String(tabId))
      }
      document.addEventListener('click', guardCloseClicks, true)

      // 定时轮询保活（300ms 一次，足够快但不过载）；同时兜住"折叠后展开"的补开。
      var urlGuardTimer = setInterval(enforceUrl, 1000)
      enforceUrl()
      var checkTimer = setInterval(function () {
        if (disposed) return
        try {
          ensureOnce()
          checkAndRevive()
        } catch (error) {
          console.warn('[dsh-port-sidebar] 定时保活检查失败', error)
        }
      }, CHECK_INTERVAL_MS)

      schedule()
      var unsubscribeMounted = sidebar.mounted.subscribe(schedule)
      var unsubscribeTabs = sidebar.openTabs.subscribe(onInventoryChange)

      ctx.effect(function () {
        return function () {
          disposed = true
          unsubscribeMounted()
          unsubscribeTabs()
          if (typeof unregisterClose === 'function') unregisterClose()
          document.removeEventListener('click', guardCloseClicks, true)
          if (checkTimer !== null) clearInterval(checkTimer)
          if (urlGuardTimer !== null) clearInterval(urlGuardTimer)
          for (var i = 0; i < retryTimers.length; i++) {
            if (retryTimers[i] !== null) clearTimeout(retryTimers[i])
          }
        }
      })
    },
  }

  return module.exports;
} });
