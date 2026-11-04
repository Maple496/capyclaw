/**
 * Web UI 接口 - ServiceManager 的可视化控制面板
 * 
 * 提供：
 * - 实时查看所有服务状态
 * - 启动/停止服务
 * - 查看日志
 * - 访问各服务的 Web 界面
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export class WebUiInterface {
  constructor(manager, options = {}) {
    this.manager = manager;
    this.port = options.port || 9999;
    this.serviceUrls = options.serviceUrls || {};
    this.server = null;
    
    this.setupEventHandlers();
  }

  /**
   * 监听管理器事件
   */
  setupEventHandlers() {
    this.manager.on('service:started', () => {
      this.broadcast({ type: 'status', data: this.manager.getStatus() });
    });

    this.manager.on('service:stopped', () => {
      this.broadcast({ type: 'status', data: this.manager.getStatus() });
    });

    this.manager.on('service:error', ({ name, error }) => {
      this.broadcast({ type: 'error', data: { name, error: error.message } });
    });
  }

  /**
   * 启动 Web 服务器
   */
  async start() {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${this.port}`);

      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // 路由
      if (url.pathname === '/' && req.method === 'GET') {
        // 返回 HTML 界面
        res.setHeader('Content-Type', 'text/html');
        res.writeHead(200);
        res.end(this.getHtmlPage());

      } else if (url.pathname === '/api/status' && req.method === 'GET') {
        // 获取所有服务状态
        const status = this.manager.getStatus();
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({
          services: status,
          urls: this.serviceUrls,
        }));

      } else if (url.pathname.startsWith('/api/start/') && req.method === 'POST') {
        // 启动服务
        const name = url.pathname.split('/')[3];
        try {
          await this.manager.start(name);
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }

      } else if (url.pathname.startsWith('/api/stop/') && req.method === 'POST') {
        // 停止服务
        const name = url.pathname.split('/')[3];
        try {
          await this.manager.stop(name);
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }

      } else if (url.pathname === '/api/stopall' && req.method === 'POST') {
        // 停止所有服务
        try {
          await this.manager.stopAll();
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }

      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`\n🌐 Web 管理界面已启动: http://localhost:${this.port}/`);
      console.log(`   在浏览器中打开此地址进行管理\n`);
    });
  }

  /**
   * 广播消息（未来可用于 WebSocket）
   */
  broadcast(message) {
    // 预留接口，未来可实现 WebSocket 实时推送
  }

  /**
   * 生成 HTML 页面
   */
  getHtmlPage() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>服务管理面板</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f5;
      padding: 20px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 {
      font-size: 28px;
      margin-bottom: 24px;
      color: #333;
    }
    .services {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 20px;
    }
    .service-card {
      background: white;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .service-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .service-name {
      font-size: 18px;
      font-weight: 600;
      color: #333;
    }
    .service-status {
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }
    .status-running { background: #d4edda; color: #155724; }
    .status-stopped { background: #f8d7da; color: #721c24; }
    .status-starting { background: #fff3cd; color: #856404; }
    .status-failed { background: #f8d7da; color: #721c24; }
    .service-info {
      margin-bottom: 16px;
      font-size: 14px;
      color: #666;
    }
    .service-info div {
      margin-bottom: 8px;
    }
    .service-actions {
      display: flex;
      gap: 8px;
    }
    button {
      flex: 1;
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-start {
      background: #28a745;
      color: white;
    }
    .btn-start:hover { background: #218838; }
    .btn-stop {
      background: #dc3545;
      color: white;
    }
    .btn-stop:hover { background: #c82333; }
    .btn-open {
      background: #007bff;
      color: white;
    }
    .btn-open:hover { background: #0056b3; }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .global-actions {
      margin-bottom: 24px;
      display: flex;
      gap: 12px;
    }
    .btn-stopall {
      background: #dc3545;
      color: white;
      padding: 12px 24px;
    }
    .btn-refresh {
      background: #6c757d;
      color: white;
      padding: 12px 24px;
    }
    .loading {
      text-align: center;
      padding: 40px;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎛️ 服务管理面板</h1>
    
    <div class="global-actions">
      <button class="btn-stopall" onclick="stopAll()">停止所有服务</button>
      <button class="btn-refresh" onclick="loadStatus()">刷新状态</button>
    </div>

    <div id="services" class="services">
      <div class="loading">正在加载...</div>
    </div>
  </div>

  <script>
    let services = {};
    let urls = {};

    async function loadStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        services = data.services;
        urls = data.urls;
        renderServices();
      } catch (err) {
        console.error('加载状态失败:', err);
      }
    }

    function renderServices() {
      const container = document.getElementById('services');
      
      if (Object.keys(services).length === 0) {
        container.innerHTML = '<div class="loading">没有服务</div>';
        return;
      }

      container.innerHTML = Object.entries(services).map(([name, info]) => {
        const statusClass = 'status-' + info.state;
        const statusText = {
          running: '运行中',
          stopped: '已停止',
          starting: '启动中',
          stopping: '停止中',
          failed: '失败'
        }[info.state] || info.state;

        const hasUrl = urls[name];
        const uptime = info.uptime ? formatUptime(info.uptime) : '-';

        return \`
          <div class="service-card">
            <div class="service-header">
              <div class="service-name">\${name}</div>
              <div class="service-status \${statusClass}">\${statusText}</div>
            </div>
            <div class="service-info">
              <div>PID: \${info.pid || '-'}</div>
              <div>运行时间: \${uptime}</div>
              \${info.error ? \`<div style="color: #dc3545;">错误: \${info.error}</div>\` : ''}
            </div>
            <div class="service-actions">
              <button class="btn-start" 
                onclick="startService('\${name}')"
                \${info.state === 'running' ? 'disabled' : ''}>
                启动
              </button>
              <button class="btn-stop" 
                onclick="stopService('\${name}')"
                \${info.state !== 'running' ? 'disabled' : ''}>
                停止
              </button>
              \${hasUrl ? \`
                <button class="btn-open" onclick="openUrl('\${hasUrl}')">
                  打开
                </button>
              \` : ''}
            </div>
          </div>
        \`;
      }).join('');
    }

    function formatUptime(seconds) {
      if (seconds < 60) return seconds + 's';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
      return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
    }

    async function startService(name) {
      try {
        await fetch(\`/api/start/\${name}\`, { method: 'POST' });
        setTimeout(loadStatus, 1000);
      } catch (err) {
        alert('启动失败: ' + err.message);
      }
    }

    async function stopService(name) {
      try {
        await fetch(\`/api/stop/\${name}\`, { method: 'POST' });
        setTimeout(loadStatus, 1000);
      } catch (err) {
        alert('停止失败: ' + err.message);
      }
    }

    async function stopAll() {
      if (!confirm('确定要停止所有服务吗？')) return;
      try {
        await fetch('/api/stopall', { method: 'POST' });
        setTimeout(loadStatus, 1000);
      } catch (err) {
        alert('停止失败: ' + err.message);
      }
    }

    function openUrl(url) {
      window.open(url, '_blank');
    }

    // 初始加载
    loadStatus();
    
    // 自动刷新
    setInterval(loadStatus, 3000);
  </script>
</body>
</html>`;
  }

  /**
   * 停止 Web 服务器
   */
  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

/**
 * 便捷函数：创建并启动 Web UI
 */
export async function serveWebUi(manager, options = {}) {
  const ui = new WebUiInterface(manager, options);
  await ui.start();
  return ui;
}
