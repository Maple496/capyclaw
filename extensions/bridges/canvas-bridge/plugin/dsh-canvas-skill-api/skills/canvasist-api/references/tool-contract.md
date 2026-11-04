# Canvas Workbench 工具契约

- contractVersion: `1.0.0`
- packageVersion: `0.2.0`
- toolCount: 22
- features: `canvas.contract`, `doc.read`, `doc.write`, `text.replace`, `text.search`, `element.insert`, `table.edit`, `style.inline`, `page.setup`, `view.screenshot`, `view.control`, `doc.undo`, `doc.audit`, `task.checkpoint`, `exec.passthrough`, `export.html`

## 能力

- `contract`（契约探测）：`[object Object]`
- `doc`（文档读写）：`[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`
- `text`（查找替换）：`[object Object]`, `[object Object]`
- `element`（元素插入）：`[object Object]`, `[object Object]`, `[object Object]`
- `table`（表格编辑）：`[object Object]`
- `style`（行内样式）：`[object Object]`
- `page`（页面设置）：`[object Object]`
- `view`（视图与截图）：`[object Object]`, `[object Object]`
- `history`（撤销重做）：`[object Object]`
- `audit`（文档审计）：`[object Object]`
- `task`（任务检查点）：`[object Object]`, `[object Object]`
- `exec`（命令透传）：`[object Object]`, `[object Object]`
- `export`（导出）：`[object Object]`

> 本文件由 scripts/build-plugin.mjs 生成，禁止手改。

## `canvas_capabilities`

- kind: `read`
- since: `1.0.0`
- capability: `contract`

返回工作台契约版本、工具清单、能力清单与编辑器地址。skill 加载后先调用一次；工具缺失或 major 版本不一致时停止并提示升级。

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

## `canvas_read`

- kind: `read`
- since: `1.0.0`
- capability: `doc`

读取文档：summary（摘要+大纲+预览，默认）/ text（纯文本）/ outline（标题大纲）/ doc（完整元素流）。

```json
{
  "type": "object",
  "properties": {
    "mode": {
      "type": "string",
      "enum": [
        "summary",
        "text",
        "outline",
        "doc"
      ],
      "description": "读取模式"
    }
  },
  "additionalProperties": false
}
```

## `canvas_write_document`

- kind: `write`
- since: `1.0.0`
- capability: `doc`

一次成稿：用块数组整篇替换文档（避免几十次增量往返）。已有内容会被覆盖。

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "description": "批次说明（进 undo 历史）"
    },
    "blocks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "heading",
              "paragraph",
              "bullet",
              "number",
              "quote",
              "code",
              "divider",
              "pageBreak"
            ],
            "description": "块类型"
          },
          "text": {
            "type": "string",
            "description": "块文本"
          },
          "level": {
            "type": "number",
            "description": "heading 级别 1-4"
          },
          "index": {
            "type": "number",
            "description": "number 块序号"
          },
          "style": {
            "type": "object",
            "description": "行内样式（bold/italic/color/size/font/highlight/underline）"
          }
        },
        "required": [
          "type"
        ]
      }
    }
  },
  "required": [
    "blocks"
  ],
  "additionalProperties": false
}
```

## `canvas_append_blocks`

- kind: `write`
- since: `1.0.0`
- capability: `doc`

末尾续写：把块数组追加到正文末尾（不改已有内容）。

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string"
    },
    "blocks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "heading",
              "paragraph",
              "bullet",
              "number",
              "quote",
              "code",
              "divider",
              "pageBreak"
            ],
            "description": "块类型"
          },
          "text": {
            "type": "string",
            "description": "块文本"
          },
          "level": {
            "type": "number",
            "description": "heading 级别 1-4"
          },
          "index": {
            "type": "number",
            "description": "number 块序号"
          },
          "style": {
            "type": "object",
            "description": "行内样式（bold/italic/color/size/font/highlight/underline）"
          }
        },
        "required": [
          "type"
        ]
      }
    }
  },
  "required": [
    "blocks"
  ],
  "additionalProperties": false
}
```

## `canvas_clear`

- kind: `write`
- since: `1.0.0`
- capability: `doc`

清空文档（三段全空；undo 可撤销）。

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

## `canvas_replace_text`

- kind: `write`
- since: `1.0.0`
- capability: `text`

全文替换（默认全部）：保留元素样式与表格结构；返回替换次数。

```json
{
  "type": "object",
  "properties": {
    "find": {
      "type": "string",
      "description": "查找文本"
    },
    "replace": {
      "type": "string",
      "description": "替换文本"
    },
    "all": {
      "type": "boolean",
      "description": "替换全部（默认 true；false 只替换第一处）"
    },
    "title": {
      "type": "string"
    }
  },
  "required": [
    "find",
    "replace"
  ],
  "additionalProperties": false
}
```

## `canvas_search`

- kind: `read`
- since: `1.0.0`
- capability: `text`

搜索文本：返回命中区域/位置与上下文片段（只读，不改稿）。

```json
{
  "type": "object",
  "properties": {
    "find": {
      "type": "string",
      "description": "查找文本"
    },
    "limit": {
      "type": "number",
      "description": "最多返回条数（默认 50）"
    }
  },
  "required": [
    "find"
  ],
  "additionalProperties": false
}
```

## `canvas_insert_table`

- kind: `write`
- since: `1.0.0`
- capability: `element`

插入表格：headers + rows，列宽按内容自适应，表头默认底色。追加到正文末尾。

```json
{
  "type": "object",
  "properties": {
    "headers": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "表头（空数组则无表头行）"
    },
    "rows": {
      "type": "array",
      "items": {
        "type": "array",
        "items": {}
      },
      "description": "数据行（每行单元格可为字符串/数字）"
    },
    "header_background": {
      "type": "string",
      "description": "表头底色（默认 #eef1f5）"
    },
    "content_width": {
      "type": "number",
      "description": "内容区宽度（默认 554）"
    },
    "title": {
      "type": "string"
    }
  },
  "required": [
    "rows"
  ],
  "additionalProperties": false
}
```

## `canvas_insert_image`

- kind: `write`
- since: `1.0.0`
- capability: `element`

插入图片：value 接受 dataURL / http(s) URL / relay /assets 引用；追加到正文末尾。

```json
{
  "type": "object",
  "properties": {
    "src": {
      "type": "string",
      "description": "dataURL 或 URL（推荐 dataURL 或 /assets 引用）"
    },
    "width": {
      "type": "number",
      "description": "显示宽（默认 480）"
    },
    "height": {
      "type": "number",
      "description": "显示高（默认 270）"
    },
    "caption": {
      "type": "string",
      "description": "题注"
    },
    "title": {
      "type": "string"
    }
  },
  "required": [
    "src"
  ],
  "additionalProperties": false
}
```

## `canvas_element`

- kind: `write`
- since: `1.0.0`
- capability: `element`

结构元素与更新：separator（分割线）/ pageBreak（分页符）/ list（列表项）/ updateById（按 id 改元素属性）。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "separator",
        "pageBreak",
        "list",
        "updateById"
      ],
      "description": "操作"
    },
    "items": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "list：多级列表项（\"1. x\" / \"- x\" 前缀识别）"
    },
    "id": {
      "type": "string",
      "description": "updateById：元素 id"
    },
    "properties": {
      "type": "object",
      "description": "updateById：要覆盖的元素属性"
    },
    "title": {
      "type": "string"
    }
  },
  "required": [
    "action"
  ],
  "additionalProperties": false
}
```

## `canvas_table`

- kind: `write`
- since: `1.0.0`
- capability: `table`

表格结构操作（table: 第几个表格，从 0 起）。setCell 改单元格文本/背景；insertRow/deleteRow/insertCol/deleteCol 增删行列；merge 合并区域单元格。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "setCell",
        "insertRow",
        "deleteRow",
        "insertCol",
        "deleteCol",
        "merge"
      ],
      "description": "操作"
    },
    "table": {
      "type": "number",
      "description": "表格序号（默认 0）"
    },
    "row": {
      "type": "number",
      "description": "行号（setCell/insertRow 在该行上方插入/deleteRow 删该行）"
    },
    "col": {
      "type": "number",
      "description": "列号（insertCol 在该列左侧插入/deleteCol 删该列）"
    },
    "text": {
      "type": "string",
      "description": "setCell：单元格文本"
    },
    "backgroundColor": {
      "type": "string",
      "description": "setCell：单元格背景色（可选）"
    },
    "toRow": {
      "type": "number",
      "description": "merge：结束行"
    },
    "toCol": {
      "type": "number",
      "description": "merge：结束列"
    },
    "title": {
      "type": "string"
    }
  },
  "required": [
    "action"
  ],
  "additionalProperties": false
}
```

## `canvas_style`

- kind: `write`
- since: `1.0.0`
- capability: `style`

给包含指定文本的元素套样式：find 定位（必填），style 指定要改的属性。可精确匹配（exact）或多处全改（默认）。

```json
{
  "type": "object",
  "properties": {
    "find": {
      "type": "string",
      "description": "定位文本（元素 value 包含即命中）"
    },
    "exact": {
      "type": "boolean",
      "description": "默认 false 包含即命中；true 时元素文本需完全相等"
    },
    "style": {
      "type": "object",
      "description": "样式属性：bold/italic/underline/strikeout(boolean)、color/highlight/font(string)、size(number)",
      "properties": {
        "bold": {
          "type": "boolean"
        },
        "italic": {
          "type": "boolean"
        },
        "underline": {
          "type": "boolean"
        },
        "strikeout": {
          "type": "boolean"
        },
        "color": {
          "type": "string"
        },
        "highlight": {
          "type": "string"
        },
        "font": {
          "type": "string"
        },
        "size": {
          "type": "number"
        }
      },
      "additionalProperties": false
    },
    "title": {
      "type": "string"
    }
  },
  "required": [
    "find",
    "style"
  ],
  "additionalProperties": false
}
```

## `canvas_page_setup`

- kind: `write`
- since: `1.0.0`
- capability: `page`

页面设置：size（A4/A3/A5/B4/B5/Letter/Legal）、direction（vertical/horizontal）、margins([上,右,下,左])、columns（分栏数）。只传要改的字段。

```json
{
  "type": "object",
  "properties": {
    "size": {
      "type": "string",
      "enum": [
        "A4",
        "A3",
        "A5",
        "B4",
        "B5",
        "Letter",
        "Legal"
      ],
      "description": "纸张大小"
    },
    "direction": {
      "type": "string",
      "enum": [
        "vertical",
        "horizontal"
      ],
      "description": "纸张方向"
    },
    "margins": {
      "type": "array",
      "items": {
        "type": "number"
      },
      "description": "页边距 [上,右,下,左]（pt）"
    },
    "columns": {
      "type": "number",
      "description": "分栏数（1-4）"
    },
    "column_gap": {
      "type": "number",
      "description": "栏间距（默认 16）"
    },
    "title": {
      "type": "string"
    }
  },
  "additionalProperties": false
}
```

## `canvas_screenshot`

- kind: `read`
- since: `1.0.0`
- capability: `view`

编辑器渲染截图（所有页拼图，JPEG）：排版自检用。

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

## `canvas_view`

- kind: `control`
- since: `1.0.0`
- capability: `view`

页面级视图命令：pageMode(paging/continuous)/pageScale(0.5-3)/缩放/编辑模式/标尺/修订/打印/定位目录。不改文档内容。

```json
{
  "type": "object",
  "properties": {
    "cmd": {
      "type": "string",
      "enum": [
        "pageMode",
        "pageScale",
        "pageScaleAdd",
        "pageScaleMinus",
        "pageScaleRecovery",
        "mode",
        "toggleRuler",
        "toggleTrace",
        "print",
        "locationCatalog"
      ],
      "description": "视图命令"
    },
    "value": {
      "type": "string",
      "description": "命令参数（pageMode: paging|continuous；pageScale: 数字；mode: edit|clean）"
    },
    "title": {
      "type": "string"
    }
  },
  "required": [
    "cmd"
  ],
  "additionalProperties": false
}
```

## `canvas_history`

- kind: `control`
- since: `1.0.0`
- capability: `history`

撤销/重做（编辑器 undo 栈；一次 setValue 是一条记录）。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "undo",
        "redo"
      ]
    }
  },
  "required": [
    "action"
  ],
  "additionalProperties": false
}
```

## `canvas_audit`

- kind: `read`
- since: `1.0.0`
- capability: `audit`

审计当前文档：返回 blocking（必须处理）与 warn（提示）发现列表。只读，不改稿。

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

## `canvas_task`

- kind: `read`
- since: `1.0.0`
- capability: `task`

任务状态与检查点列表：seq/applied_seq/编辑器连接 + 已有检查点名。

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

## `canvas_checkpoint`

- kind: `write`
- since: `1.0.0`
- capability: `task`

检查点操作：save（当前文档存为命名检查点）/ restore（恢复到检查点）/ read（读检查点内容）。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "save",
        "restore",
        "read"
      ],
      "description": "操作"
    },
    "name": {
      "type": "string",
      "description": "检查点名（save 默认 auto）"
    },
    "title": {
      "type": "string"
    }
  },
  "required": [
    "action",
    "name"
  ],
  "additionalProperties": false
}
```

## `canvas_exec`

- kind: `write`
- since: `1.0.0`
- capability: `exec`

执行编辑器原生命令（白名单 108 条，分组见 canvas_capabilities）。cmds 是 {cmd,args} 数组；顺序执行、整批一条 undo 记录。示例：[{cmd:"insertTitle",args:[1]},{cmd:"bold",args:[true]}]。

```json
{
  "type": "object",
  "properties": {
    "cmds": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "cmd": {
            "type": "string",
            "description": "命令名（如 insertTable / bold / setRange / paperSize）"
          },
          "args": {
            "type": "array",
            "description": "命令参数数组"
          }
        },
        "required": [
          "cmd"
        ]
      },
      "description": "命令数组"
    },
    "title": {
      "type": "string"
    }
  },
  "required": [
    "cmds"
  ],
  "additionalProperties": false
}
```

## `canvas_commands`

- kind: `read`
- since: `1.0.0`
- capability: `exec`

列出全部可用命令（分组 + 说明）：写 canvas_exec 前先看这里。

```json
{
  "type": "object",
  "properties": {
    "group": {
      "type": "string",
      "description": "只看某组：doc/table/text/search/page/control/area/history/image/view"
    }
  },
  "additionalProperties": false
}
```

## `canvas_export`

- kind: `read`
- since: `1.0.0`
- capability: `export`

导出 HTML：name 为文件名（默认 export）。返回文件路径与下载 URL。浏览器打开 URL 可另存/打印成 PDF。

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "文件名（不含扩展名，默认 export）"
    },
    "title": {
      "type": "string",
      "description": "HTML 标题（默认取文档首个标题）"
    }
  },
  "additionalProperties": false
}
```
