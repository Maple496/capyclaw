/** 桥的稳定常量（relay/routes/tests 共用，避免循环 import）。 */
import { VIEW_OP_NAMES } from '../core/ops.js'

export const DEFAULT_PORT = 39311
export const BASE_PATH = '/api/desktop/works/ppt-bridge'

export const EDITOR_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  /* “打开方式”启动器专用入口：版本化 URL 绕过浏览器对旧 app.js 的强缓存。
   * 升级编辑器构建时同时改 app-v* 文件名与 index.html 里的 script src。 */
  '/open.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app-v20261103.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/heartbeat-worker.js': ['heartbeat-worker.js', 'text/javascript; charset=utf-8'],
  '/ppt-full-app.js': ['ppt-full-app.js', 'text/javascript; charset=utf-8'],
}

/** 页面级命令：不改 deck，只交给编辑器执行。由 op registry 的 view 元数据派生。 */
export const VIEW_OPS = new Set(VIEW_OP_NAMES)
