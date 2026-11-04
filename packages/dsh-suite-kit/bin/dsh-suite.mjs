#!/usr/bin/env node
/**
 * dsh-suite CLI：
 *   dsh-suite validate <suite...>
 *   dsh-suite compose <suite...> --out <dir>
 *   dsh-suite install <suite...> --profile web [--dsh-home <dir>] [--dry-run] [--no-pnpm]
 *   dsh-suite doctor --profile web [--dsh-home <dir>] [--dsh-bin <path>]
 *   dsh-suite init <dir> --name <name> [--title <title>]
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  buildActivationRegistry, composeSuites, composeToDir, doctor, formatReport, installSuites,
  loadSuiteManifest, renderCordisPatch, validateSuiteManifest,
} from '../src/index.mjs'

function parse(argv) {
  const args = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (!item.startsWith('--')) { args.push(item); continue }
    const key = item.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { flags[key] = next; i++ }
    else flags[key] = true
  }
  return { args, flags }
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function printValidation(loaded) {
  const result = validateSuiteManifest(loaded.manifest, { baseDir: loaded.dir })
  console.log(`${result.ok ? '✓' : '✗'} ${loaded.manifest.name || loaded.file}`)
  for (const warning of result.warnings) console.log(`  ! ${warning}`)
  for (const error of result.errors) console.log(`  ✗ ${error}`)
  return result.ok
}

function cmdValidate(suitePaths) {
  if (!suitePaths.length) fail('用法: dsh-suite validate <suite...>')
  let ok = true
  for (const input of suitePaths) {
    try {
      ok = printValidation(loadSuiteManifest(input)) && ok
    } catch (error) {
      console.log(`✗ ${input}: ${error.message}`)
      ok = false
    }
  }
  process.exit(ok ? 0 : 1)
}

function cmdCompose(suitePaths, flags) {
  if (!suitePaths.length || !flags.out) fail('用法: dsh-suite compose <suite...> --out <dir>')
  const suites = suitePaths.map((input) => loadSuiteManifest(input))
  const result = composeToDir(suites, path.resolve(flags.out))
  for (const warning of result.warnings) console.log(`! ${warning}`)
  for (const error of result.errors) console.log(`✗ ${error}`)
  console.log(result.ok
    ? `✓ 组合 ${suites.length} 个 suite，${result.rows.length} 行 → ${path.resolve(flags.out)}`
    : '✗ 组合存在冲突')
  process.exit(result.ok ? 0 : 1)
}

function cmdInstall(suitePaths, flags) {
  if (!suitePaths.length) fail('用法: dsh-suite install <suite...> --profile <name>')
  try {
    const plan = installSuites({
      suiteInputs: suitePaths,
      profile: flags.profile,
      dshHome: flags['dsh-home'],
      dryRun: !!flags['dry-run'],
      runPnpm: !flags['no-pnpm'],
      packageSpecs: flags.package ? String(flags.package).split(',') : [],
      rollbackTo: flags['rollback-to'],
      artifactRoot: flags['artifact-root'],
    })
    for (const warning of plan.warnings || []) console.log(`! ${warning}`)
    console.log(`✓ ${plan.dryRun ? 'dry-run ' : ''}suite 安装完成`)
    console.log(JSON.stringify(plan, null, 2))
  } catch (error) {
    fail(error.message)
  }
}

function cmdRegistry(suitePaths) {
  if (!suitePaths.length) fail('用法: dsh-suite registry <suite...>')
  const suites = suitePaths.map((input) => loadSuiteManifest(input))
  const composed = composeSuites(suites)
  if (!composed.ok) fail('suite 组合冲突:\n- ' + composed.errors.join('\n- '))
  const { registry, warnings } = buildActivationRegistry({ suites, composed })
  for (const warning of warnings) console.error(`! ${warning}`)
  console.log(JSON.stringify(registry, null, 2))
}

async function cmdDoctor(flags) {
  const report = await doctor({
    profile: flags.profile,
    dshHome: flags['dsh-home'],
    dshBin: flags['dsh-bin'],
  })
  console.log(formatReport(report))
  process.exitCode = report.ok ? 0 : 1
}

function cmdInit(dir, flags) {
  if (!dir || !flags.name) fail('用法: dsh-suite init <dir> --name <name> [--title <title>]')
  const target = path.resolve(dir)
  if (fs.existsSync(target) && fs.readdirSync(target).length) fail(`目录非空: ${target}`)
  fs.mkdirSync(target, { recursive: true })
  const name = flags.name
  const title = flags.title || name
  const manifest = {
    name,
    version: '0.1.0',
    title,
    description: `${title}（DSH 组合套件）`,
    packages: {
      [name]: { role: 'runtime', version: '^0.1.0', path: '.' },
    },
    rows: [{ id: `${name}-host`, name }],
    checks: [],
  }
  const pkg = {
    name,
    version: '0.1.0',
    description: manifest.description,
    type: 'module',
    main: './lib/index.mjs',
    exports: { '.': './lib/index.mjs', './package.json': './package.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, suite: './dsh-suite.json' },
    files: ['lib/', 'dsh-suite.json', 'cordis.patch.yml', 'README.md'],
    license: 'MIT',
    private: true,
  }
  fs.writeFileSync(path.join(target, 'dsh-suite.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  fs.writeFileSync(path.join(target, 'cordis.patch.yml'), renderCordisPatch(manifest.rows))
  fs.mkdirSync(path.join(target, 'lib'))
  fs.writeFileSync(path.join(target, 'lib', 'index.mjs'),
    `export const name = ${JSON.stringify(name)}\nexport function apply() {}\n`)
  fs.writeFileSync(path.join(target, 'README.md'),
    `# ${title}\n\n由 dsh-suite-kit 生成的 DSH 组合套件。\n\n` +
    '```bash\ndsh-suite validate .\ndsh-suite install . --profile web\n```\n')
  console.log(`✓ 已生成 ${target}`)
}

const { args, flags } = parse(process.argv.slice(2))
const [command] = args
if (!command || command === '--help' || command === 'help') {
  console.log(`dsh-suite — DSH 组合标准件

  validate <suite...>                         校验 manifest
  compose <suite...> --out <dir>              组合并生成 cordis.patch.yml
  registry <suite...>                         生成 launch-engine 激活注册表（预览）
  install <suite...> --profile web            安装到 profile
  doctor --profile web                        运行健康检查
  init <dir> --name <name>                    生成新 suite 模板
`)
  process.exit(0)
}

if (command === 'validate') cmdValidate(args.slice(1))
else if (command === 'compose') cmdCompose(args.slice(1), flags)
else if (command === 'registry') cmdRegistry(args.slice(1))
else if (command === 'install') cmdInstall(args.slice(1), flags)
else if (command === 'doctor') await cmdDoctor(flags)
else if (command === 'init') cmdInit(args[1], flags)
else fail(`未知命令: ${command}`)
