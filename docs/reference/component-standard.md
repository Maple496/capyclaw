# DSH 功能组件注册标准（2026-11-04 起强制）

> 一句话：**「实现一个功能要注册哪些组件」只有一个答案——`dsh-suite.json`。
> 组合看 domain，启动看 stack，运行期激活看 suite 自动生成的注册表；
> 其余一切格式都是这条链的编译产物或分发包装。**

## 三层模型

```
功能层  dsh-suite.json     声明「这个功能 = 哪些包/行/服务/检查」   ← 唯一注册点
组合层  dsh-domain.json    选择哪些 suite 一起跑 + runtime.requires 启动门禁
启动层  launchpads/*.stack DSL → dsh-stack.json → dshd               ← 唯一作者启动面
运行期  <profile>/launch-engine.registry.json（由 suite 组合结果自动编译）
```

### 1. 功能层：`dsh-suite.json` 是唯一的组件注册点

一个功能的全部组件声明写在这里，别的文件不许再发明一份：

| 段 | 回答的问题 | 语义 |
|---|---|---|
| `packages.<name>` | 有哪些包 | `role`（runtime/skills/provider/ui/bridge/support）、`version` 范围、`path` |
| `packages.<name>.requires` | 依赖什么 | 包名范围或 `capabilities: {<cap>: <range>}`（semver，compose 时强校验，缺提供者/major 不兼容 = 错误） |
| `packages.<name>.provides` | 对外提供什么 | `tools[]`、`skills[]`、`services[]`、`ports[]`、`capabilities: {<cap>: <version>}` |
| `rows[]` | dsh 进程内挂哪些插件行 | `{id, name, config}`；`id` 即 entryId（`include:<rowId>`） |
| `services.json` | 跑哪些独立服务进程 | [统一服务 spec](./service-standard.md)（`@capyclaw/service-broker/service.schema.json`） |
| `checks[]` | 怎么验收 | http 健康检查 + contract 工具 major 检查 |
| `components[]` | 引用别的 suite | 装载期展开合并（components 的 rows 在前） |

`requires`/`provides` 的 capability 匹配在两个时点强制：
**compose 时**（`dsh-suite-kit/src/compose.mjs`，缺提供者报错）与
**runtime 创建时**（`checkRuntimeRequirements`，端口分配前拦截）。

### 2. 组合层：`dsh-domain.json` 选择与门禁

domain 只做两件事：`components` 选哪些 suite、`runtime.requires` 声明
启动门槛（tools/services/capabilities）。选中即装、未选不装；门禁不满足
在创建 runtime 前报错。端口/模型/scope/rowOverrides 也是 domain 的职责。

### 3. 启动层：stack DSL 是唯一作者启动面

- 作者写 `launchpads/*.stack` DSL（capyclaw-launchpad 管理/编译），
  产物是 `dsh-stack.json`（`packages/dsh-stack-kit/stack.schema.json`），
  `dshd --stack` 只认这份 JSON；
- `kind "profile"`：轻量 dev 栈（自选 bundles + 自选服务），
  由 dsh-stack-kit 物化 profile + `stack-services.json`；
- `kind "domain"`：功能栈，指向一个 domain，交给 dsh-suite-kit runtime；
- 端口别名：domain 语义的 `harness`/`dsh` 在装载期归一为 `proxy`/`upstream`
  （规范名优先），两套命名不再漂移。

### 4. 运行期激活：注册表由 suite 自动生成，不手写

`dsh-suite-kit` 的 `installSuites`/`installDomain` 把组合结果编译成
`<profile>/launch-engine.registry.json`（`dsh-suite registry` /
`dsh-domain registry` 可预览），`@capyclaw/launch-engine` 用
`registryKind: profile` 读它。映射规则：

- 每个包 = 一个激活 capability（有 row、拥有服务进程、或是组合内被
  required 能力的提供方三者其一即可见）：`entries` = rows，
  `requires` = 包 requires.capabilities 解析到的提供方包；
- 每个套件 = 一个聚合 capability：`bundles` = [{name: 套件名}]
  （installSuites 把套件名写进 `dsh.profile.bundles`），
  收编无主行与服务；
- `services` 编译期展开 `${PACKAGE_DIR}`、剥除 `portFrom`/`dirFrom`
  （那是物化期提示）；`${PORT}` 留给 broker 仲裁。

## 格式归属表（谁编写、谁消费）

| 格式 | 层 | 编写 | 消费 | 状态 |
|---|---|---|---|---|
| `dsh-suite.json`（+`services.json`） | 功能 | 功能作者 / `dsh-assembly-kit` 生成 | suite-kit compose/install/runtime；launch-engine 注册表 | ✅ 标准 |
| `dsh-domain.json` | 组合 | 领域作者 | suite-kit resolve/createRuntime；dshd；dsh-deploy | ✅ 标准 |
| `launchpads/*.stack` DSL | 启动(作者) | 用户/作者 | launchpad 编译 → dsh-stack.json | ✅ 标准 |
| `dsh-stack.json` | 启动(契约) | DSL 编译产物 | dsh-stack-kit / dshd / suite-kit runtime | ✅ 生成物，勿手改 |
| `<profile>/launch-engine.registry.json` | 运行期 | suite-kit 自动生成 | @capyclaw/launch-engine | ✅ 生成物，勿手改 |
| `stack-services.json` / `service-manifest.json` | 服务 | stack-kit / suite-kit 生成 | dsh-service-broker（同一 spec：`service.schema.json`） | ✅ 生成物 |
| `.works` / deployment json | 分发 | 作品作者 | dsh-deploy → `deployment.source` 指向 domain | 包装层 |
| `product.json` / `launcher.json`(ZIP) | 分发 | 产品构建 | product-packager → `stageDomain` + 种子 stack | 包装层（仓库外） |
| ~~`dshd.config.json` + `local-services.json`~~ | 启动 | — | — | ❌ 已删除（2026-11-04），统一 `--stack` |
| ~~`tools/launch.mjs` / `launch-by-manifest.mjs`~~ | 启动 | — | — | ❌ 已删除 |
| ~~`simple/unified/web-launcher.mjs`~~ | 启动 | — | — | ❌ 已删除 |

**两套 profile 物化器的边界**（有意保留，不合并）：profile 型轻量栈归
dsh-stack-kit（`compileProfile`），domain 型功能栈归 dsh-suite-kit
（`installSuites`）；同一个 profile 不要两边同时写。

## 标杆：PPTist 编辑工作台

「能编辑 PPTist 的系统」由三层文件完整回答，不再有第二种说法：

```text
功能层  extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-suite/dsh-suite.json
        4 公共基建(service/tool/asset/editor-host) + @capyclaw/ppt-workbench
        (PPTist 编辑器 + ppt_* MCP 工具, 服务进程 39311) + 8 个 skill 包
        + broker/skills 服务 + mcp-ppt 行 + healthz/contract 检查
组合层  extensions/bridges/ppt-bridge/domains/ppt/dsh-domain.json
        baseBundles + components + runtime.requires(8 项 capability 门禁)
启动层  launchpads/ppt.stack（kind domain）→ ppt.dsh-stack.json
        npm run dshd -- start --stack launchpads/ppt.dsh-stack.json
验收    suite checks：/healthz → {ok:true, contractsOk:true}；
        ppt_capabilities contractVersion major=2
运行期  dsh-domain registry extensions/bridges/ppt-bridge/domains/ppt
        → workbench/skills/基建/套件聚合的完整激活图
```

新增一个功能 = 写一个 `dsh-suite.json`（+必要的 `services.json`/包），
挂进某个 domain 或新建 domain，加一行 stack。不需要碰任何中央注册表。
