/**
 * 文档审计：交付前的只读检查（不改稿）。
 * 全部基于镜像 doc 的纯函数。
 */
import { textOf, wordCountOf, outlineOf, elementStats, walkElements } from './doc.js'

const zoneOf = (zone) => Array.isArray(zone) ? zone : (zone && zone.elementList) || []

/** 单条发现。level: blocking（必须处理）/ warn（提示）。 */
function finding(level, rule, message, hint) {
  return { level, rule, message, hint: hint || '' }
}

export function auditDoc(doc) {
  const findings = []
  if (!doc || typeof doc !== 'object') {
    return { ok: false, findings: [finding('blocking', 'no-doc', '桥上没有文档镜像', '先 canvas_write_document 生成内容')] }
  }
  const text = textOf(doc)
  const words = wordCountOf(doc)
  const stats = elementStats(doc)
  const outline = outlineOf(doc)

  if (words === 0) findings.push(finding('blocking', 'empty', '文档为空'))
  if (!outline.length && words > 0) {
    findings.push(finding('warn', 'no-heading', '全文没有可识别的标题（加粗或 ≥18 号）',
      '用 heading 块或 insertTitle 命令补充结构'))
  }
  if (outline.length === 1 && words > 800) {
    findings.push(finding('warn', 'single-heading', '长文只有一级结构', '拆分章节'))
  }
  for (const el of walkElements(zoneOf(doc.main))) {
    if (typeof el.value === 'string' && el.value.length > 1200) {
      findings.push(finding('warn', 'long-paragraph', `存在 ${el.value.length} 字的超长段落`, '拆段，避免整块渲染异常'))
      break
    }
  }
  if (stats.table) {
    for (const el of walkElements(zoneOf(doc.main))) {
      if (el.type !== 'table' || !Array.isArray(el.trList)) continue
      const cols = new Set(el.trList.map((tr) => (tr.tdList || []).reduce((n, td) => n + (td.colspan || 1), 0)))
      if (cols.size > 1) {
        findings.push(finding('warn', 'ragged-table', '表格各行列数不一致', '检查合并单元格是否越界'))
      }
      if (!el.colgroup || !el.colgroup.length) {
        findings.push(finding('warn', 'no-colgroup', '表格缺少列宽定义', '用 canvas_insert_table 重建'))
      }
      break
    }
  }
  if (stats.image) {
    for (const el of walkElements(zoneOf(doc.main))) {
      if (el.type !== 'image') continue
      if (typeof el.value === 'string' && !el.value.startsWith('data:image') && !el.value.startsWith('/assets/') && !/^https?:/.test(el.value)) {
        findings.push(finding('warn', 'bad-image-src', '图片 src 不是 dataURL/assets 引用/URL'))
      }
      break
    }
  }
  const blocking = findings.filter((f) => f.level === 'blocking')
  return {
    ok: blocking.length === 0,
    words,
    counts: { heading: outline.length, ...stats },
    findings,
  }
}
