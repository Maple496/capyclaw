/**
 * standalone/storage.mjs
 * 
 * 文档存储：本地 JSON 文件 + 内存缓存
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const DEFAULT_WORKSPACE = process.env.CANVAS_WORKSPACE || join(process.cwd(), '.canvas-docs')

/** 确保工作目录存在 */
async function ensureWorkspace(workspace = DEFAULT_WORKSPACE) {
  if (!existsSync(workspace)) {
    await mkdir(workspace, { recursive: true })
  }
  return workspace
}

/** 文档文件路径（相对或绝对） */
function docPath(file, workspace = DEFAULT_WORKSPACE) {
  const abs = resolve(workspace, file.endsWith('.canvas.json') ? file : `${file}.canvas.json`)
  return abs
}

/** 保存文档 */
export async function save(file, doc, options = {}) {
  const workspace = await ensureWorkspace(options.workspace)
  const path = docPath(file, workspace)
  await mkdir(dirname(path), { recursive: true })
  const content = {
    version: '1.0',
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    doc,
    options: options.editorOptions || {},
  }
  await writeFile(path, JSON.stringify(content, null, 2), 'utf-8')
  return path
}

/** 加载文档 */
export async function load(file, workspace = DEFAULT_WORKSPACE) {
  const path = docPath(file, workspace)
  try {
    await access(path)
  } catch {
    return null  // 文件不存在
  }
  const raw = await readFile(path, 'utf-8')
  const content = JSON.parse(raw)
  return {
    doc: content.doc || { header: [], main: [], footer: [] },
    options: content.options || {},
    meta: {
      version: content.version,
      created: content.created,
      modified: content.modified,
    },
  }
}

/** 列出所有文档 */
export async function list(workspace = DEFAULT_WORKSPACE) {
  const ws = await ensureWorkspace(workspace)
  const { readdir } = await import('node:fs/promises')
  const files = await readdir(ws, { recursive: true })
  return files.filter((f) => f.endsWith('.canvas.json'))
}

/** 删除文档 */
export async function remove(file, workspace = DEFAULT_WORKSPACE) {
  const path = docPath(file, workspace)
  const { unlink } = await import('node:fs/promises')
  await unlink(path)
}

/** 导出 HTML */
export async function exportHtml(doc, text) {
  // 简化版：直接用文本，后续可以接 canvas-editor 的 getHTML()
  const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Canvas 文档</title>
<style>
body { max-width: 800px; margin: 40px auto; padding: 20px; font-family: sans-serif; line-height: 1.6; }
h1 { font-size: 28px; margin-top: 40px; }
h2 { font-size: 22px; margin-top: 32px; }
p { margin: 12px 0; }
table { border-collapse: collapse; width: 100%; margin: 20px 0; }
th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
th { background: #f5f5f5; font-weight: 600; }
</style>
</head><body>
<pre style="white-space: pre-wrap;">${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body></html>`
  return html
}
