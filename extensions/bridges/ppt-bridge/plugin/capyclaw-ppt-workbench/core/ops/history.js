/** 历史 op：撤销/重做（不再 snapshot）。 */
export const historyOps = {
  undo: {
    mutates: false,
    run(P) { return P.undo() },
  },
  redo: {
    mutates: false,
    run(P) { return P.redo() },
  },
}
