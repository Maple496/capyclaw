#!/usr/bin/env node
/**
 * Session Token 代理服务
 * 
 * 功能：从 localhost:39620 的 Cookie 中提取 session token
 * 供 dsh-llm-tempkey 插件使用
 */
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';

const PORT = 3310;
const DDR0_CLIENT_URL = 'http://localhost:39620';

// 存储最近的 token（从 ddr0 客户端的请求中提取）
let cachedToken = null;
let lastUpdateTime = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Session token endpoint
  if (url.pathname === '/api/desktop/account/session-token') {
    // 尝试从请求 Cookie 中获取 token
    const cookies = req.headers.cookie || '';
    const sessionMatch = cookies.match(/sessionid=([^;]+)/);
    
    if (sessionMatch) {
      cachedToken = sessionMatch[1];
      lastUpdateTime = Date.now();
    }
    
    // 返回 token
    const response = {
      logged_in: !!cachedToken,
      token: cachedToken || '',
      token_name: 'sessionid',
      username: cachedToken ? 'user' : '',
    };
    
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(response));
    return;
  }
  
  // 404
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('='.repeat(60));
  console.log(`🔑 Session Token 代理已启动: http://localhost:${PORT}/`);
  console.log('='.repeat(60));
  console.log();
  console.log('功能：');
  console.log('  - 从 Cookie 中提取 session token');
  console.log('  - 供 tempkey 插件使用');
  console.log();
  console.log('端点：');
  console.log('  GET /api/desktop/account/session-token');
  console.log();
  console.log('按 Ctrl+C 停止服务');
  console.log('='.repeat(60));
});
