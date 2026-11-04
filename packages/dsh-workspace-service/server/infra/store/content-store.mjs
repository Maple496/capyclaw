/**
 * 兼容导出：旧的 content-store 名称映射到新的职责分层。
 *
 * 新代码请直接使用：
 *   store/blob-store.mjs     纯对象仓库（不关心文件关系）
 *   workspace/manager.mjs    文件关系 / 归属 / 版本 / 生命周期中间层
 */
export { BlobStore } from './blob-store.mjs'
export {
  WorkspaceManager as ContentStore,
  WorkspaceClient as ContentStoreClient,
  WorkspaceBackend as ContentStoreBackend,
  WorkspaceConflictError as StoreConflictError,
  WorkspaceAccessError as StoreAccessError,
  NamespaceRegistry,
} from '../workspace/manager.mjs'
export { withFileLock, writeJsonAtomic, readJson, sleepSync } from '../util/fs-lock.mjs'
