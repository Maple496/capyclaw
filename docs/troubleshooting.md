# 故障排查手册

记录实际踩过的坑与修复方式。新问题排查前先看这里，避免重复调试。

---

## 1. DeepSeek Messages 404（HTTP_404 / transport failed）

**现象**：dsh 对话报 `DeepSeek Messages request failed (404)` 或 `Messages transport failed`。

**根因**：环境变量 `DEEPSEEK_BASE_URL=https://api.deepseek.com` 是 **OpenAI 兼容协议**的根；
dsh 的 DeepSeek 插件走的是 **Anthropic Messages 协议**，解析顺序：

```
config.baseURL > 环境变量 DEEPSEEK_BASE_URL > 默认值 https://api.deepseek.com/anthropic
```

配置缺省时落到环境变量，请求打到 `https://api.deepseek.com/v1/messages` → 404。
（实测：`/anthropic/v1/messages` 返回 200，`/v1/messages` 返回 404。）

**修复**：在 profile 的 `cordis.patch.yml` 显式写死（config 优先级最高，永久压过环境变量）：

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: 'https://api.deepseek.com/anthropic'   # Messages 协议必须带 /anthropic
    reasoningEffort: high
```

改完必须**重启 dsh** 才生效。

**注意**：`DEEPSEEK_BASE_URL` 同时被 flow-engine（OpenAI 兼容，`server/relay.mjs` 拼
`/chat/completions`）消费——**同名变量两套语义**。不要全局改这个环境变量，只靠上面的
config 显式覆盖区分。快速自检：

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST https://api.deepseek.com/anthropic/v1/messages \
  -H "x-api-key: $DEEPSEEK_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"deepseek-chat","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
# 200 = Key 与端点都正常；404 = baseURL 少了 /anthropic
```

## 2. dshd start 报「进程创建失败: node.exe」→「启动意图尚未解决」

**现象**：broker 拉起成功，dsh（auth-proxy）拉起报进程创建失败；此后每次 start 都报
「启动意图尚未解决；请先 stop 并检查」，陷入死循环。

**根因链**（两层）：

1. stack 里 `workspace ""`（留空）被 dsh-stack-kit 解析成 **stackDir 下的 workspace**
   （如 `launchpads/workspace`，不存在）。spawn 的 `cwd` 不存在 → Windows 上 spawn 只发
   异步 error 事件 → `child.pid` 为空。
2. 旧版 `spawnDetached` 用空 handler 吞掉了真实错误（`child.on('error', () => {})`），
   上层只见「进程创建失败」，无从排查；state.json 留下 `dshStartupPending`。

**修复**（已完成于代码）：

- `dsh-stack-kit/src/index.mjs`：空 workspace 返回 `''`，交给 launcher 的
  `|| harnessDir/workspace` 回退；
- `dsh-launcher/lib/launcher.mjs`：spawn 前预检 cwd 并 `mkdirSync(workspace, recursive)`；
  spawn error 事件的真实原因写入日志（查 `dev-state/logs/dsh.log` 末尾 `spawn error` 行）。

**手动恢复**（若再遇到 pending 卡死）：

```bash
node tools/dsh-launcher/bin/dshd.mjs stop --stack launchpads/dev.dsh-stack.json
rm -f tools/dsh-launcher/.dshd/dev-state/state.json
rm -rf tools/dsh-launcher/.dshd/dev-state/services.json.ownership/
node tools/dsh-launcher/bin/dshd.mjs start --stack launchpads/dev.dsh-stack.json
```

## 3. dshd start 报「SyntaxError: Unexpected token '#' ... is not valid JSON」

**根因**：`launchpads/*.stack` 是 DSL（作者视图），**dshd 只认编译后的 dsh-stack.json**。
直接 `--stack xx.stack` 会按 JSON 解析失败。

**修复**：先编译再启动（launchpad 网页端启动会自动编译）：

```bash
node scripts/compile-stack.mjs launchpads/dev.stack
npm run dshd -- start --stack launchpads/dev.dsh-stack.json
```

## 4. 端口被占用（brokerPort=13593 已被占用）

dsh 固定端口不自动换。手动清理：

```bash
netstat -ano | grep -E "13593|13594|13595|13596"   # 找 LISTENING 的 PID
taskkill //F //PID <pid>                            # Git Bash 下双斜杠
# TIME_WAIT 状态等待 30-60s 自动释放，无需处理
```

## 5. auth-proxy 报「另一个实例正在运行」

残留实例锁。确认无运行实例后删锁：

```bash
rm -f ../dsh-runtime/apps/harness/deepseek-harness/.dsh-instance.lock
```

## 6. 手动启动的 dsh 不受 dshd 管理

手动 `node auth-proxy.mjs` 起的 dsh 不写 dshd 的 state.json，后续 `dshd start/stop`
会与它冲突（端口/锁）。**尽量统一用 `dshd start`**；手动起的进程要自己
`netstat` 找 PID 杀掉后再走 dshd。

## 7. launchpad 启动体检报错（stack-plugin-missing / broker-missing-cmd / works-source-missing）

多为**清单引用陈旧**。已修复的几类：

- `tools/dsh-launcher/dev-stack.json` 引用过 `dsh-llm-tempkey`（目录不存在）与
  `dsh-ddr0-client`（空目录）→ 已改为 `@capyclaw/llm-tempkey` / `@capyclaw/ddr0-client`
  的真实路径。**插件改名后在 extensions/ 留旧空目录是坑**，删插件要删干净。
- `packages/dsh-suite-kit/examples/deployment-ppt-dev.works` 的
  `source: "./bridges/..."` 相对路径错 → 已改为 `../../../extensions/...`。
- `packages/dsh-suite-kit/examples/multi-service-manifest.json` 缺失 → 已补 fixture。
- `config/manifests/services.*.json` 是 dsh-plugin-manifest 的登记型示例（无 cmd 启动
  语义），被启动体检误判 → 已改名 `*.example.json`（体检按后缀跳过示例）。

排查命令：`npm run dshd -- stack plan --stack <file>` 看清单校验；launchpad 网页端
「启动清单体检」看全仓扫描。
