/**
 * 真实互联网实测脚本（不进入自动化 e2e——外网依赖会造成不稳定，
 * 作为人工验收战役运行：node test/internet-campaign.mjs）
 */
const BASE = 'http://127.0.0.1:39640'

const CAMPAIGN = [
  {
    name: 'quotes.toscrape.com（名言站：经典结构）',
    url: 'https://quotes.toscrape.com/',
    selectors: [
      { key: '名言', selector: '.quote .text::text' },
      { key: '作者', selector: '.quote small.author::text' },
      { key: '标签', selector: 'a.tag::text' },
      { key: '下一页', selector: 'li.next a::attr(href)' },
    ],
    expect: (rec) => rec.extracts['名言'].count === 10 && rec.extracts['作者'].values[0] === 'Albert Einstein',
  },
  {
    name: 'books.toscrape.com（书店：商品/价格/评分）',
    url: 'https://books.toscrape.com/',
    selectors: [
      { key: '书名', selector: 'article.product_pod h3 a::attr(title)' },
      { key: '价格', selector: 'article.product_pod .price_color::text' },
      { key: '评分', selector: 'article.product_pod p.star-rating::attr(class)' },
      { key: '有无库存', selector: 'article.product_pod .availability::text' },
    ],
    expect: (rec) => rec.extracts['书名'].count === 20 && /^£/.test(rec.extracts['价格'].values[0] || ''),
  },
  {
    name: 'www.baidu.com（真实中文大站：UA 定制 + 大页面）',
    url: 'https://www.baidu.com/',
    /* baidu 按 UA 门控：默认 UA 只给 0.2KB 防爬页，浏览器 UA 给完整页面——
       这个用例顺带端到端验证 API 的 userAgent 参数 */
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    selectors: [
      { key: '页面标题', selector: 'title::text' },
      { key: '链接文字', selector: '#s-top-left a::text' },
    ],
    expect: (rec) => rec.status === 200 && rec.bytes > 100000
      && rec.extracts['页面标题'].values[0] === '百度一下，你就知道',
  },
  {
    name: 'gitee.com/explore（真实中文站点：反爬 405 时的诚实呈现）',
    url: 'https://gitee.com/explore',
    selectors: [
      { key: '页面标题', selector: 'title::text' },
      { key: '导航', selector: 'a::attr(href)' },
    ],
    /* gitee 对非浏览器 UA 常回 405/防爬页；产品要求：状态如实呈现即可 */
    expect: (rec) => (rec.status === 200 && rec.extracts['导航'].count > 10) || (rec.status === 405 || rec.status === 403),
  },
  {
    name: 'httpbin.org/redirect/2（真实重定向链 → /get）',
    url: 'https://httpbin.org/redirect/2',
    selectors: [{ key: '主机', selector: 'body::text' }],
    expect: (rec) => rec.status === 200 && /\/get$/.test(rec.finalUrl || rec.url),
  },
  {
    name: 'httpbin.org/status/404（真实 404）',
    url: 'https://httpbin.org/status/404',
    selectors: [],
    expect: (rec) => rec.status === 404 && rec.ok === false && !rec.error,
  },
  /* 环境受限参考（本网络不可达时应产出友好错误而非崩溃） */
  {
    name: 'example.com（本网络不可达时的错误形态参考）',
    url: 'https://example.com/',
    selectors: [{ key: '标题', selector: 'h1::text' }],
    optional: true,
    expect: (rec) => rec.error.code === 'NETWORK' || rec.extracts['标题'].values[0] === 'Example Domain',
  },
]

let passed = 0
let failed = 0
const t0 = Date.now()
for (const caseItem of CAMPAIGN) {
  const started = Date.now()
  try {
    const res = await fetch(`${BASE}/api/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: caseItem.url, selectors: caseItem.selectors, timeoutMs: 25000, userAgent: caseItem.userAgent }),
      signal: AbortSignal.timeout(30000),
    })
    const json = await res.json()
    const rec = json.crawl || {}
    const ok = res.status === 200 && json.ok !== false && caseItem.expect(rec)
    const counted = ok || (caseItem.optional && !ok)
    if (counted) passed++
    else failed++
    const mark = ok ? '✓' : counted ? '◐（环境受限，按预期处理）' : '✗'
    const counts = rec.extracts
      ? ' · ' + Object.entries(rec.extracts).map(([k, v]) => `${k}=${v.count}`).join(' ')
      : ''
    console.log(`${mark} ${caseItem.name}`)
    console.log(`    HTTP ${rec.status} · ${(rec.bytes / 1024).toFixed(1)}KB · ${rec.totalMs}ms · 标题「${(rec.title || '').slice(0, 30)}」${counts}`)
    if (!ok) console.log('    失败详情:', JSON.stringify({ http: res.status, error: rec.error, firstExtracts: Object.fromEntries(Object.entries(rec.extracts || {}).map(([k, v]) => [k, v.values ? v.values.slice(0, 2) : v])) }).slice(0, 400))
  } catch (error) {
    failed++
    console.log(`✗ ${caseItem.name}`)
    console.log(`    请求异常: ${error.message}`)
  }
}
console.log(`\n合计: ${passed} 通过 / ${failed} 失败（总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`)
process.exit(failed ? 1 : 0)
