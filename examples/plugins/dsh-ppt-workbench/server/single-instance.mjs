/* 单实例锁：确保同一时间只有一个 ppt-bridge relay 运行 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = path.join(HERE, '.relay-instance.lock');

export function acquireLock() {
  try {
    // 检查锁文件是否存在
    if (fs.existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const { pid, timestamp, port } = lockData;
      
      // 检查进程是否还活着（Windows）
      try {
        process.kill(pid, 0); // 信号 0 只检测不杀
        const age = Date.now() - timestamp;
        if (age < 60000) {
          // 进程活着且锁文件不到 1 分钟
          console.error(`✗ 另一个 ppt-bridge relay 正在运行 (PID ${pid}, 端口 ${port})`);
          console.error(`如果确认没有运行，删除: ${LOCK_FILE}`);
          return false;
        }
      } catch (e) {
        // 进程已死，清理旧锁
        console.log(`清理过期锁文件 (PID ${pid} 已不存在)`);
        fs.unlinkSync(LOCK_FILE);
      }
    }
    
    return true;
  } catch (e) {
    console.error('获取锁失败:', e);
    return false;
  }
}

export function writeLock(port) {
  try {
    // 写入锁文件
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
      pid: process.pid,
      port,
      timestamp: Date.now(),
    }));
    
    // 进程退出时清理
    const cleanup = () => {
      try {
        if (fs.existsSync(LOCK_FILE)) {
          const data = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
          if (data.pid === process.pid) {
            fs.unlinkSync(LOCK_FILE);
          }
        }
      } catch (e) { /* 忽略清理失败 */ }
    };
    
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('uncaughtException', (e) => { console.error('未捕获异常:', e); cleanup(); process.exit(1); });
    
    return true;
  } catch (e) {
    console.error('写入锁失败:', e);
    return false;
  }
}
