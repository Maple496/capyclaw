# @capyclaw/plugin-release

DSH 插件发布工具（生产中心侧）。把 `extensions/` 里的插件变成可分发的 zip，
并把一批 zip 组织成一个**源**（`index.json` + `plugins/*.zip`），源可整体打成
单一 zip 传播。

消费方只需要源地址，不需要知道生产中心存在。

## 命令

```bash
node tools/capyclaw-plugin-release/bin/cli.mjs release <插件名|目录>   # 发布单个
node tools/capyclaw-plugin-release/bin/cli.mjs release --all           # 发布全部
node tools/capyclaw-plugin-release/bin/cli.mjs index                   # 重建 index.json
node tools/capyclaw-plugin-release/bin/cli.mjs bundle                  # 源 → 单一 zip
node tools/capyclaw-plugin-release/bin/cli.mjs list                    # 列出源内容
```

选项：`--out <dir>`（默认 `<repo>/dist`）、`--root <dir>`、`--channel <name>`、`--json`。

## 产物

```
dist/index.json                    源索引（消费方唯一入口）
dist/plugins/<name>-<ver>.zip      单插件包（根 = 包根，内置 workspace 依赖）
release/dsh-plugin-source-*.zip    整个源 = 可传播的单一文件
```

## 发布闸

1. 复用 `tools/capyclaw-plugin-validator` 的规范验证；
2. 追加分发必需项：`engines.dsh` 必填、`dsh.bundle.patch` 文件必须存在、
   依赖不许 `link:`/`file:`。

契约细节见仓根 [DELIVERY.md](../../DELIVERY.md)。

## 测试

```bash
node --test tools/capyclaw-plugin-release/test/release.test.mjs
```
