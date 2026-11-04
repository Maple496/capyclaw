/**
 * 统一服务管理器 - 核心抽象
 * 
 * 设计理念：
 * - 管理器是核心抽象，负责所有服务的生命周期
 * - 终端、GUI、API 等只是不同的"接口实现"
 * - 所有服务统一由管理器控制
 * 
 * 职责：
 * - 启动/停止/重启服务
 * - 查询服务状态
 * - 管理服务依赖关系
 * - 统一日志和错误处理
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * 服务状态枚举
 */
export const ServiceState = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  FAILED: 'failed',
};

/**
 * 服务管理器 - 核心抽象
 */
export class ServiceManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.services = new Map();  // name -> ServiceDescriptor
    this.logDir = options.logDir || './logs';
    
    mkdirSync(this.logDir, { recursive: true });
  }

  /**
   * 注册一个服务（但不启动）
   */
  register(name, config) {
    if (this.services.has(name)) {
      throw new Error(`服务 ${name} 已注册`);
    }

    const descriptor = {
      name,
      command: config.command,
      args: config.args || [],
      cwd: config.cwd || process.cwd(),
      env: config.env || {},
      depends: config.depends || [],  // 依赖的其他服务
      
      // 运行时状态
      state: ServiceState.STOPPED,
      process: null,
      logStream: null,
      startTime: null,
      exitCode: null,
      error: null,
    };

    this.services.set(name, descriptor);
    this.emit('service:registered', { name });
    
    return this;
  }

  /**
   * 启动一个服务
   */
  async start(name) {
    const service = this.services.get(name);
    if (!service) {
      throw new Error(`服务 ${name} 未注册`);
    }

    if (service.state === ServiceState.RUNNING) {
      return; // 已经在运行
    }

    // 检查依赖
    for (const dep of service.depends) {
      const depService = this.services.get(dep);
      if (!depService || depService.state !== ServiceState.RUNNING) {
        throw new Error(`服务 ${name} 依赖 ${dep}，但 ${dep} 未运行`);
      }
    }

    service.state = ServiceState.STARTING;
    this.emit('service:starting', { name });

    try {
      const logFile = path.join(this.logDir, `${name}.log`);
      
      // 创建日志流并等待 'open' 事件
      service.logStream = createWriteStream(logFile, { flags: 'a' });
      
      await new Promise((resolve, reject) => {
        service.logStream.once('open', resolve);
        service.logStream.once('error', reject);
      });

      const child = spawn(service.command, service.args, {
        cwd: service.cwd,
        env: { ...process.env, ...service.env },
        stdio: ['ignore', service.logStream, service.logStream],
        detached: false,  // 不分离！由管理器控制
      });

      if (!child.pid) {
        throw new Error(`启动失败：无法创建进程`);
      }

      service.process = child;
      service.startTime = Date.now();
      service.state = ServiceState.RUNNING;

      child.on('exit', (code, signal) => {
        service.exitCode = code;
        service.state = ServiceState.STOPPED;
        service.process = null;
        
        if (service.logStream) {
          service.logStream.end();
          service.logStream = null;
        }

        this.emit('service:stopped', { 
          name, 
          code, 
          signal,
          expected: service.state === ServiceState.STOPPING,
        });
      });

      child.on('error', (err) => {
        service.error = err;
        service.state = ServiceState.FAILED;
        this.emit('service:error', { name, error: err });
      });

      this.emit('service:started', { name, pid: child.pid });

    } catch (err) {
      service.state = ServiceState.FAILED;
      service.error = err;
      this.emit('service:error', { name, error: err });
      throw err;
    }
  }

  /**
   * 停止一个服务
   */
  async stop(name, signal = 'SIGTERM') {
    const service = this.services.get(name);
    if (!service) {
      throw new Error(`服务 ${name} 未注册`);
    }

    if (service.state !== ServiceState.RUNNING) {
      return; // 已经停止
    }

    service.state = ServiceState.STOPPING;
    this.emit('service:stopping', { name });

    if (service.process) {
      service.process.kill(signal);
      
      // 等待退出（超时保护）
      await Promise.race([
        new Promise(resolve => service.process.on('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]);

      // 如果还没退出，强制杀
      if (service.process && !service.process.killed) {
        service.process.kill('SIGKILL');
      }
    }
  }

  /**
   * 启动所有服务（按依赖顺序）
   */
  async startAll() {
    const started = new Set();
    const pending = Array.from(this.services.keys());

    while (pending.length > 0) {
      let progress = false;

      for (let i = pending.length - 1; i >= 0; i--) {
        const name = pending[i];
        const service = this.services.get(name);

        // 检查依赖是否都已启动
        const depsReady = service.depends.every(dep => started.has(dep));

        if (depsReady) {
          await this.start(name);
          started.add(name);
          pending.splice(i, 1);
          progress = true;
        }
      }

      if (!progress && pending.length > 0) {
        throw new Error(`循环依赖或依赖未满足: ${pending.join(', ')}`);
      }
    }
  }

  /**
   * 停止所有服务（反向依赖顺序）
   */
  async stopAll() {
    const names = Array.from(this.services.keys()).reverse();
    
    for (const name of names) {
      await this.stop(name);
    }
  }

  /**
   * 获取所有服务状态
   */
  getStatus() {
    const status = {};
    
    for (const [name, service] of this.services) {
      status[name] = {
        state: service.state,
        pid: service.process?.pid || null,
        uptime: service.startTime 
          ? Math.floor((Date.now() - service.startTime) / 1000)
          : null,
        exitCode: service.exitCode,
        error: service.error?.message || null,
      };
    }
    
    return status;
  }

  /**
   * 获取单个服务状态
   */
  getServiceStatus(name) {
    const service = this.services.get(name);
    if (!service) return null;

    return {
      name: service.name,
      state: service.state,
      pid: service.process?.pid || null,
      uptime: service.startTime 
        ? Math.floor((Date.now() - service.startTime) / 1000)
        : null,
      exitCode: service.exitCode,
      error: service.error?.message || null,
    };
  }

  /**
   * 等待所有服务（任一退出时返回）
   */
  async wait() {
    const promises = [];
    
    for (const service of this.services.values()) {
      if (service.process) {
        promises.push(
          new Promise(resolve => {
            service.process.on('exit', () => resolve(service.name));
          })
        );
      }
    }

    if (promises.length === 0) {
      throw new Error('没有运行中的服务');
    }

    return Promise.race(promises);
  }
}

/**
 * 创建管理器的便捷工厂函数
 */
export function createServiceManager(options) {
  return new ServiceManager(options);
}
