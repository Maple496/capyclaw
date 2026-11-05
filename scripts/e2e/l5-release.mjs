/**
 * L5 发布链路层：一键 release 流水线 → zip 源标准校验（离线）。
 * （npm 发布预演/可安装性抽检已随发布流水线移入 dsh 内的 @capyclaw/publisher 插件，
 *   见 docs/PUBLISHING.md；本层只验证本仓职责——生产出合格的 dist 产物。）
 */
import path from 'node:path'

import { ROOT, Recorder, run } from './harness.mjs'

const RELEASE_CLI = path.join(ROOT, 'tools/capyclaw-plugin-release/bin/cli.mjs')

export async function runLayer({ skipNetwork = false } = {}) {
  const rec = new Recorder('L5 发布链路层')

  rec.section('一键 release 流水线（构建→lint→校验→zip→索引→registry）')
  const release = run('npm', ['run', 'release'], { capture: false })
  rec.check('npm run release 全链退出码 0', release.status === 0)

  rec.section('zip 源标准校验（plugin-source/1，离线）')
  const verify = run('node', [RELEASE_CLI, 'verify'])
  rec.check('dsh-release verify dist（索引 + 逐 zip 完整性）', verify.status === 0,
    (verify.stderr || verify.stdout).split('\n').filter((l) => l.includes('✗')).join(' | '))

  return rec.summary()
}
