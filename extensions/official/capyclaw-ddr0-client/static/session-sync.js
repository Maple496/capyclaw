/**
 * Session Token 同步脚本
 * 
 * 功能：定期将浏览器的 sessionid Cookie 发送到服务器
 * 这样 tempkey 插件就能读取到登录态
 */
(function() {
  console.log('[Session Sync] 初始化...');
  
  function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
  }
  
  function syncSession() {
    const sessionid = getCookie('sessionid');
    if (sessionid) {
      // 发送到同步端点
      fetch('/api/sync-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionid })
      }).catch(err => {
        console.error('[Session Sync] 同步失败:', err);
      });
    }
  }
  
  // 每 30 秒同步一次
  setInterval(syncSession, 30000);
  // 立即执行一次
  syncSession();
  
  console.log('[Session Sync] 已启动，每 30 秒同步一次');
})();
