/**
 * bridge 构建公共库：三个 bridge（ppt / canvas / browser）的 build-plugin.mjs
 * 共用的构建驱动（runBridgeBuild）、受检写文件原语、基建供应表（INFRA_KIT_FILES）、
 * skill 包生成、工具契约 markdown、组合锁、suite patch 生成与 workbench host 模板。
 *
 * 分工：本库是唯一的流水线实现；各 bridge 的 scripts/build-plugin.mjs 只保留
 * 差异声明（SKILL_PACKAGES 表、COPIES 表、拼接哪些基建文件、sanity 清单）。
 *
 * 等价性约束：除 host.mjs（两 bridge 历史上有政策/注释漂移，模板统一口径）
 * 外，本库生成的文件内容必须与三 bridge 的历史产物字节级一致——
 * `build-plugin.mjs --check` 的漂移检查通过即为等价性证明。
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSuiteManifest } from '@capyclaw/suite-kit'
import { checkSuiteDrift } from '../check-suite-drift.mjs'
import { syncSharedDir } from './shared-sync.mjs'

// ---------------------------------------------------------------------------
// 受检文件原语（写前比对；--check 模式只报漂移不落盘）
// ---------------------------------------------------------------------------

/** 创建一组绑定 checkOnly 模式的文件原语。 */
export function createCheckedFs(checkOnly) {
  function fail(msg) {
    if (checkOnly) throw new Error('[check] ' + msg)
    throw new Error(msg)
  }

  function writeChecked(file, content, label) {
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : null
    if (prev === content) {
      console.log(`· ${label} 已是最新`)
      return
    }
    if (checkOnly) throw new Error(`[check] ${label} 不是最新，请运行 node scripts/build-plugin.mjs`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
    console.log(`✓ ${label}`)
  }

  function copyChecked(src, dst, label) {
    if (!existsSync(src)) fail('缺少 kit 源文件: ' + src)
    writeChecked(dst, readFileSync(src, 'utf8'), label)
  }

  /** 拍平到 infra 根的 kit 文件：'../tuning.mjs' 需改写为 './tuning.mjs'，
   * 否则会解析到 server/tuning.mjs（relay 调优，键不同）造成静默错配。 */
  function copyFlattened(src, dst, label) {
    if (!existsSync(src)) fail('缺少 kit 源文件: ' + src)
    const content = readFileSync(src, 'utf8').replaceAll("'../tuning.mjs'", "'./tuning.mjs'")
    writeChecked(dst, content, label)
  }

  function listFiles(dir, base = dir) {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...listFiles(full, base))
      else out.push(relative(base, full).split('\\').join('/'))
    }
    return out.sort()
  }

  function syncDir(src, dst, label, ignore = []) {
    if (!existsSync(src)) fail('缺少目录: ' + src)
    const filtered = (files) => files.filter((file) => !ignore.includes(file))
    const want = filtered(listFiles(src))
    const have = existsSync(dst) ? filtered(listFiles(dst)) : null
    const identical = have !== null
      && want.join('\n') === have.join('\n')
      && want.every((rel) => readFileSync(join(src, rel), 'utf8') === readFileSync(join(dst, rel), 'utf8'))
    if (checkOnly) {
      if (have === null || want.join('\n') !== have.join('\n')) {
        throw new Error(`[check] ${label}/ 文件集不是最新，请运行 node scripts/build-plugin.mjs`)
      }
      for (const rel of want) {
        if (readFileSync(join(src, rel), 'utf8') !== readFileSync(join(dst, rel), 'utf8')) {
          throw new Error(`[check] ${label}/${rel} 不是最新，请运行 node scripts/build-plugin.mjs`)
        }
      }
      console.log(`· ${label}/ 已是最新`)
      return
    }
    if (identical) {
      console.log(`· ${label}/ 已是最新`)
      return
    }
    rmSync(dst, { recursive: true, force: true })
    mkdirSync(dst, { recursive: true })
    cpSync(src, dst, { recursive: true })
    console.log(`✓ 拷贝 ${label}/（${want.length} 个文件）`)
  }

  return { fail, writeChecked, copyChecked, copyFlattened, listFiles, syncDir, checkOnly }
}

// ---------------------------------------------------------------------------
// skill 单包生成（两 bridge 的 SKILL_PACKAGES 条目同构）
// ---------------------------------------------------------------------------

export const skillPkgDir = (pluginRoot, entry) => join(pluginRoot, entry.dir)

/** 单 skill provider 的 lib/index.mjs。cfg 见 syncSkillPackage。 */
export function renderSkillProviderIndex(entry, cfg) {
  return [
    `/** ${entry.name}（目录 ${entry.dir}）：单 skill provider。 */`,
    `import { fileURLToPath } from 'node:url'`,
    `import { createSkillProvider } from './provider.mjs'`,
    '',
    `export const name = '${cfg.ns}-skill-${entry.slug}'`,
    `export const inject = ['skills']`,
    `const SKILL = ${JSON.stringify(entry.skill)}`,
    '',
    'function defaultProvider(config = {}) {',
    '  return createSkillProvider({',
    "    assetRoot: config.assetRoot ?? fileURLToPath(new URL('../skills/', import.meta.url)),",
    "    contractRoot: config.contractRoot ?? fileURLToPath(new URL('../contract/', import.meta.url)),",
    `    contractFile: '${cfg.contractFile}',`,
    `    providerName: ${JSON.stringify(cfg.providerPrefix + '-' + entry.slug)},`,
    '    skillDirs: [SKILL],',
    `    contractNote: (version, skillName) => (${cfg.noteSkipExpr}`,
    "      ? ''",
    `      : ${cfg.noteExpr}),`,
    '  })',
    '}',
    '',
    'export function createProvider(config = {}) { return defaultProvider(config) }',
    'export function apply(ctx, config = {}) { ctx.skills.registerProvider(() => defaultProvider(config)) }',
    '',
  ].join('\n')
}

/** 仓库元数据（生成的 skill 包 package.json 尾部的 repository/bugs/homepage）。 */
const REPO_META = {
  git: 'git+https://github.com/Maple496/capyclaw.git',
  bugs: 'https://github.com/Maple496/capyclaw/issues',
  tree: 'https://github.com/Maple496/capyclaw/tree/main',
}

/**
 * 组装一个单 skill provider 包（package.json / cordis.patch.yml / lib / skills / README）。
 *
 * cfg:
 *   nsLabel        'PPT' | 'Canvas'（description/meta 前缀）
 *   ns             'ppt' | 'canvas'（cordis insert id 前缀）
 *   contractFile   'ppt-contract.json' | 'canvas-contract.json'
 *   providerPrefix 'dsh-ppt' | 'dsh-canvas'
 *   noteSkipExpr   contractNote 的豁免表达式（JS 源码串，入参 skillName）
 *   noteExpr       contractNote 文案表达式（JS 源码串，如 '契约：… ' + version + '。…'）
 */
export function syncSkillPackage(entry, { ctx, pluginRoot, kitRoot, root, cfg }) {
  const pkgDir = skillPkgDir(pluginRoot, entry)
  /* 包目录的仓内相对路径（repository.directory / homepage 用） */
  const pkgDirRel = relative(join(root, '..', '..', '..'), pkgDir).split('\\').join('/')
  const pkgJson = JSON.stringify({
    name: entry.name,
    version: entry.version,
    description: `${cfg.nsLabel} skill：${entry.description}`,
    type: 'module',
    main: './lib/index.mjs',
    exports: { '.': './lib/index.mjs', './package.json': './package.json' },
    engines: { node: '>=18', dsh: '^0.2.0-rc.2' },
    publishConfig: { access: 'public' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, category: 'skills', platform: 'both' },
    meta: { title: `${cfg.nsLabel} Skill · ${entry.title}`, description: entry.description },
    files: ['lib/', 'skills/', 'contract/', 'cordis.patch.yml', 'README.md'],
    license: 'MIT',
    dependencies: { '@capyclaw/plugin-kit': '^0.2.0' },
    repository: { type: 'git', url: REPO_META.git, directory: pkgDirRel },
    bugs: { url: REPO_META.bugs },
    homepage: `${REPO_META.tree}/${pkgDirRel}#readme`,
  }, null, 2) + '\n'
  ctx.writeChecked(join(pkgDir, 'package.json'), pkgJson, `${entry.dir}/package.json`)
  ctx.writeChecked(join(pkgDir, 'cordis.patch.yml'), [
    `# ${entry.name}（目录 ${entry.dir}） bundle patch：只注册 ${entry.skill} 一个 skill provider。`,
    '- insert:',
    `    - id: ${cfg.ns}-skill-${entry.slug}`,
    `      name: ${entry.name}`,
    '',
  ].join('\n'), `${entry.dir}/cordis.patch.yml`)
  ctx.writeChecked(join(pkgDir, 'lib', 'index.mjs'), renderSkillProviderIndex(entry, cfg), `${entry.dir}/lib/index.mjs`)
  ctx.copyChecked(join(kitRoot, 'src', 'skills', 'provider.mjs'), join(pkgDir, 'lib', 'provider.mjs'), `${entry.dir}/lib/provider.mjs`)
  ctx.syncDir(join(root, 'src', 'skills', entry.skill), join(pkgDir, 'skills', entry.skill), `${entry.dir}/skills/${entry.skill}`, ['references/tool-contract.md'])
  ctx.writeChecked(join(pkgDir, 'README.md'), `# ${entry.name}\n\n${cfg.nsLabel} skill 单包：\`${entry.skill}\`。只注册一个 skill provider，不启动服务。\n`, `${entry.dir}/README.md`)
}

// ---------------------------------------------------------------------------
// 工具契约 markdown / MCP 拷贝 / 编辑器打包 / 资产
// ---------------------------------------------------------------------------

/** 工具契约参考 markdown（写入 skill 包 references/tool-contract.md）。 */
export function renderToolContractMarkdown(contract, title) {
  const lines = [
    `# ${title} 工具契约`,
    '',
    `- contractVersion: \`${contract.contractVersion}\``,
    `- packageVersion: \`${contract.packageVersion}\``,
    `- toolCount: ${contract.toolCount}`,
    `- features: ${contract.features.map((f) => `\`${f}\``).join(', ')}`,
    '',
    '## 能力',
    '',
    ...contract.capabilities.map((cap) => `- \`${cap.id}\`（${cap.title}）：${cap.tools.map((name) => `\`${name}\``).join(', ')}`),
    '',
    '> 本文件由 scripts/build-plugin.mjs 生成，禁止手改。',
    '',
  ]
  for (const tool of contract.tools) {
    lines.push(`## \`${tool.name}\``, '', `- kind: \`${tool.kind}\``, `- since: \`${tool.since}\``, `- capability: \`${tool.capability || '-'}\``, '', tool.description || '', '')
    if (tool.inputSchema) {
      lines.push('```json', JSON.stringify(tool.inputSchema, null, 2), '```', '')
    }
  }
  return lines.join('\n')
}

/** MCP 源文件逐条拷贝进 workbench（内容一致跳过，漂移即报）。 */
export function copyMcpEntries(copies, { root, workbench, ctx }) {
  for (const [src, dst] of copies) {
    const from = join(root, src), to = join(workbench, dst)
    if (!existsSync(from)) ctx.fail('缺少源: ' + from)
    if (existsSync(to) && readFileSync(to, 'utf8') === readFileSync(from, 'utf8')) {
      console.log(`· ${dst} 已是最新`)
      continue
    }
    if (ctx.checkOnly) throw new Error(`[check] ${dst} 不是最新，请运行 node scripts/build-plugin.mjs`)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to)
    console.log('✓ 拷贝', dst)
  }
}

/** esbuild 打包编辑器（bundle IIFE）→ workbench/editor/app.js。 */
export async function buildEditorApp({ root, workbench, ctx, esbuild }) {
  const out = await esbuild.build({
    entryPoints: [join(root, 'src', 'editor', 'main.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    legalComments: 'none',
    charset: 'utf8',
  })
  const js = out.outputFiles[0].text
  ctx.writeChecked(join(workbench, 'editor', 'app.js'), js,
    'editor/app.js（' + Math.round(js.length / 1024) + 'KB）')
}

/** 纯运行时内核资产整体写入 workbench。 */
export function writeRuntimeAsset({ asset, dest, ctx, missingLabel, writeLabel }) {
  if (!existsSync(asset)) ctx.fail(missingLabel + ': ' + asset)
  const src = readFileSync(asset, 'utf8')
  ctx.writeChecked(dest, src, writeLabel + '（' + Math.round(src.length / 1024) + 'KB）')
}

// ---------------------------------------------------------------------------
// 组合锁与 suite patch
// ---------------------------------------------------------------------------

/** CRLF/LF 归一：lock 哈希必须与 worktree 行尾状态无关（Windows autocrlf 检出、
 *  编辑器改行尾都不应制造假漂移），否则同一内容跨机器会算出不同 sha256。 */
const eolNormalized = (text) => text.replaceAll('\r\n', '\n')

/** 组合锁：记录 suite 实际解析到的包版本与关键 manifest hash。 */
export function writeCompositionLock({ suitePkg, ctx }) {
  const suiteManifest = loadSuiteManifest(suitePkg).manifest
  const packages = {}
  for (const [name, entry] of Object.entries(suiteManifest.packages || {})) {
    if (!entry.path) continue
    const dir = join(suitePkg, entry.path)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const suiteFile = join(dir, 'dsh-suite.json')
    const extra = existsSync(suiteFile) ? readFileSync(suiteFile, 'utf8') : ''
    packages[name] = {
      version: pkg.version,
      apiVersion: pkg.dsh?.apiVersion || null,
      path: entry.path,
      sha256: createHash('sha256').update(
        eolNormalized(readFileSync(join(dir, 'package.json'), 'utf8')) + eolNormalized(extra),
      ).digest('hex'),
    }
  }
  const lock = {
    suite: suiteManifest.name,
    suiteVersion: suiteManifest.version,
    packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))),
  }
  ctx.writeChecked(join(suitePkg, 'composition.lock.json'), JSON.stringify(lock, null, 2) + '\n', `${suiteManifest.name}/composition.lock.json`)
}

/** 校验 dsh-suite.json 并生成 cordis.patch.yml（须先于 sanity：首跑时 patch 由这里产出）。 */
export async function generateSuitePatch({ suitePkg, ctx, suiteKit }) {
  const kit = suiteKit || await import('@capyclaw/suite-kit')
  const loadedSuite = kit.loadSuiteManifest(suitePkg)
  const suiteValidation = kit.validateSuiteManifest(loadedSuite.manifest)
  if (!suiteValidation.ok) ctx.fail('dsh-suite.json 校验失败:\n' + suiteValidation.errors.join('\n'))
  const composedSuite = kit.composeSuites([loadedSuite])
  if (!composedSuite.ok) ctx.fail('dsh-suite.json 组合失败:\n' + composedSuite.errors.join('\n'))
  const expectedSuitePatch = kit.renderCordisPatch(composedSuite.rows)
  const suiteName = loadedSuite.manifest.name
  ctx.writeChecked(join(suitePkg, 'cordis.patch.yml'), expectedSuitePatch, `${suiteName}/cordis.patch.yml（由 manifest 生成）`)
  return loadedSuite.manifest
}

// ---------------------------------------------------------------------------
// 包完整性 sanity
// ---------------------------------------------------------------------------

/** required: [[dir, [files...]], ...]；逐包检查文件存在 + dsh.bundle.patch + main 可达。 */
export function verifyRequiredFiles(required, { pluginRoot, ctx }) {
  for (const [dir, files] of required) {
    for (const file of files) {
      if (!existsSync(join(dir, file))) ctx.fail(`${relative(pluginRoot, dir)} 缺少文件: ${file}`)
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (!manifest.dsh?.bundle?.patch) ctx.fail(`${relative(pluginRoot, dir)} 缺 dsh.bundle.patch`)
    if (!existsSync(join(dir, manifest.main))) ctx.fail(`${relative(pluginRoot, dir)} 的 main 不存在: ${manifest.main}`)
  }
}

/** 逐 skill 包核对：必需文件、name/version 与 SKILL_PACKAGES 表一致、patch 与 main 可达。 */
export function verifySkillPackages(skillPackages, { pluginRoot, ctx, contractFile }) {
  for (const entry of skillPackages) {
    const dir = skillPkgDir(pluginRoot, entry)
    for (const file of ['package.json', 'cordis.patch.yml', 'lib/index.mjs', 'lib/provider.mjs', `skills/${entry.skill}/SKILL.md`, `contract/${contractFile}`]) {
      if (!existsSync(join(dir, file))) ctx.fail(`${entry.dir} 缺少文件: ${file}`)
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (manifest.name !== entry.name) ctx.fail(`${entry.dir} 的 package.json name=${manifest.name} 与预期 ${entry.name} 不一致`)
    if (manifest.version !== entry.version) ctx.fail(`${entry.dir} 的 package.json version=${manifest.version} 与预期 ${entry.version} 不一致`)
    if (!manifest.dsh?.bundle?.patch) ctx.fail(`${entry.dir} 缺 dsh.bundle.patch`)
    if (!existsSync(join(dir, manifest.main))) ctx.fail(`${entry.dir} 的 main 不存在: ${manifest.main}`)
  }
}

// ---------------------------------------------------------------------------
// workbench host.mjs 模板（两 bridge 唯一真源；政策口径统一）
// ---------------------------------------------------------------------------

/**
 * 生成 workbench 的 lib/host.mjs。
 *
 * 政策口径：relay 是独立端口服务（server/relay.mjs 即 standalone 入口），由
 * dsh-service-broker 按套件 services.json 以独立进程拉起；本模块只在被
 * insert 时以同样装配拉起 relay 并返回 disposer（兼容入口，生产路径走 broker）。
 *
 * cfg:
 *   pkgName    '@capyclaw/ppt-workbench' | '@capyclaw/canvas-workbench'
 *   ns         'ppt' | 'canvas'（服务名/日志前缀 <ns>-workbench）
 *   journalFile 'ppt-journal.jsonl' | 'canvas-journal.jsonl'
 *   envHome     'PPT_BRIDGE_HOME' | 'CANVAS_BRIDGE_HOME'
 *   homeDefault '.dsh-ppt-bridge' | '.dsh-canvas-bridge'
 */
export function renderWorkbenchHost(cfg) {
  const tag = `[${cfg.ns}-workbench]`
  return `/**
 * ${cfg.pkgName} 宿主插件（cordis 入口，loader 经包名加载本模块）。
 *
 * 服务解耦标准：relay 是独立端口服务（server/relay.mjs 即 standalone 入口），
 * 由 dsh-service-broker 按清单以独立进程拉起；本模块只在被 insert 时
 * 以同样装配拉起 relay 并返回 disposer（兼容入口，生产路径走 broker）。
 * 零 @deepseek-ai 依赖：只用 node 内置模块，最小化跨版本耦合。
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeContextFromConfig, createRuntimeStoreClient } from '../server/infra/runtime/context.mjs'
import { WorkspaceBackend } from '../server/infra/workspace/manager.mjs'
import { createWorkspaceAssetStore } from '../server/shared/asset-service.mjs'
import { assertServiceApi } from '../server/shared/kit/service/api.mjs'

export const name = '${cfg.ns}-workbench-host'

function safeGet(ctx, serviceName) {
  try { return ctx?.get ? ctx.get(serviceName) : null } catch { return null }
}

function requireApi(service, name) {
  if (service) assertServiceApi(service, { name, major: 1 })
  return service
}

export async function apply(ctx, config) {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const { startRelay, DEFAULT_PORT } = await import('../server/relay.mjs')
  const runtime = runtimeContextFromConfig(config || {})
  const workId = (config && config.workId) || runtime?.workId || 'main'
  /* 进程内若提供 workspace 服务，优先使用它的 scoped client；
   * 没有时保留 runtime context fallback，保证独立运行。 */
  const workspaceService = safeGet(ctx, 'workspace')
  const storeClient = workspaceService?.getWork
    ? workspaceService.getWork(workId)
    : (runtime ? createRuntimeStoreClient(runtime, { workId }) : null)
  const journalPath = runtime ? path.join(runtime.paths.logs, '${cfg.journalFile}') : null
  const backend = storeClient ? new WorkspaceBackend({ client: storeClient, workId, journalPath }) : null
  const hostDir = (config && config.hostDir)
    || runtime?.paths?.contentState
    || process.env.${cfg.envHome}
    || path.join(os.homedir(), '${cfg.homeDefault}')
  /* 公共插件 API 契约：存在则校验 major，避免静默不兼容。 */
  const serviceHost = requireApi(safeGet(ctx, 'serviceHost'), 'serviceHost')
  const toolHost = requireApi(safeGet(ctx, 'toolHost'), 'toolHost')
  const editorHost = requireApi(safeGet(ctx, 'editorHost'), 'editorHost')
  /* 图片等二进制资源只进对象仓库；文档里只保存 /assets/<sha256> 引用。 */
  const assetService = requireApi(safeGet(ctx, 'assets'), 'assets')
  const assetStore = storeClient
    ? (assetService?.createStore
        ? assetService.createStore({ storeClient, workId })
        : createWorkspaceAssetStore({ storeClient, workId }))
    : (assetService?.createFileStore
        ? assetService.createFileStore({ dir: path.join(hostDir, 'assets') })
        : null)
  const port = (config && Number(config.port))
    || runtime?.ports?.content
    || DEFAULT_PORT
  const relay = await startRelay({
    packageDir,
    port,
    hostDir,
    strictPort: config?.strictPort != null ? !!config.strictPort : !!runtime,
    allowReuse: config?.allowReuse != null ? !!config.allowReuse : !runtime,
    lockFile: (config && config.lockFile) || path.join(hostDir, '.relay-instance.lock'),
    backend,
    assetStore,
    assetService,
    workId,
    capabilities: config?.capabilities || null,
    serviceHost,
    toolHost,
    editorHost,
  })
  const line = relay.reused
    ? '${tag} 复用已运行的桥: \${relay.url}'
    : '${tag} 桥已就绪: \${relay.url}'
  console.log(line)
  console.log(\`${tag} 编辑器: \${relay.editorUrl} （浏览器打开即用）\`)
  if (runtime) console.log(\`${tag} runtime=\${runtime.runtimeId} work=\${workId} namespace=\${runtime.store?.namespace || ''}\`)
  if (relay.reused) console.log('${tag} 注意：实际端口可能不是配置端口，/mcp 以当前 runtime 的 profile 注入为准')
  return async () => {
    await relay.stop()
    console.log('${tag} 桥已停止')
  }
}
`
}

// ---------------------------------------------------------------------------
// 基建供应表：构建期拼接进 workbench 的 plugin-kit 运行时文件（唯一登记处）
// ---------------------------------------------------------------------------

/**
 * plugin-kit 源 → workbench 目标。只登记「构建时拼接进产物」的运行时文件；
 * packages 级公共插件（service-host 等）走 server/shared 快照
 * （scripts/sync-shared.mjs 的 PUBLIC_SHARED），不在此表。
 *
 * flatten：拍平到目标目录后需改写 `'../tuning.mjs'` → `'./tuning.mjs'`
 * （否则会解析到 server/tuning.mjs，relay 调优键不同，造成静默错配）。
 *
 * 新增拼接文件：在 sources 里加一行，再在对应 bridge 的 kitInfra 里选键；
 * 不要在各 build-plugin.mjs 里直接写 copyChecked/copyFlattened 调用。
 */
export const INFRA_KIT_FILES = {
  http: { src: 'service/http.mjs', dst: 'server/infra/http.mjs', flatten: true },
  tuning: { src: 'tuning.mjs', dst: 'server/infra/tuning.mjs' },
  fsLock: { src: 'util/fs-lock.mjs', dst: 'server/infra/util/fs-lock.mjs' },
  blobStore: { src: 'store/blob-store.mjs', dst: 'server/infra/store/blob-store.mjs' },
  workspace: { src: 'workspace/manager.mjs', dst: 'server/infra/workspace/manager.mjs' },
  runtimeContext: { src: 'runtime/context.mjs', dst: 'server/infra/runtime/context.mjs' },
  heartbeatWorker: { src: 'editor/heartbeat-worker.js', dst: 'editor/heartbeat-worker.js' },
}

// ---------------------------------------------------------------------------
// 构建驱动：一套流水线，各 bridge 只提供差异配置
// ---------------------------------------------------------------------------

/**
 * 跑完整插件构建（步骤 0~7，与历史三份 build-plugin.mjs 逐步对齐）。
 *
 * config（各 bridge 的差异声明）：
 *   ns / nsLabel / contractFile / contractTitle / contractCapabilitiesSource /
 *   providerPrefix / noteSkipExpr / noteExpr
 *                                  skill 包生成参数与契约形态（原 SKILL_CFG）
 *   workbenchDir / suiteDir        plugin/ 下的两个目录名
 *   host                           renderWorkbenchHost 参数；null = 手写 host.mjs
 *   skillPackages                  SKILL_PACKAGES 表（行格式被 scripts/bump.mjs 解析）
 *   copies                         [源, workbench 目标] 的 MCP 源拷贝表
 *   kitInfra                       INFRA_KIT_FILES 的键（拼接哪些基建文件）
 *   syncCoreDir                    bridge 有 src/core 镜像时 true
 *   legacyDirs                     需清理的废弃产物目录（--check 时报错）
 *   editor                         { assetEnv, assetPath, dest, missingLabel, writeLabel } | null
 *   toolContractSkills             生成 references/tool-contract.md 的 skill 名
 *   required                       [[dir, [files...]], ...] 包完整性清单
 */
export async function runBridgeBuild({ root, config, checkOnly = false }) {
  const {
    workbenchDir, suiteDir, nsLabel, contractFile, providerPrefix,
    noteSkipExpr, noteExpr, host = null, skillPackages, copies = [],
    kitInfra = [], syncCoreDir = false, legacyDirs = [], editor = null,
    toolContractSkills = [], required = [],
  } = config

  const PLUGIN_ROOT = join(root, 'plugin')
  const KIT_ROOT = join(root, '..', '..', '..', 'packages', 'capyclaw-plugin-kit')
  const WORKBENCH = join(PLUGIN_ROOT, workbenchDir)
  const SUITE_PKG = join(PLUGIN_ROOT, suiteDir)
  const ctx = createCheckedFs(checkOnly)
  const skillCfg = { ns: config.ns, nsLabel, contractFile, providerPrefix, noteSkipExpr, noteExpr }

  /* 0. 公共插件快照（必须在 import tools.mjs 之前生成） */
  {
    const drift = checkSuiteDrift({ quiet: true })
    if (!drift.ok) ctx.fail('suite 元数据漂移:\n- ' + drift.issues.join('\n- '))
  }
  syncSharedDir(join(root, 'src', 'mcp', 'shared'), { force: !checkOnly, check: checkOnly })
  syncSharedDir(join(WORKBENCH, 'server', 'shared'), { force: !checkOnly, check: checkOnly })

  /* 1. 生成工具契约快照（唯一真源：capabilities → registry → tools.mjs）。
   * ppt 侧历史上导出名为 CAPABILITY_LIST（同一数组的别名），统一取 CAPABILITIES。 */
  const toolModule = await import(pathToFileURL(join(root, 'src', 'mcp', 'tools.mjs')).href)
  const { TOOLS, TOOL_META, FEATURES } = toolModule
  const rawCapabilities = toolModule.CAPABILITIES
  const contractCapabilities = config.contractCapabilitiesSource === 'registry'
    ? toolModule.CAPABILITY_LIST
    : rawCapabilities
  if (!Array.isArray(rawCapabilities) || !Array.isArray(contractCapabilities)) {
    throw new Error('tools.mjs 未导出所需的能力清单')
  }
  const { CONTRACT_VERSION, PACKAGE_VERSION } = await import(pathToFileURL(join(root, 'src', 'mcp', 'contract.mjs')).href)

  const toolNames = TOOLS.map((tool) => tool.name).sort()
  const metaNames = Object.keys(TOOL_META).sort()
  if (toolNames.join('\n') !== metaNames.join('\n')) {
    throw new Error('registry 的 TOOL_META 与 TOOLS 不一致：\n' +
      `tools: ${toolNames.join(', ')}\nmeta:  ${metaNames.join(', ')}`)
  }
  const contract = {
    contractVersion: CONTRACT_VERSION,
    packageVersion: PACKAGE_VERSION,
    toolCount: TOOLS.length,
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      kind: TOOL_META[tool.name].kind,
      since: TOOL_META[tool.name].since,
      capability: TOOL_META[tool.name].capability,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    features: FEATURES,
    capabilities: contractCapabilities,
  }
  const contractJson = JSON.stringify(contract, null, 2) + '\n'
  const contractTargets = [
    [join(root, 'contract'), `contract/${contractFile}`],
    [join(WORKBENCH, 'contract'), `${workbenchDir}/contract/${contractFile}`],
    [join(SUITE_PKG, 'contract'), `${suiteDir}/contract/${contractFile}`],
  ]
  for (const entry of skillPackages) {
    contractTargets.push([join(skillPkgDir(PLUGIN_ROOT, entry), 'contract'), `${entry.dir}/contract/${contractFile}`])
  }
  for (const [dir, label] of contractTargets) {
    ctx.writeChecked(join(dir, contractFile), contractJson, label)
  }

  /* 1.5 生成 capabilities.json 元数据（用于组件库） */
  {
    const capabilitiesMetadata = {
      version: 1,
      source: 'server/tools/capabilities',
      capabilities: rawCapabilities.map((cap) => ({
        id: cap.id,
        version: PACKAGE_VERSION,
        title: cap.title || cap.id,
        description: cap.description || '',
        tags: cap.tags || [],
        keywords: [],
        entry: {
          module: `./capabilities/${cap.id}.mjs`,
          export: `${cap.id}Capability`,
        },
        provides: {
          tools: cap.tools.map((t) => t.name),
          features: cap.features || [],
        },
        requires: cap.requires || [],
        dependsOn: cap.dependsOn || [],
      })),
    }
    ctx.writeChecked(join(WORKBENCH, 'capabilities.json'), JSON.stringify(capabilitiesMetadata, null, 2) + '\n', `${workbenchDir}/capabilities.json`)
  }

  /* 2. host.mjs：模板生成（有 host 配置）或保留手写（browser） */
  if (host) {
    ctx.writeChecked(join(WORKBENCH, 'lib', 'host.mjs'), renderWorkbenchHost(host), `${workbenchDir}/lib/host.mjs`)
  }

  /* 3. MCP 拷贝 + core 镜像 + 基建拼接（INFRA_KIT_FILES） */
  copyMcpEntries(copies, { root, workbench: WORKBENCH, ctx })
  ctx.syncDir(join(root, 'src', 'mcp', 'tools'), join(WORKBENCH, 'server', 'tools'), 'server/tools')
  if (syncCoreDir) ctx.syncDir(join(root, 'src', 'core'), join(WORKBENCH, 'core'), 'core')
  for (const dir of legacyDirs) {
    const target = join(WORKBENCH, dir)
    if (checkOnly) {
      if (existsSync(target)) throw new Error(`[check] ${dir} 已废弃，请运行 node scripts/build-plugin.mjs 清理`)
    } else {
      rmSync(target, { recursive: true, force: true })
    }
  }
  for (const key of kitInfra) {
    const entry = INFRA_KIT_FILES[key]
    if (!entry) throw new Error(`未知的基建拼接键: ${key}（见 INFRA_KIT_FILES）`)
    const from = join(KIT_ROOT, 'src', entry.src)
    const to = join(WORKBENCH, entry.dst)
    if (entry.flatten) ctx.copyFlattened(from, to, entry.dst)
    else ctx.copyChecked(from, to, entry.dst)
  }

  /* 4. 编辑器打包 + 运行时资产（纯运行时；无编辑器的 bridge 跳过） */
  if (editor) {
    const require = createRequire(import.meta.url)
    await buildEditorApp({ root, workbench: WORKBENCH, ctx, esbuild: require('esbuild') })
    writeRuntimeAsset({
      asset: editor.assetPath,
      dest: join(WORKBENCH, editor.dest),
      ctx,
      missingLabel: editor.missingLabel,
      writeLabel: editor.dest,
    })
  }

  /* 5. 技能源 → 单 skill 包 + 生成工具契约参考 */
  for (const entry of skillPackages) {
    syncSkillPackage(entry, { ctx, pluginRoot: PLUGIN_ROOT, kitRoot: KIT_ROOT, root, cfg: skillCfg })
    if (toolContractSkills.includes(entry.skill)) {
      ctx.writeChecked(
        join(skillPkgDir(PLUGIN_ROOT, entry), 'skills', entry.skill, 'references', 'tool-contract.md'),
        renderToolContractMarkdown(contract, config.contractTitle),
        `${entry.dir}/skills/${entry.skill}/references/tool-contract.md`,
      )
    }
  }
  {
    const { lintSkills } = await import(pathToFileURL(join(root, 'scripts', 'lint-skills.mjs')).href)
    const lint = lintSkills()
    if (!lint.ok) ctx.fail('skill lint 未通过:\n' + lint.errors.join('\n'))
    for (const warning of lint.warnings) console.log(`! ${warning}`)
  }

  /* 6. 组合锁 + suite patch 生成（patch 须先于 sanity：首跑时由这里产出） */
  writeCompositionLock({ suitePkg: SUITE_PKG, ctx })
  await generateSuitePatch({ suitePkg: SUITE_PKG, ctx })

  /* 7. 所有包的完整性 sanity */
  verifyRequiredFiles(required, { pluginRoot: PLUGIN_ROOT, ctx })
  verifySkillPackages(skillPackages, { pluginRoot: PLUGIN_ROOT, ctx, contractFile })
  const workbenchManifest = JSON.parse(readFileSync(join(WORKBENCH, 'package.json'), 'utf8'))
  if (workbenchManifest.version !== PACKAGE_VERSION) {
    ctx.fail(`contract.mjs 的 PACKAGE_VERSION=${PACKAGE_VERSION} 与 workbench package.json=${workbenchManifest.version} 不一致`)
  }
  const suiteManifest = JSON.parse(readFileSync(join(SUITE_PKG, 'package.json'), 'utf8'))
  /* suite 的 dependencies 引用 npm 发布名（@capyclaw/*） */
  for (const dep of [workbenchManifest.name, ...skillPackages.map((entry) => entry.name)]) {
    if (!suiteManifest.dependencies?.[dep]) ctx.fail(`${suiteManifest.name} 缺少依赖: ${dep}`)
  }
  if (suiteManifest.dsh?.suite !== './dsh-suite.json') ctx.fail(`${suiteManifest.name} 未声明 dsh.suite`)
  loadSuiteManifest(SUITE_PKG) // 走一遍加载路径（校验/组合/渲染已在 generateSuitePatch 完成）

  console.log(checkOnly
    ? '✓ 所有包全部最新（check 通过）'
    : `✓ 构建完成：${TOOLS.length} 个工具 / ${skillPackages.length + 2} 个包 → ${PLUGIN_ROOT}`)
}
