# 接入一个新服务

先选路线，再动手。

## 决策树

```text
服务已提供 MCP server？
├─ 是 → 方案 A：只加 MCP client row（不写代码）
└─ 否 → 服务有 HTTP API / SDK / 数据库？
         ├─ 是 → 方案 B：写 service 插件（推荐默认）
         └─ 同时需要用户界面 → 方案 C：写 ui 插件
```

---

## 方案 A：已有 MCP 服务

适合 GitHub、数据库、搜索、内部 MCP 服务等。

在 suite 的 `dsh-suite.json` 里加一条 row：

```json
{
  "id": "mcp-github",
  "name": "@deepseek-ai/dsh-mcp-client",
  "config": {
    "serverName": "github",
    "transport": "streamable-http",
    "url": "http://127.0.0.1:39400/mcp",
    "headers": {
      "Authorization": "!!js `Bearer ${process.env.GITHUB_TOKEN}`"
    },
    "failOnStartupError": false,
    "toolCallTimeoutMs": 120000
  }
}
```

如果是 stdio 服务：

```json
{
  "id": "mcp-github",
  "name": "@deepseek-ai/dsh-mcp-client",
  "config": {
    "serverName": "github",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_TOKEN": "!!js process.env.GITHUB_TOKEN" }
  }
}
```

校验：

```bash
node packages/dsh-suite-kit/bin/dsh-suite.mjs validate <suite-dir>
```

工具会以 `mcp__github__<tool>` 出现在模型工具列表。

---

## 方案 B：写一个 service 插件

适合只有 HTTP API/SDK 的内部服务。

### 1. 生成

```bash
cd plugin-development
node create-plugin.mjs \
  --name dsh-my-service \
  --type service \
  --title "My Service" \
  --port 39500 \
  --out ./my-plugins \
  --domain my-service \
  --yes
```

### 2. 实现工具

编辑 `plugin/dsh-my-service/server/impl.mjs`：

```js
export async function query({ q, limit = 10 }) {
  const res = await fetch(`${process.env.MY_SERVICE_URL}/search?q=${encodeURIComponent(q)}&limit=${limit}`, {
    headers: { authorization: `Bearer ${process.env.MY_SERVICE_TOKEN}` },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`上游 HTTP ${res.status}`)
  return res.json()
}
```

编辑 `server/tools.mjs`：加 schema、分派。

```js
{
  name: 'my_service_query',
  description: '查询 My Service',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      q: { type: 'string', maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['q'],
  },
}
```

```js
case 'my_service_query':
  return { content: [{ type: 'text', text: JSON.stringify(await query(args)) }] }
```

### 3. 补契约

更新 `contract/*.json` 和 `my_service_capabilities` 的返回，保证 `contractVersion` 稳定。suite 的 `checks` 会调用它。

### 4. 测试

```bash
cd my-plugins/my-service/plugin/dsh-my-service
npm test
```

### 5. 安装

```bash
node packages/dsh-suite-kit/bin/dsh-suite.mjs install \
  ./my-plugins/my-service/plugin/dsh-my-service-suite --profile web
```

---

## 方案 C：带 UI 的插件

```bash
node create-plugin.mjs --name dsh-my-ui --type ui --port 39501 \
  --out ./my-plugins --domain my-ui --yes
```

生成的 `editor/` 会被 `server/relay.mjs` 静态托管在 `/`。UI 规则见 [PLUGIN_UX_STANDARD.md](../PLUGIN_UX_STANDARD.md)：

- 打开即工作，不显示“未连接/待命/重连”；
- 多窗口后打开者自动抢占，旧窗口静默待命；
- 使用 `ctx.editorHost` 做静态托管与租约仲裁（底层 `dsh-plugin-kit/editor/lease.mjs`）。

---

## 接入检查清单

- [ ] 服务是 `127.0.0.1` 绑定
- [ ] `/healthz` 返回 `{ ok, name, version, contractVersion, uptimeSec }`
- [ ] `/metrics` 至少 `<slug>_up`、`<slug>_uptime_seconds`
- [ ] `/mcp` 走 `createMcpHandler`
- [ ] 每个工具都有 inputSchema，且限制 `maxLength` / `maxItems`
- [ ] 有 `*_capabilities` 契约工具
- [ ] 单实例锁 + 退出释放
- [ ] `npm test` 通过
- [ ] `dsh-suite validate` 通过
- [ ] `dsh-domain validate` 通过
