/**
 * discovery 注册表：中间件运行事实的唯一落点。
 *
 * 形状（~/.dsh/services.json）：
 *   {
 *     "version": 1,
 *     "updatedAt": "2026-11-01T…",
 *     "services": {
 *       "<id>": { id, state, url, pid, ports, specHash, keepAlive, startedAt }
 *     }
 *   }
 *
 * 口径：损坏 = 空表（诚实降级，不阻塞）；原子写（唯一 tmp + rename，
 * tmp 名带随机段——同进程并发写不会互抢同一个 tmp）。
 */
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

/** 每个注册表文件一条写队列：整文件读改写串行化，杜绝并发互相覆盖。 */
const _writeQueues = new Map()

function enqueueWrite(filePath, task) {
  const key = path.resolve(filePath).toLowerCase()
  const prev = _writeQueues.get(key) || Promise.resolve()
  const run = prev.then(task, task)
  _writeQueues.set(key, run.then(() => {}, () => {}))
  return run
}

export async function loadDiscovery(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

export function saveDiscovery(filePath, data) {
  return enqueueWrite(filePath, async () => {
    await mkdir(path.dirname(filePath), { recursive: true })
    const tmp = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`)
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await rename(tmp, filePath)
  })
}
