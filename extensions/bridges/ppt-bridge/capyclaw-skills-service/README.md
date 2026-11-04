# capyclaw-skills-service

DSH 独立技能服务（服务解耦标准形态）。把原「`ctx.skills` 进程内注册表」的
技能内容（SKILL.md）搬出 dsh 进程，作为独立端口服务：

```
GET /healthz        { ok, service:"dsh-skills", pid, port, providers, skills }
GET /skills         全量技能清单（聚合各 provider）
GET /skills/:name   单技能正文（原 provider.get 形状）
```

## 技能数据源

自动扫描两类布局（都找 `capyclaw-ppt-skill-*` 目录里的 `lib/index.mjs`）：

- dev 树：`../plugin/capyclaw-ppt-skill-*`
- 套件安装态：本目录同级（`node_modules/capyclaw-ppt-skill-*`）

可用 `--providers <dir>[[;|,]dir…]` 显式指定。

## 由谁拉起

`dsh-service-broker` 按清单以独立进程拉起（套件捆绑布局的清单见
@capyclaw/ppt-suite 包根 `services.json`，端口 39321）。dsh 侧经 broker 的
skills 瘦客户端（`ctx.skills` 兼容形状）访问本服务。

## 独立运行

```bash
node server.mjs [--port 39321] [--providers dir1,dir2]
```
