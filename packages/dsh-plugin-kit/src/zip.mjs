/**
 * 极简跨平台 ZIP 读写（store + deflate 读，store 写；无外部依赖）——全仓单一真源。
 *
 * 之前三处实现各持一份（plugin-development 写 / tools-plugin-release 读 /
 * dsh-suite-kit zip-read 读），本模块合并之。旧位置保留兼容 shim。
 *
 * 写入：store 模式（内容不压缩，跨平台稳定，产物可被任何标准读取器读）。
 * 读取：支持 store(0) 与 deflate(8)；接受 Buffer 或文件路径——本地文件与
 * 远端下载源共用同一条校验/解包路径。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/* ------------------------------------------------------------------ 写入 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f)
  const day = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

function walkFiles(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full, base))
    else if (entry.isFile()) out.push(path.relative(base, full).replace(/\\/g, '/'))
  }
  return out.sort()
}

/** 把目录写成 store 模式 ZIP。返回打包的相对路径列表。 */
export function writeZipFromDir(sourceDir, outFile) {
  const files = walkFiles(sourceDir)
  const now = dosDateTime()
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const name of files) {
    const data = fs.readFileSync(path.join(sourceDir, name))
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(now.time, 10)
    local.writeUInt16LE(now.day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBytes, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(now.time, 12)
    central.writeUInt16LE(now.day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBytes)

    offset += local.length + nameBytes.length + data.length
  }

  const centralBuffer = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, Buffer.concat([...localParts, centralBuffer, eocd]))
  return files
}

/* ------------------------------------------------------------------ 读取 */

function locateEocd(data, label) {
  for (let i = data.length - 22; i >= 0; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error(`不是有效的 ZIP: ${label}`)
}

/**
 * 列出 ZIP 全部条目名。
 * @param {Buffer|string} input - ZIP 字节或文件路径
 */
export function listZipEntryNames(input, label = 'zip') {
  const data = Buffer.isBuffer(input) ? input : fs.readFileSync(input)
  const eocd = locateEocd(data, label)
  const count = data.readUInt16LE(eocd + 10)
  let offset = data.readUInt32LE(eocd + 16)
  const names = []
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error(`ZIP 中央目录损坏: ${label}`)
    const nameLength = data.readUInt16LE(offset + 28)
    const extraLength = data.readUInt16LE(offset + 30)
    const commentLength = data.readUInt16LE(offset + 32)
    names.push(data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return names
}

/**
 * 从 ZIP 读单个条目的原始字节；不存在返回 undefined。
 * @param {Buffer|string} input - ZIP 字节或文件路径
 */
export function readZipEntryBuffer(input, entryName, label = 'zip') {
  const data = Buffer.isBuffer(input) ? input : fs.readFileSync(input)
  const eocd = locateEocd(data, label)
  const count = data.readUInt16LE(eocd + 10)
  let offset = data.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error(`ZIP 中央目录损坏: ${label}`)
    const method = data.readUInt16LE(offset + 10)
    const compSize = data.readUInt32LE(offset + 20)
    const nameLength = data.readUInt16LE(offset + 28)
    const extraLength = data.readUInt16LE(offset + 30)
    const commentLength = data.readUInt16LE(offset + 32)
    const localOffset = data.readUInt32LE(offset + 42)
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (name === entryName) {
      const localNameLength = data.readUInt16LE(localOffset + 26)
      const localExtraLength = data.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + localNameLength + localExtraLength
      const body = data.subarray(start, start + compSize)
      if (method === 0) return body
      if (method === 8) return zlib.inflateRawSync(body)
      throw new Error(`不支持的 ZIP 压缩方式 ${method}: ${label}`)
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  return undefined
}

/** 读取 ZIP 中央目录条目名（文件路径版；打包自检/测试用）。 */
export function listZipEntries(file) {
  return listZipEntryNames(fs.readFileSync(file), file)
}
