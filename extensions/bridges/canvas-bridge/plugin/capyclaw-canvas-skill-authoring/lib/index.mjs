/** @capyclaw/canvas-skill-authoring（目录 capyclaw-canvas-skill-authoring）：单 skill provider。 */
import { fileURLToPath } from 'node:url'
import { createSkillProvider } from './provider.mjs'

export const name = 'canvas-skill-authoring'
export const inject = ['skills']
const SKILL = "canvasist-authoring"

function defaultProvider(config = {}) {
  return createSkillProvider({
    assetRoot: config.assetRoot ?? fileURLToPath(new URL('../skills/', import.meta.url)),
    contractRoot: config.contractRoot ?? fileURLToPath(new URL('../contract/', import.meta.url)),
    contractFile: 'canvas-contract.json',
    providerName: "dsh-canvas-authoring",
    skillDirs: [SKILL],
    contractNote: (version, skillName) => (skillName === 'canvas'
      ? ''
      : '契约：Canvas Workbench ' + version + '。动作前先调用 canvas_capabilities；工具缺失或 major 不一致时停止，并提示用户安装/升级 @capyclaw/canvas-suite。'),
  })
}

export function createProvider(config = {}) { return defaultProvider(config) }
export function apply(ctx, config = {}) { ctx.skills.registerProvider(() => defaultProvider(config)) }
