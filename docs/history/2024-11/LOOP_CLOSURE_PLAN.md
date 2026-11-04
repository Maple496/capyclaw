# 全链路闭环作战计划（LOOP CLOSURE PLAN）

> 目标：把「生产 → 打包 → 分发 → 消费」与「登录 → LLM 配置（apikey/url/model）→ 插件消费」两条链路
> 从"接近闭环但有断裂"修成"清晰解耦且闭环"。
> 依据：2026-11-02 全链路审计（附录 A：断裂点清单与证据行号）。
> 本文档是长期计划的追踪基准：每完成一项，勾选复选框并填入验证证据。

---

## 一、长期视图：四个阶段

| 阶段 | 主题 | 内容 | 状态 |
|---|---|---|---|
| **P0（本地止血）** | 让既有校验和启动入口真正可用 | ①打包接入 manifest 校验 ②修复 dsh-deploy 启动必崩 bug | ✅ 2026-11-02 完成 |
| **P1（本地闭环）** | 补齐分发与 LLM 配置的本地半边 | ③tempkey 支持平台下发 url/model（客户端侧+降级） ④dsh-works 静态源分发闭环 | ✅ 2026-11-02 完成（客户端侧） |
| **P2（链路交汇）** | .works 与控制面、schema 语义合流 | ⑤控制面接受 .works 输入 ⑥works-parser 补强 CODE 段语义校验 | ✅ 2026-11-02 完成 |
| **P3（平台协同，外部依赖）** | ddr0 平台端落地 | ⑦平台实现 `/api/llm/config` 下发 ⑧平台插件包注册表 ⑨port-8217 服务端可验证 | ⏳ 待平台排期（客户端已就绪） |

**依赖关系**：P0 独立；P1-③ 客户端先行（平台端缺席时回退静态配置，不阻塞）；P2-⑤ 依赖 P0-②（deploy 链路先能跑）；P3 全部依赖外部平台排期。

---

## 二、逐项任务卡（含完成证据）

### P0-1 打包接入 manifest 校验 ✅ 完成（2026-11-02）
- **断裂**：`plugin-development\lib\pack.mjs` 只查 4 项文件存在性；suite-kit 已有的 `validateSuiteManifest`/`validateDomainManifest` 打包时不调用 → 坏 manifest 能打成 ZIP。
- **落地**：pack.mjs 新增 `validateManifests(stagedDir, pkg)`——`dsh.suite` → suite 校验；`dsh.domain` / 根级 `dsh-domain.json` → domain 校验；错误打包中止、warnings 透出（CLI 打 `⚠`）。跨包引用沿用 `create-plugin.mjs` 的相对路径先例。不传 baseDir：ZIP 内兄弟包路径在包外，存在性检查留给安装侧。
- **验证**：plugin-development 套件 **8/8** 通过（新增 4 用例：合法 suite 打包✓ / 坏 role+重复端口+坏 row id 被拦✓ / domain manifest 校验✓ / rows 引用外部包 warning✓）。

### P0-2 修复 dsh-deploy 启动链 ✅ 完成（2026-11-02）
- **断裂**：`bin/dsh-deploy.mjs` 用 execSync 跑 dsh-runtime CLI 再 `JSON.parse(stdout)`，而 CLI 在 JSON 后还打印 `✓ runtime …` 日志 → 必崩；健康检查依赖外部 curl（Windows 裸机不可用）。
- **落地**：
  1. create/start/stop/show/rm 全部改为进程内 SDK（`createRuntime`/`startRuntime`/`stopRuntime`/`readRuntime`/`removeRuntime` + `runtimePublicInfo`），删除 execSync+JSON.parse 粘合（钩子 executeHooks 保留 shell 语义）。
  2. 健康检查改用 SDK `probeHttp`（已从 src/runtime.mjs 导出）。
  3. `getRuntimeId` 增加 slug+摘要（中文名如"PPT工作台部署配置"不再被 `assertRuntimeId` 拒绝，且跨次执行确定性一致）。
  4. start 的健康检查重试成功后正确置位，最终失败则落盘 failed 并抛错；validate 改抛错不直接 exit；bin 加导入守卫（可测试），`commands/loadConfig/getRuntimeId` 导出。
  5. `dsh-deploy`、`dsh-works` 注册进 suite-kit package.json bin。
  6. 示例 `examples/deployment-ppt-basic.works` 的失效 source 路径修正为 `../../../extensions/bridges/ppt-bridge/domains/ppt`。
- **验证**：suite-kit 内 deploy 套件 **6/6**，含真实 E2E：`.works` → 创建 → 启动 → probeHttp 健康检查 → status → stop（约 5s）。

### P1-3 tempkey 支持平台下发 url/model（客户端侧） ✅ 完成（2026-11-02）；平台端归 P3-⑦
- **断裂**：契约只返回 apikey；上游 url（千帆）与模型写死在 cordis.patch.yml。
- **落地**：
  1. `lib/ddr0.mjs` 新增 `llmConfig(base, token)`：`GET /api/llm/config`（P3 平台契约，注释固化：`{base_url, models[], ttl_seconds?}`）。
  2. `lib/host.mjs`：登录校验通过后拉取配置；成功 → 中转 `upstreamBase` 动态切换 + 平台 models 进入状态面 + 与 `config.models` 静态声明对账告警；404 → 安静回退静态；其他错误 → 告警一次后沿用静态。`/__status` 与 `ctx.llmTempkey.status()` 新增 `upstreamSource: platform|config`、`platformModels`。
  3. cordis.patch.yml 的 upstreamBase 注明"平台下发成功后自动覆盖"；README 增「LLM 配置来源」对照表 + 端口口径（开发态 3310 / 部署态 8850）。
- **验证**：dsh-llm-tempkey 套件 **12/12**（新增：平台下发→中转流量实际打到平台上游✓ / 404 回退且状态如实标注✓；既有用例天然覆盖 404 路径）。

### P1-4 dsh-works 静态源分发闭环 ✅ 完成（2026-11-02）；平台注册表归 P3-⑧
- **断裂**：`dsh-works.mjs` "从平台下载：TODO"；实际分发物（index.json+zip+sha256）接不进安装侧。
- **落地**：
  1. 新增 `lib/works-source.mjs`：`loadSourceIndex`（本地文件/目录/http(s) URL）→ `assertIndexShape`（schema 1）→ `pickWorksEntry`（版本/latest）→ `fetchEntryBytes`（**sha256+size 强校验**）→ `extractWorksFiles`（zip 内 .works 提取）。
  2. 新增 `lib/zip-read.mjs`（自包含 ZIP 读取，store+deflate，与 tools/plugin-release 读取语义一致，Buffer 形态供远端源复用）。
  3. `bin/dsh-works.mjs`：`install <name> --from <源> [--version v]`；`--from` 缺省读 `DSH_WORKS_SOURCE`（P3 平台上线后指向平台 URL 即切换，客户端零改动）；源安装的注册表条目带 `source` 字段；顺带修复 `--auto-install` 旗标从不被解析的死角、check 的 `--auto-install` 真正按源补装；bin 导入守卫 + 导出。
- **验证**：works-source 套件 **7/7**（本地安装✓ / --from 静态源→sha256 校验→解包→注册表✓ / 环境变量缺省源+篡改 zip 被拒✓ / 无源报可读错误✓ / 引用解析与参数解析✓）。

### P2-5 .works 接入控制面 + 语义校验补强 ✅ 完成（2026-11-02）
- **断裂**：`/control/create` 只收 domainInput；works-parser 只查 META 浅层；`deployment.schema.json` 从不被 JS 加载；CODE 段必填校验只在 Python 适配器有。
- **落地**：
  1. `lib/works-parser.mjs`：新增 `parseWorksContent`（字符串解析）与 `validateWorksDeployment`（CODE 对象、deployment.source 必填、type 仅 domain、runtime/launcher 形状）；`validateWorksFormat` 对 `kind=deployment` 自动加深校验（与 dsh-deploy loadConfig / PYTHON_DEPLOYMENT_ADAPTER 口径一致）。**不引入 JSON-schema 依赖**，保持仓库零依赖风格。
  2. `dsh-deploy loadConfig` 的 .works 分支接入 `validateWorksDeployment`。
  3. `dsh-runtime-control/lib/host.mjs`：`/control/create` 与 `service.create` 支持 `worksFile` / `worksInput` → 解析+双层校验（格式/部署语义）→ `deployment.source` 解析为绝对路径 → 转 domainInput（runtime.workId/model 覆盖项透传）；校验失败回 **400** 带错误清单（error.status 机制）。
- **验证**：works-parser 套件 **8/8**；runtime-control e2e **2/2**（domain 线 + **.works 线**：worksFile → 控制面创建/启动 worker → healthz 通过；负路径缺 source → 400）。

---

## 三、P2 阶段发现：ppt 域包宿主行缺失 ✅ 已修复（2026-11-02 验收轮）

**现象**：PPT 域包创建 worker 成功、harness 可服务，但 content 端口不监听，健康检查 30s 超时且**无任何报错**。

**根因（验收轮定位，修正上一轮"16 行全丢"的误判）**：
`dsh-ppt-suite/cordis.patch.yml` 的 insert 列表（14 行）**缺少 `ppt-workbench-host` 行**——content 端口的唯一宿主。其余行（service/tool/asset/editor-host、mcp-ppt、8 skills）经 `dsh --dump-config` 验证**全部在有效配置里**并正常加载；缺的只有宿主行 → 没人绑定 content 端口 → 健康检查超时。行不存在不是错误，所以完全静默。bundles 目录部署之所以可用，是因为那里的 dsh-ppt-workbench 包自带含宿主行的 patch。

**修复**：`extensions/bridges/ppt-bridge/plugin/dsh-ppt-suite/cordis.patch.yml` 补上
`- id: ppt-workbench-host / name: "dsh-ppt-workbench"`（声明形态对齐 bundles 可用版本；端口 config 由 runtime 层 `buildRuntimeRowOverrides` 依 domain bindings 注入，不写死）。

**验证**：
- 驱动复跑：worker `ready:true`，`/healthz` 返回 `{bridge:"ppt-workbench", ok:true, contractsChecked:8, injected:{serviceHost,toolHost,editorHost,assets}}`。
- `packages\dsh-workspace-service` 的 PPT e2e **解除 skip 后通过**（全套 **7/7**，0 skip）。
- 连带修正（上一轮已做）：ppt domain manifest 的 components/schema 相对路径（4 层→5 层，适配 extensions 搬迁）；两处 e2e 的旧 `bridges/...` 路径常量。

**经验**：bundle 行静默缺失（行不存在≠错误）是这类故障的隐藏形态；`dsh --dump-config` 是排查行组合的最直接工具。

---

## 四、节奏与里程碑

- **第 1 步（2026-11-02）**：P0-1、P0-2、P1-3（客户端）、P1-4、P2-5 全量落地+测试 ✅
- **第 2 步（2026-11-02，验收轮）**：正式验收（见六）+ ppt 宿主行根因修复（见三）+ 全链路验收测试 `chain.test.mjs` 入库 + dsh-assembly-kit 测试从 0 补到 12 ✅
- **第 3 步（2026-11-02，巩固轮）**：链路结构化巩固 ✅ —— ①行覆盖审计 `auditRowCoverage`（产品化进 `dsh-deploy validate`，ppt 类静默缺行配置期即拦）+ 顺手修掉 ppt domain 的 `state-service` 死引用 ②接缝测试 `seam.test.mjs`（S4 安装→部署、S5 部署→运行，仅靠工件衔接）③一条命令全链验收 `npm run verify-chain`（各环节 CLI 独立可运行 + 真实工件咬合检查，10/10）④接缝契约总册 `CHAIN_CONTRACTS.md`（9 条接缝：格式/生产方/消费方/校验/守卫/变更规则）
- **第 4 步（2026-11-02，拓展轮）**：拓展性取证+演练 ✅ —— `extensibility.test.mjs`（E1 新启动清单=纯数据 / E2 加插件=数组加一项 / E3 换模型=改一个字段 / E4 防呆审计）证明四大扩展场景零代码；`CHAIN_CONTRACTS.md` 增「拓展性矩阵」（含诚实边界：pi-ai 路由 models 静态列表需重启，完全热切换属后续项）
- **第 5 步（2026-11-02，基建轮）**：基础设施收敛启动 ✅ —— 盘点重复（fs-lock×5、ZIP×3、CLI 解析×8、http 基建现成被无视）；落地两个样板：**cli-kit**（`dsh-plugin-kit/src/cli.mjs`：parseArgs/isMain/fail，迁移 dsh-works，顺手修复 `--auto-install` 死旗标读驼峰键的 bug）+ **http-kit 迁移**（runtime-control 手写劣化版 jsonBody/send → plugin-kit `readBody`/`send`，白得安全头/HEAD/断连兜底）；`CHAIN_CONTRACTS.md` 增「基础设施层 vs 功能层」章节（已有清单/样板/待迁移路线 TOP5/分工对照表）
- **第 6 步（2026-11-02，真源合并轮）**：单一真源收敛 ✅ —— ①**ZIP 读写合一**：`dsh-plugin-kit/src/zip.mjs` 为唯一实现，3 处旧位置全部变 shim/re-export（plugin-kit 24/24 含回环测试，release 37/37）②**fs-lock 确认已归一**（runtime-kit 本就是 shim，真源唯一；顺带让 dsh-works 用上 `writeJsonAtomic` 原子写）③**works 注册表分治**：`works-registry.json` 独立于 runtime 租约 `registry.json`，终结两套 schema 混写互相覆盖（实机文件已证实混存），旧文件一次性收养迁移 ④dsh-runtime 迁 cli-kit。发现修正：fs-lock"5 份副本"实为 1 真源+1 shim+3 快照，归一程度好于此前盘点。
- **第 7 步（下一迭代）**：其余 bin 迁 cli-kit（dsh-suite/dsh-domain/dsh-assembly）；ppt-bridge 快照再生机制确认；dsh-flow-engine worksreg 对齐 works-registry.json；`dsh-works update`；pi-ai 路由 models 动态化评估。
- **第 7.5 步（2026-11-02，进化优化轮）**：用 NSGA-II 求最优结构与参数 ✅ —— 修复从未能运行的 llm-tempkey 评估器（三处坏点）→ 轮换策略抽纯函数（宿主+评估器共用）→ 评估器重写（虚拟时钟/抖动/相位/探针加密/契约对齐）→ 进化 120 次评估得平衡解 `ttl=2820/margin=555/tick=90s/prop=60s`（**24h 签发 -88.8%、检查 -66.7%、零稳定违例**）→ 固化 tuning + 行 config；链路基准定位 row-audit 热点 → patch 缓存结构变体 A/B（**热路径 -26%**，冷路径不劣化，manifest 对象缓存因变异风险明确放弃）。详见 `EVOLUTION_REPORT_2026-11-02.md`；基准工具 `evolution/chain-bench.mjs`。
- **第 7.8 步（2026-11-02，E2E 与死代码轮）**：大量端到端 + 死代码治理 ✅ —— 新增分发 E2E（HTTP 源安装/篡改拒绝/注册表收养/auto-install 旗标）与 worksInput 内联建 runtime；E2E 中抓出并修复 `check --auto-install` 的 `if (m.error) continue` 逻辑 bug（把"未找到作品"可安装场景也跳过）；新建 `scripts/scan-dead-code.mjs`（import 图 v2）扫描 239 个 .mjs，清除 5 个真死导出（satisfiesVersion/parseVersionRange/compareVersions/autoInstallDependencies/generateWorksFile），13 个"零引用文件"全部核实为手动工具入口/同步快照产物（保留并标注）。全量矩阵 9 套件 + verify-chain 全绿。
- **第 7.9 步（2026-11-02，高频链路优化轮）**：Phase 0 算法优化落地 ✅ —— ①ppt-shim 5 处深拷贝改递归 `cloneJson`（0.71→0.14–0.17ms，3.8–5×）②`FileStateBackend` fsync 节流（每批 2 次写：3.88→2.22ms，-43%；checkpoint 仍强制刷盘，`fsyncEvery=1` 可回旧行为）③`validateToolArguments` 编译缓存（0.0294→0.0080ms，3.7×）。全量 10 套件 + verify-chain 10/10 + ppt-shim 语义验证全绿；未做项（batch 调用方/命名管道/msgpackr/uWS）与理由见 `HOTPATH_OPTIMIZATION_REPORT_2026-11-02.md`。
- **第 7.95 步（2026-11-02，多 agent 实验轮 → 已剔除）**：多 agent 并行编排插件 ❌ 经实测判定为负收益，**已从生产剔除并归档**（`archives/experiments/dsh-multi-agent/`）。过程与证据：实现薄编排层（ctx.subagents/ctx.tools、DAG+并发+adaptive+验证）、策略 GA（adaptive 100%/1.1s，直写重叠负载仅 70%）、真实模型 ON/OFF（20 页单 agent 全面更优；60 页多 agent 仅时延中位快 48% 但 token 3.45×、一致性更差）、消费端验收（安装→激活→卸载全链路通过，抓出并修复 ZIP CRC/engines.dsh/inject/schema 四个真实缺陷）。基础设施收益保留在主干；详见 `MULTI_AGENT_REPORT_2026-11-02.md`。
- **第 8 步（2026-11-03，全链闭环轮）**：修复 PPT 域装配断链并收口工具链 ✅ —— ①domain runtime 增加服务支持：suite `services.json` → `<runtime>/service-manifest.json`（`portFrom: "content"` / `dirFrom: "contentState"`），runtime 拉起 `dsh-service-broker`，不再依赖已退役的 `ppt-workbench-host` 行；PPT domain 删除该行 binding/removeRows ②relay standalone 入口接回 runtime workspace store ③恢复 `scripts/test-all-plugins.mjs` 并加 `npm run verify-all` 一键门禁 ④两条生成器对齐 validator + 发布闸（engines.dsh / category / platform / dsh-plugin-kit）⑤tempkey 补 engines.dsh，dist/release 刷新为 3 个官方插件。验收：verify-chain 10/10、suite-kit 68/68、workspace-service 7/7、stack 矩阵全绿、release 37/37、test-all 5/5、`verify-all` exit 0。详见 `CLOSURE_2026-11-03.md`。
- **第 8.5 步（2026-11-03，stack v2）**：一份清单统一 profile/domain 装配 ✅ —— `dsh-stack.json` 增加 `kind: profile|domain`；domain 型 `domain.source` 委托 `dsh-suite-kit` runtime（create/start/stop/status/doctor），端口映射 `proxy→harness`、`upstream→dsh`、`content→content`、`broker→broker`、`services.*→suite 服务偏好`；`createRuntime` 新增 brokerPort/servicePorts/env 合并；新增 `domain-stack.test.mjs`（plan→apply→start→status/doctor→stop→复用，真实 dsh+broker+service，外部栈不变）。stack-kit 9/9。详见 `STACK_V2_2026-11-03.md`。
- **第 8.6 步（2026-11-03，产品化交付）**：独立 DSH + 启动程序管理器 + exe 打包 ✅ —— ①launchpad DSL 增加 `kind "domain"` + runtime.json/discovery 状态读取（管理器可列/启/停 domain launcher）②`stageDomain` 自带 `dsh-service-broker` ③新增 `tools/product-packager`：`product.json`（base+launchers+infra）→ 便携产品（node+harness+app+data）+ `dsh.exe`（C# 薄壳），首次启动建链接、产品可移动 ④示例 `products/dsh-desktop`（base=launchpad，launcher=PPT）。实测：base 39000 + 管理器 39010；API 启动 PPT launcher → 独立 dsh 39100 + broker 8871 + relay 8870 + skills 39321；stop 全释放。详见 `PRODUCT_PACKAGING_2026-11-03.md`。
- **第 9 步（平台排期后）**：P3 联调（⑦ `/api/llm/config`、⑧ 平台注册表、⑨ port-8217 真实冒烟 `LIVE=1` 脚本）。

## 五、风险与约束

- 平台端（ddr0、port-8217、主站 auth_sessions）不在本仓库：客户端一律 mock 测试 + 优雅降级，不因平台缺席阻塞本地链路。
- Windows 环境：新代码不依赖 curl/shell 外部命令（deploy 健康检查已改 probeHttp）。
- 端口口径：tempkey tokenUrl 开发态 3310 / 部署态 8850，已写入 README 表格。
- 遗留租约：`~/.dsh-store` 有历史 `rt-ppt-latest`/`rt-demo-ppt` 租约（状态 running 但进程已死），属本会话之前产物，未动。

## 六、验收快照（2026-11-02 验收轮，全新跑）

**验收方法**：A 语法核验（18 个改动 .mjs 全过 `node --check` + JSON 合法）→ B 全量测试全新重跑（不信上轮结果）→ C 文档声明 vs 代码逐项 grep 核对（校验函数/SDK 化/bin 注册/契约/分发模块全部属实）→ D 新建永久全链路验收测试。

| 包 | 验收结果 |
|---|---|
| plugin-development（含 **chain.test.mjs 全链路验收**：scaffold→pack 校验→分发源→install→check→卸载） | **9/9** |
| dsh-suite-kit（含 deploy E2E / works-source / works-parser） | **53/53** |
| dsh-runtime-control（e2e domain 线 + .works 线） | **2/2** |
| dsh-workspace-service（e2e，PPT 用例已解除 skip） | **7/7** |
| dsh-llm-tempkey | **12/12** |
| dsh-assembly-kit（测试从 0 补齐：catalog/resolver/emitter/scanner） | **12/12** |

**巩固轮增量（2026-11-02）**：suite-kit **60/60**（新增 seam.test 7 条）；`npm run verify-chain` **10/10**；契约总册见 `CHAIN_CONTRACTS.md`。

**拓展轮增量（2026-11-02）**：suite-kit **64/64**（新增 extensibility 4 条演练）；四场景拓展性矩阵见 `CHAIN_CONTRACTS.md`。

**全面验收轮（2026-11-02，最终）**：A 语法 11/11 + 单一真源取证（ZIP EOCD 实现仅存于 plugin-kit 真源）；B 全量全新重跑 —— plugin-kit **24/24**、suite-kit **64/64**、plugin-development **9/9**、runtime-control **2/2**、workspace-service **7/7**、tempkey **12/12**、assembly-kit **12/12**、tools/plugin-release **37/37**、`verify-chain` **10/10**；C registry 分治实测 5/5（新装只写 works-registry.json / 预置旧文件收养且租约逐字不动 / **真实 ~/.dsh-store 15 条存量 works 已收养成功**）；D E2E 含于 B 批次（chain/deploy/控制面 .works 线）；E 文档核对与残留检查（无临时目录/无泄漏进程/无部署残留；`sync-shared.mjs` 确认快照真源=plugin-kit）。发现：`workspace-service/server/infra/util/fs-lock.mjs` 为逐字一致但**无人引用**的死副本（低危，待清理）；`dsh-works` 合并残留死变量 `HERE` 已当场清除。

**遗留债（非阻塞，已排期）**：双工具链归并；`dsh-works update`；tempkey 平台端真实冒烟（依赖 P3）；`~/.dsh-store` 两个历史死租约（`rt-ppt-latest`/`rt-demo-ppt`，本会话前产物，可用 `dsh-runtime gc` 清理）；workspace-service 死副本清理；`dsh-flow-engine/worksreg.mjs` 迁新注册表文件。

---

## 附录 A：审计断裂点证据索引（2026-11-02）

| # | 断裂 | 证据 | 状态 |
|---|---|---|---|
| 1 | 打包不拦坏 manifest | `plugin-development\lib\pack.mjs`（旧 L97-109）；校验函数在 suite-kit 未被调用 | ✅ P0-1 修复 |
| 2 | dsh-deploy 启动必崩 | execSync+JSON.parse vs CLI 追加日志；curl 依赖 | ✅ P0-2 修复 |
| 3 | url/model 不来自平台 | 契约仅返回 apikey；写死在 cordis.patch.yml | ✅ 客户端就绪（P1-3），平台端 ⏳ P3-⑦ |
| 4 | 平台分发 TODO | `dsh-works.mjs:99-101,389`；静态源格式 `tools\plugin-release` | ✅ 本地闭环（P1-4），平台端 ⏳ P3-⑧ |
| 5 | .works 与控制面不交汇 | `/control/create` 只收 domainInput；浅校验；schema 未加载 | ✅ P2-5 修复 |
| 6 | 登录链（已闭环，供参照） | 桌前面前端 backend 持有登录态→快照端点（仅回环）→插件消费 | ✅ 无需改动 |
| 7 | （P2 发现）ppt 域包宿主行缺失 → content 端口无人绑定 | 见第三节证据链 | ✅ 验收轮修复（workspace-service PPT e2e 解除 skip） |
| 8 | （验收发现）dsh-assembly-kit npm test 指向不存在的测试文件 | `package.json:24`；仓库原无 test 目录 | ✅ 补齐 4 个测试文件（12/12） |
| 9 | （巩固发现）ppt domain removeRows 含死引用 `state-service`（组件链已无此行，移除为空操作） | 行覆盖审计首战检出 | ✅ 清理死引用 |
| 10 | 结构性：环节间缺显式契约与独立验收入口 | 见 `CHAIN_CONTRACTS.md` | ✅ 9 条接缝契约 + `npm run verify-chain` |
