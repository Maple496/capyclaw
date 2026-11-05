/** 桥的稳定常量（relay/routes/tests 共用，避免循环 import）。 */

export const DEFAULT_PORT = 39315

/** 工作台静态页（白名单，杜绝路径穿越；相对 ui/）。 */
export const WORKBENCH_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
}

/** 内置离线演示页（相对 demo/）。 */
export const DEMO_FILES = {
  '/demo/form.html': ['form.html', 'text/html; charset=utf-8'],
}
