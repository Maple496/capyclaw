/* 精确进程管理：只管理自己启动的子进程，不误杀无关 node 进程 */
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
/* PID 记录文件：env 可覆盖；缺省落调用目录（npm 安装形态下包目录不宜写状态）。 */
const PID_FILE = process.env.DSH_PID_FILE || path.join(process.cwd(), '.dsh-pids.json');

/**
 * 记录进程组：主进程 + 子进程（dsh）
 */
export function savePids(mainPid, childPid) {
  try {
    fs.writeFileSync(PID_FILE, JSON.stringify({
      main: mainPid,
      child: childPid,
      timestamp: Date.now(),
    }));
  } catch (e) {
    console.warn('保存 PID 失败:', e.message);
  }
}

/**
 * 清理旧实例：只杀死记录在 PID_FILE 里的进程
 */
export async function cleanupOldInstance() {
  if (!fs.existsSync(PID_FILE)) return;
  
  try {
    const data = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    const { main, child, timestamp } = data;
    
    // 检查进程是否还活着
    const killed = [];
    
    for (const [name, pid] of [['子进程', child], ['主进程', main]]) {
      if (!pid) continue;
      
      try {
        // 检查进程是否存在（Windows）
        process.kill(pid, 0);
        
        // 进程还活着，尝试终止
        await execAsync(`taskkill /F /PID ${pid}`);
        killed.push(`${name}(${pid})`);
        console.log(`✓ 已终止旧实例 ${name} (PID ${pid})`);
      } catch (e) {
        // 进程已不存在，跳过
      }
    }
    
    if (killed.length > 0) {
      console.log(`清理完成: ${killed.join(', ')}`);
      await new Promise(r => setTimeout(r, 1000)); // 等待端口释放
    }
    
    // 清理旧 PID 文件
    fs.unlinkSync(PID_FILE);
  } catch (e) {
    console.warn('清理旧实例失败:', e.message);
    // 文件损坏，直接删除
    try { fs.unlinkSync(PID_FILE); } catch {}
  }
}

/**
 * 退出时清理
 */
export function setupCleanup() {
  const cleanup = () => {
    try {
      if (fs.existsSync(PID_FILE)) {
        const data = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
        if (data.main === process.pid) {
          fs.unlinkSync(PID_FILE);
        }
      }
    } catch (e) { /* 忽略清理失败 */ }
  };
  
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}
