/**
 * Works 静态分发源：schema 1 的 index.json + zip + sha256。
 *
 * 与 tools/plugin-release 的源格式同一封装（file/sha256/size）——works 与插件包共用
 * 一套索引语义，桌面后端（works_plugins.py）与 CLI（dsh-works）消费同一种源。
 *
 * 分发闭环：发布侧产出 index.json+zip → `dsh-works install <name> --from <源>` 下载/
 * 读取 → sha256/size 强校验 → 解包提取 .works → 落本地注册表。
 * 远端注册表（P3 平台端）上线后，`--from`/DSH_WORKS_SOURCE 指向平台 URL 即切换，
 * 客户端零改动。
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { listZipEntryNames, readZipEntryBuffer } from './zip-read.mjs'

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value)
}

/** 读 index.json。source 可为本地 index.json 路径、含 index.json 的目录、或 http(s) URL。返回 { index, base }。 */
export async function loadSourceIndex(source) {
  if (isHttpUrl(source)) {
    const res = await fetch(source)
    if (!res.ok) throw new Error(`源不可达（HTTP ${res.status}）: ${source}`)
    const index = await res.json()
    return { index, base: source }
  }
  const abs = isAbsolute(source) ? source : resolve(source)
  const file = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? join(abs, 'index.json') : abs
  if (!fs.existsSync(file)) throw new Error(`源缺少 index.json: ${file}`)
  let index
  try {
    index = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`index.json 解析失败: ${file} — ${error.message}`)
  }
  return { index, base: file }
}

/** index 形状校验（与 readIndex 语义一致）。 */
export function assertIndexShape(index, label = 'index.json') {
  if (!index || index.schema !== 1 || !Array.isArray(index.plugins)) {
    throw new Error(`index.json 形状不合法（schema 必须是 1，plugins 必须是数组）: ${label}`)
  }
}

/** 选条目：显式版本优先，否则 latest，否则首个。 */
export function pickWorksEntry(index, name, version) {
  const candidates = index.plugins.filter((item) => item.name === name)
  if (!candidates.length) throw new Error(`源里没有作品: ${name}`)
  if (version) {
    const hit = candidates.find((item) => item.version === version)
    if (!hit) throw new Error(`源里没有 ${name}@${version}`)
    return hit
  }
  return candidates.find((item) => item.latest) || candidates[0]
}

/** 取条目 zip 字节（本地相对/绝对路径或 URL），并强校验 sha256 与 size。 */
export async function fetchEntryBytes(base, entry) {
  let bytes
  if (isHttpUrl(base)) {
    const zipUrl = isHttpUrl(entry.file) ? entry.file : new URL(entry.file, base).href
    const res = await fetch(zipUrl)
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）: ${zipUrl}`)
    bytes = Buffer.from(await res.arrayBuffer())
  } else {
    const zipPath = isAbsolute(entry.file) ? entry.file : resolve(dirname(base), entry.file)
    if (!fs.existsSync(zipPath)) throw new Error(`条目文件不存在: ${zipPath}`)
    bytes = fs.readFileSync(zipPath)
  }
  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  if (entry.sha256 && digest !== String(entry.sha256).toLowerCase()) {
    throw new Error(`sha256 校验失败: 期望 ${entry.sha256}，实际 ${digest}`)
  }
  if (entry.size != null && bytes.length !== entry.size) {
    throw new Error(`size 校验失败: 期望 ${entry.size}，实际 ${bytes.length}`)
  }
  return bytes
}

/** 从 zip 字节提取全部 .works 条目 → [{ name, content }]。 */
export function extractWorksFiles(bytes, label = 'zip') {
  const names = listZipEntryNames(bytes, label).filter((name) => name.endsWith('.works'))
  return names.map((name) => ({ name, content: readZipEntryBuffer(bytes, name, label).toString('utf8') }))
}
