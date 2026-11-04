import fs from 'node:fs'

const rows = []
const fixed = {
  'packages/capyclaw-plugin-kit': 'libs',
  'packages/capyclaw-document-workbench': 'libs',
  'extensions/bridges/ppt-bridge/capyclaw-skills-service': 'libs',
  'packages/capyclaw-service-host': 'infra',
  'packages/capyclaw-tool-host': 'infra',
  'packages/capyclaw-asset-service': 'infra',
  'packages/capyclaw-editor-host': 'infra',
  'packages/capyclaw-service-broker': 'infra',
  'tools/capyclaw-plugin-generator': 'tools',
  'tools/capyclaw-plugin-validator': 'tools',
  'extensions/official/capyclaw-launchpad': 'official',
  'extensions/official/capyclaw-launch-engine': 'official',
  'extensions/official/capyclaw-plugin-sync': 'official',
  'extensions/official/capyclaw-llm-tempkey': 'official',
  'extensions/official/capyclaw-port-sidebar': 'official',
  'extensions/official/capyclaw-scrapling': 'official',
  'extensions/official/capyclaw-ddr0-client': 'official',
  'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-workbench': 'ppt',
  'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-suite': 'ppt',
  'extensions/bridges/canvas-bridge/plugin/capyclaw-canvas-workbench': 'canvas',
  'extensions/bridges/canvas-bridge/plugin/capyclaw-canvas-suite': 'canvas',
}

for (const [d, g] of Object.entries(fixed)) {
  const p = JSON.parse(fs.readFileSync(d + '/package.json', 'utf8'))
  rows.push({ g, name: p.name, ver: p.version, desc: (p.description || '').split(/[。;；\n]/)[0].slice(0, 40) })
}

for (const dir of ['extensions/bridges/ppt-bridge/plugin', 'extensions/bridges/canvas-bridge/plugin']) {
  for (const sub of fs.readdirSync(dir)) {
    const f = `${dir}/${sub}/package.json`
    if (!fs.existsSync(f)) continue
    const p = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (!p.name.includes('skill-') || p.private) continue
    rows.push({ g: dir.includes('ppt') ? 'ppt' : 'canvas', name: p.name, ver: p.version, desc: (p.description || '').split(/[。;；\n]/)[0].slice(0, 40) })
  }
}

const titles = {
  libs: '### 构建库(packages/ · registry 外单独发布)',
  infra: '### 基建插件(packages/)',
  tools: '### 工具链(tools/)',
  official: '### 官方扩展(extensions/official/)',
  ppt: '### PPT 桥(extensions/bridges/ppt-bridge/)',
  canvas: '### Canvas 桥(extensions/bridges/canvas-bridge/)',
}
const order = ['libs', 'infra', 'tools', 'official', 'ppt', 'canvas']

let out = ''
for (const g of order) {
  const rs = rows.filter((r) => r.g === g).sort((a, b) => a.name.localeCompare(b.name))
  if (!rs.length) continue
  out += `\n${titles[g]}\n\n| 包 | 版本 | 说明 |\n|---|---|---|\n`
  for (const r of rs) out += `| [\`${r.name}\`](https://www.npmjs.com/package/${r.name}) | ${r.ver} | ${r.desc || '—'} |\n`
}

fs.writeFileSync('npm-table.md', out.trimEnd() + '\n')
console.log(`rows: ${rows.length}`)
