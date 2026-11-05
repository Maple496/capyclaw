/**
 * 能力清单：唯一扩展点。
 *
 * 新增能力：新建 capabilities/<id>.mjs，导出 defineCapability(...)，
 * 然后在这里加一行 import 和数组项即可。contract / instructions / 测试
 * 全部由 registry 自动派生。
 */
import { contractCapability } from './contract.mjs'
import { navigationCapability } from './navigation.mjs'
import { snapshotCapability } from './snapshot.mjs'
import { interactionCapability } from './interaction.mjs'
import { tabsCapability } from './tabs.mjs'
import { screenshotCapability } from './screenshot.mjs'
import { sessionCapability } from './session.mjs'
import { evaluateCapability } from './evaluate.mjs'

export const CAPABILITIES = [
  contractCapability,
  navigationCapability,
  snapshotCapability,
  interactionCapability,
  tabsCapability,
  screenshotCapability,
  sessionCapability,
  evaluateCapability,
]
