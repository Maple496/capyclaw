/**
 * 终端接口实现 - ServiceManager 的一个视图
 * 
 * 职责：
 * - 在终端中显示服务状态
 * - 响应用户输入（Ctrl+C 等）
 * - 将终端生命周期映射到管理器操作
 */
import { ServiceManager } from './service-manager.mjs';

export class TerminalInterface {
  constructor(manager) {
    this.manager = manager;
    this.setupEventHandlers();
    this.setupSignalHandlers();
  }

  /**
   * 监听管理器事件，输出到终端
   */
  setupEventHandlers() {
    this.manager.on('service:registered', ({ name }) => {
      // 静默，不输出
    });

    this.manager.on('service:starting', ({ name }) => {
      console.log(`🔄 启动 ${name}...`);
    });

    this.manager.on('service:started', ({ name, pid }) => {
      console.log(`✓ ${name} 已启动 (PID ${pid})`);
    });

    this.manager.on('service:stopping', ({ name }) => {
      console.log(`🛑 停止 ${name}...`);
    });

    this.manager.on('service:stopped', ({ name, code, signal, expected }) => {
      if (expected) {
        console.log(`✓ ${name} 已停止`);
      } else {
        console.log(`⚠️  ${name} 意外退出 (${signal || `code ${code}`})`);
      }
    });

    this.manager.on('service:error', ({ name, error }) => {
      console.error(`❌ ${name} 错误: ${error.message}`);
    });
  }

  /**
   * 将终端信号映射到管理器操作
   */
  setupSignalHandlers() {
    const cleanup = async (signal) => {
      console.log(`\n收到信号 ${signal}，正在停止所有服务...`);
      
      try {
        await this.manager.stopAll();
        console.log('所有服务已停止');
        process.exit(0);
      } catch (err) {
        console.error('停止服务失败:', err.message);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('SIGTERM', () => cleanup('SIGTERM'));
    process.on('SIGHUP', () => cleanup('SIGHUP'));
    
    if (process.platform === 'win32') {
      process.on('SIGBREAK', () => cleanup('SIGBREAK'));
    }
  }

  /**
   * 显示服务状态表格
   */
  printStatus() {
    const status = this.manager.getStatus();
    
    console.log('\n服务状态：');
    console.log('─'.repeat(60));
    console.log('服务名'.padEnd(20), '状态'.padEnd(12), 'PID'.padEnd(10), '运行时间');
    console.log('─'.repeat(60));
    
    for (const [name, info] of Object.entries(status)) {
      const uptime = info.uptime ? `${info.uptime}s` : '-';
      const pid = info.pid || '-';
      console.log(
        name.padEnd(20),
        info.state.padEnd(12),
        String(pid).padEnd(10),
        uptime
      );
    }
    
    console.log('─'.repeat(60));
    console.log();
  }

  /**
   * 运行交互式会话
   */
  async run() {
    console.log('按 Ctrl+C 停止所有服务\n');
    
    // 定期显示状态（可选）
    const statusInterval = setInterval(() => {
      // this.printStatus();
    }, 10000);

    try {
      // 等待任一服务退出
      const exitedService = await this.manager.wait();
      console.log(`\n⚠️  服务 ${exitedService} 已退出`);
      
      clearInterval(statusInterval);
      
      // 停止其他服务
      await this.manager.stopAll();
      
    } catch (err) {
      clearInterval(statusInterval);
      throw err;
    }
  }
}

/**
 * 便捷函数：创建并运行终端接口
 */
export async function runInTerminal(manager) {
  const terminal = new TerminalInterface(manager);
  await terminal.run();
}
