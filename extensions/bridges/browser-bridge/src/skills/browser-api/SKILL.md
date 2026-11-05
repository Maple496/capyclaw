---
name: browser-api
description: 浏览器工具手册：browser_* 工具契约、ref 快照语义、登录态持久化、安全边界与报错处理。
whenToUse: 需要确认 browser_* 工具参数、理解 ref/STALE_SNAPSHOT 语义、处理引擎报错或配置（headless/evaluate）问题时。
---

# browser_* 工具手册

工具契约、inputSchema 与能力归属见 `references/tool-contract.md`（构建期生成，随包分发）。

## 固定流程

1. browser_capabilities：确认 contractVersion 与工具面；major 不一致停止并提示用户安装/升级浏览器套件。
2. 观察页面：browser_navigate 返回首屏快照；browser_snapshot 随时重看。快照含可交互元素（链接/按钮/输入框/下拉）与结构节点（标题/图片），每个带 ref=eN。
3. 动作只用 ref：browser_click / browser_fill / browser_select / browser_press；动作成功自动返回新快照。

## ref 语义

- ref 只在「当前标签页最近一次快照」内有效；页面变化后旧 ref 报 STALE_SNAPSHOT（错误信息自带提示）——重新 browser_snapshot 用新 ref，不要盲目重试。
- browser_tabs 管理 T1/T2… 稳定标签页 id；动作默认作用于活动标签页，也可用 tab 参数显式指定。

## 登录态与持久化

- 引擎使用持久化 profile：登录、cookie、localStorage 跨任务保留；browser_close 只关浏览器不丢登录。
- 登录流程：导航到登录页 → 快照 → browser_fill 账号/密码（密码框在快照里掩码显示，填写不受影响）→ 提交 → browser_snapshot 确认结果。

## 安全边界（如实，不伪造）

- 仅 http/https；URL 内嵌用户名/密码会被拒绝（URL_CREDENTIALS_DENIED）。
- browser_evaluate 默认关闭，调用返回 NOT_IMPLEMENTED 与开启方法；快照+ref 已覆盖绝大多数任务。
- 快照只覆盖主框架（iframe/shadow DOM 不入快照）；需要时用 browser_press Tab 或页面自身导航。
- 不做反爬/风控绕过；站点拦截时如实报告并停止。

## 常见报错

| 错误 | 含义 | 下一步 |
|---|---|---|
| STALE_SNAPSHOT | ref 过期/定位歧义 | 重新 browser_snapshot |
| ENGINE_LAUNCH_FAILED | 本机没有可用浏览器 | npx playwright install chromium 或装 Chrome/Edge |
| TAB_UNKNOWN | 标签页 id 不存在 | browser_tabs(action=list) |
| URL_SCHEME_DENIED | 非 http/https | 换网页地址 |
