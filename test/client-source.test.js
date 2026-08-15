import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('@会话选择以可读标题提交稳定 ID，而不是固定宽度引用占位符', () => {
  assert.match(source, /claim:/)
  assert.match(source, /session\.prompt/)
  assert.match(source, /"@" \+ String\(row\.id\)/)
  assert.match(source, /function compactSessionTitle/)
  assert.doesNotMatch(source, /source: referenceSource,\s+ref:/)
})

test('会话运行状态只在候选列表显示，并使用运行中或空闲语义', () => {
  const referenceBody = source.slice(
    source.indexOf('function SessionReference'),
    source.indexOf('function enhanceReferenceHost'),
  )

  assert.doesNotMatch(referenceBody, /SessionStatus/)
  assert.match(source, /uiText\("运行中", "Running"\)/)
  assert.match(source, /uiText\("空闲", "Idle"\)/)
  assert.doesNotMatch(source, /uiText\("在线", "Online"\)/)
  assert.doesNotMatch(source, /uiText\("离线", "Offline"\)/)
})
