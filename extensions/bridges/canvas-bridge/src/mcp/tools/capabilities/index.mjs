/**
 * 能力清单：唯一扩展点。
 *
 * 新增能力：新建 capabilities/<id>.mjs，导出 defineCapability(...)，
 * 然后在这里加一行 import 和数组项即可。contract / instructions / 测试
 * 全部由 registry 自动派生。
 */
import { contractCapability } from './contract.mjs'
import { docCapability } from './doc.mjs'
import { textCapability } from './text.mjs'
import { elementCapability } from './element.mjs'
import { tableCapability } from './table.mjs'
import { styleCapability } from './style.mjs'
import { pageCapability } from './page.mjs'
import { viewCapability } from './view.mjs'
import { historyCapability } from './history.mjs'
import { auditCapability } from './audit.mjs'
import { taskCapability } from './task.mjs'
import { execCapability } from './exec.mjs'
import { exportCapability } from './export.mjs'

export const CAPABILITIES = [
  contractCapability,
  docCapability,
  textCapability,
  elementCapability,
  tableCapability,
  styleCapability,
  pageCapability,
  viewCapability,
  historyCapability,
  auditCapability,
  taskCapability,
  execCapability,
  exportCapability,
]
