/**
 * 浏览器编辑器客户端：租约/心跳/长轮询/镜像/应用/截图请求。
 *
 * 不直接碰 DOM 与具体编辑器；加载、dump、应用、截图渲染都由 adapter 注入。
 * 该文件必须保持 browser-safe：禁止 import node:*。
 */

const DEFAULTS = {
  pollTimeoutSec: 3,
  claimRetryMs: 800,
  activeClaimRetryMs: 1500,
  heartbeatMs: 3000,
  stateDebounceMs: 800,
  errorRetryMs: 500,
  shotIdleMs: 3000,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createEditorClient({
  api,
  apiBase = '',
  clientId,
  adapter,
  authority = 'server',
  documentKey = 'document',
  documentPath = '/document',
  storage = typeof localStorage !== 'undefined' ? localStorage : null,
  workerFactory = null,
  heartbeatWorkerUrl = './heartbeat-worker.js',
  singletonKey = 'document-workbench-singleton',
  intervals = {},
  onStatus = () => {},
  onNote = () => {},
} = {}) {
  if (typeof api !== 'function') throw new Error('createEditorClient 需要 api(path, init)')
  if (!adapter || typeof adapter.load !== 'function' || typeof adapter.dump !== 'function') {
    throw new Error('createEditorClient 需要 adapter.load / adapter.dump')
  }
  if (authority !== 'server' && authority !== 'editor') {
    throw new Error('authority 只能是 server 或 editor')
  }

  const timing = { ...DEFAULTS, ...intervals }
  const st = {
    clientId,
    active: false,
    stopped: false,
    heartbeat: null,
    heartbeatWorker: null,
    lastSeq: 0,
    lastShotReq: 0,
    lastUiSeq: 0,
    busy: false,
    shooting: false,
    pumping: false,
    watching: false,
    onchange: null,
    unsubscribe: null,
    stateTimer: null,
    shotCache: null,
    singletonKey,
    pendingShotReq: null,
  }

  const note = (message, kind = '') => onNote(message, kind)
  const badge = (text, kind = '') => onStatus(text, kind)

  function request(path, init) {
    return api(path, init)
  }

  function post(path, body) {
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async function claim(force) {
    try {
      /* 能力/版本随 claim 上报，服务端存进 owner.meta；
       * 工具可据此判断页面是否支持某个 op（例如 import-pptx）。 */
      const meta = typeof adapter.meta === 'function' ? adapter.meta() : null
      const result = await post('/claim', {
        id: st.clientId,
        force: !!force,
        ...(meta && typeof meta === 'object' ? { meta } : {}),
      })
      return !!(result && result.ok)
    } catch {
      return false
    }
  }

  async function ensureLinked() {
    for (;;) {
      if (await claim(true)) return
      await sleep(600)
    }
  }

  async function restore() {
    try {
      const doc = await request('')
      const value = doc && doc[documentKey]
      if (value !== undefined && value !== null) await adapter.load(value)
      st.lastSeq = Number(doc && doc.seq) || 0
      st.lastUiSeq = Number(doc && doc.ui_seq) || 0
      return doc
    } catch {
      /* 镜像不可用 = 保留编辑器默认文档 */
      return null
    }
  }

  async function activate() {
    if (st.active) return
    st.stopped = false
    st.active = true
    try { storage?.setItem(st.singletonKey, st.clientId) } catch { /* quota / privacy mode */ }
    badge('', 'ok')
    note('')
    watch()
    pump()
    startHeartbeatWorker()

    /* 补发未完成的截图请求：编辑器重启后旧请求的结果丢失。 */
    try {
      const status = await request('/status')
      if (status && status.shot_req > 0
        && (!status.shot || (status.shot.req | 0) < status.shot_req)) {
        st.lastShotReq = status.shot_req
        shoot(status.shot_req)
      }
    } catch { /* 下一轮 pump 兜底 */ }
  }

  async function claimLoop() {
    if (storage && typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('storage', (event) => {
        if (event.key === st.singletonKey && event.newValue && event.newValue !== st.clientId) {
          if (st.active) {
            st.active = false
            stopHeartbeatWorker()
            badge('', 'standby')
            note('')
          }
        }
      })
    }

    let firstClaim = true
    for (;;) {
      if (st.stopped) break
      if (!st.active) {
        if (await claim(firstClaim)) {
          firstClaim = false
          await activate()
        } else {
          firstClaim = false
          badge('', 'standby')
          note('')
        }
      }
      await sleep(st.active ? timing.activeClaimRetryMs : timing.claimRetryMs)
    }
  }

  /** editor authority：应用一批命令并回执。 */
  async function apply(doc) {
    st.busy = true
    let applied = 0
    let error = ''
    try {
      applied = await adapter.apply(doc.cmds || [])
      if (!Number.isFinite(applied)) applied = (doc.cmds || []).length
    } catch (caught) {
      error = String((caught && caught.message) || caught)
      if (!adapter.isMounted?.()) st.lastSeq = 0
    }
    try {
      await post('/ack', { seq: doc.seq, applied, error })
    } catch { /* 回执失败由下一轮轮询补 */ }
    st.busy = false
    note(error ? `第 ${doc.seq} 队应用失败：${error}` : `第 ${doc.seq} 队已应用（${applied} 条）`, error ? 'error' : 'ok')
    Promise.resolve().then(() => pushState(doc.seq)).catch(() => {})
  }

  /** 本地快捷命令：直接改编辑器，然后把镜像推回服务端。 */
  async function applyLocal(commands) {
    st.busy = true
    try {
      await adapter.apply(commands || [])
      await pushState()
    } finally {
      st.busy = false
    }
  }

  /** 单轮长轮询；pump 循环调用它，测试也可单独调用。 */
  async function pumpOnce() {
    if (!st.active) return false
    const doc = await request(`/watch?seq=${st.lastSeq}&shot=${st.lastShotReq}&ui=${st.lastUiSeq}&timeout=${timing.pollTimeoutSec}`)
    if (!doc) return false

    /* 服务端 shot_req 计数被重置（runtime 换代/服务重启）时回退本地游标，
       否则 doc.shot_req 永远小于旧游标，截图从此失灵直到页面刷新。 */
    if ((doc.shot_req | 0) < (st.lastShotReq | 0)) st.lastShotReq = doc.shot_req | 0
    if (doc.shot_req && doc.shot_req > st.lastShotReq) {
      st.lastShotReq = doc.shot_req
      shoot(doc.shot_req)
    }

    if ((doc.seq | 0) !== (st.lastSeq | 0)) {
      st.lastSeq = doc.seq | 0
      if (authority === 'editor') {
        if (doc.cmds && doc.cmds.length) await apply(doc)
      } else if (st.lastSeq > 0) {
        st.busy = true
        try {
          const mirror = await request(documentPath)
          const value = mirror && mirror[documentKey]
          if (value !== undefined) await adapter.load(value)
        } catch { /* 镜像失败下一轮重试 */ }
        finally { st.busy = false }
      }
    }

    if ((doc.ui_seq | 0) > (st.lastUiSeq | 0)) {
      st.lastUiSeq = doc.ui_seq | 0
      st.busy = true
      try {
        const uiDoc = await request('/ui')
        await adapter.applyUi?.(uiDoc.ui || [])
      } catch { /* 页面级命令失败不阻塞下一轮 */ }
      finally { st.busy = false }
    }
    return true
  }

  async function pump() {
    if (st.pumping) return
    st.pumping = true
    try {
      for (;;) {
        if (st.stopped) break
        if (!st.active) { await sleep(1500); continue }
        try { await pumpOnce() } catch { await sleep(timing.errorRetryMs) }
      }
    } finally {
      st.pumping = false
    }
  }

  /** 截图：永远回传新渲染帧，不回旧缓存。 */
  async function shoot(req) {
    if (st.shooting) { st.pendingShotReq = req; return }
    st.shooting = true
    try {
      const idleDeadline = Date.now() + timing.shotIdleMs
      while (st.busy && Date.now() < idleDeadline) await sleep(100)

      let current = req
      for (;;) {
        let data = ''
        for (let attempt = 0; attempt < 2 && !data; attempt++) {
          try { data = await adapter.renderScreenshot() } catch { await sleep(400) }
        }
        if (!data) {
          try { await post('/shot-result', { req: current, data: '' }) } catch { /* 工具端会快速失败 */ }
          throw new Error('画面渲染为空')
        }
        st.shotCache = data
        await post('/shot-result', { req: current, data })
        if (st.pendingShotReq && st.pendingShotReq !== current) {
          current = st.pendingShotReq
          st.pendingShotReq = null
          continue
        }
        break
      }
    } catch (caught) {
      badge('', 'error')
      note('截图失败：' + String((caught && caught.message) || caught))
    } finally {
      st.shooting = false
      st.pendingShotReq = null
    }
  }

  /** 编辑器 change → 防抖 POST /state（agent 的「看」）。 */
  function watch() {
    if (st.watching || typeof adapter.onChange !== 'function') return
    st.watching = true
    st.onchange = () => {
      clearTimeout(st.stateTimer)
      st.stateTimer = setTimeout(() => { pushState().catch(() => {}) }, timing.stateDebounceMs)
    }
    st.unsubscribe = adapter.onChange(st.onchange) || null
  }

  async function pushState(seq) {
    if (!st.active) return
    if (adapter.isMounted && !adapter.isMounted()) return
    try {
      const body = { [documentKey]: adapter.dump() }
      if (seq != null) body.seq = Number(seq)
      else if (st.lastSeq) body.seq = Number(st.lastSeq)
      await post('/state', body)
    } catch { /* 下一轮 change 再推 */ }
  }

  function release() {
    try {
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        const body = new Blob([JSON.stringify({ id: st.clientId })], { type: 'application/json' })
        navigator.sendBeacon(apiBase + '/release', body)
        return
      }
      post('/release', { id: st.clientId }).catch(() => {})
    } catch { /* 页面关闭路径不能抛 */ }
  }

  /* ---- Web Worker 心跳（不受标签页节流影响） ---- */
  function startHeartbeatWorker() {
    if (st.heartbeatWorker) return
    try {
      const worker = workerFactory
        ? workerFactory()
        : (typeof Worker !== 'undefined' ? new Worker(heartbeatWorkerUrl) : null)
      if (!worker) { startFallbackHeartbeat(); return }
      st.heartbeatWorker = worker
      if (st.heartbeat) { clearInterval(st.heartbeat); st.heartbeat = null }
      worker.onmessage = (event) => {
        if ((event.data || {}).type === 'error') {
          stopHeartbeatWorker()
          startFallbackHeartbeat()
        }
      }
      worker.onerror = () => {
        stopHeartbeatWorker()
        startFallbackHeartbeat()
      }
      worker.postMessage({ type: 'start', data: { clientId: st.clientId, apiBase } })
    } catch {
      startFallbackHeartbeat()
    }
  }

  function stopHeartbeatWorker() {
    if (st.heartbeatWorker) {
      try { st.heartbeatWorker.postMessage({ type: 'stop' }) } catch { /* ignore */ }
      try { st.heartbeatWorker.terminate() } catch { /* ignore */ }
      st.heartbeatWorker = null
    }
    if (st.heartbeat) {
      clearInterval(st.heartbeat)
      st.heartbeat = null
    }
  }

  function startFallbackHeartbeat() {
    if (st.heartbeat) return
    st.heartbeat = setInterval(async () => {
      if (!st.active) return
      const ok = await claim()
      if (!ok) {
        st.active = false
        badge('', 'standby')
        note('')
      }
    }, timing.heartbeatMs)
  }

  function stop() {
    st.stopped = true
    st.active = false
    clearTimeout(st.stateTimer)
    st.stateTimer = null
    stopHeartbeatWorker()
    try { st.unsubscribe?.() } catch { /* ignore */ }
    st.unsubscribe = null
    st.watching = false
  }

  return {
    state: st,
    claim,
    ensureLinked,
    restore,
    activate,
    claimLoop,
    apply,
    applyLocal,
    pumpOnce,
    pump,
    shoot,
    watch,
    pushState,
    release,
    startHeartbeatWorker,
    stopHeartbeatWorker,
    startFallbackHeartbeat,
    stop,
    note,
    badge,
  }
}
