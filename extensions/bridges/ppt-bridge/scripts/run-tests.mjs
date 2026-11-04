#!/usr/bin/env node
/** 跨平台跑全部 test/*.test.mjs（Windows cmd 不会展开 glob）。 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const files = readdirSync(join(ROOT, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(ROOT, 'test', name))

const result = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' })
process.exit(result.status ?? 1)
