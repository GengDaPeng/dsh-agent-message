import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm/message'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-agent-message'
export const inject = ['agents', 'tools', 'sessionQuery', 'workspaceRegistry']

export const Config = z.object({
  showTechnicalDetails: z.boolean().default(true).volatile(),
  allowedPairs: z.array(z.object({
    id: z.string(),
    sessions: z.array(z.string()),
    maxMessages: z.number().default(20),
  })).default([]),
})

export function apply(ctx, config = {}) {
  const agents = ctx.agents
  const allowedPairs = new Map()
  const runIds = new Set()
  if (config.allowedPairs !== undefined && !Array.isArray(config.allowedPairs)) throw new Error('allowedPairs must be an array')
  for (const entry of config.allowedPairs ?? []) {
    const sessions = entry?.sessions
    const maxMessages = entry?.maxMessages ?? 20
    if (typeof entry?.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.id) || !Array.isArray(sessions) || sessions.length !== 2 ||
      sessions.some((id) => typeof id !== 'string' || id.length === 0) || sessions[0] === sessions[1] ||
      !Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) {
      throw new Error('invalid allowedPairs: require a run id, two distinct Session IDs and maxMessages 1..100')
    }
    const key = pairKey(...sessions)
    if (allowedPairs.has(key) || runIds.has(entry.id)) throw new Error('duplicate allowedPairs pair or run id')
    allowedPairs.set(key, Object.freeze({ id: entry.id, sessions: Object.freeze([...sessions]), maxMessages }))
    runIds.add(entry.id)
  }
  // Serialize each pair's budget check and native delivery; no separate durable mailbox.
  const pairDeliveries = new Map()
  /** messageId -> { from, to, at, mode }；只允许调用方查询自己的投递。 */
  const sent = new Map()
  /** 记账表 FIFO 上限：超过则淘汰最老记录，内存恒定。 */
  const SENT_MAX = 1000
  const PAIR_MESSAGE_LIMIT = 10
  const PAIR_WINDOW_MS = 60_000
  const receiptMeaning = 'claimed 仅表示目标 turn 已从 Inbox 认领消息；传输回执不表示对方已读、回复或完成。'
  /** 插件恢复的 Session handle；保留到插件卸载，避免 idle dispose 移除 Harness store 投影。 */
  const resumedHandles = new Map()
  /** 无向 Session 对 -> 最近成功或正在进行的投递预留；只保护当前 Harness 进程。 */
  const pairSends = new Map()
  let lastPairPruneAt = 0

  // rc.2 Settings projects volatile fields from this plugin's live Config.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (child) => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)))
  }

  ctx.effect(() => async () => {
    const handles = [...resumedHandles.values()]
    resumedHandles.clear()
    const settled = await Promise.allSettled(handles.map(async (pending) => (await pending).dispose()))
    for (const result of settled) {
      if (result.status === 'rejected') ctx.logger?.warn?.('释放恢复会话失败：' + String(result.reason))
    }
  }, 'dsh-agent-message: resumed agent handles')

  ctx.on('agent/disposed', ({ agent }) => {
    const key = String(agent.id)
    const pending = resumedHandles.get(key)
    if (pending === undefined) return
    pending.then((handle) => {
      if (handle.agent === agent && resumedHandles.get(key) === pending) resumedHandles.delete(key)
    }, () => {})
  })

  function pairKey(from, to) {
    return JSON.stringify([String(from), String(to)].sort())
  }

  function rememberSent(messageId, from, to, mode) {
    sent.set(messageId, { from, to, at: Date.now(), mode })
    if (sent.size > SENT_MAX) sent.delete(sent.keys().next().value)
  }

  function reservePairSend(from, to) {
    const now = Date.now()
    if (now < lastPairPruneAt || now - lastPairPruneAt >= PAIR_WINDOW_MS) {
      for (const [key, entries] of pairSends) {
        const active = entries.filter((entry) => now - entry.at < PAIR_WINDOW_MS)
        if (active.length === 0) pairSends.delete(key)
        else pairSends.set(key, active)
      }
      lastPairPruneAt = now
    }
    const key = pairKey(from, to)
    const recent = (pairSends.get(key) ?? []).filter((entry) => now - entry.at < PAIR_WINDOW_MS)
    if (recent.length >= PAIR_MESSAGE_LIMIT) {
      pairSends.set(key, recent)
      throw new Error('同一对会话 60 秒内最多投递 10 条消息，请稍后再试')
    }
    const reservation = { at: now }
    recent.push(reservation)
    pairSends.set(key, recent)
    return () => {
      const current = pairSends.get(key)
      if (current === undefined) return
      const index = current.indexOf(reservation)
      if (index !== -1) current.splice(index, 1)
      if (current.length === 0) pairSends.delete(key)
    }
  }

  function titleOf(agent) {
    const service = ctx.get('sessionTitle')
    if (service !== undefined) {
      try {
        const snapshot = service.get(agent.session)
        if (snapshot && typeof snapshot.title === 'string') return snapshot.title
      } catch (_) {}
    }
    return ''
  }

  /** 折叠日志里的 agent/inbox/spliced 事件，得到当前 inbox 状态 + 已认领/已丢弃集合。 */
  function foldInbox(events) {
    const state = { 'next-turn': [], 'next-step': [], claimed: new Set(), discarded: new Set(), messages: new Map() }
    for (const ev of events) {
      if (ev.type !== 'agent/inbox/spliced') continue
      const s = ev.data
      for (const message of s.inserted) state.messages.set(message.id, message)
      const list = state[s.target] ?? []
      const removed = list.splice(s.start, s.removedCount ?? 0, ...s.inserted)
      const bucket = s.outcome === 'canceled' ? state.discarded : state.claimed
      for (const m of removed) bucket.add(m.id)
    }
    return state
  }

  function archivedIds() {
    const workspace = ctx.get('workspaceRegistry')
    if (!Array.isArray(workspace?.archivedSessionIds)) throw new Error('缺少 workspaceRegistry，跨会话权限关闭')
    return new Set(workspace.archivedSessionIds.map((id) => String(id)))
  }

  function isSubagentSession(header) {
    return header?.origin === 'subagent'
  }

  function assertPeerCaller(agent) {
    if (agent === undefined) throw new Error('no calling agent')
    if (isSubagentSession(agent.session.header)) {
      throw new Error('子代理不能使用独立会话通信工具')
    }
    if (typeof agent.session?.header?.cwd !== 'string' || agent.session.header.cwd === '' ||
      String(agent.session.header.id) !== String(agent.id) || archivedIds().has(String(agent.id))) throw peerDenied()
  }

  function assertPair(agent, id, signal) {
    signal?.throwIfAborted()
    assertPeerCaller(agent)
    const pair = allowedPairs.get(pairKey(agent.id, id))
    if (typeof id !== 'string' || !pair || id === String(agent.id) || archivedIds().has(id)) throw peerDenied()
    const live = agents.get(id)
    if (live !== undefined) assertPeerHeader(live.session?.header, id, agent.session.header.cwd)
    return pair
  }

  function assertSnapshot(snapshot, id, cwd) {
    assertPeerHeader(snapshot?.session, id, cwd)
    if (!Array.isArray(snapshot.events) || !Number.isSafeInteger(snapshot.inheritedEventCount) ||
      snapshot.inheritedEventCount < 0 || snapshot.inheritedEventCount > snapshot.events.length) throw peerDenied()
    return snapshot.events.slice(snapshot.inheritedEventCount)
  }

  async function withPairDelivery(pair, signal, operation) {
    const previous = pairDeliveries.get(pair.id) ?? Promise.resolve()
    const ready = Promise.withResolvers()
    const pending = previous.then(() => ready.promise)
    pairDeliveries.set(pair.id, pending)
    try {
      await previous
      signal?.throwIfAborted()
      return await operation()
    } finally {
      ready.resolve()
      if (pairDeliveries.get(pair.id) === pending) pairDeliveries.delete(pair.id)
    }
  }

  async function checkMessageBudget(pair, me, to, signal) {
    const messages = new Set()
    let targetSnapshot
    for (const id of pair.sessions) {
      assertPair(me, to, signal)
      const snapshot = await readLogicalSession(id, signal)
      assertPair(me, to, signal)
      const events = assertSnapshot(snapshot, id, me.session.header.cwd)
      if (id === to) targetSnapshot = snapshot
      for (const event of events) {
        if (event.type !== 'agent/inbox/spliced') continue
        for (const message of event.data.inserted) {
          const source = message.source
          if (source?.kind === name && source.coordinationId === pair.id &&
            source.targetSessionId === id && source.senderSessionId === pair.sessions.find((peer) => peer !== id)) messages.add(message.id)
        }
      }
    }
    if (messages.size >= pair.maxMessages) throw new Error('该协作配对的消息预算已用尽；请由用户结束任务或配置新的协作 id')
    return targetSnapshot
  }

  function sessionQuery() {
    const query = ctx.get('sessionQuery')
    if (query === undefined) throw new Error('本部署缺少 sessionQuery，无法查询逻辑会话')
    return query
  }

  async function readLogicalSession(id, signal) {
    signal?.throwIfAborted()
    try {
      // rc.2 readSession has no signal parameter: check cancellation on both sides of its await.
      const snapshot = await sessionQuery().readSession(id)
      signal?.throwIfAborted()
      return snapshot
    } catch (error) {
      signal?.throwIfAborted()
      if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined
      throw error
    }
  }

  function peerDenied() {
    return new Error('无权访问该协作会话')
  }

  function assertPeerHeader(header, sessionId, cwd) {
    if (String(header?.id) !== sessionId || header?.cwd !== cwd || isSubagentSession(header)) {
      throw peerDenied()
    }
    return header
  }

  /** 冷会话投递：公开 resume + followup；同一 Session 复用 handle，仅在插件卸载时释放。 */
  async function resumeAndFollowup(id, message, inspected, me, signal) {
    assertPair(me, id, signal)
    const existing = agents.get(id)
    if (existing !== undefined) {
      existing.followup(message)
      return existing
    }
    const key = String(id)
    let pending = resumedHandles.get(key)
    let created = false
    if (pending === undefined) {
      created = true
      let presetId = inspected.session.agentPreset
      const events = inspected.events ?? []
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]
        if (ev && ev.type === 'agent-preset/selected') {
          presetId = ev.data.agentPreset
          break
        }
      }
      const presets = ctx.get('agentPresets')
      const defaultModel = ctx.get('agentDefaultModel')
      const selection = defaultModel !== undefined ? defaultModel.currentSelection() : { provider: '', model: '' }
      pending = agents.resume({
        resumeSessionId: id,
        signal,
        agentOptions: { provider: selection.provider ?? '', model: selection.model ?? '' },
        setup: async (agentCtx, agent) => {
          assertPair(me, id, signal)
          assertPeerHeader(agent.session.header, id, me.session.header.cwd)
          if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
          assertPair(me, id, signal)
          return { commit() {
            assertPair(me, id, signal)
            assertPeerHeader(agent.session.header, id, me.session.header.cwd)
          } }
        },
      })
      resumedHandles.set(key, pending)
      pending.catch(() => {
        if (resumedHandles.get(key) === pending) resumedHandles.delete(key)
      })
    }

    let handle
    try {
      handle = await pending
    } catch (error) {
      assertPair(me, id, signal)
      const concurrent = agents.get(id)
      if (concurrent === undefined) throw error
      concurrent.followup(message)
      return concurrent
    }
    try {
      assertPair(me, id, signal)
      assertPeerHeader(handle.agent.session.header, id, me.session.header.cwd)
    } catch (error) {
      if (created && resumedHandles.get(key) === pending) {
        resumedHandles.delete(key)
        await handle.dispose()
      }
      throw error
    }
    handle.agent.followup(message)
    return handle.agent
  }

  /** 一次读取并折叠目标会话，供同一批回执查询复用。 */
  async function deliverySnapshotOf(to, me, signal) {
    assertPair(me, to, signal)
    const inspected = await readLogicalSession(to, signal)
    assertPair(me, to, signal)
    const state = foldInbox(assertSnapshot(inspected, to, me.session.header.cwd))
    return {
      pending: new Set(state['next-turn'].concat(state['next-step']).map((message) => message.id)),
      claimed: state.claimed,
      discarded: state.discarded,
      messages: state.messages,
    }
  }

  /** 回执状态：pending 排队中 / claimed 已认领 / discarded 被丢弃 / unknown 查无此消息。 */
  function deliveryStateOf(messageId, snapshot, from, to) {
    const source = snapshot.messages.get(messageId)?.source
    if (source?.kind !== name || source.senderSessionId !== from || source.targetSessionId !== to) return 'unknown'
    if (snapshot.pending.has(messageId)) return 'pending'
    if (snapshot.discarded.has(messageId)) return 'discarded'
    if (snapshot.claimed.has(messageId)) return 'claimed'
    return 'unknown'
  }

  ctx.tools.register(defineTool({
    name: 'list_peer_agents',
    description:
      '只列出已配置授权配对、同一工作目录、未归档且不是子代理的协作会话。未配置配对时列表为空。' +
      '每条含：id（会话 ID）、标题、工作目录、status（offline=进程里未加载、重启后未打开；其余为在线）、' +
      'kind（固定为 peer，作为兼容字段）。在线在前、按标题排序。普通 fork 即使有 parentSession 也仍是独立会话。' +
      '找到目标会话后，用它的 id 调用 send_agent_message 发送消息（目标离线时自动恢复后投递，恢复失败则返回错误）。' +
      '注意：它不同于 list_agents（后者列的是你的后台子代理）。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(_args, exec) {
      const me = exec.agent
      assertPeerCaller(me)
      const signal = exec?.signal
      signal?.throwIfAborted()
      const query = sessionQuery()
      const live = new Map()
      for (const agent of agents.list()) live.set(String(agent.id), agent)

      const rows = []
      const records = await query.listSessions(signal)
      signal?.throwIfAborted()
      for (const record of records) {
        const header = record.header
        const id = String(header.id)
        try {
          assertPair(me, id, signal)
          assertPeerHeader(header, id, me.session.header.cwd)
        } catch (error) { signal?.throwIfAborted(); continue }
        const agent = live.get(id)
        const status = agent !== undefined ? agent.status : 'offline'
        rows.push({ id, title: '', cwd: header.cwd ?? '', status, kind: 'peer', self: me !== undefined && String(me.id) === id })
      }

      const snapshots = await query.readTitleSnapshots(rows.map((r) => r.id), signal)
      signal?.throwIfAborted()
      const titleMap = new Map()
      for (const t of snapshots) {
        if (t.status === 'fulfilled' && t.value !== undefined && t.value.title !== undefined && typeof t.value.title.title === 'string') {
          titleMap.set(String(t.sessionId), t.value.title.title)
        }
      }
      for (let i = rows.length - 1; i >= 0; i--) {
        try { assertPair(me, rows[i].id, signal) } catch (error) { signal?.throwIfAborted(); rows.splice(i, 1); continue }
        rows[i].title = titleMap.get(rows[i].id) ?? ''
      }

      const rank = (row) => (row.status === 'running' ? 0 : row.status === 'idle' ? 1 : 2)
      rows.sort((a, b) => {
        const ra = rank(a)
        const rb = rank(b)
        if (ra !== rb) return ra - rb
        const ta = a.title || '~'
        const tb = b.title || '~'
        return ta < tb ? -1 : ta > tb ? 1 : 0
      })
      for (const row of rows) if (row.title === '') row.title = '(无标题 · ' + String(row.id).replace(/^session-/, '').slice(0, 8) + ')'
      return rows
    },
  }))

  ctx.tools.register(defineTool({
    name: 'send_agent_message',
    description:
      '向指定 Agent 或 Session 投递消息，用于执行当前请求或用户已授予的编排职责中的跨会话通信。' +
      '官方 @会话 提供只读上下文快照，不会发送消息，也不会授予通信权限。' +
      '仅参考其他会话或讨论本会话的改动方案时，不调用本工具；使用完整 Session ID 引用时也遵循同一规则。' +
      '收到 relay 消息时，只有正文明确要求向发送方返回内容时才使用本工具回复 senderSessionId；' +
      '不要回传单纯的 transport ack 或“收到”。' +
      '默认使用 followup 创建独立的新 turn；' +
      '目标离线（进程里未加载）时自动恢复该会话后投递。' +
      '用户无需说出模式名：目标为 running 且整句明确要求立即介入时用 steer，明确要求不打断当前任务、只补充上下文时用 inject；不确定时使用 followup。' +
      '同一对 Session 双向合计 60 秒内最多投递 10 条消息，超过时拒绝本次投递。' +
      '仅允许用户在插件配置中授予的同工作目录配对；每个协作 id 的消息总预算从原生日志计算，重启不重置。' +
      '归档会话和子代理一律拒绝。' +
      '注意：它不同于 send_message（后者是给你的后台子代理续聊）。',
    parameters: {
      to: { type: 'string', required: true, description: '目标的完整稳定 Session ID，来自官方 @会话 引用快照、list_peer_agents 或复制到的会话 ID；不要使用标题或编码后的 dsh-session 链接。' },
      content: { type: 'string', required: true, description: '只填用户要求转达的消息文本，不要自行追加“收到”、“请确认”或其他 transport ack 要求。' },
      mode: { type: 'string', enum: ['followup', 'inject', 'steer'], description: '不确定时省略并使用 followup；steer=立即介入 running 任务；inject=不打断地补充 running 任务上下文。' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: '已投递。\nmessageId: ' + value.messageId }]
      },
      presentationMeta(_args, value) {
        return value
      },
    },
    presentResult(_args, result) {
      const meta = result.meta
      if (result.isError || meta === null || typeof meta !== 'object' || Array.isArray(meta)) return
      const messageId = typeof meta.messageId === 'string' ? meta.messageId : ''
      const text = (typeof meta.text === 'string' ? meta.text : '已投递。')
        + (messageId ? '\nmessageId: ' + messageId : '')
      const details = config.showTechnicalDetails?.get() !== false
        ? '\n' + JSON.stringify({ to: meta.to, mode: meta.mode, state: meta.state, targetRuntimeStatus: meta.targetRuntimeStatus })
        : ''
      return {
        card: 'generic',
        title: '消息已投递',
        content: [{ type: 'text', text: text + details }],
      }
    },
    async execute(args, exec) {
      const me = exec.agent
      if (me === undefined) throw new Error('no calling agent')
      assertPeerCaller(me)
      const to = args.to
      if (to === '' || String(to) === String(me.id)) throw new Error('不能给自己发消息')
      const signal = exec.signal
      const pair = assertPair(me, to, signal)
      const reservedRelayTags = ['dsh-cross-session-agent', 'dsh-agent-message']
      if (reservedRelayTags.some((tag) => args.content.includes('<' + tag + '>') || args.content.includes('</' + tag + '>'))) {
        throw new Error('消息正文不能包含保留的跨会话协议标签')
      }

      const mode = args.mode ?? 'followup'
      return withPairDelivery(pair, signal, async () => {
        assertPair(me, to, signal)
        let target = agents.get(to)
        if (mode !== 'followup' && target?.status !== 'running') throw new Error(mode + ' 仅用于 running 会话')
        const inspected = await checkMessageBudget(pair, me, to, signal)
        assertPair(me, to, signal)
        target = agents.get(to)
        if (mode !== 'followup' && target?.status !== 'running') throw new Error(mode + ' 仅用于 running 会话')

        const myTitle = titleOf(me) || String(me.id)
        const source = {
          kind: name,
          form: 'relay',
          protocolVersion: 1,
          senderSessionId: String(me.id),
          targetSessionId: to,
          senderTitle: myTitle,
          coordinationId: pair.id,
        }
        const identified = createUserMessage({ content: [{ type: 'text', text: args.content }], source })
        const relayHeader = JSON.stringify({ senderSessionId: source.senderSessionId })
        const message = freezeMessage({
          ...identified,
          content: [{ type: 'text', text: '<dsh-agent-message>' + relayHeader + '</dsh-agent-message>\n\n' + args.content }],
        })
        const rollbackPairSend = reservePairSend(me.id, to)
        try {
          assertPair(me, to, signal)
          if (target !== undefined) target[mode](message)
          else target = await resumeAndFollowup(to, message, inspected, me, signal)
        } catch (error) {
          rollbackPairSend()
          throw error
        }

        rememberSent(message.id, String(me.id), to, mode)
        return {
          ok: true,
          to,
          mode,
          messageId: message.id,
          state: 'accepted',
          targetRuntimeStatus: target.status,
          text: '会话 ' + to + ' 已接受投递（' + mode + '）。这不表示对方已读、回复或完成。',
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'check_delivery',
    description:
      '按需查询发给某会话的消息状态（跨会话回执，默认安静——只有监督场景主动调用时才返回，不做任何自动播报）。' +
      '状态：pending=仍在目标 Inbox 排队；claimed=已被对方认领；discarded=被丢弃；unknown=查无此消息。' +
      'claimed 不表示已读、已回复或任务完成。' +
      '仅查询当前调用方发给授权配对的消息。传 messageId 时可在进程重启后从目标自己的 Inbox 日志恢复状态；不传则只返回当前调用方在本进程中的已记账消息。',
    parameters: {
      to: { type: 'string', required: true, description: '目标会话 ID。' },
      messageId: { type: 'string', description: '可选：只查这一条消息（来自 send_agent_message 的返回值）。' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const me = exec?.agent
      const signal = exec?.signal
      assertPair(me, args.to, signal)
      const target = agents.get(args.to)
      const targetRuntimeStatus = target !== undefined ? target.status : 'offline'
      const wanted = args.messageId !== undefined
        ? [args.messageId]
        : [...sent.entries()].filter(([, e]) => e.to === args.to && e.from === String(me.id)).map(([id]) => id)
      const entries = []
      const snapshot = await deliverySnapshotOf(args.to, me, signal)
      for (const messageId of wanted) {
        const entry = sent.get(messageId)
        if (entry !== undefined && (entry.to !== args.to || entry.from !== String(me.id))) {
          entries.push({ messageId, state: 'unknown', targetRuntimeStatus })
          continue
        }
        const state = deliveryStateOf(messageId, snapshot, String(me.id), args.to)
        entries.push({
          messageId,
          ...(entry !== undefined ? { sentAt: entry.at, mode: entry.mode } : {}),
          state,
          targetRuntimeStatus,
        })
      }
      return { to: args.to, receiptMeaning, entries }
    },
  }))
}
