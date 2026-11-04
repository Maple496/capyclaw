/**
 * 全链路验收测试：生产（scaffold）→ 打包（manifest 校验）→ 分发（index.json+zip+sha256）
 * → 安装（dsh-works）→ 检查 → 卸载。一条用例走完插件交付链的本地半边。
 * 运行时编排半边（deploy start / 控制面 .works 线）由 dsh-suite-kit 与 dsh-runtime-control
 * 的 e2e 覆盖，此处不重复起 harness。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { packPlugin } from '../lib/pack.mjs'
import { commands as worksCommands } from '../../packages/dsh-suite-kit/bin/dsh-works.mjs'
import { writeZipFromDir } from '../lib/zip.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const CREATE = path.join(ROOT, 'plugin-development', 'create-plugin.mjs')

function smokeWorks(source) {
  return `%%%WORKS-META%%%
{
  "name": "chain-smoke-deploy",
  "brief": "全链路验收冒烟：脚手架产物的部署配置",
  "tags": "acceptance,chain",
  "view": { "kind": "deployment" },
  "schema_version": "1.0.0"
}

%%%WORKS-CODE%%%
{
  "deployment": { "type": "domain", "source": ${JSON.stringify(source)}, "autoStart": true },
  "runtime": { "driver": "node", "workId": "main" }
}
`
}

test('全链路验收：scaffold → pack（含 manifest 校验）→ 分发源 → works install → check → 卸载', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-accept-'))
  const storeRoot = path.join(tmp, 'store')
  const savedStore = process.env.DSH_STORE_ROOT
  process.env.DSH_STORE_ROOT = storeRoot
  try {
    // 1) 生产：脚手架生成 plugin + suite + domain
    const out = path.join(tmp, 'plugins')
    execFileSync(process.execPath, [
      CREATE,
      '--name', 'dsh-chain-service',
      '--type', 'service',
      '--title', 'Chain Service',
      '--port', '39607',
      '--out', out,
      '--domain', 'chain',
      '--yes',
    ], { cwd: ROOT, stdio: 'pipe' })
    const suiteDir = path.join(out, 'dsh-chain-service', 'plugin', 'dsh-chain-service-suite')
    const domainDir = path.join(out, 'dsh-chain-service', 'domains', 'chain')
    assert.ok(fs.existsSync(path.join(suiteDir, 'dsh-suite.json')), '脚手架应产出 suite')
    assert.ok(fs.existsSync(path.join(domainDir, 'dsh-domain.json')), '脚手架应产出 domain')

    // 2) 打包：合法 suite 通过（含 manifest 语义校验），产出 ZIP
    const packed = packPlugin({ srcDir: suiteDir, outDir: path.join(tmp, 'dist') })
    assert.ok(packed.entries.includes('dsh-suite.json'))
    assert.ok(
      packed.warnings.every((warning) => /引用外部包/.test(warning)),
      `只允许外部包引用类 warning，实际: ${packed.warnings.join(' | ')}`,
    )

    // 2b) 打包负路径：坏 manifest 被拦（role 非法）
    const badDir = path.join(tmp, 'bad-suite')
    fs.cpSync(suiteDir, badDir, { recursive: true })
    const suiteManifestPath = path.join(badDir, 'dsh-suite.json')
    const badManifest = JSON.parse(fs.readFileSync(suiteManifestPath, 'utf8'))
    const firstPackage = Object.keys(badManifest.packages)[0]
    badManifest.packages[firstPackage].role = 'not-a-role'
    fs.writeFileSync(suiteManifestPath, JSON.stringify(badManifest, null, 2))
    assert.throws(() => packPlugin({ srcDir: badDir, outDir: path.join(tmp, 'dist') }), /manifest 语义校验/)

    // 3) 分发源：脚手架 domain 打成 works zip + index.json（sha256/size）
    const sourceRoot = path.join(tmp, 'source')
    fs.mkdirSync(sourceRoot, { recursive: true })
    const stage = path.join(sourceRoot, 'stage')
    fs.mkdirSync(stage, { recursive: true })
    fs.writeFileSync(path.join(stage, 'chain-smoke.works'), smokeWorks(domainDir))
    const zipFile = path.join(sourceRoot, 'zips', 'chain-smoke-1.0.0.zip')
    fs.mkdirSync(path.dirname(zipFile), { recursive: true })
    writeZipFromDir(stage, zipFile)
    const bytes = fs.readFileSync(zipFile)
    const indexFile = path.join(sourceRoot, 'index.json')
    fs.writeFileSync(indexFile, JSON.stringify({
      schema: 1,
      channel: 'stable',
      generatedAt: new Date().toISOString(),
      plugins: [{
        name: 'chain-smoke',
        version: '1.0.0',
        title: 'chain smoke',
        file: 'zips/chain-smoke-1.0.0.zip',
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        latest: true,
      }],
    }, null, 2))

    // 4) 安装：--from 源 → sha256 校验 → 解包 → 注册表
    await worksCommands.install('chain-smoke', { from: indexFile })
    const registry = JSON.parse(fs.readFileSync(path.join(storeRoot, 'works-registry.json'), 'utf8'))
    const entry = registry.works.find((item) => item.ref === 'WORKS-src-chain-smoke')
    assert.ok(entry, '安装后注册表应有 WORKS-src-chain-smoke')
    assert.equal(entry.source, indexFile)

    // 5) 检查 + 详情 + 卸载
    await worksCommands.check('WORKS-src-chain-smoke')
    await worksCommands.show('WORKS-src-chain-smoke')
    await worksCommands.uninstall('WORKS-src-chain-smoke')
    const after = JSON.parse(fs.readFileSync(path.join(storeRoot, 'works-registry.json'), 'utf8'))
    assert.ok(!after.works.some((item) => item.ref === 'WORKS-src-chain-smoke'), '卸载后注册表应移除')
  } finally {
    if (savedStore === undefined) delete process.env.DSH_STORE_ROOT
    else process.env.DSH_STORE_ROOT = savedStore
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}, { timeout: 120000 })
