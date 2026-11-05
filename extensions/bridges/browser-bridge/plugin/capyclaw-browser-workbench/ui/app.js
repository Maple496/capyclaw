/**
 * 浏览器操控工作台前端（无框架无构建）。
 *
 * 数据面全部来自本服务的 /api/*：状态轮询 2s；浏览器运行时实时画面轮询
 * 1.2s（未运行不请求）。所有按钮只是便捷入口，与 AI 的 browser_* 工具
 * 共用同一引擎实例与动作互斥队列。
 */
(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }
  var els = {
    engine: $('badge-engine'), mode: $('badge-mode'), tabs: $('tabs'),
    view: $('view'), log: $('log'), snapshot: $('snapshot'), counters: $('counters'),
    urlInput: $('url-input'),
    btnOpen: $('btn-open'), btnDemo: $('btn-demo'), btnSnapshot: $('btn-snapshot'), btnClose: $('btn-close'),
  }
  var running = false
  var shotBusy = false
  var statusBusy = false

  function fmtUrl(url) {
    if (!url || url === 'about:blank') return '(空白页)'
    return url.replace(/^https?:\/\//, '').slice(0, 40)
  }

  function renderStatus(data) {
    var st = data.status || {}
    running = !!st.running
    els.engine.textContent = running
      ? (st.launching ? '浏览器启动中…' : '浏览器运行中 · ' + (st.channel || 'chromium'))
      : '浏览器未启动'
    els.engine.className = 'badge ' + (running ? 'on' : 'off')
    els.mode.hidden = !running
    els.mode.textContent = st.headless ? '无头' : '有头'
    els.counters.textContent = st.counters
      ? '动作 ' + st.counters.actions + ' · 失败 ' + st.counters.errors + ' · 快照 ' + st.counters.snapshots
      : ''
    /* 标签页 */
    els.tabs.innerHTML = ''
    var tabs = st.tabs || []
    if (tabs.length > 1 || (tabs.length && !running)) {
      tabs.forEach(function (tab) {
        var el = document.createElement('span')
        el.className = 'tab' + (tab.active ? ' active' : '')
        el.textContent = (tab.id || '?') + ' ' + fmtUrl(tab.url)
        el.title = tab.url
        el.onclick = function () { post('/api/tabs', { action: 'select', tab: tab.id }) }
        els.tabs.appendChild(el)
      })
    }
    /* 动作日志 */
    var actions = data.actions || []
    if (actions.length) {
      els.log.innerHTML = ''
      actions.forEach(function (a) {
        var li = document.createElement('li')
        var t = document.createElement('span')
        t.className = 't'
        t.textContent = (a.at || '').slice(11, 19)
        var name = document.createElement('span')
        name.className = a.ok ? 'ok' : 'fail'
        name.textContent = (a.ok ? '✓ ' : '✗ ') + a.tool + (a.detail ? ' · ' + a.detail : '')
        if (!a.ok && a.error) name.title = a.error
        var ms = document.createElement('span')
        ms.className = 'ms'
        ms.textContent = a.ms + 'ms'
        li.appendChild(t); li.appendChild(name); li.appendChild(ms)
        els.log.appendChild(li)
      })
    }
  }

  function pollStatus() {
    if (statusBusy) return
    statusBusy = true
    fetch('/api/status').then(function (r) { return r.json() }).then(function (data) {
      renderStatus(data)
    }).catch(function () { /* 服务重启间隙 */ }).finally(function () { statusBusy = false })
  }

  function pollScreenshot() {
    if (!running || shotBusy) return
    shotBusy = true
    fetch('/api/screenshot').then(function (r) {
      if (!r.ok) throw new Error('shot ' + r.status)
      return r.blob()
    }).then(function (blob) {
      var img = els.view.querySelector('img')
      if (!img) {
        els.view.innerHTML = ''
        img = document.createElement('img')
        img.alt = '当前页面实时画面'
        els.view.appendChild(img)
      }
      var url = URL.createObjectURL(blob)
      var prev = img.src
      img.src = url
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev)
    }).catch(function () { /* 引擎未运行/页面关闭 */ }).finally(function () { shotBusy = false })
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json() }).then(function (data) {
      pollStatus()
      if (data && data.ok === false && data.error) {
        alert('[' + (data.error.code || 'ERROR') + '] ' + data.error.message +
          (data.error.hint ? '\n' + data.error.hint : ''))
      }
      return data
    }).catch(function (e) { alert('请求失败: ' + e.message) })
  }

  function openUrl(url) {
    els.btnOpen.disabled = true
    post('/api/navigate', { url: url }).finally(function () {
      els.btnOpen.disabled = false
      pollScreenshot()
    })
  }

  els.btnOpen.onclick = function () {
    var url = els.urlInput.value.trim()
    if (!url) return
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url
    openUrl(url)
  }
  els.urlInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') els.btnOpen.click()
  })
  els.btnDemo.onclick = function () { openUrl(location.origin + '/demo/form.html') }
  els.btnSnapshot.onclick = function () {
    fetch('/api/snapshot').then(function (r) { return r.json() }).then(function (data) {
      if (data.ok === false) {
        els.snapshot.textContent = (data.error ? data.error.message : '快照失败')
        return
      }
      els.snapshot.textContent =
        '# ' + (data.title || '(无标题)') + '\n' + data.url + '（' + data.elements + ' 个元素' +
        (data.truncated ? '，已截断' : '') + '）\n\n' + data.text
    }).catch(function (e) { els.snapshot.textContent = '快照失败: ' + e.message })
  }
  els.btnClose.onclick = function () {
    if (!confirm('关闭浏览器？登录态会持久化，下次打开网址自动重启。')) return
    post('/api/control', { action: 'close' }).then(function () {
      els.view.innerHTML = '<div class="placeholder"><p>浏览器已关闭。</p><p>登录态已持久化；下次打开网址时自动重启。</p></div>'
    })
  }

  pollStatus()
  setInterval(pollStatus, 2000)
  setInterval(pollScreenshot, 1200)
})()
