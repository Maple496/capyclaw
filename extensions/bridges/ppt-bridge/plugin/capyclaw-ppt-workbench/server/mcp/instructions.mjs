/**
 * server instructions：agent 拿到的「怎么用这套工具」说明书（≤32KB 硬限）。
 * 排版由 dsh-tool-host 的 buildInstructions 统一生成，本文件只放 PPT 文案。
 */
import { buildInstructions } from '../shared/tool-host.mjs'
import { CONTRACT_VERSION } from '../contract.mjs'

export function serverInstructions(editorUrl, { tools = [], capabilities = [] } = {}) {
  const major = String(CONTRACT_VERSION).split('.')[0]
  const caps = capabilities.length
    ? capabilities
    : [{ title: '工具', description: '', tools: tools.map((tool) => tool.name) }]

  return buildInstructions({
    title: 'PPTist 工作台',
    intro: '你负责通过 `mcp__ppt__*` 工具编辑右侧实时 PPTist 编辑器。',
    startup: [
      `首次操作前调用 \`ppt_capabilities\`，确认 \`contractVersion\` 为 ${major}.x；工具缺失或 major 不一致时停止，提示用户安装/升级 \`dsh-ppt-suite\`。`,
      '若本会话提供对应 skill，先加载：`pptmaster-narrative`、`pptmaster-design`、`pptist-api`、`pptist-authoring`、`pptist-editing`、`pptist-visual-check`、`pptist-research`；没有 skill 时按本页规则执行。',
    ],
    capabilities: caps,
    rules: [
      '用户说“背景/页面/幻灯片/标题”指右侧编辑器，不是网页或文件。',
      '新建 deck 默认用 `ppt_deck` + `preset:"clean"` 出简洁稿，不叠装饰形状。',
      '改现有 deck 只执行用户点名的修改；不主动审美、审计、截图，不扩大范围。',
      '改整体背景/配色只用 `ppt_recolor` 一次完成；禁止逐页 `ppt_element` 改色。',
      '改文字/加页/改背景不要先读整个 deck；只有定位具体元素时才 `ppt_get_deck({detailed:true})`，一次即可。',
      '图片用 `ppt_image`（attachment_id/path/src），不要用 shell 找图，不要用 `ppt_element` 传本机路径。',
      '单次工具参数不要过大：`ppt_deck` 一次不超过约 20 页；超过时先成稿骨架，再用 `ppt_fill` / `ppt_text` 分批补充，避免 tool input JSON 解析失败。',
      '不主动截图；用户要求看效果或确实不确定版面时才 `ppt_screenshot`。',
      '工具返回已含回执；改完一句话回复，不要重复验证。',
      '长任务每阶段用 `ppt_task` checkpoint；新会话先 status，必要时 restore。',
      `编辑器未连接时，提示用户打开 ${editorUrl}（页面加载后自动连接），不要循环重试。`,
    ],
    output: [
      '交付时说明页数、每章要点、是否已截图确认。',
      '不贴 JSON、不列工具调用日志。',
    ],
  })
}
