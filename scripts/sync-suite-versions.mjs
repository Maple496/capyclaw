#!/usr/bin/env node
/**
 * 一次性脚本:版本提升后,同步所有 dsh-suite.json / services.json 中
 * 对被提升包的 ^X.Y.Z 引用(你的体系要求引用精确跟踪当前版本)。
 *
 * 只更新 packages 对象里「键名 = 被提升包名」的 version 字段,不碰清单自身版本。
 * 用法:node scripts/sync-suite-versions.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

// 被提升的包:名 -> 新版本
const bumped = {
  '@capyclaw/asset-service': '0.1.2',
  '@capyclaw/document-workbench': '0.1.1',
  '@capyclaw/editor-host': '0.1.2',
  '@capyclaw/plugin-kit': '0.2.1',
  '@capyclaw/service-broker': '0.2.1',
  '@capyclaw/service-host': '0.1.2',
  '@capyclaw/tool-host': '0.1.2',
  '@capyclaw/skills-service': '0.1.4',
  '@capyclaw/ppt-suite': '2.4.4',
  '@capyclaw/ppt-workbench': '2.4.4',
  '@capyclaw/ppt-skill-api': '2.2.2',
  '@capyclaw/ppt-skill-authoring': '2.2.2',
  '@capyclaw/ppt-skill-design': '2.2.2',
  '@capyclaw/ppt-skill-editing': '2.2.2',
  '@capyclaw/ppt-skill-narrative': '2.2.3',
  '@capyclaw/ppt-skill-ppt': '2.2.2',
  '@capyclaw/ppt-skill-research': '2.2.2',
  '@capyclaw/ppt-skill-visual-check': '2.2.2',
  '@capyclaw/ddr0-client': '1.0.2',
  '@capyclaw/launch-engine': '0.1.1',
  '@capyclaw/launchpad': '1.1.2',
  '@capyclaw/llm-tempkey': '1.0.2',
  '@capyclaw/plugin-sync': '0.1.1',
  '@capyclaw/port-sidebar': '1.0.3',
  '@capyclaw/scrapling': '1.1.0',
}
// 目录名形式(部分清单用本地目录名做键)
for (const [name, ver] of Object.entries({ ...bumped })) {
  bumped[name.replace(/^@capyclaw\//, '')] = ver
}

const files = []
const walk = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist') continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p)
    else if (ent.name === 'dsh-suite.json' || ent.name === 'services.json') files.push(p)
  }
}
walk('packages'); walk('extensions'); walk('tools')

let changed = 0
const report = []
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8')
  const json = JSON.parse(raw)
  let touched = false
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    for (const [key, val] of Object.entries(node)) {
      if (val && typeof val === 'object') {
        // packages 形态:{ "@capyclaw/x": { version: "^1.2.3", ... } }
        const normKey = key.startsWith('@capyclaw/') ? key : (bumped[key] ? key : null)
        if (normKey && bumped[key] && val.version !== undefined) {
          const want = '^' + bumped[key]
          if (val.version !== want) {
            report.push(`${path.relative('.', file)}: ${key} ${val.version} -> ${want}`)
            val.version = want
            touched = true
          }
        }
        visit(val)
      }
    }
  }
  visit(json)
  if (touched) {
    fs.writeFileSync(file, raw.endsWith('\n') ? JSON.stringify(json, null, 2) + '\n' : JSON.stringify(json, null, 2))
    changed++
  }
}
console.log(report.join('\n'))
console.log(`\n${changed} 个文件更新`)
