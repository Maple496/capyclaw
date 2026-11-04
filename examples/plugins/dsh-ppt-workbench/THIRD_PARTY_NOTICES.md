# 第三方组件说明（THIRD PARTY NOTICES）

## PPTist

- 来源：https://github.com/pipipi-pikachu/PPTist
- 许可：GNU Affero General Public License v3.0（AGPL-3.0-or-later）
- 本包 `editor/ppt-full-app.js` 是 PPTist 的编译产物，**有修改**：
  在 IIFE 结尾注入 `window.__pptTemplates` / `window.__pptTemplateIds`，
  将内嵌的 8 套官方模板数据（slides + theme）暴露为模板接口的唯一数据源
  （补丁见上游工程 `ppt-bridge/scripts/patch-asset.mjs`，幂等、约 +68 字节）。
- 依 AGPL-3.0 第 13 条，本包整体按 AGPL-3.0-or-later 分发；如获得本包的
  交互副本，你可依该许可证获取上述 PPTist 及修改对应的源代码（上游工程
  内含补丁脚本与锚点说明）。

## 其余代码

`lib/`、`server/`、`editor/index.html`、`editor/app.js` 为本工程自研
（构建产物 `editor/app.js` 源码见上游 `ppt-bridge/src/editor/` 与
`ppt-bridge/src/core/`），同样按 AGPL-3.0-or-later 分发。
