/**
 * worksreg —— 工作流组件 → dsh 作品体系（dsh-works）的注册桥。
 *
 * dsh 的作品资产真源 = DSH_STORE_ROOT 下的：
 *   registry.json            {version, works:[{ref,type,title,...}], capabilities:{cap:[ref]}}
 *   works/<ref>/             meta.json + content.json + installed + <ref>.works
 * 由 dsh-works CLI（list/search/show/uninstall）消费。本模块以同一格式
 * 把工作流组件登记为 `WORKS-local-flow-<id>` 作品（ref 对 WORKS-local-*
 * 直通，dsh-works parseWorkRef 原生兼容），使组件进入 dsh 原生资产体系：
 * CLI 可见、跨插件可见、.works 文件可再分发。
 *
 * 注册纪律：
 * - upsert 幂等（同 ref 覆盖，不动他人条目）；registry 原子写。
 * - .works 双段格式与 works-parser.mjs/validateWorksFormat 兼容
 *   （meta.name/brief/view.kind 必需；schema_version x.y.z）。
 * - code 段携带完整 DSL —— 作品自带执行体，可流转到任何装有
 *   dsh-flow-engine 的实例经 import_work 再物化。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// [基建正确使用] registry 属跨进程元数据（dsh-works CLI ↔ 本服务并发），
// 用 plugin-kit 的 fs-lock（快照于 shared/kit/util/fs-lock.mjs）互斥 + 原子写
import { withFileLock, writeJsonAtomic, readJson } from './shared/kit/util/fs-lock.mjs'

const WORK_CAPABILITY = 'flow.workflow'
const WORK_EMOJI = '🔀'

export function defaultStoreRoot() {
  return process.env.DSH_STORE_ROOT
    || path.join(process.env.HOME || process.env.USERPROFILE, '.dsh-store')
}

export function workRefFor(componentId) {
  return `WORKS-local-flow-${componentId}`
}

function registryFile(storeRoot) {
  return path.join(storeRoot, 'registry.json')
}

function readRegistry(storeRoot) {
  const f = registryFile(storeRoot)
  const reg = readJson(f, null)
  if (!reg) return { version: '1.0.0', works: [], capabilities: {} }
  reg.works = Array.isArray(reg.works) ? reg.works : []
  reg.capabilities = reg.capabilities && typeof reg.capabilities === 'object' ? reg.capabilities : {}
  return reg
}

function writeRegistry(storeRoot, reg) {
  fs.mkdirSync(storeRoot, { recursive: true })
  // 锁段 = 读-改-写全程（registry.lock 与 dsh-works 同目录约定；CLI 侧暂无锁，
  // 本侧锁可防服务多实例/对账与执行写之间的竞态）
  withFileLock(path.join(storeRoot, 'registry.lock'), () => {
    // 锁内重读合并：不覆盖锁窗口内他人写入的其他条目
    const latest = readRegistry(storeRoot)
    latest.works = mergeWorks(latest.works, reg.works)
    latest.capabilities = mergeCapabilities(latest.capabilities, reg)
    latest.updatedAt = new Date().toISOString()
    writeJsonAtomic(registryFile(storeRoot), latest)
  })
}

function mergeWorks(base, incoming) {
  const byRef = new Map(base.map((w) => [w.ref, w]))
  for (const w of incoming) byRef.set(w.ref, w)
  return [...byRef.values()]
}

function mergeCapabilities(base, reg) {
  const merged = { ...base }
  for (const w of reg.works) {
    for (const cap of w.capabilities || []) {
      const list = new Set(merged[cap] || [])
      list.add(w.ref)
      merged[cap] = [...list]
    }
  }
  return merged
}

/** 组件 → 作品 meta/code 对象（.works 双段格式的结构化真源） */
export function buildWorkflowMeta(comp) {
  return {
    name: comp.name || comp.id,
    emoji: WORK_EMOJI,
    brief: comp.description || `dsh 工作流组件 ${comp.id}`,
    view: { kind: 'workflow' },
    tags: Array.isArray(comp.tags) ? comp.tags.join(',') : String(comp.tags || ''),
    schema_version: '1.0.0',
    capabilities: [WORK_CAPABILITY],
    requires: {},
    flow: {
      id: comp.id,
      version: comp.version,
      dsl_kind: comp.dsl_kind,
      contract: comp.contract,
      requires: comp.requires,
    },
  }
}

export function buildWorkflowCode(comp) {
  return {
    kind: 'flow-workflow',
    id: comp.id,
    dsl_kind: comp.dsl_kind,
    dsl: comp.dsl,
    requires: comp.requires,
    contract: comp.contract,
    component_version: comp.version,
  }
}

/** 序列化为 .works 双段文本（与 dsh-works install 产物同构）。
 *  注意：DSL 文本本身可能含字面 %%%WORKS-XXX%%% 标记（如 W3230 的打包模板），
 *  双段边界只认"行首标记"，解析侧不得用简单 split 反解。 */
export function buildWorkflowWorksFile(comp) {
  const meta = buildWorkflowMeta(comp)
  const code = buildWorkflowCode(comp)
  return `%%%WORKS-META%%%\n${JSON.stringify(meta, null, 2)}\n\n%%%WORKS-CODE%%%\n${JSON.stringify(code, null, 2)}\n`
}

/**
 * 登记/更新一个组件作品。返回 { ref, created }。
 * @param {{ storeRoot?: string }} opts
 */
export function registerWork(comp, opts = {}) {
  const storeRoot = opts.storeRoot || defaultStoreRoot()
  const ref = workRefFor(comp.id)
  const workDir = path.join(storeRoot, 'works', ref)
  fs.mkdirSync(workDir, { recursive: true })

  const worksText = buildWorkflowWorksFile(comp)
  const meta = buildWorkflowMeta(comp)
  const code = buildWorkflowCode(comp)

  const existed = fs.existsSync(path.join(workDir, 'meta.json'))
  fs.writeFileSync(path.join(workDir, 'meta.json'), JSON.stringify(meta, null, 2))
  fs.writeFileSync(path.join(workDir, 'content.json'), JSON.stringify(code, null, 2))
  if (!existed) fs.writeFileSync(path.join(workDir, 'installed'), new Date().toISOString())
  fs.writeFileSync(path.join(workDir, `${ref}.works`), worksText)

  const reg = readRegistry(storeRoot)
  reg.works = reg.works.filter((w) => w.ref !== ref)
  reg.works.push({
    ref,
    type: 'workflow',
    title: meta.name,
    version: meta.schema_version,
    installed: true,
    installed_at: existed
      ? (reg.works.find((w) => w.ref === ref)?.installed_at || new Date().toISOString())
      : new Date().toISOString(),
    capabilities: [WORK_CAPABILITY],
    requires: {},
    flow: { id: comp.id, component_version: comp.version, dsl_kind: comp.dsl_kind },
  })
  const capList = reg.capabilities[WORK_CAPABILITY] || []
  if (!capList.includes(ref)) capList.push(ref)
  reg.capabilities[WORK_CAPABILITY] = capList
  writeRegistry(storeRoot, reg)
  return { ref, created: !existed }
}

export function unregisterWork(componentId, opts = {}) {
  const storeRoot = opts.storeRoot || defaultStoreRoot()
  const ref = workRefFor(componentId)
  const workDir = path.join(storeRoot, 'works', ref)
  if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true })
  let removed = false
  withFileLock(path.join(storeRoot, 'registry.lock'), () => {
    const reg = readRegistry(storeRoot)
    const before = reg.works.length
    reg.works = reg.works.filter((w) => w.ref !== ref)
    for (const cap of Object.keys(reg.capabilities)) {
      reg.capabilities[cap] = reg.capabilities[cap].filter((r) => r !== ref)
      if (reg.capabilities[cap].length === 0) delete reg.capabilities[cap]
    }
    removed = reg.works.length < before
    reg.updatedAt = new Date().toISOString()
    writeJsonAtomic(registryFile(storeRoot), reg)
  })
  return { ref, removed }
}

/** 组件仓 ↔ 作品注册表对账：把仓内组件全部登记（幂等），返回统计。 */
export function reconcileWorks(components, opts = {}) {
  const storeRoot = opts.storeRoot || defaultStoreRoot()
  const registered = []
  for (const comp of components) {
    const { ref, created } = registerWork(comp, { storeRoot })
    registered.push({ id: comp.id, ref, created })
  }
  return { storeRoot, count: registered.length, registered }
}

/** 枚举作品注册表里的工作流作品（type=workflow 且 content.kind=flow-workflow）。
 *  以 content.json 为真源——无论 ref 是本插件登记的 WORKS-local-flow-<id>
 *  还是经 dsh-works install 产生的 WORKS-local-<ts>，都能被识别。 */
export function listWorkflowWorks(opts = {}) {
  const storeRoot = opts.storeRoot || defaultStoreRoot()
  const reg = readRegistry(storeRoot)
  const out = []
  for (const entry of reg.works) {
    if (entry.type !== 'workflow') continue
    const contentFile = path.join(storeRoot, 'works', entry.ref, 'content.json')
    try {
      if (!fs.existsSync(contentFile)) continue
      const code = JSON.parse(fs.readFileSync(contentFile, 'utf8'))
      if (code?.kind !== 'flow-workflow' || !code.id || typeof code.dsl !== 'string') continue
      const metaFile = path.join(storeRoot, 'works', entry.ref, 'meta.json')
      const meta = fs.existsSync(metaFile)
        ? JSON.parse(fs.readFileSync(metaFile, 'utf8'))
        : {}
      out.push({
        ref: entry.ref,
        id: String(code.id),
        name: String(meta.name || code.id),
        description: String(meta.brief || ''),
        tags: typeof meta.tags === 'string' && meta.tags
          ? meta.tags.split(',').map((s) => s.trim()).filter(Boolean)
          : ['imported'],
        version: Number(code.component_version) || 1,
        dsl_kind: code.dsl_kind,
        dsl: code.dsl,
        requires: code.requires,
        contract: code.contract,
      })
    } catch { /* 损坏条目跳过 */ }
  }
  return out
}
