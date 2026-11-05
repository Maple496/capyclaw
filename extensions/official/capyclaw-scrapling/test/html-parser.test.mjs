/**
 * html-parser 单测：容错性 + 结构正确性。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseHtml, decodeEntities, documentStats } from '../lib/html-parser.mjs'

test('基础结构：嵌套与兄弟', () => {
  const doc = parseHtml('<div><p>a</p><p>b</p></div>')
  const div = doc.children[0]
  assert.equal(div.tag, 'div')
  assert.equal(div.children.length, 2)
  assert.equal(div.children[0].children[0].text, 'a')
  assert.equal(div.children[1].children[0].text, 'b')
})

test('void 元素不进栈（hr 隐式闭合 p，与浏览器一致）', () => {
  const doc = parseHtml('<p>1<br>2<img src="x.png">3<hr></p><span>after</span>')
  const p = doc.children[0]
  assert.equal(p.tag, 'p')
  assert.equal(p.children.length, 5) // 1 br 2 img 3
  assert.equal(doc.children[1].tag, 'hr')
  assert.equal(doc.children[2].tag, 'span')
})

test('未闭合标签：在父级闭合时自动收尾', () => {
  const doc = parseHtml('<ul><li>a<li>b<li>c</ul><tail>x</tail>')
  const ul = doc.children[0]
  assert.equal(ul.children.length, 3)
  assert.deepEqual(ul.children.map((li) => li.children[0].text), ['a', 'b', 'c'])
  assert.equal(doc.children[1].tag, 'tail')
})

test('隐式闭合：li / p / td / tr', () => {
  const doc = parseHtml('<table><tr><td>1<td>2<tr><td>3</table>')
  const table = doc.children[0]
  assert.equal(table.children.length, 2)
  assert.equal(table.children[0].children.length, 2)
  assert.equal(table.children[1].children[0].children[0].text, '3')
})

test('p 被块级元素隐式闭合', () => {
  const doc = parseHtml('<p>one<div>two</div>')
  assert.equal(doc.children.length, 2)
  assert.equal(doc.children[0].tag, 'p')
  assert.equal(doc.children[1].tag, 'div')
})

test('孤立结束标签被忽略', () => {
  const doc = parseHtml('</div><b>ok</b></span>')
  assert.equal(doc.children.length, 1)
  assert.equal(doc.children[0].children[0].text, 'ok')
})

test('script/style raw text 不解析标签', () => {
  const doc = parseHtml('<head><script>if (a < b) { x("</div>") }</script><style>p::before{content:"<"}</style></head>')
  const script = doc.children[0].children[0]
  assert.equal(script.children[0].text.includes('</div>'), true)
  assert.equal(doc.children[0].children.length, 2)
})

test('属性解析：引号/无引号/布尔/重复/大小写', () => {
  const doc = parseHtml(`<A Href="x" Data-Y='2' class = big data-flag checked="yes" data-n=5>`)
  const a = doc.children[0]
  assert.equal(a.tag, 'a')
  assert.equal(a.attrs.href, 'x')
  assert.equal(a.attrs['data-y'], '2')
  assert.equal(a.attrs.class, 'big')
  assert.equal(a.attrs['data-flag'], '')
  assert.equal(a.attrs.checked, 'yes')
  assert.equal(a.attrs['data-n'], '5')
})

test('自闭合 <div/> 与斜杠容错', () => {
  const doc = parseHtml('<div/><span>t</span><img src="a"/><img src="b">')
  assert.equal(doc.children[0].children.length, 0)
  assert.equal(doc.children[1].children[0].text, 't')
  assert.equal(doc.children.length, 4)
})

test('注释保留为节点，doctype 跳过', () => {
  const doc = parseHtml('<!DOCTYPE html><!-- c --><p>x<!-- inner --></p>')
  const p = doc.children.find((n) => n.tag === 'p')
  assert.equal(doc.children[0].tag, '#comment')
  assert.equal(p.children[0].text, 'x')
  assert.equal(p.children[1].tag, '#comment')
})

test('实体解码：命名/十进制/十六进制/未知保留', () => {
  assert.equal(decodeEntities('a&amp;b'), 'a&b')
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB')
  assert.equal(decodeEntities('&hellip;&mdash;&nbsp;'), '…—\u00a0')
  assert.equal(decodeEntities('&unknown; 5 < 6'), '&unknown; 5 < 6')
})

test('非标签的 < 按文本处理（后随字母时与浏览器一致按标签解析）', () => {
  const doc = parseHtml('<p>3 < 5 and 4 < 6</p>')
  const p = doc.children[0]
  const text = p.children.map((n) => n.text || '').join('')
  assert.equal(text, '3 < 5 and 4 < 6')
  // '<b' 后随字母：浏览器按标签处理，解析器同样如此
  const doc2 = parseHtml('<p>a<b>bold</b></p>')
  assert.equal(doc2.children[0].children[1].tag, 'b')
})

test('title 提取与统计', () => {
  const doc = parseHtml('<html><head><title>My &amp; Page</title></head><body><p>hello</p></body></html>')
  const stats = documentStats(doc)
  assert.equal(stats.title, 'My & Page')
  assert.equal(stats.elements, 5) // html head title body p
  assert.ok(stats.textLength > 0)
})

test('quotes.toscrape.com 风格片段', () => {
  const html = `<div class="quote">
    <span class="text" itemprop="text">“The world as we have created it is a process of our thinking.”</span>
    <span>by <small class="author" itemprop="author">Albert Einstein</small>
    <a href="/author/Albert-Einstein">(about)</a></span>
    <div class="tags">
      <a class="tag" href="/tag/change/page/1/">change</a>
      <a class="tag" href="/tag/deep-thoughts/page/1/">deep-thoughts</a>
    </div>
  </div>`
  const doc = parseHtml(html)
  const elementsOf = (node) => (node.children || []).filter((c) => c.tag !== '#text' && c.tag !== '#comment')
  const quote = elementsOf(doc)[0]
  assert.equal(quote.attrs.class, 'quote')
  const bySpan = elementsOf(quote)[1]
  const small = elementsOf(bySpan)[0]
  assert.equal(small.tag, 'small')
  assert.equal(small.attrs.class, 'author')
  assert.equal(small.children[0].text, 'Albert Einstein')
})
