# PPT 编辑器插件（历史示例）

> **已废弃**：本示例仅为旧版 Cordis/React 侧边栏探索，未完成也未接入当前 Harness。新插件请看 `plugin-development/README.md` 和 `examples/dsh-hello-service/`；生产 PPT 套件在 `bridges/ppt-bridge/plugin/`。

AI 驱动的 PPT 创建和编辑工具，完全集成到 DeepSeek Harness。

## ✨ 功能特性

### 🛠️ MCP 工具

- **ppt_create** - 创建新的 PPT 演示文稿
- **ppt_add_slide** - 添加幻灯片
- **ppt_edit_slide** - 编辑指定幻灯片
- **ppt_delete_slide** - 删除幻灯片
- **ppt_preview** - 预览当前 PPT

### 📊 侧边栏预览

- 实时显示 PPT 内容
- 幻灯片卡片视图
- 当前页高亮显示
- 响应式设计

### 🎨 模板支持

- professional - 专业商务
- creative - 创意设计
- minimal - 简约风格
- tech - 科技风

## 📦 安装

### 方式 1: 手动安装

```bash
# 复制插件到 Harness
cp -r dsh-ppt-editor /path/to/deepseek-harness/workspace/plugins/

# 重启 Harness
cd /path/to/deepseek-harness
node auth-proxy.mjs
```

### 方式 2: 使用打包启动器

```bash
# 下载预打包版本
# 解压后双击 start.bat 即可
```

## 🚀 使用方法

### 创建 PPT

```
User: 创建一个产品介绍的 PPT，5 页，使用专业模板

AI: 好的，我来创建...
    [调用 ppt_create 工具]
    ✅ 已创建 PPT "产品介绍"，共 5 页
    可以在右侧面板实时查看预览
```

### 添加幻灯片

```
User: 添加一页关于技术架构的内容

AI: [调用 ppt_add_slide 工具]
    ✅ 已添加幻灯片 "技术架构"
    当前共 6 页
```

### 编辑幻灯片

```
User: 把第 3 页的标题改成"市场分析"

AI: [调用 ppt_edit_slide 工具]
    ✅ 已更新第 3 页幻灯片
```

### 删除幻灯片

```
User: 删除第 5 页

AI: [调用 ppt_delete_slide 工具]
    ✅ 已删除第 5 页幻灯片
    剩余 5 页
```

## 🏗️ 架构设计

```
DeepSeek Harness 进程
├── 主对话区 (AI 交互)
│   └── 调用 MCP 工具
│
├── PPT 编辑器插件 (lib/index.mjs)
│   ├── 状态管理 (ctx.pptEditor.state)
│   ├── MCP 工具注册
│   ├── 事件监听
│   └── 侧边栏注册
│
└── 右侧面板 (侧边栏)
    └── PPT 预览 UI (ui/index.js)
        ├── 实时更新
        └── 幻灯片卡片
```

### 关键特点

✅ **运行在 Harness 进程内** - 不启动独立服务器  
✅ **通过 Cordis 事件通信** - 不需要 HTTP/WebSocket  
✅ **状态存储在 Context** - `ctx.pptEditor.state`  
✅ **集成侧边栏** - 使用 Harness 的 sidebar API  
✅ **零外部依赖** - 纯 JavaScript  

## 📋 配置选项

在 `cordis.patch.yml` 中配置：

```yaml
- insert:
    - id: ppt-editor-host
      name: dsh-ppt-editor
      config:
        autoOpenSidebar: true      # 创建 PPT 时自动打开侧边栏
        defaultTemplate: professional  # 默认模板
        maxSlides: 50              # 最大幻灯片数
```

## 🔧 开发

### 目录结构

```
dsh-ppt-editor/
├── package.json          # 插件元数据
├── cordis.patch.yml      # Cordis 配置
├── lib/
│   └── index.mjs        # 插件主逻辑
├── ui/
│   └── index.js         # 侧边栏 UI
└── README.md            # 本文档
```

### 状态结构

```javascript
{
  presentations: [        // 所有 PPT
    {
      id: 'ppt-xxx',
      title: '产品介绍',
      template: 'professional',
      slides: [...]
    }
  ],
  currentPresentationId: 'ppt-xxx',  // 当前 PPT
  slides: [               // 当前幻灯片
    {
      id: 'slide-xxx',
      index: 0,
      title: '封面',
      content: '...',
      layout: 'title'
    }
  ],
  currentSlideIndex: 0    // 当前页
}
```

### 事件

```javascript
// 状态更新事件
ctx.emit('ppt-editor:state-changed', state)

// 监听事件
ctx.on('ppt-editor:state-changed', (state) => {
  // 更新 UI
})
```

## 🐛 调试

查看插件日志：

```bash
# Harness 日志
tail -f /path/to/deepseek-harness/dsh.log | grep ppt-editor
```

测试工具调用：

```javascript
// 在 Harness 控制台
ctx.pptEditor.getState()
```

## 📄 许可证

MIT

## 🤝 贡献

欢迎提交 Issue 和 PR！

---

**版本**: 1.0.0  
**作者**: ZCode AI Assistant  
**更新**: 2026-10-29
