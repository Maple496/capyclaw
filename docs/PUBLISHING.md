# 发布到 npm

本仓库的发布是**手动决定**的：流水线只负责构建与打包，是否发布、何时发布由人工执行命令确定。

**一条命令跑完整条发布准备流水线：`npm run release`**（构建 → lint → 结构校验 → zip 产物 →
索引 → registry 生成与一致性检查）。之后人工检视，再 `npm run publish:execute` 发布。

## 前置条件

```bash
# 1. npm 账号已登录（一次性）
npm whoami        # 未登录则 npm adduser

# 2. 组织 @capyclaw 已创建（作用域包需要）
# https://www.npmjs.com/org/create
```

## 发布流程

### 第一步：一键流水线（构建 + 打包 + 清单）

```bash
npm run release
# 等价于依次执行：
#   npm run build            # ppt-bridge + canvas-bridge 全部插件包重建
#   npm run lint             # 两个 bridge 的 skill lint
#   npm run validate-all     # 结构校验全绿
#   release-all              # 生成 dist/plugins/*.zip（含 vendored 依赖）
#   release-index            # 生成 dist/index.json
#   gen-registry + check     # capyclaw-registry.json 重新生成并校验一致
```

### 第二步：发布预演（dry-run，不真发）

```bash
npm run publish:npm                                  # 全部包（支撑库 + 插件）
node scripts/publish-to-npm.mjs --only @capyclaw/launchpad   # 单个包
```

统一发布脚本覆盖**全部对外包**：

- **支撑库**（显式清单，先发）：`@capyclaw/plugin-kit`、`@capyclaw/document-workbench`、
  `@capyclaw/skills-service` —— 它们无 `dsh.bundle`、进不了插件闸，走库发布闸
  （private / publishConfig.access / license / link 依赖检查）。
- **插件**（`discoverPlugins()` 自动发现，后发）：结构校验 + 插件发布闸。

顺序固定「先库后插件」：`@capyclaw/plugin-kit` 必须先上 registry，插件发布时依赖才可解析。
任何一关不过都会列出原因；已发布过且版本未变的包自动跳过（`skipped-exists`）。

### 第三步：人工确认后执行

```bash
npm run publish:execute                          # 全部 → latest
npm run publish:execute -- --tag next            # 预发布通道（dist-tag=next）
```

`--tag` 与 zip 源索引的 `--channel` 语义对应：`stable ↔ latest`、`next ↔ next`。
走了 `next` 的版本正式发布时重新 `publish:execute` 即可落到 `latest`（npm dist-tag 语义）。

## 版本管理

- 各包 `version` 手工维护；改版本后跑 `npm run gen-registry` 刷新 registry
  （`npm run release` 已包含）。
- PPT skill 包的 version/files/publishConfig 由 `build-plugin.mjs` 生成，不要手改。
- `@capyclaw/ppt-workbench` 的版本必须与 `src/mcp/contract.mjs` 的 `PACKAGE_VERSION` 一致
  （构建脚本强校验）。

## 常见问题

- **发布被闸挡下**：看 dry-run 输出的具体原因（缺 `publishConfig.access`、
  有 `link:`/`file:` 依赖、缺 `engines.dsh` 等）。
- **可安装性自检**（打 tarball → 干净目录安装验证）：`npm run verify-publishable`。
- **zip 分发**：`npm run release-all` 的产物在 `dist/`（gitignored），
  整源包用 `npm run release-source`，标准校验用 `npm run verify-source`。

### npm 侧已知限制（2026-11 实测）

- **新建包名 429**：短时间连续创建多个新包名会触发 registry 的账号/网络级限流，
  报错形如 `429 ... as user undefined: rate limited exceeded`。已有包发新版本不受影响。
  冷却窗口实测超过 17 小时（约 24 小时），期间只能等待；补发时逐包 `--only` 发布即可。
- **暂存版本冲突**：个别包的发布会进 registry staged 区（未立即上架），
  再发同版本报 `409 Cannot publish over previously staged version "x.y.z"`。
  查看/批准需 npm ≥ 11.15 的 `npm stage list|approve`（批准要 2FA），
  或到 npmjs.com 的 Staged Packages 页操作；无法操作时**升 patch 版本重发**最省事
  （`ppt-skill-research` 2.2.3 即按此跳到 2.2.4，并连带 suite 2.4.6 更新组合锁）。
- 发布后 `npm view <pkg> version` 可能短暂滞后（registry 副本），以 `publish:npm` 的
  逐包结果为准，稍后复核。
