# 🚀 快速开始指南

## 立即开始使用统一作品格式系统

---

## 📦 安装验证

```bash
cd deepseekharness_dev

# 验证工具可用
node packages/dsh-suite-kit/bin/dsh-works.mjs help
node packages/dsh-suite-kit/bin/dsh-agent.mjs help
node packages/dsh-suite-kit/bin/dsh-deploy.mjs help
```

---

## 🎯 5 分钟快速体验

### 1. 安装一个作品

```bash
# 安装示例配置
node packages/dsh-suite-kit/bin/dsh-works.mjs install \
  packages/dsh-suite-kit/examples/deployment-ppt-basic.works

# 输出：
# 📦 安装作品: deployment-ppt-basic.works
# 🚀 PPT工作台部署配置
# ✅ 安装成功: WORKS-local-xxx
```

### 2. 查看已安装的作品

```bash
node packages/dsh-suite-kit/bin/dsh-works.mjs list

# 输出：
# 📋 已安装的作品
# 共 1 个作品:
#   WORKS-local-xxx
#     标题: PPT工作台部署配置
#     类型: deployment
#     状态: ✓ 已安装
```

### 3. 使用 AI Agent 推荐

```bash
node packages/dsh-suite-kit/bin/dsh-agent.mjs chat "帮我部署PPT"

# 输出：
# 我找到了一个现成的配方：
# 📦 PPT工作台部署配置 ✅ 已安装
# 我可以帮你：
# 2. [查看详情] - dsh-works show WORKS-local-xxx
# 4. [直接部署] - dsh-deploy start WORKS-local-xxx
```

### 4. 使用作品部署

```bash
# 方式 1: 使用 .works 文件
node packages/dsh-suite-kit/bin/dsh-deploy.mjs validate \
  packages/dsh-suite-kit/examples/deployment-ppt-basic.works

# 方式 2: 使用作品引用（当路径正确时）
# node packages/dsh-suite-kit/bin/dsh-deploy.mjs start WORKS-local-xxx
```

### 5. 检查依赖

```bash
# 安装另一个有依赖的作品
node packages/dsh-suite-kit/bin/dsh-works.mjs install \
  packages/dsh-suite-kit/examples/deployment-ppt-dev.works

# 检查依赖树
node packages/dsh-suite-kit/bin/dsh-works.mjs check WORKS-local-xxx

# 输出：
# 依赖树:
# └─ ✓ WORKS-local-xxx - PPT工作台-开发环境
#   └─ ✓ WORKS-local-yyy - PPT工作台部署配置
# ✅ 所有依赖已满足
```

---

## 📝 常用命令速查

### 作品管理 (dsh-works)

```bash
# 安装作品
dsh-works install <file.works>

# 列出所有
dsh-works list

# 查看详情
dsh-works show <WORKS-id>

# 搜索作品
dsh-works search "关键词"

# 检查依赖
dsh-works check <WORKS-id>

# 卸载作品
dsh-works uninstall <WORKS-id>
```

### AI 助手 (dsh-agent)

```bash
# 推荐配方
dsh-agent recommend "PPT部署"

# 对话交互
dsh-agent chat "帮我部署XXX"

# 检查任务
dsh-agent check-task task.json
```

### 部署工具 (dsh-deploy)

```bash
# 验证配置
dsh-deploy validate <config.works|.json>

# 启动部署
dsh-deploy start <config.works|.json>

# 查看状态
dsh-deploy status <config>

# 列出所有部署
dsh-deploy list

# 停止部署
dsh-deploy stop <config>
```

---

## 🎨 创建你自己的作品

### 1. 创建 .works 文件

```bash
cat > my-deployment.works << 'EOF'
%%%WORKS-META%%%
{
  "name": "我的部署配置",
  "brief": "自定义的部署配置",
  "tags": "部署,自定义",
  "emoji": "🎯",
  "view": { "kind": "deployment" },
  "capabilities": ["deployment.dsh"],
  "schema_version": "1.0.0"
}

%%%WORKS-CODE%%%
{
  "deployment": {
    "type": "domain",
    "source": "./path/to/your/domain"
  },
  "runtime": {
    "driver": "node",
    "ports": {
      "harness": 3090,
      "content": 39400
    }
  }
}
EOF
```

### 2. 验证格式

```bash
node packages/dsh-suite-kit/lib/works-parser.mjs validate my-deployment.works
```

### 3. 安装和使用

```bash
dsh-works install my-deployment.works
dsh-works list
```

---

## 🔧 配置别名（可选）

添加到你的 `~/.bashrc` 或 `~/.zshrc`：

```bash
# DSH Works 别名
alias dw='node packages/dsh-suite-kit/bin/dsh-works.mjs'
alias da='node packages/dsh-suite-kit/bin/dsh-agent.mjs'
alias dd='node packages/dsh-suite-kit/bin/dsh-deploy.mjs'

# 然后就可以：
# dw list
# da chat "帮我部署PPT"
# dd start config.works
```

---

## 📚 下一步

1. **浏览文档**
   - [完整实施报告](./FINAL_IMPLEMENTATION_REPORT.md)
   - [系统设计文档](./UNIFIED_WORKS_FORMAT_DESIGN.md)
   - [部署系统文档](./packages/dsh-suite-kit/DEPLOYMENT.md)

2. **尝试高级功能**
   - 创建带依赖的作品
   - 使用 AI Agent 推荐
   - 部署到生产环境

3. **集成到服务器**
   - 部署 Python 适配器
   - 创建 API 端点
   - 前端界面集成

---

## 🆘 故障排查

### 问题 1: 命令找不到

```bash
# 确保在项目根目录
cd deepseekharness_dev

# 使用完整路径
node packages/dsh-suite-kit/bin/dsh-works.mjs help
```

### 问题 2: 作品安装失败

```bash
# 检查文件格式
node packages/dsh-suite-kit/lib/works-parser.mjs validate <file.works>

# 查看错误信息
```

### 问题 3: 依赖检查失败

```bash
# 查看依赖树
dsh-works check <WORKS-id>

# 手动安装缺失的依赖
```

---

## 🎉 开始探索！

你现在拥有一个完整的统一作品格式系统：

- ✅ 与服务器格式兼容
- ✅ 智能依赖管理
- ✅ AI 驱动的推荐
- ✅ 本地作品库
- ✅ 一键部署

**Happy Coding! 🚀**
