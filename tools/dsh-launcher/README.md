# dsh-launcher（dshd）

**dsh + 插件全栈独立启动器**：把原本由桌面前端后端（`works_services.py`）执行的
启动清单，抽成一个零桌面依赖的独立程序。

启动入口只有 `--stack <dsh-stack.json>`（作者层是 `launchpads/*.stack` DSL，
由 capyclaw-launchpad 编译）；旧的 `dshd.config.json` + `local-services.json`
配置路径已删除。

```bash
npm run dshd -- start --stack launchpads/dev.dsh-stack.json   # 拉起 broker → dsh，就绪返回
npm run dshd -- start --stack launchpads/dev.dsh-stack.json --open        # 就绪后开浏览器
npm run dshd -- start --stack launchpads/dev.dsh-stack.json --foreground  # 前台守护（Ctrl+C 全停）
npm run dshd -- status --stack launchpads/dev.dsh-stack.json   # 运行态一览
npm run dshd -- doctor --stack launchpads/dev.dsh-stack.json   # 体检（pid + 端点响应）
npm run dshd -- stop   --stack launchpads/dev.dsh-stack.json   # 停服务 → 停 broker → 停 dsh
npm run dshd -- logs   --stack launchpads/dev.dsh-stack.json   # 日志文件列表
```

或直接：`node tools/dsh-launcher/bin/dshd.mjs <命令> --stack <file>`。

## 统一启动清单（`dsh-stack.json`）

一份 stack 同时决定 **profile bundles（插件） / broker 服务 / 端口 / DSH_HOME /
workspace / stateDir**，不再分别手改 profile `package.json` 和 `services.json`：

```bash
# 只读：看会生成什么 / 与现有 profile、服务清单是否漂移
node tools/dsh-launcher/bin/dshd.mjs stack plan --stack launchpads/dev.dsh-stack.json

# 物化：写 profile package.json + 生成 <stateDir>/stack-services.json
node tools/dsh-launcher/bin/dshd.mjs stack apply --stack launchpads/dev.dsh-stack.json

# apply + start
node tools/dsh-launcher/bin/dshd.mjs start --stack launchpads/dev.dsh-stack.json
```

生成物：

| 文件 | 内容 |
|---|---|
| `<home>/profiles/<profile>/package.json` | `dsh.profile.bundles` + `link:`/registry 依赖（保留其它字段与 `cordis.patch.yml`） |
| `<stateDir>/stack-services.json` | broker 的 `{services:[...]}` |

stack 的 schema、占位符和编译规则见
[`packages/dsh-stack-kit/README.md`](../../packages/dsh-stack-kit/README.md)。

**为什么只多这一层**：dsh 必须读 profile 的 `package.json`，broker 必须读
`{services:[...]}` 清单，所以这两个生成物省不掉；stack 是唯一的运行时配置入口，
没有第二份。v2 起支持 domain 型 stack（见下），model/runtime-control
仍由 domain/works 自己决定。

**domain 型（v2）**：`kind: "domain"` + `domain.source` 指向 `dsh-domain.json`，
dshd 交给 `dsh-suite-kit` 创建/启动 runtime（broker + dsh + suite services）：

```bash
dshd stack plan  --stack my-domain.stack.json
dshd stack apply --stack my-domain.stack.json
dshd start       --stack my-domain.stack.json
dshd status|doctor|stop --stack my-domain.stack.json
```

端口映射：`ports.proxy → runtime.harness`、`ports.upstream → runtime.dsh`、
`ports.content → runtime.content`、`ports.broker → runtime.broker`、
`ports.services.* → suite 服务端口偏好`。`domain.runtimeId` 默认 `rt-stack-<slug>`，
稳定 id 让 start/stop 幂等；`domain.recreate: true` 会先删同名 runtime（破坏性）。
详见 [`packages/dsh-stack-kit/README.md`](../../packages/dsh-stack-kit/README.md)。

**边界**：profile 型 stack 改动后需要 `stop` → `start`（运行中的 dsh 不会热重载
bundles）；domain 型的 `--foreground` 守护 proxy，proxy 死 → 整组 stop+start（限次）。

本仓库的 dev 实例是 [`launchpads/dev.stack`](../../launchpads/dev.stack)
（DSL，作者层）编译出的
[`launchpads/dev.dsh-stack.json`](../../launchpads/dev.dsh-stack.json)：
固定 13593 broker / 13594 web / 13595 upstream，launchpad 管理 API 13596，
独立 DSH_HOME，不碰桌面 3016/39311。

## 链路测试矩阵（独立 + 环环相扣）

```bash
npm run test-stack:all       # 根目录一键跑：stack-kit + launchpad + dshd E2E
# 或分开：
npm run test-stack-kit       # 编译/校验/占位符/幂等（9）
npm run test-launchpad       # 四类清单 + stack 漂移 + HTTP API（56）
npm run test-stack-chain     # 锁隔离 + 真实进程 E2E（profile 14 场景 + domain 8 步）
```

| 节点 / 接缝 | 验证内容 | 入口 |
|---|---|---|
| stack 清单 | 形状、重复 id、缺插件/服务路径、非法端口、占位符 | `test-stack-kit` |
| stack → profile | `dsh.profile.bundles`、link 依赖、pnpm install、二次 apply 无写入 | stack-kit + E2E 2/4 |
| stack → broker 清单 | `path`→cmd、`${PORT}` 保留、`normalizeSpec` 接受 | E2E 2/3 |
| broker → 服务 | 真实拉起、`/healthz`、discovery 登记、端口 | E2E 5 |
| dsh profile → dsh | 生成的 profile 被 auth-proxy 加载；launchpad host 体检 | E2E 5 |
| dshd 生命周期 | start/stop/status/doctor、start 幂等、2 轮重启、端口释放 | E2E 5–7/11–12 |
| 双栈独立 | 独立 home/state/ports 并排运行，互不影响 | E2E 8 |
| 服务守护 | 杀 launchpad 后 broker 原端口 keepAlive 复活 | E2E 9 |
| 漂移 | stack ↔ profile、stack ↔ 生成服务清单；apply 恢复 | E2E 10 + launchpad 测试 |
| 失败隔离 | 坏服务早退/端口冲突：dsh 仍可用，status/doctor 报 missing | 失败场景 E2E |
| 非法 stack | 编译阶段拒绝，不占用端口/不拉进程 | E2E 13 |
| domain 型 stack | kind=domain：plan/apply/start/status/doctor/stop + runtime 复用；broker + suite service 真实拉起 | `domain-stack.test.mjs` |
| 外部隔离 | 桌面 3016/39311、当前 dev 13594/13596 前后不变 | 两个 E2E |

E2E 用临时 `home/stateDir` 和动态空闲端口，不读也不改桌面/当前 dev 的运行态；会真实拉起 broker + dsh + launchpad（profile 型）或 domain runtime + suite 服务（domain 型），并在结束时回收进程、验证端口全部释放。

## 为什么能独立：启动链的三件套本来就不依赖桌面

| 件 | 位置 | 桌面扮演的角色 | dshd 的做法 |
|---|---|---|---|
| 开机清单 | `services.json`（broker 格式 `{services:[…]}`） | 被 `works_services.py` 读取后投递 | 直接交给 broker 的 `--manifest` |
| 中间件 | `packages/dsh-service-broker`（standalone 入口） | 由桌面（或没人）拉起 | dshd 作为独立进程拉起，守护/复用/收编/停机全在它身上 |
| dsh 入口 | `core-harness/deepseek-harness/auth-proxy.mjs` | 桌面把端口/env 写进声明后拉起 | dshd 用同样的 env 直接拉起（DSH_HOME/PROFILE/WORKSPACE/端口/锁/discovery） |

插件的**装载**本来就在 dsh 进程内（profile bundles），与桌面无关；服务的
**发现**走 discovery 注册表（`DSH_DISCOVERY_FILE`），dshd 把 broker 与 dsh
指到同一张表（`<stateDir>/services.json`），侧边栏/MCP 等消费者照常工作。

## 配置

没有独立配置文件。`--stack` 的 DSL/JSON 字段（home/profile/stateDir/ports/
plugins/services，domain 型的 domain.source 等）就是全部配置，schema 见
[`packages/dsh-stack-kit/stack.schema.json`](../../packages/dsh-stack-kit/stack.schema.json)。
`harnessDir` 缺省按 `DSH_HARNESS_DIR` 环境变量或文档化兄弟目录解析
（`dsh-harness-paths` 唯一实现）。

## 语义与边界（诚实失败）

- **幂等**：入口已监听 → 报告"已在运行"不重启；broker 复用优先，端口上有
  健康实例（`/healthz` 带 pid）→ 收编，不重复拉起。
- **分离进程**：服务与 dsh 都是 detached，不随 dshd 退出；`stop` 按运行态
  回收（服务经 broker `/control/stop` 做身份核验，broker 不在则按 discovery
  pid 兜底 taskkill `/T`）。
- **守护**：服务的 keepAlive 由 broker 内置 guard 承担（任何时候都生效）；
  dsh 的自动重启只在 `--foreground` 前台守护模式有效（与桌面行为一致）。
- **同 profile 并发**：`dshHome` 若与桌面正在跑的实例相同，第二个 dsh 的
  单例组件（如 dsh-flow-engine 的 service.lock）会诚实报错——这与桌面侧
  双实例的表现一致；要独占请先停桌面侧实例，或把 `dshHome` 指向独立目录。
- **端口**：固定端口被占不自动换（诚实失败）；`auto` 现场分配，三个进程
  端口互不相同。

## 稳定性验证（2026-11-02 真机）

> 该轮验证基于已删除的 `--config` 路径（stability.config/manifest 输入文件已随配置路径一并清理）；
> 结论对 `--stack` 路径同样适用——broker/dsh/守护行为不在配置装载层。现行回归见上方「链路测试矩阵」。

当时用隔离端口/隔离数据目录跑完整循环，生产实例（3016/3017、39311/39312）全程未受影响：

| 场景 | 结果 |
|---|---|
| 冷启动 → doctor 4/4 → stop → 端口全释放 | ✅ 连续 5 轮 |
| `start` 幂等（已在运行不重启） | ✅ |
| 杀 ppt relay → broker guard 按原端口复活（新 pid，/healthz 恢复） | ✅ |
| `--foreground` 下杀 auth-proxy → 守护按原端口重启，入口 HTTP 200 | ✅ |
| 杀 broker → 服务仍存活（一服务一进程）；doctor 诚实报 broker 挂 | ✅ |
| broker 已死时 `stop` → 按 discovery pid 兜底回收 | ✅ |
| 守护运行中 `dshd stop` → 守护先停，dsh 不被复活 | ✅（修复前会复活） |
| 两个 `start --foreground` → 不会出现第二个守护 | ✅ |
| 两个 `start` 并发冷启 → 启动锁只放行一个，另一个明确报错 | ✅（修复前会各拉一套） |
| broker 测试套件（含 10 轮启停/并发/keepAlive/病态服务/复用） | ✅ 20/20 |

验证中发现并修掉的真实缺陷（都在本次改动里）：

1. **守护被 stop 后复活 dsh**：`stop` 原先只收 dsh/broker，前台守护下一轮又按原端口拉起。
   现在 state 记 `supervisor.json`，`stop` 先停守护；守护发现 state 被清空也主动退出。
2. **并发冷启双开**：两个 `start` 同时判断“无主”各拉一套。现在有 `start.lock`（pid 失效自动清）。
3. **孤儿 auth-proxy**：守护被外部杀掉时它重启的子进程会留下。`stop` 增加端口→进程命令行核验兜底。
4. **broker 把“复用即退出”误判为失败**：服务发现端口已有健康实例时会直接返回并退出，
   旧引擎只盯 child pid → 判“健康检查前退出”。现在 child 退出后补一次健康探测，健康则收编
   （`packages/dsh-service-broker/lib/engine.mjs`；该包 20/20 测试通过）。

## 稳定边界（必须知道）

1. **不要和正在运行的桌面栈共用端口。** 本工具会“收编”端口上的健康实例，`stop` 时按
   discovery 一并停掉——如果你同时开着桌面（它管着 39311），`dshd stop` 会把它也停掉。
   要么先停桌面栈，要么给 dshd 用独立清单/端口（`test/stability.manifest.json` 即样板）。
2. **PPT 的 39311 是 profile 写死的。** `mcp-ppt` 的 URL 固定为 `http://127.0.0.1:39311/mcp`，
   所以 PPT 栈的 relay 必须占 39311；想和桌面**同时**跑两套 PPT，需要复制一份 profile 并改
   该行（以及 `port-sidebar` 的探测 URL），本工具不替 profile 改配置。
3. **同一 DSH_HOME/profile 的双实例**会撞单例插件锁（如 `dsh-flow-engine` 的
   `service.lock`），表现是 dsh 里该插件报错但主进程可用——与桌面双开的表现一致。
4. **外部强杀守护**（任务管理器）时子进程会存活（detached 设计）。请用 `dshd stop`；
   它会先停守护再收进程树。

## 与投递契约的关系

dshd 只消费两类既有契约，不发明新格式：

1. broker 清单/spec（与 `PLUGIN_SOURCE_STANDARD` / 服务解耦标准同一份形状，
   `${PACKAGE_DIR}` / `${PORT}` / `${PORT_<NAME>}` 占位符口径一致）；
2. auth-proxy 的 env 注入面（与桌面 `services.json` 的 `env` 段逐字段同构）。

换源/换插件/换部署 = 改 `manifest` 与 `dshHome` 两个配置项，launcher 零改动。
