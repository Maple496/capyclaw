/**
 * 前台进程管理器 - 大道至简版
 * 
 * 核心原则：终端窗口的生命周期 = 所有服务的生命周期
 * 
 * 设计：
 * - 所有子进程 detached: false（不分离）
 * - 终端关闭 → 操作系统自动清理整个进程树
 * - 没有状态文件、没有 PID 追踪、没有复杂的清理逻辑
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export class ForegroundServiceManager {
  constructor(options = {}) {
    this.services = [];
    this.logDir = options.logDir || './logs';
    this.showLogs = options.showLogs !== false;
    this.setupCleanup();
    
    mkdirSync(this.logDir, { recursive: true });
  }

  /**
   * 启动一个服务（前台模式）
   */
  start(name, command, args, options = {}) {
    const logFile = path.join(this.logDir, `${name}.log`);
    const logStream = createWriteStream(logFile, { flags: 'a' });
    
    console.log(`[dshd] 启动 ${name}...`);
    
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: [
        'ignore',           // stdin
        logStream,          // stdout → 日志文件
        logStream,          // stderr → 日志文件
      ],
      detached: false,      // ✅ 不分离！
      windowsHide: false,   // ✅ 不隐藏！
    });

    if (!child.pid) {
      throw new Error(`启动 ${name} 失败`);
    }

    // 可选：实时显示日志
    if (this.showLogs) {
      this.tailLog(name, logFile);
    }

    child.on('exit', (code, signal) => {
      const reason = signal ? `信号 ${signal}` : `代码 ${code}`;
      console.log(`[dshd] ${name} 退出 (${reason})`);
      logStream.end();
    });

    child.on('error', (err) => {
      console.error(`[dshd] ${name} 错误:`, err.message);
    });

    this.services.push({ name, child, logStream, logFile });
    
    console.log(`[dshd] ✓ ${name} 已启动 (PID ${child.pid})`);
    
    return child;
  }

  /**
   * 实时显示日志（可选）
   */
  tailLog(name, logFile) {
    // 简单实现：定期读取日志末尾
    const tail = spawn('tail', ['-f', logFile], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: false,
    });

    tail.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      lines.forEach(line => {
        if (line) console.log(`  [${name}] ${line}`);
      });
    });

    tail.on('error', () => {
      // tail 不可用时静默失败
    });
  }

  /**
   * 设置清理处理 - 极简版
   */
  setupCleanup() {
    const cleanup = (signal) => {
      console.log(`\n[dshd] 收到信号 ${signal}，正在停止所有服务...`);
      
      // 关闭所有日志流
      this.services.forEach(({ logStream }) => {
        try {
          logStream.end();
        } catch (e) {}
      });

      // 不需要手动 kill！
      // 因为 detached: false，操作系统会自动清理子进程
      
      console.log('[dshd] 所有服务已停止');
      process.exit(0);
    };

    // 捕获所有退出信号
    process.on('SIGINT', () => cleanup('SIGINT'));    // Ctrl+C
    process.on('SIGTERM', () => cleanup('SIGTERM'));  // kill
    process.on('SIGHUP', () => cleanup('SIGHUP'));    // 终端关闭
    
    if (process.platform === 'win32') {
      process.on('SIGBREAK', () => cleanup('SIGBREAK'));
    }
  }

  /**
   * 等待所有服务
   */
  async waitAll() {
    if (this.services.length === 0) {
      throw new Error('没有运行中的服务');
    }

    console.log('[dshd] 所有服务已启动，按 Ctrl+C 停止');
    
    // 等待任一服务退出
    await Promise.race(
      this.services.map(({ name, child }) =>
        new Promise((resolve) => {
          child.on('exit', () => resolve(name));
        })
      )
    );
  }
}
