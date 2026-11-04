# dsh-state-service

DSH 公共状态插件。功能插件通过 `ctx.state` 获得统一的状态、journal、checkpoint 和崩溃恢复，不再各自实现 `FileBridgeBackend`。

## 使用

```js
export const inject = ['state']

export function apply(ctx) {
  const backend = ctx.state.createFileBackend(path.join(hostDir, 'state.json'), {
    initialDoc: { seq: 0, slides: [] },
  })
  const store = new (ctx.state.PersistentStore)({ backend, initialDoc: { seq: 0, slides: [] } })
  // 业务方法直接改 store.doc 后 store.save()
}
```

恢复：

```js
await ctx.state.replayPending({
  store,
  pending: () => store.pending(),
  apply: (cmd) => applyOp(cmd),
})
```

## 提供什么

- `FileStateBackend`：原子 JSON 状态 + append-only journal（2MB 轮转）+ 命名 checkpoint
- `PersistentStore`：通用状态门面，业务 store 可继承
- `replayPending`：崩溃后重放未完成批次并回执
- `createFileBackend` / `createStateHost`

## 与 workspace-service 的分工

- `ctx.workspace`：作品文件、work manifest、版本 CAS、目录 catalog
- `ctx.state`：插件运行状态、journal、checkpoint、恢复
