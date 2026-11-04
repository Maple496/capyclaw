#!/usr/bin/env node
/**
 * dshd 启动器 - 基于统一服务管理器抽象
 * 
 * 架构：
 * 
 *   ServiceManager (核心抽象)
 *        ↓
 *   TerminalInterface (终端视图)
 * 
 * 特点：
 * - ServiceManager 负责所有服务的生命周期
 * - TerminalInterface 只是一个"视图"
 * - 可以轻松替换为 GUI、API、系统托盘等其他接口
 */
import { createServiceManager } from './lib/service-manager.mjs';
import { runInTerminal } from './lib/terminal-interface.mjs';
import { loadConfig } from './lib/config.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function loadStack(stackFile) {
  const content = await readFile(stackFile, 'utf8');
  return JSON.parse(content);
}

async function main() {
  // 解析参数
  const args = process.argv.slice(2);
  const stackIndex = args.indexOf('--stack');
  const stackFile = stackIndex >= 0 ? args[stackIndex + 1] : null;

  if (!stackFile) {
    console.error('用法: node unified-launcher.mjs --stack <stack.json>');
    process.exit(1);
  }

  // 加载配置
  const stack = await loadStack(path.resolve(stackFile));
  const cfg = await loadConfig();

  console.log('='.repeat(60));
  console.log(`启动栈: ${stack.name}`);
  console.log('='.repeat(60));
  console.log();

  // 创建服务管理器（核心抽象）
  const manager = createServiceManager({
    logDir: path.join(cfg.stateDir, 'logs'),
  });

  // 注册所有服务
  const brokerPort = stack.ports?.broker || 13593;
  const proxyPort = stack.ports?.proxy || 13594;
  const upPort = stack.ports?.upstream || 13595;
  const workspace = path.resolve(stack.workspace || cfg.workspace);

  // 1. Broker
  manager.register('broker', {
    command: process.execPath,
    args: [
      path.join(cfg.brokerDir, 'server.mjs'),
      '--manifest', path.join(cfg.stateDir, 'stack-services.json'),
      '--port', String(brokerPort),
    ],
    cwd: cfg.brokerDir,
    depends: [],  // 无依赖
  });

  // 2. DSH
  manager.register('dsh', {
    command: process.execPath,
    args: [path.join(cfg.harnessDir, 'auth-proxy.mjs')],
    cwd: cfg.harnessDir,
    env: {
      DSH_HOME: cfg.dshHome,
      DSH_PROFILE: stack.profile || cfg.profile,
      DSH_WORKSPACE: workspace,
      DSH_PROXY_PORT: String(proxyPort),
      DSH_UP_PORT: String(upPort),
    },
    depends: ['broker'],  // 依赖 Broker
  });

  // 3. 其他服务（从 stack.services）
  if (stack.services && stack.services.length > 0) {
    for (const service of stack.services) {
      const args = service.args || [];
      
      // 替换变量
      const resolvedArgs = args.map(arg => {
        if (typeof arg !== 'string') return arg;
        return arg
          .replace('${STACK_DIR}', path.dirname(path.resolve(stackFile)))
          .replace('${home}', stack.home)
          .replace('${ports.broker}', String(brokerPort));
      });

      const servicePath = path.resolve(
        path.dirname(stackFile),
        service.path
      );

      manager.register(service.id, {
        command: process.execPath,
        args: [servicePath, ...resolvedArgs],
        cwd: path.dirname(servicePath),
        depends: ['broker', 'dsh'],  // 依赖核心服务
      });
    }
  }

  try {
    // 启动所有服务（按依赖顺序）
    await manager.startAll();

    console.log();
    console.log('='.repeat(60));
    console.log('✅ 所有服务已启动');
    console.log('='.repeat(60));
    console.log();
    console.log(`🌐 DSH 主界面:  http://localhost:${proxyPort}/`);
    
    if (stack.services) {
      stack.services.forEach(service => {
        if (service.ports?.main) {
          console.log(`🔧 ${service.id}:  http://localhost:${service.ports.main}/`);
        }
      });
    }
    
    console.log();
    console.log('💡 提示：');
    console.log('   - 日志目录:', path.join(cfg.stateDir, 'logs/'));
    console.log('   - 所有服务生命周期由 ServiceManager 统一管理');
    console.log('   - 终端只是一个视图接口');
    console.log();
    console.log('='.repeat(60));
    console.log();

    // 使用终端接口（可以替换为其他接口）
    await runInTerminal(manager);

  } catch (err) {
    console.error('\n❌ 启动失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('致命错误:', err);
  process.exit(1);
});
