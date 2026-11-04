/**
 * Canvas 命令面：CanvasApp.exec(name, ...args) 的白名单与校验。
 *
 * 真源：runtime/canvas-full-app.js（由 scripts/discover-api.mjs 在真实浏览器里
 * 探测产出 contract/canvas-api.json，103 个已注册命令）。
 * test/contract.test.mjs 会把本清单与 discovery 产物对账。
 *
 * kind 语义：
 *   doc  —— 改文档内容，应用后编辑器会回传新镜像
 *   view —— 只改编辑器视图/模式，不产生新镜像
 */

/** 全部已注册命令（按域分组）。`svc` 段为桥层合成的便捷命令，不透传 exec。 */
export const COMMAND_GROUPS = {
  doc: {
    title: '文档内容',
    commands: {
      setValue: '整篇替换文档（args:[doc]；桥层合成，编辑器侧转 CanvasApp.load）',
      appendElementList: '追加元素流到正文末尾',
      insertElementList: '插入元素流（当前光标处）',
      insertTitle: '插入标题（level）',
      insertTable: '插入表格（{trList,colgroup}）',
      image: '插入图片（{value,width,height}）',
      hyperlink: '插入超链接（{valueList,url}）',
      separator: '插入分割线',
      pageBreak: '插入分页符',
      list: '列表（{listType,listMarkerType}）',
      updateElementById: '按 id 更新元素（{id,properties}）',
      replace: '替换（{searchStr,replaceStr}）',
      replaceRange: '替换范围（{searchStr,replaceStr,range}）',
      setGroup: '设置分组',
      format: '格式化（{formatList}）',
    },
  },
  table: {
    title: '表格操作',
    commands: {
      insertTableTopRow: '上方插行',
      insertTableBottomRow: '下方插行',
      insertTableLeftCol: '左侧插列',
      insertTableRightCol: '右侧插列',
      deleteTableRow: '删除行',
      deleteTableCol: '删除列',
      mergeTableCell: '合并单元格',
      splitHorizontalTableCell: '横向拆分',
      splitVerticalTableCell: '纵向拆分',
      tableTdVerticalAlign: '单元格垂直对齐',
      tableTdBorderType: '单元格边框',
      tableTdBackgroundColor: '单元格背景色',
      tableTdSlashType: '斜线',
      tableBorderType: '表格边框',
      tableBorderColor: '表格边框色',
      tableSelectAll: '全选表格',
      tableAutoFitToPage: '适应页宽',
      tableAutoFitToContent: '适应内容',
    },
  },
  text: {
    title: '文字样式（作用于选区；需先 setRange）',
    commands: {
      setRange: '设置选区（{startIndex,endIndex}）',
      getRange: '读取选区',
      bold: '加粗（selected）',
      italic: '斜体',
      underline: '下划线',
      strikeout: '删除线',
      superscript: '上标',
      subscript: '下标',
      title: '标题级（level）',
      size: '字号（size）',
      sizeAdd: '字号增',
      sizeMinus: '字号减',
      color: '文字色（value）',
      highlight: '高亮（value）',
      font: '字体（value）',
      rowFlex: '对齐（align）',
      rowMargin: '行间距',
    },
  },
  search: {
    title: '搜索导航',
    commands: {
      search: '搜索（{searchStr}）',
      searchNavigateNext: '下一处',
      searchNavigatePre: '上一处',
    },
  },
  page: {
    title: '页面设置',
    commands: {
      paperSize: '纸张大小',
      paperDirection: '纸张方向',
      setPaperMargin: '页边距（[t,r,b,l]）',
      setColumns: '分栏（{column,count,gap}）',
      setZone: '页眉页脚区（{zone,{...}}）',
      setMainBadge: '主区角标',
    },
  },
  control: {
    title: '控件',
    commands: {
      insertControl: '插入控件（{type,value,...}）',
      setControlValue: '设控件值',
      setControlProperties: '设控件属性',
      setControlExtension: '设控件扩展',
      setControlHighlight: '控件高亮',
      setControlValueList: '批量设值',
      setControlPropertiesList: '批量设属性',
      setControlExtensionList: '批量设扩展',
      removeControl: '移除控件',
      jumpControl: '跳转控件',
    },
  },
  area: {
    title: '区域（标注/批注）',
    commands: {
      insertArea: '插入区域',
      setAreaValue: '设区域值',
      setAreaProperties: '设区域属性',
      setAreaBadge: '区域角标',
    },
  },
  history: {
    title: '历史',
    commands: {
      undo: '撤销',
      redo: '重做',
      getValue: '读文档（含 options）',
      setHTML: 'HTML 载入',
    },
  },
  image: {
    title: '图片',
    commands: {
      replaceImageElement: '替换图片',
      setImageCrop: '图片裁剪',
      setImageCaption: '图片题注',
      saveAsImageElement: '元素另存为图片',
    },
  },
  view: {
    title: '视图/模式（不改文档）',
    viewOnly: true,
    commands: {
      mode: '编辑/只读（clean）',
      pageMode: '翻页/连续',
      pageScale: '缩放（scale）',
      pageScaleAdd: '放大',
      pageScaleMinus: '缩小',
      pageScaleRecovery: '复位缩放',
      toggleRuler: '标尺',
      toggleTrace: '修订',
      print: '打印',
      painter: '格式刷',
      locationCatalog: '定位到目录',
      locationControl: '定位到控件',
      locationArea: '定位到区域',
      locationGroup: '定位到分组',
      selectAll: '全选',
      copy: '复制',
      cut: '剪切',
      paste: '粘贴',
      translate: '翻译（AI 扩展）',
      wordTool: '文字工具（AI 扩展）',
      validate: '校验',
      setLocale: '语言',
      setSpellcheckRangeList: '拼写检查范围',
      setPositionContext: '位置上下文',
      updateOptions: '更新选项',
      getGroupIds: '分组 id 列表',
    },
  },
  svc: {
    title: '桥层合成（不透传 exec）',
    bridge: true,
    commands: {
      clear: '清空文档（桥层转 setValue 空文档）',
      redoTitle: '废弃占位，勿用',
    },
  },
}

/* redoTitle 不存在，占位剔除 */
delete COMMAND_GROUPS.svc.commands.redoTitle

const VIEW_ONLY = new Set(
  Object.values(COMMAND_GROUPS)
    .filter((g) => g.viewOnly)
    .flatMap((g) => Object.keys(g.commands)),
)

/** 桥层合成命令：编辑器 adapter 拦截解释，不进 CanvasApp.exec。 */
export const BRIDGE_COMMANDS = new Set(
  Object.values(COMMAND_GROUPS)
    .filter((g) => g.bridge)
    .flatMap((g) => Object.keys(g.commands)),
)

/** 全部可用命令名（含桥层合成）。 */
export const COMMAND_NAMES = new Set([
  ...Object.values(COMMAND_GROUPS).flatMap((g) => Object.keys(g.commands)),
])

export const isViewCommand = (name) => VIEW_ONLY.has(name)
export const isBridgeCommand = (name) => BRIDGE_COMMANDS.has(name)

const MAX_ARGS_JSON = 4 * 1024 * 1024
const MAX_CMDS = 100

/**
 * 校验一条指令。返回 {ok:true,cmd} 或 {ok:false,error}。
 * 指令形如 {cmd:'bold', args:[true]}；args 缺省为 []。
 */
export function validateCommand(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, error: '指令必须是 {cmd, args} 对象' }
  }
  const name = entry.cmd
  if (typeof name !== 'string' || !COMMAND_NAMES.has(name)) {
    return { ok: false, error: `未知命令：${name}（可用命令见 canvas_capabilities / contract/ops.json）` }
  }
  let args = entry.args
  if (args === undefined || args === null) args = []
  if (!Array.isArray(args)) {
    return { ok: false, error: `命令 ${name} 的 args 必须是数组` }
  }
  let size = 0
  for (const a of args) {
    try { size += JSON.stringify(a).length } catch { return { ok: false, error: `命令 ${name} 的参数不可序列化` } }
  }
  if (size > MAX_ARGS_JSON) {
    return { ok: false, error: `命令 ${name} 参数超过 ${Math.round(MAX_ARGS_JSON / 1024)}KB 上限` }
  }
  return { ok: true, cmd: { cmd: name, args } }
}

/** 校验一批指令（工具入口用）。 */
export function validateCommands(cmds) {
  if (!Array.isArray(cmds) || !cmds.length) return { ok: false, error: '没有可执行的指令' }
  if (cmds.length > MAX_CMDS) return { ok: false, error: `单批最多 ${MAX_CMDS} 条指令` }
  const out = []
  for (const entry of cmds) {
    const r = validateCommand(entry)
    if (!r.ok) return r
    out.push(r.cmd)
  }
  return { ok: true, cmds: out }
}

/** 分组清单（capabilities 报告 / 契约快照用）。 */
export function commandCatalog() {
  return Object.entries(COMMAND_GROUPS).map(([id, group]) => ({
    id, title: group.title, count: Object.keys(group.commands).length,
    viewOnly: !!group.viewOnly, bridge: !!group.bridge,
    commands: Object.entries(group.commands).map(([name, desc]) => ({ name, desc })),
  }))
}
