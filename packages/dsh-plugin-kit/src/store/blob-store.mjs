/**
 * 纯内容仓库：只负责按 sha256 存取不可变字节。
 *
 * 这里刻意不保存 manifest、不关心哪些文件属于同一个作品、不解释文件名。
 * 文件关系、归属、版本和生命周期全部由 workspace/manager.mjs 的中间层负责。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export class BlobStore {
  constructor({ root }) {
    if (!root) throw new Error('BlobStore 需要 root')
    this.root = path.resolve(root)
    this.objectsRoot = path.join(this.root, 'objects')
  }

  init() {
    fs.mkdirSync(this.objectsRoot, { recursive: true })
    return this
  }

  blobPath(hash) {
    if (!/^[a-f0-9]{64}$/.test(String(hash || ''))) throw new Error(`非法对象 hash: ${hash}`)
    return path.join(this.objectsRoot, hash.slice(0, 2), hash)
  }

  put(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')
    const file = this.blobPath(hash)
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
      fs.writeFileSync(tmp, buffer)
      try {
        fs.renameSync(tmp, file)
      } catch (error) {
        /* 并发写同一 hash 时目标可能已出现；目标有效就复用，绝不删除目标。 */
        if (fs.existsSync(file)) {
          try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
          return { hash, size: buffer.length }
        }
        try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
        throw error
      }
    }
    return { hash, size: buffer.length }
  }

  get(hash) {
    const data = fs.readFileSync(this.blobPath(hash))
    /* 内容寻址仓库的读取必须复核 sha256：截断/篡改对象不能静默使用。 */
    const actual = crypto.createHash('sha256').update(data).digest('hex')
    if (actual !== String(hash)) {
      throw new Error(`BlobStore 对象校验失败: ${hash} (actual ${actual})`)
    }
    return data
  }

  has(hash) {
    try { return fs.existsSync(this.blobPath(hash)) } catch { return false }
  }

  delete(hash) {
    const file = this.blobPath(hash)
    if (!fs.existsSync(file)) return false
    fs.rmSync(file, { force: true })
    return true
  }

  list() {
    const out = []
    let prefixes = []
    try {
      prefixes = fs.readdirSync(this.objectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      return out
    }
    for (const prefix of prefixes) {
      const dir = path.join(this.objectsRoot, prefix.name)
      for (const name of fs.readdirSync(dir)) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue
        const file = path.join(dir, name)
        out.push({ hash: name, size: fs.statSync(file).size })
      }
    }
    return out
  }

  /** 仓库只按中间层给的引用集合做物理清理，不自己判断文件关系。 */
  gc(referencedHashes, { minAgeMs = 0 } = {}) {
    const referenced = referencedHashes instanceof Set ? referencedHashes : new Set(referencedHashes || [])
    const cutoff = Date.now() - Math.max(0, Number(minAgeMs) || 0)
    let removed = 0
    let skipped = 0
    for (const { hash, size } of this.list()) {
      if (referenced.has(hash)) continue
      if (minAgeMs > 0) {
        try {
          if (fs.statSync(this.blobPath(hash)).mtimeMs > cutoff) { skipped++; continue }
        } catch { continue }
      }
      this.delete(hash)
      removed++
    }
    return { removed, skipped, referenced: referenced.size }
  }
}
