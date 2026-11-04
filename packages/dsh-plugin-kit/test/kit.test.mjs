import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillProvider, JournalStore, validateToolArguments } from '../src/index.mjs'

test('validate：required/type/enum/maxLength/maxItems', () => {
  const tool = {
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', maxLength: 4 },
        count: { type: 'integer' },
        list: { type: 'array', maxItems: 2, items: { type: 'string' } },
        mode: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['text'],
    },
  }
  assert.equal(validateToolArguments(tool, { text: 'ok' }).ok, true)
  assert.equal(validateToolArguments(tool, {}).ok, false)
  assert.equal(validateToolArguments(tool, { text: 'toolong' }).ok, false)
  assert.equal(validateToolArguments(tool, { text: 'ok', extra: 1 }).ok, false)
  assert.equal(validateToolArguments(tool, { text: 'ok', list: ['a', 'b', 'c'] }).ok, false)
  assert.equal(validateToolArguments(tool, { text: 'ok', mode: 'c' }).ok, false)
})

test('skill provider：目录、frontmatter、按需加载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-kit-skill-'))
  mkdirSync(join(dir, 'demo'))
  writeFileSync(join(dir, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: demo skill\nwhenToUse: test\n---\n\n# Demo\n\nhello')
  const provider = createSkillProvider({ assetRoot: dir, skillDirs: ['demo'] })
  const list = await provider.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'demo')
  const body = await provider.get(list[0], {})
  assert.ok(body.content.includes('hello'))
  assert.ok(!body.content.startsWith('---'))
})

test('journal store：原子状态 + checkpoint + journal tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-kit-store-'))
  const store = new JournalStore({ file: join(dir, 'state.json'), initialDoc: { seq: 0 } })
  store.doc.seq = 1
  store.save()
  store.journal({ type: 'push', seq: 1 })
  store.checkpoint('cp', { deck: { slides: [] } }, { goal: 'test' })
  assert.equal(store.get().seq, 1)
  assert.equal(store.listCheckpoints()[0].name, 'cp')
  assert.equal(store.readCheckpoint('cp').meta.goal, 'test')
  assert.equal(store.journalTail(10).at(-1).type, 'checkpoint')
  const reloaded = new JournalStore({ file: join(dir, 'state.json'), initialDoc: { seq: 0 } })
  assert.equal(reloaded.get().seq, 1)
})
