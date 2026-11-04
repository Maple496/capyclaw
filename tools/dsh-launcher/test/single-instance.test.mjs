import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'


// dsh 宿主已移出本仓库：单实例锁实现跟着宿主走，用 DSH_HARNESS_DIR 或文档化的移出位置解析
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const HARNESS = [
  process.env.DSH_HARNESS_DIR,
  path.join(REPO, '..', 'dsh-runtime', 'apps', 'harness', 'deepseek-harness'),
].filter(Boolean).find((p) => existsSync(path.join(p, 'single-instance.mjs')))

if (!HARNESS) {
  console.error('[skip-hint] 未找到 dsh 宿主，请设置 DSH_HARNESS_DIR（需要其中的 single-instance.mjs）')
  process.exit(0)
}
const { acquireLock } = await import(pathToFileURL(path.join(HARNESS, 'single-instance.mjs')).href)

test('acquireLock 使用调用方传入的锁文件（每个 runtime 独立）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-lock-'))
  const lock = path.join(dir, 'instance.lock')
  try {
    assert.equal(acquireLock(lock), true)
    assert.ok(existsSync(lock))
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid)

    // 同一文件、同一存活进程：第二次必须拒绝
    assert.equal(acquireLock(lock), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
