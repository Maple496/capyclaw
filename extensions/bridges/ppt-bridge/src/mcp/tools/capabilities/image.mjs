/** 图片能力：图片先进入对象仓库，deck 只保存 /assets/<sha256> 引用。 */
import fs from 'node:fs'
import { imageMime, imageSize, resolveAttachmentFile } from '../domains/image.mjs'
import { IMAGE_MAX_BYTES, describeImageFailure, downloadImage } from '../domains/remote-image.mjs'
import { clamp, okText } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

const MAX_MB = Math.round(IMAGE_MAX_BYTES / 1024 / 1024)
const TOO_LARGE_HINT = `图片过大（>${MAX_MB}MB），请先压缩后再插入`

function readLocalImage(file) {
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw new Error('图片路径不是文件：' + file)
  if (stat.size > IMAGE_MAX_BYTES) throw new Error(TOO_LARGE_HINT)
  return fs.readFileSync(file)
}

async function insertImage(ctx, spec) {
  const { slide, attachment_id, attachmentId, path: filePath, src, left, top, width, height } = spec || {}
  const i = clamp(Number(slide == null ? 0 : slide) | 0, 0, 999)
  const aid = attachment_id || attachmentId
  let buf = null
  let assetUrl = ''
  let dataUrl = ''
  let natW = 0, natH = 0
  if (aid) {
    const p = resolveAttachmentFile(aid)
    buf = readLocalImage(p)
  } else if (filePath) {
    if (!fs.existsSync(String(filePath))) throw new Error('图片文件不存在：' + filePath)
    buf = readLocalImage(String(filePath))
  } else if (src) {
    const s = String(src)
    if (/^https?:/i.test(s)) {
      if (/\/assets\/[a-f0-9]{64}$/i.test(s)) {
        assetUrl = s
      } else {
        /* 远程图不能直接把 URL 丢给编辑器：先下载并验证是图片，再进入对象仓库。 */
        try {
          const fetched = await downloadImage(s)
          buf = fetched.buf
        } catch (error) {
          throw new Error(describeImageFailure(error, s))
        }
      }
    } else if (/^data:image\//i.test(s)) {
      const comma = s.indexOf(',')
      if (comma < 0) throw new Error('data URL 不合法')
      /* 先按 base64 长度粗判，避免解码超大字符串造成瞬时内存峰值。 */
      if (s.length > Math.ceil(IMAGE_MAX_BYTES * 4 / 3) + 128) throw new Error(TOO_LARGE_HINT)
      buf = Buffer.from(s.slice(comma + 1), 'base64')
      if (buf.length > IMAGE_MAX_BYTES) throw new Error(TOO_LARGE_HINT)
    } else if (/^\/assets\/[a-f0-9]{64}$/i.test(s)) {
      assetUrl = s
    } else if (fs.existsSync(s)) {
      buf = readLocalImage(s)
    } else {
      throw new Error('src 既不是 http(s)/data URL，也不是存在的文件：' + s.slice(0, 120))
    }
  } else {
    throw new Error('ppt_image 需要 attachment_id / path / src 之一')
  }
  if (buf) {
    if (buf.length > IMAGE_MAX_BYTES) throw new Error(TOO_LARGE_HINT)
    const mime = imageMime(buf)
    if (!mime) throw new Error('不支持的图片格式（仅 PNG/JPEG/GIF/WebP）')
    if (process.env.PPT_ASSET_STORE === '1') {
      const asset = await ctx.assets.put(buf, mime)
      assetUrl = asset.url
    } else {
      dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    }
    const sz = imageSize(buf)
    if (sz) { natW = sz[0]; natH = sz[1] }
  }
  if (!assetUrl && !dataUrl) throw new Error('图片未能写入对象仓库')
  const SW = 1000, SH = 562.5
  let w = width != null ? Number(width) : null
  let h = height != null ? Number(height) : null
  if ((w == null || h == null) && natW && natH) {
    if (w == null && h == null) {
      const scale = Math.min(SW / natW, SH / natH)
      w = natW * scale; h = natH * scale
    } else if (w == null) {
      w = h * natW / natH
    } else {
      h = w * natH / natW
    }
  }
  if (w == null) w = SW
  if (h == null) h = SH
  const l = left != null ? Number(left) : Math.round((SW - w) / 2)
  const t = top != null ? Number(top) : Math.round((SH - h) / 2)
  const element = {
    type: 'image', src: assetUrl || dataUrl,
    left: l, top: t, width: Math.round(w), height: Math.round(h),
  }
  const beforeDoc = await ctx.deck.read()
  const beforeSlide = ((beforeDoc.deck && beforeDoc.deck.slides) || [])[i] || {}
  const beforeIds = new Set((beforeSlide.elements || []).filter(e => e.type === 'image').map(e => e.id))
  const r = await ctx.deck.write([{ op: 'add-element', slide: i, element }])
  if (!r.ok) return okText(r, '图片插入失败')
  const afterDoc = await ctx.deck.read()
  const afterSlide = ((afterDoc.deck && afterDoc.deck.slides) || [])[i] || {}
  const newImg = (afterSlide.elements || []).find(e => e.type === 'image' && !beforeIds.has(e.id))
  if (!newImg) {
    throw new Error('图片未真正插入：deck 中目标页没有新增 image 元素。最常见原因是编辑器还是旧 bundle（不支持 image），请按 F5 刷新桌面后重试；不要重复插入。')
  }
  const imgSrc = String(newImg.src || '')
  if (!/^\/assets\/[a-f0-9]{64}$/i.test(imgSrc) && !/^data:image\//i.test(imgSrc) && !/^https?:/i.test(imgSrc)) {
    throw new Error('图片元素已创建但 src 无效，请重试或刷新编辑器。')
  }
  const nat = natW && natH ? `${natW}×${natH}` : '图片'
  if (assetUrl) {
    const assetId = assetUrl.split('/').pop()
    return { text: `已存入对象仓库并插入：第 ${i} 页新增图片 id=${newImg.id}（${nat} → ${Math.round(newImg.width)}×${Math.round(newImg.height)}，asset=${assetId}）` }
  }
  return { text: `已插入并校验：第 ${i} 页新增图片 id=${newImg.id}（${nat} → ${Math.round(newImg.width)}×${Math.round(newImg.height)}）` }
}

export const imageCapability = defineCapability({
  id: 'image',
  title: '图片',
  tags: ['write', 'media'],
  requires: ['deck', 'assets'],
  provides: { media: { insertImage } },
  features: ['deck.image'],
  tools: [
    defineTool({
      name: 'ppt_image',
      description: '插入图片（一次完成，图片先写入对象仓库，deck 只存 /assets/<sha256> 引用）：attachment_id 取聊天图片附件的 sha256 id；也支持 path/src。src 走远程下载时带浏览器头、25s 超时、自动重试一次，上限 6MB。失败会返回 [错误码]：HOST_BLOCKED / HTTP_403 / TIMEOUT / TOO_LARGE 等——永久性失败不要重试同一链接或域名，改换来源或先用本地 path 下载。不要用 shell 找图，不要截图验证。',
      inputSchema: {
        type: 'object',
        properties: {
          slide: { type: 'integer', description: '0 起页号，缺省 0（封面）' },
          attachment_id: { type: 'string', description: '聊天图片附件的 attachmentId（sha256:…）' },
          attachmentId: { type: 'string', description: 'attachment_id 的兼容别名' },
          path: { type: 'string', description: '本机图片路径（兼容旧用法）' },
          src: { type: 'string', description: 'http(s) 或 data URL' },
          left: { type: 'number' },
          top: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        additionalProperties: false,
      },
      kind: 'write',
      since: '1.0.0',
      handler: (args, ctx) => insertImage(ctx, args),
    }),
  ],
})
