/**
 * 工具侧纯辅助：镜像读写。
 *
 * Canvas 写路径（确定性优先）：读镜像 → 纯函数变换 → setValue 整篇回写。
 * 好处：结果可在 node:test 直测；不受编辑器光标/选区影响。
 * 代价：一批 = 一次全量 load；编辑器 undo 栈里是一条完整记录。
 */
export async function readMirror(ctx) {
  const r = await ctx.doc.read()
  const doc = r && r.doc
  if (!doc || typeof doc !== 'object') {
    throw new Error('桥上没有文档镜像：先 canvas_write_document 生成内容，或等编辑器页面完成首次同步')
  }
  return doc
}

export async function writeMirror(ctx, doc, title) {
  await ctx.editor.require()
  return ctx.doc.write([{ cmd: 'setValue', args: [doc] }], title || '更新文档')
}

const zoneOf = (zone) => Array.isArray(zone) ? zone : (zone && zone.elementList) || []

/** 三段归一化成可变数组形态（load 三形兼容，统一写回数组）。 */
export function normalizeZones(doc) {
  const out = { ...doc }
  for (const zone of ['header', 'main', 'footer']) out[zone] = zoneOf(doc[zone])
  return out
}
