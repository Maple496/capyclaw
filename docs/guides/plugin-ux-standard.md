# DSH 插件体验标准（Plugin UX Standard）

> **本文件不含"接管"这个词，因为它在我们的产品里已经是历史词汇。**
> 显示的界面，必然已经连接。

**版本**: 1.0 · 2026-10-29  
**状态**: 强制标准 — 所有新插件必须遵循，禁止插件各自重复实现

---

## 原则 0：用户永远不需要理解"连接"

插件面板（侧边栏、编辑器、预览窗口）打开即工作。用户看到的永远是一个
**正常工作的界面**，不存在"未连接 / 待命 / 已接管 / 请点重连"这类状态。

> 反例（禁止）：`已接管` ✅ badge、`另一个编辑器窗口接管了这份 deck，本窗口已暂停同步`、
> `编辑器未接管：请确认窗口已打开`、`点击重连` 按钮。

---

## 原则 1：显示即连接（Display Implies Connection）

| 场景 | 行为 |
|------|------|
| 单个面板打开 | 自动成为活动实例，**无任何提示** |
| 多个面板同时打开 | **后打开者自动抢占**（first-claim force），旧面板静默转入待命，不弹提示 |
| 选中的标签页切换回来 | 重新自动抢回，无提示 |
| 心跳中断 | 自动重试 + 自动恢复，无提示 |
| 页面关闭 | 自动释放租约（pagehide/beforeunload），无提示 |

**服务端统一走 `ctx.editorHost`（底层为 `@capyclaw/plugin-kit/editor/lease`）**（旧插件兼容用 `shared/editor-attach.mjs`）：

```js
// 宿主/服务端
import { createEditorLease } from '@capyclaw/plugin-kit/editor/lease'
const lease = createEditorLease()
// POST /claim   → lease.claim(body.id, body.force === true)
// POST /release → lease.release(body.id)
// 工具调用前   → await lease.wait({ openHint: 'http://127.0.0.1:PORT', panelHint: '右侧「PPT」面板' })

// 编辑器页面
import { startAutoAttach } from '@capyclaw/plugin-kit/editor/lease'
startAutoAttach({
  clientId,
  claim: (force) => api('/claim', { method: 'POST', body: JSON.stringify({ id: clientId, force }) }).then(r => !!r.ok),
  release: () => api('/release', { method: 'POST' }),
  onActive: () => { watch(); pump() },
  onStandby: () => {},   // 静默！不要写 UI 提示
})
```

**禁止**：插件自建 claim 循环、自定义"接管"文案、在 UI 上暴露 owner/lease/TTL 概念。

---

## 原则 2：失败的提示必须可操作、且只说"下一步做什么"

如果编辑器确实没开（面板被用户关掉），错误信息应当是下一步动作，而不是内部状态：

> ✅ `PPT 编辑器面板尚未连接（打开 http://127.0.0.1:39311）。页面加载后会自动连接，无需其他操作。`  
> ❌ `编辑器未接管：请确认窗口已打开（或点重连）`

---

## 原则 3：状态仅用于内部仲裁

owner / lease / TTL / active / standby 只存在于代码内部，用于解决多窗口写入竞争。
它们**不是产品概念**，不得出现在 UI 文案、日志面向用户的部分、MCP 工具错误信息中。

---

## 原则 4：纯内部状态不上屏

面板顶栏只显示真正对用户有意义的信息：文件/文档名、页数、导出按钮等。
连接状态最多用一个不打扰的指示点（绿/灰），且**不漂浮到界面中央**；
推荐完全不显示。

---

## 原则 5：复用，不重复

所有需要"面板 ↔ 宿主"长连接的插件（编辑器、预览器、终端等）：

- 服务端一律使用 `ctx.editorHost`；客户端 lease/auto-attach 仍来自 `@capyclaw/plugin-kit/editor/lease`（旧插件兼容 `shared/editor-attach.mjs`）
- 面板 HTML 不得自带"重连"按钮或状态横幅
- 心跳、抢占、释放、重试逻辑集中在共享模块里维护

---

## 检查清单（提交前自查）

- [ ] 打开面板后，界面上没有任何连接状态文字（"已连接/待命/未连接"都不出现）
- [ ] 打开两个面板，后开的那个直接可操作，先开的静默转入后台（无提示）
- [ ] 关闭面板再打开，自动恢复，无需任何点击
- [ ] 工具调用在编辑器未打开时，报错信息只包含"下一步做什么"
- [ ] 所有 claim/心跳/释放代码来自 `ctx.editorHost`（底层 `@capyclaw/plugin-kit/editor/lease`；旧插件兼容 `shared/editor-attach.mjs`），插件内无重复实现

---

**维护**：本标准随共享模块一起演进；修改共享模块即可让所有插件获得同样的行为。
