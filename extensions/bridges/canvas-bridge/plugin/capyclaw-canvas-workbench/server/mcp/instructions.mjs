/** MCP server instructions：数据来自 dsh-tool-host 的 buildInstructions。 */
import { buildInstructions } from '../shared/tool-host.mjs'

export function serverInstructions(editorUrl, { tools = [], capabilities = [] } = {}) {
  return buildInstructions({
    title: 'Canvas 文档工作台',
    intro: `面向长文档生成与精修：块级写作模型 + ${tools.length} 个 canvas_* 工具。编辑器地址 ${editorUrl}（浏览器打开即连接；写工具需要编辑器在线）。`,
    startup: [
      '先调 canvas_capabilities 确认 contractVersion 与工具面；major 不一致时停止并提示升级套件。',
      '编辑器未连接时，写工具会明确报错并给出编辑器地址；不要反复重试。',
    ],
    capabilities,
    tools,
    rules: [
      '成稿用 canvas_write_document 一次写入；续写用 canvas_append_blocks；不要逐段小步写。',
      '改文字用 canvas_replace_text；套样式用 canvas_style（文本定位，不需要选区）。',
      '工具面没覆盖的组合操作走 canvas_exec（先 canvas_commands 看可用命令）。',
      '读取默认 canvas_read summary；只有需要精确结构时才读 doc 全量。',
      '编辑/成稿默认不主动截图；用户要求验收时才 canvas_screenshot + canvas_audit。',
    ],
    output: [
      '工具返回已含回执；改完一句话说明结果，不贴 JSON。',
      '报告字数/结构变化时以工具返回为准，不要目测。',
    ],
  })
}
