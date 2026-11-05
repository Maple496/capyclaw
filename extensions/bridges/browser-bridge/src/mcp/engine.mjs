/**
 * 浏览器引擎控制器：Playwright 持久化上下文 + ref 快照交互。
 *
 * 设计口径（借鉴 Playwright MCP / dsh-playwright-browser，能力自建）：
 *   - 懒启动：第一次导航才拉起浏览器；探测链 playwright chromium 缓存
 *     → msedge → chrome，全失败给结构化错误与安装提示。
 *   - 有头默认（headless:false）：看得见它在互联网上点击/打字；
 *     登录态持久化（userDataDir 落 hostDir/profile，跨重启保留 cookie）。
 *   - snapshot + ref：快照是「可交互元素 + 结构节点」的缩进文本树，每个
 *     元素带 ref=eN；动作引用 ref，不猜 CSS 选择器；ref 过期报
 *     STALE_SNAPSHOT，重新 browser_snapshot 即可。
 *   - 动作串行化：浏览器单线程语义，所有动作走互斥队列。
 *   - 安全默认：仅 http(s)、拒绝带凭据 URL、browser_evaluate 默认关闭
 *     （allowEvaluate 开启），页面内容视为不可信数据。
 *
 * 本模块只依赖 playwright 与 node 内置模块，可独立单测（纯函数）与注入测试。
 */
import fs from 'node:fs'
import path from 'node:path'

/* --------------------------------------------------------------------------
 * 配置解析（纯函数，可单测）
 * ------------------------------------------------------------------------ */

export const ENGINE_CONFIG_DEFAULTS = Object.freeze({
  headless: false,
  allowEvaluate: false,
  channel: '',
  executablePath: '',
  navigationTimeoutMs: 30000,
  actionTimeoutMs: 15000,
  maxSnapshotChars: 40000,
  viewportWidth: 1280,
  viewportHeight: 800,
})

const ENV_FIELDS = [
  ['DSH_BROWSER_HEADLESS', 'headless', 'boolean'],
  ['DSH_BROWSER_ALLOW_EVALUATE', 'allowEvaluate', 'boolean'],
  ['DSH_BROWSER_CHANNEL', 'channel', 'string'],
  ['DSH_BROWSER_EXECUTABLE_PATH', 'executablePath', 'string'],
  ['DSH_BROWSER_NAV_TIMEOUT_MS', 'navigationTimeoutMs', 'number'],
  ['DSH_BROWSER_ACTION_TIMEOUT_MS', 'actionTimeoutMs', 'number'],
  ['DSH_BROWSER_MAX_SNAPSHOT_CHARS', 'maxSnapshotChars', 'number'],
  ['DSH_BROWSER_VIEWPORT_W', 'viewportWidth', 'number'],
  ['DSH_BROWSER_VIEWPORT_H', 'viewportHeight', 'number'],
]

/** 环境变量 + 显式覆盖 → 引擎配置（默认值兜底）。 */
export function resolveEngineConfig(env = process.env, overrides = {}) {
  const cfg = { ...ENGINE_CONFIG_DEFAULTS }
  for (const [key, field, type] of ENV_FIELDS) {
    const raw = env[key]
    if (raw === undefined || raw === '') continue
    if (type === 'boolean') cfg[field] = /^(1|true|yes)$/i.test(String(raw))
    else if (type === 'number') {
      const num = Number(raw)
      if (Number.isFinite(num) && num > 0) cfg[field] = Math.floor(num)
    } else cfg[field] = String(raw)
  }
  for (const [field, value] of Object.entries(overrides || {})) {
    if (value === undefined || value === null || value === '') continue
    cfg[field] = value
  }
  return cfg
}

/* --------------------------------------------------------------------------
 * URL 安全校验（纯函数，可单测）
 * ------------------------------------------------------------------------ */

function urlError(code, message, hint) {
  return Object.assign(new Error(message), { code, hint })
}

/** 仅 http(s)、拒绝内嵌凭据；其余协议一律拒绝（file:/javascript:/data: 等）。 */
export function assertSafeUrl(raw) {
  let parsed
  try {
    parsed = new URL(String(raw))
  } catch {
    throw urlError('URL_INVALID', `不是合法 URL: ${String(raw).slice(0, 200)}`, '提供完整地址，如 https://example.com/path')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw urlError('URL_SCHEME_DENIED',
      `仅支持 http/https，收到 ${parsed.protocol}`,
      '浏览器工具只访问网页；本地文件与其他协议被拒绝。')
  }
  if (parsed.username || parsed.password) {
    throw urlError('URL_CREDENTIALS_DENIED',
      'URL 内嵌了用户名/密码，已拒绝',
      '凭据不要放进 URL；先打开登录页，再用 browser_fill 填表登录。')
  }
  return parsed.href
}

/* --------------------------------------------------------------------------
 * 页内快照脚本（在浏览器里执行；自包含，不引用外部标识符）
 * ------------------------------------------------------------------------ */

/**
 * 收集可交互元素 + 结构节点（标题/图片），返回扁平条目 + 缩进文本行。
 * 只走主框架（iframe/shadow DOM 不入快照，README 如实标注）。
 */
function pageSnapshotFunction() {
  const INTERACTIVE = 'a, button, input, select, textarea, summary, [role], [contenteditable="true"], [onclick], [tabindex]'
  const skipHidden = (el, style) => el.getClientRects().length === 0
    || style.visibility === 'hidden' || style.display === 'none'
    || el.getAttribute('aria-hidden') === 'true'

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea' || el.isContentEditable) return 'textbox'
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
      return 'textbox'
    }
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'img') return 'img'
    if (tag === 'form') return 'form'
    return 'generic'
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label') || el.getAttribute('title')
    if (aria) return aria.trim()
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (label && label.textContent.trim()) return label.textContent.trim().slice(0, 80)
    }
    const closest = el.closest('label')
    if (closest && closest.textContent.trim()) return closest.textContent.trim().slice(0, 80)
    const alt = el.getAttribute('alt')
    if (alt) return alt.trim().slice(0, 80)
    const placeholder = el.getAttribute('placeholder')
    if (placeholder) return placeholder.trim().slice(0, 80)
    const text = (el.innerText || el.textContent || '').trim()
    if (text) return text.replace(/\s+/g, ' ').slice(0, 80)
    if (el.tagName.toLowerCase() === 'select') {
      const opt = el.selectedOptions && el.selectedOptions[0]
      if (opt) return (opt.textContent || '').trim().slice(0, 80)
    }
    return ''
  }

  function valueOf(el, role) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'password') return '••••'
      if (type === 'checkbox' || type === 'radio') return el.checked ? '[checked]' : ''
      const value = el.value
      return value ? `"${String(value).slice(0, 60)}"` : ''
    }
    if (tag === 'select') {
      const opt = el.selectedOptions && el.selectedOptions[0]
      return opt ? `"${(opt.textContent || opt.value || '').trim().slice(0, 60)}"` : ''
    }
    if (role === 'textbox' && !el.isContentEditable) {
      const value = el.value
      return value ? `"${String(value).slice(0, 60)}"` : ''
    }
    return ''
  }

  function cssPath(el) {
    const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1 } catch { return false } }
    if (el.id) {
      const byId = `#${CSS.escape(el.id)}`
      if (unique(byId)) return byId
    }
    for (const attr of ['data-testid', 'data-test', 'data-qa']) {
      const val = el.getAttribute(attr)
      if (val) {
        const byAttr = `[${attr}="${val.replace(/"/g, '\\"')}"]`
        if (unique(byAttr)) return byAttr
      }
    }
    const parts = []
    let cur = el
    let depth = 0
    while (cur && cur !== document.body && cur !== document.documentElement && depth < 16) {
      let part = cur.tagName.toLowerCase()
      const parent = cur.parentElement
      if (parent) {
        let same = 0
        let idx = 0
        for (const child of parent.children) {
          if (child.tagName === cur.tagName) {
            same += 1
            if (child === cur) idx = same
          }
        }
        if (same > 1) part += `:nth-of-type(${idx})`
      }
      parts.unshift(part)
      if (parts.length >= 2 && unique(parts.join(' > '))) break
      cur = cur.parentElement
      depth += 1
    }
    return parts.join(' > ')
  }

  const entries = []
  const lines = []
  let ref = 0
  const nodes = document.querySelectorAll(`${INTERACTIVE}, h1, h2, h3, h4, h5, h6, img`)
  const bodyDepth = (() => { let d = 0; let n = document.body; while (n && n.parentElement) { d += 1; n = n.parentElement } return d })()
  for (const el of nodes) {
    const style = window.getComputedStyle(el)
    if (skipHidden(el, style)) continue
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') continue
    if (tag === 'img' && !el.getAttribute('alt')) continue
    const role = el.getAttribute('role') || implicitRole(el)
    if (role === 'generic' || role === 'presentation' || role === 'none') continue
    ref += 1
    const name = nameOf(el)
    const value = valueOf(el, role)
    let node = el.parentElement
    let depth = 0
    while (node && node !== document.body) { depth += 1; node = node.parentElement }
    const id = `e${ref}`
    entries.push({ ref: id, role, name, css: cssPath(el), tag, depth: Math.max(depth - bodyDepth + 1, 1) })
    const label = `${role}${name ? ` "${name}"` : ''}${value ? ` ${value}` : ''}`
    lines.push(`${'  '.repeat(Math.max(depth - bodyDepth + 1, 0))}- ${label} [ref=${id}]`)
  }
  return {
    url: location.href,
    title: document.title || '',
    lines,
    entries,
    total: entries.length,
  }
}

/* --------------------------------------------------------------------------
 * 引擎本体
 * ------------------------------------------------------------------------ */

function engineError(code, message, hint) {
  return Object.assign(new Error(message), { code, hint: hint || '' })
}

const ACTION_LOG_LIMIT = 50

/**
 * @param {object} options
 * @param {string} options.hostDir       宿主数据目录（profile/ 与 screenshots/ 落这里）
 * @param {object} [options.config]      resolveEngineConfig 的产物（默认再解析一次环境变量）
 * @param {object} [options.playwright]  注入的 playwright 模块（测试用；缺省动态 import）
 */
export async function createBrowserEngine({ hostDir, config, playwright } = {}) {
  if (!hostDir) throw new Error('createBrowserEngine: 缺少 hostDir')
  const cfg = config || resolveEngineConfig()
  const pw = playwright || await import('playwright')

  const profileDir = path.join(hostDir, 'profile')
  const screenshotsDir = path.join(hostDir, 'screenshots')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.mkdirSync(screenshotsDir, { recursive: true })

  /* ---- 运行态 ---- */
  let context = null
  let launching = null
  let channelUsed = ''
  let activeTabId = null
  let tabCounter = 0
  const tabs = new Map()          // id → page
  const tabIds = new Map()        // page → id
  const refRegistries = new Map() // tabId → Map(ref → entry)
  const snapshotChars = new Map() // tabId → 最后一次快照字符数
  const counters = { actions: 0, errors: 0, snapshots: 0 }
  const actionLog = []

  /* ---- 动作互斥（浏览器单线程语义） ---- */
  let chain = Promise.resolve()
  function enqueue(task) {
    const run = chain.then(task, task)
    chain = run.then(() => {}, () => {})
    return run
  }

  function logAction(tool, detail, ms, ok, error) {
    actionLog.unshift({ tool, detail, ms: Math.round(ms), ok, error: error ? String(error.message || error).slice(0, 160) : '', at: new Date().toISOString() })
    if (actionLog.length > ACTION_LOG_LIMIT) actionLog.length = ACTION_LOG_LIMIT
  }

  async function track(tool, detail, task) {
    const started = Date.now()
    counters.actions += 1
    try {
      const out = await task()
      logAction(tool, detail, Date.now() - started, true)
      return out
    } catch (error) {
      counters.errors += 1
      logAction(tool, detail, Date.now() - started, false, error)
      throw error
    }
  }

  /* ---- 懒启动与探测链 ---- */
  function registerPage(page) {
    if (tabIds.has(page)) return tabIds.get(page)
    tabCounter += 1
    const id = `T${tabCounter}`
    tabs.set(id, page)
    tabIds.set(page, id)
    refRegistries.set(id, new Map())
    page.on('close', () => {
      tabs.delete(id)
      tabIds.delete(page)
      refRegistries.delete(id)
      snapshotChars.delete(id)
      if (activeTabId === id) {
        const rest = [...tabs.keys()]
        activeTabId = rest.length ? rest[rest.length - 1] : null
      }
    })
    return id
  }

  async function launch() {
    if (context) return context
    if (launching) return launching
    launching = (async () => {
      const attempts = []
      const candidates = []
      if (cfg.executablePath) candidates.push({ label: `executablePath(${cfg.executablePath})`, options: { executablePath: cfg.executablePath } })
      if (cfg.channel) candidates.push({ label: `channel:${cfg.channel}`, options: { channel: cfg.channel } })
      candidates.push({ label: 'chromium', options: {} })
      if (process.platform === 'win32') {
        candidates.push({ label: 'channel:msedge', options: { channel: 'msedge' } })
        candidates.push({ label: 'channel:chrome', options: { channel: 'chrome' } })
      } else {
        candidates.push({ label: 'channel:chrome', options: { channel: 'chrome' } })
        candidates.push({ label: 'channel:msedge', options: { channel: 'msedge' } })
      }
      const seen = new Set()
      for (const candidate of candidates) {
        const key = candidate.label
        if (seen.has(key)) continue
        seen.add(key)
        try {
          const ctx = await pw.chromium.launchPersistentContext(profileDir, {
            headless: cfg.headless,
            viewport: { width: cfg.viewportWidth, height: cfg.viewportHeight },
            ...candidate.options,
          })
          context = ctx
          channelUsed = candidate.label
          for (const page of ctx.pages()) registerPage(page)
          ctx.on('page', (page) => { registerPage(page); activeTabId = tabIds.get(page) })
          if (!activeTabId && tabs.size) activeTabId = [...tabs.keys()][0]
          return ctx
        } catch (error) {
          attempts.push(`${candidate.label}: ${String(error && error.message || error).split('\n')[0].slice(0, 200)}`)
        }
      }
      throw engineError('ENGINE_LAUNCH_FAILED',
        `浏览器启动失败（已尝试 ${attempts.length} 种方式）`,
        `安装 Playwright Chromium（npx playwright install chromium）或系统 Chrome/Edge 后重试。尝试明细：${attempts.join('；')}`)
    })()
    try {
      return await launching
    } finally {
      launching = null
    }
  }

  async function ensureTab(tabId) {
    await launch()
    let id = tabId || activeTabId
    if (id && !tabs.has(id)) {
      throw engineError('TAB_UNKNOWN', `标签页 ${id} 不存在`, '用 browser_tabs(action=list) 查看现有标签页。')
    }
    if (!id) {
      const page = await context.newPage()
      id = registerPage(page)
      activeTabId = id
    }
    if (!activeTabId) activeTabId = id
    return { id, page: tabs.get(id) }
  }

  /* ---- 快照 ---- */
  /**
   * 动作后落定：Playwright 的 click/press 只等到导航「提交」，不等新文档 DOM 就绪，
   * 立刻 evaluate 会拍到空页（真实站点上很常见）。这里补一次 domcontentloaded
   * 等待 + 极短渲染让位，拿不到就按当前状态拍（不阻塞超时站点）。
   */
  async function settle(page) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 })
    } catch { /* 未发生导航 / 站点慢：继续拍当前状态 */ }
    try {
      await page.waitForTimeout(80)
    } catch { /* 页面已关闭 */ }
  }

  async function takeSnapshot(page, tabId) {
    const raw = await page.evaluate(pageSnapshotFunction)
    counters.snapshots += 1
    const registry = new Map()
    for (const entry of raw.entries) registry.set(entry.ref, entry)
    refRegistries.set(tabId, registry)
    let text = raw.lines.join('\n')
    let truncated = false
    if (text.length > cfg.maxSnapshotChars) {
      truncated = true
      text = text.slice(0, cfg.maxSnapshotChars) + `\n…（已截断：完整快照 ${raw.lines.join('\n').length} 字符；已列出的 ref 仍可使用）`
    }
    snapshotChars.set(tabId, text.length)
    return {
      url: raw.url,
      title: raw.title,
      elements: raw.total,
      truncated,
      text,
    }
  }

  /* ---- ref 解析 ---- */
  function resolveRef(tabId, ref) {
    const registry = refRegistries.get(tabId)
    const entry = registry && registry.get(String(ref))
    if (!entry) {
      throw engineError('STALE_SNAPSHOT',
        `ref=${ref} 不在当前标签页最近的快照里`,
        '页面可能已变化或引用了别的标签页；先 browser_snapshot 重新观察，再用新 ref。')
    }
    return entry
  }

  async function locatorFor(page, tabId, ref) {
    const entry = resolveRef(tabId, ref)
    const locator = page.locator(entry.css)
    const count = await locator.count()
    if (count !== 1) {
      throw engineError('STALE_SNAPSHOT',
        `ref=${ref}（${entry.role}${entry.name ? ` "${entry.name}"` : ''}）定位到 ${count} 个元素`,
        '快照已过期；重新 browser_snapshot 后用新 ref。')
    }
    return { locator, entry }
  }

  /* ---- 公开 API ---- */
  const engine = {
    config: cfg,
    profileDir,
    screenshotsDir,

    /** 结构化状态（health/metrics/工具共用；不触发浏览器启动）。 */
    status() {
      const tabList = [...tabs.entries()].map(([id, page]) => {
        let url = ''
        try { url = page.url() || '' } catch { /* 已关闭 */ }
        return { id, url, active: id === activeTabId }
      })
      return {
        running: !!context,
        launching: !!launching,
        headless: cfg.headless,
        channel: channelUsed,
        tabs: tabList,
        activeTab: activeTabId,
        counters: { ...counters },
        evaluateEnabled: !!cfg.allowEvaluate,
      }
    },

    actionLog() {
      return actionLog.slice()
    },

    async navigate({ url, tab } = {}) {
      const safe = assertSafeUrl(url)
      return enqueue(() => track('browser_navigate', safe.slice(0, 120), async () => {
        const { id, page } = await ensureTab(tab)
        activeTabId = id
        await page.goto(safe, { timeout: cfg.navigationTimeoutMs, waitUntil: 'domcontentloaded' })
        const snapshot = await takeSnapshot(page, id)
        return { tab: id, url: page.url(), title: snapshot.title, snapshot }
      }))
    },

    async snapshot({ tab } = {}) {
      return enqueue(() => track('browser_snapshot', tab ? `tab=${tab}` : 'active', async () => {
        const { id, page } = await ensureTab(tab)
        const snapshot = await takeSnapshot(page, id)
        return { tab: id, ...snapshot }
      }))
    },

    async click({ ref, tab } = {}) {
      return enqueue(() => track('browser_click', `ref=${ref}`, async () => {
        const { id, page } = await ensureTab(tab)
        const { locator, entry } = await locatorFor(page, id, ref)
        await locator.click({ timeout: cfg.actionTimeoutMs })
        await settle(page)
        const snapshot = await takeSnapshot(page, id)
        return { clicked: `${entry.role}${entry.name ? ` "${entry.name}"` : ''}`, tab: id, snapshot }
      }))
    },

    async fill({ ref, text, submit = false, tab } = {}) {
      return enqueue(() => track('browser_fill', `ref=${ref}`, async () => {
        const { id, page } = await ensureTab(tab)
        const { locator, entry } = await locatorFor(page, id, ref)
        await locator.fill(String(text ?? ''), { timeout: cfg.actionTimeoutMs })
        if (submit) {
          await locator.press('Enter', { timeout: cfg.actionTimeoutMs })
          await settle(page)
        }
        const snapshot = await takeSnapshot(page, id)
        return { filled: `${entry.role}${entry.name ? ` "${entry.name}"` : ''}`, submit: !!submit, tab: id, snapshot }
      }))
    },

    async press({ key, ref, tab } = {}) {
      return enqueue(() => track('browser_press', `${ref ? `ref=${ref} ` : ''}${key}`, async () => {
        const { id, page } = await ensureTab(tab)
        if (ref) {
          const { locator } = await locatorFor(page, id, ref)
          await locator.press(String(key), { timeout: cfg.actionTimeoutMs })
        } else {
          await page.keyboard.press(String(key))
        }
        await settle(page)
        const snapshot = await takeSnapshot(page, id)
        return { key, tab: id, snapshot }
      }))
    },

    async select({ ref, value, tab } = {}) {
      return enqueue(() => track('browser_select', `ref=${ref}`, async () => {
        const { id, page } = await ensureTab(tab)
        const { locator, entry } = await locatorFor(page, id, ref)
        let applied = ''
        try {
          await locator.selectOption({ value: String(value) }, { timeout: cfg.actionTimeoutMs })
          applied = String(value)
        } catch {
          /* 值匹配失败 → 按 label 再试一次（真实页面两种写法都常见）。 */
          await locator.selectOption({ label: String(value) }, { timeout: cfg.actionTimeoutMs })
          applied = String(value)
        }
        await settle(page)
        const snapshot = await takeSnapshot(page, id)
        return { selected: `${entry.name || entry.role} → ${applied}`, tab: id, snapshot }
      }))
    },

    async scroll({ direction = 'down', amount = 600, tab } = {}) {
      return enqueue(() => track('browser_scroll', `${direction} ${amount}px`, async () => {
        const { id, page } = await ensureTab(tab)
        const delta = direction === 'up' ? -Number(amount) : Number(amount)
        await page.evaluate((dy) => window.scrollBy(0, dy), delta)
        const snapshot = await takeSnapshot(page, id)
        return { scrolled: `${direction} ${Math.abs(delta)}px`, tab: id, snapshot }
      }))
    },

    async wait({ ms, selector, tab } = {}) {
      return enqueue(() => track('browser_wait', ms ? `${ms}ms` : selector ? selector.slice(0, 80) : 'load', async () => {
        const { id, page } = await ensureTab(tab)
        if (selector) {
          await page.waitForSelector(String(selector), { timeout: Math.min(Number(ms) || cfg.actionTimeoutMs, cfg.actionTimeoutMs) })
        } else if (ms) {
          await page.waitForTimeout(Math.min(Number(ms), 30000))
        } else {
          await page.waitForLoadState('load', { timeout: cfg.navigationTimeoutMs })
        }
        return { waited: true, tab: id }
      }))
    },

    async history({ action = 'back', tab } = {}) {
      return enqueue(() => track('browser_history', action, async () => {
        const { id, page } = await ensureTab(tab)
        if (action === 'back') await page.goBack({ timeout: cfg.navigationTimeoutMs })
        else if (action === 'forward') await page.goForward({ timeout: cfg.navigationTimeoutMs })
        else if (action === 'reload') await page.reload({ timeout: cfg.navigationTimeoutMs })
        else throw engineError('ARG_INVALID', `history 不支持 ${action}`, '可用：back / forward / reload')
        const snapshot = await takeSnapshot(page, id)
        return { action, url: page.url(), tab: id, snapshot }
      }))
    },

    async tabsAction({ action = 'list', url, tab } = {}) {
      return enqueue(() => track('browser_tabs', action, async () => {
        if (action === 'list') {
          return { tabs: engine.status().tabs, activeTab: activeTabId }
        }
        if (action === 'new') {
          await launch()
          const page = await context.newPage()
          const id = registerPage(page)
          activeTabId = id
          if (url) {
            const safe = assertSafeUrl(url)
            await page.goto(safe, { timeout: cfg.navigationTimeoutMs, waitUntil: 'domcontentloaded' })
          }
          const snapshot = await takeSnapshot(page, id)
          return { tab: id, url: page.url(), snapshot }
        }
        if (action === 'select') {
          if (!tab || !tabs.has(tab)) throw engineError('TAB_UNKNOWN', `标签页 ${tab || '(空)'} 不存在`, '先 browser_tabs(action=list)。')
          activeTabId = tab
          const snapshot = await takeSnapshot(tabs.get(tab), tab)
          return { tab, snapshot }
        }
        if (action === 'close') {
          if (!tab || !tabs.has(tab)) throw engineError('TAB_UNKNOWN', `标签页 ${tab || '(空)'} 不存在`, '先 browser_tabs(action=list)。')
          await tabs.get(tab).close()
          return { closed: tab, tabs: engine.status().tabs }
        }
        throw engineError('ARG_INVALID', `tabs 不支持 ${action}`, '可用：list / new / select / close')
      }))
    },

    /** 截图落盘（工具面：返回绝对路径）。 */
    async screenshot({ fullPage = false, tab } = {}) {
      return enqueue(() => track('browser_screenshot', fullPage ? 'fullPage' : 'viewport', async () => {
        const { page } = await ensureTab(tab)
        const buffer = await page.screenshot({ fullPage: !!fullPage })
        const file = path.join(screenshotsDir, `shot-${Date.now()}-${Math.floor(Math.random() * 1e4)}.png`)
        fs.writeFileSync(file, buffer)
        return { path: file, bytes: buffer.length, tab: activeTabId }
      }))
    },

    /** 实时画面（工作台 /api/screenshot 用：不落盘，直接返回 PNG Buffer）。 */
    async screenshotBuffer({ tab } = {}) {
      const { page } = await ensureTab(tab)
      return page.screenshot({ fullPage: false })
    },

    /** 任意 JS 执行：默认关闭，如实返回 NOT_IMPLEMENTED（不伪造结果）。 */
    async evaluate({ script, tab } = {}) {
      if (!cfg.allowEvaluate) {
        throw engineError('NOT_IMPLEMENTED',
          'browser_evaluate 默认关闭（安全默认：页面脚本面不向模型开放）',
          '确有需要时在 cordis 配置 allowEvaluate: true 或环境变量 DSH_BROWSER_ALLOW_EVALUATE=true，重启服务后生效。')
      }
      return enqueue(() => track('browser_evaluate', String(script).slice(0, 80), async () => {
        const { id, page } = await ensureTab(tab)
        const out = await page.evaluate(String(script))
        return { tab: id, result: out === undefined ? null : out }
      }))
    },

    async close() {
      return enqueue(() => track('browser_close', '', async () => {
        if (!context) return { closed: false }
        const ctx = context
        context = null
        activeTabId = null
        try {
          await ctx.close()
        } catch { /* 浏览器已退出时忽略 */ }
        return { closed: true }
      }))
    },
  }

  return engine
}
