import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('Client 只注入 0.2.2 存在的运行时服务，文案跟随 Harness locale', () => {
  assert.match(source, /const inject = \["slots", "sessions", "uiWorkspace", "locale"\]/)
  assert.match(source, /ctx\.locale\.getSnapshot\(\)/)
  assert.match(source, /React\.useSyncExternalStore/)
  assert.doesNotMatch(source, /document\.documentElement\.lang|navigator\.language/)
})

test('0.2.2 插件详情页注册 Host Config 表单，不再自建设置卡片', () => {
  assert.doesNotMatch(source, /settingsScope/)
  assert.doesNotMatch(source, /settings\.plugin\.item/)
  assert.doesNotMatch(source, /AgentMessageSettingsCard/)
  assert.doesNotMatch(source, /AGENT_MESSAGE_SETTINGS_NAMESPACE/)
  assert.match(source, /plugins\.bundle\.config/)
  assert.match(source, /CONFIG_BUNDLE_KEY = "dsh-agent-message"/)
  assert.match(source, /ctx\.inject\(\["configForms"\]/)
  assert.match(source, /configForms\.get\(CONFIG_NAMESPACE\)/)
  assert.match(source, /CONFIG_NAMESPACE = "agent-message"/)
  assert.match(source, /showTechnicalDetails/)
})

test('@会话引用完全复用 Harness 原生 source', () => {
  assert.doesNotMatch(source, /registerSource/)
  assert.doesNotMatch(source, /inputTriggers/)
  assert.doesNotMatch(source, /session\.prompt/)
  assert.doesNotMatch(source, /agent-message-session/)
})

test('relay 保持 Agent 来源，同时投影为可见消息卡片', () => {
  assert.match(source, /function prepareRelayCards/)
  assert.match(source, /data-agent-msg-relay-card/)
  assert.match(source, /data-context-form="relay"/)
  assert.match(source, /data-context-relay-sender/)
  assert.doesNotMatch(source, /data-disclosure-row/)
  assert.match(source, /<dsh-agent-message>/)
  assert.match(source, /raw\.slice\(end \+ "<\/dsh-agent-message>"\.length\)\.trimStart\(\)/)
  assert.doesNotMatch(source, /source\.kind\s*=\s*["']user["']/)
})

test('relay 来源支持鼠标及键盘打开完整 Session ID', () => {
  assert.match(source, /dataset\.agentMsgSessionId/)
  assert.match(source, /setAttribute\("role", "link"\)/)
  assert.match(source, /event\.key !== "Enter" && event\.key !== " "/)
  assert.match(source, /ctx\.uiWorkspace\.openSession\(sessionId\)/)
  assert.doesNotMatch(source, /ctx\.sessions\.open/)
  assert.match(source, /document\.addEventListener\("click", openSender\)/)
  assert.match(source, /document\.removeEventListener\("click", openSender\)/)
})

test('会话导航服务缺失时静默降级，不抛错', () => {
  const openSender = source.slice(source.indexOf('function openSender'), source.indexOf('function onKeyDown'))
  assert.match(openSender, /ctx\.uiWorkspace === undefined \|\| typeof ctx\.uiWorkspace\.openSession !== "function"\) return;/)
})

test('0.2.x turn-trigger 渲染路径也剥离协议头并补出发送方', () => {
  assert.match(source, /function stripRelayHeader/)
  assert.match(source, /data-turn-trigger="true"/)
  assert.match(source, /function ensureRelaySender/)
  assert.match(source, /insertBefore\(line, text\)/)
})

test('Client 文案跟随界面语言且卸载后可恢复原生发送方标签', () => {
  assert.match(source, /uiText\("来自会话 · ", "From Session · "\)/)
  assert.match(source, /uiText\("打开发送方会话", "Open sender session"\)/)
  assert.match(source, /element\.textContent = element\.dataset\.agentMsgOriginalText/)
})

test('移除 DOM 子树时只查询其中的插件节点，不遍历全部已跟踪元素', () => {
  const cleanup = source.slice(source.indexOf('function cleanupRoots'), source.indexOf('function restoreSender'))
  assert.match(cleanup, /querySelectorAll\("\.agent-msg-session-link"\)/)
  assert.doesNotMatch(cleanup, /sessionLinks\.forEach/)
})
