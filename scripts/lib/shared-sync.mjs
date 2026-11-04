/** 共享快照同步库（供 scripts/sync-shared.mjs 与 create-plugin 共用）。 */
export {
  PUBLIC_SHARED,
  SHARED_KIT_FILES,
  rewriteSharedImports,
  syncSharedDir,
} from '../sync-shared.mjs'
