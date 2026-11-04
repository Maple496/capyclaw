# 扩展指南

## 1. 新增一个能力（工具）

以「水印」为例，只需要两个文件动作：

```js
// src/mcp/tools/capabilities/watermark.mjs
import { defineCapability, defineTool } from '../kernel/define.mjs'

export const watermarkCapability = defineCapability({
  id: 'watermark',
  title: '水印',
  description: '给每页加统一水印',
  tags: ['write', 'decoration'],
  requires: ['deck'],
  features: ['deck.watermark'],
  tools: [
    defineTool({
      name: 'ppt_watermark',
      description: '给指定页或全部页加文字水印。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 40 },
          slides: { type: 'array', items: { type: 'integer' } },
        },
        required: ['text'],
        additionalProperties: false,
      },
      kind: 'write',
      since: '2.3.0',
      handler: async ({ text, slides }, ctx) => {
        const targets = Array.isArray(slides) && slides.length ? slides : null
        const ops = (targets || []).map((slide) => ({
          op: 'add-element',
          slide,
          element: { type: 'text', text, left: 360, top: 250, width: 280, height: 60, fontSize: 14, color: '#999999' },
        }))
        const r = await ctx.deck.write(ops)
        return { text: r.ok ? `已加 ${ops.length} 个水印` : `失败：${r.error}` }
      },
    }),
  ],
})
```

然后在唯一扩展点登记：

```js
// src/mcp/tools/capabilities/index.mjs
import { watermarkCapability } from './watermark.mjs'

export const CAPABILITIES = [
  // ...
  watermarkCapability,
]
```

构建后自动完成：

- `TOOLS` / `TOOL_IMPL` / `TOOL_META` / `FEATURES` / `CAPABILITIES` 派生；
- `ppt-contract.json` 快照；
- `serverInstructions` 能力表；
- `ppt_capabilities` 返回值。

不需要再维护集中式 `schema.mjs` / `deps.mjs`（已删除）、不需要改 `tools/index.mjs`、`contract.mjs`、`mcp-http.mjs` 或测试计数。

## 2. 声明依赖与组合

```js
defineCapability({
  id: 'element',
  requires: ['deck', 'media'],   // 端口/服务
  dependsOn: ['image'],          // 能力依赖；enabled 时会自动带上
})
```

- `requires`: 由 `kernel/ports.mjs` 或能力 `provides` 提供的命名空间；registry 启动时校验。
- `dependsOn`: 能力级依赖；`createRegistry(CAPABILITIES, { enabled: ['element'] })` 会自动加载 `image`。
- `provides`: 能力对外服务，例如 image 提供 `{ media: { insertImage } }`；服务函数签名是 `(ctx, ...args)`。

能力模块之间不要互相 import；跨能力调用只走 `ctx.<service>`。

## 3. 新增一个底层 op

1. 在 `src/core/ops/<domain>.js` 加一个定义：
   ```js
   export const watermarkOps = {
     'add-watermark': {
       run(P, c) { /* 只操作 P 接口 */ },
     },
   }
   ```
2. 在 `src/core/ops/index.js` 的 `OP_MODULES` 登记域文件。
3. 在 `contract/ops.json` 的 `ops` 数组登记 `{ "op": "add-watermark", "desc": "..." }`。
4. 需要时在能力里 push 这个 op。

`test/contract.test.mjs` 会双向校验 `OP_NAMES` 与 `contract/ops.json`；`test/ops.test.mjs` 继续用 fake `P` 覆盖行为。

## 4. 新增一个 recipe（组合型工具）

recipe 只组合 core 引擎与端口，不复制底层逻辑：

```js
import { buildDeck } from '../../../core/deck-layout.js'

handler: async ({ slides }, ctx) => {
  const deck = buildDeck({ slides })      // core 引擎
  const r = await ctx.deck.write([{ op: 'load', deck }])  // 端口
  return { text: r.ok ? 'ok' : r.error }
}
```

不要在一个 recipe 里再实现一套文字/图片/换色逻辑；复用 `core/*` 或 `domains/*`。

## 5. 新增 relay 路由

`server/routes/*` 每个模块导出一个 `createXxxRoutes(deps)`，返回路由函数数组：

```js
export function createWatermarkRoutes({ store }) {
  return [async (req, res, u) => {
    if (u.pathname !== '/watermark') return false
    // ... send(req, res, ...)
    return true
  }]
}
```

在 `server/relay.mjs` 的 `createRouter([...])` 里按顺序加入。路由只做 HTTP 适配，业务逻辑放 store/core。

## 6. 测试清单

- `node --test test/architecture.test.mjs`：能力隔离、唯一性、扩展烟测。
- `node --test test/contract.test.mjs`：工具/op 契约。
- `npm test`：全量行为测试。
- `node scripts/build-plugin.mjs && node scripts/build-plugin.mjs --check`：生成物一致。
- `node scripts/build-works.mjs && node scripts/build-works.mjs --check`：桌面 `.works` 产物一致。

## 7. 能力选择（可选）

`createRegistry(CAPABILITIES, { enabled: ['text', 'image'] })` 只装载指定能力；`dependsOn` 会自动补齐。relay 通过 `config.capabilities` 透传，默认不限制（全部启用）。
