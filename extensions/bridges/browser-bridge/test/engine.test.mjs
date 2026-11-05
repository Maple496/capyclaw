/**
 * 引擎纯函数单测：配置解析 + URL 安全校验（不拉起浏览器）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { assertSafeUrl, resolveEngineConfig, ENGINE_CONFIG_DEFAULTS } from '../src/mcp/engine.mjs'

/* ---- resolveEngineConfig ---- */

test('resolveEngineConfig: 默认值（无环境变量、无覆盖）', () => {
  const cfg = resolveEngineConfig({}, {})
  assert.equal(cfg.headless, false, '默认有头可见')
  assert.equal(cfg.allowEvaluate, false, 'evaluate 默认关闭')
  assert.equal(cfg.navigationTimeoutMs, 30000)
  assert.equal(cfg.maxSnapshotChars, 40000)
  assert.equal(cfg.viewportWidth, 1280)
})

test('resolveEngineConfig: 环境变量解析（布尔/数字/字符串）', () => {
  const cfg = resolveEngineConfig({
    DSH_BROWSER_HEADLESS: 'true',
    DSH_BROWSER_ALLOW_EVALUATE: '1',
    DSH_BROWSER_CHANNEL: 'msedge',
    DSH_BROWSER_NAV_TIMEOUT_MS: '8000',
    DSH_BROWSER_MAX_SNAPSHOT_CHARS: '2000',
    DSH_BROWSER_VIEWPORT_W: '1000',
  }, {})
  assert.equal(cfg.headless, true)
  assert.equal(cfg.allowEvaluate, true)
  assert.equal(cfg.channel, 'msedge')
  assert.equal(cfg.navigationTimeoutMs, 8000)
  assert.equal(cfg.maxSnapshotChars, 2000)
  assert.equal(cfg.viewportWidth, 1000)
})

test('resolveEngineConfig: 非法数字回退默认，显式覆盖优先于环境变量', () => {
  const cfg = resolveEngineConfig(
    { DSH_BROWSER_NAV_TIMEOUT_MS: 'not-a-number', DSH_BROWSER_HEADLESS: 'true' },
    { headless: false },
  )
  assert.equal(cfg.navigationTimeoutMs, ENGINE_CONFIG_DEFAULTS.navigationTimeoutMs)
  assert.equal(cfg.headless, false, '显式覆盖击败环境变量')
})

test('resolveEngineConfig: 空字符串环境变量被忽略', () => {
  const cfg = resolveEngineConfig({ DSH_BROWSER_CHANNEL: '' }, {})
  assert.equal(cfg.channel, '')
})

/* ---- assertSafeUrl ---- */

test('assertSafeUrl: http/https 放行（含本地回环）', () => {
  assert.equal(assertSafeUrl('https://example.com/path?q=1'), 'https://example.com/path?q=1')
  assert.equal(assertSafeUrl('http://127.0.0.1:39315/demo/form.html'), 'http://127.0.0.1:39315/demo/form.html')
})

test('assertSafeUrl: 非 http(s) 协议拒绝', () => {
  for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com/']) {
    assert.throws(() => assertSafeUrl(url), (error) => {
      assert.equal(error.code, 'URL_SCHEME_DENIED', `${url} 错误码`)
      return true
    }, `${url} 应被拒绝`)
  }
})

test('assertSafeUrl: URL 内嵌凭据拒绝', () => {
  assert.throws(() => assertSafeUrl('https://alice:secret@example.com/'), (error) => {
    assert.equal(error.code, 'URL_CREDENTIALS_DENIED')
    assert.ok(error.hint.includes('browser_fill'))
    return true
  })
})

test('assertSafeUrl: 非法 URL 报 URL_INVALID', () => {
  assert.throws(() => assertSafeUrl('not a url at all'), (error) => {
    assert.equal(error.code, 'URL_INVALID')
    return true
  })
})
