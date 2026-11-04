#!/usr/bin/env node
/**
 * dshd 启动器 - Web UI 版本
 * 
 * 特点：
 * - 使用 Web 界面管理所有服务
 * - 不依赖终端
 * - 可视化查看状态
 * - 点击启动/停止服务
 */
import { createServiceManager } from './lib/service-manager.mjs';
import { serveWebUi } from './lib/web-ui-interface.mjs';
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
    console.error('用法: node web-launcher.mjs --stack <stack.json>');
    process.exit(1);
  }

  // 加载配置
  const stack = await loadStack(path.resolve(stackFile));
  const cfg = await loadConfig();

  console.log('='.repeat(60));
  console.log(`启动栈: ${stack.name}`);
  console.log('='.repeat(60));
  console.log();

  // 创建服务管理器
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
    depends: [],
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
    depends: ['broker'],
  });

  // 3. 其他服务
  const serviceUrls = {
    dsh: `http://localhost:${proxyPort}/`,
  };

  if (stack.services && stack.services.length > 0) {
    for (const service of stack.services) {
      const args = service.args || [];
      
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
        depends: ['broker', 'dsh'],
      });

      // 记录服务 URL
      if (service.ports?.main) {
        serviceUrls[service.id] = `http://localhost:${service.ports.main}/`;
      }
    }
  }

  try {
    // 启动所有服务
    console.log('正在启动所有服务...');
    await manager.startAll();

    console.log();
    console.log('='.repeat(60));
    console.log('✅ 所有服务已启动');
    console.log('='.repeat(60));
    console.log();

    // 启动 Web UI
    await serveWebUi(manager, {
      port: 9999,
      serviceUrls: serviceUrls,
    });

    console.log('📊 服务列表：');
    for (const [name, url] of Object.entries(serviceUrls)) {
      console.log(`   ${name}: ${url}`);
    }
    console.log();
    console.log('='.repeat(60));
    console.log();

    // 保持运行
    await new Promise(() => {}); // 永久运行

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
