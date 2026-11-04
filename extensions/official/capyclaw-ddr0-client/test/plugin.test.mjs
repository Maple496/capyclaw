/**
 * ddr0-client 结构冒烟测试
 *
 * 只验证「这个包作为 dsh 插件是否成型」，不启服务、不发网络请求：
 *   1. 导出契约：name / apply
 *   2. bundle 声明：package.json 的 dsh.bundle.patch 指向真实存在的文件
 *   3. 静态资源：static/index.html 存在且非空（apply 的 ready 分支依赖它）
 *
 * 运行：node --test test/plugin.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { statSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('导出契约：name 与 apply', async () => {
  const mod = await import('../lib/host.mjs')
  assert.equal(typeof mod.name, 'string')
  assert.ok(mod.name.length > 0, 'name 不应为空')
  assert.equal(typeof mod.apply, 'function')
})

test('package.json 的 dsh.bundle.patch 指向真实文件', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const patch = pkg?.dsh?.bundle?.patch
  assert.ok(patch, 'package.json 必须声明 dsh.bundle.patch')
  const patchPath = path.join(ROOT, patch)
  assert.ok(statSync(patchPath).isFile(), `patch 文件不存在: ${patch}`)

  const text = readFileSync(patchPath, 'utf8')
  assert.match(text, /^\s*-\s*insert:/m, 'patch 应包含 insert 条目')
})

test('cordis.patch.yml 的条目 name 与包名一致', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const text = readFileSync(path.join(ROOT, pkg.dsh.bundle.patch), 'utf8')
  assert.ok(
    text.includes(pkg.name),
    `patch 里应出现包名 ${pkg.name}，否则 dsh 无法解析到本包`,
  )
})

test('apply 依赖的静态资源存在且非空', () => {
  const indexPath = path.join(ROOT, 'static', 'index.html')
  const st = statSync(indexPath)
  assert.ok(st.isFile(), 'static/index.html 不存在')
  assert.ok(st.size > 0, 'static/index.html 为空')
})
