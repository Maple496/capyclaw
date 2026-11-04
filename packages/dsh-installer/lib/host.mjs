/** dsh-installer：把 domain/suite 的解析、stage、install 暴露成 ctx.installer。 */
import { installDomain, resolveDomain, stageDomain } from '../../dsh-suite-kit/src/domain.mjs'

export const name = 'installer'

export function apply(ctx, config = {}) {
  const service = {
    api: {
      name: 'installer',
      version: '1.0.0',
      capabilities: ['resolve', 'stage', 'install'],
    },
    resolve(domainInput) {
      const resolved = resolveDomain(domainInput)
      return {
        domain: resolved.manifest.name,
        components: resolved.suites.map((suite) => suite.manifest.name),
        rows: resolved.composed.rows,
        checks: resolved.composed.checks,
        warnings: resolved.composed.warnings,
      }
    },
    stage(domainInput, outDir) {
      return stageDomain({ domainInput, outDir })
    },
    install(domainInput, options = {}) {
      return installDomain({ domainInput, ...options })
    },
  }
  const dispose = ctx.provide('installer', service)
  console.log('[installer] ready')
  return () => { if (typeof dispose === 'function') dispose() }
}
