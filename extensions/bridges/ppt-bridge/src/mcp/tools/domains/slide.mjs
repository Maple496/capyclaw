/** 幻灯片工厂：加页工具用的最小页面。 */
import { escapeHtml } from '../../../core/text.js'

export function simpleSlide(title, bullets, background) {
  const W = 1000, pad = 60, ts = Date.now()
  const els = [{
    type: 'text', id: `mcp_t_${ts}`,
    left: pad, top: 50, width: W - pad * 2, height: 70,
    content: `<p style="font-size: 34px;"><strong>${escapeHtml(title)}</strong></p>`,
    defaultColor: '#333333', defaultFontName: '', fixedRatio: false, rotate: 0,
  }]
  ;(bullets || []).slice(0, 8).forEach((b, i) => {
    els.push({
      type: 'text', id: `mcp_b_${ts}_${i}`,
      left: pad, top: 150 + i * 46, width: W - pad * 2, height: 42,
      content: `<p style="font-size: 20px; color: #555555;">• ${escapeHtml(String(b))}</p>`,
      defaultColor: '#333333', defaultFontName: '', fixedRatio: false, rotate: 0,
    })
  })
  return { id: `mcp_slide_${ts}`, background: { type: 'solid', color: background || '#ffffff' }, elements: els }
}
