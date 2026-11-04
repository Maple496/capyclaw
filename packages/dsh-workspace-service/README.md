# dsh-workspace-service

把统一 Workspace 中间层挂进 DSH 进程，向同进程插件提供：

```js
ctx.workspace
```

功能插件只需：

```js
export const inject = ['workspace']

export function apply(ctx) {
  const work = ctx.workspace.getWork('main')
  work.putJson('main', 'state.json', data)
  const backend = ctx.workspace.getBackend('main')
}
```

## 职责

- 读取当前 runtime 的 `runtime.json`
- 创建 scoped `WorkspaceClient`（只允许当前 runtime namespace）
- 提供 `getWork` / `getBackend` / `read` / `write` / `checkpoint`
- 不直接拥有端口、进程或打包逻辑；那些属于 runtime-control / suite-kit

## 安装

它是一个标准 suite，可与其他 suite 一起组成 domain：

```bash
dsh-suite install packages/dsh-workspace-service --profile web
```

或者作为 domain 的 component 加入。

## 约束

- 每个 DSH runtime 只应挂载一个 `workspace-service`；`ctx.provide('workspace')` 是单例服务。
- 它只提供当前 runtime 的 scoped client，不提供跨 runtime 读写。

## 测试

```bash
npm --prefix packages/dsh-workspace-service test
```

E2E 会真实启动 DSH runtime，验证 `ctx.workspace` 注入、对象仓库 roundtrip、双 runtime 隔离、PPT 共用、重启保留、bundle setup。
