/**
 * 端到端冒烟：假编辑器（claim→watch→应用→ack→state）+ MCP 工具全量调用。
 * 不依赖浏览器，验证「工具 → 桥 → 编辑器」闭环。
 *
 *   CANVAS_BRIDGE_URL=http://127.0.0.1:8899/api/desktop/works/canvas-bridge node test/smoke.mjs
 */
process.env.CANVAS_BRIDGE_URL = process.env.CANVAS_BRIDGE_URL
  || 'http://127.0.0.1:8899/api/desktop/works/canvas-bridge'

const { get, post, sleep } = await import('../server/bridge-client.mjs')
const { TOOL_IMPL } = await import('../server/tools.mjs')

const failures = []
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!cond) failures.push(name)
}

/* ---------- 假编辑器 ---------- */
const st = {
  id: 'fake-editor-' + Date.now(),
  seq: 0, shot: 0,
  doc: { header: { height: 0, elementList: [] }, main: [], footer: { height: 0, elementList: [] } },
  applied: 0, stopped: false,
}

const normDoc = (d) => ({
  header: d.header || { height: 0, elementList: [] },
  main: d.main || [],
  footer: d.footer || { height: 0, elementList: [] },
})

function applyCmd(c) {
  const args = Array.isArray(c.args) ? c.args : []
  switch (c.cmd) {
    case 'setValue':
    case 'load':
      st.doc = normDoc(args[0] && args[0].data ? args[0].data : (args[0] || {}))
      break
    case 'appendElementList':
    case 'insertElementList':
      st.doc.main.push(...(Array.isArray(args[0]) ? args[0] : []))
      break
    case 'image':
      st.doc.main.push(args[0])
      break
    default:
      break   /* 样式/页面/历史命令：本假编辑器只记录不改变结构 */
  }
  st.applied++
}

const textOf = () => st.doc.main
  .map((el) => (el && typeof el.value === 'string' ? el.value : ''))
  .join('')

async function editorLoop() {
  for (;;) {
    if (st.stopped) return
    try {
      const c = await post('/claim', { id: st.id })
      if (c.ok) break
    } catch (e) { /* 网关未起 */ }
    await sleep(200)
  }
  for (;;) {
    if (st.stopped) return
    try {
      const d = await get(`/watch?seq=${st.seq}&shot=${st.shot}&timeout=2`)
      if (d.shot_req && d.shot_req > st.shot) {
        st.shot = d.shot_req
        await post('/shot-result', { req: st.shot, data: 'data:image/jpeg;base64,AAAA' })
      }
      if (d.seq !== st.seq) {
        st.seq = d.seq
        let applied = 0, error = ''
        try {
          for (const c of d.cmds || []) { applyCmd(c); applied++ }
        } catch (e) { error = String(e.message || e) }
        await post('/ack', { seq: d.seq, applied, error })
        await post('/state', {
          doc: st.doc,
          text: textOf(),
          word_count: textOf().replace(/\s/g, '').length,
          seq: d.seq,
        })
      }
    } catch (e) {
      await sleep(300)
    }
  }
}

const editor = editorLoop()
await sleep(600)

/* ---------- 工具全量调用 ---------- */
const blocks = [
  { type: 'heading', level: 1, text: '季度复盘' },
  { type: 'paragraph', text: '本季度收入环比增长 18%，主要来自企业版续费。' },
  { type: 'heading', level: 2, text: '关键数字' },
  { type: 'bullet', text: '新增客户 32 家' },
  { type: 'bullet', text: '流失率 1.2%' },
]

let r = await TOOL_IMPL.canvas_status()
check('canvas_status', !r.isError, r.content[0].text.slice(0, 60))

r = await TOOL_IMPL.canvas_write_document({ title: '复盘', blocks })
check('canvas_write_document', !r.isError && /已写入/.test(r.content[0].text), r.content[0].text)

r = await TOOL_IMPL.canvas_read({ mode: 'text' })
check('canvas_read text', !r.isError && r.content[0].text.includes('季度复盘'), r.content[0].text.slice(0, 40))

r = await TOOL_IMPL.canvas_append_blocks({
  blocks: [{ type: 'paragraph', text: '下一步：扩大渠道合作。' }],
})
check('canvas_append_blocks', !r.isError && /已追加/.test(r.content[0].text), r.content[0].text)

r = await TOOL_IMPL.canvas_insert_table({
  headers: ['指标', '数值'],
  rows: [['收入', '1.2 亿'], ['客户', '32 家']],
})
check('canvas_insert_table', !r.isError && /已插入表格/.test(r.content[0].text), r.content[0].text)

r = await TOOL_IMPL.canvas_replace_text({ find: '18%', replace: '20%' })
check('canvas_replace_text', !r.isError && /替换 1 处/.test(r.content[0].text), r.content[0].text)

r = await TOOL_IMPL.canvas_page_setup({ size: 'A4', direction: 'vertical', mode: 'paging' })
check('canvas_page_setup', !r.isError && /已应用页面设置/.test(r.content[0].text), r.content[0].text)

r = await TOOL_IMPL.canvas_history({ action: 'undo' })
check('canvas_history', !r.isError, r.content[0].text)

r = await TOOL_IMPL.canvas_screenshot()
check('canvas_screenshot', !r.isError && r.content.some((c) => c.type === 'image'),
  r.content[0].text)

r = await TOOL_IMPL.canvas_read({ mode: 'summary' })
check('canvas_read summary', !r.isError && /word_count/.test(r.content[0].text), r.content[0].text.slice(0, 60))

r = await TOOL_IMPL.canvas_clear()
check('canvas_clear', !r.isError, r.content[0].text)

r = await TOOL_IMPL.canvas_read({ mode: 'text' })
check('清空后正文为空', !r.isError && r.content[0].text.includes('空文档'), r.content[0].text)

r = await TOOL_IMPL.canvas_style({})
check('canvas_style 空参报错', r.isError === true, r.content[0].text)

st.stopped = true
await sleep(300)

console.log('')
if (failures.length) {
  console.log(`✗ ${failures.length} 项失败: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('✓ 冒烟全通过（假编辑器闭环）')
process.exit(0)
