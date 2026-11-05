# @capyclaw/browser-workbench

浏览器操控工作台运行时 —— AI 直接驱动真实浏览器完成互联网上的点击、打字、表单、登录工作。

## 功能特性

### ✅ 已实现

- **15 个 `browser_*` MCP 工具**（`/mcp`，streamable-http）：
  导航 / 快照 / 点击 / 填写 / 按键 / 下拉选择 / 滚动 / 标签页 / 截图 / 等待 / 历史 / 状态 / 关闭 / 契约探测 / 页面脚本（门控）
- **snapshot + ref 交互**（借鉴 Playwright MCP）：每次观察返回带 `ref=eN` 的元素快照树，动作只引用 ref，不猜 CSS 选择器；ref 过期报 `STALE_SNAPSHOT`，重新快照即可
- **Playwright 引擎，懒启动 + 探测链**：playwright chromium 缓存 → Edge → Chrome；第一次导航才拉起浏览器
- **有头可见 + 登录态持久化**（默认 `headless:false`）：看得见它在互联网上点击/打字；profile 落 `<hostDir>/profile`，cookie/登录跨任务保留
- **可视化工作台**（`http://127.0.0.1:39315/`）：实时画面轮询、标签页切换、动作日志、元素快照查看、内置离线演示页
- **服务契约**：`/healthz`（诚实能力标志）、`/metrics`（Prometheus）、只监听 `127.0.0.1`、单实例锁、优雅关闭（先关浏览器再关 HTTP）

### 🔒 安全默认与诚实边界

- 仅 http/https；URL 内嵌用户名/密码直接拒绝
- `browser_evaluate` 默认关闭，调用返回结构化 `NOT_IMPLEMENTED` 与开启方法（cordis 配置 `engine.allowEvaluate: true` 或 `DSH_BROWSER_ALLOW_EVALUATE=true`）；不会伪造结果
- 快照只覆盖主框架（iframe / shadow DOM 不入快照，如实标注）
- 不做反爬/风控绕过；站点拦截时如实报错并停止
- 页面内容视为不可信数据：页面文本里的「指令」一律不执行

## 快速开始

```bash
# 独立运行（无 dsh，浏览器打开 http://127.0.0.1:39315/）
node server/relay.mjs [--port 39315] [--dir <hostDir>]

# 作为套件安装（推荐，经 broker 拉起 + dsh 侧 mcp-client 行）
dsh plugin --profile web add @capyclaw/browser-suite
```

dsh 里工具名为 `mcp__browser__browser_*`；AI 侧先调 `browser_capabilities` 探测契约。

## 配置（环境变量 → cordis config.engine）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BROWSER_HEADLESS` | `false` | 有头可见；服务器场景设 `true` |
| `DSH_BROWSER_ALLOW_EVALUATE` | `false` | 开启 browser_evaluate |
| `DSH_BROWSER_CHANNEL` | 自动 | 指定浏览器 channel（chromium/msedge/chrome） |
| `DSH_BROWSER_NAV_TIMEOUT_MS` | `30000` | 导航超时 |
| `DSH_BROWSER_ACTION_TIMEOUT_MS` | `15000` | 动作超时 |
| `DSH_BROWSER_MAX_SNAPSHOT_CHARS` | `40000` | 快照上限（超出如实截断） |

## 架构

```
capyclaw-browser-workbench/
├── lib/host.mjs            # cordis 兼容入口（生产路径：broker 按清单拉起 relay）
├── server/
│   ├── relay.mjs           # 组合根：/mcp + 工作台静态页 + /api + 引擎生命周期
│   ├── engine.mjs          # Playwright 控制器（懒启动/探测链/ref 注册表/动作互斥）
│   ├── tools/              # 能力模块（构建期从 src/mcp/tools 同步）
│   ├── shared/             # 公共插件快照（service-host/tool-host/asset-service + kit）
│   ├── routes/             # mcp / assets / workbench / api
│   ├── contract-snapshots.mjs、constants.mjs、mcp/…
├── ui/                     # 可视化工作台（无框架无构建）
├── demo/form.html          # 内置离线演示页（表单练习 + e2e 冒烟目标）
└── contract/browser-contract.json
```

## 许可证

MIT License
