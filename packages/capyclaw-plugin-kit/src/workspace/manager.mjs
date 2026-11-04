/**
 * 文件关系中间层（Workspace / Catalog Manager）。
 *
 * 职责边界：
 *   BlobStore（store/blob-store.mjs）：只存对象，不认识文件名、作品、归属。
 *   WorkspaceManager（本文件）：解释“哪些对象属于同一个 work、谁能改、
 *   版本是多少、什么时候过期”，并生成可给 UI/生命周期管理读取的 catalog。
 *
 * 同一个 runtime 内的多个会话共享同一个 work；不同 runtime 通过 namespace
 * token 隔离。新建文件自动归入当前 work 的 manifest，不会串到别的 runtime。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BlobStore } from '../store/blob-store.mjs'
import { readJson, withFileLock, writeJsonAtomic } from '../util/fs-lock.mjs'
import { tuning } from '../tuning.mjs'

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const KEY_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@/+:-]{1,512}$/

export class WorkspaceConflictError extends Error {
  constructor(message = '内容版本冲突') {
    super(message)
    this.name = 'WorkspaceConflictError'
    this.code = 'ESTALE'
  }
}

export class WorkspaceAccessError extends Error {
  constructor(message = '没有访问该 runtime namespace 的权限') {
    super(message)
    this.name = 'WorkspaceAccessError'
    this.code = 'EACCES'
  }
}

export function assertId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new Error(`${label} 必须是 1-64 位小写字母/数字/._-: ${value}`)
  }
  return value
}

function assertKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new Error(`对象 key 非法: ${key}`)
  if (key === 'manifest.json') throw new Error('manifest.json 是中间层保留 key')
  return key
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left), 'hex')
  const b = Buffer.from(String(right), 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export class NamespaceRegistry {
  constructor({ storeRoot }) {
    this.storeRoot = path.resolve(storeRoot)
    this.dir = path.join(this.storeRoot, 'namespaces')
  }

  file(runtimeId) {
    return path.join(this.dir, `${assertId(runtimeId, 'runtimeId')}.json`)
  }

  create(runtimeId, { token, ttlSec = 0, quotaBytes = 0, meta = {} } = {}) {
    assertId(runtimeId, 'runtimeId')
    fs.mkdirSync(this.dir, { recursive: true })
    const secret = token || crypto.randomBytes(32).toString('hex')
    const now = new Date().toISOString()
    const record = {
      schemaVersion: 1,
      runtimeId,
      tokenHash: hashToken(secret),
      status: 'active',
      createdAt: now,
      lastAccessAt: now,
      ttlSec: Number(ttlSec) || 0,
      quotaBytes: Number(quotaBytes) || 0,
      meta: meta && typeof meta === 'object' ? meta : {},
    }
    writeJsonAtomic(this.file(runtimeId), record)
    return { runtimeId, token: secret, record }
  }

  read(runtimeId) {
    return readJson(this.file(runtimeId), null)
  }

  verify(runtimeId, token) {
    const record = this.read(runtimeId)
    if (!record || record.status !== 'active') throw new WorkspaceAccessError()
    if (!safeEqualHex(record.tokenHash, hashToken(token))) throw new WorkspaceAccessError()
    if (record.ttlSec > 0) {
      const last = Date.parse(record.lastAccessAt || record.createdAt)
      if (Date.now() - last > record.ttlSec * 1000) throw new WorkspaceAccessError('运行时 namespace 已过期')
    }
    return record
  }

  touch(runtimeId) {
    const record = this.read(runtimeId)
    if (!record) return
    record.lastAccessAt = new Date().toISOString()
    writeJsonAtomic(this.file(runtimeId), record)
  }

  remove(runtimeId) {
    fs.rmSync(this.file(runtimeId), { force: true })
  }
}

export class WorkspaceManager {
  /* journalMaxBytes 默认 512KB：与 JournalStore / FileStateBackend 的进化固化值
   * 保持一致（同构机制：原子 state + journal 轮转），尾读更快、磁盘更省。 */
  constructor({ storeRoot, blobStore = null, journalMaxBytes = 512 * 1024 }) {
    if (!storeRoot) throw new Error('WorkspaceManager 需要 storeRoot')
    this.storeRoot = path.resolve(storeRoot)
    this.blobs = blobStore || new BlobStore({ root: this.storeRoot }).init()
    this.namespaces = new NamespaceRegistry({ storeRoot: this.storeRoot })
    this.worksRoot = path.join(this.storeRoot, 'workspaces')
    this.catalogFile = path.join(this.storeRoot, 'catalog', 'works.json')
    this.locksRoot = path.join(this.storeRoot, 'locks')
    this.journalMaxBytes = Math.max(64 * 1024, Number(journalMaxBytes) || 512 * 1024)
    this._catalogTouched = new Map()
  }

  init() {
    fs.mkdirSync(this.worksRoot, { recursive: true })
    fs.mkdirSync(path.join(this.storeRoot, 'catalog'), { recursive: true })
    fs.mkdirSync(this.locksRoot, { recursive: true })
    return this
  }

  workDir(runtimeId, workId) {
    return path.join(this.worksRoot, assertId(runtimeId, 'runtimeId'), assertId(workId, 'workId'))
  }

  manifestFile(runtimeId, workId) {
    return path.join(this.workDir(runtimeId, workId), 'manifest.json')
  }

  lockFile(kind, runtimeId, workId = '') {
    const parts = [assertId(runtimeId, 'runtimeId'), workId ? assertId(workId, 'workId') : ''].filter(Boolean)
    return path.join(this.locksRoot, kind, ...parts) + '.lock'
  }

  emptyManifest(runtimeId, workId, title = '') {
    const now = new Date().toISOString()
    return {
      schemaVersion: 1,
      runtimeId,
      workId,
      title: title || workId,
      createdAt: now,
      updatedAt: now,
      version: 0,
      /* 中间层声明：这个 work 管哪些逻辑文件；allowNew 控制新 key 是否自动归属。 */
      declaration: {
        files: ['**'],
        allowNew: true,
        updatedAt: now,
      },
      files: {},
      meta: {},
    }
  }

  /**
   * 中间层声明一个 work 的文件范围。
   * files 支持精确 key、目录前缀（以 / 结尾）和 /** 前缀通配。
   * 声明本身不增加内容版本号；内容写入才增加 version。
   */
  declareWork(runtimeId, workId, { files = ['**'], allowNew = true, title = '', meta = {} } = {}) {
    assertId(runtimeId, 'runtimeId')
    assertId(workId, 'workId')
    if (!Array.isArray(files) || files.length === 0 || files.some((item) => typeof item !== 'string' || !item)) {
      throw new Error('declaration.files 必须是非空字符串数组')
    }
    return withFileLock(this.lockFile('works', runtimeId, workId), () => {
      const manifest = this.readManifest(runtimeId, workId) || this.emptyManifest(runtimeId, workId, title)
      manifest.title = title || manifest.title || workId
      manifest.declaration = {
        files: [...new Set(files)],
        allowNew: !!allowNew,
        updatedAt: new Date().toISOString(),
      }
      if (meta && typeof meta === 'object') manifest.meta = { ...(manifest.meta || {}), ...meta }
      manifest.updatedAt = new Date().toISOString()
      this.writeManifest(manifest, { catalog: true })
      return manifest
    })
  }

  assertDeclared(manifest, key) {
    const declaration = manifest?.declaration
    if (!declaration || !Array.isArray(declaration.files) || declaration.files.length === 0) return true
    const matched = declaration.files.some((pattern) => {
      if (pattern === '*' || pattern === '**') return true
      if (pattern.endsWith('/**')) return key.startsWith(pattern.slice(0, -2))
      if (pattern.endsWith('/')) return key.startsWith(pattern)
      return key === pattern
    })
    if (matched) return true
    if (declaration.allowNew) return true
    throw new WorkspaceAccessError(`文件 ${key} 不在 work ${manifest.workId} 的声明范围内`)
  }

  readManifest(runtimeId, workId) {
    return readJson(this.manifestFile(runtimeId, workId), null)
  }

  writeManifest(manifest, { catalog = false } = {}) {
    writeJsonAtomic(this.manifestFile(manifest.runtimeId, manifest.workId), manifest)
    const key = `${manifest.runtimeId}/${manifest.workId}`
    const last = this._catalogTouched.get(key) || 0
    /* catalog 是展示/生命周期索引，不是热路径事务日志：按节流间隔写一次，
     * 或在少数版本节点/显式操作时刷新，避免每次 state 保存都抢全局 catalog 锁。 */
    if (catalog || manifest.version <= 5 || manifest.version % 50 === 0 || Date.now() - last > tuning().catalogThrottleMs) {
      this.updateCatalog(manifest)
      this._catalogTouched.set(key, Date.now())
    }
    return manifest
  }

  /** catalog 损坏时按磁盘 manifest 重建，绝不能把坏文件当成空库覆盖。 */
  _readCatalogForUpdate() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.catalogFile, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const quarantine = `${this.catalogFile}.corrupt-${Date.now()}`
        try { fs.renameSync(this.catalogFile, quarantine) } catch { /* 忽略 */ }
        console.error(`[workspace] catalog 损坏，已隔离到 ${quarantine}，按 manifest 重建`)
      }
    }
    const works = {}
    let runtimes = []
    try { runtimes = fs.readdirSync(this.worksRoot, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { /* 空库 */ }
    for (const runtime of runtimes) {
      let entries = []
      try { entries = fs.readdirSync(path.join(this.worksRoot, runtime.name), { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const manifest = this.readManifest(runtime.name, entry.name)
        if (!manifest) continue
        const total = Object.values(manifest.files || {}).reduce((sum, item) => sum + (Number(item.size) || 0), 0)
        works[`${manifest.runtimeId}/${manifest.workId}`] = {
          runtimeId: manifest.runtimeId,
          workId: manifest.workId,
          title: manifest.title || '',
          version: manifest.version || 0,
          files: Object.keys(manifest.files || {}).length,
          size: total,
          createdAt: manifest.createdAt,
          updatedAt: manifest.updatedAt,
          declaration: manifest.declaration || null,
          meta: manifest.meta || {},
        }
      }
    }
    return { schemaVersion: 1, updatedAt: '', works }
  }

  updateCatalog(manifest) {
    withFileLock(path.join(this.locksRoot, 'catalog.lock'), () => {
      const catalog = this._readCatalogForUpdate()
      const total = Object.values(manifest.files || {}).reduce((sum, item) => sum + (Number(item.size) || 0), 0)
      catalog.works ||= {}
      catalog.works[`${manifest.runtimeId}/${manifest.workId}`] = {
        runtimeId: manifest.runtimeId,
        workId: manifest.workId,
        title: manifest.title || '',
        version: manifest.version || 0,
        files: Object.keys(manifest.files || {}).length,
        size: total,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        declaration: manifest.declaration || null,
        meta: manifest.meta || {},
      }
      catalog.updatedAt = new Date().toISOString()
      writeJsonAtomic(this.catalogFile, catalog)
    })
  }

  ensureWork(runtimeId, workId, { title = '', meta = {} } = {}) {
    assertId(runtimeId, 'runtimeId')
    assertId(workId, 'workId')
    const file = this.manifestFile(runtimeId, workId)
    if (fs.existsSync(file)) return this.readManifest(runtimeId, workId)
    return withFileLock(this.lockFile('works', runtimeId, workId), () => {
      /* 双重检查：两个实例同时初始化同一 work 时只允许一个写 v0。 */
      if (fs.existsSync(file)) return this.readManifest(runtimeId, workId)
      const manifest = this.emptyManifest(runtimeId, workId, title)
      manifest.meta = meta && typeof meta === 'object' ? meta : {}
      return this.writeManifest(manifest, { catalog: true })
    })
  }

  /** 中间层解释逻辑 key → 对象 hash；仓库只收到字节。 */
  put(runtimeId, workId, key, data, { expectedVersion = null, contentType = 'application/octet-stream', title = '' } = {}) {
    assertKey(key)
    this.ensureWork(runtimeId, workId, { title })
    return withFileLock(this.lockFile('works', runtimeId, workId), () => {
      const manifest = this.readManifest(runtimeId, workId) || this.emptyManifest(runtimeId, workId, title)
      if (expectedVersion != null && Number(expectedVersion) !== manifest.version) {
        throw new WorkspaceConflictError(`版本冲突: 当前 ${manifest.version}，期望 ${expectedVersion}`)
      }
      this.assertDeclared(manifest, key)
      const blob = this.blobs.put(data)
      const now = new Date().toISOString()
      manifest.files[key] = {
        blob: blob.hash,
        size: blob.size,
        contentType,
        updatedAt: now,
      }
      manifest.version = (manifest.version | 0) + 1
      manifest.updatedAt = now
      if (title) manifest.title = title
      this.writeManifest(manifest)
      return { key, blob: blob.hash, size: blob.size, version: manifest.version }
    })
  }

  get(runtimeId, workId, key, fallback = undefined) {
    assertKey(key)
    const manifest = this.readManifest(runtimeId, workId)
    if (!manifest || !manifest.files[key]) {
      if (fallback !== undefined) return fallback
      throw new Error(`对象不存在: ${runtimeId}/${workId}/${key}`)
    }
    return this.blobs.get(manifest.files[key].blob)
  }

  list(runtimeId, workId) {
    const manifest = this.readManifest(runtimeId, workId)
    return manifest ? Object.entries(manifest.files).map(([key, item]) => ({ key, ...item })) : []
  }

  delete(runtimeId, workId, key, { expectedVersion = null } = {}) {
    assertKey(key)
    return withFileLock(this.lockFile('works', runtimeId, workId), () => {
      const manifest = this.readManifest(runtimeId, workId)
      if (!manifest) throw new Error(`work 不存在: ${runtimeId}/${workId}`)
      if (expectedVersion != null && Number(expectedVersion) !== manifest.version) {
        throw new WorkspaceConflictError(`版本冲突: 当前 ${manifest.version}，期望 ${expectedVersion}`)
      }
      this.assertDeclared(manifest, key)
      delete manifest.files[key]
      manifest.version = (manifest.version | 0) + 1
      manifest.updatedAt = new Date().toISOString()
      this.writeManifest(manifest, { catalog: true })
      return { key, version: manifest.version }
    })
  }

  append(runtimeId, workId, key, text) {
    assertKey(key)
    return withFileLock(this.lockFile('works', runtimeId, workId), () => {
      const manifest = this.readManifest(runtimeId, workId) || this.emptyManifest(runtimeId, workId)
      this.assertDeclared(manifest, key)
      const now = new Date().toISOString()
      let current = Buffer.alloc(0)
      if (manifest.files[key]) current = this.blobs.get(manifest.files[key].blob)
      const extra = Buffer.from(text)
      /* journal 单文件超过阈值时轮转到 .1，避免每次 append 重写无上限增长的历史。 */
      if (key === 'journal.jsonl' && current.length && current.length + extra.length > this.journalMaxBytes) {
        const rotated = this.blobs.put(current)
        manifest.files['journal.jsonl.1'] = {
          blob: rotated.hash,
          size: rotated.size,
          contentType: 'text/plain; charset=utf-8',
          updatedAt: now,
        }
        current = Buffer.alloc(0)
      }
      const blob = this.blobs.put(Buffer.concat([current, extra]))
      manifest.files[key] = {
        blob: blob.hash,
        size: blob.size,
        contentType: 'text/plain; charset=utf-8',
        updatedAt: now,
      }
      manifest.version = (manifest.version | 0) + 1
      manifest.updatedAt = now
      this.writeManifest(manifest)
      return { key, blob: blob.hash, size: blob.size, version: manifest.version }
    })
  }

  tail(runtimeId, workId, key, limit = 8) {
    try {
      const text = this.get(runtimeId, workId, key).toString('utf8').trim()
      if (!text) return []
      return text.split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => {
        try { return JSON.parse(line) } catch { return { type: 'invalid', raw: line.slice(0, 120) } }
      })
    } catch {
      return []
    }
  }

  /** 从磁盘 manifest 重建 catalog；用于 CLI/UI 读取前刷新最终一致性索引。 */
  refreshCatalog({ runtimeId = '' } = {}) {
    const works = []
    let runtimes = []
    try { runtimes = fs.readdirSync(this.worksRoot, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { return works }
    for (const runtime of runtimes) {
      if (runtimeId && runtime.name !== runtimeId) continue
      let entries = []
      try { entries = fs.readdirSync(path.join(this.worksRoot, runtime.name), { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const manifest = this.readManifest(runtime.name, entry.name)
        if (!manifest) continue
        this.updateCatalog(manifest)
        works.push(manifest)
      }
    }
    return works
  }

  listWorks({ runtimeId = '' } = {}) {
    const catalog = readJson(this.catalogFile, null)
    if (catalog && catalog.works) {
      return Object.values(catalog.works)
        .filter((item) => !runtimeId || item.runtimeId === runtimeId)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    }
    const works = []
    let runtimes = []
    try { runtimes = fs.readdirSync(this.worksRoot, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { /* 空库 */ }
    for (const runtime of runtimes) {
      if (runtimeId && runtime.name !== runtimeId) continue
      let entries = []
      try { entries = fs.readdirSync(path.join(this.worksRoot, runtime.name), { withFileTypes: true }) } catch { /* 忽略 */ }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const manifest = this.readManifest(runtime.name, entry.name)
        if (manifest) works.push(manifest)
      }
    }
    return works
  }

  referencedHashes() {
    const referenced = new Set()
    for (const summary of this.listWorks()) {
      const manifest = this.readManifest(summary.runtimeId, summary.workId)
      for (const item of Object.values(manifest?.files || {})) if (item?.blob) referenced.add(item.blob)
    }
    return referenced
  }

  gc({ minAgeMs = 60000 } = {}) {
    return withFileLock(path.join(this.locksRoot, 'gc.lock'), () => {
      /* 刚写入的 blob 可能还没写进 manifest；留出宽限期防止 GC 与 put 竞态。 */
      return this.blobs.gc(this.referencedHashes(), { minAgeMs })
    })
  }

  removeWork(runtimeId, workId) {
    fs.rmSync(this.workDir(runtimeId, workId), { recursive: true, force: true })
    withFileLock(path.join(this.locksRoot, 'catalog.lock'), () => {
      const catalog = this._readCatalogForUpdate()
      delete catalog.works?.[`${runtimeId}/${workId}`]
      catalog.updatedAt = new Date().toISOString()
      writeJsonAtomic(this.catalogFile, catalog)
    })
  }

  removeRuntime(runtimeId) {
    assertId(runtimeId, 'runtimeId')
    fs.rmSync(path.join(this.worksRoot, runtimeId), { recursive: true, force: true })
    this.namespaces.remove(runtimeId)
    withFileLock(path.join(this.locksRoot, 'catalog.lock'), () => {
      const catalog = this._readCatalogForUpdate()
      for (const key of Object.keys(catalog.works || {})) {
        if (key.startsWith(`${runtimeId}/`)) delete catalog.works[key]
      }
      catalog.updatedAt = new Date().toISOString()
      writeJsonAtomic(this.catalogFile, catalog)
    })
  }
}

/** 绑定到单个 runtime / work 的客户端；每次操作校验 namespace token。 */
export class WorkspaceClient {
  constructor({ manager, runtimeId, token, workId = 'main' } = {}) {
    /* 结构化契约：允许同版本 kit 快照跨包提供 manager，不依赖类身份。 */
    if (!manager || typeof manager.put !== 'function' || typeof manager.readManifest !== 'function') {
      throw new Error('WorkspaceClient 需要 WorkspaceManager 兼容实现')
    }
    this.manager = manager
    this.runtimeId = assertId(runtimeId, 'runtimeId')
    this.token = token
    this.workId = assertId(workId, 'workId')
    this._verifiedAt = 0
    this._verify(true)
  }

  _verify(force = false) {
    const now = Date.now()
    if (!force && this._verifiedAt && now - this._verifiedAt < tuning().tokenVerifyCacheMs) return
    this.manager.namespaces.verify(this.runtimeId, this.token)
    this.manager.namespaces.touch(this.runtimeId)
    this._verifiedAt = now
  }

  ensureWork(workId = this.workId, options = {}) {
    this._verify()
    return this.manager.ensureWork(this.runtimeId, workId, options)
  }

  put(workId, key, data, options = {}) {
    this._verify()
    return this.manager.put(this.runtimeId, workId, key, data, options)
  }

  putJson(workId, key, value, options = {}) {
    return this.put(workId, key, Buffer.from(JSON.stringify(value)), {
      contentType: 'application/json; charset=utf-8',
      ...options,
    })
  }

  get(workId, key, fallback = undefined) {
    this._verify()
    return this.manager.get(this.runtimeId, workId, key, fallback)
  }

  getJson(workId, key, fallback = undefined) {
    const data = this.get(workId, key, fallback === undefined ? undefined : Buffer.from(JSON.stringify(fallback)))
    if (data === undefined) return undefined
    try { return JSON.parse(data.toString('utf8')) } catch { return fallback }
  }

  list(workId) {
    this._verify()
    return this.manager.list(this.runtimeId, workId)
  }

  delete(workId, key, options = {}) {
    this._verify()
    return this.manager.delete(this.runtimeId, workId, key, options)
  }

  append(workId, key, text) {
    this._verify()
    return this.manager.append(this.runtimeId, workId, key, text)
  }

  tail(workId, key, limit = 8) {
    this._verify()
    return this.manager.tail(this.runtimeId, workId, key, limit)
  }

  manifest(workId = this.workId) {
    this._verify()
    return this.manager.readManifest(this.runtimeId, workId)
  }

  listWorks() {
    this._verify()
    return this.manager.listWorks({ runtimeId: this.runtimeId })
  }
}

/** 插件的 JournalStore 持久化接口 → 中间层 workspace。 */
export class WorkspaceBackend {
  constructor({ client, workId = 'main', journalPath = null }) {
    /* 结构化契约：workspace-service 可能来自另一份 kit 快照。 */
    if (!client || typeof client.put !== 'function' || typeof client.getJson !== 'function') {
      throw new Error('WorkspaceBackend 需要 WorkspaceClient 兼容实现')
    }
    this.client = client
    this.workId = workId
    this.journalPath = journalPath || null
    this.stateKey = 'state.json'
    this.journalKey = 'journal.jsonl'
    this.checkpointPrefix = 'checkpoints/'
  }

  readState() {
    return this.client.getJson(this.workId, this.stateKey, null)
  }

  writeState(doc) {
    const result = this.client.putJson(this.workId, this.stateKey, doc)
    return { ...result, stateKey: this.stateKey }
  }

  appendJournal(event) {
    try {
      this.client.append(this.workId, this.journalKey, JSON.stringify({ ...event, ts: Date.now() / 1000 }) + '\n')
    } catch { /* journal 失败不阻塞主状态 */ }
  }

  journalTail(limit = 8) {
    const parse = (text) => String(text || '').trim().split(/\r?\n/).filter(Boolean)
    const lines = []
    for (const key of ['journal.jsonl.1', 'journal.jsonl']) {
      try {
        const data = this.client.get(this.workId, key, null)
        if (data) lines.push(...parse(data.toString('utf8')))
      } catch { /* 轮转文件可能不存在 */ }
    }
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line) } catch { return { type: 'invalid', raw: line.slice(0, 120) } }
    })
  }

  writeCheckpoint(name, payload) {
    const key = `${this.checkpointPrefix}${name}.json`
    this.client.putJson(this.workId, key, payload)
    this.appendJournal({ type: 'checkpoint', name })
    return { name, createdAt: payload.createdAt, meta: payload.meta || {} }
  }

  listCheckpoints() {
    return this.client.list(this.workId)
      .filter((item) => item.key.startsWith(this.checkpointPrefix) && item.key.endsWith('.json'))
      .map((item) => {
        try {
          const payload = this.client.getJson(this.workId, item.key)
          if (!payload) return null
          return {
            name: payload.name,
            seq: payload.seq,
            appliedSeq: payload.appliedSeq,
            pending: !!payload.pending,
            title: payload.title,
            slides: payload.slides,
            createdAt: payload.createdAt,
            meta: payload.meta || {},
          }
        } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  readCheckpoint(name) {
    const key = `${this.checkpointPrefix}${name}.json`
    const payload = this.client.getJson(this.workId, key, null)
    if (!payload || !payload.deck) throw new Error('checkpoint 内容损坏: ' + name)
    return payload
  }
}
