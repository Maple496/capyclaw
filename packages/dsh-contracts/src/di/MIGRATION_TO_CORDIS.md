# DIContainer → Cordis 迁移指南（实测校正版）

> 更新：2026-11-04
> 本文件所有 Cordis API 均已在本仓 `@deepseek-ai/cordis@4.0.5` 上实测验证，
> 数据来自 `tests/performance/real-benchmark.mjs`。

---

## ⚠️ 先纠正三个常见的错误认知

| 错误说法 | 实测事实 |
|---|---|
| "Cordis 比 DIContainer 快 10x" | **反了**。纯访问路径 DIContainer ≈ 100.9M ops/s，Cordis ≈ 146K ops/s，DIContainer 快约 693x |
| "插件里用 `ctx.myService = {...}` 注册服务" | **无效**。Cordis v4 会抛 `cannot set property "xxx" without provide`，必须 `ctx.provide(name, value)` |
| "`ctx.dispose()` 销毁上下文" | **不存在**。`Context` 原型只有 `extend/isolate/intercept`；销毁要 `fiber.dispose()` |

**选 Cordis 的理由是结构性能力，不是速度。**

---

## 为什么仍然推荐 Cordis（而不是保留 DIContainer）

1. **仓库一致性** —— 已有 50 个 `cordis.patch.yml`，DSH 生态即 Cordis
2. **DIContainer 没有的能力**：
   - 事件系统 `ctx.on / ctx.emit`
   - 插件生命周期与依赖声明 `ctx.inject`
   - 热重载 HMR
   - 隔离作用域 `ctx.isolate`
3. **DIContainer 在仓库内零调用方**（全仓 grep 确认），属于死代码

如果只是需要一个 10 行以内的对象仓库，且不接入 DSH —— DIContainer 仍可用，且更快。

---

## 真实 API 对照

### 注册 / 提供服务

```javascript
// DIContainer
container.registerSingleton('db', () => createDb())
container.registerInstance('config', cfg)

// Cordis v4（实测）
export function apply(ctx, config) {
  ctx.provide('db')          // 先声明
  ctx.db = createDb()        // 再赋值
}
```

也可以直接：

```javascript
export function apply(ctx, config) {
  ctx.provide('db', createDb())   // 声明并赋值一步完成
}
```

### 消费服务

```javascript
// DIContainer
const db = container.resolve('db')

// Cordis
export function apply(ctx, config) {
  const db = ctx.db            // 读取
  ctx.provide('users', {
    async get(id) { return db.query('...', [id]) }   // 闭包捕获，热路径零 Proxy 开销
  })
}
```

> **性能要点**：`ctx.xxx` 每次读取约 6.9 µs（Proxy + 反射）。
> 在 `apply()` 开头取到局部变量，循环里用局部变量，不要反复读 `ctx.xxx`。

### 生命周期 / 清理

```javascript
// DIContainer：无
// Cordis：用 fiber.dispose()
const fiber = ctx.plugin({ name: 'p', apply(cx) { /* ... */ } })
await fiber          // plugin() 返回 thenable，await 后 apply 才生效
fiber.dispose()      // 卸载插件
```

插件内部清理用 `ctx.on('dispose', ...)`：

```javascript
export function apply(ctx, config) {
  const timer = setInterval(tick, 1000)
  ctx.on('dispose', () => clearInterval(timer))
}
```

### 事件

```javascript
// DIContainer：无
// Cordis（实测 50 listeners 场景 ≈ 23K emits/s）
ctx.on('custom-event', (payload) => { /* ... */ })
ctx.emit('custom-event', { data: 1 })
```

---

## 索引（本仓实测数据）

| 项目 | 数值 | 测试条件 |
|---|---|---|
| DIContainer.resolve() | 100,948,920 ops/s | 已注册实例，中位数 5 轮 x 200k 次 |
| Cordis ctx 服务访问 | 145,671 ops/s | `ctx.provide` 后读取，同上 |
| DIContainer 工厂 resolve | 87,172,558 ops/s | 每次新建对象 |
| 直接对象构造 | 196,753,566 ops/s | 基准参照 |
| Cordis emit（50 listeners） | 22,950 ops/s | |
| Cordis 10 插件加载+卸载 | 337 cycles/s（2.97 ms/轮） | 含 await fiber |
| DIContainer x200 heap 增量 | -0.30 MB | 强制 GC 后测量 |
| Cordis Context x200 heap 增量 | +7.38 MB | 同上 |

复现：

```bash
node --expose-gc tests/performance/real-benchmark.mjs
```

环境：Node v25.2.1 / win32 x64 / @deepseek-ai/cordis 4.0.5

---

## 迁移检查清单

- [ ] 确认该模块是否真的需要接入 DSH（不需要则可保留 DIContainer）
- [ ] 把 `register/registerSingleton/registerInstance` 换成 `ctx.provide(name, value)`
- [ ] 把 `resolve(name)` 换成 `ctx.name`，并在 `apply()` 顶部取局部变量
- [ ] 用 `ctx.on('dispose', ...)` 补上原本缺失的清理逻辑
- [ ] 加 `cordis.patch.yml`
- [ ] 跑 `node --expose-gc tests/performance/real-benchmark.mjs` 确认没有性能回退
