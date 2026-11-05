# Browser Workbench 工具契约

- contractVersion: `1.0.0`
- packageVersion: `0.1.0`
- toolCount: 15
- features: `browser.contract`, `browser.navigation`, `browser.snapshot`, `browser.interaction`, `browser.tabs`, `browser.screenshot`, `browser.session`, `browser.evaluate`

## 能力

- `contract`（契约探测）：`[object Object]`
- `navigation`（导航）：`[object Object]`
- `snapshot`（页面快照）：`[object Object]`
- `interaction`（页面交互）：`[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`
- `tabs`（标签页管理）：`[object Object]`
- `screenshot`（页面截图）：`[object Object]`
- `session`（会话管理）：`[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`
- `evaluate`（页面脚本）：`[object Object]`

> 本文件由 scripts/build-plugin.mjs 生成，禁止手改。

## `browser_capabilities`

- kind: `read`
- since: `1.0.0`
- capability: `contract`

返回工作台契约版本、工具清单、能力清单与引擎状态。skill 加载后先调用一次；工具缺失或 major 版本不一致时停止并提示升级。

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

## `browser_navigate`

- kind: `write`
- since: `1.0.0`
- capability: `navigation`

打开网址（仅 http/https；URL 内嵌用户名密码会被拒绝）。首次调用会自动拉起浏览器（默认有头可见，登录态持久化）。返回新页面的元素快照，后续动作直接引用其中的 ref。

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "maxLength": 2048,
      "description": "目标网址，如 https://example.com/"
    },
    "tab": {
      "type": "string",
      "maxLength": 16,
      "description": "在指定标签页打开（缺省=当前活动标签页；浏览器未启动时自动新建）"
    }
  },
  "required": [
    "url"
  ],
  "additionalProperties": false
}
```

## `browser_snapshot`

- kind: `read`
- since: `1.0.0`
- capability: `snapshot`

观察当前页面：返回可交互元素（链接/按钮/输入框/下拉…）与结构节点（标题/图片）的缩进文本树，每个元素带 ref=eN。click/fill/select 等动作只用 ref 定位；页面变化后 ref 会过期（报 STALE_SNAPSHOT），重新快照即可。

```json
{
  "type": "object",
  "properties": {
    "tab": {
      "type": "string",
      "maxLength": 16,
      "description": "目标标签页 id（缺省=当前活动标签页）"
    }
  },
  "additionalProperties": false
}
```

## `browser_click`

- kind: `write`
- since: `1.0.0`
- capability: `interaction`

点击元素。ref 来自最近一次 browser_navigate/browser_snapshot 的快照；元素已变化时报 STALE_SNAPSHOT，重新快照后用新 ref。动作成功后返回新快照。

```json
{
  "type": "object",
  "properties": {
    "ref": {
      "type": "string",
      "maxLength": 16,
      "description": "快照里的元素引用，如 e5"
    },
    "tab": {
      "type": "string",
      "maxLength": 16,
      "description": "目标标签页 id（缺省=当前活动标签页）"
    }
  },
  "required": [
    "ref"
  ],
  "additionalProperties": false
}
```

## `browser_fill`

- kind: `write`
- since: `1.0.0`
- capability: `interaction`

在输入框/文本域填写文字（整体替换，兼容 React/Vue 受控输入）。submit=true 时填写后按回车提交。密码框会被快照掩码显示，但填写不受影响。

```json
{
  "type": "object",
  "properties": {
    "ref": {
      "type": "string",
      "maxLength": 16,
      "description": "目标输入框的 ref"
    },
    "text": {
      "type": "string",
      "maxLength": 10000,
      "description": "要填入的文字（空字符串=清空）"
    },
    "submit": {
      "type": "boolean",
      "description": "填写后按 Enter 提交（默认 false）"
    },
    "tab": {
      "type": "string",
      "maxLength": 16,
      "description": "目标标签页 id（缺省=当前活动标签页）"
    }
  },
  "required": [
    "ref",
    "text"
  ],
  "additionalProperties": false
}
```

## `browser_press`

- kind: `write`
- since: `1.0.0`
- capability: `interaction`

按键。给 ref 时在指定元素上按（如输入框内 Enter），不给 ref 时对当前页面按（如 Tab / Escape / Control+a）。

```json
{
  "type": "object",
  "properties": {
    "key": {
      "type": "string",
      "maxLength": 40,
      "description": "键名：Enter / Tab / Escape / ArrowDown / Control+a 等（Playwright 键名）"
    },
    "ref": {
      "type": "string",
      "maxLength": 16,
      "description": "目标元素 ref（缺省=页面级按键）"
    },
    "tab": {
      "type": "string",
      "maxLength": 16,
      "description": "目标标签页 id（缺省=当前活动标签页）"
    }
  },
  "required": [
    "key"
  ],
  "additionalProperties": false
}
```

## `browser_select`

- kind: `write`
- since: `1.0.0`
- capability: `interaction`

选择下拉框（select）的选项。value 先按 <option value> 匹配，失败自动按选项文本匹配。

```json
{
  "type": "object",
  "properties": {
    "ref": {
      "type": "string",
      "maxLength": 16,
      "description": "目标下拉框的 ref"
    },
    "value": {
      "type": "string",
      "maxLength": 300,
      "description": "选项的 value 或可见文本"
    },
    "tab": {
      "type": "string",
      "maxLength": 16,
      "description": "目标标签页 id（缺省=当前活动标签页）"
    }
  },
  "required": [
    "ref",
    "value"
  ],
  "additionalProperties": false
}
```

## `browser_scroll`

- kind: `write`
- since: `1.0.0`
- capability: `interaction`

滚动当前页面（默认向下 600px）。懒加载页面翻内容用它。

```json
{
  "type": "object",
  "properties": {
    "direction": {
      "type": "string",
      "enum": [
        "up",
        "down"
      ],
      "description": "方向（默认 down）"
    },
    "amount": {
      "type": "number",
      "description": "像素数（默认 600）"
    },
    "tab": {
      "type": "string",
      "maxLength": 16,
      "description": "目标标签页 id（缺省=当前活动标签页）"
    }
  },
  "additionalProperties": false
}
```

## `browser_tabs`

- kind: `control`
- since: `1.0.0`
- capability: `tabs`

标签页四合一：action=list 列出（含稳定 id 与当前地址）；new 打开新标签页（可带 url）；select 切换活动标签页；close 关闭。后续动作默认作用于活动标签页，也可用 tab 参数显式指定。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "list",
        "new",
        "select",
        "close"
      ],
      "description": "动作（默认 list）"
    },
    "url": {
      "type": "string",
      "maxLength": 2048,
      "description": "new 动作要打开的网址"
    },
    "tab": {
      "type": "string",
      "maxLength": 16,
      "description": "select/close 的目标标签页 id"
    }
  },
  "additionalProperties": false
}
```

## `browser_screenshot`

- kind: `read`
- since: `1.0.0`
- capability: `screenshot`

当前页面截图（PNG 保存到本机，返回绝对路径）。默认视口截图；fullPage=true 截整页。工作台地址可实时观察页面。

```json
{
  "type": "object",
  "properties": {
    "fullPage": {
      "type": "boolean",
      "description": "是否截取整页（默认 false）"
    },
    "tab": {
      "type": "string",
      "maxLength": 16,
      "description": "目标标签页 id（缺省=当前活动标签页）"
    }
  },
  "additionalProperties": false
}
```

## `browser_status`

- kind: `read`
- since: `1.0.0`
- capability: `session`

引擎状态：是否运行、有头/无头、标签页清单（id+地址）、累计动作数、最近动作日志。不确定浏览器是否还活着时先看它。

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

## `browser_wait`

- kind: `control`
- since: `1.0.0`
- capability: `session`

等待：ms=毫秒；selector=等元素出现（如 .result）；都不给=等页面 load 完成。动作后页面还在加载/渲染时用它。

```json
{
  "type": "object",
  "properties": {
    "ms": {
      "type": "number",
      "description": "等待毫秒数（上限 30000）"
    },
    "selector": {
      "type": "string",
      "maxLength": 300,
      "description": "等待出现的 CSS 选择器"
    },
    "tab": {
      "type": "string",
      "maxLength": 16,
      "description": "目标标签页 id（缺省=当前活动标签页）"
    }
  },
  "additionalProperties": false
}
```

## `browser_history`

- kind: `control`
- since: `1.0.0`
- capability: `session`

浏览历史：back 后退 / forward 前进 / reload 重载。返回操作后的新快照。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "back",
        "forward",
        "reload"
      ],
      "description": "动作（默认 back）"
    },
    "tab": {
      "type": "string",
      "maxLength": 16,
      "description": "目标标签页 id（缺省=当前活动标签页）"
    }
  },
  "additionalProperties": false
}
```

## `browser_close`

- kind: `control`
- since: `1.0.0`
- capability: `session`

关闭浏览器（所有标签页）。登录态与 profile 持久化，下次 navigate 自动重启浏览器并保留登录。任务结束或页面卡死时用它重置。

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

## `browser_evaluate`

- kind: `write`
- since: `1.0.0`
- capability: `evaluate`

在页面里执行 JS 表达式并返回结果。默认关闭（安全默认）；关闭时返回 NOT_IMPLEMENTED 与开启方法。优先用快照+ref 完成任务，本工具留给快照覆盖不了的场景。

```json
{
  "type": "object",
  "properties": {
    "script": {
      "type": "string",
      "maxLength": 20000,
      "description": "JS 表达式（如 document.title）"
    },
    "tab": {
      "type": "string",
      "maxLength": 16,
      "description": "目标标签页 id（缺省=当前活动标签页）"
    }
  },
  "required": [
    "script"
  ],
  "additionalProperties": false
}
```
