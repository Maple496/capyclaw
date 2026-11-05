# 统一重构验证报告（unification-verification）

对五个统一重构提交（3357c89 命名 / 477ef17 发布通道 / 1102878 启动方式 / 61c8f5e 代码去重 / 0ee130f 清理）
的大规模端到端验证结论。**入口：`npm run test:e2e`**（六层 65 项，详见下）。

## 一、端到端验证矩阵（六层 65 项，全绿）

| 层 | 覆盖 | 项数 | 用时 | 结果 |
|---|---|---|---|---|
| L1 静态清单 | validate-all、两 suite validate+compose（manifest 路径 13+7 个、row 按名解析 12+8 个）、domain validate/resolve/registry、双重嵌套回归、registry↔dist 对齐（28/28）、launchpad scan/validate、28 包名按名解析 | 19 | ~1s | ✅ |
| L2 单元 | canvas `node --test`（contract/model/plugin/relay/stability/store） | 55 项 | ~21s | ✅ |
| L3 服务/MCP | 双 relay 对称：/healthz（pid+contractsOk）、/mcp initialize、tools/list（27/22）、capabilities 真实调用、编辑器静态 ×3、/assets 上传回读；ppt stdio 管道握手（initialize/ping/tools/list/通知无应答）；skills-service 三端点（providers=8）；**host.mjs 统一模板 apply() 真实拉起 relay ×2**；12 个 skill 包 mock-ctx（list/get + 契约注豁免规则） | 26 | ~3s | ✅ |
| L4 broker 套件链路 | **services.json 一字不改**经 junction 安装态布局 → broker 拉起（${PACKAGE_DIR}/${PORT} 展开、portFrom/dirFrom 放行、healthPath 收编）→ /control/list → discovery 写入 → /control/stop 回收；canvas 单服务 + ppt 双服务各一轮 | 12 | ~11s | ✅ |
| L5 发布链路 | `npm run release` 全链（构建→lint→校验→zip→索引→registry 一致）、dsh-release verify（plugin-source/1 逐 zip 完整性）、publish dry-run（3 库+28 插件全过闸、总数 31）、verify-publishable 抽检 2 包（pack→干净目录安装） | 6 | ~2min | ✅ |
| L6 真浏览器 | canvas Playwright e2e 22/22（真编辑器挂载 claim、13 个工具真实调用、页面断言、undo/redo、导出、性能预算 append p50 87ms / read 1ms / screenshot 127ms） | 1 | ~5s | ✅ |

复跑方式：`npm run test:e2e`（全量）/ `node scripts/e2e-all.mjs --layer l1,l4`（分层）/
`--skip-browser` / `--skip-network`（离线模式）。

## 二、e2e 过程中抓到并修掉的 3 个真 bug

1. **`resolvePluginDir` 深层包名解析失败**（tools/capyclaw-plugin-release/lib/index.mjs）：
   只扫三个 base 的第一层，bridges 下 16 个生成包（workbench/suite/skill-*）按包名解析全部
   抛错 → `dsh-release release <name>` 不可用。修复：查找面加 `extensions/bridges/*/plugin`
   一层通配（28/28 全命中，L1 回归断言固化）。
2. **activation-registry 双重嵌套路径**（packages/capyclaw-suite-kit/src/activation-registry.mjs）：
   新代 services.json 的 `${PACKAGE_DIR}` 被替换为 owner 包目录，产出
   `<workbench>/node_modules/@capyclaw/<workbench>/…`。ppt 一直用新代规格，即 launch-engine
   激活面自新代规格引入起就带着这个错。修复：cmd 含 `node_modules/<pkg>/` 时以套件根为基准
   （L1 断言「无双重嵌套」固化）。
3. **relay 主入口守卫在符号链接布局下静默失效**（两 workbench `server/relay.mjs`）：
   `process.argv[1] === import.meta.url` 字符串直比，junction/pnpm 式符号链接安装态下两者
   不等 → 模块加载完静默退出 0、服务永不启动。修复：realpath 比较。L4 正是靠它才走通。

## 三、零散功能整合完成度

| 整合项 | 之前 | 之后 | 验证 |
|---|---|---|---|
| 发布通道 | npm 脚本 + zip 源 + registry 清单 + **3 条手动 npm publish**，清单互不同步（registry 28 vs dist 22） | 单一 `publish-to-npm.mjs`（3 库+28 插件、先库后插件、`--tag` dist-tag）+ `npm run release` 一键流水线 | L1 registry↔dist 28/28；L5 dry-run 31 包过闸 |
| 启动方式 | canvas 有 start/start:workbench、ppt 无任何 start；两代 services.json 规格；host.mjs 两份口径相反 | 两 bridge 对称脚本集；services.json 统一新代规格；host.mjs 单一模板（「兼容入口，生产走 broker」） | L3 host apply ×2；L4 broker 全链路 ×2 套件 |
| 命名 | 包名三种风格、目录名错位、发布工具内置兼容映射、`dsh-document-workbench` 断链导入 | 包名 `@capyclaw/*`、目录名=包名去 scope、dirNameCandidates 去历史分支 | 旧名残留 grep = **0**；L1 按名解析 28/28 |
| 构建脚本 | 两份平行 build-plugin.mjs / lint-skills.mjs，~85-95% 重复 | `scripts/lib/bridge-build.mjs` + `lint-skills-core.mjs` 单一真源，bridge 侧只剩差异配置 | `npm run check` 字节级漂移检查（构建产物等价性证明） |
| shared 快照 | ppt 多一个脱管孤儿文件 | 两 bridge 快照树文件集 **diff = 0** | L1 + sync-shared --check |
| 验证入口 | 散落 8+ 处命令，broker 链路零测试 | `npm run test:e2e` 六层一入口 | 本报告 |

## 四、复杂度度量（基线 305ae74 → 当前）

| 项 | 基线 | 现在 | 变化 |
|---|---|---|---|
| build-plugin.mjs（两 bridge） | 455 + 425 = 880 行 | 252 + 222 = 474 行 | -406 行；公共逻辑收敛为 bridge-build.mjs（430 行）单一真源，bridge 侧只剩配置表 |
| lint-skills.mjs（两 bridge） | 98 + 91 = 189 行 | 54 + 45 = 99 行 | -90 行；公共核 98 行 |
| workbench host.mjs | 98 + 84 = 182 行两份（~95% 重复、口径矛盾） | 模板单源（bridge-build 内 renderWorkbenchHost）+ 两份生成产物 | 重复消除；政策口径唯一 |
| 代码/配置旧名残留 | 广泛（dsh-* 裸名、断链导入、失效 ignore 规则） | **0** | grep 计数 |
| 发布所需命令 | 构建 2 + 校验 1 + zip 2 + registry 2 + dry-run 1 + 发布 1 + **手动 3** = 12 | `npm run release` → `npm run publish:execute`（+ 可选 `--tag`）= **2** | -10 |
| 多余 lockfile | 4 个 | 1 个（根） | -3 |
| 陈旧 node_modules shim（指向不存在目标） | 6 个（dshd/dsh-runtime/…） | 0 | -6 |

说明：根 package.json scripts 由 24 → 36 条，是**对称分解**（build:ppt/build:canvas、
check:*、lint、test、test:e2e、分层 e2e）带来的入口细化，不是复杂度上升——每个入口
单一职责且都由 `release`/`test:e2e` 两个总入口编排。

## 五、遗留与建议

- ppt-bridge 仍无自有单测（L3/L4 已覆盖其服务面与 MCP 面；若后续 ppt 核心域改动频繁，
  建议参照 canvas relay.test.mjs 的假编辑器模式补 `test/`）。
- `verify-publishable` 全量（~20 包 × 干净目录安装）仍需手动跑，e2e 默认抽检 2 包。
- registry `$schema` 指向 deepseek-ai org、包 repository 指向 Maple496/capyclaw——两个
  上游地址并存，待仓库正式定址后统一。
