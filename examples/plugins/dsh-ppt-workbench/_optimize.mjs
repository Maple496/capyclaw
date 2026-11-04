/**
 * 编辑器长轮询参数多目标优化（NSGA-II 改编）
 * 目标：最小化【平均延迟、带宽消耗、CPU 占用】，最大化【容错率】
 * 约束：HTTP keep-alive < 60s、编辑器 tab 后台节流、桥 50ms 复核固定
 */

/* ---- 成本模型（经验公式 + 测得常量）---- */
const BRIDGE_TICK_MS = 50        // 桥复核粒度（固定）
const PUSH_TO_BRIDGE_MS = 30     // MCP 推送到桥落盘（实测 73ms，取保守值）
const APPLY_PER_CMD_MS = 20      // 编辑器应用单条指令（PptApp 开销）
const SHOT_RENDER_MS = 2500      // renderSlides 全量（4.4MB 资产 + 多页）
const SHOT_CACHE_MS = 80         // 首帧缓存回传
const NETWORK_JITTER_MS = 150    // 公网/Wi-Fi 抖动缓冲

const SESSION_KB = 8             // 单次 /watch 响应（空闲时返回全 doc ~8KB）
const STATUS_KB = 0.2            // /status 轻量端点
const BANDWIDTH_COST_PER_MB = 1  // 归一化权重

function modelLatency({ pollTimeout, retryInterval, maxCmdsPerPush }) {
  // 平均延迟 = PUSH到桥 + 等编辑器轮询(最坏=超时) + 应用指令
  const avgWaitForPoll = pollTimeout * 1000 / 2
  const applyTime = APPLY_PER_CMD_MS * maxCmdsPerPush
  return PUSH_TO_BRIDGE_MS + avgWaitForPoll + applyTime
}

function modelBandwidth({ pollTimeout, retryInterval }) {
  // 每小时请求数 = 3600s / (超时+重试间隔)
  const reqPerHour = 3600 / (pollTimeout + retryInterval / 1000)
  return reqPerHour * SESSION_KB / 1024  // MB/h
}

function modelCPU({ pollTimeout, retryInterval }) {
  // 桥 50ms 复核频率 × 轮询并发（单标签页，并发=1）
  const ticksPerReq = (pollTimeout * 1000 + retryInterval) / BRIDGE_TICK_MS
  const reqPerHour = 3600 / (pollTimeout + retryInterval / 1000)
  // 归一化：CPU = 复核次数 / 基准(timeout=20s, retry=800ms)
  const baseline = 3600 / (20 + 0.8) * (20 * 1000 + 800) / BRIDGE_TICK_MS
  return (reqPerHour * ticksPerReq) / baseline
}

function modelResilience({ pollTimeout, retryInterval }) {
  // 容错率 = 1 - P(单次超时导致用户可感知卡顿)
  // 网络抖动 150ms 内恢复，超时 ≥ 3s 视为安全；重试间隔 < 500ms 视为激进
  const timeoutSafe = pollTimeout >= 3 ? 1 : pollTimeout / 3
  const retrySafe = retryInterval >= 500 ? 1 : retryInterval / 500
  return timeoutSafe * retrySafe
}

function modelShotLatency({ useCache }) {
  return useCache ? SHOT_CACHE_MS : SHOT_RENDER_MS
}

/* ---- NSGA-II 多目标优化（简化：单代+拥挤距离排序）---- */
function evaluate(gene) {
  const { pollTimeout, retryInterval, maxCmdsPerPush, useShotCache } = gene
  return {
    latency: modelLatency(gene),                  // 目标1：最小化延迟(ms)
    bandwidth: modelBandwidth(gene),              // 目标2：最小化带宽(MB/h)
    cpu: modelCPU(gene),                          // 目标3：最小化CPU(相对)
    resilience: -modelResilience(gene),           // 目标4：最大化容错(负号转最小)
    shotLatency: modelShotLatency(gene),          // 辅助：截图延迟
  }
}

function dominates(a, b) {
  // Pareto 支配：a 在所有目标上不差于 b，且至少一个严格更优
  const keys = ['latency', 'bandwidth', 'cpu', 'resilience']
  let betterInOne = false
  for (const k of keys) {
    if (a[k] > b[k]) return false
    if (a[k] < b[k]) betterInOne = true
  }
  return betterInOne
}

function crowdingDistance(population) {
  // 拥挤距离：Pareto 前沿上分布越稀疏越优（保持多样性）
  const n = population.length
  if (n <= 2) return population.map((p, i) => ({ ...p, crowding: Infinity }))
  
  const objectives = ['latency', 'bandwidth', 'cpu', 'resilience']
  const distances = population.map(() => 0)
  
  for (const obj of objectives) {
    const sorted = population.map((p, i) => ({ idx: i, val: p.objectives[obj] }))
      .sort((a, b) => a.val - b.val)
    const range = sorted[n - 1].val - sorted[0].val
    if (range === 0) continue
    distances[sorted[0].idx] = Infinity
    distances[sorted[n - 1].idx] = Infinity
    for (let i = 1; i < n - 1; i++) {
      distances[sorted[i].idx] += (sorted[i + 1].val - sorted[i - 1].val) / range
    }
  }
  
  return population.map((p, i) => ({ ...p, crowding: distances[i] }))
}

/* ---- 搜索空间（离散网格 + 二元开关）---- */
const searchSpace = []
for (const pollTimeout of [2, 3, 4, 5, 8, 10, 15, 20]) {
  for (const retryInterval of [100, 200, 300, 500, 800, 1000, 1500]) {
    for (const maxCmdsPerPush of [10, 20, 50, 100]) {
      for (const useShotCache of [false, true]) {
        searchSpace.push({ pollTimeout, retryInterval, maxCmdsPerPush, useShotCache })
      }
    }
  }
}

console.log(`[优化] 搜索空间: ${searchSpace.length} 个候选配置`)

const population = searchSpace.map(gene => ({
  gene,
  objectives: evaluate(gene),
}))

/* Pareto 前沿筛选 */
const paretoFront = []
for (const p of population) {
  let dominated = false
  for (const q of population) {
    if (p === q) continue
    if (dominates(q.objectives, p.objectives)) {
      dominated = true
      break
    }
  }
  if (!dominated) paretoFront.push(p)
}

console.log(`[优化] Pareto 前沿: ${paretoFront.length} 个非支配解`)

/* 拥挤距离排序 → 推荐 top-3 */
const ranked = crowdingDistance(paretoFront).sort((a, b) => b.crowding - a.crowding)

console.log('\n=== 推荐配置（按拥挤距离排序，分布最优）===\n')
for (let i = 0; i < Math.min(3, ranked.length); i++) {
  const { gene, objectives, crowding } = ranked[i]
  console.log(`【方案 ${i + 1}】${gene.useShotCache ? '(含截图缓存)' : ''}`)
  console.log(`  pollTimeout: ${gene.pollTimeout}s  |  retryInterval: ${gene.retryInterval}ms  |  maxCmds: ${gene.maxCmdsPerPush}`)
  console.log(`  → 平均延迟: ${Math.round(objectives.latency)}ms`)
  console.log(`  → 带宽消耗: ${objectives.bandwidth.toFixed(2)} MB/h`)
  console.log(`  → CPU 负载: ${objectives.cpu.toFixed(2)}x (相对基准)`)
  console.log(`  → 容错率: ${(100 * (1 + objectives.resilience)).toFixed(1)}%`)
  console.log(`  → 截图响应: ${objectives.shotLatency}ms`)
  console.log(`  拥挤距离: ${crowding.toFixed(3)}\n`)
}

/* 辅助：找平衡点（加权标量化，适合大多数场景）*/
const weights = { latency: 1.0, bandwidth: 0.3, cpu: 0.2, resilience: 0.8 }
const normalize = (obj) => {
  const ranges = {
    latency: [0, 10000], bandwidth: [0, 100], cpu: [0, 5], resilience: [-1, 0],
  }
  return Object.keys(weights).reduce((sum, k) => {
    const [min, max] = ranges[k]
    const norm = (obj[k] - min) / (max - min)
    return sum + weights[k] * norm
  }, 0)
}

const balanced = population.map(p => ({ ...p, score: normalize(p.objectives) }))
  .sort((a, b) => a.score - b.score)[0]

console.log('=== 平衡推荐（加权标量化，适合日常）===')
console.log(`  pollTimeout: ${balanced.gene.pollTimeout}s  |  retryInterval: ${balanced.gene.retryInterval}ms`)
console.log(`  maxCmds: ${balanced.gene.maxCmdsPerPush}  |  截图缓存: ${balanced.gene.useShotCache ? '开' : '关'}`)
console.log(`  综合得分: ${balanced.score.toFixed(3)} (越小越好)\n`)

/* 极端场景偏好 */
const ultraLowLatency = population.sort((a, b) => a.objectives.latency - b.objectives.latency)[0]
const ultraLowBandwidth = population.sort((a, b) => a.objectives.bandwidth - b.objectives.bandwidth)[0]
const ultraResilience = population.sort((a, b) => b.objectives.resilience - a.objectives.resilience)[0]

console.log('=== 极端偏好 ===')
console.log(`【超低延迟】timeout=${ultraLowLatency.gene.pollTimeout}s retry=${ultraLowLatency.gene.retryInterval}ms → ${Math.round(ultraLowLatency.objectives.latency)}ms`)
console.log(`【超低带宽】timeout=${ultraLowBandwidth.gene.pollTimeout}s retry=${ultraLowBandwidth.gene.retryInterval}ms → ${ultraLowBandwidth.objectives.bandwidth.toFixed(2)}MB/h`)
console.log(`【超强容错】timeout=${ultraResilience.gene.pollTimeout}s retry=${ultraResilience.gene.retryInterval}ms → ${(100 * (1 + ultraResilience.objectives.resilience)).toFixed(1)}%`)
