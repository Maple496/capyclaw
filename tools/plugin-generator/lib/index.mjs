/**
 * DSH 插件生成器核心
 * 自动生成符合规范的插件骨架
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, '../../..')

/**
 * 生成插件
 */
export async function generatePlugin(pluginName, options = {}) {
  const {
    tier = 0,
    category = 'ui',
    platform = 'web',
    output = null
  } = options
  
  // 验证插件名
  if (!/^[a-z0-9-]+$/.test(pluginName)) {
    throw new Error('插件名只能包含小写字母、数字和连字符')
  }
  
  const fullName = `dsh-${pluginName}`
  
  // 确定输出目录
  let pluginDir
  if (output) {
    pluginDir = resolve(process.cwd(), output, fullName)
  } else {
    const baseDir = tier === 'suite' ? 'extensions/suites' : 'extensions/official'
    pluginDir = join(rootDir, baseDir, fullName)
  }
  
  // 检查是否已存在
  if (existsSync(pluginDir)) {
    throw new Error(`插件目录已存在: ${pluginDir}`)
  }
  
  // 创建目录结构
  mkdirSync(pluginDir, { recursive: true })
  mkdirSync(join(pluginDir, 'lib'), { recursive: true })
  
  // 生成 package.json
  const packageJson = generatePackageJson(fullName, tier, category, platform)
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify(packageJson, null, 2))
  
  // 生成主入口
  const mainEntry = generateMainEntry(fullName, tier)
  writeFileSync(join(pluginDir, 'lib/index.mjs'), mainEntry)

  // 生成 README
  const readme = generateReadme(fullName, category, platform)
  writeFileSync(join(pluginDir, 'README.md'), readme)
  
  // 如果需要客户端代码，创建 client/
  if (category === 'ui' || tier >= 1) {
    mkdirSync(join(pluginDir, 'client'), { recursive: true })
    const clientCode = generateClientCode(fullName)
    writeFileSync(join(pluginDir, 'client/client.js'), clientCode)
  }
  
  // 生成 cordis.patch.yml
  const cordisPatch = generateCordisPatch(fullName, category)
  writeFileSync(join(pluginDir, 'cordis.patch.yml'), cordisPatch)
  
  return { path: pluginDir, name: fullName }
}

/**
 * 生成 package.json
 */
function generatePackageJson(name, tier, category, platform) {
  const pkg = {
    name,
    version: '1.0.0',
    description: `DSH ${category} 插件`,
    type: 'module',
    main: './lib/index.mjs',
    exports: {
      '.': './lib/index.mjs',
      './package.json': './package.json'
    },
    dependencies: {},
    dsh: {
      bundle: {
        patch: './cordis.patch.yml'
      },
      category,
      platform
    },
    engines: {
      dsh: '^0.2.0-rc.2'
    },
    meta: {
      title: name.replace('dsh-', '').split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
      description: `${category} 插件，支持 ${platform} 平台`
    },
    files: [
      'lib/',
      'cordis.patch.yml',
      'README.md'
    ],
    private: true
  }
  
  // 根据层级添加依赖
  if (tier === 'suite') {
    pkg.dependencies['dsh-suite-kit'] = '^0.1.0'
    pkg.dsh.suite = './dsh-suite.json'
  } else {
    pkg.dependencies['dsh-plugin-kit'] = '^0.2.0'
    
    if (tier >= 1) {
      pkg.dependencies['dsh-service-host'] = '^0.1.0'
    }
    
    if (tier >= 2) {
      pkg.dependencies['dsh-tool-host'] = '^0.1.0'
      pkg.dependencies['dsh-asset-service'] = '^0.1.0'
    }
  }
  
  // 如果有客户端代码，添加到 exports 和 files
  if (category === 'ui' || tier >= 1) {
    pkg.exports['./client'] = './client/client.js'
    pkg.dsh.client = {
      platform,
      immediately: true
    }
    pkg.files.push('client/')
  }
  
  return pkg
}

/**
 * 生成主入口代码
 */
function generateMainEntry(name, tier) {
  if (tier === 'suite') {
    return `/**
 * ${name} - DSH 插件套件
 */

export const name = '${name}'

export function apply(ctx) {
  ctx.logger.info('${name} 套件已加载')
}
`
  }
  
  return `/**
 * ${name} - DSH 插件主入口
 */

export const name = '${name}'

export function apply(ctx, config) {
  ctx.logger.info('${name} 插件已加载', config)
  
  // TODO: 实现插件功能
}
`
}

/**
 * 生成 README
 */
function generateReadme(name, category, platform) {
  return `# ${name}

DSH ${category} 插件

## 功能

TODO: 描述插件功能

## 安装

\`\`\`bash
# 在 DSH profile 中安装
npm install ${name}
\`\`\`

## 配置

\`\`\`yaml
# cordis.patch.yml
- id: ${name}
  name: ${name}
  config:
    # TODO: 配置项
\`\`\`

## 开发

\`\`\`bash
npm run validate-plugin -- <插件目录>
\`\`\`

## 平台支持

- ${platform}

## License

MIT
`
}

/**
 * 生成客户端代码
 */
function generateClientCode(name) {
  return `/**
 * ${name} - 客户端代码
 * 在浏览器环境中运行
 */

;(function() {
  'use strict'
  
  console.log('[${name}] 客户端代码已加载')
  
  // TODO: 实现客户端功能
})()
`
}

/**
 * 生成 cordis.patch.yml
 */
function generateCordisPatch(name, category) {
  return `# ${name} Cordis 配置

- id: ${name}
  name: ${name}
  config:
    # TODO: 添加配置项
`
}
