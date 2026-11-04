/**
 * 清单来源（ManifestSource）。
 *
 * 接口：
 *   { id: string, describe(): Promise<Manifest> }
 *
 * 本轮实现 `local`（读本地 JSON 文件）；`http` 保留接口与清晰报错，
 * 将来「通过链接外部数据确定启动清单」就在这里接。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { normalizeManifest, ManifestError } from '../manifest.mjs'

/** 本地 JSON 清单。 */
export function createLocalSource({ file, cwd = process.cwd() } = {}) {
  if (!file) throw new ManifestError('local 源缺少 file')
  const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file)
  return {
    id: 'local',
    file: abs,
    async describe() {
      if (!existsSync(abs)) {
        throw new ManifestError(`清单文件不存在: ${abs}`)
      }
      let raw
      try {
        raw = JSON.parse(await readFile(abs, 'utf8'))
      } catch (error) {
        throw new ManifestError(`清单解析失败 (${abs}): ${error.message}`)
      }
      return normalizeManifest(raw)
    },
  }
}

/**
 * HTTP 清单源（预留）。
 *
 * 契约（实现时按此对接）：
 *   GET <url>  → 200 + application/json，body 即 manifest 结构（见 lib/manifest.mjs）
 *   需要鉴权时用 Authorization: Bearer <token>（token 从 env 读，不落清单）
 *   超时、重试、缓存策略由实现方决定；解析后必须过 normalizeManifest 校验
 */
export function createHttpSource({ url, tokenEnv = 'DSH_SYNC_TOKEN' } = {}) {
  if (!url) throw new ManifestError('http 源缺少 url')
  return {
    id: 'http',
    url,
    async describe() {
      const error = new Error(
        `http 清单源尚未实现（${url}）。契约：GET 返回 manifest JSON，见 lib/sources/index.mjs 注释。`
        + ` 鉴权使用环境变量 ${tokenEnv}。`,
      )
      error.code = 'NOT_IMPLEMENTED'
      throw error
    },
  }
}

/**
 * @param {{kind?:string, file?:string, url?:string, cwd?:string, tokenEnv?:string}} options
 */
export function createSource(options = {}) {
  const kind = String(options.kind || (options.url ? 'http' : 'local')).toLowerCase()
  if (kind === 'local') return createLocalSource({ file: options.file, cwd: options.cwd })
  if (kind === 'http') return createHttpSource({ url: options.url, tokenEnv: options.tokenEnv })
  throw new ManifestError(`未知的清单源类型: ${kind}（支持 local / http）`)
}
