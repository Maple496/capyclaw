/**
 * Keynote 一体工作台（keystudio）—— 应用壳。
 * 业务逻辑在 core/（ops/layout/quick/text），本文件只做 UI / 生命周期 /
 * 桥长轮询 / 截图回传 / dsh 内嵌。构建后写入 .works CODE 段。
 */
import { applyOp } from '../../core/ops.js'
import { shrinkImage } from '../../core/ops/browser.js'
import { parseQuick, simpleSlide } from '../../core/quick.js'

const OPS_CTX = {
    apiBase: '/api/desktop/works/ppt-bridge',
    media: { prepareImage: shrinkImage },
}

const Studio = {
    /* ---- 运行时装载（4.4MB PPTist bundle，单例复用） ---- */
    async ensureRuntime() {
        if (window.PptApp) return
        if (window.Ppt && window.Ppt.pending) { await window.Ppt.pending; return }
        const j = await apiFetch('/api/desktop/works/app-asset?name=ppt-full-app.js')
        const code = j && typeof j.code === 'string' ? j.code : ''
        if (!code) throw new Error('运行时资产为空')
        const hadWork = 'Work' in window
        const host = hadWork ? window.Work : undefined
        Object.defineProperty(window, 'Work', { value: { register() { } }, configurable: true })
        try {
            const s = document.createElement('script')
            s.textContent = code
            document.head.appendChild(s)
            s.remove()
        }
        finally {
            if (hadWork) Object.defineProperty(window, 'Work', { value: host, configurable: true })
            else delete window.Work
        }
        if (!window.PptApp) throw new Error('window.PptApp 未就绪')
    },
    async bootEditor(w) {
        const box = w.node.querySelector('[data-editor]')
        if (!box) return
        try {
            await Studio.ensureRuntime()
            if (w.dead) return
            await window.PptApp.mount(box)
            /* 重开窗口：从桥的 deck 镜像恢复（不重放历史指令队列）。
             * 之前重放旧 cmds 会把已经改好的内容按旧 id 再执行一遍。 */
            await Studio.restore(w)
            const veil = w.node.querySelector('[data-veil]')
            if (veil) { veil.style.opacity = '0'; setTimeout(() => veil.remove(), 260) }
            setTimeout(() => {
                const v = w.node.querySelector('[data-veil]')
                if (v) v.remove()
            }, 3000)
            /* 单窗口所有权：只有 owner 应用指令/回执/写镜像 */
            Studio.claimLoop(w)
        }
        catch (e) {
            if (w.dead) return
            const note = w.node.querySelector('[data-editor-note]')
            if (note) note.innerHTML = '编辑器装载失败：' + esc(String((e && e.message) || e)) +
                '<br><button data-kse class="tbtn" style="margin-top:8px">重试</button>'
        }
    },
    async restore(w) {
        try {
            const doc = await apiFetch('/api/desktop/works/ppt-bridge')
            if (doc && doc.deck && Array.isArray(doc.deck.slides) && doc.deck.slides.length) {
                await window.PptApp.load(doc.deck)
            }
            w.st.lastSeq = Number(doc && doc.seq) || 0
        } catch (e) { /* 镜像不可用 = 保留默认 deck */ }
    },
    async claim(w) {
        try {
            const r = await apiFetch('/api/desktop/works/ppt-bridge/claim', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: w.st.clientId }),
            })
            return !!(r && r.ok)
        } catch (e) { return false }
    },
    async claimLoop(w) {
        while (!w.dead) {
            if (await Studio.claim(w)) {
                w.st.active = true
                Studio.note(w, '')
                Studio.watch(w)
                Studio.pushState()
                Studio.pump(w)
                w.st.heartbeat = setInterval(async () => {
                    if (w.dead || !w.st.active) return
                    const ok = await Studio.claim(w)
                    if (!ok) {
                        w.st.active = false
                        Studio.note(w, '另一个工作台窗口接管了这份 deck，本窗口已暂停同步')
                    }
                }, 3000)
                return
            }
            Studio.note(w, '另一个工作台窗口正在操作这份 deck，本窗口待命…')
            await new Promise(r => setTimeout(r, 1000))
        }
    },
    /* ---- 指令应用：core/ops（唯一分发实现） ---- */
    async apply(w, doc) {
        w.st.busy = true
        let applied = 0, error = ''
        try {
            for (const c of doc.cmds) {
                await applyOp(window.PptApp, c, OPS_CTX)
                applied++
            }
        }
        catch (e) {
            error = String((e && e.message) || e)
            /* 编辑器未挂载 = 瞬态：回退游标，挂载后重试 */
            if (!window.PptApp || !window.PptApp.isMounted()) w.st.lastSeq = 0
        }
        /* 2026-10-22 结构优化：先回执、后镜像。
         * 旧实现等 400KB 的 P.dump() + /state 写完才 /ack，实测让每次工具
         * 调用多背 2.4s（协议本身仅 140ms）。现在 ack 立即返回，镜像在
         * 后台写；get_deck 依 state_seq 等待，保证读到的仍是新 deck。 */
        try {
            await apiFetch('/api/desktop/works/ppt-bridge/ack', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ seq: doc.seq, applied, error }),
            })
        } catch (e) { /* 回执失败由下一轮轮询补 */ }
        w.st.busy = false
        if (!w.dead) Studio.note(w, error
            ? ('第 ' + doc.seq + ' 队应用失败：' + error)
            : ('第 ' + doc.seq + ' 队已应用（' + applied + ' 条）'))
        /* 镜像不阻塞回执；仍带本次 seq，供 get_deck 等待 */
        Promise.resolve().then(() => Studio.pushState(doc.seq)).catch(() => { })
    },
    async quick(w, text) {
        const cmds = parseQuick(text)
        if (!cmds) { Studio.note(w, '快捷栏只认：背景<颜色> / 第N页标题改成X / 加一页 X —— 其它请用左侧 AI'); return }
        try {
            for (const c of cmds) await applyOp(window.PptApp, c, OPS_CTX)
            Studio.pushState()
            Studio.note(w, '已执行（本地直改）')
        } catch (e) {
            Studio.note(w, '快捷执行失败：' + String((e && e.message) || e))
        }
    },
    /* ---- 长轮询泵：seq/shot 任一变化即返；空闲 20s 一次 ---- */
    async pump(w) {
        if (w.st.pumping) return
        w.st.pumping = true
        try {
            while (!w.dead) {
                if (!w.st.active) { await new Promise(r => setTimeout(r, 1500)); continue }
                try {
                    let doc
                    try {
                        doc = await apiFetch('/api/desktop/works/ppt-bridge/watch?seq=' +
                            w.st.lastSeq + '&shot=' + w.st.lastShotReq)
                    } catch (e) {
                        await new Promise(r => setTimeout(r, 800))
                        continue
                    }
                    if (w.dead) return
                    if (doc.shot_req && doc.shot_req > w.st.lastShotReq) {
                        w.st.lastShotReq = doc.shot_req
                        Studio.shoot(w, doc.shot_req)
                    }
                    if (doc.seq !== w.st.lastSeq) {
                        if (!window.PptApp || !window.PptApp.isMounted()) {
                            await new Promise(r => setTimeout(r, 500))
                            continue
                        }
                        w.st.lastSeq = doc.seq
                        if (doc.seq > 0) await Studio.apply(w, doc)
                    }
                } catch (e) {
                    w.st.busy = false
                    await new Promise(r => setTimeout(r, 500))
                }
            }
        } finally {
            w.st.pumping = false
        }
    },
    /* ---- 截图：全部页拼 2 列 contact sheet → 桥 shot-result ---- */
    async shoot(w, req) {
        if (w.st.shooting) return
        w.st.shooting = true
        try {
            let data = ''
            for (let attempt = 0; attempt < 2 && !data; attempt++) {
                try { data = await Studio.sheet() }
                catch (e) { await new Promise(r => setTimeout(r, 500)) }
            }
            if (!data) throw new Error('画面渲染为空')
            await apiFetch('/api/desktop/works/ppt-bridge/shot-result', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ req, data }),
            })
        } catch (e) {
            Studio.note(w, '截图失败：' + String((e && e.message) || e))
        } finally {
            w.st.shooting = false
        }
    },
    async sheet() {
        const P = window.PptApp
        const urls = await P.renderSlides({ width: 480, format: 'jpeg', quality: 0.6 })
        const imgs = await Promise.all(urls.map(u => new Promise(res => {
            if (!u) return res(null)
            const im = new Image()
            im.onload = () => res(im)
            im.onerror = () => res(null)
            im.src = u
        })))
        const live = imgs.filter(Boolean)
        const cols = Math.min(2, Math.max(1, live.length))
        const rows = Math.max(1, Math.ceil(live.length / cols))
        const cw = 480, ch = 270, gap = 8
        const cv = document.createElement('canvas')
        cv.width = cols * cw + (cols + 1) * gap
        cv.height = rows * ch + (rows + 1) * gap
        const ctx = cv.getContext('2d')
        ctx.fillStyle = '#222'
        ctx.fillRect(0, 0, cv.width, cv.height)
        live.forEach((im, i) => {
            const x = gap + (i % cols) * (cw + gap)
            const y = gap + Math.floor(i / cols) * (ch + gap)
            ctx.drawImage(im, x, y, cw, ch)
        })
        return cv.toDataURL('image/jpeg', 0.7)
    },
    note(w, msg) {
        const n = w.node.querySelector('[data-kbnote]')
        if (n) n.textContent = msg || ''
    },
    /* 状态镜像：PptApp change → 防抖 POST /state（agent 的「看」） */
    watch(w) {
        if (w.st.watching || !window.PptApp) return
        w.st.watching = true
        w.st.onchange = () => {
            clearTimeout(w.st.stateTimer)
            w.st.stateTimer = setTimeout(() => Studio.pushState(), 800)
        }
        window.PptApp.on('change', w.st.onchange)
    },
    async pushState(seq) {
        const P = window.PptApp
        const w = Studio.window()
        if (!P || !P.isMounted()) return
        if (w && w.st && !w.st.active) return
        try {
            const body = { deck: P.dump() }
            if (seq != null) body.seq = Number(seq)
            else if (w && w.st && w.st.lastSeq) body.seq = Number(w.st.lastSeq)
            await apiFetch('/api/desktop/works/ppt-bridge/state', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            })
        } catch (e) { /* 下一轮 change 再推 */ }
    },
    window() {
        return window.WM.list.find(x => !x.dead && x.app === 'keystudio')
    },
    /* 内嵌专属编辑 agent（keynote-agent 实例） */
    async embedChat(w) {
        const box = w.node.querySelector('[data-chatbox]')
        if (!box) return
        try {
            const emb = await Handlers.worksEmbed({ service: 'keynote-agent', title: 'Keynote 编辑 agent' })
            if (w.dead) { if (emb.ok) emb.destroy(); return }
            if (!emb.ok) throw new Error(emb.error || '内嵌失败')
            w.st.embed = emb
            box.innerHTML = ''
            box.appendChild(emb.node)
        }
        catch (e) {
            box.innerHTML = '<div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;color:var(--txt-2);font-size:12.5px;padding:20px"><div>DeepSeek Harness 连接失败：' +
                esc(String((e && e.message) || e)) +
                '<br><button data-ksre class="tbtn" style="margin-top:8px">重连</button></div></div>'
        }
    },
}

APPS.keystudio = {
    w: 1600, h: 900, minW: 1280, minH: 700,
    menus() {
        const P = window.PptApp
        const need = () => { if (!P || !P.isMounted()) { Toast('编辑器未就绪'); return null } return P }
        return stdMenus('keystudio', {
            文件: [
                { id: 'pptx', label: '保存回原文件…', key: '⌘E', run: async () => {
                    if (!need()) return
                    try {
                        const res = await apiFetch('/api/desktop/works/ppt-bridge/save-pptx', { method: 'POST' })
                        if (res && res.ok) Studio.note('已保存回 ' + res.path + (res.backup ? '（备份 ' + res.backup + '）' : ''))
                        else Studio.note('保存失败：' + ((res && res.error) || '未知错误'))
                    } catch (e) {
                        Studio.note('保存失败：' + String((e && e.message) || e))
                    }
                } },
                { id: 'json', label: '导出 JSON…', run: () => { const a = need(); if (a) a.saveJSON() } },
            ],
            放映: [
                { id: 'play', label: '从头放映', run: () => { const a = need(); if (a) a.present(0) } },
                { id: 'stop', label: '退出放映', run: () => { const a = need(); if (a) a.exitPresent() } },
            ],
        }, ['文件', '编辑', '显示', '放映', '窗口', '帮助'])
    },
    mount(w) {
        w.st = { clientId: 'ks_' + Date.now() + '_' + Math.floor(Math.random() * 1e6), active: false, heartbeat: null, lastSeq: 0, lastShotReq: 0, busy: false, shooting: false, pumping: false, watching: false, onchange: null, stateTimer: null, embed: null }
        return titlebar('Keynote 一体工作台', { plain: true }) +
      `<div style="flex:1;min-height:0;display:flex">
        <div data-chat style="flex:none;width:360px;position:relative;border-right:1px solid var(--line);background:var(--win)">
          <div data-chatbox style="position:absolute;inset:0 0 46px 0">
            <div style="position:absolute;inset:0;display:grid;place-items:center;color:var(--txt-2);font-size:12.5px">正在连接 DeepSeek…</div>
          </div>
          <div style="position:absolute;left:0;right:0;bottom:0;height:46px;display:flex;gap:6px;padding:6px;border-top:1px solid var(--line);background:var(--win)">
            <input data-q title="本地直改，不走 AI：背景<颜色> / 第N页标题改成X / 加一页 X" placeholder="⚡ 快捷·0.1秒：背景改成白色 / 第2页标题改成X / 加一页 X" style="flex:1;min-width:0;border:1px solid var(--line);border-radius:6px;padding:0 8px;font-size:12px;background:var(--panel);color:var(--txt)">
            <button data-qgo class="tbtn" style="flex:none;padding:0 10px">执行</button>
          </div>
        </div>
        <div style="flex:1;min-width:0;position:relative;background:var(--panel)">
          <div data-editor style="position:absolute;inset:0"></div>
          <div data-veil style="position:absolute;inset:0;background:var(--panel);display:grid;place-items:center;transition:opacity .25s;pointer-events:none">
            <div style="color:var(--txt-2);font-size:12.5px">
              <div data-editor-note>正在装载 Keynote 编辑器…</div>
            </div>
          </div>
          <div data-kbnote style="position:absolute;left:10px;bottom:6px;font-size:11.5px;color:var(--txt-2);pointer-events:none"></div>
        </div>
      </div>`
    },
    ready(w) {
        w.title = 'Keynote 一体工作台'
        const tt = w.node.querySelector('.tb .title')
        if (tt) tt.textContent = w.title
        on(w.node, 'click', '[data-ksre]', () => Studio.embedChat(w))
        on(w.node, 'click', '[data-kse]', () => Studio.bootEditor(w))
        on(w.node, 'click', '[data-qgo]', () => {
            const q = w.node.querySelector('[data-q]')
            if (q && q.value.trim()) Studio.quick(w, q.value.trim())
        })
        on(w.node, 'keydown', '[data-q]', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault()
                const q = w.node.querySelector('[data-q]')
                if (q && q.value.trim()) Studio.quick(w, q.value.trim())
            }
        })
        Studio.embedChat(w)
        Studio.bootEditor(w)
        /* 页面刷新/关闭时立即释放所有权：否则旧 clientId 会占着租约，
           新窗口要等到租约过期才能接管（实测造成 30~40s 的工具超时）。 */
        w.st._release = () => {
            try {
                if (!w.st || !w.st.clientId) return
                const body = new Blob([JSON.stringify({ id: w.st.clientId })],
                    { type: 'application/json' })
                navigator.sendBeacon('/api/desktop/works/ppt-bridge/release', body)
            } catch (e) { }
        }
        window.addEventListener('pagehide', w.st._release)
    },
    onClose(w) {
        clearTimeout(w.st.stateTimer)
        clearInterval(w.st.heartbeat)
        if (w.st._release) window.removeEventListener('pagehide', w.st._release)
        if (w.st.active) {
            apiFetch('/api/desktop/works/ppt-bridge/release', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: w.st.clientId }),
            }).catch(() => { })
        }
        if (window.PptApp && w.st.onchange) window.PptApp.off('change', w.st.onchange)
        if (window.PptApp && window.PptApp.isMounted()) window.PptApp.unmount()
        if (w.st.embed) w.st.embed.destroy()
    },
}
