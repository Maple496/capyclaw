# 发布到 npm 与全球部署指南

## 前置条件

```bash
# 1. 注册 npm 账号（一次性）
npm adduser

# 2. 确认组织（@capyclaw）已创建
# 访问: https://www.npmjs.com/org/create
```

## 发布流程（一次性）

### 第一步：发布所有插件到 npm

```bash
# 回到插件仓库根目录
cd <repo>

# 确保所有测试通过
npm run verify-all

# 发布可发布的插件（registry 里的 6 个）
npm run publish-all
```

**或手动逐个发布**：

```bash
cd extensions/official/capyclaw-launchpad
npm publish --access public

cd ../capyclaw-plugin-sync
npm publish --access public

cd ../capyclaw-port-sidebar
npm publish --access public

cd ../capyclaw-llm-tempkey
npm publish --access public

cd ../capyclaw-scrapling
npm publish --access public

cd ../../bridges/ppt-bridge/plugin/capyclaw-ppt-suite
npm publish --access public
```

### 第二步：上传部署脚本到公开位置

```bash
# 选项 A：上传到 GitHub Release
# 1. 创建 GitHub repo: capyclaw/dsh-plugins
# 2. 上传 tools/bootstrap.mjs 和 tools/deploy-windows.bat

# 选项 B：上传到 CDN
# 复制 tools/bootstrap.mjs 到你的 CDN
# 例如: https://cdn.example.com/capyclaw/bootstrap.mjs

# 选项 C：上传到 npm（推荐）
# 创建一个特殊包: @capyclaw/installer
cd tools
cat > package.json << 'EOF'
{
  "name": "@capyclaw/installer",
  "version": "1.0.0",
  "description": "Capyclaw plugins installer for DSH",
  "bin": {
    "capyclaw-install": "./bootstrap.mjs"
  },
  "keywords": ["dsh", "deepseek", "plugins"],
  "license": "MIT"
}
EOF
npm publish --access public

# 用户可以直接运行:
# npx @capyclaw/installer
```

### 第三步：更新 deploy-windows.bat 的下载地址

编辑 `tools/deploy-windows.bat`，修改：

```batch
set SCRIPT_URL=https://raw.githubusercontent.com/capyclaw/dsh-plugins/main/tools/bootstrap.mjs
```

改为你的实际地址。

---

## 用户安装（发布后）

### 方式 1：一键批处理（最简单，推荐给普通用户）

```bash
# 1. 下载批处理文件
# 访问: https://github.com/capyclaw/dsh-plugins/releases
# 或: https://cdn.example.com/capyclaw/deploy-windows.bat

# 2. 双击 deploy-windows.bat
# 自动完成：检查 Node.js → 安装 pnpm → 安装 dsh → 安装插件 → 启动
```

### 方式 2：Node.js 脚本（灵活，推荐给开发者）

```bash
# 从 npm 运行（推荐）
npx @capyclaw/installer

# 或下载后运行
curl -O https://cdn.example.com/capyclaw/bootstrap.mjs
node bootstrap.mjs

# 自定义插件列表
node bootstrap.mjs --plugins @capyclaw/launchpad,@capyclaw/ppt-suite
```

### 方式 3：手动安装（完全掌控）

```bash
# 1. 安装 dsh
npm install -g @deepseek-ai/dsh

# 2. 使用 dsh 原生命令安装插件
dsh plugin --profile web add @capyclaw/launchpad
dsh plugin --profile web add @capyclaw/plugin-sync
dsh plugin --profile web add @capyclaw/port-sidebar

# 3. 启动
dsh --profile web
```

---

## 验证安装

用户安装完成后，可以验证：

```bash
# 1. 检查 dsh 版本
dsh --version

# 2. 检查插件是否已安装
cd ~/.dsh/profiles/web
cat package.json

# 应该看到:
# {
#   "dependencies": {
#     "@capyclaw/launchpad": "^1.1.0",
#     "@capyclaw/plugin-sync": "^0.1.0"
#   }
# }

# 3. 启动 dsh
dsh --profile web

# 4. 访问浏览器（自动打开）
# 应该能看到 launchpad 面板
```

---

## 更新插件

用户已安装，想更新到最新版本：

```bash
cd ~/.dsh/profiles/web
pnpm update @capyclaw/launchpad
pnpm update @capyclaw/plugin-sync

# 或全部更新
pnpm update
```

---

## 发布新版本（日常维护）

```bash
# 1. 修改代码
cd extensions/official/capyclaw-launchpad

# 2. 更新版本号
npm version patch  # 或 minor / major

# 3. 测试
npm test

# 4. 发布
npm publish

# 5. 更新 registry
cd ../../..
npm run gen-registry
# 上传新的 capyclaw-registry.json 到 CDN
```

---

## 常见问题

### Q: 用户机器没有 Node.js 怎么办？

**方案 A**：批处理检测并提示安装
```batch
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo 未检测到 Node.js，正在打开安装页面...
    start https://nodejs.org/
    pause
)
```

**方案 B**：打包成独立可执行文件
```bash
# 使用 pkg 将 Node.js + 脚本打包成 .exe
npm install -g pkg
pkg bootstrap.mjs --targets node18-win-x64 --output capyclaw-installer.exe

# 用户只需下载 .exe，无需 Node.js
```

### Q: 企业内网无法访问 npm 怎么办？

**搭建私有 npm registry**：

```bash
# 1. 安装 Verdaccio
npm install -g verdaccio

# 2. 启动私有 registry
verdaccio

# 3. 发布到私有 registry
npm publish --registry http://your-company-registry:4873

# 4. 用户安装时指定 registry
npm config set registry http://your-company-registry:4873
npx @capyclaw/installer
```

### Q: 如何支持离线安装？

**打包离线安装包**：

```bash
# 1. 创建离线包目录
mkdir capyclaw-offline
cd capyclaw-offline

# 2. 下载所有插件
pnpm pack @capyclaw/launchpad
pnpm pack @capyclaw/plugin-sync
pnpm pack @capyclaw/port-sidebar

# 3. 打包部署脚本
cp ../tools/bootstrap.mjs .
cp ../tools/deploy-windows.bat .

# 4. 修改 bootstrap.mjs，从本地 .tgz 安装
# dependencies: { "@capyclaw/launchpad": "file:./capyclaw-launchpad-1.1.0.tgz" }

# 5. 压缩整个目录
# 用户解压后双击 deploy-windows.bat 即可
```

---

## 部署清单

### 需要上传到公开位置的文件

- [ ] `tools/bootstrap.mjs` → GitHub Release / CDN / npm
- [ ] `tools/deploy-windows.bat` → GitHub Release / CDN
- [ ] `capyclaw-registry.json` → CDN（可选，用于自定义安装）
- [ ] `README.md` → GitHub / 文档站点

### npm 包列表（需发布）

- [ ] `@capyclaw/launchpad`
- [ ] `@capyclaw/plugin-sync`
- [ ] `@capyclaw/port-sidebar`
- [ ] `@capyclaw/llm-tempkey`
- [ ] `@capyclaw/scrapling`
- [ ] `@capyclaw/ppt-suite`
- [ ] `@capyclaw/installer`（可选，封装 bootstrap.mjs）

### 宣传材料

- [ ] 一句话介绍："一键为 DeepSeek Harness 安装 Capyclaw 插件套件"
- [ ] 安装视频/GIF（双击 deploy-windows.bat → 自动部署 → 启动界面）
- [ ] 文档站点（GitHub Pages / Read the Docs）

---

## 自动化发布（未来）

```yaml
# .github/workflows/publish.yml
name: Publish to npm

on:
  push:
    tags:
      - 'v*'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
          registry-url: 'https://registry.npmjs.org'
      
      - run: npm ci
      - run: npm run verify-all
      
      - name: Publish packages
        run: |
          cd extensions/official/capyclaw-launchpad && npm publish --access public
          cd ../capyclaw-plugin-sync && npm publish --access public
          # ... 其他插件
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      
      - name: Upload release assets
        uses: actions/upload-release-asset@v1
        with:
          upload_url: ${{ github.event.release.upload_url }}
          asset_path: ./tools/deploy-windows.bat
          asset_name: deploy-windows.bat
```

---

## 最终用户体验

**从零到运行，只需 3 步**：

1. 下载 `deploy-windows.bat`（或运行 `npx @capyclaw/installer`）
2. 双击执行
3. 自动完成：Node.js 检测 → dsh 安装 → 插件安装 → 浏览器打开

**总耗时**：约 3-5 分钟（取决于网络速度）

**无需用户手动操作**：
- ❌ 不需要配置环境变量
- ❌ 不需要编辑配置文件
- ❌ 不需要运行多条命令
- ❌ 不需要了解 dsh 内部机制

**完全卸载**：
```bash
# 删除 dsh
npm uninstall -g @deepseek-ai/dsh

# 删除配置（可选）
rm -rf ~/.dsh
```
