/** @capyclaw/host-shell —— DSH 宿主壳标准件的库入口。
 *
 * 可复用件在此导出；auth-proxy / start-safe 是「运行即执行」的入口脚本
 * （顶层即副作用，刻意保留原语义），经 bin/dsh-host.mjs 调度，不作库导出。
 */
export { acquireLock } from './single-instance.mjs';
export { ForegroundGuard, enforceRunInForeground } from './foreground-guard.mjs';
export { savePids, cleanupOldInstance, setupCleanup } from './process-manager.mjs';
