# 插件分发与安装机制

## 设计原则

**完全适配 dsh 原生机制**，即使 dsh 更新也不会破坏：

- 不修改 dsh 核心代码
- 不自己实现包管理
- 直接操作 `~/.dsh/profiles/<name>/package.json`（dsh 的标准格式）
- 交给 dsh 原生的 pnpm 处理依赖

## 两种模式

| 模式 | 适用场景 | dependencies 格式 | 安装方式 |
|---|---|---|---|
| **development** | 开发阶段 | `"link:/path/to/dist"` | 符号链接本地目录 |
| **production** | 发布到 npm 后 | `"^1.0.0"` | pnpm 从 registry 下载 |

## 快速开始

### 开发阶段（本地 link）

```bash
# 1. 生成 registry（已自动化，在 npm run gen-registry 里）
npm run gen-registry

# 2. 安装插件到 profile
node tools/install-plugins.mjs \
  --registry ./capyclaw-registry.json \
  --target ~/.dsh/profiles/web \
  --mode development \
  --install

# 3. 启动 dsh
dsh --profile web
```

### 生产阶段（npm registry）

```bash
# 1. 发布插件到 npm（一次性，每个插件独立发布）
cd extensions/official/capyclaw-launchpad
npm publish --access public

# 2. 更新远程 registry（CDN 或服务器上）
# registry.json 的 tarball 字段指向 npm
curl -O https://your-cdn.com/capyclaw-registry.json

# 3. 用户安装（在目标机器上）
node tools/install-plugins.mjs \
  --registry https://your-cdn.com/capyclaw-registry.json \
  --target ~/.dsh/profiles/web \
  --mode production \
  --install

# 4. 启动 dsh
dsh --profile web
```

## Registry 格式

```json
{
  "version": 1,
  "plugins": [
    {
      "name": "@capyclaw/launchpad",
      "version": "1.1.0",
      "description": "工作区快速访问面板",
      "path": "./extensions/official/capyclaw-launchpad",
      "tarball": "https://registry.npmjs.org/@capyclaw/launchpad/-/launchpad-1.1.0.tgz",
      "category": "tool",
      "platform": "both"
    }
  ]
}
```

**关键字段**：
- `path`：开发模式用（相对仓库根目录）
- `tarball`：生产模式用（npm 下载地址，实际上 pnpm 会自动从 registry 解析，不需要显式用）
- `version`：semver 版本号

## 生成的 package.json（dsh 原生格式）

### 开发模式
```json
{
  "dependencies": {
    "@capyclaw/launchpad": "link:/path/to/dev/extensions/official/capyclaw-launchpad"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@capyclaw/launchpad"]
    }
  }
}
```

### 生产模式
```json
{
  "dependencies": {
    "@capyclaw/launchpad": "^1.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@capyclaw/launchpad"]
    }
  }
}
```

执行 `pnpm install` 后：
- 开发模式：`node_modules/@capyclaw/launchpad` → 符号链接
- 生产模式：`node_modules/@capyclaw/launchpad` → 从 npm 下载的真实包

## 与 dsh 原生命令的对比

| 操作 | dsh 原生命令 | 我们的工具 | 优势 |
|---|---|---|---|
| 安装单个插件 | `dsh plugin --profile web add @capyclaw/launchpad` | `install-plugins.mjs` | 批量安装、支持本地 link |
| 查看已安装 | `cat ~/.dsh/profiles/web/package.json` | 同左 | 无差异 |
| 移除插件 | `dsh plugin --profile web remove <pkg>` | 手动编辑 package.json | dsh 原生更方便 |
| 更新插件 | `cd ~/.dsh/profiles/web && pnpm update` | 同左 | 无差异 |

**我们的工具不是替代 dsh**，而是**补充批量安装与开发模式**的能力。

## 稳定性保证

### 为什么不会因 dsh 更新而破坏？

1. **只操作标准文件**：
   - `~/.dsh/profiles/<name>/package.json`（npm 标准格式）
   - `dependencies` / `dsh.profile.bundles` 是 dsh 的公开 API

2. **不依赖 dsh 内部实现**：
   - 不修改 dsh 二进制
   - 不 hook dsh 的启动流程
   - 不假设 dsh 内部目录结构

3. **交给 dsh 原生机制**：
   - 依赖安装 → pnpm（dsh 自己调用）
   - 插件加载 → dsh 的 bundle loader
   - 配置管理 → dsh 的 profile 系统

### 万一 dsh 改了 package.json 格式怎么办？

**极小概率**，因为 `package.json` 是 npm 生态标准。但如果真改了：

```bash
# 方案 A：适配新格式（改 install-plugins.mjs 的 updateProfilePackage 函数）
# 方案 B：降级到 dsh 原生命令
dsh plugin --profile web add @capyclaw/launchpad
dsh plugin --profile web add @capyclaw/ppt-suite
```

## 实际部署流程（生产环境）

```bash
# ===== CI/CD Pipeline =====

# 1. 构建插件（已在 npm run build 里）
npm run build

# 2. 发布到 npm（一次性，手动触发）
npm publish extensions/official/capyclaw-launchpad --access public
npm publish extensions/official/capyclaw-plugin-sync --access public
# ... 其他插件

# 3. 更新 registry（自动化）
npm run gen-registry
# 上传 capyclaw-registry.json 到 CDN

# ===== 用户机器 =====

# 4. 下载安装脚本
curl -O https://your-cdn.com/install-plugins.mjs

# 5. 安装插件
node install-plugins.mjs \
  --registry https://your-cdn.com/capyclaw-registry.json \
  --target ~/.dsh/profiles/web \
  --mode production \
  --install

# 6. 启动 dsh
dsh --profile web
```

## 插件安装器与启动入口

| 工具 | 用途 | 何时用 |
|---|---|---|
| `tools/install-plugins.mjs` | **修改 profile**，注册插件到 `~/.dsh` | 第一次安装、更新插件 |
| `launchpads/*.stack` DSL → `dshd --stack` | **统一启动面**（临时/正式同一入口） | 开发调试、日常运行 |

> 旧的临时启动器（`tools/launch.mjs`、`tools/launch-by-manifest.mjs`、
> `tools/dsh-launcher/dshd.config.json` + `local-services.json` 配置路径、
> `simple/unified/web-launcher.mjs` 备用前端）已删除，统一走 stack DSL。

**典型工作流**：

```bash
# 确认无误后：用 install-plugins.mjs 正式安装到 ~/.dsh
node tools/install-plugins.mjs \
  --registry capyclaw-registry.json \
  --target ~/.dsh/profiles/web \
  --mode development \
  --install

# 日常使用：stack DSL（launchpad 管理界面点击启动，或命令行）
node tools/dsh-launcher/bin/dshd.mjs start --stack launchpads/dev.dsh-stack.json
```

## 常见问题

### Q: 为什么不用 dsh 自己的 `plugin add` 命令？

A: `dsh plugin add` 只能从 npm 安装，不支持：
- 批量安装多个插件
- 本地 link 开发中的插件
- 从自定义 registry 安装

### Q: 生产环境必须发布到公开 npm 吗？

A: 不是，三种选择：
1. **公开 npm**：`npm publish --access public`
2. **私有 npm**：企业内部 npm registry（Verdaccio / npm Enterprise）
3. **文件服务器**：修改 `install-plugins.mjs`，支持从 tarball URL 下载解压

### Q: 插件更新了怎么办？

A: 
```bash
# 开发模式：无需操作（link 自动同步）
# 生产模式：
cd ~/.dsh/profiles/web
pnpm update @capyclaw/launchpad
```

### Q: 能否卸载插件？

A:
```bash
# 方法 1：dsh 原生
dsh plugin --profile web remove @capyclaw/launchpad

# 方法 2：手动
# 编辑 ~/.dsh/profiles/web/package.json
# 删除 dependencies 和 bundles 里的对应项
# 运行 pnpm install
```

## 下一步

- [ ] 支持从 tarball URL 直接安装（不依赖 npm）
- [x] 插件依赖自动解析（ppt-suite 的 dependencies 声明全部 16 个依赖包；2026-11-05 起
      全部发布到 npm，`@capyclaw/ppt-suite` 安装即自动带齐 workbench + 8 skill + 基建；
      registry 也已收录全部可安装插件：22 个）
- [ ] 版本冲突检测
- [ ] 回滚到上一个版本
