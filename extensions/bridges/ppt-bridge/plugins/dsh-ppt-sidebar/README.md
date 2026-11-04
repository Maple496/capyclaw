# PPT 工作台 - 侧边栏插件（历史示例）

> **已废弃**：本示例使用旧的 `workspace/plugins` 拷贝方式，DSH 0.2.x 不会自动扫描该目录。新插件请看 `plugin-development/README.md` 和 `examples/dsh-hello-service/`；生产 PPT 套件在 `bridges/ppt-bridge/plugin/`。

AI 驱动的 PPT 创建工具，支持实时预览和低延迟交互。

## ✨ 功能特性

- 🎨 **AI 生成 PPT** - 通过对话创建演示文稿
- 👁️ **实时预览** - 在侧边栏实时查看 PPT 内容
- ⚡ **低延迟交互** - WebSocket 通信，毫秒级响应
- 🔌 **完全解耦** - 插件独立运行，不依赖 Harness 核心

## 📦 安装

### 方法 1: 复制到插件目录

```bash
cp -r dsh-ppt-sidebar /path/to/deepseek-harness/workspace/plugins/
```

### 方法 2: 打包安装

```bash
# 打包
node pack-plugin.mjs ./my-plugins/dsh-ppt-sidebar

# 用户安装
unzip dsh-ppt-sidebar-v1.0.0.zip -d /path/to/deepseek-harness/workspace/plugins/dsh-ppt-sidebar/
```

## 🚀 使用

1. 启动 DeepSeek Harness
2. 插件自动加载（查看日志确认）
3. 在对话中使用 AI 创建 PPT
4. 在右侧面板实时查看预览

### 示例对话

```
User: 帮我创建一个产品介绍的 PPT，5 页

AI: 好的，我来创建一个产品介绍 PPT...
    [调用 ppt_create 工具]
    ✅ 已创建 PPT "产品介绍"，共 5 页。
    可以在右侧面板实时查看预览。

User: 添加一页关于技术架构的内容

AI: 好的，添加技术架构页...
    [调用 ppt_add_slide 工具]
    ✅ 已添加幻灯片 "技术架构"，当前共 6 页。
```

## 🛠️ MCP 工具

### ppt_create
创建新的 PPT

**参数**：
- `title` (string, 必需) - PPT 标题
- `slides` (number, 可选) - 幻灯片数量，默认 5

### ppt_add_slide
添加幻灯片

**参数**：
- `title` (string, 必需) - 幻灯片标题
- `content` (string, 必需) - 幻灯片内容

### ppt_preview
预览当前 PPT

**参数**: 无

## 🏗️ 架构

```
DeepSeek Harness
├── 主对话区 (AI 交互)
└── 右侧面板 (实时预览)
    └── iframe → http://127.0.0.1:39311

Plugin Server (独立进程)
├── MCP Tools (AI 调用)
├── WebSocket (实时通信)
└── HTTP Server (UI 渲染)
```

## 🔌 通信协议

### MCP (AI → 插件)
```
AI 调用工具 → HTTP POST /mcp → 插件处理 → 返回结果
```

### WebSocket (插件 ↔ UI)
```
插件更新状态 → WebSocket 推送 → UI 实时刷新
UI 用户操作 → WebSocket 发送 → 插件处理
```

## 📝 配置

编辑 `cordis.patch.yml` 修改端口等配置：

```yaml
- insert:
    - id: ppt-sidebar-host
      name: dsh-ppt-sidebar
      config:
        port: 39311  # 修改端口
```

## 🐛 调试

查看插件日志：
```bash
# DeepSeek Harness 日志
tail -f /path/to/deepseek-harness/dsh.log
```

测试 WebSocket 连接：
```javascript
const ws = new WebSocket('ws://127.0.0.1:39311/ws')
ws.onopen = () => console.log('已连接')
ws.onmessage = (e) => console.log('收到:', JSON.parse(e.data))
```

## 📄 许可证

MIT
