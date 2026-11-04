# Domains（领域包）

`domains/<name>/dsh-domain.json` 是**启动单位**，不是插件包。

```json
{
  "name": "ppt",
  "components": ["../../plugin/capyclaw-ppt-suite"],
  "baseBundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
  "profile": { "name": "domain-ppt", "port": 3080 }
}
```

- `components`：只选该领域需要的 suite（suite 内部可以包含 plugin / skills / MCP）。
- 启动时生成独立 profile：`base + web-app + 选中 suite`；
- 未选中的插件、skill、MCP 不会进入该 profile；
- `rowOverrides` 可以换端口、换 MCP URL，支持和别的领域同时运行；
- `dsh-domain stage` 只复制选中组件，形成可带走的领域包。

## 当前领域

| domain | profile | 组件 |
|---|---|---|
| `ppt` | `domain-ppt` | `capyclaw-ppt-suite`（workbench + skills） |

## 常用命令

```bash
# 在 bridges/ppt-bridge 下
npm run domain:validate
npm run domain:install
npm run domain:stage

# 或直接启动（本地推荐 auth-proxy，浏览器零登录）
node ../../packages/dsh-suite-kit/bin/dsh-domain.mjs launch domains/ppt \
  --auth-proxy ../../core-harness/deepseek-harness/auth-proxy.mjs \
  --port 3090 --proxy-port 3091
```
