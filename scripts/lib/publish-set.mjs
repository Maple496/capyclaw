/**
 * 本仓「可发布包」集合的唯一定义：支撑库 + discoverPlugins() 插件。
 *
 * publish-to-npm 与 bump 共用，避免两份清单漂移。支撑库（纯库/独立服务，
 * 无 dsh.bundle，discoverPlugins 不收）用显式清单维护。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverPlugins } from '../../tools/capyclaw-plugin-release/lib/index.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 支撑库目录（相对仓库根）。 */
export const SUPPORT_LIBS = [
  'packages/capyclaw-plugin-kit',
  'packages/capyclaw-document-workbench',
  'packages/capyclaw-host-shell',
  'extensions/bridges/ppt-bridge/capyclaw-skills-service',
]

/** 全部可发布包目录（支撑库在前：发布顺序「先库后插件」的依赖要求）。 */
export function allPublishableDirs() {
  const dirs = [...SUPPORT_LIBS.map((rel) => path.join(ROOT, rel)), ...discoverPlugins()]
  return dirs.filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
}

export function pkgOf(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
}

/** 名字（npm 名或目录名形态 capyclaw-<x>）→ 目录 的解析表。 */
export function packageDirIndex() {
  const map = new Map()
  for (const dir of allPublishableDirs()) {
    const pkg = pkgOf(dir)
    map.set(pkg.name, dir)
    map.set('capyclaw-' + pkg.name.split('/').pop(), dir)
  }
  return map
}
