/**
 * dsh-scrapling 浏览器半
 * 
 * 提供 Scrapling 功能的前端界面集成
 */
window.__ModuleLoader__.load({ id: '@capyclaw/scrapling', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;

  module.exports = {
    name: 'dsh-scrapling',
    inject: ['slots'],
    apply: function (ctx) {
      console.log('[dsh-scrapling] 客户端已加载')
      
      // 在这里可以注册 UI 组件、命令等
      
      // 清理函数
      ctx.effect(function () {
        return function () {
          console.log('[dsh-scrapling] 客户端已卸载')
        }
      })
    },
  }

  return module.exports;
} });
