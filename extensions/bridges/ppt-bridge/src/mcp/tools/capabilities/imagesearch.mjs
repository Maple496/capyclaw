/** 图片检索能力：搜索 + 预检，返回确认可下载的候选直链；下载/入库/插图由 ppt_image 负责。 */
import { IMAGE_UA, probeImage } from '../domains/remote-image.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

const BING = 'https://cn.bing.com/images/async'
const UA = IMAGE_UA
const MIN_WIDTH = 480
const CACHE_TTL_MS = 10 * 60 * 1000
/* 全局预算：一个 read 工具不该拖到十几秒。
 * 2026-11-02 实测 Bing 图片搜索常态 0.2~0.5s，偶发 7s+ 抖动，
 * 所以搜索单独给 8s（沿用原值，不因预检而收紧），预检在剩余预算里跑，
 * 整轮 12s 封顶。预算耗尽就返回已拿到的结果，不再补测。 */
const TOTAL_BUDGET_MS = 12000
const SEARCH_TIMEOUT_MS = 8000
const PROBE_CONCURRENCY = 9
const PROBE_TIMEOUT_MS = 3000
const PROBE_MAX_RATIO = 2
const cache = new Map()

const decode = (value) => String(value || '')
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')

/** 从 Bing 图片搜索 HTML 中提取 murl/purl/t 宽高。 */
export function parseBingImages(html, limit = 12) {
  const out = []
  const seen = new Set()
  for (const match of String(html || '').matchAll(/m="(\{&quot;[\s\S]*?)"/g)) {
    let meta
    try { meta = JSON.parse(decode(match[1])) } catch { continue }
    const url = String(meta.murl || '')
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url)
    out.push({
      title: String(meta.t || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      page: String(meta.purl || ''),
      url,
      width: Number(meta.w) || 0,
      height: Number(meta.h) || 0,
    })
    if (out.length >= limit) break
  }
  return out
}

async function searchBing(query, count, deadline) {
  const url = `${BING}?q=${encodeURIComponent(query)}&first=1&count=${Math.max(count * 3, 24)}&mkt=zh-CN&qft=+filterui:photo-photo`
  const budget = Math.min(SEARCH_TIMEOUT_MS, Math.max(1000, deadline - Date.now()))
  const res = await fetch(url, {
    signal: AbortSignal.timeout(budget),
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  })
  if (!res.ok) throw new Error(`图片搜索 HTTP ${res.status}`)
  return parseBingImages(await res.text(), count)
}

/**
 * 并发预检，凑够 want 条就停。
 * 只淘汰"确定的坏链"（403/404/不是图片/超大）；预检超时或网络抖动归入
 * unverified——下载阶段预算长得多，不能因为探测慢就丢掉可能的好图。
 * 返回顺序：验证通过的在前，未验证的兜底在后。
 */
async function filterDownloadable(items, want, deadline) {
  const verified = []
  const unverified = []
  const rejected = []
  const pool = items.slice(0, Math.min(items.length, want * PROBE_MAX_RATIO))
  let cursor = 0
  const worker = async () => {
    while (cursor < pool.length && verified.length < want && Date.now() < deadline) {
      const item = pool[cursor++]
      const probe = await probeImage(item.url, { timeoutMs: PROBE_TIMEOUT_MS, deadline })
      if (probe.ok) verified.push(item)
      else if (probe.permanent) rejected.push({ url: item.url, code: probe.code, permanent: true })
      else unverified.push(item)
    }
  }
  const lanes = Math.min(PROBE_CONCURRENCY, pool.length)
  await Promise.all(Array.from({ length: lanes }, worker))
  return {
    candidates: [...verified, ...unverified].slice(0, want),
    verifiedCount: Math.min(verified.length, want),
    verified: new Set(verified),
    rejected,
  }
}

export const imagesearchCapability = defineCapability({
  id: 'imagesearch',
  title: '图片检索',
  tags: ['read'],
  features: ['media.search'],
  tools: [
    defineTool({
      name: 'ppt_images',
      description: '图片搜索：返回已预检可下载的候选直链（不下载正文，整轮 12s 内）。选中后直接用 ppt_image { src: url, slide } 插入；返回的候选基本不会 403/超限，若仍失败说明网络波动，换下一个候选即可。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 120, description: '中文或英文图片搜索词' },
          count: { type: 'integer', minimum: 1, maximum: 12, description: '需要的候选数量，缺省 6' },
          min_width: { type: 'integer', description: '最小宽度像素，缺省 480' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      kind: 'read',
      since: '2.3.0',
      handler: async ({ query, count, min_width }) => {
        const want = Math.min(12, Math.max(1, Number(count) || 6))
        const floor = Math.max(0, Number(min_width) || MIN_WIDTH)
        const cacheKey = `${query}|${want}|${floor}`
        const hit = cache.get(cacheKey)
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { text: hit.text }

        const deadline = Date.now() + TOTAL_BUDGET_MS
        const found = (await searchBing(query, want * 3, deadline)).filter((item) => !item.width || item.width >= floor)
        if (!found.length) throw new Error(`没有找到图片（${query}）`)
        const { candidates, verifiedCount, verified, rejected } = await filterDownloadable(found, want, deadline)
        if (!candidates.length) {
          const codes = [...new Set(rejected.map((r) => r.code))].slice(0, 3).join('/') || '未知'
          throw new Error(`搜到 ${found.length} 条但全部不可下载（${codes}）：请换搜索词，或改用本地图片路径`)
        }
        const results = candidates.map((item) => {
          const entry = {
            title: item.title,
            page: item.page,
            url: item.url,
            width: item.width,
            height: item.height,
          }
          if (!verified.has(item)) entry.verified = false
          return entry
        })
        const text = JSON.stringify({
          query,
          count: results.length,
          verified: verifiedCount,
          images: results,
          note: verifiedCount === results.length
            ? '候选均已预检可下载；直接用 ppt_image { src: url, slide } 插入，不要换 URL 试探'
            : '前 ' + verifiedCount + ' 条已预检可下载，优先用它们；verified:false 的仅预检超时，下载可能较慢。直接用 ppt_image { src: url, slide } 插入。',
        }, null, 2)
        cache.set(cacheKey, { at: Date.now(), text })
        return { text }
      },
    }),
  ],
})
