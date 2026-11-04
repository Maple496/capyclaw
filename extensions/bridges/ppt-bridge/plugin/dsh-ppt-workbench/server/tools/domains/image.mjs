/** 图片域：字节嗅探 / 尺寸解析 / 聊天附件定位（实际落盘由 assets 端口负责）。 */
import fs from 'node:fs'
import path from 'node:path'

export function imageMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

export function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf.length > 24) {
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
  }
  if (buf.slice(0, 3).toString('ascii') === 'GIF' && buf.length > 10) {
    return [buf.readUInt16LE(6), buf.readUInt16LE(8)]
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 8 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const m = buf[i + 1]
      i += 2
      if (m === 0xd8 || m === 0xd9 || m === 0x01) continue
      const len = buf.readUInt16BE(i)
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(m)) {
        return [buf.readUInt16BE(i + 5), buf.readUInt16BE(i + 3)]
      }
      i += len
    }
  }
  return null
}

export function resolveAttachmentFile(id) {
  const hex = String(id || '').replace(/^sha256:/i, '')
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('attachment_id 必须是 sha256:<64位hex>')
  const roots = []
  if (process.env.DSH_HOME) roots.push(path.join(process.env.DSH_HOME, 'attachments', 'v1', 'objects'))
  if (process.env.DSH_ATTACHMENTS_DIR) roots.push(process.env.DSH_ATTACHMENTS_DIR)
  if (process.env.USERPROFILE) roots.push(path.join(process.env.USERPROFILE, '.dsh', 'attachments', 'v1', 'objects'))
  for (const root of roots) {
    const p = path.join(root, hex.slice(0, 2), hex)
    if (fs.existsSync(p)) return p
  }
  throw new Error('找不到聊天附件：' + id + '（请在聊天里重新粘贴图片）')
}
