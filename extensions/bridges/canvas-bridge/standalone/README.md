# Canvas 独立插件使用指南

## 快速开始

### 1. 启动服务器

```bash
cd canvas-bridge
node standalone/server.mjs --http 39313
```

或 stdio 模式（DSH 默认）：
```bash
node standalone/server.mjs
```

### 2. DSH 配置

在 DSH 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "canvas": {
      "command": "node",
      "args": [
        "/path/to/canvas-bridge/standalone/server.mjs"
      ]
    }
  }
}
```

### 3. 使用示例

**生成文档：**
```python
# 在 DSH Agent 中调用
canvas_write_document(blocks=[
  {"type": "heading", "level": 1, "text": "项目报告"},
  {"type": "paragraph", "text": "这是一份自动生成的文档。"},
  {"type": "heading", "level": 2, "text": "数据汇总"},
])
```

**插入表格：**
```python
canvas_insert_table(
  headers=["指标", "数值", "同比"],
  rows=[
    ["营收", "1000万", "+20%"],
    ["成本", "600万", "+15%"],
  ]
)
```

**保存文档：**
```python
canvas_save(file="report-2024")
# 保存到 .canvas-docs/report-2024.canvas.json
```

**导出 PDF：**
```python
canvas_export(file="report-2024", format="pdf")
# 生成 report-2024.pdf
```

**打开已有文档继续编辑：**
```python
canvas_open(file="report-2024")
canvas_append_blocks(blocks=[
  {"type": "paragraph", "text": "追加内容"},
])
canvas_save(file="report-2024")
```

---

## 工具列表

### 文档操作

| 工具 | 用途 | 参数 |
|------|------|------|
| `canvas_write_document` | 整篇生成 | `blocks`, `title?` |
| `canvas_append_blocks` | 追加内容 | `blocks` |
| `canvas_read` | 读取内容 | `mode: text\|summary\|doc` |
| `canvas_clear` | 清空文档 | 无 |

### 元素插入

| 工具 | 用途 | 参数 |
|------|------|------|
| `canvas_insert_table` | 插入表格 | `headers`, `rows` |
| `canvas_insert_image` | 插入图片 | `src`, `width?`, `height?` |

### 编辑操作

| 工具 | 用途 | 参数 |
|------|------|------|
| `canvas_replace_text` | 全文替换 | `find`, `replace` |
| `canvas_history` | 撤销/重做 | `action: undo\|redo` |
| `canvas_page_setup` | 页面设置 | `size?`, `direction?`, `margins?` |

### 文件操作

| 工具 | 用途 | 参数 |
|------|------|------|
| `canvas_save` | 保存文档 | `file`, `workspace?` |
| `canvas_open` | 打开文档 | `file`, `workspace?` |
| `canvas_list` | 列出文档 | `workspace?` |
| `canvas_export` | 导出文档 | `file`, `format: html\|pdf` |

### 其他

| 工具 | 用途 | 参数 |
|------|------|------|
| `canvas_screenshot` | 截图 | 无 |
| `canvas_status` | 查看状态 | 无 |

---

## Block 类型

### 标题
```json
{"type": "heading", "level": 1, "text": "一级标题"}
{"type": "heading", "level": 2, "text": "二级标题"}
```

### 段落
```json
{"type": "paragraph", "text": "正文内容"}
```

### 列表
```json
{"type": "bullet", "text": "无序列表项"}
{"type": "number", "index": 1, "text": "有序列表项"}
```

### 引用
```json
{"type": "quote", "text": "引用内容"}
```

### 分割线
```json
{"type": "divider"}
```

---

## 配置选项

### 工作目录

默认：`./.canvas-docs`

自定义：
```bash
export CANVAS_WORKSPACE=/path/to/docs
node standalone/server.mjs
```

或在工具调用时指定：
```python
canvas_save(file="doc", workspace="/custom/path")
```

### 页面设置

```python
canvas_page_setup(
  size="A4",           # A3, A4, A5, B4, B5
  direction="vertical", # vertical, horizontal
  mode="paging",       # paging, continuous
  margins=[80, 90, 80, 90]  # [上, 右, 下, 左] 单位 pt
)
```

---

## 性能与资源

- **启动时间**：首次 ~2s（拉起浏览器），后续 ~50ms
- **内存占用**：Headless Chromium ~150MB
- **磁盘占用**：Chromium ~50MB（已安装）
- **并发支持**：单实例单文档，多文档需多实例

---

## 故障排除

### 1. Chromium 未安装

```bash
cd canvas-bridge
npx playwright install chromium
```

### 2. 端口冲突

```bash
# 更换端口
node standalone/server.mjs --http 39315
```

### 3. 文档损坏

```bash
# 删除损坏文件
rm .canvas-docs/broken.canvas.json
```

### 4. 内存不足

```bash
# 关闭服务器自动释放
# 或减少文档复杂度
```

---

## 与桌面版对比

| 特性 | 独立插件 | 桌面版 |
|------|---------|--------|
| 依赖 | Chromium | 桌面前后端 + 浏览器 |
| 启动 | 2s | 10s+ |
| 内存 | 150MB | 500MB+ |
| 可视化编辑 | ❌ | ✅ |
| 批量生成 | ✅ | ✅ |
| 文件持久化 | ✅ | 需手动保存 |
| PDF 导出 | ✅ | ❌（需手动） |

---

## 开发计划

- [ ] 多文档并发
- [ ] 样式模板
- [ ] 图片本地缓存
- [ ] 增量保存
- [ ] 协作编辑
