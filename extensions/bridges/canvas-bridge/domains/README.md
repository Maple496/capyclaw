# 领域包（Canvas）

`domains/canvas/dsh-domain.json` 是「启动单位」而不是插件包：它声明一个 domain
profile 只加载 base + web-app + Canvas 套件；未选中的插件、skill、MCP 不会注册。

`dsh-domain` 是校验/解析工具（profile 的安装与启动由 dsh 运行时侧执行）：

```bash
node ../../../../packages/capyclaw-suite-kit/bin/dsh-domain.mjs validate domains/canvas
node ../../../../packages/capyclaw-suite-kit/bin/dsh-domain.mjs resolve domains/canvas
node ../../../../packages/capyclaw-suite-kit/bin/dsh-domain.mjs registry domains/canvas
node ../../../../packages/capyclaw-suite-kit/bin/dsh-domain.mjs doctor --profile domain-canvas
```

- `runtime.requires` 声明需要 `canvas_*` 工具、`canvas.runtime` 等能力
- 服务按套件 `services.json` 由 dsh-service-broker 拉起（`portFrom: content`，
  内容服务默认端口 39313，`CANVAS_BRIDGE_HOME` 指向 runtime 的 contentState）
- 组件 = `capyclaw-canvas-suite` + `capyclaw-launch-engine-suite`（按需激活）
