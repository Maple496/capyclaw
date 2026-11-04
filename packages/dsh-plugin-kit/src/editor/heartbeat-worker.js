/* Web Worker：独立线程保持心跳，不受浏览器标签页节流影响
 * 
 * 设计原则：
 * 1. 健壮降级：任何失败都通知主线程，主线程决定是否降级
 * 2. 自我监控：内置健康检查，连续失败自动报告
 * 3. 优雅退出：stop 后立即停止，不留残留定时器
 */

let active = false;
let clientId = null;
let apiBase = null;
let intervalHandle = null;
let consecutiveFailures = 0;
const MAX_FAILURES = 3; // 连续失败 3 次后通知主线程降级

self.onmessage = function(e) {
  const { type, data } = e.data;
  
  if (type === 'start') {
    active = true;
    clientId = data.clientId;
    apiBase = data.apiBase;
    consecutiveFailures = 0;
    startHeartbeat();
    self.postMessage({ type: 'started', clientId });
  } else if (type === 'stop') {
    active = false;
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    self.postMessage({ type: 'stopped' });
  } else if (type === 'ping') {
    // 主线程健康检查：返回当前状态
    self.postMessage({ 
      type: 'pong', 
      active, 
      clientId,
      consecutiveFailures,
      timestamp: Date.now()
    });
  }
};

function startHeartbeat() {
  if (intervalHandle) clearInterval(intervalHandle);
  
  // 每 4 秒发送心跳（留 1 秒缓冲，避免刚好 5 秒时被判过期）
  intervalHandle = setInterval(() => {
    if (!active) return;
    
    sendClaim().catch(err => {
      consecutiveFailures++;
      self.postMessage({ 
        type: 'error', 
        message: err.message,
        consecutiveFailures,
        fatal: consecutiveFailures >= MAX_FAILURES
      });
      
      // 连续失败达到阈值，建议主线程降级
      if (consecutiveFailures >= MAX_FAILURES) {
        self.postMessage({ 
          type: 'fatal', 
          message: `连续 ${MAX_FAILURES} 次心跳失败，建议降级到主线程`
        });
      }
    });
  }, 4000);
  
  // 立即发送第一次
  sendClaim().catch(() => {});
}

async function sendClaim() {
  if (!apiBase || !clientId) {
    throw new Error('Worker 未初始化：缺少 apiBase 或 clientId');
  }
  
  const url = `${apiBase}/claim`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 秒超时
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: clientId }),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    
    // 成功：重置失败计数
    if (consecutiveFailures > 0) {
      consecutiveFailures = 0;
      self.postMessage({ type: 'recovered' }); // 通知主线程已恢复
    }
    
    self.postMessage({ 
      type: 'heartbeat', 
      timestamp: Date.now(), 
      response: data,
      consecutiveFailures: 0
    });
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}
