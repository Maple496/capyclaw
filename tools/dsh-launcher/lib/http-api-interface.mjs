/**
 * HTTP API 接口实现 - ServiceManager 的另一个视图
 * 
 * 展示如何用不同的接口控制同一个管理器
 */
import { createServer } from 'node:http';

export class HttpApiInterface {
  constructor(manager, port = 9000) {
    this.manager = manager;
    this.port = port;
    this.server = null;
  }

  /**
   * 启动 HTTP API 服务器
   */
  start() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${this.port}`);
      
      res.setHeader('Content-Type', 'application/json');
      
      // 路由
      if (url.pathname === '/status' && req.method === 'GET') {
        // 获取所有服务状态
        const status = this.manager.getStatus();
        res.writeHead(200);
        res.end(JSON.stringify(status, null, 2));
        
      } else if (url.pathname === '/status/:name' && req.method === 'GET') {
        // 获取单个服务状态
        const name = url.pathname.split('/')[2];
        const status = this.manager.getServiceStatus(name);
        
        if (status) {
          res.writeHead(200);
          res.end(JSON.stringify(status, null, 2));
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Service not found' }));
        }
        
      } else if (url.pathname === '/start/:name' && req.method === 'POST') {
        // 启动服务
        const name = url.pathname.split('/')[2];
        
        this.manager.start(name)
          .then(() => {
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, message: `Started ${name}` }));
          })
          .catch(err => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
          });
          
      } else if (url.pathname === '/stop/:name' && req.method === 'POST') {
        // 停止服务
        const name = url.pathname.split('/')[2];
        
        this.manager.stop(name)
          .then(() => {
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, message: `Stopped ${name}` }));
          })
          .catch(err => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
          });
          
      } else if (url.pathname === '/stop' && req.method === 'POST') {
        // 停止所有服务
        this.manager.stopAll()
          .then(() => {
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, message: 'All services stopped' }));
          })
          .catch(err => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
          });
          
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`📡 HTTP API 已启动: http://localhost:${this.port}/`);
      console.log(`   GET  /status          - 获取所有服务状态`);
      console.log(`   GET  /status/:name    - 获取单个服务状态`);
      console.log(`   POST /start/:name     - 启动服务`);
      console.log(`   POST /stop/:name      - 停止服务`);
      console.log(`   POST /stop            - 停止所有服务`);
      console.log();
    });
  }

  /**
   * 停止 HTTP API 服务器
   */
  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

/**
 * 便捷函数：创建并启动 HTTP API 接口
 */
export function serveHttpApi(manager, port = 9000) {
  const api = new HttpApiInterface(manager, port);
  api.start();
  return api;
}
