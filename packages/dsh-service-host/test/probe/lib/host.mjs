/** E2E probe: proves ctx.serviceHost/toolHost/state/assets/editorHost injection. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'public-plugins-probe'
export const inject = ['serviceHost', 'toolHost', 'state', 'assets', 'editorHost']

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

export function apply(ctx, config = {}) {
  const port = Number(config.port) || 0
  const hostDir = config.hostDir || fs.mkdtempSync(path.join(os.tmpdir(), 'public-plugins-probe-'))
  fs.mkdirSync(hostDir, { recursive: true })

  const echo = ctx.toolHost.defineTool({
    name: 'probe_echo',
    description: 'E2E probe echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: ({ text }) => ({ content: [{ type: 'text', text }] }),
  })
  const capability = ctx.toolHost.defineCapability({ id: 'probe', title: 'Probe', tools: [echo] })
  const registry = ctx.toolHost.createRegistry([capability])

  const stateStore = new ctx.state.PersistentStore({
    backend: ctx.state.createFileBackend(path.join(hostDir, 'state.json'), { initialDoc: { count: 0 } }),
    initialDoc: { count: 0 },
  })
  const assetStore = ctx.assets.createFileStore({ dir: path.join(hostDir, 'assets') })
  const editor = ctx.editorHost.createEditorHost({ id: 'probe-editor', dir: hostDir })

  const app = ctx.serviceHost.createApp({
    id: 'public-plugins-probe',
    title: 'Public Plugins Probe',
    version: '0.1.0',
    contractVersion: '1.0.0',
    health: () => ({
      services: {
        serviceHost: !!ctx.serviceHost,
        toolHost: !!ctx.toolHost,
        state: !!ctx.state,
        assets: !!ctx.assets,
        editorHost: !!ctx.editorHost,
      },
      tools: registry.TOOLS.length,
      editorConnected: editor.status().connected,
    }),
  })

  app.get('/probe/tools', (req, res) => json(res, 200, { ok: true, tools: registry.TOOLS.map((tool) => tool.name) }))
  app.get('/probe/state', (req, res) => {
    stateStore.doc.count = (stateStore.doc.count | 0) + 1
    stateStore.save()
    json(res, 200, { ok: true, count: stateStore.get().count })
  })
  app.get('/probe/asset', async (req, res) => {
    const asset = await assetStore.put(Buffer.from('probe-asset'), 'text/plain')
    const got = assetStore.get(asset.id)
    json(res, 200, { ok: true, id: asset.id, text: got?.data?.toString() || '' })
  })

  return app.listen({ port, hostDir, strictPort: true, lockFile: path.join(hostDir, 'probe.lock') })
}
