/**
 * 远程图片抓取：浏览器头 + 分级错误 + 主机熔断 + 候选预检。
 *
 * 2026-11-02 事故复盘（用户侧现象：一直报"远程图片下载/校验失败"）：
 *   1. 请求不带 User-Agent，图床把裸 Node 请求当爬虫直接 403；
 *   2. 10s 硬超时覆盖了整个响应体，3.6MB 的原图在并发下必然中断；
 *   3. 403 / 超时 / 超大 都吐同一句"请改用可访问的图片 URL"，
 *      模型读不出"这个域名没救"，于是换一个 URL 再撞一次。
 *
 * 所以判定逻辑收在这里：每个失败都带 code 和 permanent 标记，调用方
 * 据此告诉模型下一步该做什么；同一主机确认不可用后 10 分钟内短路，
 * 不再重复付超时的代价。
 */
export const IMAGE_MAX_BYTES = 6 * 1024 * 1024

export const IMAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const DEFAULT_TIMEOUT_MS = 25000
const DEFAULT_PROBE_TIMEOUT_MS = 4500
const DEFAULT_RETRIES = 1
const HOST_BLOCK_TTL_MS = 10 * 60 * 1000
const RETRY_BACKOFF_MS = 400
/* 同一主机连续多少个"永久失败"才整体熔断。
 * 单条 403 可能只是某张图防盗链，一刀切会误伤同一 CDN 上的好图；
 * 连续两条都废，才说明这个域名对本机不是可用来源。 */
const HOST_BLOCK_THRESHOLD = 2

/** host -> { until, code, reason } */
const blockedHosts = new Map()
/** host -> 连续永久失败次数（成功一次清零） */
const hostFailures = new Map()

export class ImageFetchError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'ImageFetchError'
    this.code = code
    this.host = options.host || ''
    this.status = options.status || 0
    this.permanent = options.permanent === true
    this.retryable = options.retryable === true
  }
}

export function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase() } catch { return '' }
}

export function blockedHost(host) {
  const entry = blockedHosts.get(host)
  if (!entry) return null
  if (entry.until <= Date.now()) { blockedHosts.delete(host); return null }
  return entry
}

export function blockHost(host, code, reason) {
  if (!host) return
  blockedHosts.set(host, { until: Date.now() + HOST_BLOCK_TTL_MS, code, reason })
}

/** 记一次永久失败；达到阈值才真正熔断整个主机。 */
export function noteHostFailure(host, code, reason) {
  if (!host) return false
  const count = (hostFailures.get(host) || 0) + 1
  hostFailures.set(host, count)
  if (count < HOST_BLOCK_THRESHOLD) return false
  blockHost(host, code, reason)
  return true
}

export function noteHostSuccess(host) {
  if (host) hostFailures.delete(host)
}

/** 测试用：清空熔断表。 */
export function clearBlockedHosts() {
  blockedHosts.clear()
  hostFailures.clear()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isTimeout(error) {
  const name = String(error?.name || '')
  return name === 'TimeoutError' || name === 'AbortError'
}

function networkError(error, host, timeoutMs) {
  if (isTimeout(error)) {
    return new ImageFetchError('TIMEOUT', `下载超时（${Math.round(timeoutMs / 1000)}s 内没有收完）`, {
      host, retryable: true,
    })
  }
  return new ImageFetchError('NETWORK', `网络错误：${error?.message || error}`, { host, retryable: true })
}

function httpError(status, host) {
  if (status === 401 || status === 403 || status === 451) {
    noteHostFailure(host, 'HTTP_' + status, '拒绝直连（防盗链/爬虫拦截）')
    return new ImageFetchError('HTTP_' + status, `HTTP ${status}：该站拒绝程序直连（防盗链）`, {
      host, status, permanent: true,
    })
  }
  if (status === 404 || status === 410) {
    return new ImageFetchError('HTTP_' + status, `HTTP ${status}：链接已失效`, { host, status, permanent: true })
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return new ImageFetchError('HTTP_' + status, `HTTP ${status}：对方暂时不可用`, { host, status, retryable: true })
  }
  return new ImageFetchError('HTTP_' + status, `HTTP ${status}`, { host, status, permanent: true })
}

const FETCH_HEADERS = {
  'user-agent': IMAGE_UA,
  accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  referer: 'https://www.bing.com/',
}

async function cancelBody(res) {
  try { await res.body?.cancel() } catch { /* 已关闭 */ }
}

async function fetchBinary(url, { timeoutMs, maxBytes }) {
  const host = hostOf(url)
  let res
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: FETCH_HEADERS,
    })
  } catch (error) {
    throw networkError(error, host, timeoutMs)
  }

  if (!res.ok) {
    await cancelBody(res)
    throw httpError(res.status, host)
  }

  const type = String(res.headers.get('content-type') || '').toLowerCase()
  if (type && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
    await cancelBody(res)
    throw new ImageFetchError('NOT_IMAGE', `返回的不是图片（content-type=${type}）`, {
      host, status: res.status, permanent: true,
    })
  }

  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > maxBytes) {
    await cancelBody(res)
    throw new ImageFetchError('TOO_LARGE', `图片 ${(declared / 1024 / 1024).toFixed(1)}MB 超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`, {
      host, status: res.status, permanent: true,
    })
  }

  if (!res.body || typeof res.body.getReader !== 'function') {
    let buf
    try { buf = Buffer.from(await res.arrayBuffer()) } catch (error) {
      throw networkError(error, host, timeoutMs)
    }
    if (buf.length > maxBytes) {
      throw new ImageFetchError('TOO_LARGE', `图片 ${(buf.length / 1024 / 1024).toFixed(1)}MB 超过上限`, {
        host, permanent: true,
      })
    }
    noteHostSuccess(host)
    return { buf, contentType: type, host }
  }

  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        try { await reader.cancel() } catch { /* 忽略 */ }
        throw new ImageFetchError('TOO_LARGE', `图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`, {
          host, permanent: true,
        })
      }
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    if (error instanceof ImageFetchError) throw error
    throw networkError(error, host, timeoutMs)
  }
  noteHostSuccess(host)
  return { buf: Buffer.concat(chunks), contentType: type, host }
}

/**
 * 下载远程图片为 Buffer。
 * @returns {Promise<{buf: Buffer, contentType: string, host: string}>}
 */
export async function downloadImage(url, options = {}) {
  const host = hostOf(url)
  const blocked = blockedHost(host)
  if (blocked) {
    throw new ImageFetchError('HOST_BLOCKED', `${host} 近期已确认不可用（${blocked.reason}），本次直接跳过`, {
      host, permanent: true,
    })
  }
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)
  const maxBytes = Number(options.maxBytes) || IMAGE_MAX_BYTES
  const retries = options.retries == null ? DEFAULT_RETRIES : Math.max(0, Number(options.retries) || 0)

  let last = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchBinary(url, { timeoutMs, maxBytes })
    } catch (error) {
      last = error
      const retryable = error instanceof ImageFetchError && error.retryable
      if (!retryable || attempt === retries) break
      await sleep(RETRY_BACKOFF_MS * (attempt + 1))
    }
  }
  throw last
}

/**
 * 预检候选图：只读响应头，判定能否被 ppt_image 下载。
 * 用于 ppt_images 在把直链交给模型之前先过滤死链，避免"选一个、失败、
 * 再选一个、再失败"的循环。拿到头就断开，不读正文。
 * @returns {Promise<{ok: true, size: number, type: string} | {ok: false, code: string, reason: string, permanent: boolean}>}
 */
export async function probeImage(url, options = {}) {
  const host = hostOf(url)
  const blocked = blockedHost(host)
  if (blocked) return { ok: false, code: 'HOST_BLOCKED', reason: blocked.reason, permanent: true }

  const budget = Math.max(1000, Number(options.timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS)
  const remaining = options.deadline ? Number(options.deadline) - Date.now() : budget
  if (remaining <= 0) return { ok: false, code: 'TIMEOUT', reason: '预检预算用尽', permanent: false }
  const timeoutMs = Math.min(budget, remaining)
  let res
  try {
    /* 不用 Range 探体积：部分图床对 bytes=0-0 回 416/400，
     * 会把好图误判成死链。这里发普通 GET，拿到响应头就立刻 cancel，
     * 正文不会真的下载完。 */
    res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      headers: FETCH_HEADERS,
    })
  } catch (error) {
    /* 预检超时不等于不可用：下载阶段给了更长预算，保留候选交给 ppt_image 判定。 */
    return { ok: false, code: isTimeout(error) ? 'TIMEOUT' : 'NETWORK', reason: error?.message || String(error), permanent: false }
  }

  const type = String(res.headers.get('content-type') || '').toLowerCase()
  if (!res.ok && res.status !== 206) {
    await cancelBody(res)
    const mapped = httpError(res.status, host)
    return { ok: false, code: mapped.code, reason: mapped.message, permanent: mapped.permanent }
  }
  await cancelBody(res)
  if (type && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
    return { ok: false, code: 'NOT_IMAGE', reason: `content-type=${type}`, permanent: true }
  }
  let size = Number(res.headers.get('content-length') || 0)
  const range = String(res.headers.get('content-range') || '')
  const total = Number(range.split('/').pop())
  if (Number.isFinite(total) && total > 0) size = total
  if (size > IMAGE_MAX_BYTES) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      reason: `${(size / 1024 / 1024).toFixed(1)}MB 超过上限`,
      permanent: true,
    }
  }
  return { ok: true, size, type }
}

/** 把 ImageFetchError 翻译成模型能直接照着做的下一步。 */
export function describeImageFailure(error, url) {
  const code = error instanceof ImageFetchError ? error.code : 'UNKNOWN'
  const message = String(error?.message || error)
  const permanent = error instanceof ImageFetchError ? error.permanent : false
  const action = permanent
    ? '这是永久性失败，不要重试同一链接或同一域名：改用 ppt_images 换来源，或本地下载后用 path 传入'
    : '可以重试一次；仍失败就换来源（ppt_images）或改用本地 path'
  return `远程图片不可用[${code}]：${message}。${action}。url=${String(url).slice(0, 160)}`
}
