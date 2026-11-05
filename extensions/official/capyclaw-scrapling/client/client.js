/**
 * dsh-scrapling 浏览器半
 *
 * 宿主半会把工作台地址注入为 boot 全局 __DSH_SCRAPLING__（协议与
 * launchpad / port-sidebar 相同）。这里把工作台挂进右侧边栏 iframe；
 * 在没有 DSH web 客户端（直接用浏览器打开工作台）时静默跳过，不报错。
 */
window.__ModuleLoader__.load({ id: '@capyclaw/scrapling', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;

  module.exports = {
    name: 'dsh-scrapling',
    inject: ['slots'],
    apply: function (ctx) {
      var boot = globalThis.__DSH_SCRAPLING__
      if (!boot || !boot.url || !ctx.slots) {
        console.log('[dsh-scrapling] 客户端已加载（工作台地址未注入，跳过面板注册；可直接访问 http://127.0.0.1:39640/）')
        return
      }

      try {
        var React = require('react')
        var PANEL_ID = 'scrapling-workbench'
        var panel = React.createElement('iframe', {
          src: boot.url,
          title: 'DSH 爬虫工作台',
          style: { width: '100%', height: '100%', border: 'none' },
        })
        ctx.slots.inject('sidebar.right.pane.tab', function () {
          return ctx.slots.register({ name: 'sidebar.right.pane.tab.scrapling', key: PANEL_ID }, panel)
        })
        console.log('[dsh-scrapling] 工作台面板已注册:', boot.url)
      } catch (error) {
        console.warn('[dsh-scrapling] 面板注册失败（工作台仍可直接访问）:', error && error.message)
      }

      ctx.effect(function () {
        return function () {
          console.log('[dsh-scrapling] 客户端已卸载')
        }
      })
    },
  }

  return module.exports;
} });
