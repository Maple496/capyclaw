# 全链接缝契约总册（CHAIN CONTRACTS）

> 设计原则：**每个环节彼此独立，环环相扣靠契约**。
> 独立 = 每个环节有自己的 CLI 入口、自己的测试、可独立运行（`npm run verify-chain` 逐个验证）。
> 咬合 = 环节之间只通过「工件 + 本文定义的契约」衔接，不通过跨模块函数调用；
> 每条契约有守卫测试，破坏契约必然让某个测试红。
>
> 一条命令验收全链：`npm run verify-chain`

## 接缝总览

```
S1 生产 ──S2 打包──S3 分发──S4 安装──S5 部署──S6 运行──S7 消费(控制面)
   plugin-development │ suite-kit(dist+zip) │ dsh-works │ dsh-deploy │ dsh-runtime/control │ 桌面前端
S8 登录(桌面前端 backend) →→ 插件(tempkey) ←← S9 平台(ddr0, 外部)
```

---

## S1 生产 → S2 打包

| 项 | 内容 |
|---|---|
| 工件 | 插件目录：`package.json`（`main`/`files`/`dsh.bundle.patch`/`dsh.suite`/`dsh.domain`）+ 入口 + patch |
| 生产方 | `plugin-development/create-plugin.mjs` |
| 消费方 | `plugin-development/lib/pack.mjs`（`stagePlugin`/`packPlugin`） |
| 校验 | `validateStaged`（文件存在性）+ `validateManifests`（结构语义，**与安装侧同一套规则**：suite-kit `validateSuiteManifest`/`validateDomainManifest` 是唯一真源） |
| 守卫 | `test/pack.test.mjs`、`test/chain.test.mjs`（含坏 role/重复端口/坏 row id 被拦） |
| 变更规则 | 校验规则只改 suite-kit 一处；新增字段必须 optional；破坏性变更 → suite manifest schema 升级 + 安装侧同步 |

## S2 打包 → S3 分发

| 项 | 内容 |
|---|---|
| 工件 | `index.json` **schema 1**：`{schema:1, channel, plugins:[{name, version, file, sha256, size, latest, …}]}`，`file` 相对 index 位置（或绝对 URL）+ ZIP |
| 生产方 | `tools/plugin-release`（发布登记） |
| 消费方 | `packages/dsh-suite-kit/lib/works-source.mjs`（CLI `dsh-works --from`）；桌面后端 `works_plugins.py`（同一 schema） |
| 校验 | `assertIndexShape` + **sha256/size 强校验**（`fetchEntryBytes`） |
| 守卫 | `test/works-source.test.mjs`（含篡改 zip 被拒）、`chain.test.mjs`、`scripts/verify-chain.mjs`（真实 dist/index.json） |
| 变更规则 | schema 只增不删；新字段 optional；升级 schema 号需消费方（CLI+桌面）同步支持 |

## S3 分发 → S4 安装

| 项 | 内容 |
|---|---|
| 工件 | ZIP 内的 `.works` 文件（双段格式） |
| 消费方 | `dsh-works install`（`installWorkFile`） |
| 校验 | `validateWorksFormat`（META 必填 + 部署类 CODE 语义） |
| 产物契约 | `registry.json` 条目：`{ref, type, title, version, installed, installed_at, capabilities[], requires{}, source}`；ref 形态 `WORKS-local-*` / `WORKS-src-<slug>` / `WORKS-<数字>` |
| 守卫 | `test/works-source.test.mjs`、`chain.test.mjs`（安装→check→卸载全过） |
| 变更规则 | registry 字段只增不删；`ref` 形态是消费方（check/show/uninstall/依赖解析）的键，不可改格式 |

## S4 安装 → S5 部署

| 项 | 内容 |
|---|---|
| 工件 | `.works` 双段文本：`%%%WORKS-META%%%`（JSON）+ `%%%WORKS-CODE%%%`（部署配置 JSON） |
| 消费方 | `dsh-deploy loadConfig`、控制面 `/control/create {worksFile|worksInput}` |
| 校验 | `validateWorksFormat`（META：name/brief/view）+ `validateWorksDeployment`（CODE：deployment.source 必填、type=domain、runtime/launcher 形状）——三处消费方（deploy/控制面/安装）同一口径 |
| 守卫 | `test/works-parser.test.mjs`、`seam.test.mjs S4`、`deploy.test.mjs` |
| 变更规则 | META 标记字符串是格式本体不可改；`schema_version` 升级需三处消费方同步；`view.kind` 新枚举需所有消费方显式支持 |

## S5 部署 → S6 运行

| 项 | 内容 |
|---|---|
| 工件 | domain manifest：`components[]`（suite 路径）+ `runtime.bindings[]` / `removeRows[]`（行引用）+ suite 链的行声明（manifest `rows[]` + 各级 `cordis.patch.yml` 的 insert `id:`）+ **suite 根 `services.json`**（服务解耦 spec，broker 形状；可选） |
| 消费方 | `createRuntime`（SDK/CLI）、控制面 |
| 校验 | `validateDomainManifest` + `composeSuites` 冲突检测 + **`auditRowCoverage` 行覆盖审计**——bindings/removeRows 引用的每个行 id 必须在组件链有声明，否则运行时会**静默失去宿主**（ppt-workbench-host 事故的教训：行不存在≠错误、零日志）。审计已接入 `dsh-deploy validate`，配置阶段即拦 |
| 服务 | 有 `services.json` 的 suite：runtime 把它物化成 `<runtime>/service-manifest.json`（`portFrom: "content"` → 绑 content 端口；`dirFrom: "contentState"` → `--dir` 指向 runtime 内容目录），并拉起 `dsh-service-broker` 执行/守护；**runtime 不直接 spawn 业务服务**（服务解耦标准）。broker 端口/服务端口都进 runtime 端口租约，`stopRuntime` 先停 broker 再按 discovery 补杀服务 |
| 守卫 | `seam.test.mjs S5`（真实 PPT domain 永久守卫 + 负路径）、`deploy.test.mjs` E2E、`workspace-service` PPT E2E（broker + relay + workspace 落库）、`verify-chain` |
| 变更规则 | 行 id 是部署↔运行的咬合键；改行 id 必须同步 domain bindings/removeRows 与 patch 声明，审计会兜底。服务 spec 保持 broker 契约；`portFrom`/`dirFrom` 是 runtime 物化约定（broker 忽略），新增服务优先复用 suite `services.json` |

### stack v2：一份清单两种 kind（2026-11-03）

`dsh-stack.json` 增加 `kind: "profile" | "domain"`（缺省 profile）：

- **profile**：仍编译 `<home>/profiles/<profile>/package.json` + `<stateDir>/stack-services.json`；
- **domain**：`domain.source` 指向 `dsh-domain.json`，由 `dshd` 交给 `dsh-suite-kit`
  的 `createRuntime/startRuntime`；插件行、suite `services.json`、端口/覆盖项全由 domain 决定。
  `dshd stack plan/apply/start/status/doctor/stop --stack <file>` 同一入口。
- 端口映射：`ports.proxy→runtime.harness`、`ports.upstream→runtime.dsh`、
  `ports.content→runtime.content`、`ports.broker→runtime.broker`、
  `ports.services.*→suite 服务端口偏好`；`domain.runtimeId` 默认 `rt-stack-<slug>`（start/stop 幂等）。
- 守卫：`tools/dsh-launcher/test/domain-stack.test.mjs`（plan→apply→start→status/doctor→stop→复用，
  真实 dsh + broker + suite 服务，外部栈基线不变）。

### 产品交付层：product-packager（2026-11-03）

```text
product.json（base + launchers + infra）
  → tools/product-packager
  → dist-products/<name>/（dsh.exe + node + app + data）

base dsh（profile stack：dsh-base/web-app + dsh-launchpad + 基建）
  └─ launchpad 服务：列出/启动 launcher
       └─ launcher（domain stack）→ 独立 domain runtime（dsh+broker+services）
```

- **输入契约**：`products/<name>/product.json`（schema：`tools/product-packager/product.schema.json`）；
  `base.bundles/dependencies` 是本地包路径，`launchers[].domain` 是 `dsh-domain.json` 路径，
  `infra[]` 是随包复制的基建包。打包器**不认识任何具体 launcher**。
- **输出契约**：`app/product.json`（解析后唯一清单）+ `app/launchpads/*.stack` + `app/launchers/*/domain`
  + `app/bootstrap.mjs`（通用 start/stop/status/doctor/logs/open）+ `dsh.exe`（薄壳）。
- **执行**：base 走 profile stack；launcher 走 domain stack；管理器 `dsh-launchpad` 的
  domain DSL handler + runtime.json 状态读取是唯一 UI 入口；不复制编排逻辑。
- **可移动**：首次启动由 `bootstrap.mjs` 按当前产品路径重建 base profile 链接（junction），
  不写构建机绝对路径。
- **守卫**：`tools/product-packager/test/product.test.mjs`（manifest→DSL→staged domain→dshd plan）；
  实机产品启动证据见 `docs/reports/PRODUCT_PACKAGING_2026-11-03.md`。

## S6 运行 → S7 消费（控制面）

| 项 | 内容 |
|---|---|
| 工件 | HTTP：`POST /control/create {domainInput | worksFile | worksInput}`、`/control/start|stop|list|doctor`、`/healthz` |
| 生产方 | `dsh-runtime-control/lib/host.mjs` |
| 消费方 | 桌面前端/上层编排 |
| 校验 | .works 输入双层校验后转 domain；校验失败 → **400** 带错误清单 |
| 守卫 | `dsh-runtime-control/test/e2e.test.mjs`（domain 线 + .works 线 + 400 负路径） |
| 变更规则 | 端点只增不删；错误响应恒为 `{ok:false, error}` + 4xx/5xx 语义 |

## S8 登录 → 插件（会话快照契约）

| 项 | 内容 |
|---|---|
| 工件 | `GET {tokenUrl}` → `{logged_in, token, token_name?, username?, url}`；**仅回环 127.0.0.1**（非回环 403） |
| 生产方 | 桌面前端 backend（`routes/account.py`，仓库外） |
| 消费方 | `dsh-llm-tempkey`（`discoverToken`，三级解析 config→tokenUrl→env） |
| 校验 | 形状消费；未登录 → `{logged_in:false, token:""}`（不报错） |
| 守卫 | tempkey `plugin.test.mjs`（tokenUrl 发现模式用例） |
| 变更规则 | 双方只守这一个端点契约（解耦标准）；端口口径：开发态 3310 / 部署态 8850 |

## S9 平台 → 插件（LLM 配置契约，apikey/url/model 全部来自平台）

| 项 | 内容 |
|---|---|
| 工件 | `POST /api/keys/issue` → `{api_key, key_prefix, expires_at, hold_id, held_points}`（apikey）；`GET /api/llm/config` → `{base_url, models[{id,name?}], ttl_seconds?}`（url/model，**P3 平台端待实现**） |
| 生产方 | ddr0 平台（外部，port-8217） |
| 消费方 | `dsh-llm-tempkey`（签发/轮换 + 中转上游动态切换） |
| 校验 | 403 停发；`/api/llm/config` 404 → **安静回退静态配置**（`upstreamSource: platform|config` 如实标注） |
| 守卫 | tempkey 12 条测试（含平台下发切换 / 404 回退） |
| 变更规则 | 平台端实现契约后客户端零改动生效；字段只增不删 |

---

## 独立性清单（verify-chain 逐项验证）

| 环节 | CLI 入口 | 独立测试 |
|---|---|---|
| 生产 | `create-plugin.mjs` | scaffold.test.mjs |
| 打包 | `pack-plugin.mjs` | pack.test.mjs |
| 分发+安装 | `dsh-works.mjs` | works-source.test.mjs |
| 部署 | `dsh-deploy.mjs` | deploy.test.mjs（E2E） |
| 运行 | `dsh-runtime.mjs` | runtime.test.mjs / seam.test.mjs |
| 组装 | `dsh-assembly.mjs` | catalog/resolver/emitter/scanner.test.mjs |
| 控制面 | （ctx 服务 + HTTP） | runtime-control e2e |
| 登录/平台消费 | （插件） | tempkey plugin.test.mjs |

## 接缝测试归属

- **生产→安装（S1-S3）**：`plugin-development/test/chain.test.mjs`
- **安装→运行（S4-S5）**：`packages/dsh-suite-kit/test/seam.test.mjs`
- **运行→消费（S6）**：`packages/dsh-runtime-control/test/e2e.test.mjs`
- **登录/平台（S8-S9）**：`extensions/official/dsh-llm-tempkey/test/plugin.test.mjs`
- **一键全链**：`npm run verify-chain`

---

## 基础设施层 vs 功能层（添加新功能时你只需要写什么）

> 原则：**基础设施管"怎么做"（传输/校验/打包/锁/CLI），功能层只管"做什么"（业务语义）**。
> 判断标准：换一个业务功能这段代码一行不改的，就是基础设施。

### 已有基础设施（写新功能直接用，禁止再手写）

| 模块 | 能力 | 消费方式 |
|---|---|---|
| `dsh-plugin-kit/src/service/http.mjs` | JSON 响应（安全头/HEAD/死 socket 防护）、body 读取（上限/BAD_JSON/断连兜底）、loopback listen | `import { send, readBody, listen } from 'dsh-plugin-kit'` |
| `dsh-plugin-kit/src/cli.mjs` ✅新增 | `parseArgs`（旗标/位置参数）、`isMain`（导入守卫）、`fail`（统一失败出口） | 同上；bin 只写命令表+用法文本+业务逻辑 |
| `dsh-plugin-kit/src/store/*` | 原子 JSON 状态（journal-store）、sha256 内容寻址（blob-store） | 同上 |
| `dsh-plugin-kit/src/tools/validate.mjs` | 工具入参 schema 子集校验 | 同上 |
| `dsh-suite-kit` 校验器 | suite/domain manifest 结构校验、composeSuites 冲突、**auditRowCoverage 行覆盖** | 打包/安装/validate 全走同一真源 |
| `dsh-suite-kit` domain runtime 服务支持 ✅新增 | suite `services.json` → `<runtime>/service-manifest.json`；runtime 拉起 broker，broker 拉起/守护/登记服务；`portFrom`/`dirFrom` 物化约定 | domain/`.works` 部署自动获得服务解耦；PPT 是首个消费者 |
| `dsh-stack-kit` v2 + `dshd --stack` ✅新增 | `dsh-stack.json` 的 `kind: profile|domain`；domain 型委托 runtime，profile 型编译 profile+services；两种 kind 共用 start/stop/status/doctor/logs | 一份清单承载两类装配，不再分两套入口 |
| `tools/product-packager` + `product.json` ✅新增 | base 插件 + launcher 领域包 + infra → 便携产品（node + harness + app + `dsh.exe`）；launcher 是数据 | 新增产品/launcher 只改清单；编排复用 dshd/runtime |
| `dsh-suite-kit/lib/works-parser.mjs` | .works 双段解析 + META/CODE 分层校验 | 安装/部署/控制面同一口径 |
| `dsh-suite-kit/lib/works-source.mjs` + `zip-read.mjs` | index.json 源加载 + sha256/size 强校验 + ZIP 解包 | 分发消费 |
| `create-plugin.mjs` 模板 | 插件骨架（host/relay/server/contract/test/README） | `node create-plugin.mjs --name X --yes` |
| `extensions/official/dsh-llm-tempkey/lib/rotation-policy.mjs` ✅新增 | Key 轮换决策纯函数（宿主与进化评估器共用，仿真即真实行为） | 新计费/轮换策略只改此模块或替换之 |
| `evolution/chain-bench.mjs` ✅新增 | 链路热点基准（pack/zip/sha/manifest/resolve/audit），支持 --json A/B 对比 | `node evolution/chain-bench.mjs` |

### 样板迁移（本轮完成，证明"下沉"可行）

| 消费者 | 之前 | 之后 | 回归 |
|---|---|---|---|
| `dsh-runtime-control/lib/host.mjs` | 手写 jsonBody/send（无安全头/HEAD/断连兜底的劣化版） | plugin-kit `readBody`/`send`（白得健壮性） | e2e 2/2 |
| `bin/dsh-works.mjs` | 手写 parseArgs + 导入守卫 | plugin-kit `parseArgs`/`isMain`；顺手修复 `--auto-install` 死旗标（读驼峰键永不命中） | works-source 7/7 |

### 单一真源收敛（真源合并轮完成）

| 能力 | 真源 | 收敛动作 | 兼容 |
|---|---|---|---|
| **ZIP 读写** | `dsh-plugin-kit/src/zip.mjs`（写 store + 读 store/deflate，Buffer/路径双形态） | 3 处实现合一：`plugin-development/lib/zip.mjs`、`dsh-suite-kit/lib/zip-read.mjs` 变 shim；`tools/plugin-release` 内嵌 reader 换 re-export（签名不变） | 旧导入路径全保留；release 37/37、pack/chain/works-source 全绿 |
| **文件锁 + 原子写** | `dsh-plugin-kit/src/util/fs-lock.mjs`（withFileLock/withAsyncFileLock/writeJsonAtomic/readJson）——runtime-kit 本就是 shim | `dsh-works` 裸 readFileSync/writeFileSync 换 `writeJsonAtomic`（防半截文件） | ppt-bridge 快照走同步脚本惯例，不动 |
| **works 注册表分治** | `works-registry.json`（works 数据，dsh-works 专属）≠ `registry.json`（runtime 租约，带锁）——两套 schema 曾混写同一文件互相覆盖（实机文件已证实混存） | dsh-works 换独立文件 + 一次性收养迁移（旧文件有 works 数组才迁移，租约文件不动） | 旧路径自动收养；第三方写旧文件者（dsh-flow-engine worksreg）待对齐 |

### 待迁移路线（按收益排序，迁移时以现有测试为安全网）

1. **其余 bin 迁 cli-kit**：dsh-suite/dsh-domain/dsh-assembly/pack-plugin/create-plugin 的定制解析（语义各异，逐个对齐；dsh-runtime 已完成）。
2. **ppt-bridge 快照再生机制确认**：3 份 fs-lock 等快照由 sync 脚本生成——确认同步真源指向 plugin-kit，杜绝手改。
3. **mock fetch 测试助手**：tempkey 与 evolution evaluators 各一份可编程 mockFetch——提炼为 test-kit。
4. **第三方 works 注册写入口对齐**：`dsh-flow-engine/server/worksreg.mjs` 仍写旧 registry.json——迁 works-registry.json 或沉淀进 plugin-kit。
5. **双工具链归并**：`tools/plugin-*` vs `plugin-development/*`。2026-11-03 已把两条生成器对齐到同一 validator + 发布闸口径（category/platform、dsh-plugin-kit、engines.dsh）；归并本身仍待做。

### 添加新功能时的分工对照

| 你要做的 | 你写的（功能层） | 你不用写的（基础设施层） |
|---|---|---|
| 新插件 | 业务 server 逻辑（tools/impl）+ 工具契约 | HTTP 传输、入参校验、骨架/打包/清单校验/分发/安装（模板+CLI 全覆盖） |
| 新启动清单 | 一个 dsh-domain.json + 一个 .works | 结构/冲突/行覆盖三道校验、启动/健康检查/端口分配（deploy+runtime 全覆盖） |
| 换模型/换扣费 | works 里改 `runtime.model` 字段 / 平台契约下新增字段消费 | 中转、凭据轮换、注入缝、401 重签（tempkey 宿主全覆盖） |
| 新接缝 | 契约条目（CHAIN_CONTRACTS 补一节）+ 接缝测试 | 校验分层模式、CLI 接入、审计接入 |



> 守卫：`packages/dsh-suite-kit/test/extensibility.test.mjs`（E1-E4 演练）

## 拓展性矩阵（四个常见扩展场景 × 触碰面）

> 守卫：`packages/dsh-suite-kit/test/extensibility.test.mjs`（E1-E4 演练）

### 场景①：新增一个插件
| 动作 | 触碰面 | 证据 |
|---|---|---|
| 从零走全链 | `node create-plugin.mjs --name X --yes` → `pack-plugin.mjs` → index.json 加条目 → `dsh-works install` —— 全程 CLI，零代码 | chain.test.mjs（真实执行一遍） |
| 加入既有启动清单 | domain 的 `components[]` 加一项（行引用需在组件链有声明，审计兜底） | extensibility E2 |
| 防呆 | binding 拼错/漏声明 → `dsh-deploy validate` 行覆盖审计点名 | extensibility E4 + seam S5 |

### 场景②：新的启动清单（新 domain）
| 动作 | 触碰面 | 证据 |
|---|---|---|
| 新清单 | **新写一个 dsh-domain.json**（组件从既有 packages 挑）→ validate + 行覆盖审计过 → `.works` 指向它即可 deploy | extensibility E1（ws-state 组合清单，零代码） |
| 校验兜底 | 结构（validateDomainManifest）/冲突（composeSuites）/行覆盖（auditRowCoverage）三道，全在 validate 阶段 | deploy validate 输出 |

### 场景③：切换模型
| 动作 | 触碰面 | 证据 |
|---|---|---|
| 部署级换模型 | works/domain 的 `runtime.model` 改一个对象 → 部署配置随数据切换（works 覆盖 domain 基线，缺省回落） | extensibility E3 |
| 上游/模型平台化 | `GET /api/llm/config` 下发 base_url+models → 中转上游动态切换，`upstreamSource` 如实标注 | tempkey 测试（平台下发切换） |
| **边界（诚实声明）** | pi-ai 路由的 models 静态列表仍是 cordis.patch.yml 声明（改后需重启）；平台下发 models 目前只做对账告警——**完全热切换模型需 pi-ai 侧支持，属后续项** | cordis.patch.yml 注释 |

### 场景④：新的扣费方式
| 动作 | 触碰面 | 证据 |
|---|---|---|
| 计费语义在平台端（预扣/结算/退款） | 客户端契约只有 `/api/keys/issue` + `/api/me` —— 平台改计费语义但契约不变 → **客户端零改动** | CHAIN_CONTRACTS S9 |
| 契约演进 | 平台加字段/端点 → 契约"只增不删"，客户端按需消费（`upstreamSource` 即先例） | tempkey 测试（404 回退） |
| 换客户端实现（如包月固定 Key） | 平台接触面收敛在 `lib/ddr0.mjs` 单模块（纯函数+可注入 fetch，host.mjs 全部经它调用）——换实现=换一个模块或并一个 provider 插件；中转+`apiKeyEnvRef` 注入缝不变，pi-ai 路由改指新中转端口即切换 | host.mjs 结构（8 处调用全经 ddr0.*） |
