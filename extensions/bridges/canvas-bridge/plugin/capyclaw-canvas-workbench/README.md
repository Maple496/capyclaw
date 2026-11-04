# @capyclaw/canvas-workbench（Canvas 文档工作台运行时）

DeepSeek Harness 插件：Canvas 文档编辑器运行时 + 工具面。**普通用户请装
`@capyclaw/canvas-suite`**；本包是套件里的运行时子包，也可单独安装用于调试。

- **22 个 `canvas_*` MCP 工具**：契约探测（`canvas_capabilities`）/ 文档读写 /
  块级写作 / 页面与排版命令 / 导出 HTML / 审计 / 撤销重做 / 截图等。
- **浏览器实时编辑器**：`http://127.0.0.1:39313/`（本机 relay 托管，装完即有）。
  agent 的每一步修改实时出现在页面里；编辑器是权威状态源（编辑器权威桥）。
- **本机桥**（127.0.0.1:39313）：agent（MCP，streamable-http `/mcp`）与编辑器
  之间的指令/回执/镜像/截图通道。不依赖任何桌面系统，一条 dsh 会话 + 一个
  浏览器标签页即可工作。

## 独立运行（调试）

```bash
node server/relay.mjs --port 39313 [--dir <数据目录>]
# /healthz 健康检查；/mcp 为 MCP 端点；/ 为编辑器页面
```

生产形态不由本包自行拉起：套件 `services.json` 声明 `canvas-workbench` 服务，
由 dsh-service-broker 以独立进程拉起并注入端口/数据目录。

## 运行时架构

| 件 | 位置 | 说明 |
|----|------|------|
| relay | `server/relay.mjs` | HTTP 服务：编辑器静态托管 + `/mcp` + `/healthz` |
| 工具面 | `server/tools/` | 22 个 canvas_* 工具（kernel + capabilities + domains） |
| 契约 | `contract/` | 工具契约快照（由 `canvas_capabilities` 对齐） |
| 编辑器 | `editor/` | 浏览器壳（会话/传输/心跳/截图） |
| 公共基建 | `server/shared/` | service-host 等快照（独立运行时不依赖 dsh ctx） |

安装后工具组 `canvas_*` 出现在 agent 工具清单里；详见套件包
`@capyclaw/canvas-suite` 的 README。
