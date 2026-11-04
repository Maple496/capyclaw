# PPTist 插件包组

这里不是一个大插件，而是“一个套件 + 一个运行时 + 8 个独立 skill 包”。

| 包 | 角色 | 是否直接装 |
|---|---|---|
| `dsh-ppt-suite` | 组合入口，锁定 workbench + 8 个 skill 包的兼容版本 | ✅ 普通用户只装这个 |
| `capyclaw-ppt-workbench` | 运行时：relay、PPTist 编辑器、`ppt_*` MCP 工具 | 开发者单独调试 |
| `capyclaw-ppt-skill-*` | 8 个单 skill provider（路由/叙事/审美/工具/成稿/执行/审计/研究） | 开发者单独调试 |
| `packages/capyclaw-document-workbench` | 通用文档工作台框架：会话/命令/桥路由/编辑器客户端/截图 | 其他编辑器插件复用 |
| `packages/capyclaw-suite-kit` | 通用组合标准件：suite / domain / stage / launch / doctor | 其他组合复用 |
| `domains/ppt` | 领域包：只选择 PPT 组件，生成独立 `domain-ppt` profile | 启动单位 |

## 依赖方向

```text
dsh-ppt-suite
  ├─ capyclaw-ppt-workbench
  └─ capyclaw-ppt-skill-*       # 每个包只注册一个 skill，只依赖工具契约
        │
        └─ 通过 ppt_capabilities 读取 contractVersion
```

## 为什么这样拆

- **运行时和 instructions 生命周期不同**：工具实现和编辑器随 PPTist 升级；skill 文案可以周更。
- **skill 可以独立评测和替换**：每个 `capyclaw-ppt-skill-*` 有自己的 package/contract，单独升版本或替换不影响其他 skill。
- **套件负责兼容性**：用户不需要理解 8 个 skill 包的版本矩阵。
- **拆模块不拆进程**：workbench 内部按 capability / 端口 / store / route / editor session 拆成单一职责模块；它们仍共享同一个 relay、editor 状态、undo 历史和截图通道，避免跨进程竞态。
- **能力可组合**：15 个 capability 通过 `requires` / `dependsOn` / `provides` 声明依赖，`createRegistry(..., { enabled })` 可按 profile 选择；新增能力只加一个文件。
- **不新造搜索插件**：内容研究用 DSH 内置 `web_search` / `web_fetch`；素材搜索以后才考虑独立 provider。

## 契约

- `capyclaw-ppt-workbench` 提供 `ppt_capabilities`，返回 `contractVersion`、工具清单（含 capability 归属）、`features`、`capabilities`、`editorUrl`。
- 每个 `capyclaw-ppt-skill-*` 的 `contract/ppt-contract.json` 都是构建时快照。
- 工具名/参数/返回结构不兼容变化时，contract major +1；workbench 与 8 个 skill 包 major 同步。
- 任何 skill 在执行前先调 `ppt_capabilities`；缺失或 major 不一致就停止并提示升级套件。

## 构建与测试

```bash
cd bridges/ppt-bridge
node scripts/build-plugin.mjs
node --test test/*.test.mjs
```

构建会：

1. 从 `src/core` + `src/mcp` 生成 workbench 的 `core/` 与 `server/` 拷贝（目录镜像，相对 import 不变）；
2. 生成 `contract/ppt-contract.json` 快照（tools + capabilities）；
3. 从 `src/skills` 分别生成 8 个 `capyclaw-ppt-skill-*` 单 skill 包；
4. 校验 10 个包（workbench + 8 skill + suite）的 manifest、patch、契约和入口文件。
