# dsh-scrapling

Scrapling 网页抓取插件 —— 为 DeepSeek Harness 提供网页数据爬取能力 + **可视化爬虫工作台**。

## 功能特性

### ✅ 已实现（纯 Node，零外部依赖）

- **HTTP 抓取** —— 直连目标网址，跟随重定向，超时可控，错误翻译成人话（含「下一步」提示）
- **CSS 选择器提取** —— 自研容错 HTML 解析器 + 选择器引擎（Scrapy/parsel 语义）
  - `::text` / `::attr(name)` 伪元素
  - 类型/类/ID/属性选择器（`=` `^=` `$=` `*=` `~=` `|=`）
  - 后代 / 子代 `>` / 相邻 `+` 组合器
  - `:first-child` / `:last-child` / `:nth-child(k)`
  - 逗号分组按文档序合并去重（XPath union 语义）
  - 支持中文类名/属性值
- **爬虫工作台**（默认 `http://127.0.0.1:39640/`，端口由 broker 管理）—— 浏览器打开即用：
  - 三步引导：选目标 → 观察流程 → 取数据
  - 爬取流程逐步回放（每步真实耗时：解析 URL → 发请求 → 收响应 → 读内容 → 建文档树 → 提取 → 完成）
  - 选择器试玩（随时改随时提取，不重新请求）
  - 结果表格 / JSON 双视图，复制 JSON、导出 CSV（Excel 可直接打开）/ JSON
  - 最近 20 条历史，点击回看
  - 三个内置离线演示页（名言 / 商品 / 新闻），无需外网即可完整体验
- **服务契约** —— `/healthz`、`/metrics`（Prometheus）、只监听 `127.0.0.1`

### 🔒 未实现（诚实声明，不会伪造结果）

- **浏览器渲染 / 隐身模式 / Cloudflare 绕过 / JS 渲染** —— 依赖外部 Python `scrapling` 运行时，调用返回结构化 `NOT_IMPLEMENTED`，工作台界面上已锁定
- **XPath** —— 同上

## 快速开始

```bash
# 方式一：独立启动工作台（推荐，浏览器打开即用）
cd extensions/official/capyclaw-scrapling
node server/server.mjs            # 默认 http://127.0.0.1:39640/
# 或指定端口
node server/server.mjs --port 39641

# 方式二：作为 DSH 插件加载
# cordis.patch.yml 会加载 service-broker；Scrapling 通过 ctx.serviceBroker
# 投递独立工作台服务，Cordis 进程本身不监听业务端口。

# 单元测试（32 项）
npm test
```

## API

### 服务 API（`ctx.scrapling`）

```javascript
export const inject = ['scrapling']

export async function apply(ctx) {
  // 1. HTTP 抓取
  const page = await ctx.scrapling.fetch('https://quotes.toscrape.com/')
  console.log(page.status, page.html.length)

  // 2. 解析 + 选择器提取（Scrapy 语义）
  const doc = ctx.scrapling.parse(page.html)
  doc.css('.quote .text::text')     // → ['“Quote one.”', '“Quote two.”', …]
  doc.css('a::attr(href)')          // → ['/tag/change/1', …]
  const quotes = doc.css('.quote')  // → 元素包装（.attrib / .text / .css()）

  // 3. 带步骤计时的爬取流水线（工作台数据源）
  const record = await ctx.scrapling.crawler.crawl({
    url: 'https://example.com/',
    selectors: [{ key: '标题', selector: 'h1::text' }],
  })
  console.log(record.steps)   // 每步 { id, label, status, detail, ms }
  console.log(record.extracts) // { 标题: { selector, count, values } }
}
```

**诚实边界：** `fetchWithBrowser()` 与 XPath 抛 `NOT_IMPLEMENTED`。

### HTTP API（工作台服务）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/healthz` | GET | 标准 `{ ok, service, pid, port }` + `{ name, version, contractVersion, crawls, capabilities }` |
| `/metrics` | GET | Prometheus 文本（`scrapling_up` / `scrapling_crawls_total` 等） |
| `/api/crawl` | POST | `{ url, timeoutMs?, userAgent?, selectors?: [{key, selector}] }` → 步骤流水线 + 提取结果 |
| `/api/extract` | POST | `{ crawlId, selectors }` 基于历史记录二次提取（免重新请求） |
| `/api/crawls` | GET | 最近 20 条爬取摘要 |
| `/api/crawls/:id` | GET | 单条记录详情（含 htmlPreview） |
| `/demo/*.html` | GET | 内置离线演示页（quotes / products / news） |

## 配置

`cordis.patch.yml`（优先级：cordis config → 环境变量 → 默认值）：

| 配置 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | `DSH_SCRAPLING_ENABLED` | `true` | 是否注册服务与工作台 |
| `port` | `DSH_SCRAPLING_PORT` | `auto` | 工作台端口（`auto` 由 broker 分配；手动直启默认 39640） |
| `host` | `DSH_SCRAPLING_HOST` | `127.0.0.1` | 监听地址 |
| `timeoutMs` | `DSH_SCRAPLING_TIMEOUT_MS` | `20000` | 默认请求超时 |
| `workbench` | `DSH_SCRAPLING_WORKBENCH` | `true` | 是否拉起工作台界面 |

## 架构

```
capyclaw-scrapling/
├── lib/
│   ├── host.mjs          # Cordis 入口：注册 fetch/parse API + broker 投递工作台 + boot 全局注入
│   ├── index.mjs         # API 导出
│   ├── html-parser.mjs   # 容错 HTML 解析器（单遍、隐式闭合、实体解码）
│   ├── selectors.mjs     # CSS 选择器引擎（parsel 语义）
│   └── crawler.mjs       # 爬取流水线（步骤计时 + 历史记录）
├── server/
│   └── server.mjs        # 工作台 HTTP 服务（独立入口 / 被宿主拉起）
├── ui/
│   ├── index.html        # 工作台界面（无框架无构建）
│   ├── app.js
│   └── style.css
├── demo/                 # 内置离线演示页（爬取目标 + 选择器教学）
├── client/
│   └── client.js         # 浏览器半：把工作台挂进 DSH 右侧边栏（iframe）
├── test/                 # 32 项单测（node --test）
└── cordis.patch.yml      # bundle 配置
```

**与 DSH web 客户端的桥**：宿主半通过 `webserver/index-inject` 注入 `__DSH_SCRAPLING__`（协议与 launchpad / port-sidebar 相同），浏览器半据此把工作台挂成右侧边栏面板。

## 测试与验证

```bash
# 单元测试（52 项：解析器 / 选择器 / API / 宿主装配 / 真实世界边界）
cd extensions/official/capyclaw-scrapling && npm test

# 真实互联网实测（多站点多结构：quotes/books/baidu/gitee/httpbin）
node test/internet-campaign.mjs

# 六层 e2e（scrapling 在 L3 有 7 项专属冒烟：healthz/metrics/页面/离线自爬/二次提取/诚实拒绝/单测）
node scripts/e2e-all.mjs --layer l3

# 插件规范校验
node tools/capyclaw-plugin-validator/bin/cli.mjs extensions/official/capyclaw-scrapling
```

## 故障排除

| 症状 | 处理 |
|---|---|
| 打不开 39640 | `node server/server.mjs` 看启动日志；端口被占时用 `--port` 换一个 |
| 爬取报「无法连接到目标网址」 | 先在浏览器里确认目标网址能打开；内网地址确认服务已启动 |
| 提取 0 条数据 | 展开页面上的「原始 HTML」对照选择器写法；从演示目标开始学 |
| 想要浏览器渲染 / XPath | 当前版本未实现，需要外部 Python scrapling 运行时 |

## 相关链接

- **Scrapling 官方文档**： https://scrapling.readthedocs.io
- **Scrapling GitHub**： https://github.com/D4Vinci/Scrapling
- **DSH 插件开发**： ../../docs/guides/plugin-development.md

## 许可证

MIT License

## 版本历史

### 1.1.0 (2026-11-05)
- 🆕 可视化爬虫工作台（`http://127.0.0.1:39640/`）：流程回放、选择器试玩、JSON/CSV 导出、历史回看、三个内置离线演示页
- 🆕 `parse()` 真实实现：自研容错 HTML 解析器 + CSS 选择器引擎（`::text` / `::attr` / 组合器 / 伪类 / 中文标识符）
- 🆕 爬取流水线 `crawler.crawl()`：步骤计时、结构化错误（含「下一步」提示）、20 条历史
- 🆕 服务契约 `/healthz` + `/metrics`，浏览器半挂 DSH 右侧边栏
- 🔧 E2E 加固（大规模端到端测试发现并修复）：
  - **多编码解码**：响应头 charset → BOM → meta 嗅探三级解码，GBK/GB2312/GB18030/UTF-16 中文老站点不再乱码
  - **深度上限 512**（浏览器同款）：5 万层嵌套不再栈溢出
  - **结构伪类 O(1) 化**：兄弟位置索引缓存，2MB/5 万元素页面提取从 49.5s 降到 0.42s
  - **大结果渲染上限**：表格只画前 500 行，导出仍含全部数据
- ✅ 52 项单测（含 20 项真实世界边界场景）+ e2e L3 七项专属冒烟 + 真实互联网多站点实测
- 诚实边界不变：浏览器渲染 / XPath 未实现并如实标注

### 1.0.2 (2026-11-04)
- 初始版本（仅 HTTP fetch）
