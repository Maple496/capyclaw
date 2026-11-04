# Launcher 包构建与运行期安装（2026-11-03）

## 阶段边界

| 阶段 | 输入 | 输出 | 归属 |
|---|---|---|---|
| 构建期 | `products/dsh-desktop/product.json`、launcher domain 源、`tools/product-packager` | `dist-products/` 便携产品；`dist-launchers/<id>-<version>.zip` 独立包 | 开发/构建；不自动覆盖已有输出 |
| 交付期 | `dsh.exe`、`node/`、`app/` 运行文件、内置 launcher 种子 | 可独立运行的产品目录 | 交付文件；`app/` 作为只读资源 |
| 运行期 | 内置种子或用户明确选择的 launcher ZIP | `data/launchpads/*.stack`、`data/launchers/<id>/`、`data/launcher-state/<id>/` | 用户数据；启动时不覆盖已存在或已删除的清单 |

`launcher/Program.cs` 是构建期源码，仅用于编译 `dsh.exe`，不再复制到产品。`tools/product-packager` 和测试文件不作为运行期模块发布；只复制 `runtime/launcher-registry.mjs` 作为产品安装能力。`stageDomain` 不复制测试、示例和 bench 目录。

## 分发与安装

- `npm run build-launchers` 从同一 `product.json` 的 launcher 配置构建独立 ZIP，不覆盖现有包。
- ZIP 根包含 `launcher.json` 和 `domain/`；production npm 依赖闭包（如 PPT 的 `pptxgenjs`/`jszip`）会随包携带。安装时从已验证的 domain 包引用物化 workspace 包，使 ESM 可以按包名解析，不依赖构建机的工作区链接。
- `dsh.exe install-launcher <zip>`、`list-launchers`、`remove-launcher <id>` 与 UI 安装调用同一运行期 registry。
- UI 安装需要 loopback、同源、`data/launcher-install.token`，若同时设置 `LAUNCHPAD_TOKEN` 还需要原 API token；用户必须确认包包含可执行代码。安装成功后管理器重新扫描，无需重启或重打包。
- 安装/卸载同 dshd domain 生命周期共用锁，重复 ID 默认拒绝；正在运行的进程或 discovery 中存活的服务会阻止卸载。删除默认保留 `data/launcher-state/<id>`；显式 `--remove-state` 才删除状态。保留状态后重新安装相同 ID 会生成新 runtimeId，旧状态不自动挂载。
- ZIP 限制：64 MiB 压缩包、512 MiB 总展开、64 MiB 单文件、20,000 条目；拒绝加密、ZIP64、数据描述符、重复或不安全路径及 symlink，并校验本地头、中心目录、CRC 和大小。ZIP 并不代表签名或可信发布者，启动包代码不在沙箱运行。

## 真实产品演练

在全新临时 Windows 产品目录，实际运行了：

1. 构建产品，启动 base；base 与管理器自动分配本机端口，管理器看到内置 `ppt`。
2. 独立构建 50,783,832 字节的 `ppt-copy` ZIP，通过带安装 token 的本地 UI API 上传；文件落在 `data/launchers/ppt-copy`，清单落在 `data/launchpads/ppt-copy.stack`，无需重打包产品。
3. 从管理器启动 `ppt-copy`，真实启动 dsh、broker、PPT relay 和 skills；`/healthz` 返回 `{ok:true,bridge:"ppt-workbench",contractsOk:true}`。实测从安装后的 PPT 组件路径同时导入 `dsh-document-workbench` 和 `pptxgenjs` 成功。
4. 运行中调用卸载被拒绝；停止后卸载成功，旧 runtime 状态文件仍保留。用同一 ZIP 重新安装时分配了新 runtimeId，避免覆盖旧状态。
5. 停止产品；测试中产品进程已回收。

## 边界与后续

- 这是本地可信用户选择可执行包的安装链，不提供发布者签名、在线市场或自动更新。安装 token 不能替代系统访问控制或代码签名。
- 当前安装采用暂存后分别发布包目录和 stack；进程崩溃在两次文件系统操作之间可能留下需人工检查的残留。生命周期锁在进程异常退出后也可能残留；应在确认没有对应进程后处理锁文件。
- 新产品默认自动分配 base 端口；具体地址从运行态 discovery 读取。
- 单文件安装器/SFX 和代码签名仍未实现；产品交付为便携目录 + `dsh.exe`。
