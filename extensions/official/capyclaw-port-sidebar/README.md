# @capyclaw/port-sidebar

在 DSH 右侧边栏**稳定展示一个本机端口页面**：每个会话的右侧边栏都确保存在一个指向该端口的 Browser tab，**切换会话/换话题不消失**；会话切回来时页面保留（不重载，桌面端为原生 webview + keepMounted）。

## 结构

```text
dsh-port-sidebar/
├── package.json        # dsh.client（浏览器半声明）+ exports["./client"] + bundle patch
├── cordis.patch.yml    # 挂载宿主半；config 里改端口
├── lib/host.mjs        # 宿主半：向 webserver/index-inject 推送 __DSH_PORT_SIDEBAR__ 全局行
├── lib/url.mjs         # 地址解析（config / 环境变量 / 默认值，纯函数）
├── client/client.js    # 浏览器半：每个会话确保 Browser tab（手写 __ModuleLoader__ 工厂协议）
└── test/plugin.test.mjs
```

## 安装

```bash
dsh plugin --profile web add <本目录绝对路径>
```

或走 Web 界面：侧边栏「插件」页 → 安装 → 填本目录的本地路径。装完**刷新页面**（注入行在每次 index 渲染时携带，刷新即生效）。

## 注入端口号（每次启动）

优先级从高到低：

| 方式 | 示例 |
|---|---|
| 环境变量（完整地址） | `DSH_PORT_SIDEBAR_URL=http://127.0.0.1:39500/workbench` |
| 环境变量（端口） | `DSH_PORT_SIDEBAR_PORT=39500` |
| cordis.patch.yml 的 `config` | `port: 39600` / `url: …` / `path: /` / `restoreOnBoot: true` |
| 默认 | `http://127.0.0.1:39600/` |

改完 `cordis.patch.yml` 或环境变量后重启 dsh 并刷新页面即可。

## 行为细节

- **每会话一个 tab**：右侧边栏 tab 属于会话；本插件在每次屏上会话变化时确保该会话有指向目标端口的 Browser tab（页面 tab 在目标格内天然去重，不会重复开）。
- **不劫持**：每个页面加载周期内每个会话只处理一次；你自己开的 Browser tab 之后不会被覆盖导航。目标格内已有 Browser tab 且 `restoreOnBoot: false` 时完全不动它。
- **restoreOnBoot（默认开）**：应用重启后，恢复出的 Browser tab 只显示地址不自动加载（dsh 的安全设计）；本插件对它补一次导航参数，等价于自动点 Restore。设 `false` 保留手动 Restore。
- **可见性**：目标格内没有 tab 时会新开（右栏随之展开一次）；已有 tab 时不抢焦点（`revealIfOpened: false`）。

## 注意

- 仅支持 `http/https` 目标（与 Browser tab 类型一致）；`https` 页面里嵌 `http` 端口可能被浏览器混合内容策略拦截，桌面客户端（webview）无此问题。
- 该组合必须挂载右侧边栏（`ui-sidebar-browser` 提供的 `browser` 类型）；缺失时插件告警并放弃，不影响启动。

## 测试

```bash
cd plugins/dsh-port-sidebar
npm test
```
