import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject } from '../lib/index.js'

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

test('插件不注册全局提示，发送语义只存在于工具合同', () => {
  let sections = 0
  setup({
    services: {
      systemPrompt: {
        section() {
          sections += 1
          return () => {}
        },
      },
    },
  })

  assert.equal(sections, 0)
  assert.deepEqual(inject, ['agents', 'tools', 'sessionQuery'])
})

test('默认 followup 允许 idle 会话并进入独立下一 turn', async () => {
  const sender = liveAgent('session-sender')
  const target = liveAgent('session-target')
  const { tools } = setup({ agents: [sender, target] })
  const send = tools.get('send_agent_message')

  assert.match(send.description, /当前请求或用户已授予的编排职责/)
  assert.match(send.description, /@session.*只提供目标.*不代表发送/)
  assert.doesNotMatch(send.description, /读取、搜索、分析、比较|意图不明确时先询问/)
  assert.match(send.description, /正文明确要求.*发送方.*才.*回复/)
  assert.match(send.description, /不要.*transport ack.*“收到”/)
  assert.match(send.description, /立即介入.*steer/)
  assert.match(send.description, /不打断.*补充.*inject/)
  assert.match(send.description, /不确定.*followup/)
  assert.match(send.description, /无需.*模式名/)
  assert.doesNotMatch(send.description, /replyPolicy|结果留在目标会话|普通回复/)
  assert.match(send.parameters.properties.content.description, /不要自行追加.*“收到”/)

  const result = await send.execute(
    { to: 'session-target', content: '新请求' },
    { agent: sender },
  )

  assert.equal(result.mode, 'followup')
  assert.equal(result.state, 'accepted')
  assert.equal(result.targetRuntimeStatus, 'idle')
  assert.match(result.text, /已接受投递/)
  assert.match(result.text, /不表示.*已读.*回复.*完成/)
  assert.doesNotMatch(result.text, /结果默认留在目标会话/)
  assert.equal(target.inbox.nextTurn.length, 1)
  assert.equal(target.inbox.nextStep.length, 0)
})

test('默认 followup 允许 running 会话并保持独立 next-turn', async () => {
  const sender = liveAgent('session-sender')
  const target = liveAgent('session-running')
  target.status = 'running'
  const { tools } = setup({ agents: [sender, target] })

  const result = await tools.get('send_agent_message').execute(
    { to: 'session-running', content: '排队任务' },
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

test('running 会话接受 inject 和 steer 进入 next-step', async () => {
  const sender = liveAgent('session-sender')
  const injectTarget = liveAgent('session-inject')
  const steerTarget = liveAgent('session-steer')
  injectTarget.status = 'running'
  steerTarget.status = 'running'
  const { tools } = setup({ agents: [sender, injectTarget, steerTarget] })
  const send = tools.get('send_agent_message')

  await send.execute({ to: 'session-inject', content: '安静背景', mode: 'inject' }, { agent: sender })
  await send.execute({ to: 'session-steer', content: '立即纠正', mode: 'steer' }, { agent: sender })

  assert.equal(injectTarget.inbox.nextStep.length, 1)
  assert.equal(injectTarget.wakeCount, 0)
  assert.equal(steerTarget.inbox.nextStep.length, 1)
  assert.equal(steerTarget.wakeCount, 1)
})

test('idle 会话拒绝 inject 和 steer 且不改变 Inbox', async () => {
  const sender = liveAgent('session-sender')
  const target = liveAgent('session-idle')
  const { tools } = setup({ agents: [sender, target] })
  const send = tools.get('send_agent_message')

  for (const mode of ['inject', 'steer']) {
    await assert.rejects(
      send.execute({ to: 'session-idle', content: '不应投递', mode }, { agent: sender }),
      new RegExp(mode + ' 仅用于 running 会话'),
    )
  }
  assert.equal(target.inbox.nextStep.length, 0)
})

test('离线会话拒绝 inject 和 steer 且不会被恢复', async () => {
  const sender = liveAgent('session-sender')
  let resumes = 0
  const { tools } = setup({
    agents: [sender],
    services: {
      sessionQuery: { readSession: async () => ({ session: { id: 'session-target' }, events: [] }) },
      resumeAgent: async () => { resumes += 1 },
    },
  })
  const send = tools.get('send_agent_message')

  await assert.rejects(
    send.execute({ to: 'session-target', content: '安静背景', mode: 'inject' }, { agent: sender }),
    /inject 仅用于 running 会话/,
  )
  await assert.rejects(
    send.execute({ to: 'session-target', content: '立即纠正', mode: 'steer' }, { agent: sender }),
    /steer 仅用于 running 会话/,
  )
  assert.equal(resumes, 0)
})

test('发送工具投递不可变的原生 relay UserMessage 并返回同一 ID', async () => {
  const sender = liveAgent('session-sender')
  sender.session.agentTitle = '发送者'
  const target = liveAgent('session-target')
  const { tools } = setup({ agents: [sender, target] })

  const result = await tools.get('send_agent_message').execute(
    { to: 'session-target', content: '请处理' },
    { agent: sender },
  )

  const message = target.inbox.nextTurn[0]
  assert.equal(result.messageId, message.id)
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(message.role, 'user')
  const [header, body] = message.content[0].text.split('\n\n')
  assert.equal(body, '请处理')
  assert.deepEqual(JSON.parse(header.slice('<dsh-agent-message>'.length, -'</dsh-agent-message>'.length)), {
    senderSessionId: 'session-sender',
  })
  assert.equal(Object.isFrozen(message), true)
  assert.equal(Object.isFrozen(message.content), true)
  assert.deepEqual(message.source, {
    kind: 'dsh-agent-message',
    form: 'relay',
    protocolVersion: 1,
    senderSessionId: 'session-sender',
    targetSessionId: 'session-target',
    senderTitle: '发送者',
  })
})

test('旧 form 配置不能把 Agent 消息改写成人类 user 来源', async () => {
  const sender = liveAgent('session-sender')
  sender.session.agentTitle = '发送者'
  const target = liveAgent('session-target')
  const { tools } = setup({ agents: [sender, target], config: { form: 'user' } })

  await tools.get('send_agent_message').execute(
    { to: 'session-target', content: '上下文消息' },
    { agent: sender },
  )

  assert.match(target.inbox.nextTurn[0].content[0].text, /<\/dsh-agent-message>\n\n上下文消息$/)
  assert.deepEqual(target.inbox.nextTurn[0].source, {
    kind: 'dsh-agent-message',
    form: 'relay',
    protocolVersion: 1,
    senderSessionId: 'session-sender',
    targetSessionId: 'session-target',
    senderTitle: '发送者',
  })
})

test('会话列表使用 sessionQuery，保留普通 fork 并过滤真子代理与归档', async () => {
  const self = liveAgent('session-self')
  const running = liveAgent('session-running')
  running.status = 'running'
  const records = [
    { header: { id: 'session-self', cwd: '/self' }, live: true, persisted: true },
    { header: { id: 'session-running', cwd: '/running' }, live: true, persisted: true },
    { header: { id: 'session-fork', cwd: '/fork', parentSession: 'session-parent' }, live: false, persisted: true },
    { header: { id: 'session-subagent', cwd: '/child', parentSession: 'session-parent', origin: 'subagent' }, live: false, persisted: true },
    { header: { id: 'session-archived', cwd: '/archived' }, live: false, persisted: true },
  ]
  const titles = new Map([
    ['session-self', '自己'],
    ['session-running', '运行中'],
    ['session-fork', '独立分叉会话'],
  ])
  let listCalls = 0
  let titleIds
  const { tools } = setup({
    agents: [self, running],
    services: {
      workspaceRegistry: { archivedSessionIds: ['session-archived'] },
      sessionQuery: {
        listSessions: async () => { listCalls += 1; return records },
        readTitleSnapshots: async (ids) => {
          titleIds = ids
          return ids.map((id) => ({
            sessionId: id,
            status: 'fulfilled',
            value: { session: records.find((record) => record.header.id === id).header, title: { title: titles.get(id) } },
          }))
        },
      },
    },
  })

  const result = await tools.get('list_peer_agents').execute({}, { agent: self })

  assert.deepEqual(result, [
    { id: 'session-running', title: '运行中', cwd: '/running', status: 'running', kind: 'peer', self: false },
    { id: 'session-self', title: '自己', cwd: '/self', status: 'idle', kind: 'peer', self: true },
    { id: 'session-fork', title: '独立分叉会话', cwd: '/fork', status: 'offline', kind: 'peer', self: false },
  ])
  assert.equal(listCalls, 1)
  assert.deepEqual(titleIds, ['session-self', 'session-running', 'session-fork'])
})

test('会话恢复不会通过私有驱动唤醒历史留言', () => {
  const pluginPending = liveAgent('session-plugin')
  pluginPending.inbox.nextTurn.push({ id: 'ours', source: { kind: 'user', plugin: 'dsh-agent-message' } })
  const { listeners } = setup()
  const onSessionStart = listeners.get('agent/session-start')

  onSessionStart?.({ agent: pluginPending })

  assert.equal(pluginPending.wakeCount, 0)
})

test('默认发送会恢复离线会话，空闲后保持加载并在插件卸载时释放 handle', async () => {
  const sender = liveAgent('session-sender')
  const resumed = liveAgent('session-target')
  const idle = Promise.withResolvers()
  resumed.whenIdle = () => idle.promise
  let disposals = 0
  let reads = 0
  let resumes = 0
  const sessionQuery = {
    readSession: async () => {
      reads += 1
      return { session: { id: 'session-target', parentSession: 'session-parent' }, events: [] }
    },
  }
  const harness = setup({
    agents: [sender],
    services: {
      sessionQuery,
      resumeAgent: async (options) => {
        resumes += 1
        assert.equal(options.resumeSessionId, 'session-target')
        return { agent: resumed, dispose: async () => { disposals += 1 } }
      },
    },
  })

  const result = await harness.tools.get('send_agent_message').execute(
    { to: 'session-target', content: '请立即处理' },
    { agent: sender },
  )

  assert.equal(result.mode, 'followup')
  assert.equal(resumed.inbox.nextTurn.length, 1)
  assert.equal(resumed.wakeCount, 1)
  assert.equal(reads, 1)
  assert.equal(disposals, 0)

  idle.resolve()
  await idle.promise
  await Promise.resolve()
  assert.equal(disposals, 0)

  await harness.tools.get('send_agent_message').execute(
    { to: 'session-target', content: '第二条请求' },
    { agent: sender },
  )
  assert.equal(resumes, 1)
  assert.equal(resumed.inbox.nextTurn.length, 2)

  await harness.dispose()
  assert.equal(disposals, 1)
})

test('离线读取期间目标被 Harness 激活时复用现有 Agent 而不重复恢复', async () => {
  const sender = liveAgent('session-sender')
  const activated = liveAgent('session-target')
  let resumes = 0
  let harness
  harness = setup({
    agents: [sender],
    services: {
      sessionQuery: {
        readSession: async () => {
          harness.agentMap.set('session-target', activated)
          return { session: { id: 'session-target' }, events: [] }
        },
      },
      resumeAgent: async () => {
        resumes += 1
        throw new Error('不应重复恢复已在线会话')
      },
    },
  })

  const result = await harness.tools.get('send_agent_message').execute(
    { to: 'session-target', content: '并发恢复测试' },
    { agent: sender },
  )

  assert.equal(result.state, 'accepted')
  assert.equal(resumes, 0)
  assert.equal(activated.inbox.nextTurn.length, 1)
})

test('恢复竞态由另一个调用先注册目标时改投 Harness 现有 Agent', async () => {
  const sender = liveAgent('session-sender')
  const activated = liveAgent('session-target')
  let harness
  harness = setup({
    agents: [sender],
    services: {
      sessionQuery: { readSession: async () => ({ session: { id: 'session-target' }, events: [] }) },
      resumeAgent: async () => {
        harness.agentMap.set('session-target', activated)
        throw new Error('agent "session-target" is already registered')
      },
    },
  })

  const result = await harness.tools.get('send_agent_message').execute(
    { to: 'session-target', content: '竞态后的消息' },
    { agent: sender },
  )

  assert.equal(result.state, 'accepted')
  assert.equal(activated.inbox.nextTurn.length, 1)
})

test('Harness 销毁已缓存 Agent 后下一次投递会重新恢复目标', async () => {
  const sender = liveAgent('session-sender')
  const first = liveAgent('session-target')
  const second = liveAgent('session-target')
  const resumed = [first, second]
  let resumes = 0
  let harness
  harness = setup({
    agents: [sender],
    services: {
      sessionQuery: { readSession: async () => ({ session: { id: 'session-target' }, events: [] }) },
      resumeAgent: async () => {
        const agent = resumed[resumes++]
        harness.agentMap.set('session-target', agent)
        return { agent, dispose: async () => {} }
      },
    },
  })

  const send = (content) => harness.tools.get('send_agent_message').execute(
    { to: 'session-target', content },
    { agent: sender },
  )
  await send('第一条')
  harness.agentMap.delete('session-target')
  harness.listeners.get('agent/disposed')?.({ agent: first })
  await send('第二条')

  assert.equal(resumes, 2)
  assert.equal(first.inbox.nextTurn.length, 1)
  assert.equal(second.inbox.nextTurn.length, 1)
  await harness.dispose()
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
      sessionQuery: { readSession: async () => ({ session: { id: 'session-target' }, events: [] }) },
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
      sessionQuery: { readSession: async () => ({ session: { id: 'session-target' }, events: [] }) },
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
      sessionQuery: {
        readSession: async () => {
          const error = new Error('not found')
          error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
          throw error
        },
      },
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

test('发送边界保留普通 fork 并拒绝真实子代理', async () => {
  const sender = liveAgent('session-sender')
  const fork = liveAgent('session-fork')
  fork.session.header.parentSession = 'session-parent'
  const subagent = liveAgent('session-subagent')
  subagent.session.header.parentSession = 'session-parent'
  subagent.session.header.origin = 'subagent'
  const { tools } = setup({ agents: [sender, fork, subagent] })
  const send = (to) => tools.get('send_agent_message').execute(
    { to, content: '边界测试' },
    { agent: sender },
  )

  await send('session-fork')
  assert.equal(fork.inbox.nextTurn.length, 1)
  await assert.rejects(send('session-subagent'), /子代理.*不能通过会话通信插件直接发送/)
  assert.equal(subagent.inbox.nextTurn.length, 0)
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
  assert.equal(result.entries[0].targetRuntimeStatus, 'running')
  assert.match(result.receiptMeaning, /claimed.*仅表示.*Inbox.*认领/)
  assert.match(result.receiptMeaning, /不表示.*已读.*回复.*完成/)
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
    receiptMeaning: 'claimed 仅表示目标 turn 已从 Inbox 认领消息；传输回执不表示对方已读、回复或完成。',
    entries: [{ messageId: 'agent-msg-missing', state: 'unknown', targetRuntimeStatus: 'idle' }],
  })
})

test('重启后凭 messageId 从目标日志恢复回执', async () => {
  const sessionQuery = {
    readSession: async () => ({
      session: { id: 'session-target', seedLength: 0 },
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
  const { tools } = setup({ services: { sessionQuery } })

  const result = await tools.get('check_delivery').execute({
    to: 'session-target',
    messageId: 'agent-msg-before-restart',
  })

  assert.deepEqual(result, {
    to: 'session-target',
    receiptMeaning: 'claimed 仅表示目标 turn 已从 Inbox 认领消息；传输回执不表示对方已读、回复或完成。',
    entries: [{ messageId: 'agent-msg-before-restart', state: 'pending', targetRuntimeStatus: 'offline' }],
  })
})

test('批量查询同一离线会话的回执只读取一次日志', async () => {
  const sender = liveAgent('session-sender')
  const target = liveAgent('session-target')
  let reads = 0
  const sessionQuery = {
    readSession: async () => {
      reads += 1
      return {
        session: { id: 'session-target', seedLength: 0 },
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
    services: { sessionQuery },
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
  assert.deepEqual(result.entries.map((entry) => entry.state), ['pending', 'pending'])
  assert.equal(reads, 1)
})
