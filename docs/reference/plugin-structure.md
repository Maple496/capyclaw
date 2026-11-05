# DSH 插件体系架构规范

## 📁 目录结构

```
deepseekharness_dev/
├── extensions/                          # 插件根目录
│   ├── official/                        # 官方维护插件（独立可发布包）
│   │   ├── capyclaw-launchpad/
│   │   ├── capyclaw-plugin-sync/
│   │   └── ...
│   └── bridges/                         # 外部工具桥（构建工场，private）
│       ├── ppt-bridge/                  # src/* → plugin/ 下 10 个生成包
│       └── canvas-bridge/               # src/* → plugin/ 下 6 个生成包
│
├── packages/                            # 基础设施包
│   ├── capyclaw-plugin-kit/             # 插件开发 SDK（@capyclaw/plugin-kit）
│   ├── capyclaw-suite-kit/              # 组合标准件（@capyclaw/suite-kit，private）
│   ├── capyclaw-service-host/           # 服务托管
│   └── ...
│
├── tools/                               # 开发工具链（目录名 capyclaw-plugin-*）
│   ├── capyclaw-plugin-generator/       # 插件脚手架生成器
│   ├── capyclaw-plugin-validator/       # 插件验证工具
│   └── capyclaw-plugin-release/         # 发布、源索引与校验（private）
│
└── scripts/                             # 流水线脚本（validate-all / publish / registry 等）
```

**命名约定（统一）**：发布包名 `@capyclaw/<base>`，目录名 = 包名去 scope（`capyclaw-<base>`）；
私有构建工场（bridges、plugin-release）用 `@capyclaw/ppt-bridge`、`@capyclaw/canvas-bridge`
等短目录名。已发布包的包名不改（保 npm 连续性）。

---

## 🔒 插件规范（验证器强制）

### 1. 目录结构（必需）
```
my-plugin/
├── package.json              # 必需：包含 dsh 字段
├── lib/                      # 必需：主入口（host.mjs / index.mjs）
├── README.md                 # 必需：使用说明
├── test/                     # 可选：测试（有 npm test 则发布前必跑）
└── cordis.patch.yml          # bundle 插件必需（dsh.bundle.patch 指向）
```

### 2. package.json 必需字段
```json
{
  "name": "@capyclaw/*",                  // 作用域包名（历史 dsh-* 形态亦兼容）
  "version": "x.y.z",
  "description": "...",
  "type": "module",                       // 强制：ESM
  "main": "./lib/host.mjs",               // cordis 插件入口；纯库用 ./src/index.mjs
  "engines": { "dsh": "^0.2.0-rc.2" },    // 发布闸要求
  "publishConfig": { "access": "public" },// 作用域包发布必需
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "category": "ui|service|bridge|tool|skills",
    "platform": "web|desktop|both"
  },
  "meta": { "title": "...", "description": "..." }
}
```

### 3. 基础设施依赖（分层）

**最小层（Tier 0）：纯客户端插件**
```json
{ "dependencies": { "@capyclaw/plugin-kit": "^0.2.0" } }
```

**标准层（Tier 1）：需要服务端能力**
```json
{
  "dependencies": {
    "@capyclaw/plugin-kit": "^0.2.0",
    "@capyclaw/service-host": "^0.1.0"
  }
}
```

**完整层（Tier 2）：复杂业务插件**
```json
{
  "dependencies": {
    "@capyclaw/plugin-kit": "^0.2.0",
    "@capyclaw/service-host": "^0.1.0",
    "@capyclaw/tool-host": "^0.1.0",
    "@capyclaw/asset-service": "^0.1.0"
  }
}
```

**套件层（Suite）：插件组合**
```json
{
  "dependencies": {
    "@capyclaw/plugin-kit": "^0.2.0",
    "my-plugin-a": "^1.0.0"
  },
  "dsh": { "suite": "./dsh-suite.json" }
}
```

---

## ⚙️ 验证规则（程序强制）

### 自动验证检查项（tools/capyclaw-plugin-validator）

1. **目录结构**：必需文件 package.json / README.md / lib
2. **package.json**：必需字段、`@capyclaw/plugin-kit` 依赖、
   基础设施包版本在锁定范围内（INFRASTRUCTURE_VERSIONS）
3. **代码质量**：ESM 模块格式；可加载（import 不报错），
   导出符合约定（apply / name）

**测试是可选的但被鼓励**：有 `scripts.test` 的包在 `publish:execute` 时必跑测试
（canvas-bridge 的 55 项测试是现役范例）。验证器不强制 test/ 目录。

### 验证时机
- 开发时：`npm run validate-plugin <路径>` / `npm run validate-all`
- 发布前：`npm run release`（构建 → lint → 校验 → 打包 → registry 一致性，
  详见 [PUBLISHING.md](../PUBLISHING.md)）
- 本仓库不设 pre-commit hook 与 CI——发布闸即验证闸

---

## 🛠️ 开发工具

```bash
npm run create-plugin                    # 脚手架生成插件骨架
npm run validate-plugin <path>           # 验证单个插件
npm run validate-all                     # 验证全部插件
npm run release                          # 一键发布准备流水线
npm run publish:execute                  # 发布（先库后插件，默认 dry-run）
```
