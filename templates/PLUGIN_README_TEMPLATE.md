# CapyClaw Launchpad

> 🚀 启动清单管理器 - 用 DSL 描述启动模式，可视化管理服务启动、停止和配置

[![NPM Version](https://img.shields.io/npm/v/@capyclaw/launchpad)](https://www.npmjs.com/package/@capyclaw/launchpad)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Downloads](https://img.shields.io/npm/dm/@capyclaw/launchpad)](https://www.npmjs.com/package/@capyclaw/launchpad)

---

## ✨ 特性

- 🎯 **DSL 配置** - 使用简洁的 DSL 描述复杂的启动模式
- 🖥️ **可视化管理** - 直观的 UI 界面，点击启动/停止服务
- 🔄 **多服务协调** - 管理 broker、DSH 和多个服务的启动顺序
- 📊 **实时监控** - 显示服务运行状态和健康检查
- 🛠️ **编辑器集成** - DSL 编辑器支持语法高亮和验证
- 🔌 **DSH 集成** - 在 DSH 侧边栏提供快速入口

---

## 📦 安装

### 通过 NPM

```bash
npm install -g @capyclaw/launchpad
```

### 通过 DSH 插件系统

```bash
dsh plugin add @capyclaw/launchpad
```

### 手动安装

1. 下载最新的 [Release](https://github.com/capyclaw/dsh-plugins/releases)
2. 解压 `capyclaw-launchpad-v1.0.0.zip`
3. 安装插件：
   ```bash
   dsh plugin add /path/to/capyclaw-launchpad
   ```

---

## 🚀 快速开始

### 1. 创建启动清单

创建 `my-stack.json`：

```json
{
  "name": "my-dev-stack",
  "version": "1.0.0",
  "services": [
    {
      "id": "broker",
      "name": "Service Broker",
      "command": "node broker.mjs",
      "port": 13593,
      "healthCheck": "http://localhost:13593/healthz"
    },
    {
      "id": "dsh",
      "name": "DSH Instance",
      "command": "node dsh.mjs",
      "port": 13594,
      "dependsOn": ["broker"],
      "healthCheck": "http://localhost:13594/healthz"
    }
  ]
}
```

### 2. 启动服务

在 DSH 中打开 Launchpad，导入你的清单，点击"启动"按钮。

### 3. 监控状态

在 Launchpad 界面中查看所有服务的运行状态。

---

## 📖 使用文档

### DSL 语法

#### 基本结构

```json
{
  "name": "stack-name",
  "version": "1.0.0",
  "description": "Stack description",
  "services": [ /* 服务列表 */ ],
  "env": { /* 环境变量 */ }
}
```

#### 服务定义

```json
{
  "id": "service-id",
  "name": "Service Name",
  "command": "node server.mjs",
  "cwd": "/path/to/working/dir",
  "port": 3000,
  "env": {
    "NODE_ENV": "development"
  },
  "dependsOn": ["other-service"],
  "healthCheck": "http://localhost:3000/healthz",
  "retries": 3,
  "timeout": 30000
}
```

#### 字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 服务唯一标识符 |
| `name` | string | ✅ | 服务显示名称 |
| `command` | string | ✅ | 启动命令 |
| `cwd` | string | ❌ | 工作目录（默认当前目录）|
| `port` | number | ❌ | 服务端口 |
| `env` | object | ❌ | 环境变量 |
| `dependsOn` | array | ❌ | 依赖的服务 ID 列表 |
| `healthCheck` | string | ❌ | 健康检查 URL |
| `retries` | number | ❌ | 失败重试次数（默认 3）|
| `timeout` | number | ❌ | 启动超时时间（毫秒，默认 30000）|

### API

#### 加载清单

```javascript
import { loadStack } from '@capyclaw/launchpad'

const stack = await loadStack('./my-stack.json')
```

#### 启动服务

```javascript
await stack.start()
```

#### 停止服务

```javascript
await stack.stop()
```

#### 监听事件

```javascript
stack.on('service:started', (service) => {
  console.log(`${service.name} started`)
})

stack.on('service:failed', (service, error) => {
  console.error(`${service.name} failed:`, error)
})
```

---

## 🎨 界面预览

### 主界面

![Launchpad Main](https://raw.githubusercontent.com/capyclaw/dsh-plugins/main/docs/screenshots/launchpad-main.png)

### 编辑器

![Launchpad Editor](https://raw.githubusercontent.com/capyclaw/dsh-plugins/main/docs/screenshots/launchpad-editor.png)

---

## ⚙️ 配置

### 配置文件位置

- **用户配置**: `~/.dsh/profiles/<profile>/launchpad.config.json`
- **工作区配置**: `./.dsh/launchpad.config.json`

### 配置选项

```json
{
  "autoStart": false,
  "defaultTimeout": 30000,
  "maxRetries": 3,
  "logLevel": "info",
  "theme": "auto"
}
```

---

## 🔧 故障排除

### 服务启动失败

**症状**: 服务无法启动，显示错误信息

**解决方案**:
1. 检查命令是否正确
2. 确认工作目录存在
3. 验证端口未被占用
4. 查看日志：`~/.dsh/logs/launchpad.log`

### 健康检查失败

**症状**: 服务已启动但健康检查失败

**解决方案**:
1. 确认健康检查 URL 正确
2. 增加超时时间
3. 检查服务是否完全启动

### 依赖服务未就绪

**症状**: 依赖服务启动失败导致后续服务无法启动

**解决方案**:
1. 检查 `dependsOn` 配置
2. 确保依赖服务的健康检查配置正确
3. 增加依赖服务的启动超时时间

---

## 🤝 贡献

欢迎贡献！请查看 [CONTRIBUTING.md](../../CONTRIBUTING.md)

### 开发

```bash
# 克隆仓库
git clone https://github.com/capyclaw/dsh-plugins.git
cd dsh-plugins/extensions/official/capyclaw-launchpad

# 安装依赖
npm install

# 运行测试
npm test

# 构建
npm run build
```

---

## 📄 许可证

MIT License - 详见 [LICENSE](./LICENSE)

---

## 🙏 致谢

- [DeepSeek](https://www.deepseek.com/) - 提供 DSH 平台
- [DSH 社区](https://github.com/deepseek-ai/dsh) - 技术支持

---

## 📞 支持

- 🐛 **Bug 报告**: [GitHub Issues](https://github.com/capyclaw/dsh-plugins/issues)
- 💬 **讨论**: [GitHub Discussions](https://github.com/capyclaw/dsh-plugins/discussions)
- 📧 **邮件**: support@capyclaw.dev
- 📖 **文档**: https://capyclaw.dev/docs/launchpad

---

## 🔗 相关链接

- [CapyClaw 主页](https://github.com/capyclaw/dsh-plugins)
- [NPM 包](https://www.npmjs.com/package/@capyclaw/launchpad)
- [更新日志](./CHANGELOG.md)
- [API 文档](https://capyclaw.dev/api/launchpad)

---

**Made with ❤️ by [CapyClaw Team](https://github.com/capyclaw)**
