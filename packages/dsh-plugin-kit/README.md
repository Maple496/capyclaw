# dsh-plugin-kit（插件底层协议库）

> 运行时公共服务已经拆到 `dsh-service-host`、`dsh-tool-host`、`dsh-state-service`、`dsh-asset-service`、`dsh-editor-host`。
> 新插件优先使用这些公共插件（`ctx.*`）或 `scripts/sync-shared.mjs` 生成的 `server/shared/` 快照；
> 本包只保留纯函数/传输/存储算法，供公共插件和旧插件使用。

后续插件不要各自重复实现这些机制。按本包的接口接入，PPT 只是第一个消费者，新的 `plugin-development` 脚手架是第二个消费者。

## 提供什么

| 模块 | 能力 |
|---|---|
| `service/http` | 安全响应头、JSON/text 响应、body 上限、query 解析、loopback 监听（可挂 handler） |
| `service/mcp-http` | 通用 MCP Streamable HTTP 处理器（initialize/ping/tools/list/tools/call） |
| `tools/validate` | inputSchema 子集校验（required/type/enum/maxLength/maxItems/additionalProperties） |
| `skills/provider` | 扫描 `skills/*/SKILL.md`，按需加载，自动 frontmatter 校验 |
| `editor/transport` | 浏览器 → 本机服务的 fetch/JSON 封装 |
| `editor/lease` | “显示即连接”的编辑器租约与自动挂接 |
| `editor/heartbeat-worker.js` | 不受标签页节流的心跳 Worker |
| `store/journal-store` | 原子 JSON 状态、append-only journal、命名 checkpoint |
| `store/blob-store` | 纯内容仓库：按 sha256 存不可变对象，不关心文件关系 |
| `workspace/manager` | 中间层：work manifest、文件归属、版本 CAS、catalog、生命周期 |
| `runtime/context` | 读取当前 runtime 的端口、目录、namespace，并创建 scoped WorkspaceClient |

## 职责边界

- 编排中间层在 `dsh-suite-kit`：打包插件、分配端口、创建 runtime、校验
  `requires`、声明 work 的文件范围、维护 catalog 和生命周期。
- `BlobStore` 只接收字节，按内容 hash 存储；它不知道文件名、作品、runtime。
- `WorkspaceManager` 是中间层的 workspace 实现：解释“哪些对象属于同一个 work、
  谁能改、版本是多少”，并把可展示的目录写到 `catalog/works.json`。
- 插件通过 `WorkspaceClient` 访问自己的 namespace；新文件自动进入当前 work
  的 manifest，不会串到别的 runtime。
- `WorkspaceBackend` 把 state/journal/checkpoint 映射到对象仓库；可选 `journalPath` 把 append-only journal 写到 runtime 自己的 logs，避免 O(n²) 对象重写。PPT 已接入。

## 使用方式

```js
import { listen, send, sendText, readBody } from 'dsh-plugin-kit/service/http'
import { createMcpHandler } from 'dsh-plugin-kit/service/mcp-http'
import { createSkillProvider } from 'dsh-plugin-kit/skills/provider'
import { createEditorLease } from 'dsh-plugin-kit/editor/lease'
import { JournalStore } from 'dsh-plugin-kit/store/journal-store'
import { BlobStore, WorkspaceManager, WorkspaceClient, WorkspaceBackend } from 'dsh-plugin-kit'
import { runtimeContextFromConfig, createRuntimeStoreClient } from 'dsh-plugin-kit/runtime/context'
```

本地插件包可以在构建期把 kit 源码快照进自己的包（`server/infra/`），这样插件仍然可以独立分发：

```bash
node packages/dsh-plugin-kit/bin/sync.mjs --out <plugin>/server/infra --force
```

快照会写 `INFRA_MANIFEST.json`（版本、hash、文件清单），升级 kit 后重新同步并提交。

## 兼容性契约

- kit minor 版本只新增导出，不改变已有函数签名；
- breaking change 必须 major；
- 插件包应锁定 kit 的精确版本/快照，不要跨 major 混用；
- 任何插件暴露的 `/healthz` 至少返回 `{ ok, version, contractVersion }`；
- 任何插件暴露的 `/metrics` 使用稳定的指标名；
- 任何 MCP 工具调用前必须经过 `validateToolArguments`。

## 测试

```bash
cd packages/dsh-plugin-kit
npm test
```
