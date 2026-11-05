#!/usr/bin/env node
/**
 * 一次性脚本:对指定的 24 个已发布包做 patch 版本提升(npm→GitHub 关联重发用)。
 * 用法:node scripts/bump-patch.mjs [--check]
 */
import fs from 'node:fs'

const targets = [
  'packages/capyclaw-asset-service',
  'packages/capyclaw-document-workbench',
  'packages/capyclaw-editor-host',
  'packages/capyclaw-plugin-kit',
  'packages/capyclaw-service-broker',
  'packages/capyclaw-service-host',
  'packages/capyclaw-tool-host',
  'extensions/bridges/ppt-bridge/capyclaw-skills-service',
  'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-suite',
  'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-workbench',
  'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-skill-api',
  'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-skill-authoring',
  'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-skill-design',
  'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-skill-editing',
  'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-skill-narrative',
  'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-skill-ppt',
  'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-skill-research',
  'extensions/bridges/ppt-bridge/plugin/capyclaw-ppt-skill-visual-check',
  'extensions/official/capyclaw-ddr0-client',
  'extensions/official/capyclaw-launch-engine',
  'extensions/official/capyclaw-launchpad',
  'extensions/official/capyclaw-llm-tempkey',
  'extensions/official/capyclaw-plugin-sync',
  'extensions/official/capyclaw-port-sidebar',
  'extensions/official/capyclaw-scrapling',
]

const CHECK = process.argv.includes('--check')
for (const dir of targets) {
  const file = `${dir}/package.json`
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  const [maj, min, patch] = pkg.version.split('.').map(Number)
  const next = `${maj}.${min}.${patch + 1}`
  if (!CHECK) {
    pkg.version = next
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  }
  console.log(`${pkg.name}: ${pkg.version} -> ${next}${CHECK ? ' (check)' : ''}`)
}
console.log(`\n${targets.length} packages${CHECK ? ' (check mode)' : ''}`)
