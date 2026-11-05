/**
 * L5 发布链路层：一键 release 流水线 → zip 源标准校验（离线）→ 统一发布预演
 * （网络轻量）→ 可安装性抽检（网络重，默认抽 2 个代表包）。
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

  rec.section('统一发布预演（3 支撑库 + 28 插件全过闸）')
  if (skipNetwork) {
    rec.skip('publish dry-run', '--skip-network')
  } else {
    const dry = run('node', ['scripts/publish-to-npm.mjs'])
    const summaryLine = dry.stdout.split('\n').find((l) => l.includes('汇总')) || ''
    const m = /汇总: (\{.*\})/.exec(summaryLine)
    const summary = m ? JSON.parse(m[1]) : {}
    const failed = ['gate-failed', 'invalid', 'test-failed', 'publish-failed']
      .some((k) => summary[k])
    rec.check('publish dry-run 全过闸（无 gate/校验失败）', dry.status === 0 && !failed, summaryLine.trim())
    rec.check('publish dry-run 覆盖支撑库（skipped-exists + would-publish = 31）',
      (summary['skipped-exists'] || 0) + (summary['would-publish'] || 0) === 31, summaryLine.trim())
  }

  rec.section('可安装性抽检（npm pack → 干净目录安装）')
  if (skipNetwork) {
    rec.skip('verify-publishable 抽检', '--skip-network')
  } else {
    for (const name of ['@capyclaw/canvas-workbench', '@capyclaw/ppt-skill-api']) {
      const r = run('node', ['scripts/verify-publishable.mjs', '--only', name])
      rec.check(`verify-publishable ${name}`, r.status === 0, (r.stderr || r.stdout).split('\n').slice(-3).join(' | '))
    }
  }

  return rec.summary()
}
