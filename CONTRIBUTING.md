# 贡献指南

欢迎为 DeepSeek Harness 做出贡献！

---

## 开始之前

1. 阅读 [README.md](README.md) 了解项目概况
2. 阅读 [ARCHITECTURE.md](ARCHITECTURE.md) 了解架构设计

---

## 代码组织规范

### 目录职责

**遵循目录职责，不跨层放置代码**：

- `packages/` - 构建库与基建插件
- `extensions/` - 插件本体
- `tools/` - 插件工具链
- `scripts/` - 流水线脚本
- `docs/` - 文档

### 新增目录

**每个新目录必须包含 README.md**，说明：
- 目录职责
- 包含内容
- 使用方式
- 注意事项

### 依赖管理

**跨模块引用通过声明的 API**：

```javascript
// ✅ 正确：通过 package.json exports
import { stagePlugin } from '@capyclaw/plugin-kit/packaging/pack'

// ❌ 错误：直接引用内部路径
import { stagePlugin } from '../../packages/capyclaw-plugin-kit/src/pack.mjs'
```

---

## 开发流程

### 1. 创建分支

```bash
git checkout -b feature/my-feature
# 或
git checkout -b fix/bug-description
```

### 2. 开发和测试

```bash
# 校验插件结构
npm run validate-all

# 构建插件包（PPT 线）
npm run build:plugin

# 打包产物
npm run release-all
```

### 3. 提交代码

**提交规范**：

```
类型(scope): 简短描述

详细描述（可选）

Closes #issue_number
```

**类型**：
- `feat`: 新功能
- `fix`: 修复bug
- `docs`: 文档更新
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具相关

**示例**：
```
feat(plugin-kit): 添加打包验证功能

- 添加 manifest 语义校验
- 添加文件完整性检查
- 更新相关测试

Closes #123
```

### 4. 推送和PR

```bash
git push origin feature/my-feature
```

然后在 GitHub 创建 Pull Request。

---

## 代码规范

### JavaScript/Node.js

- 使用 ES modules (`.mjs`)
- 使用 `import`/`export`
- 函数和变量使用驼峰命名
- 常量使用大写下划线

### 文档

- 使用 Markdown 格式
- 一级标题使用 `#`
- 代码块指定语言
- 链接使用相对路径

### 测试

- 测试文件命名：`*.test.mjs`
- 使用 Node.js test runner
- 覆盖关键功能路径

---

## 插件开发

### 创建新插件

```bash
npm run create-plugin -- --name dsh-my-plugin
```

详见 [插件开发指南](docs/guides/plugin-development.md)

### 插件结构

```
dsh-my-plugin/
├── package.json
├── README.md
├── server.mjs
├── lib/
└── test/
```

### 插件验证

```bash
npm run validate-plugin -- path/to/plugin
```

---

## 提交检查清单

- [ ] 代码遵循项目规范
- [ ] 添加了必要的测试
- [ ] 测试全部通过
- [ ] 更新了相关文档
- [ ] 提交信息清晰准确
- [ ] 没有提交构建产物（`out/`）
- [ ] 没有提交用户数据
- [ ] 没有提交 `node_modules/`

---

## 注意事项

### 不要提交

- ❌ `out/` - 构建产物
- ❌ `node_modules/` - 依赖
- ❌ `.dshd/` - 运行时状态
- ❌ 用户数据
- ❌ 临时文件

### 保持依赖方向

```
extensions/ → packages/ → 第三方
tools/      → packages/ + extensions/
scripts/    → packages/ + tools/
```

**不允许**：
- `packages/` 依赖 `extensions/`
- 工具链之外的代码模仿 `tools/` 的深层相对路径引用

### 实验代码

实验性代码不进本仓库；请放在仓库之外独立验证，稳定后再作为插件或构建库引入。

---

## 获取帮助

- 查看文档：[docs/](docs/)
- 发布流程：[docs/PUBLISHING.md](docs/PUBLISHING.md)
- 提出 Issue：[GitHub Issues](#)

---

**感谢你的贡献！** 🎉
