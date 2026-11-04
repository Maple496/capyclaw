# @capyclaw/asset-service

DSH 公共资产插件。功能插件通过 `ctx.assets` 获得统一的 sha256 对象仓库和 `/assets` 路由。

## 使用

```js
export const inject = ['assets']

export function apply(ctx) {
  const app = ctx.serviceHost.createApp({ id: 'my-plugin' })
  app.use(ctx.assets.routes())
}

// 或在插件内部写入
const asset = await ctx.assets.put(buffer, 'image/png')
// { id, key, url: '/assets/<sha256>', size, contentType }
```

独立运行或测试：

```js
import { createFileAssetStore, createAssetRoutes } from 'dsh-asset-service/src'
const store = createFileAssetStore({ dir: './assets' })
```

## 路由归属

多个插件共用一个 service-host app 时，用 `ctx.assets.mount(app)` 只挂一次 `/assets`：

```js
ctx.assets.mount(app, { store: assetStore })
```

重复 mount 会被忽略；不要再手写 `app.use(ctx.assets.routes())`。

## 提供什么

- `createWorkspaceAssetStore({ storeClient, workId })`：资产归当前 work
- `createFileAssetStore({ dir })`：本地目录后端
- `createAssetRoutes({ assetStore, basePath })`：GET/HEAD `/assets/<id>`、POST `<basePath>/assets`
- `ctx.assets.put/get`：默认 store 快捷方法

## 契约

- 资产按 sha256 去重，不可变
- url 固定为 `/assets/<id>`，可长期缓存
- 内容类型由上传方声明，读取时原样返回
