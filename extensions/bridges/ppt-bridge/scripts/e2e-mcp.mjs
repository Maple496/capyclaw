#!/usr/bin/env node
/**
 * 真实 MCP E2E：对一个正在运行的 workbench 执行工具链，并在结束时恢复原 deck。
 *
 * 用法：
 *   node scripts/e2e-mcp.mjs --mcp http://127.0.0.1:39311/mcp --editor http://127.0.0.1:39311/
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const MCP = arg('--mcp', 'http://127.0.0.1:39311/mcp')
const EDITOR = arg('--editor', 'http://127.0.0.1:39311/').replace(/\/+$/, '')
const BASE = EDITOR + '/api/desktop/works/ppt-bridge'
const CONTRACT = JSON.parse(fs.readFileSync(path.join(ROOT, 'contract', 'ppt-contract.json'), 'utf8'))
const results = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

async function callTool(name, arguments_ = {}) {
  const response = await fetch(MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } }),
  })
  return response.json()
}

const textOf = (doc) => doc?.result?.content?.[0]?.text || ''
const isError = (doc) => doc?.result?.isError === true

async function getJson(pathname) {
  return fetch(BASE + pathname).then((r) => r.json())
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

let backup = null
try {
  backup = await getJson('/deck')
  if (!backup?.deck) throw new Error('无法读取当前 deck，E2E 中止')
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true })
  const backupFile = path.join(ROOT, 'dist', `e2e-deck-backup-${Date.now()}.json`)
  fs.writeFileSync(backupFile, JSON.stringify(backup.deck, null, 2))
  console.log(`· 已备份当前 deck → ${backupFile}`)

  const cap = await callTool('ppt_capabilities')
  const caps = JSON.parse(textOf(cap))
  record('ppt_capabilities',
    !isError(cap) && caps.contractVersion === CONTRACT.contractVersion
      && caps.toolCount === CONTRACT.toolCount && caps.editorConnected === true,
    `contract=${caps.contractVersion} tools=${caps.toolCount} editor=${caps.editorConnected}`)

  const made = await callTool('ppt_deck', {
    title: 'E2E 测试',
    preset: 'clean',
    slides: [
      { layout: 'cover', title: 'E2E 测试', subtitle: '自动测试' },
      { layout: 'bullets', title: '第一节', bullets: ['要点 A', '要点 B'] },
      { layout: 'end', title: '谢谢' },
    ],
  })
  record('ppt_deck', !isError(made), textOf(made).slice(0, 80))

  const deck1 = await getJson('/deck')
  record('deck 镜像', deck1?.deck?.title === 'E2E 测试' && deck1.deck.slides.length >= 3,
    `title=${deck1?.deck?.title} slides=${deck1?.deck?.slides?.length}`)

  const audit = await callTool('ppt_audit')
  const auditData = JSON.parse(textOf(audit))
  record('ppt_audit', !isError(audit) && typeof auditData.score === 'number' && Array.isArray(auditData.issues),
    `score=${auditData.score} issues=${auditData.issues?.length}`)

  const checkpoint = await callTool('ppt_task', { action: 'checkpoint', name: 'e2e-cp', meta: { goal: 'e2e', next: 'fill' } })
  record('ppt_task checkpoint', !isError(checkpoint), textOf(checkpoint).slice(0, 60))
  const taskStatus = await callTool('ppt_task', { action: 'status' })
  const taskStatusData = JSON.parse(textOf(taskStatus))
  record('ppt_task status', !isError(taskStatus) && taskStatusData.pending === false && taskStatusData.lastCheckpoint?.name === 'e2e-cp',
    `seq=${taskStatusData.seq} slides=${taskStatusData.slides}`)
  const taskList = await callTool('ppt_task', { action: 'list' })
  record('ppt_task list', !isError(taskList) && textOf(taskList).includes('e2e-cp'))

  const text = await callTool('ppt_text', { text: 'E2E 测试标题', slide: 0 })
  record('ppt_text', !isError(text), textOf(text).slice(0, 60))

  const recolor = await callTool('ppt_recolor', { background: '天蓝色', text: '#1f2d3d' })
  record('ppt_recolor', !isError(recolor), textOf(recolor).slice(0, 60))

  const style = await callTool('ppt_style', { background: '#ffffff', text_color: '#333333' })
  record('ppt_style', !isError(style), textOf(style).slice(0, 60))

  const beforeElement = (await getJson('/deck')).deck.slides[1].elements.length
  const added = await callTool('ppt_element', {
    action: 'add', slide: 1,
    element: { type: 'text', text: '元素测试', left: 10, top: 10, width: 200, height: 40 },
  })
  const afterAddElement = (await getJson('/deck')).deck.slides[1].elements
  const addedElement = afterAddElement.find((el) => String(el.content || '').includes('元素测试'))
  record('ppt_element add', !isError(added) && !!addedElement, `${beforeElement} → ${afterAddElement.length}`)

  if (addedElement) {
    const updated = await callTool('ppt_element', {
      action: 'update', slide: 1, element_id: addedElement.id,
      props: { left: 20, top: 20, width: 240, height: 44 },
    })
    record('ppt_element update', !isError(updated), textOf(updated).slice(0, 60))
    const removed = await callTool('ppt_element', { action: 'remove', slide: 1, element_id: addedElement.id })
    record('ppt_element remove', !isError(removed), textOf(removed).slice(0, 60))
  }

  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl7ZQAAAABJRU5ErkJggg=='
  const image = await callTool('ppt_image', { slide: 1, src: tinyPng, width: 80, height: 80 })
  const images = (await getJson('/deck')).deck.slides[1].elements.filter((el) => el.type === 'image')
  record('ppt_image', !isError(image) && images.length === 1, textOf(image).slice(0, 60))

  const fill = await callTool('ppt_fill', { slide: 0, slot: 0, text: '槽位测试' })
  record('ppt_fill', !isError(fill), textOf(fill).slice(0, 60))

  const beforeAdd = (await getJson('/deck')).deck.slides.length
  const add = await callTool('ppt_slide', { action: 'add', title: '新增页', bullets: ['a', 'b'] })
  const afterAdd = (await getJson('/deck')).deck.slides.length
  record('ppt_slide add', !isError(add) && afterAdd === beforeAdd + 1, `${beforeAdd} → ${afterAdd}`)

  const undo = await callTool('ppt_history', { action: 'undo' })
  const afterUndo = (await getJson('/deck')).deck.slides.length
  record('ppt_history undo', !isError(undo) && afterUndo === beforeAdd, `${afterAdd} → ${afterUndo}`)

  const select = await callTool('ppt_slide', { action: 'select', index: 1 })
  const present = await callTool('ppt_present', { action: 'start', slide: 1 })
  const ui = await getJson('/ui')
  record('present/select UI 队列', !isError(select) && !isError(present) && ui.ui_seq > 0,
    `ui_seq=${ui.ui_seq} ops=${ui.ui.map((c) => c.op).join(',')}`)

  const shot = await callTool('ppt_screenshot')
  const shotContent = shot?.result?.content || []
  record('ppt_screenshot', !isError(shot) && shotContent.some((c) => c.type === 'image'),
    shotContent.find((c) => c.type === 'image')?.mimeType || 'no image')

  const bad = await callTool('ppt_text', {})
  record('非法参数拦截', isError(bad) && textOf(bad).includes('text 必填'))

  const unknown = await callTool('nope_tool', {})
  record('未知工具拦截', isError(unknown) && /未知工具/.test(textOf(unknown)))

  const restored = await callTool('ppt_task', { action: 'restore', name: 'e2e-cp' })
  record('ppt_task restore', !isError(restored), textOf(restored).slice(0, 60))

  const health = await fetch(EDITOR + '/healthz').then((r) => r.json())
  record('healthz',
    health.ok === true && health.version === CONTRACT.packageVersion
      && health.contractVersion === CONTRACT.contractVersion,
    `version=${health.version} editorConnected=${health.editorConnected}`)
} catch (error) {
  record('E2E 异常', false, String(error.message || error))
} finally {
  if (backup?.deck) {
    const restore = await callTool('ppt_apply', { ops: [{ op: 'load', deck: backup.deck }] }).catch((e) => ({ error: e }))
    record('恢复原 deck', !isError(restore), restore?.error ? String(restore.error) : 'ok')
  }
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} 通过`)
  process.exit(results.every((r) => r.ok) ? 0 : 1)
}
