# dsh-catalog

把共享 `catalog/works.json` 和 Workspace manifest 暴露成 DSH 插件服务：

```js
export const inject = ['catalog']
const works = ctx.catalog.list()
```

功能插件不直接读 catalog 文件，管理 UI 也通过这个服务读取。
