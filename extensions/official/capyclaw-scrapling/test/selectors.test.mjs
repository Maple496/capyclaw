/**
 * selectors 单测：Scrapy 语义（::text / ::attr）+ 组合器 + 伪类 + 容错。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSelectorDocument, extract, SelectorError } from '../lib/selectors.mjs'

const QUOTES_HTML = `<html>
<head><title>Quotes to Scrape</title></head>
<body>
<div class="container">
  <div class="quote" itemscope>
    <span class="text">“Quote one.”</span>
    <span>by <small class="author">Author A</small> <a href="/a1">(about)</a></span>
    <div class="tags"><a class="tag" href="/tag/x/1/">x</a><a class="tag" href="/tag/y/1/">y</a></div>
  </div>
  <div class="quote">
    <span class="text">“Quote two.”</span>
    <span>by <small class="author">Author B</small> <a href="/a2">(about)</a></span>
    <div class="tags"><a class="tag" href="/tag/x/2/">x</a></div>
  </div>
</div>
<nav><a href="/next">Next →</a></nav>
</body></html>`

test('类选择器 + ::text（Scrapy 语义）', () => {
  const doc = createSelectorDocument(QUOTES_HTML)
  assert.deepEqual(doc.css('.quote .text::text'), ['“Quote one.”', '“Quote two.”'])
  assert.deepEqual(doc.css('small.author::text'), ['Author A', 'Author B'])
})

test('::attr 提取属性', () => {
  const doc = createSelectorDocument(QUOTES_HTML)
  assert.deepEqual(doc.css('div.tags a.tag::attr(href)'), [
    '/tag/x/1/', '/tag/y/1/', '/tag/x/2/',
  ])
  assert.deepEqual(doc.css('nav a::attr(href)'), ['/next'])
})

test('元素包装对象：attrib / text / 嵌套 css', () => {
  const doc = createSelectorDocument(QUOTES_HTML)
  const quotes = doc.css('.quote')
  assert.equal(quotes.length, 2)
  assert.equal(quotes[0].tag, 'div')
  assert.equal(quotes[0].attrib.class, 'quote')
  assert.ok(quotes[0].text.includes('“Quote one.”'))
  const authors = quotes[0].css('.author::text')
  assert.deepEqual(authors, ['Author A'])
})

test('标签选择器与 * ', () => {
  const doc = createSelectorDocument('<ul><li>1</li><li>2</li></ul>')
  assert.equal(doc.css('li').length, 2)
  assert.deepEqual(doc.css('li::text'), ['1', '2'])
  assert.ok(doc.css('*').length >= 3)
})

test('ID / 属性存在 / 属性值运算符', () => {
  const doc = createSelectorDocument(
    '<a id="top" href="https://a.b/c">1</a><a href="/x" data-k="v1 v2">2</a><a data-lang="zh-CN">3</a>',
  )
  assert.deepEqual(doc.css('#top::text'), ['1'])
  assert.deepEqual(doc.css('a[href]::attr(href)'), ['https://a.b/c', '/x'])
  assert.deepEqual(doc.css('a[href^="https"]::text'), ['1'])
  assert.deepEqual(doc.css('a[href$="/x"]::text'), ['2'])
  assert.deepEqual(doc.css('a[href*="a.b"]::text'), ['1'])
  assert.deepEqual(doc.css('a[data-k~="v2"]::text'), ['2'])
  assert.deepEqual(doc.css('a[data-lang|="zh"]::text'), ['3'])
})

test('组合器：子代 > 与相邻 +', () => {
  const doc = createSelectorDocument(
    '<div><p class="first">a</p><p>b</p><em>c</em></div><div><span class="deep"><p>d</p></span></div>',
  )
  assert.deepEqual(doc.css('div > p::text'), ['a', 'b'])
  assert.deepEqual(doc.css('span.deep > p::text'), ['d'])
  assert.deepEqual(doc.css('p.first + p::text'), ['b'])
  assert.deepEqual(doc.css('p + em::text'), ['c'])
})

test('伪类 :first-child / :last-child / :nth-child', () => {
  const doc = createSelectorDocument('<ul><li>1</li><li>2</li><li>3</li></ul>')
  assert.deepEqual(doc.css('li:first-child::text'), ['1'])
  assert.deepEqual(doc.css('li:last-child::text'), ['3'])
  assert.deepEqual(doc.css('li:nth-child(2)::text'), ['2'])
})

test('逗号分组：文档序合并 + 按位置去重（与 parsel union 一致）', () => {
  const doc = createSelectorDocument('<p>1</p><b>2</b><p>3</p>')
  const result = doc.css('p, b, p::text')
  // 文档序：p1, '1', b, p3, '3'
  assert.equal(result.length, 5)
  assert.equal(result[0].tag, 'p')
  assert.equal(result[1], '1')
  assert.equal(result[2].tag, 'b')
  assert.equal(result[3].tag, 'p')
  assert.equal(result[4], '3')
  // 同一节点命中两个元素分组：按位置去重
  const dup = doc.css('p, p')
  assert.equal(dup.length, 2)
})

test('元素作用域：wrapper.css 只查后代，自身可作祖先', () => {
  const doc = createSelectorDocument('<div class="wrap"><span>a</span><span>b</span></div><span>out</span>')
  const wrap = doc.css('div.wrap')[0]
  assert.deepEqual(wrap.css('span::text'), ['a', 'b'])
  // wrap 自身可作为组合器祖先参与（parsel 语义）
  assert.equal(wrap.css('div.wrap > span::text').length, 2)
})

test('空白归一化模式', () => {
  const doc = createSelectorDocument('<p>\n  hello   <b>world</b>\n</p>')
  assert.deepEqual(doc.css('p::text'), ['hello', 'world'])
  const keep = createSelectorDocument('<p>\n  hello   <b>world</b>\n</p>', { whitespace: 'keep' })
  assert.deepEqual(keep.css('p::text'), ['\n  hello   ', 'world', '\n'])
})

test('畸形 HTML 上的选择器提取', () => {
  const doc = createSelectorDocument('<ul><li>one<li>two<li>three</ul>')
  assert.deepEqual(doc.css('li::text'), ['one', 'two', 'three'])
})

test('非法选择器抛 SelectorError', () => {
  const doc = createSelectorDocument('<p>x</p>')
  assert.throws(() => doc.css(''), SelectorError)
  assert.throws(() => doc.css('a::attr()'), SelectorError)
  assert.throws(() => doc.css('div >'), SelectorError)
  assert.throws(() => doc.css('p:hover'), SelectorError)
  assert.throws(() => extract(doc.node, 'a[unclosed'), SelectorError)
})

test('中文内容与中文属性值', () => {
  const doc = createSelectorDocument(
    '<div class="商品"><span class="价格">¥99.5</span><a title="详情页">看详情</a></div>',
  )
  assert.deepEqual(doc.css('.价格::text'), ['¥99.5'])
  assert.deepEqual(doc.css('a[title="详情页"]::text'), ['看详情'])
})
