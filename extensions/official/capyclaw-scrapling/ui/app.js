/**
 * DSH 爬虫工作台前端交互（无框架、无构建，纯浏览器原生能力）。
 *
 * 职责：
 *   - 引导三步流程：选目标 → 观察爬取流程回放 → 选择器提取/导出
 *   - 所有动态内容用 textContent / createElement 渲染，杜绝 XSS
 *   - 错误一律给出「下一步做什么」的提示
 */
(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }

  var state = {
    crawlId: null,
    crawl: null,
    extracts: null,   // { key: { selector, count, values, error? } }
    replayToken: 0,
  }

  /* ---------------- 演示目标与推荐选择器 ---------------- */
  var DEMO_PRESETS = {
    quotes: [
      { key: '名言', selector: '.quote .text::text' },
      { key: '作者', selector: '.quote .author::text' },
      { key: '标签', selector: '.quote .tag::text' },
    ],
    products: [
      { key: '商品名', selector: '.product .name::text' },
      { key: '价格', selector: '.product .price::text' },
      { key: '评分', selector: '.product .rating::attr(data-score)' },
    ],
    news: [
      { key: '标题', selector: '.article h2 a::text' },
      { key: '链接', selector: '.article h2 a::attr(href)' },
      { key: '日期', selector: '.article .date::attr(datetime)' },
    ],
    'ext-quotes': [
      { key: 'Quote', selector: '.quote .text::text' },
      { key: 'Author', selector: 'small.author::text' },
      { key: 'Tags', selector: 'a.tag::text' },
    ],
  }

  var STEP_ICONS = {
    url: '🧭', request: '📤', response: '📥', body: '📄',
    dom: '🌳', extract: '🔍', done: '✅', mode: '⚠️',
  }

  /* ---------------- 健康检查 ---------------- */
  function refreshHealth() {
    fetch('/healthz').then(function (r) { return r.json() }).then(function (h) {
      var pill = $('health-pill')
      if (h.ok) {
        pill.className = 'pill pill-ok'
        pill.textContent = '服务正常 · 已爬 ' + (h.crawls || 0) + ' 次'
      } else {
        throw new Error('not ok')
      }
    }).catch(function () {
      var pill = $('health-pill')
      pill.className = 'pill pill-bad'
      pill.textContent = '服务异常 · 请重启插件'
    })
  }

  /* ---------------- 工具 ---------------- */
  function normalizeUrl(raw) {
    var text = String(raw || '').trim()
    if (!text) return null
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) text = 'http://' + text
    try {
      var u = new URL(text)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
      return u.href
    } catch (e) {
      return null
    }
  }

  function fmtBytes(n) {
    if (!n) return '0 B'
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / 1024 / 1024).toFixed(2) + ' MB'
  }

  function fmtTime(ts) {
    var d = new Date(ts)
    var pad = function (x) { return String(x).padStart(2, '0') }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  }

  function statusClass(status) {
    if (status >= 200 && status < 300) return 'status-2xx'
    if (status >= 300 && status < 400) return 'status-3xx'
    if (status >= 400) return 'status-4xx'
    return 'status-0'
  }

  function apiError(payload, fallback) {
    var err = (payload && payload.error) || {}
    return { message: err.message || fallback || '请求失败', hint: err.hint || '' }
  }

  function showCard(id) {
    var el = $(id)
    if (el) el.classList.remove('card-hidden')
  }

  /* ---------------- 第一步：目标 ---------------- */
  function currentSelectors() {
    var rows = []
    document.querySelectorAll('.selector-row').forEach(function (row) {
      var key = row.querySelector('.key-input').value.trim()
      var sel = row.querySelector('.sel-input').value.trim()
      if (sel) rows.push({ key: key || ('字段' + (rows.length + 1)), selector: sel })
    })
    return rows
  }

  function setSelectorRows(presets) {
    var wrap = $('selector-rows')
    wrap.textContent = ''
    var list = presets && presets.length ? presets : [{ key: '', selector: '' }]
    list.forEach(function (p) { wrap.appendChild(buildSelectorRow(p.key, p.selector)) })
  }

  function buildSelectorRow(key, selector) {
    var row = document.createElement('div')
    row.className = 'selector-row'

    var keyInput = document.createElement('input')
    keyInput.className = 'key-input'
    keyInput.type = 'text'
    keyInput.placeholder = '字段名（如：价格）'
    keyInput.value = key || ''

    var selInput = document.createElement('input')
    selInput.className = 'sel-input'
    selInput.type = 'text'
    selInput.placeholder = 'CSS 选择器（如：.price::text）'
    selInput.value = selector || ''

    var remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'remove-btn'
    remove.title = '删除这个字段'
    remove.textContent = '✕'
    remove.addEventListener('click', function () {
      row.remove()
      if (!document.querySelector('.selector-row')) setSelectorRows([])
    })

    row.append(keyInput, selInput, remove)
    return row
  }

  document.querySelectorAll('#demo-chips .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var url = chip.getAttribute('data-url')
      if (url.charAt(0) === '/') url = location.origin + url
      $('url-input').value = url
      $('url-input').classList.remove('invalid')
      setSelectorRows(DEMO_PRESETS[chip.getAttribute('data-kind')] || [])
    })
  })

  $('add-field-btn').addEventListener('click', function () {
    $('selector-rows').appendChild(buildSelectorRow('', ''))
  })

  $('crawl-form').addEventListener('submit', function (event) {
    event.preventDefault()
    var input = $('url-input')
    var url = normalizeUrl(input.value)
    if (!url) {
      input.classList.add('invalid')
      input.focus()
      return
    }
    input.classList.remove('invalid')
    input.value = url
    runCrawl(url)
  })

  function runCrawl(url) {
    var btn = $('crawl-btn')
    btn.disabled = true
    btn.textContent = '爬取中…'

    var body = {
      url: url,
      timeoutMs: Number($('timeout-input').value) || 20000,
      selectors: currentSelectors(),
    }
    var ua = $('ua-input').value.trim()
    if (ua) body.userAgent = ua

    fetch('/api/crawl', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json() }).then(function (payload) {
      if (!payload.crawl) throw apiError(payload, '爬取失败')
      state.crawl = payload.crawl
      state.crawlId = payload.crawl.id
      state.extracts = payload.crawl.extracts
      showCard('card-pipeline')
      showCard('card-extract')
      showCard('card-history')
      resetExtractBox()
      replaySteps(payload.crawl.steps, function () {
        if (payload.crawl.error) showErrorBanner(payload.crawl.error)
        else hideErrorBanner()
        renderSummary(payload.crawl)
        renderRawHtml(payload.crawl.htmlPreview || '')
        if (state.extracts) renderExtracts(state.extracts, payload.crawl.id)
        refreshHistory()
        refreshHealth()
        $('card-pipeline').scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }).catch(function (error) {
      showCard('card-pipeline')
      showErrorBanner({ message: error.message || '网络请求失败', hint: error.hint || '请确认工作台服务还在运行（右上角状态灯），然后重试。' })
    }).finally(function () {
      btn.disabled = false
      btn.textContent = '开始爬取'
    })
  }

  /* ---------------- 第二步：流程回放 ---------------- */
  function buildStepElement(step) {
    var li = document.createElement('li')
    li.className = 'step'
    li.dataset.stepId = step.id || ''

    var icon = document.createElement('span')
    icon.className = 'step-icon'

    var bodyEl = document.createElement('div')
    bodyEl.className = 'step-body'

    var label = document.createElement('div')
    label.className = 'step-label'

    var detail = document.createElement('div')
    detail.className = 'step-detail'

    bodyEl.append(label, detail)

    var ms = document.createElement('span')
    ms.className = 'step-ms'

    li.append(icon, bodyEl, ms)
    return li
  }

  function setStepState(li, phase, step) {
    li.className = 'step step-' + phase
    var icon = li.querySelector('.step-icon')
    var label = li.querySelector('.step-label')
    var detail = li.querySelector('.step-detail')
    var ms = li.querySelector('.step-ms')
    label.textContent = step.label
    detail.textContent = step.detail || ''
    if (phase === 'active') {
      icon.textContent = '⏳'
      ms.textContent = '…'
    } else {
      icon.textContent = STEP_ICONS[step.id] || '•'
      if (phase === 'skip') {
        ms.textContent = '跳过'
      } else if (typeof step.ms === 'number') {
        ms.textContent = ''
        var b = document.createElement('b')
        if (step.ms >= 1000) b.textContent = (step.ms / 1000).toFixed(2) + ' s'
        else if (step.ms < 1) b.textContent = '<1 ms'
        else b.textContent = Math.round(step.ms) + ' ms'
        ms.appendChild(b)
      }
      if (phase === 'done') icon.textContent = '✔'
      if (phase === 'warn') icon.textContent = '⚠️'
      if (phase === 'error') icon.textContent = '✖'
    }
  }

  /* 按真实时间轴回放（每步回放时长压缩到 0.12s–0.9s，观感与真实兼顾） */
  function replaySteps(steps, onDone) {
    var token = ++state.replayToken
    var pipeline = $('pipeline')
    pipeline.textContent = ''
    var elements = (steps || []).map(function (step) {
      var li = buildStepElement(step)
      pipeline.appendChild(li)
      return li
    })
    var index = 0
    var hasError = false

    function next() {
      if (token !== state.replayToken) return
      if (index >= elements.length) { if (onDone) onDone(); return }
      var step = steps[index]
      var li = elements[index]
      if (hasError) {
        setStepState(li, 'skip', { label: step.label, detail: '已中止' })
        index++
        setTimeout(next, 60)
        return
      }
      setStepState(li, 'active', step)
      li.scrollIntoView({ block: 'nearest' })
      var delay = Math.min(Math.max(step.ms || 0, 150), 900)
      setTimeout(function () {
        if (token !== state.replayToken) return
        var phase = step.status === 'error' ? 'error' : step.status === 'warn' ? 'warn' : step.status === 'skip' ? 'skip' : 'done'
        if (step.status === 'error') hasError = true
        setStepState(li, phase, step)
        index++
        setTimeout(next, 140)
      }, delay)
    }
    next()
  }

  function showErrorBanner(error) {
    var banner = $('crawl-error')
    banner.classList.remove('banner-hidden')
    banner.textContent = ''
    var b = document.createElement('b')
    b.textContent = '✖ ' + error.message
    banner.appendChild(b)
    if (error.hint) {
      var hint = document.createElement('span')
      hint.className = 'hint'
      hint.textContent = '下一步：' + error.hint
      banner.appendChild(hint)
    }
  }

  function hideErrorBanner() {
    $('crawl-error').classList.add('banner-hidden')
  }

  /* 新爬取/切历史时清掉上一次的数据表，避免旧数据误导 */
  function resetExtractBox() {
    $('extract-result').classList.add('result-hidden')
    $('result-table-wrap').textContent = ''
    $('result-json').textContent = ''
    $('result-note').textContent = ''
    state.lastExport = null
  }

  function renderSummary(crawl) {
    var box = $('page-summary')
    box.classList.remove('summary-hidden')
    box.textContent = ''

    function item(k, vContent) {
      var el = document.createElement('div')
      el.className = 'summary-item'
      var key = document.createElement('div')
      key.className = 'k'
      key.textContent = k
      var val = document.createElement('div')
      val.className = 'v'
      if (vContent instanceof Node) val.appendChild(vContent)
      else val.textContent = vContent
      el.append(key, val)
      return el
    }

    var status = document.createElement('span')
    status.className = 'status-badge ' + statusClass(crawl.status)
    status.textContent = 'HTTP ' + crawl.status
    box.appendChild(item('状态', status))
    box.appendChild(item('页面标题', crawl.title || '（无标题）'))
    box.appendChild(item('内容大小', fmtBytes(crawl.bytes)))
    if (crawl.stats) box.appendChild(item('元素数量', crawl.stats.elements + ' 个'))
    if (crawl.stats) box.appendChild(item('文档深度', String(crawl.stats.maxDepth)))
    box.appendChild(item('总耗时', (crawl.totalMs / 1000).toFixed(2) + ' s'))
    if (crawl.finalUrl && crawl.finalUrl !== crawl.url) box.appendChild(item('最终地址（重定向后）', crawl.finalUrl))
  }

  function renderRawHtml(html) {
    $('raw-html-pre').textContent = html ? html.slice(0, 40000) : '（无内容）'
  }

  /* ---------------- 第三步：提取 ---------------- */
  $('extract-btn').addEventListener('click', function () {
    var selectors = currentSelectors()
    if (!selectors.length) {
      alert('请先填写至少一个 CSS 选择器。小提示：点上面的演示目标会自动配好示例选择器。')
      return
    }
    if (!state.crawlId) {
      alert('请先完成一次爬取（第一步），再提取数据。')
      return
    }
    var btn = $('extract-btn')
    btn.disabled = true
    btn.textContent = '提取中…'
    fetch('/api/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ crawlId: state.crawlId, selectors: selectors }),
    }).then(function (r) { return r.json() }).then(function (payload) {
      if (!payload.ok) throw apiError(payload, '提取失败')
      state.extracts = payload.results
      renderExtracts(payload.results, state.crawlId)
    }).catch(function (error) {
      alert('提取失败：' + error.message + (error.hint ? '\n\n下一步：' + error.hint : ''))
    }).finally(function () {
      btn.disabled = false
      btn.textContent = '提取数据'
    })
  })

  function extractColumns(results) {
    return Object.keys(results)
  }

  function renderExtracts(results, crawlId) {
    var box = $('extract-result')
    box.classList.remove('result-hidden')
    var keys = extractColumns(results)
    var total = keys.reduce(function (sum, k) { return sum + (results[k].count || 0) }, 0)

    /* 表格视图 */
    var tableWrap = $('result-table-wrap')
    tableWrap.textContent = ''
    if (!total) {
      var empty = document.createElement('p')
      empty.className = 'result-note'
      empty.textContent = '没有抓到数据。常见原因：选择器写错了，或页面里确实没有这个元素。可以先展开「原始 HTML」确认写法。'
      tableWrap.appendChild(empty)
    } else {
      var table = document.createElement('table')
      table.className = 'data'
      var thead = document.createElement('thead')
      var headRow = document.createElement('tr')
      keys.forEach(function (k) {
        var th = document.createElement('th')
        th.textContent = k + '（' + results[k].count + '）'
        headRow.appendChild(th)
      })
      thead.appendChild(headRow)
      table.appendChild(thead)

      var maxRows = keys.reduce(function (m, k) { return Math.max(m, results[k].values.length) }, 0)
      /* 渲染上限：超大结果集只画前 500 行，导出仍含全部数据 */
      var renderRows = Math.min(maxRows, 500)
      var tbody = document.createElement('tbody')
      for (var i = 0; i < renderRows; i++) {
        var tr = document.createElement('tr')
        keys.forEach(function (k) {
          var td = document.createElement('td')
          var cell = results[k].values[i]
          if (cell === undefined) {
            td.textContent = '—'
            td.style.color = '#aaa'
          } else {
            var text = String(cell)
            td.textContent = text.length > 300 ? text.slice(0, 300) + '…' : text
            if (text.length > 300) td.title = text
          }
          tr.appendChild(td)
        })
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)

      var wrap = document.createElement('div')
      wrap.className = 'table-wrap'
      wrap.appendChild(table)
      tableWrap.appendChild(wrap)
    }

    /* JSON 视图 */
    var json = {}
    keys.forEach(function (k) {
      json[k] = results[k].error ? { error: results[k].error } : results[k].values
    })
    $('result-json').textContent = JSON.stringify(json, null, 2)

    /* 备注行 */
    var maxRowsAll = keys.reduce(function (m, k) { return Math.max(m, results[k].values.length) }, 0)
    var badKeys = keys.filter(function (k) { return results[k].error })
    var note = $('result-note')
    note.textContent = crawlId
      ? '记录 ' + crawlId + ' · ' + keys.length + ' 个字段 · 共 ' + total + ' 条数据'
        + (maxRowsAll > 500 ? ' · 表格仅显示前 500 行（导出的 CSV/JSON 包含全部 ' + total + ' 条）' : '')
        + (badKeys.length ? ' · ⚠️ ' + badKeys.length + ' 个字段选择器有误（见表格标注）' : '')
      : ''
    if (badKeys.length) {
      badKeys.forEach(function (k) {
        var p = document.createElement('div')
        p.textContent = '⚠️ 「' + k + '」' + results[k].error
        note.appendChild(document.createElement('br'))
        note.appendChild(p)
      })
    }
    state.lastExport = { json: json, keys: keys, results: results }
  }

  /* 结果视图切换 */
  document.querySelectorAll('.result-tabs .tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.result-tabs .tab').forEach(function (t) { t.classList.remove('tab-active') })
      tab.classList.add('tab-active')
      var isTable = tab.dataset.tab === 'table'
      $('result-table-wrap').hidden = !isTable
      $('result-json').hidden = isTable
    })
  })

  /* 导出与复制 */
  function downloadFile(name, content, type) {
    var blob = new Blob([content], { type: type })
    var a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(function () { URL.revokeObjectURL(a.href) }, 5000)
  }

  function exportData() {
    if (!state.lastExport) return null
    return state.lastExport
  }

  $('copy-json-btn').addEventListener('click', function () {
    var data = exportData()
    if (!data) return
    var text = JSON.stringify(data.json, null, 2)
    var btn = $('copy-json-btn')
    var done = function () {
      btn.textContent = '✓ 已复制'
      setTimeout(function () { btn.textContent = '复制 JSON' }, 1600)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done) })
    } else {
      fallbackCopy(text, done)
    }
  })

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy'); done() } catch (e) { alert('复制失败，请手动在 JSON 标签页里选择复制。') }
    ta.remove()
  }

  $('download-json-btn').addEventListener('click', function () {
    var data = exportData()
    if (!data) return
    var text = JSON.stringify(data.json, null, 2)
    downloadFile('dsh-scrapling-' + (state.crawlId || 'data') + '.json', text, 'application/json;charset=utf-8')
  })

  $('download-csv-btn').addEventListener('click', function () {
    var data = exportData()
    if (!data) return
    var keys = data.keys
    var maxRows = keys.reduce(function (m, k) { return Math.max(m, data.results[k].values.length) }, 0)
    var esc = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"' }
    var lines = [keys.map(esc).join(',')]
    for (var i = 0; i < maxRows; i++) {
      lines.push(keys.map(function (k) { return esc(data.results[k].values[i]) }).join(','))
    }
    /* UTF-8 BOM：保证 Excel 直接打开不乱码 */
    downloadFile('dsh-scrapling-' + (state.crawlId || 'data') + '.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8')
  })

  /* ---------------- 历史 ---------------- */
  function refreshHistory() {
    fetch('/api/crawls').then(function (r) { return r.json() }).then(function (payload) {
      if (!payload.ok) throw new Error('history')
      renderHistory(payload.crawls || [])
    }).catch(function () { /* 历史加载失败不打扰主流程 */ })
  }

  function renderHistory(crawls) {
    var list = $('history-list')
    list.textContent = ''
    if (!crawls.length) {
      var p = document.createElement('p')
      p.className = 'history-empty'
      p.textContent = '还没有爬取记录。'
      list.appendChild(p)
      return
    }
    crawls.slice(0, 12).forEach(function (item) {
      var btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'history-item'

      var status = document.createElement('span')
      status.className = 'status-badge ' + statusClass(item.status)
      status.textContent = item.ok ? item.status : (item.status || '✖')

      var middle = document.createElement('span')
      var url = document.createElement('div')
      url.className = 'history-url'
      url.textContent = item.url
      var meta = document.createElement('div')
      meta.className = 'history-meta'
      meta.textContent = (item.title ? '「' + item.title.slice(0, 24) + '」 · ' : '') + fmtBytes(item.bytes) + ' · ' + (item.totalMs / 1000).toFixed(1) + 's · ' + (item.itemCount || 0) + ' 条数据'
      middle.append(url, meta)

      var id = document.createElement('span')
      id.className = 'history-time'
      id.textContent = item.id

      var time = document.createElement('span')
      time.className = 'history-time'
      time.textContent = fmtTime(item.ts)

      btn.append(status, middle, id, time)
      btn.addEventListener('click', function () { loadHistoryItem(item.id) })
      list.appendChild(btn)
    })
  }

  function loadHistoryItem(id) {
    fetch('/api/crawls/' + encodeURIComponent(id)).then(function (r) { return r.json() }).then(function (payload) {
      if (!payload.ok) throw apiError(payload, '读取记录失败')
      var crawl = payload.crawl
      state.crawl = crawl
      state.crawlId = crawl.id
      state.extracts = crawl.extracts
      showCard('card-pipeline')
      showCard('card-extract')
      resetExtractBox()
      /* 恢复当时的选择器 */
      if (crawl.extracts) {
        setSelectorRows(Object.keys(crawl.extracts).map(function (k) {
          return { key: k, selector: crawl.extracts[k].selector }
        }))
      }
      replaySteps(crawl.steps, function () {
        if (crawl.error) showErrorBanner(crawl.error)
        else hideErrorBanner()
        renderSummary(crawl)
        renderRawHtml(crawl.htmlPreview || '')
        if (state.extracts) renderExtracts(state.extracts, crawl.id)
      })
      $('card-pipeline').scrollIntoView({ behavior: 'smooth', block: 'start' })
    }).catch(function (error) {
      alert('读取历史失败：' + error.message + (error.hint ? '\n\n下一步：' + error.hint : ''))
    })
  }

  /* ---------------- 初始化 ---------------- */
  $('footer-origin').textContent = location.origin
  setSelectorRows([])
  refreshHealth()
  setInterval(refreshHealth, 15000)
})()
