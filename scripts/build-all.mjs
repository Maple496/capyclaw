#!/usr/bin/env node
/** 并行构建三个 bridge；各 bridge 输出目录互不相交。用法：node scripts/build-all.mjs [--check] */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const BRIDGES = ['ppt', 'canvas', 'browser']
const checkOnly = process.argv.includes('--check')

function runBridge(name) {
  const cwd = join(ROOT, 'extensions', 'bridges', `${name}-bridge`)
  const script = join(cwd, 'scripts', 'build-plugin.mjs')
  const args = [script, ...(checkOnly ? ['--check'] : [])]

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ name, code: 1, stdout, stderr: stderr + error.message + '\n' }))
    child.on('close', (code, signal) => resolve({ name, code: code ?? 1, signal, stdout, stderr }))
  })
}

function printOutput(name, stream, text) {
  for (const line of text.split(/\r?\n/)) {
    if (line) stream.write(`[${name}] ${line}\n`)
  }
}

const results = await Promise.all(BRIDGES.map(runBridge))
for (const result of results) {
  printOutput(result.name, process.stdout, result.stdout)
  printOutput(result.name, process.stderr, result.stderr)
  if (result.code !== 0) {
    process.stderr.write(`[${result.name}] 构建失败（exitCode=${result.code}${result.signal ? `, signal=${result.signal}` : ''}）\n`)
  }
}

if (results.some((result) => result.code !== 0)) process.exitCode = 1
