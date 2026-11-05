/* 单实例锁：确保同一时间只有一个 dsh 实例运行 */
import fs from 'node:fs';
import path from 'node:path';

/* 缺省锁文件落调用目录（npm 安装形态下包目录不宜写状态）；调用方通常显式传路径。 */
const LOCK_FILE = path.join(process.cwd(), '.dsh-instance.lock');

export function acquireLock(lockFile = LOCK_FILE) {
  try {
    // 检查锁文件是否存在（每个 runtime 可传自己的锁路径）
    if (fs.existsSync(lockFile)) {
      const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      const { pid } = lockData;

      // 检查进程是否还活着（Windows）
      try {
        process.kill(pid, 0); // 信号 0 只检测不杀
        // 进程还活着就绝不允许第二个实例；时间只用于识别异常残留。
        console.error(`✗ 另一个实例正在运行 (PID ${pid})`);
        console.error(`如果确认没有运行，删除: ${lockFile}`);
        return false;
      } catch (e) {
        // 进程已死，清理旧锁
        console.log(`清理过期锁文件 (PID ${pid} 已不存在)`);
        fs.unlinkSync(lockFile);
      }
    }

    // 写入锁文件
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      timestamp: Date.now(),
    }));

    // 进程退出时清理
    const cleanup = () => {
      try {
        if (fs.existsSync(lockFile)) {
          const data = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
          if (data.pid === process.pid) {
            fs.unlinkSync(lockFile);
          }
        }
      } catch (e) { /* 忽略清理失败 */ }
    };
    
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    
    return true;
  } catch (e) {
    console.error('获取锁失败:', e);
    return false;
  }
}
