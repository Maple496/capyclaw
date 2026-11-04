/** Hello Service 业务实现。工具层只做 schema/分派，业务放这里。 */
import { capabilities as report } from './tools.mjs'

export function echo({ text }) {
  return `echo: ${String(text)}`
}

export function capabilities() {
  return {
    name: 'dsh-hello-service',
    version: '1.0.0',
    ...report(),
  }
}
