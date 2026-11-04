# 贡献指南

欢迎为 DeepSeek Harness 做出贡献！

---

## 开始之前

1. 阅读 [README.md](README.md) 了解项目概况
2. 阅读 [ARCHITECTURE.md](ARCHITECTURE.md) 了解架构设计
3. 阅读 [QUICKSTART.md](QUICKSTART.md) 搭建开发环境

---

## 代码组织规范

### 目录职责

**遵循目录职责，不跨层放置代码**：

- `apps/` - 可执行应用
- `packages/` - 可复用库
- `extensions/` - 可插拔扩展
- `tools/` - 开发工具
- `docs/` - 文档
- `examples/` - 示例代码
- `research/` - 实验代码（稳定后迁移）

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
import { stagePlugin } from 'dsh-plugin-kit/packaging/pack'

// ❌ 错误：直接引用内部路径
import { stagePlugin } from '../../packages/dsh-plugin-kit/src/pack.mjs'
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
# 运行相关测试
npm run test-all

# 验证代码标准
npm run verify-all

# 构建产品（如有需要）
npm run build-product
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
产品 → 应用 → 扩展 → 核心库 → 第三方
```

**不允许**：
- 核心库依赖扩展
- 扩展依赖应用
- 下层依赖上层

### 实验代码

**放在 `research/` 目录**，稳定后再迁移：

```bash
# 实验阶段
research/my-experiment/

# 稳定后迁移
extensions/my-feature/  # 或
packages/my-lib/
```

---

## 获取帮助

- 查看文档：[docs/](docs/)
- 查看示例：[examples/](examples/)
- 提出 Issue：[GitHub Issues](#)

---

**感谢你的贡献！** 🎉
