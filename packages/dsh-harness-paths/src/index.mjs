/**
 * dsh 宿主目录定位 —— 唯一实现。
 *
 * 此前 dsh-launcher/config.mjs、dsh-suite-kit/runtime.mjs、scripts/lib/bundle-builder.mjs
 * 各持一份副本，靠注释约定「保持同一候选顺序」，已实际漂移（一处漏 path.resolve
 * 造成子进程内相对路径二次拼接）。契约收敛到本模块后，三处消费方只 import。
 *
 * 解析顺序（部署方显式指定优先于一切布局猜测）：
 *   1. 环境变量 DSH_HARNESS_DIR（相对路径按**调用方 cwd** 绝对化——绝不把相对路径
 *      传给子进程，子进程会按自己的 cwd 二次拼接）
 *   2. 兄弟目录 ../dsh-runtime/apps/harness/deepseek-harness（文档化布局）
 *   3. 历史布局（core-harness / 仓库内 apps / out_of_scope），仅在存在时命中
 * 都不存在时返回空串，由调用方的配置校验报出明确错误。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包所在目录 = packages/dsh-harness-paths/src。 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 仓库根 = src 上三级（src → dsh-harness-paths → packages → 仓库根）。 */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..')

/** 按 auth-proxy.mjs 的真实存在性识别宿主，避免把「看起来像」的目录当真。 */
export const HARNESS_SENTINEL = 'auth-proxy.mjs'

export function harnessCandidates(repoRoot = REPO_ROOT) {
  return [
    path.join(repoRoot, '..', 'dsh-runtime', 'apps', 'harness', 'deepseek-harness'),
    // 历史布局（宿主曾在仓库内 / 曾叫 core-harness / out_of_scope）
    path.join(repoRoot, 'core-harness', 'deepseek-harness'),
    path.join(repoRoot, 'apps', 'harness', 'deepseek-harness'),
    path.join(repoRoot, '..', 'deepseekharness_out_of_scope', 'deploy', 'apps', 'harness', 'deepseek-harness'),
  ]
}

/**
 * 解析 dsh 宿主目录。
 * @param {{ env?: string, repoRoot?: string }} [options] env 缺省读 process.env.DSH_HARNESS_DIR。
 * @returns {string} 绝对路径；找不到返回 ''（调用方负责明确报错）。
 */
export function resolveHarnessDir(options = {}) {
  const env = String(options.env ?? process.env.DSH_HARNESS_DIR ?? '').trim()
  if (env) return path.resolve(env) // 必须绝对化：见文件头注释
  const repoRoot = options.repoRoot ?? REPO_ROOT
  return harnessCandidates(repoRoot)
    .find((candidate) => existsSync(path.join(candidate, HARNESS_SENTINEL))) || ''
}
