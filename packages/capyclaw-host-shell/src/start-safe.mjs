#!/usr/bin/env node
/* 安全启动脚本：自动检测并清理端口占用，然后启动 dsh */
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enforceRunInForeground } from './foreground-guard.mjs';

const execAsync = promisify(exec);

// ========== 前台运行守卫：强制在可见终端中运行 ==========
enforceRunInForeground({
  serviceName: 'DeepSeek Harness',
  strict: true,        // 严格模式：不通过则退出
  allowCI: false,      // 不允许在 CI 环境运行（这是桌面服务）
});

const PORTS_TO_CHECK = [3080, 3081, 39311]; // dsh upstream, proxy, ppt-bridge

async function findProcessOnPort(port) {
  try {
    // Windows: netstat -ano | findstr :PORT
    const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
    const lines = stdout.split('\n').filter(l => l.includes('LISTENING'));
    if (lines.length === 0) return null;
    
    // 提取 PID（最后一列）
    const match = lines[0].match(/\s+(\d+)\s*$/);
    return match ? parseInt(match[1]) : null;
  } catch (e) {
    return null; // 端口未被占用
  }
}

async function killProcess(pid) {
  try {
    await execAsync(`taskkill /F /PID ${pid}`);
    console.log(`✓ 已终止进程 ${pid}`);
    return true;
  } catch (e) {
    console.error(`✗ 终止进程 ${pid} 失败:`, e.message);
    return false;
  }
}

async function checkAndCleanPorts() {
  console.log('=== 检查端口占用 ===');
  
  for (const port of PORTS_TO_CHECK) {
    const pid = await findProcessOnPort(port);
    if (pid) {
      console.log(`端口 ${port} 被进程 ${pid} 占用`);
      
      // 检查是否是当前进程（避免自杀）
      if (pid === process.pid) {
        console.log(`  跳过（当前进程）`);
        continue;
      }
      
      // 尝试终止
      const killed = await killProcess(pid);
      if (killed) {
        // 等待端口释放
        await new Promise(r => setTimeout(r, 1000));
      }
    } else {
      console.log(`端口 ${port}: ✓ 空闲`);
    }
  }
  
  console.log('');
}

async function startDsh() {
  console.log('=== 启动 dsh ===');
  
  // 启动 auth-proxy.mjs（它会自动拉起 dsh）；绝对路径 + process.execPath，
  // 不依赖 cwd——收编进包后脚本不再与调用目录同处，原相对路径 'node auth-proxy.mjs' 必失败
  const child = spawn(process.execPath, [
    join(dirname(fileURLToPath(import.meta.url)), 'auth-proxy.mjs'),
  ], {
    stdio: 'inherit',
  });
  
  child.on('error', (err) => {
    console.error('✗ 启动失败:', err);
    process.exit(1);
  });
  
  child.on('exit', (code) => {
    console.log(`dsh 已退出，代码: ${code}`);
    process.exit(code);
  });
  
  // 转发信号
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

// 主流程
(async () => {
  try {
    await checkAndCleanPorts();
    await startDsh();
  } catch (e) {
    console.error('启动失败:', e);
    process.exit(1);
  }
})();
