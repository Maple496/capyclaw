/** 工具域辅助桶：只给 tools.mjs 兼容导出用，能力模块按需直接 import 具体文件。 */
export { COLORS, resolveColor, parseColor, contrastColor, relativeLuminance } from './color.mjs'
export { expandRecolorOps, resolveForeground } from './recolor.mjs'
export { simpleSlide } from './slide.mjs'
export { imageMime, imageSize, resolveAttachmentFile } from './image.mjs'
export { clamp, sleep, okText, normalizeSlides } from './tooling.mjs'
export { normalizeTextStyle } from './text-style.mjs'
