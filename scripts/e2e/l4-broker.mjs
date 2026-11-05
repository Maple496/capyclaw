/**
 * L4 broker 套件链路层：services.json（一字不改）→ dsh-service-broker → 真实进程拉起。
 *
 * 本次重构把 canvas-suite 的 services.json 升级为与 ppt 同款的新代规格
 * （portFrom/dirFrom/keepAlive + ${PACKAGE_DIR}/node_modules/<pkg>/ 安装态路径）。
 * 开发树没有安装态 node_modules，用 junction 伪造：临时「套件根」放原样 services.json，
 * node_modules/@capyclaw/<pkg> 以 junction 指向 dev 树真实包目录——${PACKAGE_DIR}
 * 展开基准、${PORT} 展开、portFrom/dirFrom 放行、healthPath 收编、discovery 写入、
 * /control 拉起与回收全链路照真实路径走。
 */
import fs from 'node:fs'
import path from 'node:path'

import { ROOT, Recorder, getJson, makeJunction, portFree, removeJunction, run, startService, tempDir, waitFor } from './harness.mjs'

const SUITES = [
  {
    ns: 'browser',
    suiteDir: path.join(ROOT, 'extensions/bridges/browser-bridge/plugin/capyclaw-browser-suite'),
    linkPackages: [
      ['browser-workbench', path.join(ROOT, 'extensions/bridges/browser-bridge/plugin/capyclaw-browser-workbench')],
    ],
    services: [{ id: 'browser-workbench', port: 39315 }],
  },
  {
    ns: 'canvas',
    suiteDir: path.join(ROOT, 'extensions/bridges/canvas-bridge/plugin/capyclaw-canvas-suite'),
    linkPackages: [
      ['canvas-workbench', path.join(ROOT, 'extensions/bridges/canvas-bridge/plugin/capyclaw-canvas-workbench')],
    ],
    services: [{ id: 'canvas-workbench', port: 39313 }],
  },
  {
    ns: 'ppt',
    suiteDir: path.join(ROOT, 'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-suite'),
    linkPackages: [
      ['ppt-workbench', path.join(ROOT, 'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-workbench')],
      ['skills-service', path.join(ROOT, 'extensions/bridges/ppt-bridge/capyclaw-skills-service')],
    ],
    services: [
      { id: 'ppt-workbench', port: 39311 },
      { id: 'dsh-skills', port: 39321, service: 'dsh-skills' },
    ],
  },
]

async function suiteViaBroker(rec, { ns, suiteDir, linkPackages, services }) {
  const stage = tempDir(`l4-${ns}`)
  const junctions = []
  let broker = null
  const brokerPort = 24000 + Math.floor(Math.random() * 5000)
  try {
    /* 0. 固定端口必须空闲（services.json 一字不改的前提） */
    for (const s of services) {
      if (!(await portFree(s.port))) {
        rec.check(`${ns}: 端口 ${s.port} 空闲（services.json 原样消费的前提）`, false, '被占用')
        return
      }
    }

    /* 1. 伪造安装态套件根：services.json 原样拷贝 + node_modules junction（指向 dev 树真实包目录；
     *    生成包不是 workspace 成员，根 node_modules 里没有） */
    fs.copyFileSync(path.join(suiteDir, 'services.json'), path.join(stage, 'services.json'))
    for (const [pkg, target] of linkPackages) {
      const link = path.join(stage, 'node_modules', '@capyclaw', pkg)
      makeJunction(link, target)
      junctions.push([link, target])
    }
    rec.check(`${ns}: 安装态套件根就绪（${linkPackages.length} 个 junction）`, junctions.length === linkPackages.length)

    /* 2. broker 按清单拉起（--manifest 指向临时套件根的 services.json） */
    const discovery = path.join(stage, 'discovery', 'services.json')
    broker = await startService(process.execPath, [
      path.join(ROOT, 'packages/capyclaw-service-broker/server.mjs'),
      '--port', String(brokerPort),
      '--manifest', path.join(stage, 'services.json'),
      '--discovery', discovery,
    ], {
      logFile: path.join(stage, 'broker.log'),
      timeoutMs: 60000,
      readyFn: async () => {
        const h = await getJson(`http://127.0.0.1:${brokerPort}/healthz`, 3000).catch(() => null)
        return h?.ok ? h : null
      },
    })

    /* 3. 逐服务断言：healthz（pid + 契约）+ discovery 收编 */
    for (const s of services) {
      const h = await waitFor(async () => getJson(`http://127.0.0.1:${s.port}/healthz`, 3000).catch(() => null), {
        timeoutMs: 45000,
        label: `${ns} ${s.id} relay 被 broker 拉起`,
      })
      rec.check(`${ns}: ${s.id} 被 broker 拉起且 /healthz 报 pid（portFrom 规格生效）`,
        h.ok === true && typeof h.pid === 'number',
        JSON.stringify({ ok: h.ok, pid: h.pid, service: h.service || h.bridge }))
      if (s.service) {
        rec.check(`${ns}: ${s.id} service 自报 = ${s.service}`, (h.service || '') === s.service, h.service)
      }
    }
    const list = await getJson(`http://127.0.0.1:${brokerPort}/control/list`)
    const listed = (list.services || []).map((x) => x.id || x.service?.id).filter(Boolean)
    const allListed = services.every((s) => listed.includes(s.id))
    rec.check(`${ns}: broker /control/list 收编全部服务（${services.map((s) => s.id).join(' + ')}）`, allListed, JSON.stringify(listed))
    const discoveryWritten = fs.existsSync(discovery)
      ? (fs.readFileSync(discovery, 'utf8').includes(services[0].id)) : false
    rec.check(`${ns}: discovery 文件写入 ${services[0].id}`, discoveryWritten)

    /* 4. /control/stop 回收 + receipt 清理 */
    const first = services[0]
    const stop = await fetch(`http://127.0.0.1:${brokerPort}/control/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: first.id }),
      signal: AbortSignal.timeout(15000),
    })
    const stopJson = await stop.json().catch(() => ({}))
    await waitFor(async () => !(await portFree(first.port)) ? null : true, { timeoutMs: 15000, label: `${first.id} 端口释放` })
    rec.check(`${ns}: /control/stop 回收 ${first.id}（端口已释放）`, stopJson.stopped !== false, JSON.stringify(stopJson).slice(0, 120))
  } catch (error) {
    rec.check(`${ns}: broker 套件链路`, false, error.message)
  } finally {
    if (broker) await broker.stop()
    for (const [link] of junctions) removeJunction(link)
    /* junction 移除后目标必须完好（防误删真实包内容） */
    for (const [, target] of linkPackages) {
      if (!fs.existsSync(path.join(target, 'package.json'))) console.error(`✗ 严重：junction 目标损坏 ${target}`)
    }
    await new Promise((r) => setTimeout(r, 800))
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

export async function runLayer() {
  const rec = new Recorder('L4 broker 套件链路层')
  rec.section('新代 services.json 经 broker 全链路消费')
  for (const suite of SUITES) await suiteViaBroker(rec, suite)
  return rec.summary()
}
