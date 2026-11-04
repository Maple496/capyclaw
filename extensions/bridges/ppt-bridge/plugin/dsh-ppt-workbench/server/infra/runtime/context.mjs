/**
 * Runtime context：插件启动时读取本次 DSH runtime 的端口、目录、namespace。
 *
 * 优先级：
 *   1. 显式 runtimeFile / config.runtimeFile
 *   2. DSH_RUNTIME_FILE
 *   3. DSH_RUNTIME_ID + DSH_STORE_ROOT + DSH_STORE_TOKEN 环境变量
 *
 * 插件不应再读全局插件目录或写死端口；所有持久化内容都走
 * WorkspaceClient，确保只作用于当前 runtime 的 namespace。
 */
import fs from 'node:fs'
import path from 'node:path'
import { WorkspaceManager, WorkspaceClient } from '../workspace/manager.mjs'

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

export function runtimeFileFromEnv(env = process.env) {
  return env.DSH_RUNTIME_FILE || ''
}

export function loadRuntimeContext({ runtimeFile, env = process.env } = {}) {
  const file = runtimeFile || runtimeFileFromEnv(env)
  if (file && fs.existsSync(file)) {
    const runtime = readJson(file, null)
    if (!runtime) throw new Error(`runtime 文件损坏: ${file}`)
    return normalizeRuntime(runtime, { runtimeFile: path.resolve(file), env })
  }
  if (env.DSH_RUNTIME_ID && env.DSH_STORE_ROOT) {
    return normalizeRuntime({
      runtimeId: env.DSH_RUNTIME_ID,
      storeRoot: env.DSH_STORE_ROOT,
      ports: {
        harness: Number(env.DSH_PROXY_PORT) || 0,
        dsh: Number(env.DSH_UP_PORT) || 0,
        content: Number(env.DSH_CONTENT_PORT) || 0,
      },
      paths: {
        root: env.DSH_RUNTIME_ROOT || '',
        dshHome: env.DSH_HOME || '',
        workspace: env.DSH_WORKSPACE || '',
        logs: env.DSH_LOG_DIR || '',
        tmp: env.DSH_TMP_DIR || '',
        contentState: env.DSH_CONTENT_STATE || '',
      },
      store: {
        root: env.DSH_STORE_ROOT,
        namespace: env.DSH_STORE_NAMESPACE || env.DSH_RUNTIME_ID,
        token: env.DSH_STORE_TOKEN || '',
      },
      workId: env.DSH_WORK_ID || 'main',
      profile: env.DSH_PROFILE || '',
      domain: env.DSH_DOMAIN || '',
    }, { runtimeFile: null, env })
  }
  return null
}

function normalizeRuntime(runtime, { runtimeFile = null, env = process.env } = {}) {
  const store = runtime.store || {}
  const paths = runtime.paths || {}
  const ports = runtime.ports || {}
  return {
    ...runtime,
    runtimeFile,
    runtimeId: runtime.runtimeId || env.DSH_RUNTIME_ID || '',
    storeRoot: runtime.storeRoot || store.root || env.DSH_STORE_ROOT || '',
    store: {
      root: store.root || runtime.storeRoot || env.DSH_STORE_ROOT || '',
      namespace: store.namespace || runtime.runtimeId || env.DSH_RUNTIME_ID || '',
      token: store.token || env.DSH_STORE_TOKEN || '',
    },
    ports: {
      harness: Number(ports.harness) || Number(env.DSH_PROXY_PORT) || 0,
      dsh: Number(ports.dsh) || Number(env.DSH_UP_PORT) || 0,
      content: Number(ports.content) || Number(env.DSH_CONTENT_PORT) || 0,
      ...ports,
    },
    paths: {
      root: paths.root || '',
      dshHome: paths.dshHome || env.DSH_HOME || '',
      workspace: paths.workspace || env.DSH_WORKSPACE || '',
      logs: paths.logs || env.DSH_LOG_DIR || '',
      tmp: paths.tmp || env.DSH_TMP_DIR || '',
      contentState: paths.contentState || env.DSH_CONTENT_STATE || '',
      ...paths,
    },
    workId: runtime.workId || env.DSH_WORK_ID || 'main',
  }
}

export function runtimeContextFromConfig(config = {}, options = {}) {
  if (config && config.runtimeContext && typeof config.runtimeContext === 'object') {
    return normalizeRuntime(config.runtimeContext, options)
  }
  if (config && config.runtimeFile) return loadRuntimeContext({ ...options, runtimeFile: config.runtimeFile })
  return loadRuntimeContext(options)
}

export function createRuntimeStoreClient(context, { workId } = {}) {
  if (!context || !context.store || !context.store.root || !context.store.token) {
    return null
  }
  const store = new WorkspaceManager({ storeRoot: context.store.root })
  return new WorkspaceClient({
    manager: store,
    runtimeId: context.store.namespace || context.runtimeId,
    token: context.store.token,
    workId: workId || context.workId || 'main',
  })
}

export function runtimePaths(context) {
  return (context && context.paths) || {}
}

export function isPathInside(root, target) {
  if (!root || !target) return false
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function assertPathInside(root, target, label = 'path') {
  if (!isPathInside(root, target)) throw new Error(`${label} 越出 runtime 根目录: ${target}`)
  return path.resolve(target)
}
