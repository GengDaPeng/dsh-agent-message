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
    whenIdle() { return Promise.resolve() },
    title,
  }
}

function setup({ agents: initialAgents = [], services = {}, config = {} } = {}) {
  const agentMap = new Map(initialAgents.map((agent) => [String(agent.id), agent]))
  const tools = new Map()
  const listeners = new Map()
  const effects = []
  const ctx = {
    agents: {
      get: (id) => agentMap.get(String(id)),
      list: () => [...agentMap.values()],
      resume: services.resumeAgent,
    },
    tools: { register: (tool) => tools.set(tool.name, tool) },
    get(name) {
      if (name === 'workspaceRegistry') return services.workspaceRegistry ?? { archivedSessionIds: [] }
      if (name === 'sessionTitle') return services.sessionTitle ?? { get: (session) => ({ title: session.agentTitle ?? '发送者' }) }
      return services[name]
    },
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup !== 'function') return cleanup
      let active = true
      const dispose = async () => {
        if (!active) return
        active = false
        await cleanup()
      }
      effects.push(dispose)
      return dispose
    },
    on: (name, listener) => listeners.set(name, listener),
  }
  apply(ctx, config)
  return {
    tools,
    listeners,
    agentMap,
    async dispose() {
      for (const effect of effects.reverse()) await effect()
    },
  }
}

test('@会话引用提示只提供稳定定位并由整句意图决定动作', () => {
  let section
  setup({
    services: {
      systemPrompt: {
        section(value) {
          section = value
          return () => {}
        },
      },
    },
  })

  assert.equal(section.name, 'plugin:dsh-agent-message')
  assert.match(section.text, /@session-\.\.\./)
  assert.match(section.text, /send_agent_message/)
  assert.match(section.text, /完整 session ID/)
  assert.match(section.text, /定位符/)
  assert.match(section.text, /搜索\/读取/)
  assert.match(section.text, /不要仅凭 @ 自动发送/)
  assert.match(section.text, /不要代为执行/)
})

test('默认发送给在线会话进入独立下一 turn', async () => {
  const sender = liveAgent('session-sender')
  const target = liveAgent('session-target')
  const { tools } = setup({ agents: [sender, target] })

  const result = await tools.get('send_agent_message').execute(
    { to: 'session-target', content: '新请求' },
    { agent: sender },
  )

  assert.equal(result.mode, 'followup')
  assert.equal(target.inbox.nextTurn.length, 1)
  assert.equal(target.inbox.nextStep.length, 0)
})

test('发送工具不再暴露 leave/wake 模式', async () => {
  const sender = liveAgent('sender')
  const target = liveAgent('target')
  const { tools } = setup({ agents: [sender, target] })
  const send = tools.get('send_agent_message')

  assert.deepEqual(send.parameters.properties.mode.enum, ['followup', 'inject', 'steer'])
  await assert.rejects(send.execute(
    { to: 'target', content: '稍后处理', mode: 'leave' },
    { agent: sender },
  ), /must be one of/)
})

test('inject 和 steer 仅按显式模式进入在线会话的 next-step', async () => {
  const sender = liveAgent('session-sender')
  const injectTarget = liveAgent('session-inject')
  const steerTarget = liveAgent('session-steer')
  const { tools } = setup({ agents: [sender, injectTarget, steerTarget] })
  const send = tools.get('send_agent_message')

  await send.execute({ to: 'session-inject', content: '安静背景', mode: 'inject' }, { agent: sender })
  await send.execute({ to: 'session-steer', content: '立即纠正', mode: 'steer' }, { agent: sender })

  assert.equal(injectTarget.inbox.nextStep.length, 1)
  assert.equal(injectTarget.wakeCount, 0)
  assert.equal(steerTarget.inbox.nextStep.length, 1)
  assert.equal(steerTarget.wakeCount, 1)
})

test('离线会话拒绝 inject 和 steer 且不会被恢复', async () => {
  const sender = liveAgent('session-sender')
  let resumes = 0
  const { tools } = setup({
    agents: [sender],
    services: {
      sessionPersistence: { list: async () => [{ id: 'session-target' }] },
      resumeAgent: async () => { resumes += 1 },
    },
  })
  const send = tools.get('send_agent_message')

  await assert.rejects(
    send.execute({ to: 'session-target', content: '安静背景', mode: 'inject' }, { agent: sender }),
    /inject 仅用于在线会话/,
  )
  await assert.rejects(
    send.execute({ to: 'session-target', content: '立即纠正', mode: 'steer' }, { agent: sender }),
    /steer 仅用于在线会话/,
  )
  assert.equal(resumes, 0)
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

  assert.match(target.inbox.nextTurn[0].content[0].text, /^From Session · 发送者: @session-sender\n请回复$/)
  assert.deepEqual(target.inbox.nextTurn[0].source, {
    kind: 'user',
    plugin: 'dsh-agent-message',
    form: 'user',
    senderSessionId: 'session-sender',
    senderTitle: '发送者',
  })
})

test('relay 与 user 共用完整发送者来源字段', async () => {
  const sender = liveAgent('session-sender')
  sender.session.agentTitle = '发送者'
  const target = liveAgent('session-target')
  const { tools } = setup({ agents: [sender, target], config: { form: 'relay' } })

  await tools.get('send_agent_message').execute(
    { to: 'session-target', content: '上下文消息' },
    { agent: sender },
  )

  assert.equal(target.inbox.nextTurn[0].content[0].text, '上下文消息')
  assert.deepEqual(target.inbox.nextTurn[0].source, {
    kind: 'plugin',
    plugin: 'dsh-agent-message',
    form: 'relay',
    senderSessionId: 'session-sender',
    senderTitle: '发送者',
  })
})

test('会话列表合并在线与离线记录并过滤归档', async () => {
  const self = liveAgent('session-self')
  const running = liveAgent('session-running')
  running.status = 'running'
  const headers = [
    { id: 'session-offline', cwd: '/offline', parentSession: 'session-parent' },
    { id: 'session-archived', cwd: '/archived' },
  ]
  const titles = new Map([
    ['session-self', '自己'],
    ['session-running', '运行中'],
    ['session-offline', '离线子会话'],
  ])
  const { tools } = setup({
    agents: [self, running],
    services: {
      sessionPersistence: { list: async () => headers },
      workspaceRegistry: { archivedSessionIds: ['session-archived'] },
      sessionQuery: {
        readTitleSnapshots: async (ids) => ids.map((id) => ({
          sessionId: id,
          status: 'fulfilled',
          value: { title: { title: titles.get(id) } },
        })),
      },
    },
  })

  const result = await tools.get('list_peer_agents').execute({}, { agent: self })

  assert.deepEqual(result, [
    { id: 'session-running', title: '运行中', cwd: '/tmp', status: 'running', kind: 'peer', self: false },
    { id: 'session-self', title: '自己', cwd: '/tmp', status: 'idle', kind: 'peer', self: true },
    { id: 'session-offline', title: '离线子会话', cwd: '/offline', status: 'offline', kind: 'subagent', self: false },
  ])
})

test('会话恢复不会通过私有驱动唤醒历史留言', () => {
  const pluginPending = liveAgent('session-plugin')
  pluginPending.inbox.nextTurn.push({ id: 'ours', source: { kind: 'user', plugin: 'dsh-agent-message' } })
  const { listeners } = setup()
  const onSessionStart = listeners.get('agent/session-start')

  onSessionStart?.({ agent: pluginPending })

  assert.equal(pluginPending.wakeCount, 0)
})

test('默认发送会恢复离线会话并在空闲后释放 handle', async () => {
  const sender = liveAgent('session-sender')
  const resumed = liveAgent('session-target')
  const idle = Promise.withResolvers()
  resumed.whenIdle = () => idle.promise
  let disposals = 0
  const persistence = {
    list: async () => [{ id: 'session-target' }],
    inspect: async () => ({ meta: {}, events: [] }),
  }
  const { tools } = setup({
    agents: [sender],
    services: {
      sessionPersistence: persistence,
      resumeAgent: async (options) => {
        assert.equal(options.resumeSessionId, 'session-target')
        return { agent: resumed, dispose: async () => { disposals += 1 } }
      },
    },
  })

  const result = await tools.get('send_agent_message').execute(
    { to: 'session-target', content: '请立即处理' },
    { agent: sender },
  )

  assert.equal(result.mode, 'followup')
  assert.equal(resumed.inbox.nextTurn.length, 1)
  assert.equal(resumed.wakeCount, 1)
  assert.equal(disposals, 0)

  idle.resolve()
  await idle.promise
  await Promise.resolve()
  assert.equal(disposals, 1)
})

test('插件卸载会释放尚未空闲的恢复 handle', async () => {
  const sender = liveAgent('session-sender')
  const resumed = liveAgent('session-target')
  const idle = Promise.withResolvers()
  resumed.whenIdle = () => idle.promise
  let disposals = 0
  const harness = setup({
    agents: [sender],
    services: {
      sessionPersistence: {
        list: async () => [{ id: 'session-target' }],
        inspect: async () => ({ meta: {}, events: [] }),
      },
      resumeAgent: async () => ({
        agent: resumed,
        dispose: async () => { disposals += 1 },
      }),
    },
  })

  await harness.tools.get('send_agent_message').execute(
    { to: 'session-target', content: '待完成请求' },
    { agent: sender },
  )
  await harness.dispose()

  assert.equal(disposals, 1)
  idle.resolve()
  await idle.promise
  await Promise.resolve()
  assert.equal(disposals, 1)
})

test('离线恢复失败时返回失败且不伪造 Inbox 留言', async () => {
  const sender = liveAgent('session-sender')
  let appends = 0
  const persistence = {
    list: async () => [{ id: 'session-target' }],
    inspect: async () => ({ meta: {}, events: [] }),
    append: async () => { appends += 1 },
  }
  const { tools } = setup({
    agents: [sender],
    services: {
      sessionPersistence: persistence,
      resumeAgent: async () => { throw new Error('模型不可用') },
    },
  })

  await assert.rejects(tools.get('send_agent_message').execute(
    { to: 'session-target', content: '失败后留言' },
    { agent: sender },
  ), /模型不可用/)

  assert.equal(appends, 0)
})

test('归档、未知和自身会话在发送边界被拒绝', async () => {
  const sender = liveAgent('session-sender')
  const { tools } = setup({
    agents: [sender],
    services: {
      sessionPersistence: { list: async () => [] },
      workspaceRegistry: { archivedSessionIds: ['session-archived'] },
    },
  })
  const send = (to) => tools.get('send_agent_message').execute(
    { to, content: '不应送达' },
    { agent: sender },
  )

  await assert.rejects(send('session-sender'), /不能给自己发消息/)
  await assert.rejects(send('session-archived'), /对方会话已归档/)
  await assert.rejects(send('session-missing'), /会话不存在/)
})

test('消息被认领后不因目标正在运行而夸大为 processing', async () => {
  const sender = liveAgent('session-sender')
  const target = liveAgent('session-target')
  const { tools } = setup({ agents: [sender, target] })
  const sent = await tools.get('send_agent_message').execute(
    { to: 'session-target', content: '回执测试' },
    { agent: sender },
  )
  const message = target.inbox.nextTurn.shift()
  target.status = 'running'
  target.session.events = [
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
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

test('重启后凭 messageId 从目标日志恢复回执', async () => {
  const persistence = {
    readFrom: async () => ({
      meta: { seedLength: 0 },
      events: [{
        seq: 0,
        type: 'agent/inbox/spliced',
        data: {
          target: 'next-turn',
          start: 0,
          inserted: [{ id: 'agent-msg-before-restart' }],
        },
      }],
    }),
  }
  const { tools } = setup({ services: { sessionPersistence: persistence } })

  const result = await tools.get('check_delivery').execute({
    to: 'session-target',
    messageId: 'agent-msg-before-restart',
  })

  assert.deepEqual(result, {
    to: 'session-target',
    entries: [{ messageId: 'agent-msg-before-restart', state: 'delivered', targetStatus: 'offline' }],
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
          data: { target: 'next-turn', start: 0, inserted: target.inbox.nextTurn },
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
