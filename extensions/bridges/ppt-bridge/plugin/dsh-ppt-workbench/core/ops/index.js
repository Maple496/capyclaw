/** op 组装：按域合并为一张表，交给通用 op registry 分发。 */
import { createOpDispatcher, createOpRegistry } from 'dsh-document-workbench/ops'
import { deckOps } from './deck.js'
import { textOps } from './text.js'
import { elementOps } from './element.js'
import { slideOps } from './slide.js'
import { recolorOps } from './recolor.js'
import { viewOps } from './view.js'
import { historyOps } from './history.js'
import { playbackOps } from './playback.js'
import { chartOps } from './chart.js'
import { tableOps } from './table.js'
import { importOps } from './import.js'

export const OP_MODULES = {
  deck: deckOps,
  text: textOps,
  element: elementOps,
  slide: slideOps,
  recolor: recolorOps,
  view: viewOps,
  history: historyOps,
  playback: playbackOps,
  chart: chartOps,
  table: tableOps,
  importer: importOps,
}

export const registry = createOpRegistry({
  modules: OP_MODULES,
  snapshot: (P) => P.snapshot?.(),
})

export const OP_DEFINITIONS = registry.definitions
export const OP_NAMES = registry.names
export const VIEW_OP_NAMES = registry.viewNames
export const applyOp = registry.apply

export { createOpDispatcher }
