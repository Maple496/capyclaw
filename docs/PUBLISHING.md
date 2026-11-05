# 发布到 npm

**本仓库不发布任何东西。** 仓库职责到 `dist/` 产物为止；npm 发布由 dsh 内的
**`@capyclaw/publisher` 插件**执行（`extensions/official/capyclaw-publisher/`，
源在本仓、以 npm 包分发）。发布逻辑（发现集、发布闸、顺序闸、同版本漂移、
发布后 shasum 复核）逐条移植自本仓原 `scripts/publish-to-npm.mjs`，该脚本已删除。

## 前置条件

```bash
# 1. npm 账号已登录（一次性，发布机/dsh 宿主机）
npm whoami        # 未登录则 npm adduser（或设 NODE_AUTH_TOKEN）

# 2. 组织 @capyclaw 已创建（作用域包需要）
# https://www.npmjs.com/org/create
```

## 一次性引导（仅首次需要）

publisher 依赖 `@capyclaw/plugin-validator`（校验闸），两者当前都不在 npm 上，
需按依赖顺序手动各发一次——这是本仓**最后两次**裸 `npm publish`：

```bash
# ① 先发校验器（publisher 的依赖）
cd tools/capyclaw-plugin-validator && npm publish --access public

# ② 再发 publisher 自己
cd extensions/official/capyclaw-publisher && npm publish --access public
```

之后（包括 publisher 自身的版本更新）一律走插件发布。

## 发布流程（dsh 内）

```bash
# 安装（每个 profile 一次）
dsh plugin add @capyclaw/publisher
```

在 dsh 里对 AI 说「预演发布 / 执行发布」，对应工具调用：

1. `publisher_whoami` — npm 凭据预检
2. `publisher_preview({ root })` — 全量 dry-run：支撑库 + `discoverPlugins()` 插件，
   先库后插件；发布闸 / pack 闸 / 同版本漂移 / 依赖顺序闸，逐包结果 + 汇总
3. `publisher_execute({ root, confirm: true })` — 真发布（不可撤销，必须显式 confirm）；
   可选 `only`（单包）、`tag`（dist-tag，默认 latest）、`skipTests`

`root` = 本仓 checkout 路径（或环境变量 `DSH_PUBLISHER_ROOT`）。
支撑库清单可用 `DSH_PUBLISHER_LIBS` 覆盖（默认 4 项：plugin-kit /
document-workbench / host-shell / skills-service，与 `scripts/lib/publish-set.mjs` 对齐）。

## 版本管理

用统一 bump 工具（默认 dry-run，`--write` 落盘；取代了旧的手改清单脚本）：

```bash
node scripts/bump.mjs @capyclaw/ppt-skill-narrative patch --write  # 单包（npm 名或目录名）
node scripts/bump.mjs --all patch --write                          # 全部可发布包
node scripts/bump.mjs @capyclaw/ppt-suite --set 2.5.0 --write      # 显式设版本
node scripts/bump.mjs --sync-refs --write    # 把各 dsh-suite.json 的 ^ 引用收口到本地当前版本
```

- bump 会同时更新：`package.json`、bridge 构建脚本的 SKILL_PACKAGES 表行、
  workbench 的 `contract.mjs` `PACKAGE_VERSION`、suite 的 `dsh-suite.json` 顶层 version；
  **不动引用**（引用跟踪 npm 已发布版本，何时收口用 `--sync-refs`）。
- bump 落盘后：`npm run build`（重生成 lock/契约快照）→ `npm run gen-registry`。
- PPT skill 包的 version/files/publishConfig 由 `build-plugin.mjs` 生成，不要手改
  （版本经 bump 工具改表行，不直接改产物）。
- `@capyclaw/ppt-workbench` 等三个 workbench 的版本必须与各自 `src/mcp/contract.mjs`
  的 `PACKAGE_VERSION` 一致（构建脚本强校验，bump 工具会同步更新）。

## 常见问题

- **发布被闸挡下**：看 `publisher_preview` 逐包输出的具体原因（缺 `publishConfig.access`、
  有 `link:`/`file:` 依赖、缺 `engines.dsh`、pack 闸缺文件等）。
- **可安装性**：preview 自带 pack 闸（`npm pack --dry-run` 断言 package.json / main /
  patch 必在包内）；沙箱级全量安装验证走本仓 `npm run verify:install`。
- **zip 分发**：`npm run release-all` 的产物在 `dist/`（gitignored），
  整源包用 `npm run release-source`，标准校验用 `npm run verify-source`。

### npm 侧已知限制（2026-11 实测）

- **新建包名 429**：短时间连续创建多个新包名会触发 registry 的账号/网络级限流，
  报错形如 `429 ... as user undefined: rate limited exceeded`。已有包发新版本不受影响。
  冷却窗口实测超过 17 小时（约 24 小时），期间只能等待；补发时逐包 `only` 发布即可。
- **暂存版本冲突**：个别包的发布会进 registry staged 区（未立即上架），
  再发同版本报 `409 Cannot publish over previously staged version "x.y.z"`。
  查看/批准需 npm ≥ 11.15 的 `npm stage list|approve`（批准要 2FA），
  或到 npmjs.com 的 Staged Packages 页操作；无法操作时**升 patch 版本重发**最省事：
  `node scripts/bump.mjs <pkg> patch --write && npm run build`
  （`ppt-skill-research` 2.2.3 即按此跳到 2.2.4，并连带 suite 2.4.6 更新组合锁）。
- 发布后 `npm view <pkg> version` 可能短暂滞后（registry 副本），以
  `publisher_execute` 的逐包结果（含发布后 shasum 复核）为准，稍后复核。
