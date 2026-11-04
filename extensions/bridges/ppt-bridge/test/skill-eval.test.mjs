/**
 * 轻量技能评测：不调用 LLM，检查每个场景的“必须出现的工具/步骤”是否还在。
 * 真实模型评测以后可以在此之上接 mock MCP；这里先防止文案漂移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SKILLS = join(ROOT, 'src', 'skills')
const read = (name) => readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')

const cases = [
  {
    skill: 'pptist-api',
    must: ['ppt_capabilities', 'ppt_audit', 'ppt_get_deck', 'ppt_screenshot', 'ppt_recolor', 'ppt_page', 'ppt_images'],
    forbid: ['SCQA', '金字塔'],
  },
  {
    skill: 'pptmaster-narrative',
    must: ['SCQA', '金字塔', 'governing_thought', 'deck_brief'],
    forbid: ['ppt_capabilities', 'ppt_text'],
  },
  {
    skill: 'pptmaster-design',
    must: ['design token', 'accent', '反 AI slop', '视觉'],
    forbid: ['ppt_capabilities', 'ppt_text'],
  },
  {
    skill: 'pptist-authoring',
    must: ['ppt_deck', 'ppt_page', 'ppt_capabilities', 'preset: "clean"'],
    forbid: ['slideIndex', 'role: "title"', 'ppt_template', 'ppt_audit', 'pptist-visual-check'],
  },
  {
    skill: 'pptist-editing',
    must: ['ppt_recolor', 'ppt_text', 'ppt_element', 'ppt_image', 'ppt_slide', 'ppt_history', 'ppt_get_deck'],
    forbid: ['逐页 ppt_element 改色', 'ppt_audit', 'ppt_screenshot', 'pptmaster-design', 'pptist-visual-check'],
  },
  {
    skill: 'pptist-visual-check',
    must: ['ppt_audit', 'ppt_screenshot', 'pass'],
    forbid: ['ppt_text', 'ppt_element', 'ppt_recolor', 'pptmaster-design'],
  },
  {
    skill: 'pptist-research',
    must: ['web_search', 'web_fetch', 'ppt_image', 'analysis_type', 'source_tier'],
    forbid: [],
  },
]

for (const item of cases) {
  test(`技能评测：${item.skill} 的关键步骤齐全`, () => {
    const body = read(item.skill)
    for (const token of item.must) assert.ok(body.includes(token), `${item.skill} 缺少 ${token}`)
    for (const token of item.forbid) assert.ok(!body.includes(token), `${item.skill} 出现了禁止写法 ${token}`)
  })
}

test('技能评测：路由覆盖全部子技能', () => {
  const router = read('ppt')
  for (const name of ['pptist-authoring', 'pptist-editing', 'pptist-visual-check', 'pptist-research']) {
    assert.ok(router.includes(name), `ppt 路由缺少 ${name}`)
  }
})

test('技能评测：默认简洁路线存在，模板工具已清退', () => {
  const authoring = read('pptist-authoring')
  assert.match(authoring, /preset: "clean"/)
  assert.ok(!authoring.includes('ppt_template'), 'authoring 仍引用模板工具')
  const router = read('ppt')
  assert.ok(router.includes('默认走内置简洁版式'), '路由缺少默认简洁规则')
  assert.ok(!router.includes('官方模板'), '路由仍引用官方模板')
})

test('技能评测：执行、审美、审计职责互相解耦', () => {
  const editing = read('pptist-editing')
  assert.ok(editing.includes('纯执行'), 'editing 不是纯执行技能')
  assert.ok(!editing.includes('ppt_audit'), 'editing 不得包含审计工具')
  assert.ok(!editing.includes('ppt_screenshot'), 'editing 不得包含截图工具')
  assert.ok(!editing.includes('pptmaster-design'), 'editing 不得依赖设计技能')
  assert.ok(!editing.includes('pptist-visual-check'), 'editing 不得依赖验收技能')

  const design = read('pptmaster-design')
  assert.ok(!design.includes('ppt_audit'), 'design 不得包含审计工具')
  assert.ok(!design.includes('visual-qa'), 'design 不得承载验收规则')

  const check = read('pptist-visual-check')
  assert.ok(!check.includes('pptmaster-design'), 'visual-check 不得依赖设计技能')
  assert.ok(!check.includes('ppt_text'), 'visual-check 不得包含改稿工具')
})

test('技能评测：除路由外，skill 之间不硬编码依赖', () => {
  const all = cases.map((item) => item.skill)
  for (const skill of all) {
    const body = read(skill)
    for (const other of all) {
      if (other === skill) continue
      assert.ok(!body.includes(other), `${skill} 不应硬编码引用 ${other}`)
    }
  }
})
