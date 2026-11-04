# 部署与 bundle 构建

旧的“手工拷贝 auth-proxy + workspace/plugins”方案已废弃。DSH 0.2.x 通过 profile 的 `dsh.profile.bundles` 加载 suite，不会扫描 `workspace/plugins`。

## 新流程

```bash
# 便携版（目标机器需装 Node.js）
node scripts/build-bundle.mjs \
  --domain bridges/ppt-bridge/domains/ppt \
  --out builds/ppt-portable \
  --target portable

# Windows 完全版（内置 node）
node scripts/build-bundle.mjs \
  --domain bridges/ppt-bridge/domains/ppt \
  --out builds/ppt-windows \
  --target windows
```

产物结构：

```text
builds/ppt-portable/
├── domain/                  # 由 dsh-domain stage 生成（组件 + kit + domain.json）
├── deepseek-harness/        # auth-proxy + node_modules
├── setup.mjs                # 首次运行：在 bundle 内 .dsh 建立 profile 和链接
├── start.bat
├── start.sh
├── bundle.manifest.json
└── README.md
```

启动：

- Windows：`start.bat`
- macOS/Linux：`bash start.sh`

首次启动会创建 `<bundle>/.dsh/profiles/domain-ppt`，不需要 pnpm，也不写用户主目录。

## 兼容入口

`scripts/pack-for-deployment.mjs` 与 `scripts/pack-windows-complete.mjs` 现在只是 `build-bundle.mjs` 的薄包装，默认输出到 `bundles/build/`，不会覆盖旧的 `bundles/dsh-ppt-*`。

## 旧方案

旧的 `bundles/dsh-ppt-bundle/` 和 `bundles/dsh-ppt-windows-bundle/` 仍可运行，但只作为历史产物保留；请勿继续手工往里拷插件。
