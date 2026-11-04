/**
 * 统一中间层的 workspace 门面。
 *
 * 这个文件属于 dsh-suite-kit：编排层负责“打包哪些插件、分配哪些端口、
 * 创建哪个 runtime、这个 runtime 的 work 声明包含哪些文件、如何呈现和清理”。
 *
 * 具体实现仍职责分离：
 *   - BlobStore：纯对象仓库，只存 sha256 字节，不关心文件关系；
 *   - WorkspaceManager：work 声明、文件归属、版本 CAS、catalog、生命周期；
 *   - dsh-plugin-kit 只把 WorkspaceClient/WorkspaceBackend 提供给插件侧。
 */
export {
  WorkspaceManager,
  WorkspaceClient,
  WorkspaceBackend,
  NamespaceRegistry,
  WorkspaceConflictError,
  WorkspaceAccessError,
} from '../../dsh-runtime-kit/src/workspace/manager.mjs'

export { BlobStore } from '../../dsh-runtime-kit/src/store/blob-store.mjs'
