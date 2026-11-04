# PPT Bridge MCP 工具集 - AI Agent 使用指南

> **Legacy 文档（2026-10-30）**：本文描述的是旧 6 工具/旧参数版本，已不作为契约。
> 当前工具面以 `contract/ppt-contract.json` 与 `src/skills/pptist-api/SKILL.md` 为准；
> 内部架构见 `docs/ARCHITECTURE.md`。

## 🎯 核心原则

**你是 PPT 制作专家**。用户会说"做一套关于 XX 的 PPT"，你需要：
1. 理解内容（主题、风格、页数）
2. 选择模板（调用 `ppt_get_deck`）
3. 构建幻灯片（多次调用 `ppt_text`、`ppt_style`、`ppt_image` 等）
4. 预览效果（调用 `ppt_screenshot`）

**重要**：每次工具调用后，deck 会实时更新。你不需要"记住"整个 deck 结构，桥会维护状态。

---

## 📚 工具速查

### 决策树：我应该调用哪个工具？

```
用户说"做一套 PPT" 
  └─> ppt_get_deck (获取当前 deck，通常为空或模板)
      └─> ppt_text (逐页添加标题、正文)
          └─> ppt_style (调整布局、颜色、字体)
              └─> ppt_image (插入图片)
                  └─> ppt_screenshot (生成预览图)

用户说"改第 2 页的标题"
  └─> ppt_text (指定 slideIndex=1, role=title)

用户说"把封面背景改成蓝色"
  └─> ppt_style (指定 slideIndex=0, background={type:"solid", color:"#0066cc"})

用户说"看一下效果"
  └─> ppt_screenshot (生成所有页的截图)

用户说"第 3 页右边加一张产品图"
  └─> ppt_image (指定 slideIndex=2, 位置和尺寸)
```

---

## 🔧 工具详解

### 1. `ppt_get_deck` - 获取当前 deck

**何时使用**：
- ✅ 会话开始时，了解当前 deck 状态
- ✅ 用户说"看看现在有几页"
- ✅ 需要确认某一页的内容

**何时不用**：
- ❌ 每次修改前不需要调用（工具会自动作用于当前 deck）
- ❌ 已经知道 deck 结构时（减少无意义调用）

**返回内容**：
```json
{
  "title": "演示文稿标题",
  "slides": [
    {
      "id": "slide-1",
      "background": {"type": "solid", "color": "#ffffff"},
      "elements": [
        {
          "type": "text",
          "id": "title-1",
          "left": 100,
          "top": 200,
          "width": 800,
          "height": 100,
          "content": "<p>封面标题</p>"
        }
      ]
    }
  ],
  "theme": {
    "themeColors": ["#3b82f6", "#1e40af"],
    "fontColor": "#1f2937",
    "backgroundColor": "#ffffff"
  }
}
```

**关键字段**：
- `slides.length`：当前页数
- `slides[i].id`：页面 ID（修改时可选用）
- `slides[i].elements`：页面元素列表

---

### 2. `ppt_text` - 添加或修改文本

**何时使用**：
- ✅ 添加封面标题
- ✅ 添加正文内容
- ✅ 修改已有文本

**参数详解**：

#### `slideIndex` (必需)
- 从 0 开始的页面索引
- 示例：第 1 页 = `slideIndex: 0`，第 3 页 = `slideIndex: 2`

#### `role` (必需)
决定文本的位置和样式：
- `"title"`：页面标题（居中上方，大字号）
- `"subtitle"`：副标题（标题下方，中字号）
- `"body"`：正文（左对齐，正常字号）
- `"custom"`：自定义位置（需指定 `left`、`top`、`width`、`height`）

#### `content` (必需)
- **纯文本**或**简单 HTML**
- 支持：`<p>`, `<br>`, `<strong>`, `<em>`, `<ul>`, `<li>`
- 支持内联样式：`style="font-size:32px;color:#333;text-align:center;"`

**示例 1：添加封面标题**
```json
{
  "slideIndex": 0,
  "role": "title",
  "content": "人工智能发展现状"
}
```
→ 结果：第 1 页中央出现大标题

**示例 2：添加列表内容**
```json
{
  "slideIndex": 1,
  "role": "body",
  "content": "<p>核心技术：</p><ul><li>深度学习</li><li>自然语言处理</li><li>计算机视觉</li></ul>"
}
```
→ 结果：第 2 页左侧出现列表

**示例 3：自定义位置**
```json
{
  "slideIndex": 2,
  "role": "custom",
  "content": "<p style='font-size:28px;color:#666;'>备注文字</p>",
  "left": 600,
  "top": 450,
  "width": 300,
  "height": 80
}
```
→ 结果：文本出现在指定坐标

**常见错误**：
- ❌ `slideIndex` 超出范围 → 先用 `ppt_style` 添加页面
- ❌ `content` 包含复杂 HTML → 简化为基本标签
- ❌ `role="custom"` 但缺少坐标 → 补充 `left`, `top`, `width`, `height`

---

### 3. `ppt_style` - 调整样式和布局

**何时使用**：
- ✅ 添加新页面
- ✅ 修改背景颜色
- ✅ 应用模板布局
- ✅ 调整主题色

**参数详解**：

#### `slideIndex` (可选)
- 省略 = 修改整个 deck 的主题
- 指定 = 只修改某一页

#### 操作类型（传一个即可）：

**A. 添加页面** (`op: "add"`)
```json
{
  "op": "add",
  "slideIndex": 2,  // 插入位置（可选，默认末尾）
  "layout": "title-content"  // 布局模板（可选）
}
```

**B. 修改背景** (`background`)
```json
{
  "slideIndex": 0,
  "background": {
    "type": "solid",
    "color": "#1e40af"  // 纯色背景
  }
}
```
或渐变背景：
```json
{
  "slideIndex": 1,
  "background": {
    "type": "gradient",
    "gradientType": "linear",
    "gradientColor": ["#667eea", "#764ba2"],
    "gradientRotate": 45
  }
}
```

**C. 修改主题色** (`theme`)
```json
{
  "theme": {
    "themeColors": ["#3b82f6", "#1e40af"],
    "fontColor": "#1f2937",
    "backgroundColor": "#ffffff"
  }
}
```

**常见模板布局**：
- `"blank"`：空白页
- `"title-only"`：只有标题
- `"title-content"`：标题 + 内容区
- `"two-column"`：左右分栏
- `"title-image"`：标题 + 大图

**示例 1：添加一页空白页**
```json
{
  "op": "add",
  "layout": "blank"
}
```

**示例 2：把第 1 页背景改成蓝色**
```json
{
  "slideIndex": 0,
  "background": {"type": "solid", "color": "#1e40af"}
}
```

---

### 4. `ppt_image` - 插入图片

**何时使用**：
- ✅ 添加产品图、Logo、配图
- ✅ 用户提供图片 URL 或本地路径

**参数详解**：

#### `slideIndex` (必需)
页面索引（从 0 开始）

#### `url` (必需)
- 支持：`http://`, `https://`, `file://`, `data:image/...`
- 推荐：用 `https://` 的公开 URL

#### 位置和尺寸
- `left`, `top`：左上角坐标（像素）
- `width`, `height`：宽高（像素）

**坐标系**：画布 1000×563（16:9 比例）
- 居中：`left: 300, top: 150, width: 400, height: 250`
- 右侧：`left: 600, top: 100, width: 350, height: 400`

**示例**：
```json
{
  "slideIndex": 1,
  "url": "https://example.com/product.png",
  "left": 600,
  "top": 150,
  "width": 350,
  "height": 350
}
```

**常见错误**：
- ❌ 图片 URL 无法访问 → 确认 URL 有效
- ❌ 坐标超出画布 → left + width ≤ 1000, top + height ≤ 563
- ❌ 图片遮挡文字 → 调整坐标或用 `ppt_element` 调整层级

---

### 5. `ppt_screenshot` - 生成预览图

**何时使用**：
- ✅ 用户说"看一下效果"
- ✅ 制作完成后展示结果
- ✅ 需要确认某一页的渲染效果

**参数**：
- `slideIndex`（可选）：只截取某一页
- 省略 = 截取所有页并拼接成长图

**返回**：
- Base64 编码的 PNG 图片
- 直接显示给用户

**示例 1：预览所有页**
```json
{}
```
→ 返回拼接的长图

**示例 2：只看第 2 页**
```json
{
  "slideIndex": 1
}
```

**注意**：
- 截图需要 3-10 秒，工具会等待渲染完成
- 如果超时，可能是编辑器未接管，提示用户刷新 `http://127.0.0.1:39311/`

---

### 6. `ppt_element` - 精细操作元素

**何时使用**：
- ✅ 删除某个元素
- ✅ 调整元素位置、大小
- ✅ 修改元素层级（前后关系）

**不常用**，大部分场景用 `ppt_text` 和 `ppt_style` 即可。

**参数**：
- `slideIndex`：页面索引
- `elementId`：元素 ID（从 `ppt_get_deck` 获取）
- `op`：操作类型
  - `"update"`：修改位置/大小
  - `"delete"`：删除元素
  - `"bring-forward"`：上移一层
  - `"send-backward"`：下移一层

---

## 🎨 典型工作流程

### 流程 1：从零制作 PPT

```
1. 用户："做一套介绍人工智能的 PPT，3 页"
   
2. Agent 思考：
   - 需要 3 页：封面、内容页、结束页
   - 封面：标题
   - 内容页：要点列表
   - 结束页：感谢

3. 工具调用序列：
   
   a) ppt_get_deck() 
      → 确认当前是空 deck
   
   b) ppt_text(slideIndex=0, role="title", content="人工智能发展现状")
      → 封面标题
   
   c) ppt_style(op="add", layout="title-content")
      → 添加第 2 页
   
   d) ppt_text(slideIndex=1, role="title", content="核心技术")
   
   e) ppt_text(slideIndex=1, role="body", content="<ul><li>深度学习</li><li>NLP</li><li>CV</li></ul>")
   
   f) ppt_style(op="add", layout="title-only")
      → 添加第 3 页
   
   g) ppt_text(slideIndex=2, role="title", content="谢谢")
   
   h) ppt_screenshot()
      → 生成预览图展示给用户
```

### 流程 2：修改已有 PPT

```
1. 用户："把第 2 页背景改成蓝色"
   
2. Agent 思考：
   - 第 2 页 = slideIndex 1
   - 修改背景用 ppt_style
   
3. 工具调用：
   
   ppt_style(slideIndex=1, background={type:"solid", color:"#0066cc"})
   
4. 确认修改：
   
   ppt_screenshot(slideIndex=1)
```

### 流程 3：添加图片

```
1. 用户："第 2 页右边加一张产品图 https://example.com/product.png"
   
2. Agent 思考：
   - 第 2 页 = slideIndex 1
   - 右边 = left 约 600-650
   - 不要遮挡文字
   
3. 工具调用：
   
   ppt_image(
     slideIndex=1,
     url="https://example.com/product.png",
     left=650,
     top=150,
     width=300,
     height=300
   )
```

---

## ⚠️ 常见错误和解决方案

### 错误 1："编辑器未接管"
**现象**：工具调用返回 `"编辑器未接管：请确认右侧「PPT 工作台」窗口已打开"`

**原因**：浏览器里的编辑器页面未打开或心跳停止

**解决**：告诉用户：
```
浏览器里打开 http://127.0.0.1:39311/
看到"已接管"后再继续
```

### 错误 2：截图超时
**现象**：`ppt_screenshot` 调用超过 30 秒

**原因**：
- 页面太多（>20 页）
- 编辑器卡死
- 图片加载慢

**解决**：
- 分批截图：每次只截 3-5 页
- 或先用 `ppt_get_deck` 确认 deck 状态

### 错误 3：`slideIndex` 越界
**现象**：`"slideIndex 2 超出范围（当前 2 页）"`

**原因**：试图修改不存在的页面

**解决**：
- 先用 `ppt_style(op="add")` 添加页面
- 或用 `ppt_get_deck()` 确认当前页数

### 错误 4：文本覆盖
**现象**：标题和正文重叠

**原因**：同一页多次调用 `ppt_text` 时坐标冲突

**解决**：
- 用不同的 `role`（title、body、subtitle）
- 或用 `role="custom"` 精确控制坐标

---

## 🧠 AI Agent 最佳实践

### 1. 减少冗余调用
❌ **低效**：
```
ppt_get_deck()  // 确认状态
ppt_text(...)   // 修改
ppt_get_deck()  // 再次确认
```

✅ **高效**：
```
ppt_text(...)   // 直接修改（工具会返回成功/失败）
```

### 2. 批量操作
❌ **慢**：
```
ppt_text(slideIndex=0, role="title", ...)
ppt_text(slideIndex=1, role="title", ...)
ppt_text(slideIndex=2, role="title", ...)
ppt_screenshot()  // 截图 3 次
```

✅ **快**：
```
ppt_text(slideIndex=0, role="title", ...)
ppt_text(slideIndex=1, role="title", ...)
ppt_text(slideIndex=2, role="title", ...)
ppt_screenshot()  // 一次截图所有页
```

### 3. 用户反馈循环
制作 PPT 后，主动展示效果：
```
1. 完成所有页面构建
2. ppt_screenshot() 生成预览
3. 告诉用户："这是初稿效果，需要调整吗？"
```

### 4. 错误恢复
工具失败时，给出可操作的建议：
```
如果 ppt_screenshot 超时：
→ "截图生成中，请稍等..."
→ 重试 1 次
→ 仍失败则告知用户："请在浏览器里打开 http://127.0.0.1:39311/ 查看"
```

---

## 📐 坐标参考（1000×563 画布）

```
┌─────────────────────────────────────┐
│  (0,0)                   (1000,0)  │
│                                     │
│         标题区域                    │
│    (100,150) → (900,250)           │
│                                     │
│    ┌────────┐       ┌────────┐    │
│    │  文本  │       │  图片  │    │
│    │ 区域   │       │ 区域   │    │
│    └────────┘       └────────┘    │
│   (100,300)        (600,300)      │
│    400×200          350×250       │
│                                     │
│  (0,563)                 (1000,563)│
└─────────────────────────────────────┘

常用布局：
- 居中标题：left=100, top=200, width=800, height=100
- 左侧正文：left=100, top=300, width=400, height=200
- 右侧图片：left=600, top=300, width=350, height=250
```

---

## 🎯 总结：工具选择决策表

| 用户需求 | 使用工具 | 关键参数 |
|---------|---------|---------|
| 查看当前 PPT | `ppt_get_deck` | - |
| 添加标题 | `ppt_text` | `role="title"` |
| 添加正文 | `ppt_text` | `role="body"` |
| 添加新页 | `ppt_style` | `op="add"` |
| 改背景颜色 | `ppt_style` | `background` |
| 改主题色 | `ppt_style` | `theme` |
| 插入图片 | `ppt_image` | `url`, 坐标 |
| 看效果 | `ppt_screenshot` | - |
| 删除元素 | `ppt_element` | `op="delete"` |

---

**记住**：你的目标是快速、准确地完成用户的 PPT 需求。工具是手段，用户满意是目的。
