/* Keynote 导演台（兼容入口）：能力已并入 Keynote 一体工作台。 */
APPS.pptbridge = {
    mount() {
        window.WM.open('keystudio')
        return `<div style="flex:1;display:grid;place-items:center;color:var(--txt-2);font-size:13px">
          <div style="text-align:center">
            <div style="font-size:34px;margin-bottom:8px">🎬</div>
            <b style="color:var(--txt)">已并入「Keynote 一体工作台」</b>
            <div style="margin-top:6px">正在打开…</div>
          </div>
        </div>`
    },
    ready(w) {
        setTimeout(() => { if (!w.dead) window.WM.close(w.id) }, 400)
    },
}
