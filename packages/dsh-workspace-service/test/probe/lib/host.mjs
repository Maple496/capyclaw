/** E2E probe: proves that a functional plugin can inject ctx.workspace. */
import http from 'node:http'

export const name = 'workspace-probe'
export const inject = ['workspace']

export function apply(ctx, config = {}) {
  const port = Number(config.port) || 0
  const workId = config.workId || ctx.workspace?.workId || 'main'
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const send = (code, body) => {
      const text = JSON.stringify(body)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    }
    try {
      if (url.pathname === '/healthz') {
        return send(200, {
          ok: true,
          workspace: !!ctx.workspace,
          runtimeId: ctx.workspace?.runtime?.runtimeId || '',
          workId,
          storeRoot: ctx.workspace?.runtime?.store?.root || '',
        })
      }
      if (url.pathname === '/roundtrip') {
        const value = url.searchParams.get('value') || 'probe'
        await ctx.workspace.putJson(workId, 'probe/roundtrip.json', { value })
        const got = ctx.workspace.getJson(workId, 'probe/roundtrip.json')
        return send(200, { ok: true, value: got?.value })
      }
      if (url.pathname === '/forbidden') {
        try {
          ctx.workspace.putJson(workId, 'not-declared.json', { value: 'x' })
          return send(200, { ok: false, message: 'unexpectedly allowed' })
        } catch (error) {
          return send(200, { ok: true, rejected: String(error.message || error) })
        }
      }
      return send(404, { ok: false, error: 'not found' })
    } catch (error) {
      return send(500, { ok: false, error: String(error.message || error) })
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      console.log(`[workspace-probe] ready http://127.0.0.1:${actual}/`)
      resolve(() => new Promise((done) => server.close(done)))
    })
  })
}
