/**
 * DSH 插件验证器核心
 * 强制检查插件是否符合规范
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import semver from 'semver'

/**
 * 验证规则定义
 */
const RULES = {
  // 必需文件
  REQUIRED_FILES: ['package.json', 'README.md', 'lib'],
  
  // 包名规则：dsh-<name> / @org/dsh-<name>，或已发布作用域 @capyclaw/<name>
  PACKAGE_NAME_PATTERN: /^((@[\w.-]+\/)?dsh-[\w.-]+|@capyclaw\/[\w.-]+)$/,
  
  // 必需的 package.json 字段
  REQUIRED_PKG_FIELDS: ['name', 'version', 'description', 'type', 'main', 'dsh', 'meta'],
  
  // 必需的 dsh 字段
  REQUIRED_DSH_FIELDS: ['category', 'platform'],
  
  // 有效的插件分类
  VALID_CATEGORIES: ['ui', 'service', 'bridge', 'tool', 'suite', 'skills'],
  
  // 有效的平台
  VALID_PLATFORMS: ['web', 'desktop', 'both'],
  
  // 基础设施包的锁定版本范围（npm scope 名；dsh-suite-kit 尚未迁移）
  INFRASTRUCTURE_VERSIONS: {
    '@capyclaw/plugin-kit': '^0.2.0',
    '@capyclaw/service-host': '^0.1.0',
    '@capyclaw/tool-host': '^0.1.0',
    '@capyclaw/asset-service': '^0.1.0',
    'dsh-suite-kit': '^0.1.0'
  }
}

/**
 * 验证插件
 * @param {string} pluginPath - 插件目录的绝对路径
 * @returns {Promise<{valid: boolean, errors: Array, warnings: Array}>}
 */
export async function validatePlugin(pluginPath) {
  const errors = []
  const warnings = []
  
  // 1. 检查目录存在
  if (!existsSync(pluginPath)) {
    return {
      valid: false,
      errors: [{ rule: 'PATH', message: `插件目录不存在: ${pluginPath}` }],
      warnings: []
    }
  }
  
  if (!statSync(pluginPath).isDirectory()) {
    return {
      valid: false,
      errors: [{ rule: 'PATH', message: `路径不是目录: ${pluginPath}` }],
      warnings: []
    }
  }
  
  // 2. 加载 package.json（必需文件检查需要区分 suite-only 组合包）
  let pkg
  try {
    const pkgPath = join(pluginPath, 'package.json')
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  } catch (error) {
    checkRequiredFiles(pluginPath, null, errors)
    if (!errors.some(e => e.rule === 'REQUIRED_FILES')) {
      errors.push({
        rule: 'PACKAGE_JSON',
        message: `package.json 格式错误: ${error.message}`
      })
    }
    return { valid: false, errors, warnings }
  }

  // 3. 检查必需文件
  checkRequiredFiles(pluginPath, pkg, errors)

  // 4. 验证 package.json 内容
  checkPackageJson(pkg, errors, warnings)
  
  // 5. 验证目录结构
  checkDirectoryStructure(pluginPath, pkg, errors, warnings)
  
  // 6. 验证依赖
  checkDependencies(pkg, errors, warnings)
  
  return {
    valid: errors.length === 0,
    errors,
    warnings
  }
}

/**
 * 检查必需文件
 */
function checkRequiredFiles(pluginPath, pkg, errors) {
  const suiteOnly = pkg?.dsh?.suite && !pkg?.main
  for (const file of RULES.REQUIRED_FILES) {
    // suite 组合包（dsh.suite 且无代码入口）没有 lib/ 目录
    if (file === 'lib' && suiteOnly) continue
    const filePath = join(pluginPath, file)
    if (!existsSync(filePath)) {
      errors.push({
        rule: 'REQUIRED_FILES',
        message: `缺少必需文件: ${file}`,
        hint: file === 'lib' ? '创建 lib/ 目录并放入主入口文件' : `创建 ${file} 文件`
      })
    }
  }
}

/**
 * 验证 package.json
 */
function checkPackageJson(pkg, errors, warnings) {
  // 检查必需字段
  for (const field of RULES.REQUIRED_PKG_FIELDS) {
    // suite 组合包（dsh.suite 且无代码入口）没有 main 字段
    if (field === 'main' && pkg.dsh?.suite && !pkg.main) continue
    if (!pkg[field]) {
      errors.push({
        rule: 'PACKAGE_FIELDS',
        message: `package.json 缺少必需字段: ${field}`,
        hint: `在 package.json 中添加 "${field}" 字段`
      })
    }
  }
  
  // 检查包名规范
  if (pkg.name && !RULES.PACKAGE_NAME_PATTERN.test(pkg.name)) {
    errors.push({
      rule: 'PACKAGE_NAME',
      message: `包名不符合规范: ${pkg.name}`,
      hint: '包名必须形如 "dsh-<name>"、"@org/dsh-<name>"，或已发布作用域 "@capyclaw/<name>"'
    })
  }
  
  // 检查版本号格式
  if (pkg.version && !semver.valid(pkg.version)) {
    errors.push({
      rule: 'VERSION',
      message: `版本号格式错误: ${pkg.version}`,
      hint: '使用语义化版本，如 "1.0.0"'
    })
  }
  
  // 检查 type 字段
  if (pkg.type !== 'module') {
    errors.push({
      rule: 'MODULE_TYPE',
      message: `必须使用 ESM 模块: type="${pkg.type || 'commonjs'}"`,
      hint: '在 package.json 中设置 "type": "module"'
    })
  }
  
  // 检查 dsh 字段
  if (pkg.dsh) {
    for (const field of RULES.REQUIRED_DSH_FIELDS) {
      if (!pkg.dsh[field]) {
        errors.push({
          rule: 'DSH_FIELDS',
          message: `dsh 配置缺少必需字段: ${field}`,
          hint: `在 package.json 的 dsh 对象中添加 "${field}" 字段`
        })
      }
    }
    
    // 检查分类有效性
    if (pkg.dsh.category && !RULES.VALID_CATEGORIES.includes(pkg.dsh.category)) {
      errors.push({
        rule: 'DSH_CATEGORY',
        message: `无效的插件分类: ${pkg.dsh.category}`,
        hint: `category 必须是: ${RULES.VALID_CATEGORIES.join(', ')}`
      })
    }
    
    // 检查平台有效性
    if (pkg.dsh.platform && !RULES.VALID_PLATFORMS.includes(pkg.dsh.platform)) {
      errors.push({
        rule: 'DSH_PLATFORM',
        message: `无效的平台: ${pkg.dsh.platform}`,
        hint: `platform 必须是: ${RULES.VALID_PLATFORMS.join(', ')}`
      })
    }
  }
  
  // 检查 meta 字段
  if (pkg.meta) {
    if (!pkg.meta.title) {
      errors.push({
        rule: 'META_TITLE',
        message: 'meta.title 必需（用户可见的插件标题）',
        hint: '在 package.json 的 meta 对象中添加 "title" 字段'
      })
    }
    if (!pkg.meta.description) {
      warnings.push('meta.description 建议提供（用户可见的详细描述）')
    }
  }
}

/**
 * 检查目录结构
 */
function checkDirectoryStructure(pluginPath, pkg, errors, warnings) {
  // 检查 lib/ 目录内容
  const libPath = join(pluginPath, 'lib')
  if (existsSync(libPath)) {
    const libFiles = readdirSync(libPath)
    if (libFiles.length === 0) {
      errors.push({
        rule: 'LIB_EMPTY',
        message: 'lib/ 目录为空',
        hint: '在 lib/ 中添加主入口文件（如 index.mjs）'
      })
    }
    
    // 检查 main 字段指向的文件是否存在
    if (pkg.main) {
      const mainPath = join(pluginPath, pkg.main)
      if (!existsSync(mainPath)) {
        errors.push({
          rule: 'MAIN_NOT_FOUND',
          message: `main 字段指向的文件不存在: ${pkg.main}`,
          hint: '确保 main 字段指向的文件存在'
        })
      }
    }
  }
  
  // 检查 README.md 内容
  const readmePath = join(pluginPath, 'README.md')
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf-8')
    if (readme.trim().length < 100) {
      warnings.push('README.md 内容过少，建议补充使用说明')
    }
  }
}

/**
 * 检查依赖
 */
function checkDependencies(pkg, errors, warnings) {
  const deps = pkg.dependencies || {}
  
  // 强制：必须依赖 @capyclaw/plugin-kit（除非是 suite）
  if (pkg.dsh?.category !== 'suite') {
    if (!deps['@capyclaw/plugin-kit']) {
      errors.push({
        rule: 'PLUGIN_KIT_REQUIRED',
        message: '必须依赖 @capyclaw/plugin-kit',
        hint: '在 dependencies 中添加 "@capyclaw/plugin-kit": "^0.2.0"'
      })
    } else {
      // 检查版本范围
      const expectedVersion = RULES.INFRASTRUCTURE_VERSIONS['@capyclaw/plugin-kit']
      if (!semver.satisfies(semver.coerce(deps['@capyclaw/plugin-kit']), expectedVersion)) {
        warnings.push(`@capyclaw/plugin-kit 版本建议使用 ${expectedVersion}，当前: ${deps['@capyclaw/plugin-kit']}`)
      }
    }
  }
  
  // 检查其他基础设施包的版本
  for (const [pkgName, expectedVersion] of Object.entries(RULES.INFRASTRUCTURE_VERSIONS)) {
    if (deps[pkgName]) {
      const actualVersion = deps[pkgName]
      if (!semver.intersects(actualVersion, expectedVersion)) {
        warnings.push(`${pkgName} 版本不匹配，建议: ${expectedVersion}，当前: ${actualVersion}`)
      }
    }
  }
}

/**
 * 批量验证多个插件
 */
export async function validatePlugins(pluginPaths) {
  const results = []
  for (const path of pluginPaths) {
    const result = await validatePlugin(path)
    results.push({ path, ...result })
  }
  return results
}
