# 开发环境手册（新机器完全重建）

> 目标：换一台电脑，`git clone` + 一条命令恢复全部构建/测试能力。
> CI（`.github/workflows/ci.yml`）在干净的 ubuntu + windows runner 上持续证明这套流程可重建。

## 一分钟版本

```bash
git clone git@github.com:Maple496/capyclaw.git
cd capyclaw
npm run bootstrap        # node 闸 → npm install → playwright chromium → L1 冒烟
```

带全量验证的重建（几分钟）：

```bash
npm run bootstrap -- --full
```

## 环境矩阵

| 依赖 | 要求 | 说明 |
|---|---|---|
| Node | **>= 20**（`.nvmrc` = 25.2.1） | `nvm install && nvm use`；`engines.node` 已锁，低版本 `npm install` 会告警 |
| npm | >= 10（随 Node 20+ 自带） | workspace + lockfile v3 |
| Git | 任意近期版本 | 仓库含 `package-lock.json`，依赖精确还原 |
| Playwright chromium | bootstrap 自动安装 | L6 真浏览器层用；浏览器二进制不进 node_modules，换机必装 |
| 网络 | registry.npmjs.org 可达 | 安装与 L5 发布预演（dry-run，无需登录）；`--skip-network` 可离线跑大部分层 |
| 平台 | Windows / Linux / macOS | e2e 全链已做跨平台分支（junction↔symlink、taskkill↔SIGTERM） |

不需要：dsh 桌面端、数据库、Docker。插件构建/测试/打包全部自包含。

## 日常命令速查

```bash
npm run build            # 构建全部插件包产物（ppt + canvas → plugin/）
npm run check            # 构建漂移检查（不改文件）
npm run validate-all     # 全部插件结构校验
npm run test:e2e         # 六层验证（静态/单元/服务/MCP/broker/发布/浏览器）
npm run verify:install   # 沙箱安装形态验证（见下）
npm run release          # zip + index + registry 全链（不发布）
npm run publish:npm      # 发布预演 dry-run（不真发）
```

## 沙箱安装形态验证（dsh 用户视角）

模拟「dsh 删除全部插件 → npm 全量重装 → 实测」：

```bash
npm run verify:install                # 全链：安装 + 加载 + canvas 真浏览器 + ppt 冒烟
npm run verify:install -- --keep      # 保留沙箱目录供排查
npm run verify:install -- --skip-browser
```

- registry 里**已发布**的包直接从 npm registry 安装（真实用户路径）
- **未发布**包走 `npm pack` tarball 同批安装（等价发布后形态，发布顺序见 PUBLISHING.md）
- 断言：依赖树 0 UNMET、28 插件 cordis 加载、canvas 22 工具真浏览器链路、ppt 27 工具冒烟

## 平台差异

| 事项 | Windows | Linux/macOS |
|---|---|---|
| 目录链接（L4 伪造安装态） | `mklink /J` junction，无需管理员 | symlink（用户目录内无需特权） |
| 进程树回收 | `taskkill /T /F` | `SIGTERM` |
| Playwright 系统库 | 免 | 缺库时 `sudo npx playwright install-deps chromium` |
| npm 脚本 | 脚本内部统一 `shell: win32` 处理 | 同一套代码，无需改 |

## 发布（可选，仅发布机需要）

- `npm whoami` 登录 capyclaw 发布账号，或设 `NODE_AUTH_TOKEN`
- 顺序纪律：支撑库（plugin-kit → document-workbench）→ 运行时插件 → suite；
  同版本号内容变化必须 bump（npm 禁止同版本重发），参考 `scripts/bump-patch.mjs` 与
  PUBLISHING.md

## dsh 桌面端联调（可选）

构建产物是否合入 dsh 运行时由 `~/.dsh` 的 profile 决定，与本仓库解耦：

```bash
# 在目标 profile 安装（发布后）
dsh plugin --profile <name> add @capyclaw/canvas-suite
# 或本地联调：编辑 ~/.dsh/profiles/<name>/package.json 用 link: 指向本仓包目录
```

联调端口约定：canvas 39313 / ppt 39311 / skills 39321（services.json 固定端口，本地被占用时 e2e 会跳过对应项）。

## 故障排除

| 症状 | 处置 |
|---|---|
| L6 全挂：浏览器未安装 | `npx playwright install chromium`（bootstrap 第 3 步） |
| L4 跳过：固定端口被占用 | 停掉本机 393xx 段服务（dsh 实例），或 `--layer` 跳过 L4 |
| Windows 上 symlink 报权限 | 不应出现（用的是 junction）；若出现说明跑在非 NTFS 盘 |
| `npm install` 后 e2e 找不到 workspace 包 | 确认在仓库根执行（workspace 根 hoist） |
| L5 dry-run 失败 | 网络不通 registry.npmjs.org 时加 `--skip-network` |
