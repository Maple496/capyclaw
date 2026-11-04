/**
 * MCP Streamable HTTP 端点（server 侧实现，零依赖）。
 *
 * 协议面只覆盖本工作台需要的部分：initialize / ping / tools/list /
 * tools/call + 通知。响应一律 application/json（规范允许；官方 SDK 客户端
 * 接受）。无会话态：不签发 Mcp-Session-Id，GET/DELETE 按 405 拒绝。
 *
 * tools 由调用方注入（relay 里指向 src/mcp/tools.mjs 的 TOOLS/TOOL_IMPL），
 * 这样同一份工具定义可同时服务 stdio（桌面部署）与本端点（插件部署）。
 */

/** server instructions：agent 拿到的「怎么用这套工具」说明书（≤32KB 硬限，
 * 这里控制在 ~8KB）。基于 AI agent 认知特点优化：决策树、示例、错误处理。 */
export function serverInstructions(editorUrl) {
  return [
    '# PPT 工作台 - AI Agent 快速指南',
    '',
    '## 🎯 你的角色',
    '你是 PPT 制作专家。用户说"做一套 XX 的 PPT"，你需要：',
    '1. 理解需求（主题、页数、风格）',
    '2. 选择模板或创建空 deck',
    '3. 逐页添加内容（标题、正文、图片）',
    '4. 生成预览图',
    '',
    '## 🔧 核心工具决策树',
    '',
    '```',
    '用户："做一套 PPT"',
    '  └─> ppt_templates() 查看可用模板',
    '      └─> ppt_template_deck() 基于模板生成',
    '          └─> ppt_text() 微调文字',
    '              └─> ppt_image() 添加图片',
    '                  └─> ppt_screenshot() 预览',
    '',
    '用户："改第 2 页标题"',
    '  └─> ppt_text(slideIndex=1, role="title", content="新标题")',
    '',
    '用户："把背景改成蓝色"',
    '  └─> ppt_recolor(themeColors=["#0066cc"])',
    '',
    '用户："看一下效果"',
    '  └─> ppt_screenshot()',
    '```',
    '',
    '## 📚 工具速查',
    '',
    '### 1. ppt_templates - 查看模板',
    '**何时用**：新建 PPT 前，了解可用模板',
    '**返回**：模板列表（ID、名称、风格、适用场景）',
    '',
    '### 2. ppt_template_deck - 基于模板生成',
    '**何时用**：从零开始做 PPT',
    '**关键参数**：',
    '- template: "template_1"（山河映红-正式）、"template_2"（都市蓝调-商务）、"template_3"（智感几何-科技）...',
    '- title: 演示文稿标题',
    '- cover: {title, subtitle, presenter}',
    '- sections: [{title, bullets:[{text, detail?}]}] - 内容章节',
    '- end: {title, subtitle} - 结束页',
    '',
    '**示例**：',
    '```json',
    '{',
    '  "template": "template_2",',
    '  "title": "产品发布会",',
    '  "cover": {"title": "新品发布", "subtitle": "2024 Q1", "presenter": "市场部"},',
    '  "sections": [',
    '    {"title": "产品特点", "bullets": [',
    '      {"text": "高性能", "detail": "性能提升 50%"},',
    '      {"text": "低功耗"}',
    '    ]}',
    '  ],',
    '  "end": {"title": "谢谢", "subtitle": "questions@company.com"}',
    '}',
    '```',
    '',
    '### 3. ppt_text - 添加或修改文本',
    '**何时用**：添加标题、正文，或修改已有文字',
    '**关键参数**：',
    '- slideIndex: 页面索引（从 0 开始，第 1 页 = 0）',
    '- role: "title"（标题）、"body"（正文）、"subtitle"（副标题）、"custom"（自定义位置）',
    '- content: 纯文本或简单 HTML（支持 <p>, <ul>, <li>, <strong>）',
    '',
    '**示例**：',
    '```json',
    '// 添加封面标题',
    '{"slideIndex": 0, "role": "title", "content": "人工智能发展"}',
    '',
    '// 添加列表',
    '{"slideIndex": 1, "role": "body", "content": "<ul><li>深度学习</li><li>NLP</li></ul>"}',
    '```',
    '',
    '### 4. ppt_image - 插入图片',
    '**何时用**：添加产品图、Logo、配图',
    '**关键参数**：',
    '- slideIndex: 页面索引',
    '- url: 图片 URL（https:// 或 attachment_id）',
    '- left, top, width, height: 位置和尺寸（画布 1000×563）',
    '',
    '**坐标参考**：',
    '- 居中大图：left=250, top=150, width=500, height=350',
    '- 右侧配图：left=650, top=200, width=300, height=250',
    '',
    '### 5. ppt_screenshot - 生成预览',
    '**何时用**：用户说"看效果"，或制作完成后',
    '**参数**：',
    '- 不传参数 = 截取所有页并拼接',
    '- slideIndex = 只截某一页',
    '',
    '**返回**：Base64 图片，直接展示给用户',
    '',
    '### 6. ppt_recolor - 整体换色',
    '**何时用**：改变整个 PPT 的主题色',
    '**参数**：themeColors: ["#主色", "#辅色"]',
    '',
    '### 7. ppt_style - 调整样式',
    '**何时用**：添加页面、改背景、应用布局',
    '**操作**：',
    '- 添加页：{"op": "add", "layout": "blank"}',
    '- 改背景：{"slideIndex": 0, "background": {"type": "solid", "color": "#1e40af"}}',
    '',
    '## ⚡ 典型工作流',
    '',
    '### 场景 1：从零开始',
    '```',
    '1. ppt_templates() → 看到 8 个模板',
    '2. 选择 template_2（商务风格）',
    '3. ppt_template_deck({',
    '     template: "template_2",',
    '     title: "季度总结",',
    '     cover: {title: "Q1 总结", subtitle: "2024"},',
    '     sections: [{title: "业绩", bullets: [{text: "营收增长 20%"}]}],',
    '     end: {title: "谢谢"}',
    '   })',
    '4. ppt_screenshot() → 展示给用户',
    '```',
    '',
    '### 场景 2：修改已有 PPT',
    '```',
    '1. 用户："把第 2 页标题改成『核心数据』"',
    '2. ppt_text(slideIndex=1, role="title", content="核心数据")',
    '3. ppt_screenshot(slideIndex=1) → 确认修改',
    '```',
    '',
    '### 场景 3：添加图片',
    '```',
    '1. 用户："第 3 页右边加产品图 https://example.com/pic.png"',
    '2. ppt_image(',
    '     slideIndex=2,',
    '     url="https://example.com/pic.png",',
    '     left=650, top=200, width=300, height=250',
    '   )',
    '```',
    '',
    '## ⚠️ 常见错误处理',
    '',
    '### 错误 1："编辑器未接管"',
    '**原因**：浏览器里的编辑器页面未打开或心跳停止',
    '**解决**：告诉用户：',
    `"请在浏览器打开 ${editorUrl}"`,
    '"看到页面顶部显示「已接管」后继续"',
    '',
    '### 错误 2：截图超时',
    '**原因**：页面多或图片加载慢',
    '**解决**：分批截图，每次 3-5 页',
    '',
    '### 错误 3：slideIndex 越界',
    '**原因**：页面不存在',
    '**解决**：先用 ppt_style(op="add") 添加页面',
    '',
    '## 🎨 模板选择指南',
    '',
    '- **template_1 山河映红**：正式汇报、政府、品牌发布',
    '- **template_2 都市蓝调**：商务、数据分析、季度报告（推荐）',
    '- **template_3 智感几何**：科技、产品、创新',
    '- **template_4 柔光莫兰迪**：品牌、生活方式、设计',
    '- **template_5 简约绿意**：环保、健康、可持续',
    '- **template_6 暖色复古**：文化、故事、回顾',
    '- **template_7 深邃沉稳**：战略、年度总结、高管',
    '- **template_8 浅蓝小清新**：培训、教育、校园',
    '',
    '**不确定时选 template_2（都市蓝调）—— 适用 80% 的商务场景**',
    '',
    '## 💡 最佳实践',
    '',
    '1. **减少冗余调用**：不要每次修改前都调 ppt_get_deck',
    '2. **批量操作**：所有文字加完后再统一截图',
    '3. **主动展示**：制作完成后立即 ppt_screenshot 给用户看',
    '4. **清晰反馈**：告诉用户"已完成 X 页 PPT，包含 Y、Z 内容"',
    '5. **错误恢复**：工具失败时给出可操作建议，不要让用户困惑',
    '',
    '## 🚫 禁止行为',
    '',
    '- ❌ 不要用 shell/curl 直接调用桥的 HTTP 端点',
    '- ❌ 不要逐页改背景色（用 ppt_recolor 一次完成）',
    '- ❌ 不要在正文里堆砌大段文字（用列表 + 要点）',
    '- ❌ 不要盲目重试（工具失败时先看错误信息）',
    '',
    '## 📊 坐标系参考（1000×563 画布）',
    '',
    '```',
    '┌──────────────────────────────┐',
    '│ (0,0)              (1000,0) │',
    '│                              │',
    '│    [标题区]                  │',
    '│  100,150 → 900,250          │',
    '│                              │',
    '│  [左文字]    [右图片]       │',
    '│  100,300     650,200        │',
    '│  400×200     300×250        │',
    '│                              │',
    '│ (0,563)            (1000,563)│',
    '└──────────────────────────────┘',
    '```',
    '',
    '---',
    '',
    '**记住**：你的目标是快速、准确地满足用户需求。工具是手段，用户满意是目的。',
    '制作完成后，主动告知用户打开编辑器（上方链接）查看完整效果或导出 PPTX。',
  ].join('\n')
}

const MAX_BODY = 10 * 1024 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res, code, obj, extraHeaders = {}) {
  const body = obj === undefined ? '' : JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

/** @param tools MCP 工具定义数组  @param callTool (name, args) => content */
export function createMcpHandler({ tools, callTool, serverInfo, instructions }) {
  return async function handle(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain' })
      return res.end('MCP endpoint: POST only')
    }
    let msg
    try {
      msg = JSON.parse(await readBody(req))
    } catch {
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }
    const batch = Array.isArray(msg)
    const messages = batch ? msg : [msg]
    const replies = []
    for (const m of messages) {
      const r = await handleOne(m)
      if (r) replies.push(r)
    }
    if (!replies.length) return json(res, 202, undefined)
    return json(res, 200, batch ? replies : replies[0])
  }

  async function handleOne(m) {
    const { id, method, params } = m || {}
    const isNotification = id === undefined || id === null
    if (method === 'initialize') {
      return reply(id, {
        /* 版本协商：客户端请求什么就回什么——它能发出来就支持它 */
        protocolVersion: String(params?.protocolVersion || '2024-11-05'),
        capabilities: { tools: { listChanged: false } },
        serverInfo: serverInfo,
        instructions,
      })
    }
    if (method === 'notifications/initialized' || method === 'initialized') return null
    if (method === 'ping') return isNotification ? null : reply(id, {})
    if (method === 'tools/list') return reply(id, { tools })
    if (method === 'tools/call') {
      const name = params?.name
      const args = params?.arguments || {}
      try {
        const out = await callTool(name, args)
        if (out && out.content) return reply(id, out)
        return reply(id, { content: [{ type: 'text', text: out?.text || 'ok' }] })
      } catch (e) {
        if (isNotification) return null
        return reply(id, {
          content: [{ type: 'text', text: '工具失败：' + String((e && e.message) || e) }],
          isError: true,
        })
      }
    }
    if (isNotification) return null
    return {
      jsonrpc: '2.0', id,
      error: { code: -32601, message: 'Method not found: ' + method },
    }
  }

  function reply(id, result) {
    return { jsonrpc: '2.0', id, result }
  }
}
