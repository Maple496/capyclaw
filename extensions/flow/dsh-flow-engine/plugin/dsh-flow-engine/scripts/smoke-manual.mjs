import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { startService } from '../server/relay.mjs'
const t0 = Date.now()
console.log('starting…')
const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-smoke-'))
const service = await startService({ port: 0, hostDir })
console.log('started in', Date.now() - t0, 'ms at', service.url, 'executor', service.executorUrl)
const h = await fetch(`${service.url}/healthz`).then(r => r.json())
console.log('health:', JSON.stringify(h))
const py = await fetch(`${service.url}/api/flow/health`).then(r => r.json())
console.log('py health:', JSON.stringify(py))
await service.stop()
console.log('stopped cleanly')
process.exit(0)
