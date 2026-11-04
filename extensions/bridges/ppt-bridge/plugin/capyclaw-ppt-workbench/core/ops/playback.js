/** 节奏 op：sleep（不改 deck）。 */
export const playbackOps = {
  sleep: {
    mutates: false,
    run(P, c) {
      return new Promise(r => setTimeout(r, Math.min(3000, Math.max(0, Number(c.ms) || 600))))
    },
  },
}
