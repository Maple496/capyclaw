# @capyclaw/browser-suite

浏览器操控工作台套件 —— 一键安装 Browser 运行时 + 3 个独立 skill 包 + 公共基建插件。

## 组成

- `@capyclaw/browser-workbench` —— 运行时：15 个 `browser_*` MCP 工具 + Playwright 引擎（有头可见、登录态持久化）+ 可视化工作台（http://127.0.0.1:39315/）
- `@capyclaw/browser-skill-browser` —— 路由技能（总入口）
- `@capyclaw/browser-skill-api` —— 工具手册技能（含生成的 tool-contract.md）
- `@capyclaw/browser-skill-ops` —— 网活实操技能（观察→定位→动作→验证工作流）
- 公共基建：service-host / tool-host / asset-service / service-broker

## 安装

```bash
dsh plugin --profile web add @capyclaw/browser-suite
```

安装后：broker 按本包 `services.json` 以独立进程拉起 relay（固定端口 39315），
dsh 侧经官方 mcp-client 连 `http://127.0.0.1:39315/mcp`，工具名 `mcp__browser__browser_*`。

## 许可证

MIT License
