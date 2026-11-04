/** dsh-ppt-suite 是组合包：自身不注册服务，仅承载 cordis.patch.yml。 */
export const name = 'ppt-suite'

export function apply() {
  // 组合行由 cordis.patch.yml 插入；这里保持空实现，便于包结构校验与独立加载。
}
