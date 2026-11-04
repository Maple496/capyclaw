/**
 * 只读报告：把清单、实际状态、差异、版本拼成一份可序列化的结果。
 *
 * 版本检查默认只做「已装 vs 清单期望」；「vs npm 最新版」需要注入 versionProbe
 * （默认不注入，保证离线可跑、不偷偷发网络请求）。
 */
import { diffManifest, changesOf } from './diff.mjs'

/** 已装状态快照（two 调用都来自 dsh 原生服务）。 */
export async function readActual({ manager }) {
  const bundles = await manager.listBundles()
  const plugins = await manager.listPlugins()
  return { bundles, plugins }
}

/**
 * @param {object} params
 * @param {{id:string}} params.source
 * @param {object} params.desired
 * @param {{bundles:Array,plugins:Array}} params.actual
 * @param {(ctx:{name:string,installed:string|null})=>Promise<{latest:string|null,error?:string}>} [params.versionProbe]
 */
export async function buildReport({ source, desired, actual, versionProbe }) {
  const diff = diffManifest({ desired, bundles: actual.bundles, plugins: actual.plugins })

  let remote = null
  if (versionProbe) {
    remote = []
    for (const plugin of desired.plugins) {
      const bundle = actual.bundles.find((b) => b.name === plugin.name)
      try {
        const result = await versionProbe({ name: plugin.name, installed: bundle?.version ?? null })
        remote.push({ name: plugin.name, installed: bundle?.version ?? null, latest: result?.latest ?? null, error: result?.error })
      } catch (error) {
        remote.push({ name: plugin.name, installed: bundle?.version ?? null, latest: null, error: error.message })
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    source: { id: source.id, ...(source.file ? { file: source.file } : {}), ...(source.url ? { url: source.url } : {}) },
    desired: {
      version: desired.version,
      plugins: desired.plugins,
      entries: desired.entries,
    },
    actual: {
      bundles: actual.bundles.map((b) => ({
        name: b.name,
        version: b.version ?? null,
        enabled: Boolean(b.enabled),
        installed: Boolean(b.installed),
        error: b.error ?? null,
        rows: (b.rows || []).map((r) => r.entryId),
      })),
      entries: actual.plugins.map((p) => ({
        entryId: p.entryId,
        moduleName: p.moduleName,
        enabled: Boolean(p.enabled),
        fiberPhase: p.fiberPhase ?? null,
        patchId: p.patchId ?? null,
        readOnlyReason: p.readOnlyReason ?? null,
      })),
    },
    diff: {
      ...diff,
      changes: changesOf(diff),
    },
    versions: {
      local: diff.versions,
      remote,
    },
  }
}
