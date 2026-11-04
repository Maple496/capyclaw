/**
 * 跨进程文件锁竞争子进程。
 * 用法：node fslock-child.mjs <lockFile> <counterFile> <ops> <fsLockModuleUrl>
 * 调优参数由父进程通过 DSH_TUNING_JSON 注入（验证 env 覆盖链路）。
 */
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const [lockFile, counterFile, opsArg, moduleUrl] = process.argv.slice(2)
const ops = Number(opsArg) || 20
const { withFileLock } = await import(pathToFileURL(moduleUrl).href)

for (let i = 0; i < ops; i++) {
  withFileLock(lockFile, () => {
    let n = 0
    try { n = JSON.parse(fs.readFileSync(counterFile, 'utf8')).n || 0 } catch { /* 首次 */ }
    /* 持锁做一点真实工作，放大竞争窗口 */
    const spinEnd = Date.now() + 1
    while (Date.now() < spinEnd) { /* 自旋 1ms */ }
    fs.writeFileSync(counterFile, JSON.stringify({ n: n + 1 }))
  })
}
process.stdout.write('ok')
