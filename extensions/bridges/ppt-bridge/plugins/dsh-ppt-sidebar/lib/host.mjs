/**
 * PPT 工作台 - 侧边栏插件入口
 * 提供：MCP 工具 + WebSocket 通信 + HTTP UI 服务
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Logger, HttpServer, SingleInstance, WebSocketServer } from '../../../shared/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.resolve(HERE, '..', 'ui')

export const name = 'dsh-ppt-sidebar'

export async function apply(ctx, config) {
  const logger = new Logger('ppt-sidebar')
  const port = config?.port || 39311

  // 单实例锁
  const lock = new SingleInstance('ppt-sidebar', { port })
  if (!await lock.acquire()) {
    const existing = lock.readLock()
    if (existing) {
      logger.warn(`复用已运行的实例: http://127.0.0.1:${existing.port}`)
      return () => {} // 返回空清理函数
    }
  }

  // 创建状态管理
  const state = {
    slides: [],
    currentSlide: 0,
    isGenerating: false,
  }

  // 1. 创建 HTTP 服务器
  const httpServer = new HttpServer({
    port,
    baseDir: path.resolve(HERE, '..'),
    static: {
      '/': 'ui',
    },
    routes: {
      '/api/status': () => ({ 
        status: 'ok',
        slides: state.slides.length,
        current: state.currentSlide,
      }),
      '/api/state': () => state,
    },
  })

  await httpServer.start()
  logger.success(`UI 服务: ${httpServer.url}`)

  // 2. 创建 WebSocket 服务器（使用共享工具）
  const wss = new WebSocketServer({ 
    server: httpServer.server,
    path: '/ws'
  })
  
  wss.start()
  logger.success(`WebSocket: ws://127.0.0.1:${port}/ws`)

  // 监听 WebSocket 消息
  wss.on('connection', (ws, clientInfo) => {
    logger.info(`客户端已连接: ${clientInfo.ip}`)
    
    // 发送初始状态
    wss.send(ws, {
      type: 'init',
      data: state,
    })
  })

  wss.on('message', (data, ws) => {
    logger.debug('收到消息:', data)
    
    // 处理客户端操作
    switch (data.type) {
      case 'ping':
        wss.send(ws, { type: 'pong', timestamp: Date.now() })
        break
      
      case 'action':
        handleAction(data.action, data.params, ws)
        break
    }
  })

  wss.on('disconnect', (ws, clientInfo) => {
    logger.info(`客户端已断开: ${clientInfo.ip}`)
  })

  // 3. 注册 MCP 工具
  httpServer.addRoute('/mcp', async (req, res, body) => {
    if (req.method !== 'POST') {
      return { error: 'Method not allowed' }
    }

    const { method, params } = body

    switch (method) {
      case 'initialize':
        return {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'ppt-sidebar', version: '1.0.0' },
          capabilities: { tools: {} },
        }

      case 'tools/list':
        return {
          tools: [
            {
              name: 'ppt_create',
              description: '创建新的 PPT',
              inputSchema: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'PPT 标题' },
                  slides: { type: 'number', description: '幻灯片数量', default: 5 },
                },
                required: ['title'],
              },
            },
            {
              name: 'ppt_add_slide',
              description: '添加幻灯片',
              inputSchema: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: '幻灯片标题' },
                  content: { type: 'string', description: '幻灯片内容' },
                },
                required: ['title', 'content'],
              },
            },
            {
              name: 'ppt_preview',
              description: '预览当前 PPT',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
          ],
        }

      case 'tools/call':
        return await handleToolCall(params, wss, state, logger)

      default:
        return { error: { code: -32601, message: 'Method not found' } }
    }
  })

  logger.success(`MCP 工具已注册`)
  logger.info(`\n${'='.repeat(50)}`)
  logger.info(`🎉 PPT 工作台已启动！`)
  logger.info(`${'='.repeat(50)}`)
  logger.info(`📊 UI 界面: ${httpServer.url}`)
  logger.info(`🔌 WebSocket: ws://127.0.0.1:${port}/ws`)
  logger.info(`🛠️  MCP 工具: http://127.0.0.1:${port}/mcp`)
  logger.info(`${'='.repeat(50)}\n`)

  // 返回清理函数
  return async () => {
    await httpServer.stop()
    wss.close()
    lock.release()
    logger.info('PPT 工作台已停止')
  }
}

/**
 * 处理 MCP 工具调用
 */
async function handleToolCall(params, wss, state, logger) {
  const { name, arguments: args } = params

  try {
    switch (name) {
      case 'ppt_create': {
        const { title, slides = 5 } = args
        
        // 更新状态
        state.slides = Array.from({ length: slides }, (_, i) => ({
          id: i + 1,
          title: i === 0 ? title : `幻灯片 ${i + 1}`,
          content: i === 0 ? '封面页' : `内容 ${i + 1}`,
        }))
        state.currentSlide = 0
        state.isGenerating = false

        // 实时推送到 UI
        wss.broadcast({
          type: 'update',
          data: state,
        })

        logger.info(`创建 PPT: ${title}, ${slides} 页`)

        return {
          content: [{
            type: 'text',
            text: `✅ 已创建 PPT "${title}"，共 ${slides} 页。\n\n可以在右侧面板实时查看预览。`,
          }],
        }
      }

      case 'ppt_add_slide': {
        const { title, content } = args
        
        const newSlide = {
          id: state.slides.length + 1,
          title,
          content,
        }
        
        state.slides.push(newSlide)
        
        // 实时推送
        wss.broadcast({
          type: 'slide_added',
          data: newSlide,
        })

        logger.info(`添加幻灯片: ${title}`)

        return {
          content: [{
            type: 'text',
            text: `✅ 已添加幻灯片 "${title}"，当前共 ${state.slides.length} 页。`,
          }],
        }
      }

      case 'ppt_preview': {
        return {
          content: [{
            type: 'text',
            text: `📊 当前 PPT 状态：\n\n- 总页数: ${state.slides.length}\n- 当前页: ${state.currentSlide + 1}\n\n请在右侧面板查看实时预览。`,
          }],
        }
      }

      default:
        return {
          content: [{
            type: 'text',
            text: `❌ 未知工具: ${name}`,
          }],
          isError: true,
        }
    }
  } catch (error) {
    logger.error('工具调用失败:', error)
    return {
      content: [{
        type: 'text',
        text: `❌ 错误: ${error.message}`,
      }],
      isError: true,
    }
  }
}

/**
 * 处理客户端操作
 */
function handleAction(action, params, ws) {
  // 预留：处理来自 UI 的用户操作
  console.log('处理操作:', action, params)
}
