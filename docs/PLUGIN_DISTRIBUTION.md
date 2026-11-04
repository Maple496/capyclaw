# 插件分发机制

本仓库产出的分发物有三种：**npm 包**（主渠道）、**zip 产物**（`dist/plugins/`）、
**registry 清单**（`capyclaw-registry.json`）。安装发生在用户的 dsh 环境
（`~/.dsh/profiles/<name>/package.json`），本仓库不负责安装动作本身。

> 历史上的 `tools/install-plugins.mjs`（本地 link/批量安装）与 `dshd` 启动器
> 已随运行编排代码移出仓库（见 `../dsh-archive/`）。

## 分发物

| 产物 | 生成命令 | 用途 |
|---|---|---|
| npm 包 | `npm run publish:execute`（见 [PUBLISHING.md](PUBLISHING.md)） | 用户 `dsh plugin add @capyclaw/xxx` 安装 |
| zip 产物 | `npm run release-all` → `dist/plugins/<name>-<version>.zip` | 离线分发 / 私有镜像 |
| 索引 | `npm run release-index` → `dist/index.json` | zip 目录索引（schema 1） |
| 整源包 | `npm run release-source` → `release/dsh-plugin-source-*.zip` | 按 plugin-source/1 标准的整源交付 |

## Registry（capyclaw-registry.json）

- 由 `npm run gen-registry` 从实际可发布集合生成（数据源是 plugin-release 的
  `discoverPlugins()`，即过得了发布闸的包），**不要手改**。
- `npm run check-registry` 校验 registry 与当前仓库状态一致。
- 字段：`name` / `version` / `path`（仓内相对路径）/ `tarball`（npm 下载地址）/
  `category` / `platform` / `dsh` 引擎范围。

```json
{
  "version": 1,
  "plugins": [
    {
      "name": "@capyclaw/launchpad",
      "version": "1.1.0",
      "path": "./extensions/official/capyclaw-launchpad",
      "tarball": "https://registry.npmjs.org/@capyclaw/launchpad/-/launchpad-1.1.0.tgz",
      "category": "tool",
      "platform": "both"
    }
  ]
}
```

## 用户侧安装（dsh 原生方式）

```bash
# 安装单个插件到 profile
dsh plugin --profile web add @capyclaw/launchpad

# 或直接编辑 ~/.dsh/profiles/web/package.json 的 dependencies，
# 然后在 profile 目录执行包管理器安装
```

suite 组合包（如 `@capyclaw/ppt-suite`）会把成员插件一起声明进依赖，
安装 suite 即安装全套。
