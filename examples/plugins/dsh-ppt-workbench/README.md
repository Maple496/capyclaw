# dsh-ppt-workbench（PPT 工作台，历史示例）

> 本目录是 1.x 单包示例。当前三包拆分（workbench / skills / suite）以
> `bridges/ppt-bridge/plugin/` 为准；本示例保留用于对照旧结构。

DeepSeek Harness 插件：装上即得一套完整的 AI PPT 工作台——

- **16 个 `mcp__ppt__*` 工具**：读 deck / 改文字样式 / 一键换色 / 元素页管理 /
  插图（自动压缩+自校验）/ **8 套官方模板一次成稿**（`ppt_template_deck`）/
  版式成稿（`ppt_deck`）/ 放映 / 撤销重做 / 截图。
- **浏览器实时编辑器**：`http://127.0.0.1:39311/`（本机 relay 托管，装完即有）。
  agent 的每一步修改实时出现在页面里；可本地快捷指令、导出 PPTX、放映。
- **本机桥**（127.0.0.1:39311）：agent（MCP）与编辑器之间的指令/回执/镜像/
  截图通道。**不依赖任何桌面系统**，一条 dsh 会话 + 一个浏览器标签页即可工作。

## 安装

前置：本机装有 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh ≥ 0.2）
与 pnpm（插件安装经 pnpm 拉包）。插件本体**零 npm 依赖、零构建脚本**——安装
不会触发构建脚本审批。

```bash
# 方式一：本地目录（推荐先试）
dsh plugin --profile <你的profile> install /path/to/dsh-ppt-workbench

# 方式二：Web 界面
侧边栏「插件」页 → 安装 → 填本地路径 / git 地址
```

装好后（无 HMR 的 profile 需重启会话），工具组 `mcp__ppt__*` 出现在 agent
工具清单里；同时本机 39311 端口的桥随之就绪（由插件内置宿主在进程内拉起，
dsh 关闭时自动停止）。

## 使用

1. 浏览器打开 **http://127.0.0.1:39311/** —— 页面标题旁徽标变「已接管」即就绪。
2. 在 dsh 会话里直接说需求，例如：
   - 「用都市蓝调做一套 Q4 销售规划的 PPT，封面写 XXX」
   - 「把背景改成天蓝色」「第 2 页标题换成 X」「加一页介绍 Y」「整体换成深色系」
   - 「插入这张图」（聊天里贴图，用 `ppt_image` 附件通道）
3. agent 的改动实时出现在编辑器页；说「看一下效果」会用 `ppt_screenshot`
   回传全页拼图。
4. 收尾在编辑器页点「导出 PPTX」。

同一时间只有一个编辑器页接管桥（owner 租约，心跳 3s / TTL 15s）；开第二个
标签页会显示「待命」，关掉前一个或等租约过期后自动接管。

## 架构（一包三件）

| 件 | 位置 | 说明 |
|----|------|------|
| 宿主插件 | `lib/host.mjs` | cordis 入口：进程内拉起 relay，disposer 随插件停用关闭 |
| relay | `server/` | 桥端点（与桌面网关同契约）+ MCP Streamable HTTP（`/mcp`）+ 编辑器静态托管；JSON 文件落盘（`~/.dsh-ppt-bridge/`） |
| 编辑器 | `editor/` | PPTist 运行时（打补丁版）+ 工作循环（接管/长轮询/应用/回执/镜像/自截图） |

工具实现（`server/tools.mjs`）由上游工程 `ppt-bridge/src/mcp/` 构建期拷贝——
**不要手改包内拷贝**，改上游后重跑 `node scripts/build-plugin.mjs`。

## 端口与发现

- 首选端口 **39311**（patch 里的 MCP URL 是静态常量）。被占时：若占用者
  是本桥旧实例则直接复用；否则向后扫描最多 50 个端口，实际地址写入
  `~/.dsh-ppt-bridge/bridge.json`（编辑器同源无感；此时 MCP 需重启会话后
  由新 relay 接管 39311）。
- 想换端口/目录：在 profile patch 里覆写 `ppt-workbench-host` 行的
  `config: { port, hostDir }`。

## 也可脱离 dsh 独立运行（调试/演示）

```bash
node server/relay.mjs [--port 39311]   # 桥 + 编辑器 + MCP 一并拉起
```

## 已知约束

- MCP 固定连 `http://127.0.0.1:39311/mcp`；39311 被外部应用长期抢占时工具
  不可用（工具结果会提示），属可接受降级。
- `ppt_image` 的聊天附件按 `$DSH_HOME/attachments/v1/objects` 解析；跨机器
  贴图请重新粘贴。
- 模板风格唯一来源是 PPTist 官方模板数据（运行时资产内嵌 8 套）；更换新版
  PPTist 后需重跑上游 `patch-asset.mjs` + `build-plugin.mjs`。

## 许可

AGPL-3.0-or-later。编辑器运行时基于 [PPTist](https://github.com/pipipi-pikachu/PPTist)
（AGPL-3.0，有修改：模板数据导出接口），详见 `THIRD_PARTY_NOTICES.md`。
