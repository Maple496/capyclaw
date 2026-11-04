# 领域包（Canvas）

`domains/canvas/dsh-domain.json` 是「启动单位」而不是插件包：`dsh-domain install`
只生成 `domain-canvas` profile，加载 base + web-app + Canvas 套件；未选中的
插件、skill、MCP 不会注册。

```bash
node ../../../../packages/dsh-suite-kit/bin/dsh-domain.mjs install domains/canvas
node ../../../../packages/dsh-suite-kit/bin/dsh-domain.mjs start domain-canvas
```

- `runtime.requires` 声明需要 `canvas_*` 工具、`canvas.runtime` 等能力
- `runtime.scope.workspace` 声明 Canvas work 只管理 `state.json`、`journal.jsonl`、
  `checkpoints/**`、`exports/**`、`assets/**`
- 端口：内容服务固定 39313（`CANVAS_BRIDGE_HOME` 指向 runtime 的 contentState）
