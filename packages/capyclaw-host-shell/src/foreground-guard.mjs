/* 前台运行守卫：强制程序必须在可见终端窗口中运行
 * 
 * 设计原则：终端窗口的生命周期 = 程序的生命周期
 * 
 * 这个守卫会：
 * 1. 检测是否在真实的交互式终端中运行（不是后台/服务/管道）
 * 2. 检测父进程是否是终端（cmd.exe, bash, powershell 等）
 * 3. 拒绝后台运行、daemon 模式、nohup 等方式
 * 4. 确保用户可以看到运行状态并通过关闭窗口停止服务
 */
import process from 'node:process';
import { execSync } from 'node:child_process';

const ALLOWED_PARENTS = [
  'cmd.exe',           // Windows Command Prompt
  'powershell.exe',    // PowerShell
  'pwsh.exe',          // PowerShell Core
  'WindowsTerminal.exe', // Windows Terminal
  'ConEmu64.exe',      // ConEmu
  'mintty.exe',        // Git Bash / MinGW
  'bash.exe',          // Git Bash
  'node.exe',          // Node.js (when started from terminal via wrapper script)
];

export class ForegroundGuard {
  constructor(options = {}) {
    this.strict = options.strict !== false; // 默认严格模式
    this.allowCI = options.allowCI === true; // CI 环境例外
    this.serviceName = options.serviceName || 'Service';
  }

  /**
   * 检查是否在 CI 环境中
   */
  isCI() {
    return !!(
      process.env.CI ||
      process.env.GITHUB_ACTIONS ||
      process.env.GITLAB_CI ||
      process.env.JENKINS_HOME ||
      process.env.TRAVIS
    );
  }

  /**
   * 检查是否在交互式终端中
   */
  isInteractiveTTY() {
    // stdout 和 stderr 都必须是 TTY
    return process.stdout.isTTY && process.stderr.isTTY;
  }

  /**
   * 获取父进程名称 (Windows)
   */
  getParentProcessName() {
    try {
      const ppid = process.ppid;
      if (!ppid) return null;

      // 使用 wmic 获取父进程名称
      const cmd = `wmic process where "ProcessId=${ppid}" get Name /value`;
      const output = execSync(cmd, { 
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 2000,
      });
      
      const match = output.match(/Name=([^\r\n]+)/);
      return match ? match[1].trim() : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 检查父进程是否是允许的终端
   */
  isParentTerminal() {
    const parentName = this.getParentProcessName();
    if (!parentName) return false;

    // 如果父进程是 node.exe，检查祖父进程
    if (parentName.toLowerCase() === 'node.exe') {
      return this.checkGrandparentTerminal();
    }

    return ALLOWED_PARENTS.some(allowed => 
      parentName.toLowerCase() === allowed.toLowerCase()
    );
  }

  /**
   * 检查祖父进程（当父进程是 node.exe 时）
   */
  checkGrandparentTerminal() {
    try {
      const ppid = process.ppid;
      if (!ppid) return false;

      // 获取父进程的父进程ID
      const cmd = `wmic process where "ProcessId=${ppid}" get ParentProcessId /value`;
      const output = execSync(cmd, { 
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 2000,
      });
      
      const match = output.match(/ParentProcessId=([^\r\n]+)/);
      if (!match) return false;
      
      const gppid = parseInt(match[1].trim());
      if (!gppid) return false;

      // 获取祖父进程名称
      const cmd2 = `wmic process where "ProcessId=${gppid}" get Name /value`;
      const output2 = execSync(cmd2, { 
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 2000,
      });
      
      const match2 = output2.match(/Name=([^\r\n]+)/);
      const grandparentName = match2 ? match2[1].trim() : null;
      
      if (!grandparentName) return false;

      // 检查祖父进程是否是终端
      return ALLOWED_PARENTS.some(allowed => 
        grandparentName.toLowerCase() === allowed.toLowerCase() && 
        allowed.toLowerCase() !== 'node.exe'  // 祖父进程不能是 node.exe
      );
    } catch (e) {
      return false;
    }
  }

  /**
   * 检查是否在后台运行
   */
  isBackgroundProcess() {
    // 检查常见的后台运行标记
    if (process.env.DETACHED === '1') return true;
    if (process.env.DAEMON === '1') return true;
    if (process.env.PM2_HOME) return true; // PM2 进程管理器
    
    return false;
  }

  /**
   * 执行守卫检查
   * @returns {Object} { allowed: boolean, reason: string }
   */
  check() {
    // CI 环境例外
    if (this.allowCI && this.isCI()) {
      return { allowed: true, reason: 'CI environment' };
    }

    // 检查后台运行标记
    if (this.isBackgroundProcess()) {
      return {
        allowed: false,
        reason: '检测到后台运行模式（DETACHED/DAEMON/PM2）',
        suggestion: `请使用可见终端窗口启动 ${this.serviceName}`,
      };
    }

    // 检查是否是交互式 TTY
    if (!this.isInteractiveTTY()) {
      return {
        allowed: false,
        reason: '未检测到交互式终端（stdout/stderr 不是 TTY）',
        suggestion: `请在真实的终端窗口中运行，不要重定向输出或使用管道`,
      };
    }

    // 检查父进程
    const parentName = this.getParentProcessName();
    if (!this.isParentTerminal()) {
      return {
        allowed: false,
        reason: `父进程不是终端程序（当前父进程: ${parentName || '未知'}）`,
        suggestion: `请通过双击 .cmd 文件或在终端中直接运行`,
        parentProcess: parentName,
      };
    }

    return { 
      allowed: true, 
      reason: 'Running in foreground terminal',
      parentProcess: parentName,
    };
  }

  /**
   * 强制执行守卫（不通过则退出进程）
   */
  enforce() {
    const result = this.check();

    if (!result.allowed) {
      console.error('\n==========================================================');
      console.error(`❌ ${this.serviceName} 前台运行守卫：启动被拒绝`);
      console.error('==========================================================\n');
      console.error(`原因: ${result.reason}`);
      if (result.suggestion) {
        console.error(`建议: ${result.suggestion}`);
      }
      console.error('\n设计原则：');
      console.error('  终端窗口的生命周期 = 程序的生命周期');
      console.error('  - 终端窗口打开 → 服务运行');
      console.error('  - 终端窗口关闭 → 服务停止');
      console.error('\n这确保了：');
      console.error('  ✓ 用户可以直观看到服务运行状态');
      console.error('  ✓ 可以通过日志了解服务行为');
      console.error('  ✓ 可以通过关闭窗口停止服务');
      console.error('  ✓ 避免孤儿进程占用资源');
      console.error('\n==========================================================\n');
      
      if (this.strict) {
        process.exit(1);
      }
      return false;
    }

    console.log(`✓ 前台运行守卫检查通过 (父进程: ${result.parentProcess})`);
    return true;
  }

  /**
   * 设置终端窗口标题
   */
  setTerminalTitle(title) {
    if (process.platform === 'win32') {
      process.stdout.write(`\x1b]0;${title}\x07`);
    }
  }

  /**
   * 监听进程信号，确保清理
   */
  setupCleanupHandlers(cleanupFn) {
    const cleanup = async () => {
      console.log('\n正在停止服务...');
      try {
        if (cleanupFn) await cleanupFn();
        console.log('服务已停止');
      } catch (e) {
        console.error('清理失败:', e.message);
      }
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGHUP', cleanup);
    
    // Windows 特殊处理
    if (process.platform === 'win32') {
      // Ctrl+C
      process.on('SIGBREAK', cleanup);
    }
  }
}

/**
 * 便捷函数：创建并执行守卫
 */
export function enforceRunInForeground(options = {}) {
  const guard = new ForegroundGuard(options);
  return guard.enforce();
}

export default ForegroundGuard;
