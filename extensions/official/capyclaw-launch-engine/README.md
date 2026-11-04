# @capyclaw/launch-engine（按需激活引擎）

把「根据要求启动关联插件」做成 dsh 进程内的**组合根**（容器注入的落地形态）：
本插件不 new 任何服务对象，它按 capability 注册表把「要求」解析成有序激活动作，
把插件定义注入运行中的 Cordis 树，装配由 Cordis DI 完成。

**它不自己实现任何开关**：

| 动作 | 转发给 |
|---|---|
| bundle / entry 开关 | `ctx.pluginSync.apply`（内部再转发 dsh 原生 `pluginManager.setBundleEnabled` / `setPluginEnabled`） |
| 服务进程（激活 / 停用） | `ctx.serviceBroker.start` / `ctx.serviceBroker.stop`（broker 统一编排，幂等、复用优先） |
| 激活证据 | `pluginManager.listPlugins()` 的 `enabled && fiberPhase === 'active'` |

进程生命周期（起停 dsh / broker / 守护）仍归 `dshd`（`tools/dsh-launcher`）——
插件活在 dsh 进程里，引导职能天然不能插件化。

## 能力注册表

声明「要求 → 关联插件」。四种来源：

- **`profile`（domain 型 profile 推荐）**：读 suite-kit 安装期生成的
  `<DSH_HOME>/profiles/<DSH_PROFILE>/launch-engine.registry.json`——
  它由 `@capyclaw/suite-kit` 的 `installSuites`/`installDomain` 从 `dsh-suite.json`
  组合结果**自动编译**（`dsh-suite registry` / `dsh-domain registry` 可预览），
  注册表不再手写，`dsh-suite.json` 是唯一事实来源；
- `local`（registryPath 指向文件）/ `inline`（config.capabilities 直接给）：手写或工具注入；
- `http`：预留，显式 NOT_IMPLEMENTED。

```jsonc
// registryKind: profile 时由 suite-kit 自动生成，结构如下（local/inline 同构）
{
  "version": 1,
  "capabilities": {
    "skills": {                       // 依赖闭包的底座能力
      "bundles": [{ "name": "dsh-skills-bundle" }],
      "entries": [{ "entryId": "include:skills-provider" }]
    },
    "ppt": {
      "title": "PPT 工作台",
      "requires": ["skills"],         // 依赖的其他 capability，先激活（拓扑序）
      "bundles": [{ "name": "@capyclaw/ppt-bridge" }],
      "entries": [{ "entryId": "include:ppt-workbench" }],
      "services": [{ "id": "ppt-workbench", "cmd": ["node", "server.mjs"], "ports": { "main": 39311 } }]
    }
  }
}
```

- `requires` 成环、引用未注册能力、结构非法都会**诚实报错**（不静默）
- `enabled: false` 表示「该能力要求此项关闭」（如互斥替代项）
- `services` 其余字段（cmd/env/ports/url…）原样透传给 broker，由 broker 侧校验

## 工作方式

激活 = 逐波执行（每波一个 capability，依赖在前；跨波 bundle/entry/service 去重）：

```
① 重读实际状态，裁掉已满足的开关（幂等）
② bundle→entry 顺序下发变更（pluginSync.apply）
③ 服务投递 broker.start
④ 验证：等本波 entry 全部 enabled && fiberPhase === 'active'（唯一可信证据）
⑤ 汇总：active / restart-required / degraded / failed（restart-required 不算成功）
```

停用 = 反向：波序倒转（先关依赖方）、entry→bundle、验证 entry 消失或 `enabled === false`。

## 使用

### ctx 服务（其他插件）

```js
export const inject = ['launchEngine']
// ctx.launchEngine.resolve(name)      → 计划（dry-run，不改状态）
// ctx.launchEngine.activate(name, {}) → 执行激活
// ctx.launchEngine.deactivate(name)   → 执行停用
// ctx.launchEngine.status()           → 逐 capability 满足度快照
// ctx.launchEngine.capabilities()     → 注册表摘要
```

### HTTP（默认开启，仅回环；写操作可加 token）

```bash
curl -s http://127.0.0.1:<dsh代理端口>/__launch_engine__/capabilities
curl -s http://127.0.0.1:<dsh代理端口>/__launch_engine__/status
curl -s -X POST .../__launch_engine__/resolve    -d '{"capability":"ppt"}'
curl -s -X POST .../__launch_engine__/activate   -d '{"capability":"ppt"}'
curl -s -X POST .../__launch_engine__/deactivate -d '{"capability":"ppt"}'
```

## 配置（ctx config → 环境变量 → 默认值）

| 字段 | env | 默认 | 说明 |
|---|---|---|---|
| `registryKind` | `DSH_LE_REGISTRY` | `inline` | `inline` / `local` / `profile` / `http`（domain 型 profile 用 `profile`；http 预留，显式 NOT_IMPLEMENTED） |
| `registryPath` | `DSH_LE_PATH` | 空 | local/profile 源 JSON 路径（每次操作重读；profile 空缺时按 `DSH_HOME`/`DSH_PROFILE` 推导） |
| `capabilities` | —（结构化） | `{}` | inline 注册表对象 |
| `enableHttp` | `DSH_LE_HTTP` | `true` | 是否挂 HTTP 路由 |
| `engineToken` | `DSH_LE_TOKEN` | 空 | 写操作 token（请求头 `x-launch-token`；空＝仅校验回环） |
| `verifyTimeoutMs` | `DSH_LE_VERIFY_TIMEOUT` | `60000` | 每波验证超时 |

domain 型 profile 直接 `registryKind: profile`（本插件套件的默认配置）；
手写注册表用 inline/local，由启动清单注入（`stack.plugins.configs`），不要写死在 `cordis.patch.yml`。

## 边界与阶段路线

- **阶段一（本版）**：只管已安装包的按需激活/停用；不碰进程生命周期
- **阶段二**：缺包现场安装（转发 `ctx.installer`）；配置行运行期注入
  （复用 `dsh-stack-kit` patch-block，需先划清 `>>> dshd:managed` 区块所有权）
- 注意：entry 被禁用时 dsh 不调 dispose，`apply()` 必须可重复执行（本插件遵守）；
  `restart-required` / `overridden` 如实冒泡，不当成功

## 测试

```bash
npm test
```
