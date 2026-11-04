# 第三方组件说明（THIRD PARTY NOTICES）

## PPTist

- 来源：https://github.com/pipipi-pikachu/PPTist
- 许可：GNU Affero General Public License v3.0（AGPL-3.0-or-later）
- 本包 `editor/ppt-full-app.js` 是 PPTist 的编译产物，未做源码修改。
- 依 AGPL-3.0 第 13 条，本包整体按 AGPL-3.0-or-later 分发；如获得本包的
  交互副本，你可依该许可证获取上述 PPTist 对应源代码。

## 其余代码

`lib/`、`server/`、`editor/index.html`、`editor/app.js` 为本工程自研
（构建产物 `editor/app.js` 源码见上游 `ppt-bridge/src/editor/` 与
`ppt-bridge/src/core/`），同样按 AGPL-3.0-or-later 分发。

## hfmath

- 公式渲染引擎（src/core/hfmath/）：fork 自 https://github.com/LingDong-/hfmath （MIT），
  采用 PPTist 项目 https://github.com/pipipi-pikachu/PPTist （AGPL-3.0）的扩展版并转译为 JavaScript。
- Hershey 单线字体数据（src/core/hfmath/hershey.js）来自 hfmath。
