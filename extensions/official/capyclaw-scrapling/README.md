# dsh-scrapling

Scrapling 网页抓取插件 - 为 DeepSeek Harness 提供强大的网页抓取能力

## 功能特性

### 🚀 核心功能
- **快速 HTTP 请求** - 高性能的静态页面抓取
- **隐身浏览器** - 真实浏览器渲染，绕过反爬虫检测
- **Cloudflare 绕过** - 自动处理 Cloudflare Turnstile/Interstitial
- **JavaScript 渲染** - 完整的 JS 页面支持
- **CSS/XPath 选择器** - 强大的元素选择和提取
- **并发爬虫** - 高效的多线程爬取
- **代理轮换** - 自动代理管理和轮换
- **自适应解析** - 智能元素追踪，适应页面变化
- **多格式导出** - JSON、CSV、XML 等格式

## 安装

### 前提条件

需要安装 Python 和 Scrapling 包：

```bash
# 安装 Scrapling 及所有依赖
pip install "scrapling[all]>=0.5"

# 安装浏览器引擎（用于 JavaScript 渲染）
scrapling install --force
```

### 插件安装

本插件已集成在 DeepSeek Harness 的官方扩展中，通过 DSH 的插件系统自动加载。

## 使用方法

### API 调用

插件通过 Cordis 依赖注入系统提供 `scrapling` 服务：

```javascript
// 在其他插件中使用
export const inject = ['scrapling']

export async function apply(ctx) {
  // HTTP 抓取
  const result = await ctx.scrapling.fetch('https://example.com')
  console.log(result.html)
  
  // 浏览器模式抓取
  const browserResult = await ctx.scrapling.fetchWithBrowser('https://example.com', {
    waitFor: '.content',
    timeout: 10000
  })
  
  // 解析 HTML
  const doc = ctx.scrapling.parse(result.html)
  const titles = doc.css('h1::text')
}
```

### Python 集成

插件内部通过以下方式调用 Scrapling：

#### 基础抓取
```python
from scrapling.fetchers import Fetcher

page = Fetcher.get('https://quotes.toscrape.com/')
quotes = page.css('.quote .text::text').getall()
```

#### 浏览器模式
```python
from scrapling.fetchers import StealthyFetcher

page = StealthyFetcher.get('https://example.com', 
                          wait_selector='.content',
                          wait_timeout=10)
title = page.css('h1::text').get()
```

#### Spider 爬虫
```python
from scrapling.spiders import Spider, Response

class QuotesSpider(Spider):
    name = "quotes"
    start_urls = ["https://quotes.toscrape.com/"]
    
    async def parse(self, response: Response):
        for quote in response.css('.quote'):
            yield {
                "text": quote.css('.text::text').get(),
                "author": quote.css('.author::text').get(),
            }
```

## 配置选项

在 `cordis.patch.yml` 中可以配置：

```yaml
- insert:
    - id: scrapling-host
      name: dsh-scrapling
      config:
        enabled: true
        defaultTimeout: 30000
        maxConcurrentRequests: 10
```

## 架构设计

### 宿主半（lib/host.mjs）
- 通过 Cordis 插件系统注册服务
- 提供 Scrapling API 的 JavaScript 封装
- 管理 Python 进程或 HTTP API 调用

### 浏览器半（client/client.js）
- 提供前端 UI 集成
- 注册命令和快捷键
- 显示抓取状态和结果

## API 参考

### ctx.scrapling.fetch(url, options)

使用 HTTP 模式抓取页面。

**参数:**
- `url` (string) - 目标 URL
- `options` (object) - 可选配置
  - `headers` - 自定义请求头
  - `proxy` - 代理地址
  - `timeout` - 超时时间（毫秒）

**返回:** Promise<{ url, html, status }>

### ctx.scrapling.fetchWithBrowser(url, options)

使用浏览器模式抓取页面。

**参数:**
- `url` (string) - 目标 URL
- `options` (object) - 可选配置
  - `waitFor` - 等待的选择器
  - `timeout` - 超时时间（毫秒）
  - `screenshot` - 是否截图

**返回:** Promise<{ url, html, screenshot? }>

### ctx.scrapling.parse(html)

解析 HTML 内容。

**参数:**
- `html` (string) - HTML 字符串

**返回:** ParsedDocument - 包含 css() 和 xpath() 方法的文档对象

## 开发

### 目录结构

```
dsh-scrapling/
├── lib/
│   ├── host.mjs           # Cordis 插件入口
│   └── index.mjs          # API 导出
├── client/
│   └── client.js          # 浏览器端代码
├── test/
│   └── plugin.test.mjs    # 测试文件
├── cordis.patch.yml       # Bundle 配置
├── package.json           # 包定义
└── README.md             # 本文件
```

### 运行测试

```bash
npm test
```

## 示例

### 示例 1: 抓取引言网站

```javascript
const quotes = await ctx.scrapling.fetch('https://quotes.toscrape.com/')
const doc = ctx.scrapling.parse(quotes.html)
const allQuotes = doc.css('.quote .text::text')
console.log('找到', allQuotes.length, '条引言')
```

### 示例 2: 处理动态页面

```javascript
const page = await ctx.scrapling.fetchWithBrowser('https://example.com', {
  waitFor: '.dynamic-content',
  timeout: 10000
})
const doc = ctx.scrapling.parse(page.html)
const content = doc.css('.dynamic-content::text')
```

### 示例 3: 使用代理

```javascript
const result = await ctx.scrapling.fetch('https://example.com', {
  proxy: 'http://proxy.example.com:8080'
})
```

## 故障排除

### Scrapling 未安装

**错误**: `ModuleNotFoundError: No module named 'scrapling'`

**解决方案**:
```bash
pip install "scrapling[all]>=0.5"
```

### 浏览器未安装

**错误**: Browser 相关错误

**解决方案**:
```bash
scrapling install --force
```

### 权限问题

确保 DSH 进程有权限执行 Python 和访问网络。

## 相关链接

- **Scrapling 官方文档**: https://scrapling.readthedocs.io
- **Scrapling GitHub**: https://github.com/D4Vinci/Scrapling
- **MCP Server 文档**: https://scrapling.readthedocs.io/en/latest/ai/mcp-server.html
- **DSH 插件开发**: ../../docs/guides/plugin-development.md

## 许可证

MIT License

## 作者

- **Scrapling**: D4Vinci
- **DSH 集成**: DeepSeek Harness Team

## 版本历史

### 1.0.0 (2026-11-04)
- 初始版本
- 基础 HTTP 抓取功能
- 浏览器模式支持
- HTML 解析功能
