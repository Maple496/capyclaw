# Canvas 插件包组

这里不是一个大插件，而是"一个套件 + 一个运行时 + 4 个独立 skill 包"。

| 包 | 角色 | 是否直接装 |
|---|---|---|
| `capyclaw-canvas-suite` | 组合入口，锁定 workbench + 4 个 skill 包的兼容版本 | ✅ 普通用户只装这个 |
| `capyclaw-canvas-workbench` | 运行时：relay、Canvas 编辑器、`canvas_*` MCP 工具 | 开发者单独调试 |
| `dsh-canvas-skill-*` | 4 个单 skill provider（路由/工具手册/成稿/执行） | 开发者单独调试 |
| `packages/dsh-document-workbench` | 通用文档工作台框架：会话/桥路由/编辑器客户端 | 与 PPT 共用 |
| `packages/dsh-plugin-kit` | 插件底层协议库：HTTP/MCP 壳/校验/skill provider | 与 PPT 共用 |
| `packages/dsh-suite-kit` | 通用组合标准件：suite/domain/校验 | 与 PPT 共用 |
| `domains/canvas` | 领域包：只选择 Canvas 组件，生成独立 `domain-canvas` profile | 启动单位 |

## 依赖方向

```text
capyclaw-canvas-suite
  ├─ capyclaw-canvas-workbench
  └─ dsh-canvas-skill-*       # 每个包只注册一个 skill，只依赖工具契约
        │
        └─ 通过 canvas_capabilities 读取 contractVersion
```

## 契约

- `capyclaw-canvas-workbench` 提供 `canvas_capabilities`，返回 `contractVersion`、
  工具清单（含能力归属）、`features`、`capabilities`、`editorUrl`。
- 每个 `dsh-canvas-skill-*` 的 `contract/canvas-contract.json` 都是构建时快照；
  relay 启动时对账同目录 skill 包快照，major 不一致时拒绝工具调用。
- 工具名/参数/返回结构不兼容变化时，contract major +1；workbench 与 skill 包同步。

## 构建与测试

```bash
cd extensions/bridges/canvas-bridge
node scripts/build-plugin.mjs          # 组装 6 个包
node --test test/*.test.mjs            # 46 项单测
node scripts/e2e-verify.mjs            # 真浏览器端到端（19 项检查）
```

构建会：

1. 同步公共插件快照（`src/mcp/shared` 与 workbench `server/shared`）；
2. 生成 `contract/canvas-contract.json` 快照（tools + capabilities）→ 六个包；
3. 拷贝 src/mcp 四件套 + `src/core` → 包内目录镜像；esbuild 打包编辑器壳；
4. 复制内核资产 `runtime/canvas-full-app.js` → `editor/`；
5. 从 `src/skills` 生成 4 个单 skill 包（canvasist-api 附带生成的工具契约参考）；
6. 用 dsh-suite-kit 校验并渲染 suite patch，写组合锁；对 6 个包做完整性 sanity。
