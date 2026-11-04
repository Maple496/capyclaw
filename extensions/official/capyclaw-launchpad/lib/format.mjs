/**
 * CLI 人读输出。JSON 输出由调用方直接 JSON.stringify，不经过这里。
 */

const STATE_LABEL = {
  running: '运行中',
  stopped: '已停止',
  error: '错误',
  stale: '僵死',
  unknown: '未知',
}

function line(...parts) {
  return parts.join(' ')
}

function stateLabel(state) {
  return STATE_LABEL[state] || state || '未知'
}

function portsText(ports) {
  const entries = Object.entries(ports || {})
  if (!entries.length) return ''
  return entries.map(([name, port]) => `${name}=${port}`).join(', ')
}

function specShort(hash) {
  return hash ? hash.slice(0, 8) : ''
}

function manifestHeader(manifest) {
  return `[${manifest.id}] ${manifest.relativePath}`
}

function issuesBlock(issues, options = {}) {
  const list = issues || []
  const limit = options.limit ?? 80
  const errors = list.filter((issue) => issue.severity === 'error')
  const warnings = list.filter((issue) => issue.severity !== 'error')
  if (!list.length) return '问题：无\n'
  const out = []
  out.push(`问题（${errors.length} errors / ${warnings.length} warnings）`)
  for (const issue of list.slice(0, limit)) {
    const mark = issue.severity === 'error' ? '✗' : '!'
    out.push(`  ${mark} [${issue.code || issue.severity}] ${issue.message}`)
    if (issue.path) out.push(`       at ${issue.path}`)
  }
  if (list.length > limit) out.push(`  … 还有 ${list.length - limit} 条问题，用 --json 查看全部`)
  return `${out.join('\n')}\n`
}

function stackSection(inventory) {
  const manifests = inventory.manifests.filter((manifest) => manifest.type === 'stack')
  if (!manifests.length) return ''
  const out = [`Stack 清单（${manifests.length}）`]
  for (const manifest of manifests) {
    const stack = manifest.stack || {}
    const issues = manifest.issues || []
    const profileDrift = issues.some((issue) => issue.code === 'stack-profile-drift'
      || issue.code === 'stack-profile-missing')
    const manifestDrift = issues.some((issue) => issue.code === 'stack-manifest-missing'
      || issue.code === 'stack-manifest-drift'
      || issue.code === 'stack-service-port-drift')
    out.push(`  ${manifestHeader(manifest)}  ${stack.name || manifest.title}`)
    out.push(`    profile: ${stack.profile || '?'} @ ${stack.home || '?'}`)
    out.push(`    bundles: ${(stack.bundles || []).join(', ') || '(none)'}`)
    out.push(`    services: ${(stack.services || []).map((service) => service.id).join(', ') || '(none)'}`)
    if (stack.profilePackage) out.push(`    profile pkg: ${stack.profilePackage} ${profileDrift ? '⚠ 漂移/缺失' : '✓'}`)
    if (stack.manifest) out.push(`    generated:   ${stack.manifest} ${manifestDrift ? '⚠ 未生成/漂移' : '✓'}`)
  }
  return `${out.join('\n')}\n`
}

function brokerSection(inventory) {
  const manifests = inventory.manifests.filter((manifest) => manifest.type === 'broker')
  if (!manifests.length) return ''
  const out = [`Broker 清单（${manifests.length}）`]
  for (const manifest of manifests) {
    out.push(`  ${manifestHeader(manifest)}  (${manifest.services.length} services)`)
    for (const service of manifest.services) {
      const fixed = (service.fixedPorts || []).map((item) => `${item.name}=${item.port}`).join(', ')
      const auto = Object.entries(service.ports || {})
        .filter(([, value]) => value === 'auto')
        .map(([name]) => `${name}=auto`)
        .join(', ')
      const portText = [fixed, auto].filter(Boolean).join(', ')
      const flags = [
        service.requires?.length ? `requires=${service.requires.join(',')}` : '',
        `spec=${specShort(service.specHash)}`,
      ].filter(Boolean).join('  ')
      out.push(`    - ${service.serviceId}${portText ? `  ${portText}` : ''}${service.spec?.url ? `  ${service.spec.url}` : ''}  ${flags}`)
    }
  }
  return `${out.join('\n')}\n`
}

function worksSection(inventory) {
  const manifests = inventory.manifests.filter((manifest) => manifest.type === 'works')
  if (!manifests.length) return ''
  const out = [`部署清单（${manifests.length}）`]
  for (const manifest of manifests) {
    out.push(`  ${manifestHeader(manifest)}  ${manifest.title}`)
    const deployment = manifest.works?.deployment
    if (deployment) {
      const source = deployment.source || ''
      const mark = !deployment.sourceExists ? '✗ 不存在' : deployment.domainPath ? '✓ domain' : '! 非 domain'
      out.push(`    source: ${source}  ${mark}`)
      if (deployment.domainId) out.push(`    domain: [${deployment.domainId}] ${deployment.domainRelativePath || ''}`)
    }
    const ports = portsText(Object.fromEntries((manifest.works?.declaredPorts || []).map((item) => [item.name, item.port])))
    if (ports) out.push(`    ports: ${ports}`)
  }
  return `${out.join('\n')}\n`
}

function domainSection(inventory) {
  const manifests = inventory.manifests.filter((manifest) => manifest.type === 'domain')
  if (!manifests.length) return ''
  const out = [`领域清单（${manifests.length}）`]
  for (const manifest of manifests) {
    const domain = manifest.domain || {}
    out.push(`  ${manifestHeader(manifest)}  ${domain.name || '?'}@${domain.version || '?'}`)
    out.push(`    组件: ${(domain.components || []).length} 个；行引用: ${(domain.rowRefs || []).length}；缺失行: ${(domain.missingRows || []).length}`)
    const ports = portsText(Object.fromEntries((domain.declaredPorts || []).map((item) => [item.name, item.port])))
    if (ports) out.push(`    ports: ${ports}`)
  }
  return `${out.join('\n')}\n`
}

function launcherSection(inventory) {
  const manifests = inventory.manifests.filter((manifest) => manifest.type === 'launcher')
  if (!manifests.length) return ''
  const out = [`启动器配置（${manifests.length}）`]
  for (const manifest of manifests) {
    const entry = manifest.launcher || {}
    out.push(`  ${manifestHeader(manifest)}  ${manifest.title}`)
    if (entry.resolved?.manifest) {
      const link = entry.activeManifestId ? `  → [${entry.activeManifestId}]` : '  （未在扫描结果中匹配到清单）'
      out.push(`    manifest: ${entry.resolved.manifest}${link}`)
    }
    if (entry.resolved?.dshHome) out.push(`    dshHome: ${entry.resolved.dshHome}`)
    const state = entry.state
    if (state?.broker || state?.dsh) {
      const broker = state.broker ? `broker pid=${state.broker.pid ?? '-'}` : 'broker -'
      const dsh = state.dsh ? `dsh pid=${state.dsh.pid ?? '-'}` : 'dsh -'
      out.push(`    state: ${broker}；${dsh}`)
    }
  }
  return `${out.join('\n')}\n`
}

function profileSection(inventory) {
  const manifests = inventory.manifests.filter((manifest) => manifest.type === 'profile')
  if (!manifests.length) return ''
  const out = [`Profile 激活清单（${manifests.length}）`]
  for (const manifest of manifests) {
    const profile = manifest.profile || {}
    out.push(`  ${manifestHeader(manifest)}  ${profile.name || manifest.title}`)
    if (profile.bundles?.length) out.push(`    bundles: ${profile.bundles.join(', ')}`)
    if (profile.suites?.length) out.push(`    suites: ${profile.suites.join(', ')}`)
  }
  return `${out.join('\n')}\n`
}

export function formatScan(inventory) {
  const summary = inventory.summary
  const out = []
  out.push('启动清单盘点')
  out.push(`根：${(inventory.roots || []).join(', ') || '（无）'}（${summary.scan?.rootsSource || 'auto'}）`)
  out.push(`扫描：${summary.scan?.filesScanned ?? 0} 个候选文件；${summary.manifests} 份清单；${summary.services} 条服务`)
  out.push(`汇总：stack ${summary.stacks} / broker ${summary.brokerManifests} / 部署 ${summary.deployments} / 领域 ${summary.domains} / 启动器 ${summary.launchers} / profile ${summary.profiles}`)
  out.push('')
  for (const section of [
    stackSection(inventory),
    brokerSection(inventory),
    worksSection(inventory),
    domainSection(inventory),
    launcherSection(inventory),
    profileSection(inventory),
  ]) {
    if (section) out.push(section)
  }
  out.push(issuesBlock(inventory.issues))
  return out.join('\n')
}

export function formatValidate(inventory) {
  const summary = inventory.summary
  const ok = summary.errors === 0
  const out = []
  out.push(`校验结果：${ok ? 'PASS' : 'FAIL'}（${summary.errors} errors / ${summary.warnings} warnings）`)
  out.push(`清单：${summary.manifests} 份；服务：${summary.services} 条`)
  out.push('')
  out.push(issuesBlock(inventory.issues))
  return out.join('\n')
}

export function formatStatus(status) {
  const summary = status.summary
  const out = []
  out.push('运行态')
  out.push(`discovery: ${status.discovery.file || '（未找到）'}（${status.discovery.source}）`)
  if (status.discovery.updatedAt) out.push(`  updatedAt: ${status.discovery.updatedAt}`)
  if (status.discovery.error) out.push(`  ✗ ${status.discovery.error}`)
  out.push(status.broker.url
    ? `broker: ${status.broker.url}  ${status.broker.reachable ? '可达' : `不可达（${status.broker.error || '未知错误'}）`}`
    : 'broker: 未配置（启停不可用）')
  out.push('')
  out.push(`服务（${status.services.length}）`)
  for (const service of status.services) {
    const health = service.healthy === null ? '' : `  healthy=${service.healthy}`
    const pid = service.pid == null ? '' : `  pid=${service.pid}`
    out.push(`  - ${service.serviceId}  ${stateLabel(service.state)}${pid}${health}  ${service.url || ''}`)
    out.push(`    manifest: ${service.manifestRelativePath}`)
  }
  if (!status.services.length) out.push('  （无）')
  out.push('')
  if (status.launchers.length) {
    out.push(`启动器（${status.launchers.length}）`)
    for (const launcher of status.launchers) {
      const runtime = launcher.runtime
      if (!runtime) {
        out.push(`  - ${launcher.title}  （无 state.json${launcher.stateError ? `: ${launcher.stateError}` : ''}）`)
        continue
      }
      const broker = runtime.broker
        ? `broker pid=${runtime.broker.pid} alive=${runtime.broker.pidAlive}`
        : 'broker -'
      const dsh = runtime.dsh
        ? `dsh pid=${runtime.dsh.pid} alive=${runtime.dsh.pidAlive}`
        : 'dsh -'
      out.push(`  - ${launcher.title}  ${broker}；${dsh}`)
    }
    out.push('')
  }
  out.push(`汇总：running ${summary.running} / stopped ${summary.stopped} / error ${summary.error} / stale ${summary.stale} / unknown ${summary.unknown}`)
  return `${out.join('\n')}\n`
}

export function formatDoctor(doctor) {
  const out = []
  out.push(`体检：${doctor.ok ? 'OK' : 'FAIL'}`)
  for (const check of doctor.checks) {
    const mark = check.ok ? '✓' : (check.required ? '✗' : '!')
    const tag = check.required ? 'required' : 'optional'
    out.push(`  ${mark} [${tag}] ${check.name}: ${check.detail}`)
  }
  out.push('')
  out.push(`启停可用：${doctor.actionsAvailable ? '是' : '否'}`)
  out.push(`必检失败：${doctor.summary.failedRequired}；可选项失败：${doctor.summary.failedOptional}`)
  return `${out.join('\n')}\n`
}

export function formatActionResult(result, action) {
  const out = []
  const ok = result.ok !== false
  out.push(`${ok ? '✓' : '✗'} ${action}${result.dryRun ? '（dry-run，未发送）' : ''}`)
  if (result.brokerUrl) out.push(`broker: ${result.brokerUrl}`)
  if (result.service) out.push(`service: ${result.service.serviceId}  manifest=${result.service.manifestRelativePath}`)
  if (result.manifest) out.push(`manifest: ${result.manifest.relativePath}  services=${result.manifest.services}`)
  if (result.command || result.commands) {
    out.push('请求：')
    out.push(JSON.stringify(result.command || { commands: result.commands }, null, 2))
  }
  if (result.request) out.push(`请求：${JSON.stringify(result.request)}`)
  if (result.broker) {
    out.push(`broker 响应：http=${result.broker.httpStatus ?? '?'} ok=${result.broker.ok ?? '?'}`)
    out.push(JSON.stringify(result.broker, null, 2))
  }
  return `${out.join('\n')}\n`
}
