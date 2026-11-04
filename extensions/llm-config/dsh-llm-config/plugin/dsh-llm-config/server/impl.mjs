/** LLM Config Manager 业务实现。工具层只做 schema/分派，业务放这里。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(HERE, '..', 'data', 'llm-configs.json')

// 确保数据目录存在
function ensureDataDir() {
  const dataDir = path.dirname(CONFIG_FILE)
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
}

// 加载所有配置
function loadConfigs() {
  ensureDataDir()
  if (!fs.existsSync(CONFIG_FILE)) {
    return {}
  }
  try {
    const content = fs.readFileSync(CONFIG_FILE, 'utf8')
    return JSON.parse(content)
  } catch (err) {
    console.error('Failed to load configs:', err)
    return {}
  }
}

// 保存配置
function saveConfigs(configs) {
  ensureDataDir()
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2), 'utf8')
}

export function echo({ text }) {
  return `echo: ${String(text)}`
}

export function capabilities() {
  return {
    name: 'dsh-llm-config',
    version: '1.0.0',
    contractVersion: '1.0.0',
    capabilities: [
      'add_llm_config - 添加或更新 LLM 配置',
      'get_llm_config - 获取指定的 LLM 配置',
      'list_llm_configs - 列出所有 LLM 配置',
      'delete_llm_config - 删除 LLM 配置',
      'test_llm_connection - 测试 LLM 连接',
    ],
  }
}

/**
 * 添加或更新 LLM 配置
 */
export function addLlmConfig({ id, name, provider, model, url, apiKey, options }) {
  const configs = loadConfigs()
  
  const config = {
    id: id || `llm_${Date.now()}`,
    name: name || model,
    provider: provider || 'openai',
    model,
    url,
    apiKey,
    options: options || {},
    createdAt: configs[id]?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  
  configs[config.id] = config
  saveConfigs(configs)
  
  return {
    success: true,
    message: `LLM 配置 "${config.name}" 已保存`,
    config: {
      id: config.id,
      name: config.name,
      provider: config.provider,
      model: config.model,
      url: config.url,
      hasApiKey: !!config.apiKey,
    },
  }
}

/**
 * 获取 LLM 配置
 */
export function getLlmConfig({ id }) {
  const configs = loadConfigs()
  const config = configs[id]
  
  if (!config) {
    return {
      success: false,
      message: `未找到 ID 为 "${id}" 的 LLM 配置`,
    }
  }
  
  return {
    success: true,
    config: {
      id: config.id,
      name: config.name,
      provider: config.provider,
      model: config.model,
      url: config.url,
      apiKey: config.apiKey,
      options: config.options,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    },
  }
}

/**
 * 列出所有 LLM 配置
 */
export function listLlmConfigs({ includeApiKey = false }) {
  const configs = loadConfigs()
  const configList = Object.values(configs).map(config => ({
    id: config.id,
    name: config.name,
    provider: config.provider,
    model: config.model,
    url: config.url,
    hasApiKey: !!config.apiKey,
    ...(includeApiKey ? { apiKey: config.apiKey } : {}),
    options: config.options,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  }))
  
  return {
    success: true,
    count: configList.length,
    configs: configList,
  }
}

/**
 * 删除 LLM 配置
 */
export function deleteLlmConfig({ id }) {
  const configs = loadConfigs()
  
  if (!configs[id]) {
    return {
      success: false,
      message: `未找到 ID 为 "${id}" 的 LLM 配置`,
    }
  }
  
  const deletedName = configs[id].name
  delete configs[id]
  saveConfigs(configs)
  
  return {
    success: true,
    message: `LLM 配置 "${deletedName}" 已删除`,
  }
}

/**
 * 测试 LLM 连接（基础验证）
 */
export async function testLlmConnection({ id }) {
  const configs = loadConfigs()
  const config = configs[id]
  
  if (!config) {
    return {
      success: false,
      message: `未找到 ID 为 "${id}" 的 LLM 配置`,
    }
  }
  
  // 基础验证
  const issues = []
  
  if (!config.url) {
    issues.push('缺少 URL')
  }
  
  if (!config.apiKey) {
    issues.push('缺少 API Key')
  }
  
  if (!config.model) {
    issues.push('缺少模型名称')
  }
  
  if (issues.length > 0) {
    return {
      success: false,
      message: `配置验证失败: ${issues.join(', ')}`,
      config: {
        id: config.id,
        name: config.name,
      },
    }
  }
  
  // 可以添加实际的 HTTP 请求来测试连接
  // 这里暂时只做配置验证
  return {
    success: true,
    message: `配置 "${config.name}" 验证通过`,
    config: {
      id: config.id,
      name: config.name,
      provider: config.provider,
      model: config.model,
      url: config.url,
    },
  }
}
