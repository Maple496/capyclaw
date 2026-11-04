/**
 * 拓展性演练（extensibility drills）：用测试证明四个常见扩展场景只动「数据」不动「代码」。
 *
 * E1 新增启动清单   = 新写一个 domain JSON（零代码）
 * E2 既有清单加插件 = components 数组加一项（零代码）
 * E3 切换模型       = works/domain 里改一个字段（零代码）
 * E4 防回归         = 加了插件但 binding 引用其未声明行 → 行覆盖审计拦下
 *
 * 新插件从零走全链（scaffold→pack→分发→安装）由 plugin-development/test/chain.test.mjs 证明；
 * 平台侧换扣费/上游由 tempkey 契约与 mock 测试证明（见 CHAIN_CONTRACTS.md S9）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDomainManifest } from '../src/domain.mjs'
import { auditRowCoverage } from '../lib/row-audit.mjs'
import { loadConfig } from '../bin/dsh-deploy.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const WS_PKG = path.join(REPO, 'packages', 'dsh-workspace-service')
const STATE_PKG = path.join(REPO, 'packages', 'dsh-state-service')

test('E1 新增启动清单：手写一个全新 domain JSON 即可通过校验+行覆盖审计（零代码）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-e1-'))
  try {
    // 一个此前不存在的清单：workspace-service + state-service 组合
    const domain = {
      name: 'ws-state-combo',
      version: '1.0.0',
      title: 'Workspace + State 组合清单',
      baseBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      components: [WS_PKG, STATE_PKG],
      profile: { name: 'ws-state-combo', port: 3080 },
      runtime: {
        driver: 'node',
        workId: 'main',
        requires: { services: ['workspace', 'state'] },
        bindings: [{ row: 'workspace-service', config: { port: '${ports.content}' } }],
        scope: {
          sessions: { path: '.dsh/sessions', isolated: true },
          files: [{ id: 'workspace', kind: 'workspace', path: 'workspace', patterns: ['**'] }],
          network: { bind: ['127.0.0.1'] },
          processes: { killTree: true },
        },
        ports: { harness: 0, dsh: 0, content: 0 },
        model: { id: 'llm-deepseek', plugin: '@deepseek-ai/dsh-llm-deepseek-api-key', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/anthropic' },
      },
    }
    const file = path.join(root, 'dsh-domain.json')
    fs.writeFileSync(file, JSON.stringify(domain, null, 2))

    const validation = validateDomainManifest(domain)
    assert.equal(validation.ok, true, validation.errors.join())
    const audit = auditRowCoverage(file)
    assert.equal(audit.ok, true, `缺失行: ${JSON.stringify(audit.missing)}`)
    assert.ok(audit.suites.includes('dsh-state-service-suite'), 'state-service 行应由其 suite rows 声明')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('E2 既有清单加插件：components 数组加一项，审计自动覆盖新插件的行（零代码）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-e2-'))
  try {
    const domain = {
      name: 'ext-combo',
      version: '1.0.0',
      title: '组合 + state-service',
      baseBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      components: [WS_PKG, STATE_PKG],
      profile: { name: 'ext-combo', port: 3080 },
      runtime: {
        driver: 'node',
        workId: 'main',
        bindings: [
          { row: 'workspace-service', config: { port: '${ports.content}' } },
          { row: 'state-service', config: {} },
        ],
        scope: {
          sessions: { path: '.dsh/sessions', isolated: true },
          files: [{ id: 'workspace', kind: 'workspace', path: 'workspace', patterns: ['**'] }],
          network: { bind: ['127.0.0.1'] },
          processes: { killTree: true },
        },
        ports: { harness: 0, dsh: 0, content: 0 },
      },
    }
    const file = path.join(root, 'dsh-domain.json')
    fs.writeFileSync(file, JSON.stringify(domain, null, 2))
    const audit = auditRowCoverage(file)
    assert.equal(audit.ok, true, `缺失行: ${JSON.stringify(audit.missing)}`)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('E3 切换模型：同一 works 只改 runtime.model 字段，部署配置即随数据切换（零代码）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-e3-'))
  try {
    const makeWorks = (model) => {
      const file = path.join(root, `deploy-${model.id}.works`)
      fs.writeFileSync(file, `%%%WORKS-META%%%
{ "name": "model-switch", "brief": "换模型演练", "view": { "kind": "deployment" }, "schema_version": "1.0.0" }

%%%WORKS-CODE%%%
{
  "deployment": { "type": "domain", "source": ${JSON.stringify(root)}, "autoStart": true },
  "runtime": {
    "driver": "node",
    "workId": "main",
    "model": ${JSON.stringify(model)}
  }
}
`)
      return file
    }

    const modelA = { id: 'llm-deepseek', plugin: '@deepseek-ai/dsh-llm-deepseek-api-key', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/anthropic' }
    const modelB = { id: 'llm-tempkey', plugin: 'dsh-llm-tempkey', apiKeyEnv: 'DSH_TEMPKEY_LLM_KEY', baseURL: 'http://127.0.0.1:39610/v2' }

    const configA = loadConfig(makeWorks(modelA))
    const configB = loadConfig(makeWorks(modelB))
    assert.deepEqual(configA.runtime.model, modelA, '清单 A 携带模型 A')
    assert.deepEqual(configB.runtime.model, modelB, '清单 B 携带模型 B')
    // 语义：works 的 runtime.model 会作为 createRuntime 的 model 覆盖项传给运行时
    // （bin/dsh-deploy.mjs createRuntimeFor: model: runtime?.model）；缺省时回落 domain 基线。
    assert.notEqual(configA.runtime.model.id, configB.runtime.model.id)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('E4 防回归：加了插件但 binding 引用其未声明行 → 行覆盖审计点名拦截', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-e4-'))
  try {
    const domain = {
      name: 'ext-broken',
      version: '1.0.0',
      title: '组合但引用了不存在的行',
      baseBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      components: [WS_PKG, STATE_PKG],
      profile: { name: 'ext-broken', port: 3080 },
      runtime: {
        driver: 'node',
        workId: 'main',
        bindings: [{ row: 'state-service-typo', config: {} }],
        scope: { sessions: { path: '.dsh/sessions', isolated: true }, files: [], network: { bind: ['127.0.0.1'] }, processes: { killTree: true } },
        ports: { harness: 0, dsh: 0, content: 0 },
      },
    }
    const file = path.join(root, 'dsh-domain.json')
    fs.writeFileSync(file, JSON.stringify(domain, null, 2))
    const audit = auditRowCoverage(file)
    assert.equal(audit.ok, false)
    assert.deepEqual(audit.missing, [{ id: 'state-service-typo', referencedBy: 'runtime.bindings' }])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
