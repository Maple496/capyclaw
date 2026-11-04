/**
 * 形状库：常用 SVG 形状的 path 生成（viewBox 200×200 空间，编辑器按元素宽高缩放）。
 * 零 DOM，node:test 直测；ppt_shape 工具的数据源。
 */

/** 正 n 边形顶点（外接圆半径 R，中心 100,100，顶点朝上）。 */
function polygon(n, rot = -90) {
  const pts = []
  for (let i = 0; i < n; i++) {
    const a = ((rot + (360 / n) * i) * Math.PI) / 180
    pts.push([100 + 100 * Math.cos(a), 100 + 100 * Math.sin(a)])
  }
  return pts
}

/** 顶点数组 → path（闭合）。 */
const toPath = (pts) => 'M ' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ') + ' Z'

/** 五角星（外径 100，内径 40）。 */
function star5() {
  const pts = []
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 100 : 42
    const a = ((-90 + 36 * i) * Math.PI) / 180
    pts.push([100 + r * Math.cos(a), 100 + r * Math.sin(a)])
  }
  return toPath(pts)
}

/** 圆角矩形 path（顺时针，四角四段圆弧）。 */
function roundRect(radius = 32) {
  const r = Math.min(radius, 100)
  return `M 0 ${r} ` +
    `A ${r} ${r} 0 0 1 ${r} 0 L ${200 - r} 0 A ${r} ${r} 0 0 1 200 ${r} ` +
    `L 200 ${200 - r} A ${r} ${r} 0 0 1 ${200 - r} 200 L ${r} 200 ` +
    `A ${r} ${r} 0 0 1 0 ${200 - r} Z`
}

/** 水平箭头 path（指向 dx 方向：1 右 / -1 左）。 */
function arrowH(dx) {
  const pts = dx > 0
    ? [[0, 75], [125, 75], [125, 40], [200, 100], [125, 160], [125, 125], [0, 125]]
    : [[200, 75], [75, 75], [75, 40], [0, 100], [75, 160], [75, 125], [200, 125]]
  return toPath(pts)
}

/** 垂直箭头 path（指向 dy 方向：1 下 / -1 上）。 */
function arrowV(dy) {
  const pts = dy > 0
    ? [[75, 0], [75, 125], [40, 125], [100, 200], [160, 125], [125, 125], [125, 0]]
    : [[75, 200], [75, 75], [40, 75], [100, 0], [160, 75], [125, 75], [125, 200]]
  return toPath(pts)
}

/** 双向水平箭头。 */
const doubleArrow = toPath([[0, 100], [50, 55], [50, 80], [150, 80], [150, 55], [200, 100], [150, 145], [150, 120], [50, 120], [50, 145]])

/** 对话气泡（圆角矩形 + 左下尾巴）。 */
const bubble = 'M 24 12 L 176 12 A 20 20 0 0 1 196 32 L 196 120 A 20 20 0 0 1 176 140 L 88 140 L 44 184 L 52 140 L 24 140 A 20 20 0 0 1 4 120 L 4 32 A 20 20 0 0 1 24 12 Z'

/** 爱心。 */
const heart = 'M 100 178 C 32 128 8 92 8 60 C 8 30 32 12 56 12 C 76 12 92 24 100 40 C 108 24 124 12 144 12 C 168 12 192 30 192 60 C 192 92 168 128 100 178 Z'

/** 云朵。 */
const cloud = 'M 56 160 A 44 44 0 0 1 56 72 A 52 52 0 0 1 152 60 A 46 46 0 0 1 152 160 Z'

/** 闪电。 */
const bolt = 'M 112 4 L 40 112 L 92 112 L 76 196 L 160 80 L 104 80 Z'

/** 十字。 */
const cross = 'M 70 8 L 130 8 L 130 70 L 192 70 L 192 130 L 130 130 L 130 192 L 70 192 L 70 130 L 8 130 L 8 70 L 70 70 Z'

/** 三角函数圆弧（四分之一圆 path）。 */
const quarter = (cx, cy, sx, sy, ex, ey) => `M ${sx} ${sy} A 100 100 0 0 1 ${ex} ${ey} L ${cx} ${cy} Z`

/** 圆柱（数据库/桶形）。 */
const cylinder = 'M 20 40 A 80 26 0 0 1 180 40 L 180 160 A 80 26 0 0 1 20 160 Z'

/**
 * 形状库：key → { name, path }（viewBox 统一 0 0 200 200）。
 */
export const SHAPE_LIBRARY = {
  rect: { name: '矩形', path: 'M 0 0 L 200 0 L 200 200 L 0 200 Z' },
  'round-rect': { name: '圆角矩形', path: roundRect(32) },
  circle: { name: '圆形', path: 'M 0 100 A 100 100 0 1 1 200 100 A 100 100 0 1 1 0 100 Z' },
  triangle: { name: '三角形', path: toPath(polygon(3)) },
  'triangle-down': { name: '倒三角', path: toPath(polygon(3, 90)) },
  diamond: { name: '菱形', path: toPath([[100, 0], [200, 100], [100, 200], [0, 100]]) },
  pentagon: { name: '五边形', path: toPath(polygon(5)) },
  hexagon: { name: '六边形', path: toPath(polygon(6, 0)) },
  'star-5': { name: '五角星', path: star5() },
  'arrow-right': { name: '右箭头', path: arrowH(1) },
  'arrow-left': { name: '左箭头', path: arrowH(-1) },
  'arrow-up': { name: '上箭头', path: arrowV(-1) },
  'arrow-down': { name: '下箭头', path: arrowV(1) },
  'double-arrow': { name: '双向箭头', path: doubleArrow },
  bubble: { name: '气泡', path: bubble },
  heart: { name: '爱心', path: heart },
  cloud: { name: '云朵', path: cloud },
  bolt: { name: '闪电', path: bolt },
  cross: { name: '十字', path: cross },
  'pie-quarter': { name: '扇形', path: quarter(100, 100, 100, 0, 200, 100) },
  cylinder: { name: '圆柱', path: cylinder },
  'round-frame': {
    name: '圆角边框',
    path: 'M 24 4 L 176 4 A 20 20 0 0 1 196 24 L 196 176 A 20 20 0 0 1 176 196 L 24 196 A 20 20 0 0 1 4 176 L 4 24 A 20 20 0 0 1 24 4 Z M 24 20 A 4 4 0 0 0 20 24 L 20 176 A 4 4 0 0 0 24 180 L 176 180 A 4 4 0 0 0 180 176 L 180 24 A 4 4 0 0 0 176 20 Z',
  },
}

export const SHAPE_KEYS = Object.keys(SHAPE_LIBRARY)

/**
 * 取形状定义。
 * @param {string} key SHAPE_KEYS 之一
 */
export function getShape(key) {
  const s = SHAPE_LIBRARY[String(key || '')]
  if (!s) {
    throw new Error(`未知形状: ${key}（可用: ${SHAPE_KEYS.join(', ')}）`)
  }
  return { viewBox: [200, 200], ...s }
}
