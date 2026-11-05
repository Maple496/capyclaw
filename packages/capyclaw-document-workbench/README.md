# @capyclaw/document-workbench

通用文档工作台框架。它把「文档会话协议」从具体文档插件里抽出来，供 PPT、Canvas、DOCX、XLSX 等编辑器插件复用。

它是**纯库**，不是运行时插件：不提供 `ctx.*`，不监听端口，也不生成 service row。HTTP 宿主、工具注册、状态、资产、编辑器托管仍由 `dsh-service-host` / `dsh-tool-host` / `@capyclaw/state-service` / `dsh-asset-service` / `dsh-editor-host` 提供。

## 分层

| 子路径 | 位置 | 职责 |
|---|---|---|
| `@capyclaw/document-workbench/session` | Node | `DocumentSession`：seq/命令队列/ack/state/ui/shot/owner lease/checkpoint/recover |
| `@capyclaw/document-workbench/ops` | Node | `defineOp` / `createOpRegistry`：op 元数据、snapshot 策略、未知指令 |
| `@capyclaw/document-workbench/bridge` | Node | `createDocumentBridge`：标准 HTTP 端点族 |
| `@capyclaw/document-workbench/client` | Browser | `createEditorClient`：claim/心跳/长轮询/镜像/应用/截图请求 |
| `@capyclaw/document-workbench/screenshot` | Browser | `composeContactSheet` / `composeTiles` |
| `@capyclaw/document-workbench/testing` | Node | 内存 backend、fake adapter，供一致性测试 |

浏览器侧只能从 `./client` 与 `./screenshot` 导入；这两个入口不依赖 `node:*`。

## 最小接入

服务端：

```js
import { DocumentSession } from '@capyclaw/document-workbench/session'
import { createDocumentBridge } from '@capyclaw/document-workbench/bridge'
import { createOpRegistry } from '@capyclaw/document-workbench/ops'
import { createMemoryBackend } from '@capyclaw/document-workbench/testing'

const session = new DocumentSession({
  backend,
  initialDoc: { document: { value: 0 } },
  documentKey: 'document',
  summary: (doc) => ({ value: doc.document?.value }),
})

const ops = createOpRegistry({
  modules: { counter: { inc: { run: (doc, cmd) => { doc.document.value += cmd.by || 1 } } } },
  snapshot: (doc) => { /* 可选：mutating op 前拍快照 */ },
})

const bridge = createDocumentBridge({
  session,
  basePath: '/api/my-doc',
  documentKey: 'document',
  documentPath: '/document',
  apply: (cmd) => ops.apply(session.getDocument(), cmd),
  projectStatus: (doc) => ({ value: doc.document?.value }),
})

for (const route of bridge.routes) app.use(route)
```

浏览器侧：

```js
import { createEditorClient } from '@capyclaw/document-workbench/client'

const client = createEditorClient({
  api,
  clientId: 'tab-1',
  documentKey: 'document',
  documentPath: '/document',
  adapter: {
    isMounted: () => !!editor.mounted,
    load: (doc) => editor.load(doc),
    dump: () => editor.dump(),
    apply: (cmds) => editor.apply(cmds),
    applyUi: (cmds) => editor.applyView(cmds),
    onChange: (fn) => editor.on('change', fn),
    renderScreenshot: () => editor.renderContactSheet(),
  },
})

await client.ensureLinked()
await client.restore()
await client.activate()
client.claimLoop()
```

## 协议字段

标准信封：

```text
seq, cmds, title, applied_seq, applied, error, updated,
state_seq, ui_seq, ui, shot_req, shot { req, data }, owner
```

- `seq`：服务端批次号，push 时自增。
- `applied_seq` / `applied`：当前批次已应用数与回执。
- `state_seq`：编辑器镜像对应的批次号；旧镜像不会覆盖新文档。
- `ui_seq` / `ui`：页面级命令（present/select 等），不写文档。
- `shot_req` / `shot`：截图请求与结果，旧结果会被丢弃。
- `owner`：文档 owner 租约，默认 TTL 10s。

## 实时性与传输（0.2.0）

- **变更订阅**：`DocumentSession#subscribe(fn)` / `#waitForChange(timeoutMs)`——
  push/ack/state/ui/shot 的每次状态迁移都会即时唤醒订阅方；长轮询
  `GET /watch` 与工具侧等待不再受轮询粒度影响（`watch.pollMs` 保留为兜底）。
- **响应轻量化**：`GET /watch` 只回协议字段（`seq/applied_seq/state_seq/error/
  title/shot_req/ui_seq/cmds/ui`），不回领域文档与截图 base64；`POST`（push/
  ack/state/shot-*）响应同理只回回执字段。领域文档只在 `GET` 主端点（编辑器
  restore）与 `GET /doc|/deck` 出全量。

## 两种权威模式

- `authority: 'server'`：服务端执行命令，编辑器只拉镜像；PPT 使用这种模式。
- `authority: 'editor'`：服务端只 push，编辑器应用命令后 `POST /ack`；适合 Canvas 这类编辑器权威的模型。

## 边界

- **不要**把 deck/slide/布局/审计等 PPT 领域逻辑放进本包。
- **不要**把本包做成 service plugin；它是被功能插件 import 的框架库。
- `dsh-editor-host` 的 lease 是「浏览器标签页租约」；本包的 `owner` 是「文档归属租约」，两者不要混用。
- checkpoint 的领域载荷放在 `documentKey` 下（PPT 是 `deck`）。

## 测试

```bash
npm test
```

测试覆盖 session 状态迁移、串行批次、checkpoint/recover、owner lease、watch、sanitizer、op registry、bridge 端点、浏览器客户端以及编辑器权威模式。
