# dsh-installer

控制面插件，提供 `ctx.installer`：

- `resolve(domain)`
- `stage(domain, outDir)`
- `install(domain, { profile, dshHome, runPnpm })`

它只包装 `dsh-suite-kit` 的 pure 编排接口，不直接启动进程。
