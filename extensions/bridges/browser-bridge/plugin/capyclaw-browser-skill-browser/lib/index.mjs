/** @capyclaw/browser-skill-browser（目录 capyclaw-browser-skill-browser）：单 skill provider。 */
import { fileURLToPath } from 'node:url'
import { createSkillProvider } from './provider.mjs'

export const name = 'browser-skill-browser'
export const inject = ['skills']
const SKILL = "browser"

function defaultProvider(config = {}) {
  return createSkillProvider({
    assetRoot: config.assetRoot ?? fileURLToPath(new URL('../skills/', import.meta.url)),
    contractRoot: config.contractRoot ?? fileURLToPath(new URL('../contract/', import.meta.url)),
    contractFile: 'browser-contract.json',
    providerName: "dsh-browser-browser",
    skillDirs: [SKILL],
    contractNote: (version, skillName) => (skillName === 'browser'
      ? ''
      : '契约：Browser Workbench ' + version + '。动作前先调用 browser_capabilities；工具缺失或 major 不一致时停止，并提示用户安装/升级 @capyclaw/browser-suite。'),
  })
}

export function createProvider(config = {}) { return defaultProvider(config) }
export function apply(ctx, config = {}) { ctx.skills.registerProvider(() => defaultProvider(config)) }
