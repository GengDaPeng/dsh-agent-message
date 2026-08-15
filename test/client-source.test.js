import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('@候选排除当前会话、归档、空白和真实子代理', () => {
  assert.match(source, /!row\.blank/)
  assert.match(source, /row\.origin !== "subagent"/)
  assert.match(source, /!archived\.has\(row\.id\)/)
  assert.match(source, /String\(row\.id\) !== String\(session\.sessionId\)/)
})

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

test('relay 保持 Agent 来源，同时投影为可见消息卡片', () => {
  assert.match(source, /function prepareRelayCards/)
  assert.match(source, /data-agent-msg-relay-card/)
  assert.match(source, /data-context-form="relay"/)
  assert.match(source, /<dsh-agent-message>/)
  assert.match(source, /raw\.slice\(end \+ "<\/dsh-agent-message>"\.length\)\.trimStart\(\)/)
  assert.doesNotMatch(source, /source\.kind\s*=\s*["']user["']/)
})

test('会话引用和 relay 来源支持鼠标及键盘打开完整 Session ID', () => {
  assert.match(source, /dataset\.agentMsgSessionId/)
  assert.match(source, /setAttribute\("role", "link"\)/)
  assert.match(source, /event\.key !== "Enter" && event\.key !== " "/)
  assert.match(source, /ctx\.sessions\.open\(sessionId\)/)
  assert.match(source, /document\.addEventListener\("click", openSender\)/)
  assert.match(source, /document\.removeEventListener\("click", openSender\)/)
})

test('Client 文案跟随界面语言且卸载后可恢复原生发送方标签', () => {
  assert.match(source, /uiText\("来自会话 · ", "From Session · "\)/)
  assert.match(source, /uiText\("打开发送方会话", "Open sender session"\)/)
  assert.match(source, /uiText\("复制会话 ID", "Copy session ID"\)/)
  assert.doesNotMatch(source, /label\.textContent = ""/)
})

test('移除 DOM 子树时只查询其中的插件节点，不遍历全部已跟踪元素', () => {
  const cleanup = source.slice(source.indexOf('function cleanupRoots'), source.indexOf('function SessionActivity'))
  assert.match(cleanup, /querySelectorAll\(reactRootSelector\)/)
  assert.match(cleanup, /querySelectorAll\("\.agent-msg-session-link"\)/)
  assert.doesNotMatch(cleanup, /mountedRoots\.forEach|sessionLinks\.forEach/)
})
