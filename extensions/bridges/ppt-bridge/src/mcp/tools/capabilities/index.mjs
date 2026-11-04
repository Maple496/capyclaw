/**
 * 能力清单：唯一扩展点。
 *
 * 新增能力：新建 capabilities/<id>.mjs，导出 defineCapability(...)，
 * 然后在这里加一行 import 和数组项即可。contract / instructions / 测试
 * 全部由 registry 自动派生。
 */
import { contractCapability } from './contract.mjs'
import { deckCapability } from './deck.mjs'
import { auditCapability } from './audit.mjs'
import { taskCapability } from './task.mjs'
import { textCapability } from './text.mjs'
import { styleCapability } from './style.mjs'
import { elementCapability } from './element.mjs'
import { slideCapability } from './slide.mjs'
import { applyCapability } from './apply.mjs'
import { composeCapability } from './compose.mjs'
import { recolorCapability } from './recolor.mjs'
import { imageCapability } from './image.mjs'
import { imagesearchCapability } from './imagesearch.mjs'
import { screenshotCapability } from './screenshot.mjs'
import { presentCapability } from './present.mjs'
import { historyCapability } from './history.mjs'
import { chartCapability } from './chart.mjs'
import { tableCapability } from './table.mjs'
import { notesCapability } from './notes.mjs'
import { shapeCapability } from './shape.mjs'
import { lineCapability } from './line.mjs'
import { formulaCapability } from './formula.mjs'
import { importCapability } from './import.mjs'
import { exportCapability } from './export.mjs'

export const CAPABILITIES = [
  contractCapability,
  deckCapability,
  auditCapability,
  taskCapability,
  textCapability,
  styleCapability,
  elementCapability,
  slideCapability,
  applyCapability,
  composeCapability,
  recolorCapability,
  imageCapability,
  imagesearchCapability,
  screenshotCapability,
  presentCapability,
  historyCapability,
  chartCapability,
  tableCapability,
  notesCapability,
  shapeCapability,
  lineCapability,
  formulaCapability,
  importCapability,
  exportCapability,
]
