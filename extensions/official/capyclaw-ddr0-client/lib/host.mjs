/**
 * dsh-ddr0-client 插件宿主
 * 
 * 功能：
 * - 托管 ddr0.com 单文件前端
 * - 代理 API 请求到 ddr0.com
 * - 同步登录态到 tempkey 插件
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';
import { resolveConfig } from '@capyclaw/plugin-kit/config';
import { request as httpRequest } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const name = '@capyclaw/ddr0-client';

export async function apply(ctx, config) {
  const { value: cfg } = resolveConfig(config, {
    envPrefix: 'DSH_DDR0',
    defaults: { port: 39620, backendUrl: 'https://ddr0.com' },
    fields: {
      port: { env: 'PORT', type: 'port' },
      backendUrl: { env: 'BACKEND_URL', type: 'url' },
    },
  });
  const port = cfg.port;
  const backendUrl = cfg.backendUrl;
  
  let server;
  
  ctx.logger.info(`ddr0 客户端插件正在初始化，端口: ${port}`);
  
  ctx.on('ready', async () => {
    ctx.logger.info('ddr0 客户端: 收到 ready 事件');
    const indexPath = join(__dirname, '..', 'static', 'index.html');
    let indexHtml;
    
    try {
      indexHtml = await readFile(indexPath, 'utf8');
      ctx.logger.info(`ddr0 客户端: 已加载前端文件 (${indexHtml.length} 字节)`);
    } catch (err) {
      ctx.logger.error(`无法加载 ddr0 前端: ${err.message}`);
      return;
    }
    
    server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      
      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Token');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }
      
      // 首页：返回 ddr0 单文件 HTML
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.writeHead(200);
        res.end(indexHtml);
        return;
      }
      
      // API 代理：转发到 ddr0.com
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/config.json')) {
        try {
          const targetUrl = `${backendUrl}${url.pathname}${url.search}`;
          
          // 转发请求头
          const headers = {};
          if (req.headers.cookie) headers.Cookie = req.headers.cookie;
          if (req.headers['x-session-token']) headers['X-Session-Token'] = req.headers['x-session-token'];
          if (req.headers.authorization) headers.Authorization = req.headers.authorization;
          
          // 读取请求体
          let body = '';
          if (req.method === 'POST' || req.method === 'PUT') {
            body = await new Promise((resolve, reject) => {
              let data = '';
              req.on('data', chunk => data += chunk);
              req.on('end', () => resolve(data));
              req.on('error', reject);
            });
            headers['Content-Type'] = req.headers['content-type'] || 'application/json';
            headers['Content-Length'] = Buffer.byteLength(body);
          }
          
          // 发送请求到后端
          const urlObj = new URL(targetUrl);
          const isHttps = urlObj.protocol === 'https:';
          const requestFn = isHttps ? httpsRequest : httpRequest;
          
          const backendReq = requestFn(targetUrl, {
            method: req.method,
            headers,
          }, (backendRes) => {
            // 转发响应头
            Object.entries(backendRes.headers).forEach(([key, value]) => {
              if (key.toLowerCase() !== 'content-encoding') {
                res.setHeader(key, value);
              }
            });
            
            res.writeHead(backendRes.statusCode);
            backendRes.pipe(res);
          });
          
          backendReq.on('error', (err) => {
            ctx.logger.error(`代理请求失败: ${err.message}`);
            res.writeHead(502);
            res.end(JSON.stringify({ error: 'Backend request failed' }));
          });
          
          if (body) {
            backendReq.write(body);
          }
          
          backendReq.end();
          
        } catch (err) {
          ctx.logger.error(`API 代理错误: ${err.message}`);
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
      
      // 其他路径：404
      res.writeHead(404);
      res.end('Not found');
    });
    
    server.listen(port, '127.0.0.1', () => {
      ctx.logger.info(`ddr0 客户端已启动: http://localhost:${port}/`);
    });
  });
  
  ctx.on('dispose', () => {
    if (server) {
      server.close();
      ctx.logger.info('ddr0 客户端已停止');
    }
  });
}
