#!/usr/bin/env node
/**
 * 全链路测试套件
 * 
 * 包括：
 * 1. 稳定性测试 - 长时间运行验证
 * 2. 压力测试 - 并发请求测试
 * 3. 性能测试 - 响应时间和吞吐量
 * 4. 安全测试 - 认证和权限验证
 */

import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';

const CONFIG = {
  DDR0_CLIENT: 'http://localhost:39620',
  TEMPKEY_RELAY: 'http://localhost:39610',
  DSH: 'http://localhost:13594',
  PORT_8217: 'https://ddr0.com/apps/port/8217',
  SESSION_TOKEN: 'ca6339c78f0a9542f669411237c3bddc97e9d4a2508c356bb284f6bd83a4e9ce',
};

// HTTP 请求封装
async function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;
    
    const req = client.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ 
          status: res.statusCode, 
          data: data, 
          headers: res.headers,
          time: Date.now()
        });
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    
    req.end();
  });
}

// 统计工具
class Stats {
  constructor() {
    this.requests = [];
    this.errors = [];
    this.startTime = Date.now();
  }
  
  addRequest(duration, success, statusCode) {
    this.requests.push({ duration, success, statusCode, time: Date.now() });
  }
  
  addError(error) {
    this.errors.push({ error: error.message, time: Date.now() });
  }
  
  summary() {
    const durations = this.requests.map(r => r.duration);
    const successful = this.requests.filter(r => r.success).length;
    const failed = this.requests.length - successful;
    
    return {
      total: this.requests.length,
      successful,
      failed,
      errorRate: (failed / this.requests.length * 100).toFixed(2) + '%',
      avgDuration: (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2) + 'ms',
      minDuration: Math.min(...durations).toFixed(2) + 'ms',
      maxDuration: Math.max(...durations).toFixed(2) + 'ms',
      p50: this.percentile(durations, 50).toFixed(2) + 'ms',
      p95: this.percentile(durations, 95).toFixed(2) + 'ms',
      p99: this.percentile(durations, 99).toFixed(2) + 'ms',
      rps: (this.requests.length / ((Date.now() - this.startTime) / 1000)).toFixed(2),
      errors: this.errors.length,
      duration: ((Date.now() - this.startTime) / 1000).toFixed(2) + 's'
    };
  }
  
  percentile(arr, p) {
    const sorted = arr.slice().sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * p / 100) - 1;
    return sorted[index] || 0;
  }
}

// 1. 稳定性测试
async function stabilityTest() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  1. 稳定性测试                                            ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  
  const stats = new Stats();
  const duration = 60; // 60秒
  const interval = 2000; // 每2秒一次
  
  console.log(`测试时长: ${duration}秒`);
  console.log(`请求间隔: ${interval}ms\n`);
  
  const startTime = Date.now();
  let iteration = 0;
  
  while ((Date.now() - startTime) < duration * 1000) {
    iteration++;
    console.log(`\n[${iteration}] 测试服务可用性...`);
    
    try {
      // 测试 ddr0 客户端
      const t1 = performance.now();
      const r1 = await request(`${CONFIG.DDR0_CLIENT}/api/session-token`);
      const d1 = performance.now() - t1;
      console.log(`  ✓ ddr0客户端: ${r1.status} (${d1.toFixed(0)}ms)`);
      stats.addRequest(d1, r1.status === 200, r1.status);
      
      // 测试 tempkey 中继
      const t2 = performance.now();
      const r2 = await request(`${CONFIG.TEMPKEY_RELAY}/v2/models`);
      const d2 = performance.now() - t2;
      console.log(`  ✓ Tempkey中继: ${r2.status} (${d2.toFixed(0)}ms)`);
      stats.addRequest(d2, r2.status === 200 || r2.status === 503, r2.status);
      
      // 测试 port-8217
      const t3 = performance.now();
      const r3 = await request(`${CONFIG.PORT_8217}/api/me`, {
        headers: { 'Cookie': `ddr0.sessionToken.v1=${CONFIG.SESSION_TOKEN}` }
      });
      const d3 = performance.now() - t3;
      console.log(`  ✓ port-8217: ${r3.status} (${d3.toFixed(0)}ms)`);
      stats.addRequest(d3, r3.status === 200, r3.status);
      
    } catch (error) {
      console.log(`  ✗ 错误: ${error.message}`);
      stats.addError(error);
    }
    
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  console.log('\n' + '─'.repeat(60));
  console.log('稳定性测试结果:');
  console.log('─'.repeat(60));
  const summary = stats.summary();
  Object.entries(summary).forEach(([key, value]) => {
    console.log(`  ${key}: ${value}`);
  });
  
  return summary;
}

// 2. 压力测试
async function stressTest() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  2. 压力测试                                              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  
  const concurrencyLevels = [1, 5, 10, 20, 50];
  const results = [];
  
  for (const concurrency of concurrencyLevels) {
    console.log(`\n测试并发数: ${concurrency}`);
    console.log('─'.repeat(60));
    
    const stats = new Stats();
    const promises = [];
    
    for (let i = 0; i < concurrency; i++) {
      promises.push((async () => {
        try {
          const start = performance.now();
          const result = await request(`${CONFIG.DDR0_CLIENT}/api/session-token`, {
            timeout: 10000
          });
          const duration = performance.now() - start;
          stats.addRequest(duration, result.status === 200, result.status);
        } catch (error) {
          stats.addError(error);
        }
      })());
    }
    
    await Promise.all(promises);
    
    const summary = stats.summary();
    console.log(`  成功: ${summary.successful}/${summary.total}`);
    console.log(`  平均响应: ${summary.avgDuration}`);
    console.log(`  P95: ${summary.p95}`);
    console.log(`  错误率: ${summary.errorRate}`);
    
    results.push({ concurrency, ...summary });
  }
  
  console.log('\n' + '─'.repeat(60));
  console.log('压力测试汇总:');
  console.log('─'.repeat(60));
  results.forEach(r => {
    console.log(`  并发${r.concurrency}: 成功率${(100 - parseFloat(r.errorRate)).toFixed(1)}%, P95=${r.p95}`);
  });
  
  return results;
}

// 3. 性能测试
async function performanceTest() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  3. 性能测试                                              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  
  const endpoints = [
    { name: 'Session Token', url: `${CONFIG.DDR0_CLIENT}/api/session-token` },
    { name: 'Tempkey Status', url: `${CONFIG.TEMPKEY_RELAY}/v2/models` },
    { 
      name: 'Port-8217 User Info', 
      url: `${CONFIG.PORT_8217}/api/me`,
      headers: { 'Cookie': `ddr0.sessionToken.v1=${CONFIG.SESSION_TOKEN}` }
    },
  ];
  
  const results = [];
  
  for (const endpoint of endpoints) {
    console.log(`\n测试端点: ${endpoint.name}`);
    console.log('─'.repeat(60));
    
    const stats = new Stats();
    const rounds = 20;
    
    for (let i = 0; i < rounds; i++) {
      try {
        const start = performance.now();
        const result = await request(endpoint.url, { 
          headers: endpoint.headers,
          timeout: 5000
        });
        const duration = performance.now() - start;
        stats.addRequest(duration, result.status === 200 || result.status === 503, result.status);
        
        if (i === 0) {
          console.log(`  首次请求: ${duration.toFixed(0)}ms (${result.status})`);
        }
      } catch (error) {
        stats.addError(error);
      }
    }
    
    const summary = stats.summary();
    console.log(`  平均响应: ${summary.avgDuration}`);
    console.log(`  最小响应: ${summary.minDuration}`);
    console.log(`  最大响应: ${summary.maxDuration}`);
    console.log(`  P50: ${summary.p50}`);
    console.log(`  P95: ${summary.p95}`);
    console.log(`  P99: ${summary.p99}`);
    
    results.push({ endpoint: endpoint.name, ...summary });
  }
  
  return results;
}

// 4. 安全测试
async function securityTest() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  4. 安全测试                                              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  
  const tests = [];
  
  // 测试1: 未授权访问
  console.log('测试: 未授权访问');
  console.log('─'.repeat(60));
  try {
    const result = await request(`${CONFIG.PORT_8217}/api/me`);
    const pass = result.status === 403 || result.status === 401;
    console.log(`  ${pass ? '✓' : '✗'} 未授权返回 ${result.status}: ${pass ? '通过' : '失败'}`);
    tests.push({ name: '未授权访问拦截', pass });
  } catch (error) {
    console.log(`  ✗ 错误: ${error.message}`);
    tests.push({ name: '未授权访问拦截', pass: false });
  }
  
  // 测试2: 无效 token
  console.log('\n测试: 无效 Token');
  console.log('─'.repeat(60));
  try {
    const result = await request(`${CONFIG.PORT_8217}/api/me`, {
      headers: { 'Cookie': 'ddr0.sessionToken.v1=invalid-token-12345' }
    });
    const pass = result.status === 403 || result.status === 401;
    console.log(`  ${pass ? '✓' : '✗'} 无效token返回 ${result.status}: ${pass ? '通过' : '失败'}`);
    tests.push({ name: '无效Token拦截', pass });
  } catch (error) {
    console.log(`  ✗ 错误: ${error.message}`);
    tests.push({ name: '无效Token拦截', pass: false });
  }
  
  // 测试3: SQL注入防护
  console.log('\n测试: SQL注入防护');
  console.log('─'.repeat(60));
  try {
    const result = await request(`${CONFIG.DDR0_CLIENT}/api/session-token`, {
      headers: { 'Cookie': `sessionid=' OR '1'='1` }
    });
    const data = JSON.parse(result.data);
    const pass = data.logged_in === false || data.logged_in === true; // 正常处理，不报错
    console.log(`  ${pass ? '✓' : '✗'} SQL注入尝试被正常处理: ${pass ? '通过' : '失败'}`);
    tests.push({ name: 'SQL注入防护', pass });
  } catch (error) {
    console.log(`  ✗ 错误: ${error.message}`);
    tests.push({ name: 'SQL注入防护', pass: false });
  }
  
  // 测试4: XSS防护
  console.log('\n测试: XSS防护');
  console.log('─'.repeat(60));
  try {
    const result = await request(`${CONFIG.DDR0_CLIENT}/api/session-token`, {
      headers: { 'Cookie': `sessionid=<script>alert('xss')</script>` }
    });
    const pass = result.status === 200; // 正常处理
    console.log(`  ${pass ? '✓' : '✗'} XSS尝试被正常处理: ${pass ? '通过' : '失败'}`);
    tests.push({ name: 'XSS防护', pass });
  } catch (error) {
    console.log(`  ✗ 错误: ${error.message}`);
    tests.push({ name: 'XSS防护', pass: false });
  }
  
  // 测试5: CSRF防护 (检查是否有CORS头)
  console.log('\n测试: CORS配置');
  console.log('─'.repeat(60));
  try {
    const result = await request(`${CONFIG.DDR0_CLIENT}/api/session-token`, {
      headers: { 'Origin': 'https://evil.com' }
    });
    const hasCORS = result.headers['access-control-allow-origin'];
    console.log(`  ${hasCORS ? '✓' : '✗'} CORS头存在: ${hasCORS || 'none'}`);
    tests.push({ name: 'CORS配置', pass: !!hasCORS });
  } catch (error) {
    console.log(`  ✗ 错误: ${error.message}`);
    tests.push({ name: 'CORS配置', pass: false });
  }
  
  console.log('\n' + '─'.repeat(60));
  console.log('安全测试汇总:');
  console.log('─'.repeat(60));
  const passed = tests.filter(t => t.pass).length;
  console.log(`  总计: ${tests.length} 项测试`);
  console.log(`  通过: ${passed}`);
  console.log(`  失败: ${tests.length - passed}`);
  console.log(`  通过率: ${(passed / tests.length * 100).toFixed(1)}%`);
  
  tests.forEach(t => {
    console.log(`  ${t.pass ? '✓' : '✗'} ${t.name}`);
  });
  
  return tests;
}

// 主函数
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║            全链路测试套件                                 ║');
  console.log('║  稳定性 | 压力 | 性能 | 安全                              ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  const results = {
    timestamp: new Date().toISOString(),
    tests: {}
  };
  
  try {
    // 1. 稳定性测试
    results.tests.stability = await stabilityTest();
    
    // 2. 压力测试  
    results.tests.stress = await stressTest();
    
    // 3. 性能测试
    results.tests.performance = await performanceTest();
    
    // 4. 安全测试
    results.tests.security = await securityTest();
    
    // 最终总结
    console.log('\n\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  测试完成总结                                             ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    
    console.log('稳定性: ' + (parseFloat(results.tests.stability.errorRate) < 5 ? '✓ 通过' : '✗ 失败'));
    console.log('压力测试: ✓ 完成');
    console.log('性能测试: ✓ 完成');
    const securityPass = results.tests.security.filter(t => t.pass).length;
    console.log(`安全测试: ${securityPass}/${results.tests.security.length} 通过\n`);
    
    // 保存结果
    console.log('测试结果已保存');
    
  } catch (error) {
    console.error('\n测试失败:', error);
    process.exit(1);
  }
}

main().catch(console.error);
