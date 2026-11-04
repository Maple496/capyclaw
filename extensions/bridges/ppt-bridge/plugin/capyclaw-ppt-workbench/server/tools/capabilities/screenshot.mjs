/** 实时画面能力：唯一依赖编辑器页面在线的能力。 */
import { sleep } from '../domains/tooling.mjs'
import { defineCapability, defineTool } from '../kernel/define.mjs'

let screenshotChain = Promise.resolve()

/* 每次尝试等编辑器回图的时长：两次合计 ~18s + settle 3s ≈ 21s 封顶。
   曾经 45s×2 ≈ 94s——客户端（60s 超时）早已断连，响应写回已销毁 socket
   曾引发进程崩溃（HTTP 层已加断连防护，这里同时改为快速失败）。 */
export const SHOT_WAIT_DEADLINES_MS = [12000, 6000]

async function captureScreenshot(ctx, { deadlines = SHOT_WAIT_DEADLINES_MS } = {}) {
  /* 截图必须在页面内渲染——这是唯一真正依赖面板在线的操作 */
  await ctx.editor.require()
  /* 空 deck 直接拒绝：曾经空 deck 让编辑器渲染空图被 sanitize 拒收，
     页面又已标记 lastShotReq 不再重试 → 服务端 shot_req 永久悬挂。 */
  const deckStatus = await ctx.status.get()
  if (deckStatus.has_deck === false || Number(deckStatus.slides || 0) === 0) {
    throw new Error('当前演示文稿为空（0 页），没有可截取的画面。请先用 ppt_deck / ppt_slide 添加页面。')
  }
  /* 先等编辑器应用完所有已排队指令，避免截到旧状态 */
  const settleDeadline = Date.now() + 3000
  while (Date.now() < settleDeadline) {
    const st = await ctx.status.get()
    if (Number(st.applied_seq || 0) >= Number(st.seq || 0)) break
    await sleep(120)
  }
  let lastError = ''
  for (const waitMs of deadlines) {
    const reqDoc = await ctx.editor.requestShot()
    const req = reqDoc.shot_req
    const deadline = Date.now() + waitMs
    let pending = true
    while (Date.now() < deadline) {
      const st = await ctx.status.get()
      if (st.shot && st.shot.req === req) {
        const shot = await ctx.editor.getShot()
        if (shot.data) {
          const base64 = shot.data.slice(shot.data.indexOf(',') + 1)
          return {
            content: [
              { type: 'text', text: `以下是右侧编辑器的实时画面（全部页拼图，帧 ${req}）：` },
              { type: 'image', data: base64, mimeType: 'image/jpeg' },
            ],
          }
        }
        lastError = '编辑器渲染失败'
        pending = false
        break
      }
      await sleep(150)
    }
    if (pending) lastError = '等待编辑器渲染超时'
    await sleep(600)
  }
  throw new Error(`截图失败（${lastError}）：编辑器面板未打开、在后台被浏览器节流，或页面已关闭。请把编辑器标签页切到前台再重试。`)
}

export const screenshotCapability = defineCapability({
  id: 'screenshot',
  title: '实时画面',
  tags: ['read', 'visual'],
  requires: ['editor', 'status'],
  features: ['deck.screenshot'],
  tools: [
    defineTool({
      name: 'ppt_screenshot',
      description: '取右侧编辑器实时画面（全部页拼图）。确认视觉效果时调用。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      kind: 'read',
      since: '1.0.0',
      handler: async (args, ctx) => {
        /* 并发截图串行化：多个工具调用不能互相 reset shot_req。 */
        const previous = screenshotChain
        let release
        screenshotChain = new Promise((resolve) => { release = resolve })
        await previous
        try {
          return await captureScreenshot(ctx)
        } finally {
          release()
        }
      },
    }),
  ],
})
