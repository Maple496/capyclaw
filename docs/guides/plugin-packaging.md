# DSH 插件打包与分发指南

## 1. 两种分发物

| 分发物 | 用途 | 工具 |
|---|---|---|
| 单插件 ZIP | 把某个插件给已有 Harness 的用户 | `plugin-development/pack-plugin.mjs` |
| Domain bundle | 把 Harness + 插件 + Node 运行时打包成开箱即用目录 | `scripts/build-bundle.mjs` |

推荐先发 suite，再发 bundle；不要让用户手工拷插件到 `workspace/plugins`（DSH 0.2.x 不会扫描该目录）。

## 2. 打包单个插件

```bash
cd plugin-development
node pack-plugin.mjs ./my-plugins/my-service/plugin/my-service
```

产物：

```text
plugin-development/dist/dsh-my-service-v1.0.0.zip
```

打包器行为：

- 始终包含 `package.json`、`README.md`、`LICENSE*`、`THIRD_PARTY_NOTICES.md`（存在时）；
- 按 `package.json.files` 收集，支持目录、文件和 `!` 排除项；
- 打包前对 staged 产物自检：`package.json`、`main`、`dsh.bundle.patch`、`dsh.suite`；
- 使用内置 ZIP 写入器，不依赖 PowerShell，Windows/macOS/Linux 结果一致。

安装：

```bash
# 解压后
dsh plugin --profile web add /path/to/unzipped-plugin
```

## 3. 打包 suite / domain

suite 本身也是 npm 包，可以直接用 `pack-plugin.mjs` 打包：

```bash
node pack-plugin.mjs ./my-plugins/my-service/plugin/dsh-my-service-suite
```

domain 包用 `dsh-domain stage`：

```bash
node packages/dsh-suite-kit/bin/dsh-domain.mjs stage \
  ./my-plugins/my-service/domains/my-service \
  --out ./dist/domain-my-service
```

stage 产物包含 `components/`、`kit/`、`domain.json`、`install.mjs`，可整体拷贝到另一台机器再执行：

```bash
cd dist/domain-my-service
DSH_PROFILE=domain-my-service node install.mjs
```

## 4. 构建完整 bundle

```bash
# 便携版（目标机器需安装 Node.js）
node scripts/build-bundle.mjs \
  --domain bridges/ppt-bridge/domains/ppt \
  --out builds/ppt-portable \
  --target portable

# Windows 完全版（内置 node，默认复用现有 bundles/dsh-ppt-windows-bundle/node）
node scripts/build-bundle.mjs \
  --domain bridges/ppt-bridge/domains/ppt \
  --out builds/ppt-windows \
  --target windows
```

构建器做什么：

1. 通过 `dsh-suite-kit` 解析 domain → suite → packages；
2. `stageDomain` 生成 `domain/`（组件 + kit + domain.json）；
3. 复制 Harness shell（`auth-proxy.mjs`、`package.json`、`package-lock.json`、`process-manager.mjs`、`single-instance.mjs`、`node_modules`）；
4. 生成 `setup.mjs`：调用 `installDomain({ runPnpm: false })`，在 `<bundle>/.dsh/profiles/<profile>` 建链接和 profile；
5. 生成 `start.bat` / `start.sh` / `start-silent.vbs`（Windows）；
6. 写 `bundle.manifest.json` 和 README。

启动：

```bash
# Windows
start.bat

# macOS / Linux
bash start.sh
```

## 5. 旧发布包

- `bundles/dsh-ppt-bundle/` 和 `bundles/dsh-ppt-windows-bundle/` 是旧版手工构建产物，仍可运行，但不再推荐作为新发布流程。
- 新发布统一走 `scripts/build-bundle.mjs`，默认输出到 `bundles/build/`，不会覆盖旧包。
- `scripts/pack-for-deployment.mjs` 和 `scripts/pack-windows-complete.mjs` 现在只是 `build-bundle` 的薄包装。

## 6. 发布前检查

- [ ] 插件 `npm test` 通过
- [ ] `dsh-suite validate` / `dsh-domain validate` 通过
- [ ] 打包产物解压后有 `package.json`
- [ ] 安装到干净 profile 后 `/healthz` 返回 200
- [ ] MCP `initialize` / `tools/list` / `tools/call` 正常
- [ ] bundle `setup.mjs` 可在空 `DSH_HOME` 下重复执行
- [ ] 不把 `node_modules`、`.git`、锁文件、日志打进单插件 ZIP
