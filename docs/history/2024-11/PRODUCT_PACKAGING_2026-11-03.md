# 产品化交付：独立 DSH + 启动程序管理器 + exe 打包（2026-11-03）

> 目标形态：用户拿到一个独立可运行的 DSH（Windows 交付为文件夹 + `dsh.exe`）。
> base dsh 里由 `dsh-launchpad` 展示/启动不同 launcher（如 PPT 工作台）；
> 每个 launcher = 独立 domain runtime（自己的 dsh + broker + services），
> 端口/服务/文件/会话由基建插件负责；打包器数据驱动、不认识具体 launcher。

## 一、产品结构

```text
dsh-desktop/
  dsh.exe                     C# 薄启动器（转发到 node + app/bootstrap.mjs）
  dsh.cmd / dsh.sh            兜底
  node/                       便携 Node 22
  app/
    bootstrap.mjs             start/stop/status/doctor/logs/open（通用）
    product.json              构建期唯一清单
    core-harness/deepseek-harness/   dsh 主程序 + node_modules
    tools/dsh-launcher/       dshd（profile/domain 两种 stack）
    packages/                 stack-kit/suite-kit/plugin-kit/runtime-kit/broker + infra
    extensions/official/dsh-launchpad/   管理器（host + 独立服务）
    launchpads/base.stack      base dsh（管理器 + 基建）
    launchpads/ppt.stack       launcher（kind=domain）
    launchers/ppt/domain/      stageDomain 后的 PPT 领域包（自带 broker/kit）
  data/                       首次启动创建：base DSH_HOME/store/workspace +
                              每个 launcher 的 state/store/runtime
```

启动链：

```text
dsh.exe start
  └─ base dsh 39000（base profile：dsh-base/web-app + dsh-launchpad）
       └─ launchpad service 39010（broker 拉起，独立进程）
            ├─ GET  /api/launchpads          → base + ppt（domain 状态从 runtime.json）
            └─ POST /api/launchpads/ppt/start
                 └─ dshd start --stack app/launchpads/ppt.stack
                      └─ PPT domain runtime：dsh 39100 + broker 8871 +
                         ppt-workbench 8870 + dsh-skills 39321
```

## 二、实现

| 文件 | 作用 |
|---|---|
| `tools/product-packager/lib/index.mjs` | 打包器：manifest → 复制运行时工具/base 插件/infra/harness/node → stageDomain → base/launcher DSL → product.json → bootstrap → dsh.exe |
| `tools/product-packager/bin/build.mjs` | CLI（`--manifest/--out/--skip-runtime/--skip-exe/--zip`） |
| `tools/product-packager/templates/bootstrap.mjs` | 通用产品启动器（不依赖具体 launcher；首次运行建链接、编译 DSL、调 dshd） |
| `tools/product-packager/launcher/Program.cs` | C# 薄 exe：`node\node.exe app\bootstrap.mjs <cmd>` |
| `tools/product-packager/product.schema.json` | product 清单 schema |
| `products/dsh-desktop/product.json` | 示例产品：base（launchpad）+ PPT launcher + infra 列表 |
| `extensions/official/dsh-launchpad/lib/dsl.mjs` | 新增 `kind "domain"` handler（source/runtimeId/profile/env/requires/scope/model） |
| `extensions/official/dsh-launchpad/lib/launchpads.mjs` | domain 状态从 runtime.json + discovery 读；start 不再假设 home/workspace；支持 domain 型列出/启动/停止 |
| `packages/dsh-suite-kit/src/domain.mjs` | `stageDomain` 自带 `dsh-service-broker`（runtime 启动 services 必需） |
| `tools/dsh-launcher/lib/domain.mjs` | dshd 的 domain 执行面（start/stop/status/doctor/logs/supervise） |

## 三、实测（真实产品启动）

构建：

```bash
node tools/product-packager/bin/build.mjs \
  --manifest products/dsh-desktop/product.json \
  --out dist-products/dsh-desktop
# ✓ dsh.exe（csc 编译）；base + PPT launcher；data/ 首次创建
```

启动 base：

```bash
dist-products/dsh-desktop/dsh.exe start
# ✓ DSH 桌面 已就绪: http://127.0.0.1:39000/
#   启动管理器: http://127.0.0.1:39010/
```

实测端点：

| 项 | 结果 |
|---|---|
| base dsh | `http://127.0.0.1:39000/` → 200 |
| launchpad 服务 | `http://127.0.0.1:39010/healthz` → `{ok:true,service:"dsh-launchpad"}` |
| 管理器列表 | `base` running + `ppt` stopped（kind=domain，runtimeId=rt-ppt） |
| 启动 PPT launcher | `POST /api/launchpads/ppt/start` → `ok:true`，state=running |
| PPT 领域 runtime | dsh `39100`（200）、broker `8871`、ppt-workbench `8870`、dsh-skills `39321` |
| PPT health | `{ok:true,bridge:"ppt-workbench",contractsOk:true,...}` |
| 停止 | `dsh.exe stop` → `✓ 已停止 domain runtime rt-ppt` + base 停止；39000/39010/39100/8870/8871/39321 全部释放 |

## 四、解耦设计

1. **打包器不认识 PPT**：launcher 只是 `product.json` 里的 domain 路径；新增 launcher 只改清单。
2. **base 与 launcher 互不 import**：base 通过 launchpad 服务 + dshd 启动 launcher；launcher 是独立 runtime，用 HTTP/MCP/discovery 协作。
3. **基建下沉**：端口/服务/守护/discovery 在 `dsh-service-broker` + `dsh-stack-kit`；文件/会话在 `dsh-workspace-service`；launcher 领域只声明 domain/suite/services。
4. **启动器薄壳**：`dsh.exe` 只转发；编排在通用 `bootstrap.mjs` + 现有 dshd；不复制一套编排逻辑。
5. **产品可移动**：首次启动按当前路径重建 base profile 链接（junction），不依赖构建机绝对路径。
6. **DSL 是作者层**：base/launcher 都由 `.stack` 描述；launchpad UI 与 bootstrap 共用同一个编译器。

## 五、边界

- 交付形态是**文件夹 + dsh.exe**（便携）；不是单文件自解压 exe。需要单文件时可后续加 7z SFX/安装器。
- base 端口固定（39000/39001/39002/39010）；launcher 端口可在 product.json 配置（PPT 示例 content=auto，避免占用冲突）。
- `dsh.exe` 编译依赖 Windows .NET Framework `csc.exe`；缺失时生成 `dsh.cmd` 兜底。
- `.works` 的 autoStart/钩子/健康检查仍归 `dsh-deploy` 部署配置，不塞进产品启动器。
- 自动更新、签名、安装器、托盘常驻未做；当前是“解压即用”的便携产品。
