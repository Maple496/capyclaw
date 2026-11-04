/** deck 级 op：整副替换 / 标题 / 主题。 */
export const deckOps = {
  load: {
    run(P, c) { return P.load(c.deck) },
  },
  title: {
    run(P, c) { P.setTitle(String(c.title || '')) },
  },
  theme: {
    run(P, c) {
      const th = P.getTheme() || {}
      Object.assign(th, c.theme || {})
      P.setTheme(th)
    },
  },
  /* 只压一条服务端历史快照，不改 deck。导入这类“绕过 op 内核”的
   * 编辑器级操作前调用，保证 ppt_history undo 能回到导入前。 */
  snapshot: {
    run() {},
  },
}
