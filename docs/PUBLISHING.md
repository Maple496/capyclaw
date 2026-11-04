# 发布到 npm

本仓库的发布是**手动决定**的：流水线只负责构建与打包，是否发布、何时发布由人工执行命令确定。

## 前置条件

```bash
# 1. npm 账号已登录（一次性）
npm whoami        # 未登录则 npm adduser

# 2. 组织 @capyclaw 已创建（作用域包需要）
# https://www.npmjs.com/org/create
```

## 发布流程

### 第一步：构建与打包

```bash
npm run build:plugin        # 重新构建 PPT 插件包
npm run validate-all        # 结构校验全绿
npm run release-all         # 生成 dist/plugins/*.zip
npm run check-registry      # registry 与实际可发布集一致
```

### 第二步：发布预演（dry-run，不真发）

```bash
npm run publish:npm                     # 全部包
node scripts/publish-to-npm.mjs --dry-run --only @capyclaw/launchpad   # 单个包
```

预演会逐包执行：结构校验 → 发布闸（private/publishConfig.access/engines.dsh/link 依赖检查）
→ npm pack → 显示将要发布的版本。任何一关不过都会列出原因。

### 第三步：人工确认后执行

```bash
npm run publish:execute
```

已发布过且版本未变的包会自动跳过（`skipped-exists`）。

## registry 外的手动发布包

以下三个包被发布产品依赖，但不带 `dsh.bundle` 字段、不在 `discoverPlugins()`
集合与 `capyclaw-registry.json` 内，需要单独发布：

| 包 | 目录 | 被谁依赖 |
|---|---|---|
| `@capyclaw/plugin-kit` | `packages/dsh-plugin-kit` | 所有插件的 SDK |
| `@capyclaw/document-workbench` | `packages/dsh-document-workbench` | `@capyclaw/ppt-workbench` |
| `@capyclaw/skills-service` | `extensions/bridges/ppt-bridge/dsh-skills-service` | `@capyclaw/ppt-suite` |

```bash
npm --prefix packages/dsh-plugin-kit publish --access public
npm --prefix packages/dsh-document-workbench publish --access public
npm --prefix extensions/bridges/ppt-bridge/dsh-skills-service publish --access public
```

## 版本管理

- 各包 `version` 手工维护；改版本后跑 `npm run gen-registry` 刷新 registry。
- PPT skill 包的 version/files/publishConfig 由 `build-plugin.mjs` 生成，不要手改。
- `capyclaw-ppt-workbench` 的版本必须与 `src/mcp/contract.mjs` 的 `PACKAGE_VERSION` 一致
  （构建脚本强校验）。

## 常见问题

- **发布被闸挡下**：看 dry-run 输出的具体原因（缺 `publishConfig.access`、
  有 `link:`/`file:` 依赖、缺 `engines.dsh` 等）。
- **zip 分发**：`npm run release-all` 的产物在 `dist/`（gitignored），
  整源包用 `npm run release-source`，标准校验用 `npm run verify-source`。
