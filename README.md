# dsh 插件工程

**本仓库只做两件事：构建 dsh 插件，以及把插件组合成可运行环境。**

不改 dsh 源码。dsh 是 npm 依赖（`@deepseek-ai/dsh`），所有扩展都通过 Cordis 官方扩展点
（`cordis.patch.yml` 的 `insert`）注入；仓库内 40 个 patch 操作全部是 `insert`，
没有 `update`/`remove`。

> dsh 宿主与产品交付在 `../dsh-runtime/`（见其 README）；历史归档在 `../dsh-archive/`。
> 本仓库只保留造插件与组合插件所需的代码。

---

## 四层结构

```
packages/     插件基础设施        构建插件所需的库 + 基建级插件
  ├─ 纯库（不加载进 dsh）
  │    dsh-plugin-kit     插件 SDK：HTTP/MCP、单实例锁、校验、技能 provider、存储、编辑器租约、打包
  │    dsh-suite-kit      suite/domain 清单与打包
  │    dsh-assembly-kit   组件扫描 → suite manifest
  │    dsh-runtime-kit    运行时内核（re-export plugin-kit）
  │    dsh-contracts      接口契约（DIContainer 已废弃，见其 MIGRATION 文档）
  │    dsh-stack-kit      启动清单编译器（把 stack.json 编译成 profile + broker 清单）
  └─ 基建级插件（bundle + suite）
       service-broker  服务进程编排（拉起/守护/discovery）
       service-host    服务宿主
       tool-host       工具宿主
       state-service   状态
       asset-service   资产
       workspace-service  工作区
       editor-host     编辑器宿主
       mcp-gateway     MCP 网关
       catalog         组件目录
       installer       安装器
       runtime-control 运行时控制

tools/        插件工具链
  plugin-generator   脚手架（create-plugin）
  plugin-validator   结构与规范校验
  plugin-release     zip / index / 整源包发布
  dsh-launcher       dshd：按 stack 拉起 broker + dsh + 服务
                     需要 dsh 宿主：DSH_HARNESS_DIR 或 ../dsh-runtime/apps/harness/deepseek-harness

extensions/   插件本体
  official/     capyclaw-launchpad、llm-tempkey、port-sidebar、scrapling、ddr0-client
  bridges/      ppt-bridge（workbench + 8 个 skill + suite）、canvas-bridge
  flow/         dsh-flow-engine（+ suite）
  llm-config/   dsh-llm-config（+ suite）

docs/         插件工程文档（guides / architecture / reference）
scripts/      插件生命周期自动化（校验、测试、发布、漂移检查）
launchpads/   插件组合的运行清单（*.stack DSL）
examples/     示例插件
tests/        性能与稳定性套件
research/     插件模块的实验与基准
vendor/       插件依赖的第三方领域执行器（flow-executor）
templates/    插件 README 模板
```

---

## 快速开始

```bash
npm install                    # 建立 workspace 链接

npm run validate-all           # 校验所有插件
npm run test-all               # 跑所有插件测试
npm run test-release           # 发布工具测试
npm run verify-all             # 全量校验
```

新建插件：

```bash
npm run create-plugin -- --name my-plugin
npm run validate-plugin -- extensions/official/my-plugin
```

---

## 插件长什么样

```js
// lib/index.mjs
export const name = 'my-plugin'
export const inject = ['skills']            // 声明依赖的服务

export function apply(ctx, config) {
  const skills = ctx.skills                 // 读取一次，热路径用局部变量
  ctx.provide('myService')                  // Cordis v4：必须先 provide 再赋值
  ctx.myService = { /* ... */ }

  ctx.on('dispose', () => { /* 清理 */ })
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: my-plugin
      name: "my-plugin"
      config:
        option: value
```

```json
// package.json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

**性能要点（实测）**：`ctx.x` 单次读取约 7 µs（Proxy + 反射）。在 `apply()` 顶部取到局部变量，
循环内不要出现 `ctx.x` —— 实测快 741~775 倍。详见 `tests/performance/README.md`。

---

## 给插件传参数（启动器负责注入）

插件自己**不写死**端口 / URL / 路径；一律按 `ctx config → 环境变量 → 代码默认值` 解析
（`dsh-plugin-kit/config` 的 `resolveConfig`）。想改参数时，由启动清单注入，不改插件代码：

```jsonc
// dsh-stack.json
{
  "plugins": {
    "bundles": [{ "name": "@capyclaw/launchpad", "path": "../extensions/official/capyclaw-launchpad" }],
    "configs": [
      {
        "name": "@capyclaw/launchpad",
        "row": "launchpad-host",          // 该包 patch 只有一个 insert 行时可省略
        "config": { "port": 39777, "strict": true }
      }
    ]
  }
}
```

DSL 写法（`launchpads/*.stack`）：

```text
plugins {
  plugin "@capyclaw/launchpad" { path "../extensions/official/capyclaw-launchpad" }
  config "@capyclaw/launchpad" {
    port 39777
    strict true
  }
}
```

生成的覆盖行写在 profile 的 `cordis.patch.yml` 的**受管区块**里，区块外你手写的内容不会被覆盖：

```yaml
# >>> dshd:managed（由 stack.plugins.configs 生成，勿手改）
- id: launchpad-host
  name: '@capyclaw/launchpad'
  config:
    roots: []
    includeProfiles: true
    strict: true            # ← 来自 stack
    port: 39777             # ← 来自 stack
# <<< dshd:managed
```

要点：

- **默认值不会丢**：dsh 的 patch 覆盖是整键替换，所以 dshd 先读插件自己的 patch，深合并后再写完整 config。
- **行不存在就报错**：`row` 写错会直接失败并列出可用行，不会静默用默认值跑。
- **密钥不放进 stack**：需要密钥的插件用 `*Env` 字段引用环境变量（例如 `apiKeyEnv: DEEPSEEK_API_KEY`）。
- 排查用 `npm run dshd -- stack config --stack <file>`，会打印「默认 / 覆盖 / 合并」三份值。

---

## 运行中的插件集合由谁管

两条路径，职责不同：

| 角色 | 位置 | 管什么 |
|---|---|---|
| `dshd`（CLI） | 仓库外进程 | **启动** dsh：编译 profile、拉 broker、起服务 |
| `@capyclaw/plugin-sync`（dsh 插件） | dsh 进程内 | **运行中**的插件集合：报告差异、按清单开关 bundle / 插件行 |

`plugin-sync` 不自己实现开关，全部转发给 dsh 原生 `pluginManager`：

```js
ctx.pluginManager.setBundleEnabled(name, enabled)     // 包级：不参与组合，依赖保留
ctx.pluginManager.setPluginEnabled(entryId, enabled)  // 行级：profile patch 写 disabled
```

```bash
# 看清单 vs 实际的差异（只读）
curl -s http://127.0.0.1:<dsh代理端口>/__plugin_sync__/report | jq .report.diff

# 按清单执行（两级开关）
curl -s -X POST http://127.0.0.1:<dsh代理端口>/__plugin_sync__/apply   -H 'content-type: application/json'   -d '{"changes":[{"op":"bundle","name":"@capyclaw/launchpad","enabled":false}]}'
```

清单源本轮只实现**本地 JSON**（`sourceKind: local` + `sourcePath`）；HTTP 源保留接口，
将来「通过链接外部数据确定启动清单」在 `plugin-sync/lib/sources/index.mjs` 接。

---

## 端到端验证（插件工程 ↔ 仓外 dsh）

```bash
npm run test-e2e
```

这条测试只要求 `DSH_HARNESS_DIR` 指向任意 dsh 宿主，然后真实启动一套隔离栈，断言：

1. 仓库外的探针插件被**注入并激活**（`pluginInventory` 的 `fiberPhase: active`）
2. 包级开关：`setBundleEnabled(false)` → 注入消失、**依赖保留**
3. 行级开关：`setPluginEnabled(entryId,false)` → profile patch 出现 `disabled: true`
4. 管理插件 `plugin-sync` 用清单驱动同一套开关

> **务必记住**：`GET /` 200 只说明 web 必需 entry 活着，**不能**作为插件激活证据。
> 另外 dsh 在 entry 被禁用时**不会调用插件的 dispose**，所以插件 `apply()` 必须可重复执行。

---

## 插件分发（开发 → npm）

**两种模式，完全适配 dsh 原生机制**（即使 dsh 更新也不会破坏）：

| 阶段 | 模式 | dependencies 格式 | 命令 |
|---|---|---|---|
| **开发** | `development` | `"link:/path/to/dist"` | `node tools/install-plugins.mjs --mode development` |
| **生产** | `production` | `"^1.0.0"` | `node tools/install-plugins.mjs --mode production` |

两者都直接操作 `~/.dsh/profiles/<name>/package.json`，交给 dsh 的 pnpm 处理依赖。

### 开发阶段（本地 link）

```bash
# 1. 生成 registry
npm run gen-registry

# 2. 批量注册插件到 profile（link 本地目录）
node tools/install-plugins.mjs   --registry ./capyclaw-registry.json   --target ~/.dsh/profiles/web   --mode development   --install

# 3. 启动 dsh
dsh --profile web
```

### 生产阶段（npm registry）

```bash
# 1. 发布到 npm（一次性）
npm publish extensions/official/capyclaw-launchpad --access public

# 2. 用户安装
node tools/install-plugins.mjs   --registry https://your-cdn.com/capyclaw-registry.json   --target ~/.dsh/profiles/web   --mode production   --install
```

详见 [docs/PLUGIN_DISTRIBUTION.md](docs/PLUGIN_DISTRIBUTION.md)。

---

## 发布到 npm

```bash
npm run gen-registry        # 从各 package.json 生成 capyclaw-registry.json（不要手改）
npm run check-registry      # 校验 registry 与 package.json 一致
npm run verify-publishable  # 目标可安装性：pack → 扫密钥/绝对路径 → 装进干净目录
node scripts/publish-to-npm.mjs --dry-run    # 预览
node scripts/publish-to-npm.mjs --execute    # 真正发布
```

发布闸会拦下：`private: true`、缺 `publishConfig.access`、缺 `engines.dsh`、缺 `bundle.patch`、
依赖里出现 `link:`/`file:`。`tools/plugin-release` 另有 zip 分发路径（`release-all` + `index` + `verify`）。

---

## 命令一览

| 命令 | 作用 |
|---|---|
| `npm run create-plugin` | 生成插件脚手架 |
| `npm run validate-plugin <dir>` | 校验单个插件 |
| `npm run validate-all` | 校验所有插件（递归覆盖 `extensions/*`） |
| `npm run test-all` | 跑插件测试 |
| `npm run release-plugin <dir>` | 打插件 zip |
| `npm run release-all` | 打包全部可发布插件 |
| `npm run verify-publishable` | 检查可安装性（pack / 密钥 / 绝对路径 / 依赖解析） |
| `npm run gen-registry` | 从 package.json 生成 registry |
| `npm run test-stack-kit` | stack 编译器测试 |
| `npm run test-stack-chain` | launcher 链路测试 |
| `npm run test-perf` | 性能与稳定性套件 |
| `npm run dshd -- stack config --stack <file>` | 看插件配置合并结果 |
| `node scripts/compile-stack.mjs <x.stack>` | 把 launchpads DSL 编译成 dsh-stack.json（dshd 只认 JSON） |
| `npm run dshd -- start --stack <file>` | 按清单起 broker + dsh + 服务 |
| `npm run verify-all` | 全量校验 |

---

## 设计原则

1. **不改 dsh 源码**：只用 Cordis 扩展点（bundle patch / suite / domain）
2. **插件间不直接拉起**：服务由 `dsh-service-broker` 统一编排，跨端口组织只经过中间件
3. **包级依赖单向**：`extensions → packages`，反向只允许通过契约
4. **性能写法统一**：热路径用局部变量，不反复读 `ctx`

详见 [ARCHITECTURE.md](ARCHITECTURE.md) 与 [docs/architecture/contracts.md](docs/architecture/contracts.md)。

---

## 许可证

MIT
