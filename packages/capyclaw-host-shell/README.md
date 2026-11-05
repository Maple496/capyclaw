# @capyclaw/host-shell

**DSH 宿主壳标准件** —— 把「把 dsh 跑起来」所需的基础设施收进 npm：
零登录认证代理、安全启动、单实例锁、前台运行守卫、精确进程管理。

与 `@deepseek-ai/dsh` 同装即得可跑的宿主，不再依赖任何仓库外的目录
（本包由 `../dsh-runtime` 宿主壳收编而来，见文末「收编来源与适配差异」）。

## 安装与启动

```bash
npm install @deepseek-ai/dsh @capyclaw/host-shell
npx dsh-host start-safe     # 端口体检 → 前台守卫 → 拉起代理与 dsh
# 或只要代理本体：
npx dsh-host auth-proxy     # 拉起 dsh web，浏览器打开 http://localhost:3081/ 免登录
```

## 命令

| 命令 | 作用 |
|---|---|
| `dsh-host auth-proxy` | 零登录代理：拉起 dsh web 子进程、从 stdout 抓 boot token、兑换 `dsh-auth-*` 信任 cookie，浏览器侧无需登录；HTTP + WebSocket 全量转发，401 自动重兑换 |
| `dsh-host start-safe` | 启动前体检：检查并清理 3080/3081/39311 端口占用（只杀占用端口的进程），前台守卫通过后拉起 auth-proxy |

## 实例参数（环境变量）

多实例 = 各自工作区 + 各自端口 + 各自 profile，全部经 env 区分：

| 变量 | 缺省 | 说明 |
|---|---|---|
| `DSH_WORKSPACE` | `<cwd>/workspace` | dsh 子进程工作区 |
| `DSH_BIN` | 自动解析 | dsh 入口：显式指定 → 同装的 `@deepseek-ai/dsh` → 旧目录布局 |
| `DSH_PROFILE` | `web` | dsh profile；非 `web` 且未初始化时自 `web` 模板引导 |
| `DSH_PROFILE_PATCH` | （无） | profile 初始化后注入的 `cordis.patch.yml` 源文件（MCP 补丁） |
| `DSH_HOME` | `~/.dsh` | dsh home 隔离（profile/会话/工作区注册表） |
| `DSH_UP_PORT` | `3080` | dsh 上游端口 |
| `DSH_PROXY_PORT` | `3081` | 代理监听端口 |
| `DSH_LOCK_FILE` | `<cwd>/.dsh-instance.lock` | 单实例锁文件（每 runtime 一个） |
| `DSH_PID_FILE` | `<cwd>/.dsh-pids.json` | 进程组记录文件 |
| `DSHD_MANAGED` | （无） | 已由 ServiceManager 托管时置任意值，跳过前台守卫 |

## 库 API

```js
import { acquireLock, ForegroundGuard, enforceRunInForeground,
         savePids, cleanupOldInstance, setupCleanup } from '@capyclaw/host-shell';
```

| 导出 | 来源模块 | 用途 |
|---|---|---|
| `acquireLock(lockFile?)` | `./single-instance` | 跨进程单实例锁（PID 探活、过期自清理、退出钩子） |
| `ForegroundGuard` / `enforceRunInForeground(opts)` | `./foreground-guard` | 强制可见终端运行：TTY/父进程链/后台标记三重检查 |
| `savePids` / `cleanupOldInstance` / `setupCleanup` | `./process-manager` | 只杀自己记录的进程组，不误杀无关 node |

`auth-proxy` / `start-safe` 是「运行即执行」的入口脚本，不作库导出（顶层即副作用，
刻意保留原语义）；`dsh-host` 通过动态 import 调度它们。

## templates/

`templates/dsh-desktop.product.json` 与 `templates/dsh-desktop.runtime-manifest.json`
是 dsh-runtime 时代「DSH 桌面」产品装配清单的历史快照，其中引用的
`packages/dsh-*` / `extensions/official/dsh-launchpad` 均为**本仓改名前路径**，
仅作装配思路参考，不可直接复用。

## 收编来源与适配差异

收编自 `dsh-runtime/apps/harness/deepseek-harness/` 的 5 个宿主壳脚本
（2026-11-05 收编，原目录随之退役）。除下列 4 处 npm 形态适配外逐行保留原实现：

| 适配 | 原因 |
|---|---|
| `DSH_BIN` 解析链：env → peer 同装解析 → 旧布局回退 | 包安装后 `HERE` 在 `node_modules` 内，原「脚本旁 node_modules」直连必不命中 |
| workspace / 锁 / PID 状态文件缺省从「脚本所在目录」改为「调用目录（cwd）」 | 包目录不宜写运行状态 |
| `start-safe` 拉起 auth-proxy 由相对路径改为绝对路径 + `process.execPath` | 包内脚本与调用目录不再同处 |
| `auth-proxy` spawn 前自举 `DSH_WORKSPACE`（`mkdirSync recursive`） | npm 首跑工作区不存在；spawn 的 cwd 缺失会以 ENOENT 误报 node.exe |
| `auth-proxy` 增加 `child.on('error')` 友好提示 | dsh 未安装时给出安装指引而非裸 ENOENT |

（`dsh-host` 调度器内部：Windows 动态 import 用 `pathToFileURL` 转换，裸盘符路径会抛
`ERR_UNSUPPORTED_ESM_URL_SCHEME`——bin 实现细节，不影响语义。）

## License

MIT
