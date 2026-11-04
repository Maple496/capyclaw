/**
 * ppt-shim.mjs — 服务端 PptApp 数据执行器（纯 JSON，无 DOM）。
 *
 * 架构定位（2026-10-30 解耦批）：
 *   deck 数据的权威保存在 relay 进程（store.doc.deck）。
 *   MCP 工具的 ops 在服务端由本 shim 直接执行——**不依赖任何编辑器页面在线**。
 *   编辑器页面（无论侧边栏还是独立标签）只是视图：watch 到指令版本变化后
 *   镜像 load 最新 deck；用户手动编辑通过 pushState 镜像回服务端。
 *
 * 实现 core/ops.js 定义的 P 接口子集（数据类）：
 *   isMounted / getSlides / updateSlide / load / setTitle / setTheme / getTheme
 *   addSlide / removeSlide / moveSlide / duplicateSlide / selectSlide
 *   snapshot / undo / redo / present / exitPresent
 * undo/redo 在服务端维护 50 步 deck 历史；present/select 仍是页面概念。
 */

const emptyDeck = () => ({
  title: '未命名演示文稿',
  slides: [],
  theme: {
    themeColors: ['#2f6feb', '#f0a030', '#1f2d3d'],
    fontColor: '#1f2d3d',
    fontName: '',
    backgroundColor: '#ffffff',
  },
  viewportSize: 1000,
  viewportRatio: 0.5625,
})

/**
 * 递归纯 JSON 深拷贝（HOTPATH A1）。deck 全部是 JSON 安全数据，
 * 相比 JSON.parse(JSON.stringify()) 实测快 3-4×（157KB deck：0.65ms → 0.19ms）。
 */
const cloneJson = (value) => {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneJson)
  const out = {}
  for (const key of Object.keys(value)) out[key] = cloneJson(value[key])
  return out
}

let dupCounter = 0

export function createJsonPptApp(store) {
  const deckOf = () => {
    if (!store.doc.deck || !Array.isArray(store.doc.deck.slides)) {
      store.doc.deck = emptyDeck()
    }
    return store.doc.deck
  }

  const past = []
  const future = []
  const cloneDeck = () => cloneJson(deckOf())
  const remember = () => {
    past.push(cloneDeck())
    if (past.length > 50) past.shift()
    future.length = 0
  }
  const restore = (deck) => {
    store.doc.deck = deck
    store.doc.updated = Date.now() / 1000
  }

  const P = {
    isMounted() { return true },

    getSlides() { return deckOf().slides },

    /** PPTist updateSlide(index, slide) → bool */
    updateSlide(i, slide) {
      const slides = deckOf().slides
      const k = Number(i) | 0
      if (k < 0 || k >= slides.length) return false
      slides[k] = slide
      return true
    },

    /** 替换 title + slides + 画布设定（checkpoint 恢复必须连 theme 一起还原）。 */
    load(deck) {
      const d = deckOf()
      if (deck && Array.isArray(deck.slides)) d.slides = cloneJson(deck.slides)
      if (deck && deck.title != null) d.title = String(deck.title)
      for (const key of ['theme', 'viewportSize', 'viewportRatio']) {
        if (deck && deck[key] != null) d[key] = cloneJson(deck[key])
      }
      return true
    },

    setTitle(t) { deckOf().title = String(t || '') },

    getTheme() { return deckOf().theme || {} },

    setTheme(t) {
      const d = deckOf()
      d.theme = { ...(d.theme || {}), ...(t || {}) }
    },

    addSlide(slide, index) {
      const d = deckOf()
      const s = (slide && (slide.elements || slide.background || slide.id))
        ? cloneJson(slide)
        : { id: 'slide_' + Date.now() + '_' + Math.floor(Math.random() * 1e3), elements: [] }
      if (!Array.isArray(s.elements)) s.elements = []
      if (index != null) {
        const k = Math.min(Math.max(Number(index) | 0, 0), d.slides.length)
        d.slides.splice(k, 0, s)
      } else {
        d.slides.push(s)
      }
      return true
    },

    removeSlide(i) {
      const slides = deckOf().slides
      const k = Number(i) | 0
      if (k < 0 || k >= slides.length) return false
      slides.splice(k, 1)
      return true
    },

    moveSlide(from, to) {
      const slides = deckOf().slides
      const a = Number(from) | 0
      const b = Number(to) | 0
      if (a < 0 || a >= slides.length || b < 0 || b > slides.length) return false
      const [m] = slides.splice(a, 1)
      slides.splice(b > a ? b - 1 : b, 0, m)
      return true
    },

    duplicateSlide(i) {
      const slides = deckOf().slides
      const k = Number(i) | 0
      if (k < 0 || k >= slides.length) return false
      dupCounter += 1
      const copy = cloneJson(slides[k])
      copy.id = (copy.id || 'slide') + '_d' + dupCounter
      ;(copy.elements || []).forEach(e => { e.id = (e.id || 'el') + '_d' + dupCounter })
      slides.splice(k + 1, 0, copy)
      return true
    },

    /** 每个会改 deck 的 op 执行前调用。 */
    snapshot: remember,

    undo() {
      if (!past.length) return false
      future.push(cloneDeck())
      restore(past.pop())
      return true
    },

    redo() {
      if (!future.length) return false
      past.push(cloneDeck())
      restore(future.pop())
      return true
    },

    /* 页面概念：服务端 no-op */
    selectSlide() { return true },
    present() { return true },
    exitPresent() { return true },
  }

  return P
}
