Keynote 一体工作台 —— 左侧 DeepSeek 编辑 agent + 右侧 Keynote 编辑器同窗联动。

## 结构（源码在 ppt-bridge/，本文件由构建产出）

- `ppt-bridge/src/core/`：op 分发（ops）、版式引擎（deck-layout）、
  文本/样式工具（text）、快捷指令解析（quick）——纯逻辑，可单测；
- `ppt-bridge/src/apps/keystudio/`：应用壳（UI、长轮询泵、截图回传、
  dsh 内嵌），构建时打包成单 IIFE 写入本文件 CODE 段；
- 桥契约见 `ppt-bridge/contract/ops.json` 与 `ppt-bridge/README.md`。

## 运行时

- 右侧编辑器 = PPTist 4.4MB bundle（backend/system_works/assets/
  ppt-full-app.js），首次打开注入。
- 桥 = 本机网关 /api/desktop/works/ppt-bridge（指令队列 / 回执 /
  deck 镜像 / 截图请求），编辑器侧长轮询消费。
- agent = keynote-agent 实例（workspace-keynote/AGENTS.md 限定只操作
  本 deck），工具面 = ppt MCP（ppt-bridge/src/mcp）。

## 风格规则

新建 deck 默认用 `ppt_deck` + `preset: clean` 出简洁稿，不依赖外部样式。

## 回滚修复（2026-10-22）

- **镜像先落再回执**：旧实现 ack 早于 800ms 防抖的 state 镜像，agent
  拿到 ack 后立刻读桥会读到旧 deck，再基于旧 deck 回推 → 表现为
  「改好后又变回去」。现在 apply 内先 `pushState()` 再 `/ack`。
- **重开窗口从镜像恢复**：不再重放历史指令队列（旧队列按旧元素 id
  重放会报 remove-element 未命中并覆盖当前内容）。
- **单窗口所有权**：claim/release 租约（心跳 3s / 租约 10s），只有
  owner 应用指令/回执/写镜像；其他窗口显示待命，owner 关闭或过期后
  自动接管。后台标签页定时器被节流时所有权可能转移，原窗口自动暂停。
