#!/usr/bin/env node
/**
 * dshd 简化启动器 - 大道至简版
 * 
 * 核心原则：
 * 1. 终端窗口的生命周期 = 所有服务的生命周期
 * 2. 没有 detached，没有状态文件，没有复杂追踪
 * 3. 操作系统自动管理进程树
 * 
 * 使用：
 *   node simple-launcher.mjs --stack <stack.json>
 */
import { ForegroundServiceManager } from './lib/foreground-manager.mjs';
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
    console.error('用法: node simple-launcher.mjs --stack <stack.json>');
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
  const manager = new ForegroundServiceManager({
    logDir: path.join(cfg.stateDir, 'logs'),
    showLogs: false,  // 日志写入文件，不实时显示（保持终端清爽）
  });

  try {
    // 1. 启动 Broker
    console.log('📦 启动 Broker...');
    const brokerPort = stack.ports?.broker || 13593;
    
    const servicesManifest = path.join(cfg.stateDir, 'stack-services.json');
    
    manager.start('broker', process.execPath, [
      path.join(cfg.brokerDir, 'server.mjs'),
      '--manifest', servicesManifest,
      '--port', String(brokerPort),
    ], {
      cwd: cfg.brokerDir,
    });

    // 等待 Broker 就绪
    await sleep(3000);
    console.log('✓ Broker 已就绪\n');

    // 2. 启动 DSH (auth-proxy)
    console.log('🚀 启动 DSH...');
    const proxyPort = stack.ports?.proxy || 13594;
    const upPort = stack.ports?.upstream || 13595;
    const workspace = path.resolve(stack.workspace || cfg.workspace);

    manager.start('dsh', process.execPath, [
      path.join(cfg.harnessDir, 'auth-proxy.mjs'),
    ], {
      cwd: cfg.harnessDir,
      env: {
        DSH_HOME: cfg.dshHome,
        DSH_PROFILE: stack.profile || cfg.profile,
        DSH_WORKSPACE: workspace,
        DSH_PROXY_PORT: String(proxyPort),
        DSH_UP_PORT: String(upPort),
        // 不需要 DSHD_MANAGED！因为现在不用日志重定向，守卫可以看到 TTY
      },
    });

    await sleep(5000);
    console.log('✓ DSH 已就绪\n');

    // 3. 启动其他服务（从 stack.services）
    if (stack.services && stack.services.length > 0) {
      console.log('🔧 启动额外服务...');
      
      for (const service of stack.services) {
        const servicePort = service.ports?.main || 'auto';
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

        manager.start(service.id, process.execPath, [servicePath, ...resolvedArgs], {
          cwd: path.dirname(servicePath),
        });

        await sleep(2000);
        console.log(`✓ ${service.id} 已就绪\n`);
      }
    }

    // 显示访问地址
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
    console.log('   - 所有日志已写入:', path.join(cfg.stateDir, 'logs/'));
    console.log('   - 按 Ctrl+C 停止所有服务');
    console.log('   - 关闭此终端窗口也会停止所有服务');
    console.log();
    console.log('='.repeat(60));
    console.log();

    // 等待（保持运行）
    await manager.waitAll();

  } catch (err) {
    console.error('\n❌ 启动失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('致命错误:', err);
  process.exit(1);
});
