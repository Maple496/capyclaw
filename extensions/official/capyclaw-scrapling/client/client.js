/**
 * dsh-scrapling 浏览器半
 *
 * 装载协议与 tsdown 客户端产物一致：`window.__ModuleLoader__.load({ id, factory })`，
 * factory 内以 CJS 组装 Cordis 插件并返回 module.exports。
 *
 * 面板注册协议与 dsh-port-sidebar（0.2.0 实测基线）对齐：
 *   1. inject slots + sidebarRight + sidebarRightTabs 三个服务；
 *   2. 注册自有 tab 类型（kind 唯一、keepMounted 保活 iframe）；
 *   3. 注册正文/标题两个插槽（正文即指向工作台的 iframe）；
 *   4. 主动 openTab 打开（会话 store 未就绪时分档重试）。
 *
 * 宿主半把工作台地址注入为 __DSH_SCRAPLING__（webserver/index-inject）。
 * 直接用浏览器打开工作台（无 DSH web 客户端）时本文件不产生任何副作用。
 */
window.__ModuleLoader__.load({ id: '@capyclaw/scrapling', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;

  var React = require('react')

  /** 本插件在 tab 系统里的实现 id（正文/标题插槽的 key）。 */
  var TAB_ID = 'dsh-scrapling-workbench'
  /** 本插件独占的 tab kind。 */
  var TAB_KIND = 'scraplingWorkbench'
  /** tab 标题。 */
  var TAB_TITLE = '爬虫工作台'
  /** 打开重试档位（避开 mounted→store 铸造窗口，同 port-sidebar 基线）。 */
  var RETRY_DELAYS_MS = [0, 200, 1000]

  module.exports = {
    name: 'dsh-scrapling',
    inject: ['slots', 'sidebarRight', 'sidebarRightTabs'],
    apply: function (ctx) {
      var boot = globalThis.__DSH_SCRAPLING__
      if (!boot || typeof boot.url !== 'string') {
        console.warn('[dsh-scrapling] 页面未收到 __DSH_SCRAPLING__（宿主半未加载或工作台未启动），跳过面板注册；可直接访问 http://127.0.0.1:39640/')
        return
      }
      var url = boot.url
      var disposed = false
      var retryTimers = []
      /** 诊断出口（自动化/控制台核对用）。 */
      var diag = { plugin: 'applied', opened: 0, lastError: null, events: [] }
      globalThis.__DSH_SCRAPLING_DEBUG__ = diag
      function note(event) {
        diag.events.push(event + '@' + Date.now())
        if (diag.events.length > 40) diag.events.shift()
      }

      /** 正文：指向工作台的 iframe。背景取页面主题色，消除加载期白闪。 */
      function createBody(targetUrl) {
        var bg = 'transparent'
        try {
          var cs = getComputedStyle(document.body)
          if (cs && cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') bg = cs.backgroundColor
        } catch (error) { /* 拿不到就用透明 */ }
        return function ScraplingBody() {
          return React.createElement('iframe', {
            src: targetUrl,
            title: TAB_TITLE,
            style: { width: '100%', height: '100%', border: '0', display: 'block', background: bg },
          })
        }
      }

      function ScraplingTitle() {
        return React.createElement('span', null, TAB_TITLE)
      }

      /* 1. 注册 tab 类型（kind 唯一 → 关闭回调/清单检查精确命中；keepMounted 切 tab 不重载） */
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          keepMounted: true,
          priority: 'extension',
          title: function () { return TAB_TITLE },
        })
      }, 'dsh-scrapling.type')

      /* 2. 正文插槽 */
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, createBody(url))
        })
      }, 'dsh-scrapling.body')

      /* 3. 标题插槽 */
      ctx.effect(function () {
        return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
          return ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, ScraplingTitle)
        })
      }, 'dsh-scrapling.title')

      /* 4. 打开 tab：会话 store 未就绪（mounted === undefined）时分档重试 */
      function openWorkbenchTab() {
        diag.opened += 1
        note('open')
        ctx.sidebarRight.openTab(TAB_KIND, { revealIfOpened: true })
      }

      function tryOpen(tier) {
        if (disposed) return
        var sessionId
        try {
          sessionId = ctx.sidebarRight.mounted.getSnapshot()
        } catch (error) {
          sessionId = undefined
        }
        if (sessionId === undefined) return schedule(tier)
        try {
          openWorkbenchTab()
        } catch (error) {
          diag.lastError = String(error)
          note('openFail:' + String(error).slice(0, 40))
          schedule(tier)
        }
      }

      function schedule(tier) {
        if (disposed || tier >= RETRY_DELAYS_MS.length) return
        if (retryTimers[tier] !== null && retryTimers[tier] !== undefined) return
        retryTimers[tier] = setTimeout(function () {
          retryTimers[tier] = null
          tryOpen(tier + 1)
        }, RETRY_DELAYS_MS[tier])
      }

      /* 会话切换后在新会话补开一次（静默，不抢焦点） */
      var unsubscribeMounted = ctx.sidebarRight.mounted.subscribe(function () {
        try {
          var mounted = ctx.sidebarRight.mounted.getSnapshot()
          if (mounted === undefined) return
          var has = ctx.sidebarRight.openTabs.getSnapshot().some(function (t) {
            return t.sessionId === mounted && t.kind === TAB_KIND
          })
          if (!has) tryOpen(0)
        } catch (error) { /* 清单暂不可读时留给下次订阅 */ }
      })

      tryOpen(0)

      ctx.effect(function () {
        return function () {
          disposed = true
          unsubscribeMounted()
          for (var i = 0; i < retryTimers.length; i++) {
            if (retryTimers[i] !== null && retryTimers[i] !== undefined) clearTimeout(retryTimers[i])
          }
        }
      })
    },
  }

  return module.exports;
} });
