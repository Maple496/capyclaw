/**
 * 构建：src/apps/<app> → .works 产物
 * 用法：node scripts/build-works.mjs [--check] [--out <dir>]
 * 产物 = META + DOC + CODE（esbuild 打包成单 IIFE，符合 apphost 的
 * new Function 执行模型与 check-engines 闸门）。
 *
 * 输出目录解析（优先级从高到低）：
 *   1. --out <dir>            显式指定
 *   2. WORKS_OUT_DIR 环境变量  显式指定
 *   3. 本仓 dist/apps          独立模式兜底
 *
 * 需要向桌面主仓投递时，显式设置 DESKTOP_ROOT=<桌面仓根>（opt-in，
 * 不再自动探测平级目录）：desktop-plugin/ppt_bridge.py →
 * backend/bridges.d/（桥插件）、assets/ppt-full-app.js →
 * backend/system_works/assets/（Keynote 运行时 bundle）。
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const APPS_SRC = join(ROOT, 'src', 'apps')
const APPS = ['keystudio', 'pptbridge', 'ppt']
const CHECK_ONLY = process.argv.includes('--check')
const ARG_OUT = (() => {
    const i = process.argv.indexOf('--out')
    return i > 0 ? process.argv[i + 1] : null
})()
const DESKTOP = process.env.DESKTOP_ROOT ? resolve(process.env.DESKTOP_ROOT) : null
const OUT_DIR = resolve(ARG_OUT
    || process.env.WORKS_OUT_DIR
    || join(ROOT, 'dist', 'apps'))
mkdirSync(OUT_DIR, { recursive: true })
console.log(`· 输出目录：${OUT_DIR}`)

/* 闸门等价校验（check-engines 的核心边界） */
function validate(name, code) {
    const fail = []
    try { new Function('"use strict";\n' + code) }
    catch (e) { fail.push('语法错误: ' + e.message) }
    if (/^import\s/m.test(code) || /^export\s/m.test(code)) fail.push('出现 import/export 声明')
    if (/\bfetch\s*\(/.test(code)) fail.push('出现裸 fetch(')
    if (/\bwindow\s*\.\s*[A-Za-z_$][\w$]*\s*=[^=]/.test(code)) fail.push('出现 window. 赋值')
    if (/https?:\/\/(?!localhost|127\.0\.0\.1)[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}/.test(code)) fail.push('出现外部主机字面量')
    if (/icon:\s*['"]app-/.test(code)) fail.push("出现 icon: 'app-…' 字面量")
    if (fail.length) throw new Error(`[${name}] 产物不合规：\n  ` + fail.join('\n  '))
}

async function buildApp(name) {
    const dir = join(APPS_SRC, name)
    const entry = join(dir, 'index.js')
    if (!existsSync(entry)) throw new Error('缺少入口: ' + entry)
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    const doc = readFileSync(join(dir, 'doc.md'), 'utf8').trim()
    const out = await build({
        entryPoints: [entry],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        write: false,
        legalComments: 'none',
        charset: 'utf8',
    })
    const code = out.outputFiles[0].text.trim()
    validate(name, code)
    const text = '%%%WORKS-META%%%\n' + JSON.stringify(meta) +
        '\n\n%%%WORKS-DOC%%%\n' + doc +
        '\n\n%%%WORKS-CODE%%%\n' + code + '\n'
    const dest = join(OUT_DIR, name + '.works')
    if (CHECK_ONLY) {
        const prev = existsSync(dest) ? readFileSync(dest, 'utf8') : ''
        if (prev !== text) throw new Error(`[${name}] 产物过期，请运行 node scripts/build-works.mjs`)
    } else {
        writeFileSync(dest, text)
    }
    return { name, bytes: Buffer.byteLength(text), codeBytes: Buffer.byteLength(code) }
}

const results = []
for (const name of APPS) results.push(await buildApp(name))
for (const r of results) {
    console.log(`${CHECK_ONLY ? '✓ 最新' : '✓ 构建'} ${r.name}.works  ${(r.bytes / 1024).toFixed(1)}KB（CODE ${(r.codeBytes / 1024).toFixed(1)}KB）`)
}

/* ---- 主站接口化投递（2026-10-27）：桥插件 + Keynote 运行时 bundle ---- */
if (DESKTOP) {
    const PLUGIN_SRC = join(ROOT, 'desktop-plugin', 'ppt_bridge.py')
    const PLUGIN_DST = join(DESKTOP, 'backend', 'bridges.d', 'ppt_bridge.py')
    const ASSET_SRC = join(ROOT, 'assets', 'ppt-full-app.js')
    const ASSET_DST = join(DESKTOP, 'backend', 'system_works', 'assets', 'ppt-full-app.js')
    for (const [src, dst, label] of [[PLUGIN_SRC, PLUGIN_DST, 'bridges.d/ppt_bridge.py'], [ASSET_SRC, ASSET_DST, 'assets/ppt-full-app.js']]) {
        if (!existsSync(src)) throw new Error('投递源缺失: ' + src)
        if (CHECK_ONLY) {
            if (!existsSync(dst) || readFileSync(dst, 'utf8') !== readFileSync(src, 'utf8'))
                throw new Error(`[${label}] 投递物过期，请运行 npm run build`)
            console.log(`✓ 最新投递 ${label}`)
        } else {
            mkdirSync(dirname(dst), { recursive: true })
            copyFileSync(src, dst)
            console.log(`✓ 投递 ${label}`)
        }
    }
} else {
    console.log('· 未探测到桌面主仓（DESKTOP_ROOT），跳过 bridges.d/assets 投递')
}
