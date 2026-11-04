#!/usr/bin/env node
/**
 * ddr0 客户端 - 独立服务版本
 * 
 * 不依赖 DSH 插件系统，直接作为独立 HTTP 服务启动
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 39620;
const BACKEND_URL = 'https://ddr0.com';

// 缓存最后看到的 session token
let cachedSessionToken = null;
let lastSeenTime = 0;

let indexHtml;

async function main() {
  // 加载前端文件
  const indexPath = join(__dirname, 'static', 'index.html');
  try {
    indexHtml = await readFile(indexPath, 'utf8');
    console.log(`✓ 已加载 ddr0 前端 (${indexHtml.length} 字节)`);
  } catch (err) {
    console.error(`❌ 无法加载前端文件: ${err.message}`);
    process.exit(1);
  }

  // 创建 HTTP 服务器
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Token, Cookie');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    // 首页：返回 ddr0 前端
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(indexHtml);
      return;
    }
    
    // Session token endpoint for tempkey plugin
    if (url.pathname === '/api/session-token') {
      // 优先使用缓存的 token（来自浏览器的请求）
      // 如果 5 分钟内有更新，就使用缓存的
      const now = Date.now();
      const cacheValid = cachedSessionToken && (now - lastSeenTime < 300000);
      
      const response = {
        logged_in: !!cacheValid,
        token: cacheValid ? cachedSessionToken : '',
        token_name: 'ddr0.sessionToken.v1',  // 修正：使用 port-8217 期望的名称
        username: cacheValid ? 'user' : '',
      };
      
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(response));
      return;
    }
    
    // Session sync endpoint - 前端调用来更新缓存
    if (url.pathname === '/api/sync-session' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.sessionid) {
            cachedSessionToken = data.sessionid;
            lastSeenTime = Date.now();
            console.log('✓ Session token 已更新:', cachedSessionToken.substring(0, 20) + '...');
          }
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }
    
      // API 代理：转发到 ddr0.com
      // 检测并缓存登录请求的 session token
      if (req.headers.cookie) {
        const cookies = req.headers.cookie;
        const sessionMatch = cookies.match(/sessionid=([^;]+)/);
        if (sessionMatch) {
          cachedSessionToken = sessionMatch[1];
          lastSeenTime = Date.now();
        }
      }
    // 包括 /api/*, /config.json, /interact/*, /static/* 等
    if (
      url.pathname.startsWith('/api/') || 
      url.pathname.startsWith('/config.json') ||
      url.pathname.startsWith('/interact/') ||
      url.pathname.startsWith('/static/') ||
      url.pathname === '/config.json'
    ) {
      try {
        const targetUrl = `${BACKEND_URL}${url.pathname}${url.search}`;
        
        // 转发请求头（包括 Cookie）
        const headers = {};
        if (req.headers.cookie) headers.Cookie = req.headers.cookie;
        if (req.headers['x-session-token']) headers['X-Session-Token'] = req.headers['x-session-token'];
        if (req.headers['x-requested-with']) headers['X-Requested-With'] = req.headers['x-requested-with'];
        if (req.headers.authorization) headers.Authorization = req.headers.authorization;
        if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
        if (req.headers.referer) headers.Referer = req.headers.referer;
        if (req.headers['user-agent']) headers['User-Agent'] = req.headers['user-agent'];
        
        // 如果前端没有发送 X-Requested-With，我们手动添加
        if (!headers['X-Requested-With']) {
          headers['X-Requested-With'] = 'XMLHttpRequest';
        }
        
        // 读取请求体
        let body = '';
        if (req.method === 'POST' || req.method === 'PUT') {
          body = await new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => resolve(data));
            req.on('error', reject);
          });
          if (body) {
            headers['Content-Length'] = Buffer.byteLength(body);
          }
        }
        
        // 发送到后端
        const urlObj = new URL(targetUrl);
        const isHttps = urlObj.protocol === 'https:';
        const requestFn = isHttps ? httpsRequest : httpRequest;
        
        const backendReq = requestFn(targetUrl, {
          method: req.method,
          headers,
        }, (backendRes) => {
          // 转发响应头（包括 Set-Cookie）
          Object.entries(backendRes.headers).forEach(([key, value]) => {
            if (key.toLowerCase() !== 'content-encoding') {
              res.setHeader(key, value);
            }
          });
          
          res.writeHead(backendRes.statusCode);
          backendRes.pipe(res);
        });
        
        backendReq.on('error', (err) => {
          console.error(`代理请求失败: ${err.message}`);
          res.writeHead(502);
          res.end(JSON.stringify({ error: 'Backend request failed' }));
        });
        
        if (body) {
          backendReq.write(body);
        }
        
        backendReq.end();
        
      } catch (err) {
        console.error(`API 代理错误: ${err.message}`);
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    
    // 其他路径：404
    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log('='.repeat(60));
    console.log(`🌐 ddr0 客户端已启动: http://localhost:${PORT}/`);
    console.log('='.repeat(60));
    console.log();
    console.log('功能：');
    console.log('  - 本地访问 ddr0 前端');
    console.log('  - API 请求代理到 ddr0.com');
    console.log('  - 登录态保存在本地浏览器');
    console.log();
    console.log('使用：');
    console.log('  1. 打开 http://localhost:39620/');
    console.log('  2. 登录你的 ddr0 账号');
    console.log('  3. 登录态自动保存在本地');
    console.log('  4. tempkey 插件会自动检测并获取临时 key');
    console.log();
    console.log('按 Ctrl+C 停止服务');
    console.log('='.repeat(60));
  });
}

main().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
