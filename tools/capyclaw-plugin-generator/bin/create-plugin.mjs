#!/usr/bin/env node
/**
 * DSH 插件脚手架（标准版）。
 *
 * 默认生成一个可安装的完整单元：
 *   <out>/<name>/plugin/<name>                 运行时插件
 *   <out>/<name>/plugin/<name>-suite           suite 包
 *   <out>/<name>/domains/<domain>/dsh-domain.json
 *
 * 只生成单个插件包：--plugin-only
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { renderCordisPatch } from '@capyclaw/suite-kit/compose'
import { syncSharedDir } from '../../../scripts/lib/shared-sync.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATES = path.join(HERE, '..', 'templates')
const VERSION = '1.0.0'
const DEFAULT_PORT = 39500

function printHelp() {
  console.log(`
DSH 插件脚手架

用法:
  node create-plugin.mjs
  node create-plugin.mjs --name dsh-my-service --type service --port 39500 --out ./my-plugins --yes

参数:
  --name <kebab-case>       插件包名（必填）
  --type <service|ui|minimal>  插件类型（默认 service）
  --title <text>            显示标题（默认取 name）
  --description <text>      描述
  --port <1-65535>          默认端口（默认 ${DEFAULT_PORT}）
  --out <dir>               输出父目录（默认 ./my-plugins）
  --domain <name>           domain 名称（默认取去掉 dsh- 前缀的名字）
  --plugin-only             只生成插件包，不生成 suite/domain
  --yes, -y                 非交互模式；缺失参数用默认值
  --help, -h                显示帮助

生成结构（默认）:
  <out>/<name>/plugin/<name>/
  <out>/<name>/plugin/<name>-suite/
  <out>/<name>/domains/<domain>/dsh-domain.json
`)
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`参数缺少值: ${arg}`)
      return value
    }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--yes' || arg === '-y') options.yes = true
    else if (arg === '--plugin-only') options.pluginOnly = true
    else if (arg === '--name') options.name = next()
    else if (arg.startsWith('--name=')) options.name = arg.slice('--name='.length)
    else if (arg === '--type') options.type = next()
    else if (arg.startsWith('--type=')) options.type = arg.slice('--type='.length)
    else if (arg === '--title') options.title = next()
    else if (arg.startsWith('--title=')) options.title = arg.slice('--title='.length)
    else if (arg === '--description') options.description = next()
    else if (arg.startsWith('--description=')) options.description = arg.slice('--description='.length)
    else if (arg === '--port') options.port = Number(next())
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length))
    else if (arg === '--out') options.out = next()
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length)
    else if (arg === '--domain') options.domain = next()
    else if (arg.startsWith('--domain=')) options.domain = arg.slice('--domain='.length)
    else throw new Error(`未知参数: ${arg}`)
  }
  return options
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close()
    resolve(answer.trim())
  }))
}

function slugOf(name) {
  return name.replace(/^dsh-/, '')
}

function render(text, tokens) {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => tokens[key] ?? '')
}

function writeTemplate(templateRel, destFile, tokens) {
  const source = fs.readFileSync(path.join(TEMPLATES, templateRel), 'utf8')
  fs.mkdirSync(path.dirname(destFile), { recursive: true })
  fs.writeFileSync(destFile, render(source, tokens))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function makePackageJson({ name, title, description, type, version }) {
  const files = ['package.json', 'lib/', 'cordis.patch.yml', 'README.md']
  if (type === 'service' || type === 'ui') files.push('server/', 'contract/')
  if (type === 'ui') files.push('editor/')
  return {
    name,
    version,
    private: true,
    description,
    type: 'module',
    main: './lib/host.mjs',
    exports: {
      '.': './lib/host.mjs',
      './package.json': './package.json',
    },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      category: type === 'ui' ? 'ui' : 'service',
      platform: 'web',
    },
    dependencies: {
      '@capyclaw/plugin-kit': '^0.2.0',
    },
    engines: {
      dsh: '^0.2.0-rc.2',
    },
    meta: { title, description },
    files,
    license: 'MIT',
  }
}

function makeCordisPatch({ name, hostId, serverName, port, type }) {
  const host = `    - id: ${hostId}
      name: ${JSON.stringify(name)}
      config:
        port: ${port}`
  if (type === 'minimal') {
    return `# 由脚手架生成；只注册宿主插件，不提供 MCP 服务。

- insert:
${host}
`
  }
  return `# 由脚手架生成；端口或 MCP 配置变化时同步修改这里和 dsh-suite.json。

- insert:
${host}
    - id: mcp-${serverName}
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ${serverName}
        transport: streamable-http
        url: 'http://127.0.0.1:${port}/mcp'
        failOnStartupError: false
        toolCallTimeoutMs: 120000
`
}

function makeSuiteManifest({ suiteName, name, title, description, hostId, serverName, toolPrefix, port }) {
  return {
    name: suiteName,
    version: VERSION,
    title: `${title} 套件`,
    description: description || `${title} 运行时与 MCP 工具`,
    packages: {
      [name]: {
        role: 'runtime',
        version: `^${VERSION}`,
        path: `../${name}`,
        provides: {
          tools: [`${toolPrefix}_*`],
          services: [`${serverName}-service`],
          ports: [port],
          capabilities: {
            [`${serverName}.runtime`]: VERSION,
          },
        },
      },
    },
    rows: [
      { id: hostId, name, config: { port } },
      {
        id: `mcp-${serverName}`,
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          serverName,
          transport: 'streamable-http',
          url: `http://127.0.0.1:${port}/mcp`,
          failOnStartupError: false,
          toolCallTimeoutMs: 120000,
        },
      },
    ],
    checks: [
      {
        id: `${serverName}-health`,
        type: 'http',
        url: `http://127.0.0.1:${port}/healthz`,
        expectStatus: 200,
        expectBody: { ok: true },
        timeoutMs: 3000,
      },
      {
        id: `${serverName}-contract`,
        type: 'contract',
        url: `http://127.0.0.1:${port}/mcp`,
        tool: `${toolPrefix}_capabilities`,
        major: 1,
        timeoutMs: 5000,
      },
    ],
  }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`✗ ${error.message}\n`)
    printHelp()
    process.exit(1)
  }
  if (options.help) {
    printHelp()
    return
  }

  if (!options.name) {
    if (options.yes) throw new Error('--yes 模式必须提供 --name')
    options.name = await ask('插件包名（kebab-case，例 dsh-my-service）: ')
  }
  if (!options.type) {
    options.type = options.yes ? 'service' : (await ask('类型 service/ui/minimal（默认 service）: ')) || 'service'
  }
  if (!options.title) {
    options.title = options.yes ? options.name : (await ask('显示标题（默认取插件名）: ')) || options.name
  }
  if (!options.description) {
    options.description = options.yes ? `${options.title} DSH 插件` : (await ask('描述（可留空）: '))
  }
  if (!options.port) {
    options.port = options.yes ? DEFAULT_PORT : Number(await ask(`默认端口（${DEFAULT_PORT}）: `) || DEFAULT_PORT)
  }
  if (!options.out) options.out = options.yes ? path.join(HERE, 'my-plugins') : (await ask('输出父目录（默认 ./my-plugins）: ')) || path.join(HERE, 'my-plugins')

  const name = options.name
  const type = options.type
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('--name 必须是 kebab-case（小写字母/数字/连字符）')
  if (!['service', 'ui', 'minimal'].includes(type)) throw new Error('--type 必须是 service/ui/minimal')
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('--port 必须是 1-65535 的整数')

  const slug = slugOf(name)
  const serverName = slug.replace(/[^a-zA-Z0-9_-]/g, '-')
  const toolPrefix = serverName.replace(/-/g, '_')
  const hostId = `${name}-host`
  const suiteName = `${name}-suite`
  const domainName = options.domain || slug
  if (!/^[a-z0-9][a-z0-9-]*$/.test(domainName)) throw new Error('--domain 必须是 kebab-case')

  const rootDir = path.join(path.resolve(options.out), name)
  if (fs.existsSync(rootDir)) throw new Error(`目标已存在: ${rootDir}`)

  const withSuite = !options.pluginOnly && type !== 'minimal'
  if (type === 'minimal' && !options.pluginOnly) {
    console.log('· minimal 类型不生成 suite/domain，按 plugin-only 处理')
  }
  const pluginDir = withSuite ? path.join(rootDir, 'plugin', name) : rootDir
  const suiteDir = path.join(rootDir, 'plugin', suiteName)
  const domainDir = path.join(rootDir, 'domains', domainName)

  const tokens = {
    NAME: name,
    SLUG: slug,
    SLUG_U: slug.replace(/-/g, '_'),
    TITLE: options.title,
    DESCRIPTION: options.description,
    VERSION,
    PORT: String(options.port),
    HOST_ID: hostId,
    SERVER_NAME: serverName,
    TOOL_PREFIX: toolPrefix,
    ENV_PREFIX: `DSH_${slug.toUpperCase().replace(/-/g, '_')}`,
    SUITE_NAME: suiteName,
    DOMAIN_NAME: domainName,
    DOMAIN_PROFILE: `domain-${domainName}`,
  }

  fs.mkdirSync(pluginDir, { recursive: true })
  writeJson(path.join(pluginDir, 'package.json'), makePackageJson({
    name,
    title: options.title,
    description: options.description,
    type,
    version: VERSION,
  }))
  fs.writeFileSync(path.join(pluginDir, 'cordis.patch.yml'), makeCordisPatch({ name, hostId, serverName, port: options.port, type }))

  if (type === 'minimal') {
    fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(pluginDir, 'lib', 'host.mjs'), render(`export const name = '{{HOST_ID}}'

export function apply() {
  console.log('[{{NAME}}] 已加载')
}
`, tokens))
  } else {
    writeTemplate('plugin/lib/host.mjs.tmpl', path.join(pluginDir, 'lib', 'host.mjs'), tokens)
    writeTemplate('plugin/server/relay.mjs.tmpl', path.join(pluginDir, 'server', 'relay.mjs'), tokens)
    writeTemplate('plugin/server/tools.mjs.tmpl', path.join(pluginDir, 'server', 'tools.mjs'), tokens)
    writeTemplate('plugin/server/impl.mjs.tmpl', path.join(pluginDir, 'server', 'impl.mjs'), tokens)
    writeTemplate('plugin/contract/contract.json.tmpl', path.join(pluginDir, 'contract', `${slug}-contract.json`), tokens)
    if (type === 'ui') {
      writeTemplate('plugin/editor/index.html.tmpl', path.join(pluginDir, 'editor', 'index.html'), tokens)
      writeTemplate('plugin/editor/app.js.tmpl', path.join(pluginDir, 'editor', 'app.js'), tokens)
    }
    syncSharedDir(path.join(pluginDir, 'server', 'shared'), { force: true })
  }

  fs.writeFileSync(path.join(pluginDir, 'README.md'), `# ${options.title}

${options.description}

## 开发

\`\`\`bash
npm run validate-plugin -- ${pluginDir.replace(/\\/g, '/')}
\`\`\`

## 安装到 DSH

\`\`\`bash
dsh plugin --profile web add ${pluginDir.replace(/\\/g, '/')}
\`\`\`

${type === 'ui' ? `启动后浏览器打开：http://127.0.0.1:${options.port}/\n` : ''}`)

  if (withSuite) {
    const suite = makeSuiteManifest({
      suiteName,
      name,
      title: options.title,
      description: options.description,
      hostId,
      serverName,
      toolPrefix,
      port: options.port,
    })
    writeJson(path.join(suiteDir, 'package.json'), {
      name: suiteName,
      version: VERSION,
      private: true,
      description: `${options.title} 套件`,
      type: 'module',
      main: './lib/index.mjs',
      exports: {
        '.': './lib/index.mjs',
        './package.json': './package.json',
      },
      dependencies: { [name]: `^${VERSION}` },
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        suite: './dsh-suite.json',
      },
      engines: {
        dsh: '^0.2.0-rc.2',
      },
      files: ['lib/', 'dsh-suite.json', 'cordis.patch.yml', 'README.md', 'package.json'],
      license: 'MIT',
    })
    writeJson(path.join(suiteDir, 'dsh-suite.json'), suite)
    fs.mkdirSync(path.join(suiteDir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(suiteDir, 'cordis.patch.yml'), renderCordisPatch(suite.rows, { header: true }))
    fs.writeFileSync(path.join(suiteDir, 'lib', 'index.mjs'), `export const name = '${suiteName}'\n\nexport function apply() {}\n`)
    fs.writeFileSync(path.join(suiteDir, 'README.md'), `# ${suiteName}\n\n安装：\n\n\`\`\`bash\nnode packages/capyclaw-suite-kit/bin/dsh-suite.mjs install ${suiteDir.replace(/\\/g, '/')} --profile web\n\`\`\`\n`)

    writeJson(path.join(domainDir, 'dsh-domain.json'), {
      name: domainName,
      version: VERSION,
      title: `${options.title} 领域包`,
      description: `只加载 ${options.title} 所需的运行时和工具。`,
      baseBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      components: [`../../plugin/${suiteName}`],
      profile: { name: tokens.DOMAIN_PROFILE, port: 3080 },
      runtime: {
        driver: 'node',
        workId: 'main',
        bindings: [
          {
            row: suite.rows[0].id,
            config: { port: '${ports.content}' },
          },
        ],
        model: {
          id: 'llm-deepseek',
          plugin: '@deepseek-ai/dsh-llm-deepseek-api-key',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          baseUrlEnv: 'DEEPSEEK_BASE_URL',
          baseURL: 'https://api.deepseek.com/anthropic',
        },
        requires: {
          tools: [`${toolPrefix}_*`],
          services: [`${serverName}-service`],
          capabilities: [`${serverName}.runtime`],
        },
        scope: {
          sessions: { path: '.dsh/sessions', isolated: true },
          files: [
            { id: 'workspace', kind: 'workspace', path: 'workspace', patterns: ['**'] },
            { id: 'plugin-content', kind: 'content', path: 'content/plugin', patterns: ['**'] },
          ],
          workspace: { workId: 'main', files: ['**'], allowNew: true },
          network: { bind: ['127.0.0.1'] },
          processes: { killTree: true },
        },
        ports: {
          harness: { preferred: 3080, range: 100 },
          content: { preferred: options.port || 39311, range: 100 },
        },
      },
      removeRows: suite.rows.map((row) => row.id),
    })
  }

  console.log(`\n✓ 已生成: ${rootDir}`)
  console.log(`  plugin: ${pluginDir}`)
  if (withSuite) {
    console.log(`  suite : ${suiteDir}`)
    console.log(`  domain: ${domainDir}`)
  }
  console.log('\n下一步:')
  console.log(`  npm run validate-plugin -- ${pluginDir.replace(/\\/g, '/')}`)
  if (withSuite) {
    console.log(`  node packages/capyclaw-suite-kit/bin/dsh-suite.mjs validate ${suiteDir}`)
    console.log(`  node packages/capyclaw-suite-kit/bin/dsh-domain.mjs validate ${domainDir}`)
  }
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`)
  process.exit(1)
})
