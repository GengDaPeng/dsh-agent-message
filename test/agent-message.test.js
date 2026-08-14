import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.js'

function liveAgent(id, title = id) {
  const nextTurn = []
  const nextStep = []
  return {
    id,
    status: 'idle',
    wakeCount: 0,
    session: { header: { cwd: '/tmp' }, events: [] },
    inbox: {
      nextTurn,
      nextStep,
      get hasPending() { return nextTurn.length > 0 || nextStep.length > 0 },
      append(target, message) { (target === 'next-turn' ? nextTurn : nextStep).push(message) },
    },
    followup(message) { nextTurn.push(message); this.wakeCount += 1 },
    steer(message) { nextStep.push(message); this.wakeCount += 1 },
    inject(message) { nextStep.push(message) },
    wakeDriver() { this.wakeCount += 1 },
    title,
  }
}

function setup({ agents: initialAgents = [], services = {} } = {}) {
  const agentMap = new Map(initialAgents.map((agent) => [String(agent.id), agent]))
  const tools = new Map()
  const listeners = new Map()
  const ctx = {
    agents: {
      get: (id) => agentMap.get(String(id)),
      list: () => [...agentMap.values()],
    },
    tools: { register: (tool) => tools.set(tool.name, tool) },
    get(name) {
      if (name === 'workspaceRegistry') return { archivedSessionIds: [] }
      if (name === 'sessionTitle') return { get: (session) => ({ title: session.agentTitle ?? '发送者' }) }
      return services[name]
    },
    on: (name, listener) => listeners.set(name, listener),
  }
  apply(ctx, {})
  return { tools, listeners, agentMap }
}

test('leave 给在线会话排队但不唤醒', async () => {
  const sender = liveAgent('sender')
  sender.session.agentTitle = '发送者'
  const target = liveAgent('target')
  const { tools } = setup({ agents: [sender, target] })

  await tools.get('send_agent_message').execute(
    { to: 'target', content: '稍后处理', mode: 'leave' },
    { agent: sender },
  )

  assert.equal(target.inbox.nextTurn.length, 1)
  assert.equal(target.wakeCount, 0)
})

test('接收消息头包含可用于回复的稳定发送者会话 ID', async () => {
  const sender = liveAgent('session-sender')
  sender.session.agentTitle = '发送者'
  const target = liveAgent('session-target')
  const { tools } = setup({ agents: [sender, target] })

  await tools.get('send_agent_message').execute(
    { to: 'session-target', content: '请回复' },
    { agent: sender },
  )

  assert.match(target.inbox.nextStep[0].content[0].text, /^From Agent · 发送者: @session-sender\n请回复$/)
})

test('会话恢复只唤醒本插件排队的消息', () => {
  const otherPending = liveAgent('session-other')
  otherPending.inbox.nextStep.push({ id: 'other', source: { kind: 'plugin', plugin: 'other-plugin' } })
  const pluginPending = liveAgent('session-plugin')
  pluginPending.inbox.nextTurn.push({ id: 'ours', source: { kind: 'user', plugin: 'dsh-agent-message' } })
  const { listeners } = setup()
  const onSessionStart = listeners.get('agent/session-start')

  onSessionStart({ agent: otherPending })
  onSessionStart({ agent: pluginPending })

  assert.equal(otherPending.wakeCount, 0)
  assert.equal(pluginPending.wakeCount, 1)
})

test('离线留言遇到序号竞争时重新读取并重试一次', async () => {
  const sender = liveAgent('session-sender')
  let reads = 0
  let appends = 0
  const persistence = {
    list: async () => [{ id: 'session-target' }],
    readFrom: async () => {
      reads += 1
      return { meta: { seedLength: 0 }, events: [] }
    },
    append: async () => {
      appends += 1
      if (appends === 1) throw new Error('append seq mismatch for "session-target"')
    },
  }
  const { tools } = setup({ agents: [sender], services: { sessionPersistence: persistence } })

  const result = await tools.get('send_agent_message').execute(
    { to: 'session-target', content: '并发留言', mode: 'leave' },
    { agent: sender },
  )

  assert.equal(result.ok, true)
  assert.equal(reads, 2)
  assert.equal(appends, 2)
})

test('消息被认领后不因目标正在运行而夸大为 processing', async () => {
  const sender = liveAgent('session-sender')
  const target = liveAgent('session-target')
  const { tools } = setup({ agents: [sender, target] })
  const sent = await tools.get('send_agent_message').execute(
    { to: 'session-target', content: '回执测试' },
    { agent: sender },
  )
  const message = target.inbox.nextStep.shift()
  target.status = 'running'
  target.session.events = [
    { type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: [message] } },
    { type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] } },
  ]

  const result = await tools.get('check_delivery').execute({
    to: 'session-target',
    messageId: sent.messageId,
  }, { agent: sender })

  assert.equal(result.entries[0].state, 'claimed')
  assert.equal(result.entries[0].targetStatus, 'running')
})

test('查询未记账的指定消息时显式返回 unknown', async () => {
  const sender = liveAgent('session-sender')
  const target = liveAgent('session-target')
  const { tools } = setup({ agents: [sender, target] })

  const result = await tools.get('check_delivery').execute({
    to: 'session-target',
    messageId: 'agent-msg-missing',
  }, { agent: sender })

  assert.deepEqual(result, {
    to: 'session-target',
    entries: [{ messageId: 'agent-msg-missing', state: 'unknown', targetStatus: 'idle' }],
  })
})

test('批量查询同一离线会话的回执只读取一次日志', async () => {
  const sender = liveAgent('session-sender')
  const target = liveAgent('session-target')
  let reads = 0
  const persistence = {
    readFrom: async () => {
      reads += 1
      return {
        meta: { seedLength: 0 },
        events: [{
          seq: 0,
          type: 'agent/inbox/spliced',
          data: { target: 'next-step', start: 0, inserted: target.inbox.nextStep },
        }],
      }
    },
  }
  const { tools, agentMap } = setup({
    agents: [sender, target],
    services: { sessionPersistence: persistence },
  })
  await tools.get('send_agent_message').execute(
    { to: 'session-target', content: '第一条' },
    { agent: sender },
  )
  await tools.get('send_agent_message').execute(
    { to: 'session-target', content: '第二条' },
    { agent: sender },
  )
  agentMap.delete('session-target')

  const result = await tools.get('check_delivery').execute(
    { to: 'session-target' },
    { agent: sender },
  )

  assert.equal(result.entries.length, 2)
  assert.deepEqual(result.entries.map((entry) => entry.state), ['delivered', 'delivered'])
  assert.equal(reads, 1)
})
