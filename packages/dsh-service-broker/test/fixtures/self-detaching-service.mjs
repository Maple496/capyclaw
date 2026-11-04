/**
 * 测试夹具：模拟「启动器进程退出、服务进程实际存活」的形态。
 *
 * 真实场景 = relay 的 allowReuse 路径：发现端口上已有健康实例 → 直接返回，
 * 启动器进程没有句柄自然退出，但端口上确有服务在跑。
 *
 * 这里用 detached 孙进程起一个最小 /healthz 服务，父进程 300ms 后退出。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.argv[process.argv.indexOf('--port') + 1])

const child = spawn(process.execPath, [path.join(HERE, 'health-server.mjs'), '--port', String(port), '--delay', '900'], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
})
child.unref()
setTimeout(() => process.exit(0), 300)
