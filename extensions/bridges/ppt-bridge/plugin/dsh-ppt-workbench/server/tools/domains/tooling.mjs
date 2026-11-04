/** 工具层通用小函数：参数钳制、等待、回执文案。 */

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const okText = (r, msg) => ({
  text: r.ok ? `${msg}（seq ${r.seq}，${r.applied} 条）` : `应用失败：${r.error}`,
})

export const normalizeSlides = (slides) => (Array.isArray(slides) && slides.length
  ? slides.map((n) => clamp(Number(n) | 0, 0, 999))
  : null)
