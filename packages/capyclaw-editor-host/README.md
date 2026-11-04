# @capyclaw/editor-host

DSH 公共编辑器宿主插件。功能插件只提供 `editor/` 静态目录，不再自己写静态路由、租约和连接状态。

## 使用

```js
export const inject = ['editorHost', 'serviceHost']

export function apply(ctx, config) {
  const editor = ctx.editorHost.createEditorHost({
    id: 'my-editor',
    dir: path.join(packageDir, 'editor'),
    basePath: '/editor',
    files: { '/': 'index.html', '/app.js': 'app.js' },
  })
  const app = ctx.serviceHost.createApp({
    id: 'my-plugin',
    health: () => editor.status(),
  })
  for (const route of editor.routes()) app.use(route)
}
```

## 提供什么

- `createEditorHost({ id, dir, basePath, index, files })`
  - `routes()`：静态文件 + 租约端点
  - `status()`：`{ connected, lease }`，可直接并入 `/healthz`
- `createLease()`：`@capyclaw/plugin-kit/editor/lease` 的租约仲裁
- 端点：`POST <base>/claim`、`POST <base>/release`、`GET <base>/status`

## 约定

- “显示即连接”：页面加载后自动 claim；后打开者强制抢占
- 租约状态只用于内部仲裁，不渲染成“未连接/待命”
- 心跳间隔应小于 TTL（默认 3s / 15s）
