# dsh-llm-tempkey

把 **ddr0 平台的千帆临时 LLM Key** 接进 dsh：登录态校验 → 运行时签发 → 到期前自动轮换 → 通过凭据缝注入 `dsh-llm-pi-ai` 路由。**模型可用性与 Key 全部来自外部请求，配置里不写死任何 Key。**

## 计费链路（服务端已有，本插件是对接端）

```
dsh 插件 ──1. GET /api/me──▶ ddr0 (port-8217)      登录态校验 + 余额
        ──2. POST /api/keys/issue──▶ 同上            签发临时 Key
              └─ 服务端: billing.authorize（按 TTL×500 micro-USD/s 预扣积分）
                        → llk.issue（百度 IAM → 千帆临时 Bearer）
                        → 到期 8214 结算，按真实用量多退少补
        ──2.5 GET /api/llm/config──▶ 同上            下发上游 url + models（P3 契约）
        ──3. 用户对话──▶ {base_url}/chat/completions (Bearer 临时Key)
        ──4. 流水──▶ point_ledger: llm_hold / llm_settle / llm_refund
```

- 明文 Key **只返回一次**；插件在到期前 `refreshMarginSeconds` 自动换新。
- TTL 范围 300–3600 秒（服务端限制），默认 300。

## LLM 配置来源（目标：apikey/url/model 全部来自平台）

| 项 | 来源 | 回退 |
|---|---|---|
| apikey | `POST /api/keys/issue`（已上线契约） | 无（签发失败即拒绝服务） |
| 上游 url | `GET /api/llm/config` → `{base_url, models[], ttl_seconds?}` | 静态 `upstreamBase`（千帆） |
| models | 同上 `models[]` | cordis 静态声明 |

- 平台返回配置时中转上游**动态切换**；`/__status`（及 `ctx.llmTempkey.status()`）以
  `upstreamSource: platform | config` 如实标注来源，`platformModels` 透传平台下发列表。
- 平台 404（未上线）→ 安静回退静态；其他 HTTP 错误 → 告警一次后沿用静态。
- 静态声明的模型（`config.models`）不在平台下发列表时打警告（路由侧声明仍归 cordis）。

## 安装

```bash
# web profile（或任意 profile）
# 1) node_modules 链接（junction/symlink 均可）
# 2) profile package.json:
#    "dependencies": { "dsh-llm-tempkey": "link:<本目录绝对路径>" }
#    "dsh": { "profile": { "bundles": [ ..., "dsh-llm-tempkey" ] } }
# 3) pnpm install / dsh plugin install
```

## 配置（cordis.patch.yml 由本插件 bundle patch 自动生效）

本插件 bundle patch 做两件事：
1. 挂载 `@deepseek-ai/dsh-llm-pi-ai`，声明路由 `ddr0-tempkey`：
   `api: openai-completions`、`baseURL: https://qianfan.baidubce.com/v2`、
   `apiKeyEnv: DSH_TEMPKEY_LLM_KEY`、`models: [ernie-4.5-turbo-128k]`（改模型编辑本插件 cordis.patch.yml）。
2. 挂载宿主行 `llm-tempkey-host`，默认配置：

| 键 | 默认 | 说明 |
|---|---|---|
| `serverBase` | `https://ddr0.com/apps/port/8217` | 临时 Key 服务公网入口 |
| `tokenEnv` | `DDR0_SESSION_TOKEN` | 主站会话 token 的环境变量名 |
| `sessionToken` | （空） | 直接写死 token（优先级高于 tokenEnv；不建议提交） |
| `tokenUrl` | `http://127.0.0.1:3310/api/desktop/account/session-token` | 会话快照端点（**端口口径**：开发态网关 3310；8850 为前端由 vite 托管的部署态口径，按实际部署改） |
| `ttlSeconds` | 300 | 签发 TTL（300–3600） |
| `refreshMarginSeconds` | 60 | 到期前多少秒开始轮换 |
| `apiKeyEnvRef` | `DSH_TEMPKEY_LLM_KEY` | 与 pi-ai 路由 apiKeyEnv 保持一致 |
| `upstreamBase` | `https://qianfan.baidubce.com/v2` | 回退上游；平台 `/api/llm/config` 下发成功后自动覆盖 |
| `models` | （空） | 静态声明的模型 id 数组，与平台下发做对账告警 |

## 登录态（三级解析，解耦标准）

优先级从高到低：

1. `config.sessionToken` —— 字面量（调试用，不建议提交）；
2. **`config.tokenUrl`（推荐，解耦标准）** —— 本机网关的会话快照端点：
   `GET {tokenUrl}` → `{logged_in, token, token_name, username, url}`。
   网关登录后 token 自动流入 dsh，插件不知道登录怎么做的，网关不知道 dsh 存在——
   双方只守这一个端点契约。网关侧实现见 桌前面前端 `routes/account.py`
   （`/api/desktop/account/session-token`，仅回环 127.0.0.1 可调）。
3. `tokenEnv`（`DDR0_SESSION_TOKEN`）—— 启动注入（向后兼容）。

插件启动与每 30s 周期校验登录态；**403/会话失效立即停发并丢弃本地 Key 引用**，
token 恢复后自动续上。

## 状态查询

插件提供 `ctx.llmTempkey.status()`（登录态/余额/到期时间/最后错误）。日志关键字 `[dsh-llm-tempkey]`。

## 验证

```bash
npm test   # 12 条：契约/鉴权头/幂等键/403 停发/签发注入/token 缺省/发现模式/平台下发切换/404 回退
```
