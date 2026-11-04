/** 编辑器轻量 UI：状态点与临时提示，不暴露内部连接状态。 */
export function createUi({ root = document } = {}) {
  let timer = null
  const find = (selector) => root.querySelector(selector)
  return {
    note(message) {
      const element = find('[data-note]')
      if (!element) return
      element.textContent = message || ''
      clearTimeout(timer)
      if (message && !/失败|错误|未连接|未就绪|不能/.test(message)) {
        timer = setTimeout(() => {
          if (element.textContent === message) element.textContent = ''
        }, 4000)
      }
    },
    badge(text, kind) {
      const element = find('[data-badge]')
      if (!element) return
      element.textContent = text || ''
      element.dataset.kind = kind || ''
    },
  }
}
