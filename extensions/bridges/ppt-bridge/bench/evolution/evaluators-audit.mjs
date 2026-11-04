/**
 * 审计质量评估器：生成器↔审计器一致性 + 损坏注入必检 + 对抗鲁棒性。
 *
 * 真相来源（非循环）：
 *   1. buildDeck 生成的合规稿是系统自己承诺的“好版式” → 审计必须 0 error（误报=系统自相矛盾）；
 *   2. 在合规稿上注入已知几何损坏（缩框溢出/文本重叠/重复文案/低对比） → 必须检出（漏检=失效）；
 *   3. 严重度校准：轻度损坏允许 warning，重度损坏必须 error；
 *   4. 对抗稿（零高度框/超长单行/60 元素页）不得崩溃或产生非有限分数。
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..', '..', 'plugin', 'dsh-ppt-workbench')
const { auditDeck } = await import(pathToFileURL(path.join(PKG, 'core', 'audit.js')).href)
const { buildDeck } = await import(pathToFileURL(path.join(PKG, 'core', 'deck-layout.js')).href)

const { baseDeck } = await import('./evaluators-editing.mjs')

const round2 = (v) => Math.round(Number(v) * 100) / 100

const stripText = (el) => String(el?.content || '').replace(/<[^>]+>/g, '').trim()

/** 找一个有真实文字的文本元素（返回 {slide, el}；找不到返回 null）。 */
function pickText(deck, filter = () => true) {
  for (const slide of deck.slides) {
    const el = (slide.elements || []).find((element) => element.type === 'text' && stripText(element).length >= 2 && filter(element))
    if (el) return { slide, el }
  }
  return null
}

/** 单行小框压到 10px（needed/H ≈ 2-3）：任何合理阈值都必须至少给 warning。 */
function injectShrinkSmall(deck) {
  const d = JSON.parse(JSON.stringify(deck))
  const hit = pickText(d, (el) => el.height <= 40 && el.height >= 24)
  if (hit) hit.el.height = 10
  return d
}

/** 重度溢出：大框砍到 35%（needed/H ≈ 2.9，任何合理阈值都必须报 error）。 */
function injectSevereOverflow(deck) {
  const d = JSON.parse(JSON.stringify(deck))
  const hit = pickText(d, (el) => el.height >= 100)
  if (hit) hit.el.height = 35
  return d
}

/** 文本重叠：克隆后仅下移 14px（字形几乎完全重合，约 79% 重叠，必须 error）。
 * 文字不同（追加后缀）→ 命中 text-overlap 而非 duplicate-text。 */
function injectOverlap(deck) {
  const d = JSON.parse(JSON.stringify(deck))
  const hit = pickText(d)
  if (!hit) return d
  const { slide, el } = hit
  const ghost = JSON.parse(JSON.stringify(el))
  ghost.id = `${el.id}_ghost`
  ghost.top = el.top + 14
  ghost.content = ghost.content.replace(/<\/p>\s*$/i, ' 变体</p>')
  slide.elements.push(ghost)
  return d
}

/** 部分重叠：下移 40px（大标题字形高 ~67.5px → 重叠率 ≈ 0.40，判别 overlapErr ∈ (0.3, 0.55]）。 */
function injectOverlapPartial(deck) {
  const d = JSON.parse(JSON.stringify(deck))
  const hit = pickText(d, (el) => el.height >= 100)
  if (!hit) return d
  const { slide, el } = hit
  const ghost = JSON.parse(JSON.stringify(el))
  ghost.id = `${el.id}_partial`
  ghost.top = el.top + 40
  ghost.content = ghost.content.replace(/<\/p>\s*$/i, ' 局部重叠</p>')
  slide.elements.push(ghost)
  return d
}

/** 重复文案：同一段文字同位重绘（必须 error）。 */
function injectDuplicate(deck) {
  const d = JSON.parse(JSON.stringify(deck))
  const hit = pickText(d)
  if (!hit) return d
  hit.slide.elements.push({ ...JSON.parse(JSON.stringify(hit.el)), id: `${hit.el.id}_dup` })
  return d
}

/** 低对比：#777777 文字放在 #999999 卡片上（≈1.57:1，任何标准都必须 error）。
 * 内联 style 的 color 优先于元素属性，必须一并替换。 */
function injectContrast(deck) {
  const d = JSON.parse(JSON.stringify(deck))
  const hit = pickText(d)
  if (!hit) return d
  hit.el.color = '#777777'
  hit.el.content = String(hit.el.content || '').replace(/color:\s*[^;"']+/i, 'color:#777777;')
  hit.slide.elements.unshift({
    id: 'bg_card', type: 'shape', left: hit.el.left - 10, top: hit.el.top - 10,
    width: hit.el.width + 20, height: hit.el.height + 20, fill: '#999999',
    path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z',
  })
  return d
}

/** 对抗稿：零高度框、超长单行、60 元素页 —— 不崩溃、分数有限。 */
function adversarialDecks() {
  const decks = []
  decks.push({ title: 'zero-height', slides: [{ id: 's1', elements: [
    { id: 'z1', type: 'text', left: 0, top: 0, width: 300, height: 0, content: '<p>零高度文本框</p>' },
    { id: 'z2', type: 'text', left: 0, top: 0, width: 0, height: 100, content: '<p>零宽度</p>' },
  ] }] })
  decks.push({ title: 'long-line', slides: [{ id: 's1', elements: [
    { id: 'l1', type: 'text', left: 0, top: 0, width: 40, height: 30, content: `<p>${'超长单行'.repeat(60)}</p>` },
  ] }] })
  const many = Array.from({ length: 60 }, (_, i) => ({
    id: `m${i}`, type: 'text', left: (i % 10) * 100, top: Math.floor(i / 10) * 56,
    width: 95, height: 50, content: `<p>元素 ${i} 的文字内容，做重叠与性能压力。</p>`,
  }))
  decks.push({ title: 'dense', slides: [{ id: 's1', elements: many }] })
  return decks
}

export async function evaluateAudit(genome, tuningPatch) {
  const previous = globalThis.PPT_AUDIT_TUNING
  globalThis.PPT_AUDIT_TUNING = tuningPatch
  try {
    const presets = ['clean', 'business', 'warm', 'tech']
    const cleanDecks = presets.map((preset) => baseDeck(preset, 12))
    /* 长标题换行变体：cover 标题 28 字（生成器上限 30）→ 2 行，needed/H ≈ 1.13。
     * 这是 warnK 的安全下界检验：warnK ≤ 1.1 会对生成器接受的输入误报。 */
    const longTitleDeck = baseDeck('clean', 3)
    longTitleDeck.slides[0].elements.forEach((el) => {
      if (el.id?.startsWith('lt_cover_title')) el.content = `<p style="font-size: 50px; color:#1f2d3d;">${'面向增长团队的季度经营复盘与下一阶段行动纲领'}</p>`
    })
    cleanDecks.push(longTitleDeck)

    /* 1) 干净语料：生成稿必须 0 error（自相矛盾 = 误报） */
    let falseBlocks = 0
    let falseWarnings = 0
    let auditMs = 0
    const warmup = auditDeck(cleanDecks[0])
    void warmup
    for (const deck of cleanDecks) {
      const started = performance.now()
      const result = auditDeck(deck)
      auditMs += performance.now() - started
      falseBlocks += result.summary.errors
      falseWarnings += result.summary.warnings
    }

    /* 2) 损坏注入：必须检出 */
    let missedDetections = 0
    let severityViolations = 0
    const injections = [
      { name: 'shrink-small', deck: injectShrinkSmall(cleanDecks[0]), minSeverity: 'warning' },
      { name: 'severe-overflow', deck: injectSevereOverflow(cleanDecks[0]), minSeverity: 'error' },
      { name: 'overlap-full', deck: injectOverlap(cleanDecks[0]), minSeverity: 'error' },
      { name: 'overlap-partial', deck: injectOverlapPartial(cleanDecks[0]), minSeverity: 'error' },
      { name: 'duplicate', deck: injectDuplicate(cleanDecks[0]), minSeverity: 'error' },
      { name: 'contrast', deck: injectContrast(cleanDecks[0]), minSeverity: 'error' },
    ]
    for (const item of injections) {
      const result = auditDeck(item.deck)
      const hit = result.issues.some((issue) => issue.severity === 'error' || issue.severity === 'warning')
      const errorHit = result.issues.some((issue) => issue.code !== 'empty-slide' && issue.severity === 'error')
      if (!hit) missedDetections++
      else if (item.minSeverity === 'error' && !errorHit) severityViolations++
    }

    /* 3) 对抗鲁棒性 */
    let robustnessViolations = 0
    for (const deck of adversarialDecks()) {
      try {
        const result = auditDeck(deck)
        if (!Number.isFinite(result.score)) robustnessViolations++
      } catch {
        robustnessViolations++
      }
    }

    const stabilityFailures = robustnessViolations + missedDetections + falseBlocks + severityViolations
    const decks = cleanDecks.length
    return {
      ok: stabilityFailures === 0,
      objectives: {
        missedDetections,
        falseBlocks,
        falseWarnings,
        auditMsPerDeck: round2(auditMs / decks),
        robustnessViolations: stabilityFailures,
      },
      meta: { falseBlocks, falseWarnings, missedDetections, severityViolations, auditMsPerDeck: round2(auditMs / decks) },
    }
  } finally {
    if (previous === undefined) delete globalThis.PPT_AUDIT_TUNING
    else globalThis.PPT_AUDIT_TUNING = previous
  }
}
