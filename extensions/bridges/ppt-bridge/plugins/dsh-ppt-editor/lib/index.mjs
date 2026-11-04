/**
 * PPT 编辑器插件 - Cordis 入口
 * 运行在 DeepSeek Harness 进程内，不启动独立服务器
 */

export const name = 'dsh-ppt-editor'

// 插件状态（存储在 Cordis context 中）
const state = {
  presentations: [],
  currentPresentationId: null,
  slides: [],
  currentSlideIndex: 0,
  templates: [
    { id: 'professional', name: '专业商务', theme: 'blue' },
    { id: 'creative', name: '创意设计', theme: 'purple' },
    { id: 'minimal', name: '简约风格', theme: 'gray' },
    { id: 'tech', name: '科技风', theme: 'dark' }
  ]
}

export async function apply(ctx, config) {
  const logger = ctx.logger('ppt-editor')
  
  logger.info('PPT 编辑器插件加载中...')
  
  // 将状态挂载到 context
  ctx.pptEditor = {
    state,
    getState: () => state,
    updateState: (updates) => {
      Object.assign(state, updates)
      ctx.emit('ppt-editor:state-changed', state)
    }
  }
  
  // 注册 MCP 工具
  registerTools(ctx, logger)
  
  // 注册侧边栏 UI（如果 Harness 支持）
  if (ctx.sidebarRight && ctx.sidebarRightTabs) {
    registerSidebarUI(ctx, logger)
  }
  
  // 监听 AI 事件
  ctx.on('conversation:message', (message) => {
    // 可以在这里监听 AI 消息，做智能处理
    logger.debug('收到消息:', message)
  })
  
  logger.success('PPT 编辑器插件已加载')
  
  // 返回清理函数
  return () => {
    logger.info('PPT 编辑器插件卸载')
  }
}

/**
 * 注册 MCP 工具
 */
function registerTools(ctx, logger) {
  // 注册到 MCP 工具系统
  ctx.on('mcp:register-tools', (registry) => {
    registry.register({
      name: 'ppt_create',
      description: '创建新的 PPT 演示文稿',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'PPT 标题'
          },
          template: {
            type: 'string',
            description: '模板 ID',
            enum: ['professional', 'creative', 'minimal', 'tech'],
            default: 'professional'
          },
          slides: {
            type: 'number',
            description: '幻灯片数量',
            default: 5,
            minimum: 1,
            maximum: 50
          }
        },
        required: ['title']
      },
      handler: async (args) => {
        return handleCreatePPT(ctx, args, logger)
      }
    })
    
    registry.register({
      name: 'ppt_add_slide',
      description: '添加幻灯片到当前 PPT',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '幻灯片标题' },
          content: { type: 'string', description: '幻灯片内容' },
          layout: {
            type: 'string',
            description: '布局类型',
            enum: ['title', 'title-content', 'two-column', 'image-text'],
            default: 'title-content'
          }
        },
        required: ['title', 'content']
      },
      handler: async (args) => {
        return handleAddSlide(ctx, args, logger)
      }
    })
    
    registry.register({
      name: 'ppt_edit_slide',
      description: '编辑指定幻灯片',
      inputSchema: {
        type: 'object',
        properties: {
          slideIndex: {
            type: 'number',
            description: '幻灯片索引（从 0 开始）'
          },
          title: { type: 'string', description: '新标题' },
          content: { type: 'string', description: '新内容' }
        },
        required: ['slideIndex']
      },
      handler: async (args) => {
        return handleEditSlide(ctx, args, logger)
      }
    })
    
    registry.register({
      name: 'ppt_delete_slide',
      description: '删除指定幻灯片',
      inputSchema: {
        type: 'object',
        properties: {
          slideIndex: {
            type: 'number',
            description: '幻灯片索引（从 0 开始）'
          }
        },
        required: ['slideIndex']
      },
      handler: async (args) => {
        return handleDeleteSlide(ctx, args, logger)
      }
    })
    
    registry.register({
      name: 'ppt_preview',
      description: '预览当前 PPT',
      inputSchema: {
        type: 'object',
        properties: {}
      },
      handler: async (args) => {
        return handlePreview(ctx, logger)
      }
    })
    
    logger.info('已注册 5 个 PPT 工具')
  })
}

/**
 * 注册侧边栏 UI
 */
function registerSidebarUI(ctx, logger) {
  try {
    // 注册 Tab 类型
    ctx.sidebarRightTabs.register({
      id: '@dsh-ppt-editor/preview',
      kind: 'ppt-preview',
      title: () => 'PPT 编辑器',
      icon: '📊',
      guide: {
        title: 'PPT 编辑器',
        description: '实时预览和编辑 PPT',
        action: () => {
          ctx.sidebarRight.openTab('ppt-preview')
        }
      }
    })
    
    logger.info('已注册侧边栏 UI')
  } catch (error) {
    logger.warn('侧边栏注册失败（可能 Harness 版本不支持）:', error.message)
  }
}

/**
 * 工具处理函数
 */

async function handleCreatePPT(ctx, args, logger) {
  const { title, template = 'professional', slides: slideCount = 5 } = args
  
  logger.info(`创建 PPT: ${title}, 模板: ${template}, 幻灯片: ${slideCount}`)
  
  // 生成幻灯片
  const slides = []
  for (let i = 0; i < slideCount; i++) {
    slides.push({
      id: `slide-${Date.now()}-${i}`,
      index: i,
      title: i === 0 ? title : `幻灯片 ${i + 1}`,
      content: i === 0 ? '封面页' : `这里是第 ${i + 1} 页的内容`,
      layout: i === 0 ? 'title' : 'title-content',
      notes: ''
    })
  }
  
  // 更新状态
  const presentation = {
    id: `ppt-${Date.now()}`,
    title,
    template,
    createdAt: new Date().toISOString(),
    slides
  }
  
  ctx.pptEditor.state.presentations.push(presentation)
  ctx.pptEditor.state.currentPresentationId = presentation.id
  ctx.pptEditor.state.slides = slides
  ctx.pptEditor.state.currentSlideIndex = 0
  
  // 触发状态更新事件
  ctx.emit('ppt-editor:state-changed', ctx.pptEditor.state)
  
  // 自动打开侧边栏
  if (ctx.sidebarRight) {
    try {
      ctx.sidebarRight.openTab('ppt-preview')
    } catch (e) {
      // 忽略错误
    }
  }
  
  return {
    content: [{
      type: 'text',
      text: `✅ 已创建 PPT "${title}"，共 ${slideCount} 页\n\n` +
            `📊 模板: ${template}\n` +
            `👁️ 可以在右侧面板实时查看预览\n\n` +
            `💡 提示: 使用 ppt_add_slide 添加更多幻灯片`
    }]
  }
}

async function handleAddSlide(ctx, args, logger) {
  const { title, content, layout = 'title-content' } = args
  const state = ctx.pptEditor.state
  
  if (state.slides.length === 0) {
    return {
      content: [{
        type: 'text',
        text: '❌ 错误: 请先使用 ppt_create 创建 PPT'
      }],
      isError: true
    }
  }
  
  const newSlide = {
    id: `slide-${Date.now()}`,
    index: state.slides.length,
    title,
    content,
    layout,
    notes: ''
  }
  
  state.slides.push(newSlide)
  ctx.emit('ppt-editor:state-changed', state)
  
  logger.info(`添加幻灯片: ${title}`)
  
  return {
    content: [{
      type: 'text',
      text: `✅ 已添加幻灯片 "${title}"\n\n` +
            `📄 当前共 ${state.slides.length} 页`
    }]
  }
}

async function handleEditSlide(ctx, args, logger) {
  const { slideIndex, title, content } = args
  const state = ctx.pptEditor.state
  
  if (slideIndex < 0 || slideIndex >= state.slides.length) {
    return {
      content: [{
        type: 'text',
        text: `❌ 错误: 幻灯片索引 ${slideIndex} 超出范围（0-${state.slides.length - 1}）`
      }],
      isError: true
    }
  }
  
  const slide = state.slides[slideIndex]
  if (title) slide.title = title
  if (content) slide.content = content
  
  ctx.emit('ppt-editor:state-changed', state)
  
  logger.info(`编辑幻灯片 ${slideIndex}: ${slide.title}`)
  
  return {
    content: [{
      type: 'text',
      text: `✅ 已更新第 ${slideIndex + 1} 页幻灯片`
    }]
  }
}

async function handleDeleteSlide(ctx, args, logger) {
  const { slideIndex } = args
  const state = ctx.pptEditor.state
  
  if (slideIndex < 0 || slideIndex >= state.slides.length) {
    return {
      content: [{
        type: 'text',
        text: `❌ 错误: 幻灯片索引 ${slideIndex} 超出范围`
      }],
      isError: true
    }
  }
  
  const deletedSlide = state.slides.splice(slideIndex, 1)[0]
  
  // 重新索引
  state.slides.forEach((slide, i) => {
    slide.index = i
  })
  
  ctx.emit('ppt-editor:state-changed', state)
  
  logger.info(`删除幻灯片: ${deletedSlide.title}`)
  
  return {
    content: [{
      type: 'text',
      text: `✅ 已删除第 ${slideIndex + 1} 页幻灯片\n\n` +
            `📄 剩余 ${state.slides.length} 页`
    }]
  }
}

async function handlePreview(ctx, logger) {
  const state = ctx.pptEditor.state
  
  if (state.slides.length === 0) {
    return {
      content: [{
        type: 'text',
        text: '📊 当前没有 PPT\n\n使用 ppt_create 创建新的演示文稿'
      }]
    }
  }
  
  const summary = state.slides.map((slide, i) => 
    `${i + 1}. ${slide.title} (${slide.layout})`
  ).join('\n')
  
  return {
    content: [{
      type: 'text',
      text: `📊 当前 PPT 预览\n\n` +
            `📝 标题: ${state.slides[0]?.title || '未命名'}\n` +
            `📄 幻灯片数: ${state.slides.length}\n\n` +
            `${summary}\n\n` +
            `👁️ 在右侧面板查看实时预览`
    }]
  }
}
