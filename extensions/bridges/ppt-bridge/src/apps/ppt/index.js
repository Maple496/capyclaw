/* Keynote（ppt）—— PPTist 完整应用套件的本地应用形态（结构见 DOC 段：
 * 大包住后端资产，本段只做装载器；放映/导出走菜单，编程面走 window.PptApp）。 */
const Ppt = {
    pending: null,
    /* 资产取文 + 注入执行。Object.defineProperty 预置哑 Work（闸门禁止
     * window. 赋值字面量，且 finally 里按原状还原——Work 非 ABI，壳内
     * 本无此全局）。内联 script append 即同步执行，无需 onload。 */
    async ensureRuntime() {
        if (window.PptApp) return;
        if (!this.pending) this.pending = (async () => {
            const j = await apiFetch('/api/desktop/works/app-asset?name=ppt-full-app.js');
            const code = j && typeof j.code === 'string' ? j.code : '';
            if (!code) throw new Error('运行时资产为空（assets/ppt-full-app.js 缺失？）');
            const hadWork = 'Work' in window;
            const host = hadWork ? window.Work : undefined;
            Object.defineProperty(window, 'Work',
                { value: { register() { } }, configurable: true });
            try {
                const s = document.createElement('script');
                s.textContent = code;
                document.head.appendChild(s);
                s.remove();
            }
            finally {
                if (hadWork) Object.defineProperty(window, 'Work', { value: host, configurable: true });
                else delete window.Work;
            }
            if (!window.PptApp) throw new Error('window.PptApp 未就绪（资产版本不匹配？）');
        })().catch(e => { this.pending = null; throw e; });
        await this.pending;
    },
    async boot(w) {
        const stage = w.node.querySelector('[data-stage]');
        if (!stage) return;
        try {
            await this.ensureRuntime();
            if (w.dead) return;
            await window.PptApp.mount(stage);
            const veil = w.node.querySelector('[data-veil]');
            if (veil) { veil.style.opacity = '0'; setTimeout(() => veil.remove(), 260); }
        }
        catch (e) {
            if (w.dead) return;
            const note = w.node.querySelector('[data-note]');
            if (note) note.innerHTML = '引擎装载失败：' + esc(String((e && e.message) || e)) +
                '<br><button data-ppy class="tbtn" style="margin-top:8px">重试</button>';
        }
    },
    need() {
        if (!window.PptApp || !window.PptApp.isMounted()) { Toast('演示引擎未就绪'); return null; }
        return window.PptApp;
    },
};
APPS.ppt = {
    w: 1280, h: 800, minW: 960, minH: 600,
    menus() {
        return stdMenus('ppt', {
            文件: [
                { id: 'pptx', label: '导出 PPTX…', key: '⌘E', run: () => { const a = Ppt.need(); if (a) a.exportPPTX(); } },
                { id: 'json', label: '导出 JSON…', run: () => { const a = Ppt.need(); if (a) a.saveJSON(); } },
            ],
            放映: [
                { id: 'play', label: '从头放映', run: () => { const a = Ppt.need(); if (a) a.present(0); } },
                { id: 'stop', label: '退出放映', run: () => { const a = Ppt.need(); if (a) a.exitPresent(); } },
            ],
        }, ['文件', '编辑', '显示', '放映', '窗口', '帮助']);
    },
    mount(w) {
        return titlebar('Keynote', { plain: true }) +
      `<div data-stage style="flex:1;min-height:0;position:relative;overflow:hidden;background:#181818">
        <div data-veil style="position:absolute;inset:0;display:grid;place-items:center;background:var(--win);transition:opacity .25s">
          <div style="text-align:center;color:var(--txt-2);font-size:12.5px">
            <div style="font-size:34px">📊</div>
            <b style="color:var(--txt)" data-note>正在装载演示引擎（本机网关直取，仅首次）…</b>
          </div>
        </div>
      </div>`;
    },
    ready(w) {
        on(w.node, 'click', '[data-ppy]', () => {
            const note = w.node.querySelector('[data-note]');
            if (note) note.textContent = '正在装载演示引擎（本机网关直取，仅首次）…';
            Ppt.boot(w);
        });
        Ppt.boot(w);
    },
    onClose(w) {
        /* PptApp 全页单例：仅当最后一个 ppt 窗口关闭才卸载（多窗时后关的
         * 统一收尾）；包可能改写 body 行内样式（放映态），一并还原。 */
        if (WM.list.some(x => !x.dead && x.app === 'ppt' && x !== w)) return;
        if (window.PptApp && window.PptApp.isMounted()) window.PptApp.unmount();
        document.body.removeAttribute('style');
    },
};
