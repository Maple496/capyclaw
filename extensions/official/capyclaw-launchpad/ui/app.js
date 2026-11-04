/* dsh-launchpad 管理界面：无构建依赖，直接同源 fetch /api/*。 */
(() => {
  const $ = (id) => document.getElementById(id)
  const STATE_LABEL = {
    running: '运行中', stopped: '已停止', degraded: '异常', invalid: 'DSL 错误', error: '错误', unknown: '未知',
  }
  const state = {
    launchpads: [],
    dir: '',
    dshd: '',
    selectedId: null,
    detail: null,
    dirty: false,
    busy: false,
    catalog: [],
    catalogLoading: false,
    catalogError: '',
    listSignature: '',
    serverPid: null,
    token: localStorage.getItem('launchpad.token') || '',
  }

  function label(value) {
    return STATE_LABEL[value] || value || '未知'
  }

  function badge(text, cls) {
    const el = document.createElement('span')
    el.className = `badge ${cls || ''}`.trim()
    el.textContent = text
    return el
  }

  function showBanner(message, ok = false) {
    const el = $('banner')
    el.hidden = false
    el.textContent = message
    el.className = `banner${ok ? ' ok' : ''}`
  }

  function clearBanner() {
    const el = $('banner')
    el.hidden = true
    el.textContent = ''
  }

  function showOutput(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    $('output').textContent = text || ''
  }

  async function api(path, options = {}) {
    const headers = {}
    if (options.body) headers['content-type'] = 'application/json'
    if (state.token) headers['x-launchpad-token'] = state.token
    const res = await fetch(path, { ...options, headers })
    const text = await res.text()
    let data = null
    if (text) {
      try { data = JSON.parse(text) } catch { data = text }
    }
    if (res.status === 401) {
      showBanner('需要 token：在右上角填写 x-launchpad-token 后重试')
      $('token').focus()
      throw new Error('unauthorized')
    }
    if (!res.ok && res.status !== 207) {
      const message = data?.error?.message || (typeof data === 'string' ? data : `HTTP ${res.status}`)
      throw new Error(message)
    }
    return data
  }

  async function installArchive() {
    const file = $('archive').files[0]
    const token = $('install-token').value
    const result = $('install-result')
    if (!file || !token) { result.textContent = '请选择安装包并输入安装 token。'; return }
    if (file.size > 64 * 1024 * 1024 || !file.size) { result.textContent = '安装包必须大于 0 且不超过 64 MiB。'; return }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(file.name)) { result.textContent = '文件名仅支持字母、数字、点、下划线和连字符。'; return }
    if (!window.confirm(`确认安装本地包 ${file.name}（${file.size} 字节）？仅安装您信任的包。`)) return
    $('install').disabled = true
    result.textContent = '正在安装…'
    try {
      const headers = { 'content-type': 'application/octet-stream', 'x-archive-filename': file.name, 'x-launcher-install-token': token }
      if (state.token) headers['x-launchpad-token'] = state.token
      const res = await fetch('/api/launcher/install', { method: 'POST', headers, body: file, cache: 'no-store' })
      const data = await res.json()
      if (!res.ok || data.ok === false) throw new Error(data?.error?.message || `HTTP ${res.status}`)
      result.textContent = `安装成功\n${JSON.stringify(data.result ?? {}, null, 2)}`
      $('archive').value = ''
      await refreshList({ quiet: true })
      if (data.result?.id) await selectLaunchpad(data.result.id)
    } catch (error) {
      result.textContent = `安装失败：${error.message}`
    } finally {
      $('install-token').value = ''
      $('install').disabled = false
    }
  }

  async function checkServer() {
    try {
      const res = await fetch('/healthz', {
        cache: 'no-store',
        signal: AbortSignal.timeout(2000),
      })
      if (!res.ok) return
      const health = await res.json()
      if (!state.serverPid) {
        state.serverPid = health.pid
      } else if (health.pid !== state.serverPid) {
        /* 服务重启过：当前 DOM 可能是旧版本，直接换到新界面。 */
        window.location.reload()
      }
    } catch { /* 服务短暂不可用，下一次再试 */ }
  }

  function setBusy(busy, message) {
    state.busy = busy
    if (message) showOutput(message)
    updateButtons()
    renderPlugins()
  }

  function isRunning() {
    return state.detail && (state.detail.state === 'running' || state.detail.state === 'degraded')
  }

  function updateButtons() {
    const has = !!state.detail
    const host = !!state.detail?.host
    const running = isRunning()
    for (const id of ['save', 'validate', 'plan', 'start', 'stop', 'delete']) {
      $(id).disabled = state.busy || !has
    }
    if (has && !state.busy) {
      $('start').disabled = running
      $('stop').disabled = host || !running
      $('delete').disabled = host || running
    }
    $('dirty').hidden = !state.dirty
  }

  function renderList(force = false) {
    /* 轮询每 5s 一次；列表没变就不重建 DOM，否则会打断用户点击。 */
    const signature = JSON.stringify({
      dir: state.dir,
      selectedId: state.selectedId,
      items: state.launchpads.map((lp) => [
        lp.id, lp.name, lp.state, lp.kind, lp.profile, lp.host,
        lp.errors?.length || 0, lp.errors?.[0]?.message || '',
      ]),
    })
    if (!force && signature === state.listSignature) return
    state.listSignature = signature
    const list = $('list')
    list.replaceChildren()
    $('count').textContent = `${state.launchpads.length} 个`
    $('dir').textContent = state.dir ? `DSL: ${state.dir}` : ''
    for (const lp of state.launchpads) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `item${lp.id === state.selectedId ? ' selected' : ''}`
      const top = document.createElement('div')
      top.className = 'item-top'
      const name = document.createElement('span')
      name.className = 'item-name'
      name.textContent = lp.name || lp.id
      top.append(name, badge(label(lp.state), lp.state))
      const sub = document.createElement('div')
      sub.className = 'item-sub'
      sub.textContent = `${lp.kind || 'profile'} · ${lp.profile || '?'}${lp.host ? ' · HOST' : ''}`
      btn.append(top, sub)
      if (lp.errors?.length) {
        const error = document.createElement('div')
        error.className = 'item-error'
        error.textContent = lp.errors[0].message || String(lp.errors[0])
        btn.append(error)
      }
      btn.addEventListener('click', () => { void selectLaunchpad(lp.id) })
      list.append(btn)
    }
  }

  function renderBadges() {
    const box = $('badges')
    box.replaceChildren()
    if (!state.detail) return
    box.append(badge(label(state.detail.state), state.detail.state))
    if (state.detail.host) box.append(badge('HOST', 'host'))
    box.append(badge(state.detail.kind || 'profile'))
  }

  function renderIssues(errors = [], warnings = []) {
    const box = $('issues')
    box.replaceChildren()
    let count = 0
    for (const error of errors || []) {
      count += 1
      const line = document.createElement('div')
      line.className = 'issue error'
      const where = error.line ? `第 ${error.line} 行: ` : ''
      line.textContent = `✗ ${where}${error.message || error}`
      box.append(line)
    }
    for (const warning of warnings || []) {
      count += 1
      const line = document.createElement('div')
      line.className = 'issue warning'
      line.textContent = `! ${warning.message || warning}`
      box.append(line)
    }
    if (!count) {
      const empty = document.createElement('div')
      empty.className = 'issue issue-muted'
      empty.textContent = '无'
      box.append(empty)
    }
    $('issue-count').textContent = count ? `${count} 项` : ''
  }

  function statusLine(key, value) {
    const line = document.createElement('div')
    line.className = 'status-line'
    const k = document.createElement('span')
    k.className = 'status-key'
    k.textContent = key
    const v = document.createElement('span')
    v.className = 'status-url'
    v.textContent = value || '—'
    line.append(k, v)
    return line
  }

  function renderStatus() {
    const box = $('status')
    box.replaceChildren()
    const status = state.detail?.status
    $('status-state').textContent = state.detail ? label(state.detail.state) : ''
    if (!status) {
      box.append(statusLine('状态', '—'))
      return
    }
    box.append(statusLine('state', status.state || '—'))
    if (status.dsh) {
      box.append(statusLine('dsh', `${status.dsh.url || '—'}${status.dsh.pid ? `  pid=${status.dsh.pid}` : ''}`))
    }
    if (status.broker) {
      box.append(statusLine('broker', `${status.broker.url || '—'}${status.broker.httpStatus ? `  http=${status.broker.httpStatus}` : ''}`))
    }
    if (status.services?.length) {
      const chips = document.createElement('div')
      chips.className = 'services'
      for (const service of status.services) {
        const chip = document.createElement('span')
        chip.className = 'service'
        chip.textContent = `${service.id}:${service.state}`
        chips.append(chip)
      }
      box.append(chips)
    }
  }

  function renderDetail() {
    const detail = state.detail
    $('empty').hidden = !!detail
    $('workspace').hidden = !detail
    if (!detail) return
    $('title').textContent = detail.name || detail.id
    $('meta').textContent = `${detail.id} · ${detail.kind || 'profile'} · profile=${detail.profile || '?'} · services=${(detail.services || []).length}`
      + (detail.host ? ' · HOST（停止请用 dshd stop）' : '')
    if ($('editor').value !== state.text) $('editor').value = state.text
    renderBadges()
    renderIssues(detail.errors, detail.warnings)
    renderStatus()
    renderPlugins()
    void ensureCatalog()
    updateButtons()
  }

  async function refreshList({ quiet = false, selectMissing = false } = {}) {
    try {
      const data = await api('/api/launchpads')
      state.launchpads = data.launchpads || []
      state.dir = data.dir || ''
      state.dshd = data.dshd || ''
      renderList()
      if (!state.selectedId && state.launchpads.length) {
        await selectLaunchpad(state.launchpads[0].id)
      } else if (selectMissing && state.selectedId
        && !state.launchpads.some((lp) => lp.id === state.selectedId)) {
        state.selectedId = null
        state.detail = null
        state.text = ''
        renderDetail()
      }
      if (!quiet) clearBanner()
    } catch (error) {
      if (!quiet) showBanner(error.message)
    }
  }

  async function selectLaunchpad(id) {
    if (state.dirty && !window.confirm('当前有未保存修改，放弃并切换？')) return
    try {
      const data = await api(`/api/launchpads/${encodeURIComponent(id)}`)
      state.selectedId = id
      state.detail = data.launchpad
      state.text = data.launchpad.text || ''
      state.dirty = false
      renderDetail()
      renderList()
      clearBanner()
    } catch (error) {
      showBanner(error.message)
    }
  }

  async function saveIfDirty() {
    if (!state.dirty) return true
    const id = state.selectedId
    if (!id) return false
    try {
      const data = await api(`/api/launchpads/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ text: $('editor').value }),
      })
      state.detail = data.launchpad
      state.text = data.launchpad.text || $('editor').value
      state.dirty = false
      renderDetail()
      renderList()
      showOutput('已保存')
      return !(data.launchpad.errors || []).length
    } catch (error) {
      showBanner(error.message)
      return false
    }
  }

  async function doSave() {
    state.dirty = true
    await saveIfDirty()
  }

  async function doValidate() {
    const id = state.selectedId
    if (!id) return
    if (!(await saveIfDirty())) {
      showOutput('DSL 有错误，已在“问题”里显示')
      return
    }
    setBusy(true, '校验中…')
    try {
      const result = await api(`/api/launchpads/${encodeURIComponent(id)}/validate`, { method: 'POST' })
      renderIssues(result.errors, result.warnings)
      showOutput(result)
      if (result.ok) showBanner('DSL 校验通过', true)
    } catch (error) {
      showBanner(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function doPlan() {
    const id = state.selectedId
    if (!id) return
    if (!(await saveIfDirty())) return
    setBusy(true, 'plan 中（dshd stack plan）…')
    try {
      const result = await api(`/api/launchpads/${encodeURIComponent(id)}/plan`, { method: 'POST' })
      showOutput(result)
      if (result.plan?.errors?.length) {
        renderIssues(result.plan.errors.map((message) => ({ message })), result.plan.warnings || [])
      } else if (result.plan?.warnings?.length) {
        renderIssues([], result.plan.warnings)
      }
      if (result.ok) showBanner('plan 通过', true)
      else showBanner('plan 未通过，查看输出与问题')
      await refreshList({ quiet: true })
    } catch (error) {
      showBanner(error.message)
      showOutput(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function doStart() {
    const id = state.selectedId
    if (!id) return
    if (!(await saveIfDirty())) return
    if (!window.confirm(`启动 ${state.detail?.name || id}？\n会使用 DSL 里的 home/profile/端口，通过 dshd 拉起。`)) return
    setBusy(true, '启动中（dshd start，可能需要几秒）…')
    try {
      const result = await api(`/api/launchpads/${encodeURIComponent(id)}/start`, { method: 'POST' })
      showOutput(result)
      if (result.status) {
        state.detail.status = result.status
        state.detail.state = result.status.state
        state.detail.running = result.status.state === 'running'
      }
      renderBadges()
      renderStatus()
      updateButtons()
      if (result.ok) showBanner('启动成功', true)
      else showBanner('启动命令已执行，但状态不是 running；查看输出')
      await refreshList({ quiet: true })
      if (result.ok) {
        try {
          const fresh = await api(`/api/launchpads/${encodeURIComponent(id)}`)
          state.detail = fresh.launchpad
          state.text = fresh.launchpad.text || state.text
          state.dirty = false
          renderDetail()
        } catch { /* 状态已更新，详情刷新失败不阻塞 */ }
      }
    } catch (error) {
      showBanner(error.message)
      showOutput(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function doStop() {
    const id = state.selectedId
    if (!id) return
    if (state.detail?.host) return
    if (!window.confirm(`停止 ${state.detail?.name || id}？会停掉该模式的 dsh/broker/服务。`)) return
    setBusy(true, '停止中…')
    try {
      const result = await api(`/api/launchpads/${encodeURIComponent(id)}/stop`, { method: 'POST' })
      showOutput(result)
      if (result.status) {
        state.detail.status = result.status
        state.detail.state = result.status.state
        state.detail.running = result.status.state === 'running'
      }
      renderBadges()
      renderStatus()
      updateButtons()
      showBanner(result.ok ? '已停止' : '停止命令已执行，状态未变为 stopped', result.ok)
      await refreshList({ quiet: true })
    } catch (error) {
      showBanner(error.message)
      showOutput(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function doDelete() {
    const id = state.selectedId
    if (!id) return
    if (!window.confirm(`删除 launchpad ${state.detail?.name || id}？DSL 文件会被删除。`)) return
    setBusy(true, '删除中…')
    try {
      await api(`/api/launchpads/${encodeURIComponent(id)}`, { method: 'DELETE' })
      state.selectedId = null
      state.detail = null
      state.text = ''
      state.dirty = false
      renderDetail()
      showOutput('已删除')
      await refreshList({ quiet: true, selectMissing: true })
    } catch (error) {
      showBanner(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function doNew() {
    const name = window.prompt('新 launchpad 名称（会生成 DSL 文件）', 'my-mode')
    if (!name) return
    setBusy(true, '创建中…')
    try {
      const result = await api('/api/launchpads', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      await refreshList({ quiet: true })
      await selectLaunchpad(result.launchpad.id)
      showBanner(`已创建 ${result.launchpad.id}.stack；编辑后点“启动”`, true)
    } catch (error) {
      showBanner(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function poll() {
    if (state.busy) return
    await checkServer()
    try {
      const data = await api('/api/launchpads')
      state.launchpads = data.launchpads || []
      state.dir = data.dir || ''
      renderList()
      if (!state.selectedId) return
      const summary = state.launchpads.find((lp) => lp.id === state.selectedId)
      if (summary && state.detail) {
        state.detail.state = summary.state
        state.detail.running = summary.running
        state.detail.host = summary.host
        renderBadges()
        updateButtons()
      }
      const status = await api(`/api/launchpads/${encodeURIComponent(state.selectedId)}/status`)
      if (state.detail) {
        state.detail.status = status.status
        state.detail.state = status.launchpad.state
        state.detail.running = status.launchpad.running
        state.detail.host = status.launchpad.host
        renderBadges()
        renderStatus()
        updateButtons()
      }
    } catch { /* 轮询失败静默；下一次再试 */ }
  }

  /* ---------------- 插件面板 ---------------- */

  function bundleName(bundle) {
    if (typeof bundle === 'string') return bundle
    return bundle && typeof bundle.name === 'string' ? bundle.name : ''
  }

  function bundleSub(bundle) {
    if (!bundle || typeof bundle === 'string') return ''
    return bundle.path || (bundle.version ? `version ${bundle.version}` : '')
  }

  function pluginRow(name, sub, options = {}) {
    const row = document.createElement('div')
    row.className = 'plugin-row'
    const grow = document.createElement('div')
    grow.className = 'grow'
    const title = document.createElement('div')
    title.textContent = name
    grow.append(title)
    if (sub) {
      const s = document.createElement('div')
      s.className = 'sub'
      s.textContent = sub
      grow.append(s)
    }
    row.append(grow)
    if (options.tag) {
      const tag = document.createElement('span')
      tag.className = `tag ${options.tagClass || ''}`.trim()
      tag.textContent = options.tag
      row.append(tag)
    }
    if (options.action) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'btn tiny'
      button.textContent = options.actionLabel || '添加'
      button.disabled = state.busy
      button.addEventListener('click', options.action)
      row.append(button)
    }
    return row
  }

  function emptyRow(text) {
    const el = document.createElement('div')
    el.className = 'plugin-empty'
    el.textContent = text
    return el
  }

  function renderPlugins() {
    const desiredBox = $('plugins-desired')
    const actualBox = $('plugins-actual')
    const catalogBox = $('plugins-catalog')
    desiredBox.replaceChildren()
    actualBox.replaceChildren()
    catalogBox.replaceChildren()
    const detail = state.detail
    if (!detail) {
      $('plugins-desired-count').textContent = ''
      $('plugins-actual-count').textContent = ''
      $('plugins-catalog-count').textContent = ''
      $('plugins-drift').textContent = ''
      return
    }
    const desired = detail.stack?.plugins?.bundles || []
    const actual = detail.profileState || { exists: false, bundles: [], missing: [], extra: [] }
    $('plugins-desired-count').textContent = `${desired.length} 个`
    $('plugins-actual-count').textContent = actual.exists ? `${actual.bundles.length} 个` : '未生成'
    if (!desired.length) desiredBox.append(emptyRow('还没有插件；可从右侧目录添加'))
    for (const bundle of desired) {
      const name = bundleName(bundle)
      if (!name) continue
      desiredBox.append(pluginRow(name, bundleSub(bundle), {
        action: () => { void removePlugin(name) },
        actionLabel: '移除',
      }))
    }
    if (!actual.exists) {
      actualBox.append(emptyRow('profile 尚未生成；Plan/Start 后出现'))
    } else if (!actual.bundles.length) {
      actualBox.append(emptyRow('profile bundles 为空'))
    } else {
      for (const name of actual.bundles) {
        const tag = (actual.missing || []).includes(name) ? 'missing'
          : ((actual.extra || []).includes(name) ? 'extra' : '')
        actualBox.append(pluginRow(name, '', tag ? { tag, tagClass: tag } : {}))
      }
    }
    $('plugins-drift').textContent = !actual.exists
      ? 'profile 尚未生成；Plan/Start 后出现'
      : ((actual.missing?.length || actual.extra?.length)
        ? `未生效: ${(actual.missing || []).join(', ') || '-'}；profile 多出: ${(actual.extra || []).join(', ') || '-'}`
        : 'profile 与 DSL 一致')

    const desiredNames = new Set(desired.map(bundleName))
    const catalog = (state.catalog || []).filter((plugin) => !desiredNames.has(plugin.name))
    $('plugins-catalog-count').textContent = state.catalogLoading ? '扫描中…'
      : (catalog.length ? `${catalog.length} 个` : '')
    if (state.catalogError) catalogBox.append(emptyRow(state.catalogError))
    else if (state.catalogLoading && !catalog.length) catalogBox.append(emptyRow('扫描仓库插件…'))
    else if (!catalog.length) catalogBox.append(emptyRow(state.catalog.length ? '已全部添加' : '没有发现可用插件'))
    else {
      for (const plugin of catalog) {
        catalogBox.append(pluginRow(plugin.name, plugin.title || plugin.path, {
          action: () => { void addCatalogPlugin(plugin) },
          actionLabel: '添加',
        }))
      }
    }
  }

  async function ensureCatalog(force = false) {
    if (state.catalogLoading) return
    if (!force && state.catalog.length) return
    state.catalogLoading = true
    state.catalogError = ''
    renderPlugins()
    try {
      const data = await api('/api/plugins/catalog')
      state.catalog = data.plugins || []
    } catch (error) {
      state.catalogError = error.message
    } finally {
      state.catalogLoading = false
      renderPlugins()
    }
  }

  async function applyPluginBundles(next, action) {
    const id = state.selectedId
    if (!id || state.busy) return
    if (state.dirty) {
      showBanner('先保存 DSL 编辑，再操作插件（避免覆盖未保存内容）')
      return
    }
    setBusy(true, `${action}：写回 DSL…`)
    try {
      const data = await api(`/api/launchpads/${encodeURIComponent(id)}/plugins`, {
        method: 'PUT',
        body: JSON.stringify({ bundles: next }),
      })
      state.detail = data.launchpad
      state.text = data.launchpad.text || state.text
      state.dirty = false
      renderDetail()
      showBanner(`${action} 已写入 DSL；Plan/Start 后生效${data.launchpad.host ? '（HOST 需从外部 dshd stop/start）' : ''}`, true)
    } catch (error) {
      showBanner(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function addCatalogPlugin(plugin) {
    const current = state.detail?.stack?.plugins?.bundles || []
    if (current.some((bundle) => bundleName(bundle) === plugin.name)) return
    await applyPluginBundles([...current, { name: plugin.name, path: plugin.path }], `添加 ${plugin.name}`)
  }

  async function addCustomPlugin() {
    const name = $('plugin-name').value.trim()
    const pluginPath = $('plugin-path').value.trim()
    if (!name) {
      showBanner('插件名必填')
      return
    }
    const current = state.detail?.stack?.plugins?.bundles || []
    if (current.some((bundle) => bundleName(bundle) === name)) {
      showBanner(`插件已存在: ${name}`)
      return
    }
    const entry = pluginPath ? { name, path: pluginPath } : name
    await applyPluginBundles([...current, entry], `添加 ${name}`)
    $('plugin-name').value = ''
    $('plugin-path').value = ''
  }

  async function removePlugin(name) {
    if (!window.confirm(`从 DSL 移除插件 ${name}？`)) return
    const current = state.detail?.stack?.plugins?.bundles || []
    await applyPluginBundles(current.filter((bundle) => bundleName(bundle) !== name), `移除 ${name}`)
  }

  function bind() {
    $('token').value = state.token
    $('token').addEventListener('change', () => {
      state.token = $('token').value.trim()
      if (state.token) localStorage.setItem('launchpad.token', state.token)
      else localStorage.removeItem('launchpad.token')
      state.catalog = []
      state.catalogError = ''
      void refreshList()
      void ensureCatalog(true)
    })
    $('refresh').addEventListener('click', () => {
      if (state.dirty) void refreshList({ selectMissing: true })
      else if (state.selectedId) void selectLaunchpad(state.selectedId)
      else void refreshList()
    })
    $('install').addEventListener('click', () => { void installArchive() })
    $('new').addEventListener('click', () => { void doNew() })
    $('save').addEventListener('click', () => { void doSave() })
    $('validate').addEventListener('click', () => { void doValidate() })
    $('plan').addEventListener('click', () => { void doPlan() })
    $('start').addEventListener('click', () => { void doStart() })
    $('stop').addEventListener('click', () => { void doStop() })
    $('delete').addEventListener('click', () => { void doDelete() })
    $('clear-output').addEventListener('click', () => showOutput(''))
    $('plugin-add').addEventListener('click', () => { void addCustomPlugin() })
    $('plugin-name').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void addCustomPlugin() }
    })
    $('editor').addEventListener('input', () => {
      state.dirty = true
      $('dirty').hidden = false
      renderPlugins()
    })
    window.addEventListener('beforeunload', (event) => {
      if (!state.dirty) return
      event.preventDefault()
      event.returnValue = ''
    })
    window.addEventListener('pageshow', (event) => {
      /* 从 bfcache 返回时可能还是旧 DOM。 */
      if (event.persisted) window.location.reload()
    })
    window.setInterval(() => { void poll() }, 5000)
  }

  bind()
  void checkServer()
  void refreshList()
})()
