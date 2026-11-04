/** 视图 op：放映控制（不改 deck，不产生 undo 快照）。 */
export const viewOps = {
  present: {
    mutates: false,
    view: true,
    run(P, c) { return P.present(c.index != null ? c.index : undefined) },
  },
  'exit-present': {
    mutates: false,
    view: true,
    run(P) { return P.exitPresent() },
  },
}
