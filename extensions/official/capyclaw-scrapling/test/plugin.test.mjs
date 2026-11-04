/**
 * dsh-scrapling 插件测试
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'

describe('dsh-scrapling', () => {
  it('应该导出 name 和 apply', async () => {
    const plugin = await import('../lib/host.mjs')
    assert.strictEqual(plugin.name, '@capyclaw/scrapling')
    assert.strictEqual(typeof plugin.apply, 'function')
  })

  it('应该提供 scrapling 服务', async () => {
    const plugin = await import('../lib/host.mjs')
    
    // 模拟 Cordis 上下文
    const services = {}
    const ctx = {
      provide(name, service) {
        services[name] = service
      }
    }
    
    await plugin.apply(ctx, {})
    
    assert.ok(services.scrapling)
    assert.strictEqual(typeof services.scrapling.fetch, 'function')
    assert.strictEqual(typeof services.scrapling.fetchWithBrowser, 'function')
    assert.strictEqual(typeof services.scrapling.parse, 'function')
  })
})
