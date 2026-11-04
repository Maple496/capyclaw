/**
 * dsh-launchpad 浏览器半：在左侧全局面板区注册「启动清单」入口。
 *
 * 页面本体由独立 launchpad 服务托管（/ 就是管理界面），这里只挂一个
 * iframe；不直接拉服务、不写文件。
 */
window.__ModuleLoader__.load({ id: '@capyclaw/launchpad', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports
  var React = require('react')
  var PANEL_ID = 'launchpad'
  var boot = globalThis.__DSH_LAUNCHPAD__
  var url = boot && typeof boot.url === 'string' ? boot.url : ''

  function LaunchpadPage() {
    return React.createElement('iframe', {
      src: url,
      title: '启动清单',
      style: { width: '100%', height: '100%', border: '0', display: 'block', background: 'transparent' },
    })
  }

  function LaunchpadIcon({ size }) {
    var s = typeof size === 'number' ? size : 18
    return React.createElement('svg', {
      width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    React.createElement('path', { d: 'M5 4.5 19 12 5 19.5v-15Z' }),
    React.createElement('path', { d: 'M9.5 12H19' }))
  }

  module.exports = {
    name: 'dsh-launchpad',
    inject: ['slots'],
    apply: function (ctx) {
      if (!url) {
        console.warn('[dsh-launchpad] 未收到 __DSH_LAUNCHPAD__（launchpad 服务未运行？）')
        return
      }
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID }, LaunchpadPage)
      })
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 6,
          label: function () { return '启动清单' },
        }, LaunchpadIcon)
      })
    },
  }
  return module.exports
} })
