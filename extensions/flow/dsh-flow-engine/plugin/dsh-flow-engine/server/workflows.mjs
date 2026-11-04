/**
 * 工作流组件仓 —— "工作流 = 插件内组件"的落地面。
 *
 * 一组件一文件：<workflowsDir>/<id>.workflow.json
 * {
 *   id: 'deck-curator', name: '演示文稿策展', version: 1,
 *   tags: ['ppt','generation'], description: '…',
 *   contract: { input: 'string', output: 'string' },
 *   requires: { llm: true, platform_api: false, subflows: [] },  // save 时自动推导
 *   dsl: '<DSL 文本（v3 JSON 或 YAML pipeline）>',
 *   source: { kind: 'fixture'|'authored', work_id?, note? }
 * }
 *
 * 组件被引用：执行器 flow 节点按 id 回调宿主 /api/flow/subflow 递归执行；
 * 组件被调用：flow_engine_invoke(workflow_id, input)；组件被创建：
 * flow_engine_save_workflow（先过执行器结构校验再入仓）。
 */
import fs from 'node:fs'
import path from 'node:path'

const SLUG_RE = /^[a-z][a-z0-9-]{1,47}$/

/** 从 DSL 推导依赖清单（llm / platform_api / 子工作流引用） */
export function deriveRequires(dsl) {
  const requires = { llm: false, platform_api: false, subflows: [] }
  requires.llm = /["']?type["']?\s*:\s*["']?(llm|agent|react|rag)\b/.test(dsl)
  requires.platform_api = /\{\{\s*platform_api_url\s*\}\}/.test(dsl)
  const subflows = new Set()
  // JSON 形：解析后扫 flow 节点；解析失败退回正则（YAML 形）
  try {
    const doc = JSON.parse(dsl)
    for (const n of doc.nodes || []) {
      if (n.type === 'flow' && n.workflow_id) subflows.add(String(n.workflow_id))
    }
  } catch {
    for (const m of dsl.matchAll(/workflow_id:\s*([A-Za-z0-9_-]+)/g)) subflows.add(m[1])
  }
  requires.subflows = [...subflows].sort()
  return requires
}

export function createWorkflowStore({ dir, log = () => {}, onSave = null, onRemove = null }) {
  fs.mkdirSync(dir, { recursive: true })

  const fileOf = (id) => path.join(dir, `${id}.workflow.json`)

  function read(id) {
    const f = fileOf(id)
    if (!fs.existsSync(f)) return null
    try {
      const comp = JSON.parse(fs.readFileSync(f, 'utf8'))
      return comp && comp.id === id ? comp : null
    } catch {
      return null
    }
  }

  /** 全量组件（含 DSL）——作品对账用 */
  function allWithDsl() {
    const out = []
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.workflow.json')).sort()) {
      try {
        const comp = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        if (comp && comp.id && typeof comp.dsl === 'string') out.push(comp)
      } catch { /* 损坏文件跳过 */ }
    }
    return out
  }

  function listMeta() {
    const out = []
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.workflow.json')).sort()) {
      try {
        const comp = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        const { dsl, ...meta } = comp
        meta.dsl_kind = /^\s*\{/.test(String(dsl || '')) ? 'json' : 'yaml'
        meta.dsl_bytes = Buffer.byteLength(String(dsl || ''), 'utf8')
        out.push(meta)
      } catch { out.push({ id: f, error: '组件文件损坏' }) }
    }
    return out
  }

  function save({ id, name, tags, description, contract, dsl, source }) {
    if (!SLUG_RE.test(String(id || ''))) {
      throw new Error(`组件 id 非法（需 ${SLUG_RE.source}）: ${id}`)
    }
    const text = String(dsl ?? '').trim()
    if (!text) throw new Error('dsl 不能为空')
    if (Buffer.byteLength(text, 'utf8') > 20 * 1024 * 1024) throw new Error('DSL 超 20MB 限额')
    const prev = read(id)
    const comp = {
      id,
      name: String(name || id),
      version: (prev?.version || 0) + 1,
      tags: Array.isArray(tags) ? tags.map(String).slice(0, 8) : [],
      description: String(description || '').slice(0, 300),
      contract: {
        input: contract?.input || 'string',
        output: contract?.output || 'string',
      },
      requires: deriveRequires(text),
      dsl: text,
      source: source || prev?.source || { kind: 'authored' },
      updated_at: new Date().toISOString(),
    }
    // 原子写：tmp + rename
    const tmp = `${fileOf(id)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(comp, null, 1), 'utf8')
    fs.renameSync(tmp, fileOf(id))
    log(`组件入仓: ${id} v${comp.version}（requires.llm=${comp.requires.llm}, subflows=${comp.requires.subflows.length}）`)
    // 作品体系登记（dsh-works 可见；失败即报错——登记是保存的一部分）
    if (onSave) onSave(comp)
    const { dsl: _omit, ...meta } = comp
    return meta
  }

  function remove(id) {
    const f = fileOf(id)
    if (!fs.existsSync(f)) return false
    fs.unlinkSync(f)
    log(`组件移除: ${id}`)
    if (onRemove) onRemove(id)
    return true
  }

  /** 外来物化（works → 组件，反向对账专用）：直接落仓不走 onSave 钩子
   *  （作品的 works 条目已存在，再登记会为 CLI 安装的外来 ref 造出重复条目）。
   *  组件已存在 = 跳过（执行真源在组件仓；刷新请走显式 import_work）。 */
  function materialize(comp) {
    if (!comp?.id || typeof comp.dsl !== 'string' || !comp.dsl.trim()) {
      return { id: comp?.id, skipped: true, reason: 'bad_payload' }
    }
    if (!SLUG_RE.test(String(comp.id))) {
      return { id: comp.id, skipped: true, reason: `bad_id（需 ${SLUG_RE.source}）` }
    }
    if (read(comp.id)) {
      return { id: comp.id, skipped: true, reason: 'exists' }
    }
    const full = {
      id: comp.id,
      name: String(comp.name || comp.id).slice(0, 60),
      version: Number(comp.version) || 1,
      tags: Array.isArray(comp.tags) ? comp.tags.slice(0, 8) : ['imported'],
      description: String(comp.description || '').slice(0, 300),
      contract: {
        input: comp.contract?.input || 'string',
        output: comp.contract?.output || 'string',
      },
      requires: deriveRequires(comp.dsl),
      dsl: comp.dsl.trim(),
      source: { kind: 'work', note: 'dsh-works 作品物化' },
      updated_at: new Date().toISOString(),
    }
    const tmp = `${fileOf(comp.id)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(full, null, 1), 'utf8')
    fs.renameSync(tmp, fileOf(comp.id))
    log(`作品物化: ${comp.id}（来自作品注册表）`)
    const { dsl: _omit, ...meta } = full
    return { id: comp.id, skipped: false, meta }
  }

  /** 从平台 fixtures 播种（幂等：已存在 id 跳过） */
  function seedFromFixtures(fixturesDir) {
    if (!fs.existsSync(fixturesDir)) return { seeded: [], skipped: 0 }
    const seeded = []
    let skipped = 0
    for (const f of fs.readdirSync(fixturesDir).filter((n) => n.endsWith('.json')).sort()) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8'))
        const id = `platform-w${j.work_id}`
        if (read(id)) { skipped += 1; continue }
        save({
          id,
          name: String(j.meta?.name || id).slice(0, 60),
          tags: ['platform', j.dsl_kind || 'json'],
          description: String(j.meta?.description || '').slice(0, 300),
          dsl: String(j.dsl_raw || ''),
          source: {
            kind: 'fixture',
            work_id: j.work_id,
            note: `平台作品 W${j.work_id}@v${j.version} 快照${j.meta?.decorator ? '，含装饰器外壳（dsh 侧未投递 decorator）' : ''}`,
          },
        })
        seeded.push(id)
      } catch { skipped += 1 }
    }
    return { seeded, skipped }
  }

  return { listMeta, read, allWithDsl, save, remove, materialize, seedFromFixtures, dir }
}
