/** 测试工具：内存 backend 与 fake editor adapter，供框架自身和消费者做一致性测试。 */

export function createMemoryBackend({ initialDoc = {} } = {}) {
  let state = null
  const journal = []
  const checkpoints = new Map()
  return {
    dir: '',
    file: '',
    journalFile: '',
    checkpointDir: '',
    lastStateError: null,
    readState() {
      return state ? structuredClone(state) : null
    },
    writeState(doc) {
      state = structuredClone(doc)
    },
    appendJournal(event) {
      journal.push({ ...structuredClone(event), ts: Date.now() / 1000 })
    },
    journalTail(limit = 8) {
      return journal.slice(-limit).map((event) => structuredClone(event))
    },
    writeCheckpoint(name, payload) {
      checkpoints.set(name, structuredClone(payload))
    },
    listCheckpoints() {
      return [...checkpoints.values()]
        .map((payload) => ({
          name: payload.name,
          seq: payload.seq,
          appliedSeq: payload.appliedSeq,
          pending: !!payload.pending,
          title: payload.title,
          slides: payload.slides,
          createdAt: payload.createdAt,
          meta: payload.meta || {},
        }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    },
    readCheckpoint(name) {
      const payload = checkpoints.get(name)
      if (!payload) throw new Error('checkpoint 不存在: ' + name)
      return structuredClone(payload)
    },
    initialDoc,
  }
}

export function createFakeEditorAdapter({
  document = {},
  applyCommand = (doc) => doc,
  renderScreenshot = async () => 'data:image/png;base64,eA==',
} = {}) {
  let current = structuredClone(document)
  const listeners = new Set()
  return {
    isMounted: () => true,
    load(value) { current = structuredClone(value) },
    dump() { return structuredClone(current) },
    async apply(commands) {
      for (const command of commands || []) current = await applyCommand(current, command)
      return (commands || []).length
    },
    async applyUi(commands) { return (commands || []).length },
    onChange(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    async renderScreenshot() { return renderScreenshot() },
    emitChange() { for (const handler of listeners) handler() },
    get document() { return current },
  }
}
