/** 桥的稳定常量（relay/routes/tests 共用，避免循环 import）。 */

export const DEFAULT_PORT = 39313
export const BASE_PATH = '/api/desktop/works/canvas-bridge'

export const EDITOR_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/heartbeat-worker.js': ['heartbeat-worker.js', 'text/javascript; charset=utf-8'],
  '/canvas-full-app.js': ['canvas-full-app.js', 'text/javascript; charset=utf-8'],
}
