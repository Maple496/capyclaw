/**
 * profile `cordis.patch.yml` 的「受管区块」读写。
 *
 * 背景：dsh 会按固定顺序叠加 patch 层，profile 的 `cordis.patch.yml` 是用户层。
 * 启动器（dshd）需要往这一层注入 stack 声明的插件参数，但不能覆盖用户手写的内容。
 *
 * 方案：用一个带标记的区块承载生成内容，区块外原样保留。
 *
 *   # >>> dshd:managed（由 stack.plugins.configs 生成，勿手改）
 *   - id: launchpad-host
 *     name: "@capyclaw/launchpad"
 *     config:
 *       port: 39700
 *   # <<< dshd:managed
 *
 * 没有区块时：追加到文件末尾（保留原有内容）。
 */
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

export const BEGIN_MARK = '# >>> dshd:managed'
export const END_MARK = '# <<< dshd:managed'
const BEGIN_RE = /^# >>> dshd:managed.*$/m
const END_RE = /^# <<< dshd:managed.*$/m

/** 把 patch 行数组序列化成带标记的区块文本。 */
export function renderManagedBlock(rows) {
  const body = rows.length
    ? yaml.dump(rows, { lineWidth: 120, noRefs: true })
    : '[]\n'
  return `${BEGIN_MARK}（由 stack.plugins.configs 生成，勿手改）\n${body}${END_MARK}\n`
}

/** 读取文件中的受管区块（不存在返回 null）。 */
export function readManagedBlock(text) {
  const begin = text.match(BEGIN_RE)
  const end = text.match(END_RE)
  if (!begin || !end) return null
  const start = begin.index + begin[0].length
  const stop = end.index
  if (stop < start) return null
  return text.slice(start, stop)
}

/** 解析受管区块为 patch 行数组（空区块 → []）。 */
export function parseManagedBlock(block) {
  if (block == null) return null
  const trimmed = block.trim()
  if (!trimmed) return []
  try {
    const parsed = yaml.load(trimmed)
    if (parsed == null) return []
    if (!Array.isArray(parsed)) throw new Error('受管区块必须是 YAML 数组')
    return parsed
  } catch (error) {
    throw new Error(`受管区块解析失败: ${error.message}`)
  }
}

/**
 * 把新的受管区块写进文件，保留区块外内容。
 * @param {string} file
 * @param {Array} rows
 * @returns {{ changed: boolean, created: boolean }}
 */
export function writeManagedBlock(file, rows) {
  const block = renderManagedBlock(rows)
  const exists = fs.existsSync(file)
  const before = exists ? fs.readFileSync(file, 'utf8') : ''
  let after
  if (!exists) {
    after = `# dsh profile patch（用户覆盖层）\n${block}`
  } else {
    const begin = before.match(BEGIN_RE)
    const end = before.match(END_RE)
    if (begin && end && end.index > begin.index) {
      const start = begin.index
      const stop = end.index + end[0].length
      // 末尾可能紧贴换行
      const tailStart = before[stop] === '\n' ? stop + 1 : stop
      after = before.slice(0, start) + block + before.slice(tailStart)
    } else if (!before.trim()) {
      after = `# dsh profile patch（用户覆盖层）\n${block}`
    } else {
      const sep = before.endsWith('\n') ? '' : '\n'
      after = `${before}${sep}\n${block}`
    }
  }
  if (after === before) return { changed: false, created: false }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, after, 'utf8')
  fs.renameSync(tmp, file)
  return { changed: true, created: !exists }
}
