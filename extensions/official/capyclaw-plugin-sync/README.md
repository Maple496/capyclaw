# @capyclaw/plugin-sync

把**运行中的 dsh 插件集合**与一份**外部清单**对齐：报告差异、按清单启用/停用插件。

开关能力**全部复用 dsh 原生** `pluginManager`，不重复实现：

| 层级 | dsh 原生调用 | 语义 |
|---|---|---|
| bundle | `setBundleEnabled(name, enabled)` | 整个包是否参与组合；**保留 dependencies** |
| entry | `setPluginEnabled(entryId, enabled)` | 只关某一行（profile patch 写 `disabled: true`） |

两者都走 `dsh-hmr` 热重组，返回 `applied` / `restart-required` / `overridden` / `failed` —— 本插件原样透传，不把 `overridden` 当成功。

## 清单格式

```json
{
  "version": 1,
  "plugins": [
    { "name": "@capyclaw/launchpad", "version": "1.1.0", "enabled": true }
  ],
  "entries": [
    { "entryId": "include:launchpad-host", "enabled": false }
  ]
}
```

- `plugins[].name`：bundle 包名（对应 profile 的 `dsh.profile.bundles`）
- `plugins[].enabled`：缺省 `true`；`false` = 从组合里移除（依赖保留）
- `plugins[].version`：期望版本，**只用于报告差异**，本轮不触发安装
- `entries[].entryId`：行级开关，用 inventory 里的 entryId（通常是 `include:<rowId>`）

## 清单源

```js
// lib/sources/index.mjs
{ id, describe(): Promise<Manifest> }
```

| 源 | 状态 | 配置 |
|---|---|---|
| `local` | ✅ 已实现 | `sourceKind: local, sourcePath: <json>` 或 `DSH_SYNC_PATH` |
| `http` | ⏳ 预留（调用即报 NOT_IMPLEMENTED） | `sourceUrl` 或 `DSH_SYNC_URL` |

HTTP 源契约（实现时对接）：`GET <url>` 返回 manifest JSON；鉴权用 `Authorization: Bearer ${DSH_SYNC_TOKEN}`；解析后必须过 `normalizeManifest`。

## HTTP 面

挂在 dsh 自己的 webServer 上（不需要另开端口；auth-proxy 会处理 cookie）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/__plugin_sync__/report` | 只读报告：desired / actual / diff / versions |
| POST | `/__plugin_sync__/apply` | body `{ changes: [{op,name|entryId,enabled}] }` |

两者都只允许**回环**访问；设了 `DSH_SYNC_TOKEN` 时还要求 `x-sync-token`。

## ctx 服务

```js
export const inject = ['pluginSync']
const report = await ctx.pluginSync.report()
const result = await ctx.pluginSync.apply({ changes: [{ op: 'bundle', name: '@capyclaw/launchpad', enabled: false }] })
```

## 重要行为（实测 dsh 0.2.0-rc.2）

- **entry 被禁用时插件不会收到 `dispose`**：不要依赖清理逻辑，`apply` 要能重复执行。
- `setPluginEnabled` 用 **entryId**（`include:<rowId>`），不是 patchId。
- 受保护的 dsh 核心行会返回 `readOnlyReason`，本插件把它们单独列在 `diff.readonly`，不静默跳过。

## 本轮范围

- ✅ 报告（清单 vs 实际，本地版本差异）
- ✅ 按清单执行两级开关
- ⏳ 自动安装/升级（`pluginManager/installBundle` 的调用点已留，未接）
- ⏳ HTTP 清单源实现
