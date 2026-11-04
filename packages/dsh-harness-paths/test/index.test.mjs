import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { resolveHarnessDir, harnessCandidates, REPO_ROOT } from '../src/index.mjs'

test('env 显式指定时绝对化并优先于一切候选', () => {
  const hit = resolveHarnessDir({ env: 'x:/definitely/not/real' })
  assert.equal(hit, path.resolve('x:/definitely/not/real'))
})

test('相对 env 路径按调用方 cwd 绝对化（不产生相对路径返回值）', () => {
  const hit = resolveHarnessDir({ env: '../somewhere' })
  assert.ok(path.isAbsolute(hit), `应返回绝对路径，得到 ${hit}`)
  assert.ok(hit.endsWith('somewhere'))
})

test('候选顺序：dsh-runtime 在前，历史布局在后', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hp-'))
  try {
    const list = harnessCandidates(root)
    assert.match(list[0], /[\\/]dsh-runtime[\\/]apps[\\/]harness[\\/]deepseek-harness$/)
    assert.ok(list.some((p) => p.includes('out_of_scope')))
    // 候选都不存在 → 空串（调用方负责明确报错）
    assert.equal(resolveHarnessDir({ env: '', repoRoot: root }), '')
    // 造一个哨兵文件让 core-harness 候选命中，验证存在性识别
    const fake = path.join(root, 'core-harness', 'deepseek-harness')
    mkdirSync(fake, { recursive: true })
    writeFileSync(path.join(fake, 'auth-proxy.mjs'), '')
    assert.equal(resolveHarnessDir({ env: '', repoRoot: root }), fake)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('默认解析能定位本机真实宿主或诚实返回空串', () => {
  const hit = resolveHarnessDir({ env: '' })
  assert.ok(hit === '' || existsSync(path.join(hit, 'auth-proxy.mjs')))
})

test('REPO_ROOT 指向仓库根（含 package.json workspaces）', () => {
  assert.ok(existsSync(path.join(REPO_ROOT, 'package.json')))
})
