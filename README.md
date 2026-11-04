# dsh 插件工程

**本仓库只做三件事：构建 dsh 插件、生成打包产物、手动发布到 npm。**

不改 dsh 源码。dsh 是 npm 依赖（`@deepseek-ai/dsh`），所有扩展都通过 Cordis 官方扩展点
（`cordis.patch.yml` 的 `insert`）注入；仓库内全部 patch 操作均为 `insert`，
没有 `update`/`remove`。

> 测试不在本仓库职责内。仓库产出的合格产物是否发布，由人工执行发布命令决定。

---

## 流水线

```
① 构建            ② 打包                    ③ 手动发布
build:plugin  →   release-all / release-index  →   publish:npm (dry-run 预览)
（源内构建，        （dist/plugins/*.zip          publish:execute（人工确认后执行）
 产物提交进仓）      + dist/index.json）
```

```bash
npm install                     # 建立 workspace 链接

npm run build:plugin            # 构建 PPT 插件包（10 个包 → ppt-bridge/plugin/）
npm run check:plugin            # 构建漂移检查（不改文件）
npm run validate-all            # 校验全部插件结构

npm run release-all             # 全部可发布插件 → dist/plugins/*.zip
npm run release-index           # 重建 dist/index.json
npm run verify-source           # 校验整源包（plugin-source/1 标准）

npm run check-registry          # registry 一致性检查
npm run publish:npm             # 发布预演（dry-run，不真发）
npm run publish:execute         # 真正发布到 npm（人工决定时机）
```

新建插件：

```bash
npm run create-plugin -- --name my-plugin
npm run validate-plugin -- extensions/official/my-plugin
```

---

## 目录结构

```
packages/     构建库与基建插件
  ├─ 构建库（不加载进 dsh）
  │    @capyclaw/plugin-kit     插件 SDK：HTTP/MCP、校验、打包（pack/zip）、技能 provider
  │    @capyclaw/suite-kit      suite/domain 清单校验与组合（validate/compose/profile）
  └─ 基建级插件（发布产品）
       service-host / tool-host / asset-service / editor-host / service-broker
       （@capyclaw/*，均在 registry）
       state-service      （shared 源供给方，随 PPT 插件构建内联）
       document-workbench （@capyclaw/ppt-workbench 的运行时依赖）

tools/        插件工具链
  plugin-generator   脚手架（create-plugin）
  plugin-validator   结构与规范校验
  plugin-release     zip / index / 整源包打包与发布闸

extensions/   插件本体（发布产品）
  official/     launchpad、launch-engine、plugin-sync、llm-tempkey、
                port-sidebar、scrapling、ddr0-client
  bridges/      ppt-bridge（workbench + 8 个 skill + suite，由 build:plugin 构建）

scripts/      流水线脚本（校验、构建同步、registry 生成、发布）
docs/         工程文档（guides / reference）
```

---

## 插件长什么样

```js
// lib/index.mjs
export const name = 'my-plugin'
export const inject = ['skills']            // 声明依赖的服务

export function apply(ctx, config) {
  const skills = ctx.skills                 // 读取一次，热路径用局部变量
  ctx.provide('myService')                  // Cordis v4：必须先 provide 再赋值
  ctx.myService = { /* ... */ }

  ctx.on('dispose', () => { /* 清理 */ })
}
```

```yaml
# cordis.patch.yml：把插件行插入 Cordis 配置树
- insert:
    - id: my-plugin
      name: my-plugin
```

---

## 发布

发布对象由 `tools/capyclaw-plugin-release` 的 `discoverPlugins()` 收敛（过得了发布闸的包），
清单与 `capyclaw-registry.json` 一致（由 `npm run gen-registry` 生成，不要手改）。

```bash
npm run publish:npm          # dry-run 预览每个包的发布动作
npm run publish:execute      # 确认无误后执行
```

三个 registry 外的依赖包需单独发布：`@capyclaw/plugin-kit`、
`@capyclaw/document-workbench`、`@capyclaw/skills-service`。详见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

---

## 更多文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 架构与依赖方向
- [docs/PUBLISHING.md](docs/PUBLISHING.md) — 发布流程
- [docs/PLUGIN_DISTRIBUTION.md](docs/PLUGIN_DISTRIBUTION.md) — 插件分发
- [docs/guides/](docs/guides/) — 插件开发指南
- [CONTRIBUTING.md](CONTRIBUTING.md) — 贡献指南
