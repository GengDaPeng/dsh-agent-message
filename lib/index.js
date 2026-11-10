import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm/message'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-agent-message'
export const inject = ['agents', 'tools', 'sessionQuery']

/** Host 配置由 Harness Settings 持有，`.volatile()` 字段可在运行中更新。 */
export const Config = z.object({
  showTechnicalDetails: z.boolean().default(true).volatile(),
})

export function apply(ctx, config) {
  const agents = ctx.agents
  /** messageId -> { from, to, at, mode }；发送成功即记账，供批量查询及补充本进程发送信息。 */
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

  function showTechnicalDetails() {
    const setting = config?.showTechnicalDetails
    return (setting?.get?.() ?? setting) !== false
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
    const key = JSON.stringify([String(from), String(to)].sort())
    const recent = (pairSends.get(key) ?? []).filter((entry) => now - entry.at < PAIR_WINDOW_MS)
    if (recent.length >= PAIR_MESSAGE_LIMIT) {
      pairSends.set(key, recent)
      const retryAfterSeconds = Math.max(1, Math.ceil((PAIR_WINDOW_MS - (now - recent[0].at)) / 1000))
      throw new Error('同一对会话 60 秒内最多投递 10 条消息；请勿立即重试，约 ' + retryAfterSeconds + ' 秒后窗口重置')
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

  /** 按原始索引重放完整 Inbox，只归集当前发送方的回执。 */
  function foldInbox(events, from, to) {
    function ownsMessage(message) {
      const source = message?.source
      if (source?.form !== 'relay' || source.senderSessionId !== from) return false
      if (source.kind === name) return source.targetSessionId === to
      // 早期插件 relay 没有目标字段，目标由其所在的自有 Inbox 日志确认。
      return source.kind === 'plugin' && source.plugin === name && source.targetSessionId === undefined
    }

    const state = { 'next-turn': [], 'next-step': [], claimed: new Set(), discarded: new Set() }
    for (const ev of events) {
      if (ev.type !== 'agent/inbox/spliced') continue
      const s = ev.data
      const list = state[s.target] ?? []
      const removed = list.splice(s.start, s.removedCount ?? 0, ...s.inserted)
      const bucket = s.outcome === 'canceled' ? state.discarded : state.claimed
      for (const message of removed) {
        if (ownsMessage(message)) bucket.add(message.id)
      }
    }
    return {
      pending: new Set(state['next-turn'].concat(state['next-step']).filter(ownsMessage).map((message) => message.id)),
      claimed: state.claimed,
      discarded: state.discarded,
    }
  }

  function archivedIds() {
    const workspace = ctx.get('workspaceRegistry')
    return new Set((workspace !== undefined ? workspace.archivedSessionIds : []).map((id) => String(id)))
  }

  function isSubagentSession(header) {
    return header?.origin === 'subagent'
  }

  function assertPeerCaller(agent) {
    if (agent !== undefined && isSubagentSession(agent.session.header)) {
      throw new Error('子代理不能使用独立会话通信工具')
    }
  }

  function sessionQuery() {
    const query = ctx.get('sessionQuery')
    if (query === undefined) throw new Error('本部署缺少 sessionQuery，无法查询逻辑会话')
    return query
  }

  /**
   * 读取一份逻辑会话快照，归一化为 `{ session, inheritedEventCount, events }`。
   *
   * 新版宿主公开 `observeSession()`：它同时给出完整的会话头、精确的继承边界
   * 和事件，也能读取分叉会话。旧的 `readSession()` 在当前宿主上对分叉会话会
   * 直接抛错（种子必须等于继承前缀），因此优先使用前者，仅在宿主未提供时回退。
   */
  async function readLogicalSession(id) {
    const query = sessionQuery()
    try {
      if (typeof query.observeSession === 'function') {
        const observation = await query.observeSession(id, { projectionMode: 'none' })
        try {
          // 复制一份并立刻释放租约；非法形状由下面的归属判定给出受控错误。
          const events = Array.isArray(observation.events) ? observation.events.slice() : observation.events
          return {
            session: observation.header,
            inheritedEventCount: observation.inheritedEventCount,
            events,
          }
        } finally {
          observation[Symbol.dispose]?.()
        }
      }
      return await query.readSession(id)
    } catch (error) {
      if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined
      throw error
    }
  }

  /** 冷会话投递：公开 resume + followup；同一 Session 复用 handle，仅在插件卸载时释放。 */
  async function resumeAndFollowup(id, message, inspected) {
    const existing = agents.get(id)
    if (existing !== undefined) {
      existing.followup(message)
      return existing
    }
    const key = String(id)
    let pending = resumedHandles.get(key)
    if (pending === undefined) {
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
        agentOptions: { provider: selection.provider ?? '', model: selection.model ?? '' },
        ...(presets !== undefined && presetId !== undefined
          ? { setup: async (agentCtx) => { await presets.mount(agentCtx, presetId) } }
          : {}),
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
      const concurrent = agents.get(id)
      if (concurrent === undefined) throw error
      concurrent.followup(message)
      return concurrent
    }
    handle.agent.followup(message)
    return handle.agent
  }

  /**
   * 取「本会话自有」的事件，用于回执归属。
   *
   * 只认宿主公开的继承边界，且在线与离线走同一条规则：
   * - 在线当前合同：`Session.ownEvents()`；
   * - 离线当前合同：`SessionLogSnapshot.inheritedEventCount`；
   * - 旧合同：`header.seedLength`（缺席即未继承）。
   *
   * 边界无法确定时抛受控错误：静默按「没有继承历史」处理会把父会话的投递
   * 与认领历史折叠进分叉会话的回执。
   */
  function ownEventsOf(source, label) {
    if (source !== null && typeof source === 'object') {
      // 在线当前合同：宿主直接给出自有事件，语义无歧义。
      if (typeof source.ownEvents === 'function') return source.ownEvents()
      const events = source.events
      if (Array.isArray(events)) {
        // 离线快照把 header 放在 session 上，在线会话放在 header 上。
        const header = source.header ?? source.session
        const inherited = source.inheritedEventCount
        if (Number.isSafeInteger(inherited) && inherited >= 0) {
          if (inherited > events.length) throw undecidableBoundary(label)
          return events.slice(inherited)
        }
        if (header !== null && typeof header === 'object') {
          // 当前合同的 header 一定带 isSeeded；缺边界却声明有分叉时必须失败。
          if (header.isSeeded === true) throw undecidableBoundary(label)
          if (header.isSeeded === false) return events.slice(0)
          const seedLength = header.seedLength
          if (seedLength === undefined) return events.slice(0)
          if (Number.isSafeInteger(seedLength) && seedLength >= 0 && seedLength <= events.length) {
            return events.slice(seedLength)
          }
        }
      }
    }
    throw undecidableBoundary(label)
  }

  function undecidableBoundary(label) {
    return new Error(
      '无法确定' + label + '的继承边界（宿主会话接口不受支持或格式异常）：已拒绝按无继承历史折叠回执。',
    )
  }

  /** 一次读取目标会话的自有事件，供同一批回执查询复用。 */
  async function deliverySnapshotOf(to, from) {
    const target = agents.get(to)
    if (target !== undefined) return foldInbox(ownEventsOf(target.session, '在线目标会话'), from, to)
    const inspected = await readLogicalSession(to)
    if (inspected === undefined) return { pending: new Set(), claimed: new Set(), discarded: new Set() }
    return foldInbox(ownEventsOf(inspected, '离线目标会话'), from, to)
  }

  /** 回执状态：pending 排队中 / claimed 已认领 / discarded 被丢弃 / unknown 查无此消息。 */
  function deliveryStateOf(messageId, snapshot) {
    if (snapshot.pending.has(messageId)) return 'pending'
    if (snapshot.discarded.has(messageId)) return 'discarded'
    if (snapshot.claimed.has(messageId)) return 'claimed'
    return 'unknown'
  }

  ctx.tools.register(defineTool({
    name: 'list_peer_agents',
    description:
      '需要选择独立会话且缺少目标 ID 时调用。' +
      '用标题和创建目录定位目标，从 self: false 的记录中取完整 id。' +
      'offline 表示本进程尚未加载该会话。',
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
      const archived = archivedIds()
      const query = sessionQuery()
      const live = new Map()
      for (const agent of agents.list()) live.set(String(agent.id), agent)

      const rows = []
      const records = await query.listSessions()
      for (const record of records) {
        const header = record.header
        const id = String(header.id)
        if (archived.has(id)) continue
        if (isSubagentSession(header)) continue
        const agent = live.get(id)
        const status = agent !== undefined ? agent.status : 'offline'
        rows.push({ id, title: '', cwd: header.cwd ?? '', status, kind: 'peer', self: me !== undefined && String(me.id) === id })
      }

      const snapshots = await query.readTitleSnapshots(rows.map((r) => r.id))
      const titleMap = new Map()
      for (const t of snapshots) {
        if (t.status === 'fulfilled' && t.value !== undefined && t.value.title !== undefined && typeof t.value.title.title === 'string') {
          titleMap.set(String(t.sessionId), t.value.title.title)
        }
      }
      for (const row of rows) row.title = titleMap.get(row.id) ?? ''

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
      '向独立会话投递消息。用户明确要求发送，或已授权的协作需要时调用。' +
      '仅查看 @会话 引用时，使用它提供的快照。' +
      '收到 relay 并被明确要求回传业务结果时，在已有授权范围内用 senderSessionId 回复。' +
      '成功返回 messageId，表示目标收件箱已接纳。',
    parameters: {
      to: {
        type: 'string',
        required: true,
        description:
          '目标会话的完整 Session ID。可使用用户给出的 ID、原生会话引用中的 ID，或 list_peer_agents 返回的 id。' +
          '回复 relay 时填写 senderSessionId。',
      },
      content: { type: 'string', required: true, description: '填写发给目标会话的业务正文和必要上下文。已授权的协作可自行撰写任务、问题或结果。' },
      mode: {
        type: 'string',
        enum: ['followup', 'inject', 'steer'],
        description:
          '省略时用 followup，排入独立的一轮。未加载的目标会先用默认模型恢复。' +
          '仅当用户意图或已授权的协作策略明确要求时，为 running 会话选择 inject（在下一步补充上下文）' +
          '或 steer（在最近可处理的步骤边界介入）。',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: '目标收件箱已接纳。\nmessageId: ' + value.messageId }]
      },
      presentationMeta(_args, value) {
        return value
      },
    },
    presentResult(_args, result) {
      const meta = result.meta
      if (result.isError || meta === null || typeof meta !== 'object' || Array.isArray(meta)) return
      const messageId = typeof meta.messageId === 'string' ? meta.messageId : ''
      const detailed = showTechnicalDetails()
      const summary = detailed && typeof meta.text === 'string' ? meta.text : '目标会话已接受投递。'
      const text = summary
        + (messageId ? '\nmessageId: ' + messageId : '')
      const details = detailed
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
      if (args.content.includes('<dsh-agent-message>') || args.content.includes('</dsh-agent-message>')) {
        throw new Error('消息正文不能包含保留协议标签 dsh-agent-message')
      }

      const archived = archivedIds()
      if (archived.has(String(to))) throw new Error('对方会话已归档，无法发送（请先取消归档）')
      const mode = args.mode ?? 'followup'
      const target = agents.get(to)
      if (target !== undefined && isSubagentSession(target.session.header)) {
        throw new Error('目标是子代理，不能通过会话通信插件直接发送')
      }
      if (target !== undefined && mode !== 'followup' && target.status !== 'running') {
        throw new Error(mode + ' 仅用于 running 会话；目标当前状态：' + target.status)
      }

      let inspected
      if (target === undefined) {
        inspected = await readLogicalSession(to)
        if (inspected === undefined) throw new Error('会话不存在：' + to)
        if (isSubagentSession(inspected.session)) throw new Error('目标是子代理，不能通过会话通信插件直接发送')
        if (mode !== 'followup') throw new Error('目标离线（进程里未加载）：' + mode + ' 仅用于 running 会话')
      }

      const myTitle = titleOf(me) || String(me.id)
      const source = {
        kind: name,
        form: 'relay',
        protocolVersion: 1,
        senderSessionId: String(me.id),
        targetSessionId: String(to),
        senderTitle: myTitle,
      }
      const identified = createUserMessage({ content: [{ type: 'text', text: args.content }], source })
      const relayHeader = JSON.stringify({ senderSessionId: source.senderSessionId })
      const message = freezeMessage({
        ...identified,
        content: [{ type: 'text', text: '<dsh-agent-message>' + relayHeader + '</dsh-agent-message>\n\n' + args.content }],
      })

      let usedMode = ''
      let targetRuntimeStatus = 'offline'

      const rollbackPairSend = reservePairSend(me.id, to)
      try {
        if (target !== undefined) {
          if (mode === 'followup') { target.followup(message); usedMode = mode }
          else if (mode === 'inject') { target.inject(message); usedMode = 'inject' }
          else { target.steer(message); usedMode = 'steer' }
          targetRuntimeStatus = target.status
        } else {
          const resumed = await resumeAndFollowup(to, message, inspected)
          usedMode = 'followup'
          targetRuntimeStatus = resumed.status
        }
      } catch (error) {
        rollbackPairSend()
        throw error
      }

      rememberSent(message.id, source.senderSessionId, source.targetSessionId, usedMode)
      return {
        ok: true,
        to: String(to),
        mode: usedMode,
        messageId: message.id,
        state: 'accepted',
        targetRuntimeStatus,
        text: '会话 ' + String(to) + ' 已接受投递（' + usedMode + '）。这不表示对方已读、回复或完成。',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'check_delivery',
    description:
      '按需查询本会话发给目标的消息。指定 messageId 查单条，可跨重启。省略时查本进程保留的发送记录。' +
      'pending 等待认领，claimed 已被目标轮次认领，discarded 已丢弃，unknown 无可核验回执。' +
      'targetRuntimeStatus 仅表示目标运行状态。',
    parameters: {
      to: { type: 'string', required: true, description: '原始发送时使用的目标 Session ID。' },
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
      if (me === undefined) throw new Error('no calling agent')
      assertPeerCaller(me)

      const from = String(me.id)
      const { to, messageId } = args
      const targetRuntimeStatus = agents.get(to)?.status ?? 'offline'
      const ownsEntry = (entry) => entry.from === from && entry.to === to
      const tracked = messageId === undefined ? undefined : sent.get(messageId)
      if (tracked !== undefined && !ownsEntry(tracked)) {
        return { to, receiptMeaning, entries: [{ messageId, state: 'unknown', targetRuntimeStatus }] }
      }

      const wanted = messageId === undefined
        ? [...sent.entries()].filter(([, entry]) => ownsEntry(entry))
        : [[messageId, tracked]]
      if (wanted.length === 0) return { to, receiptMeaning, entries: [] }

      const snapshot = await deliverySnapshotOf(to, from)
      const entries = wanted.map(([id, entry]) => ({
        messageId: id,
        ...(entry !== undefined ? { sentAt: entry.at, mode: entry.mode } : {}),
        state: deliveryStateOf(id, snapshot),
        targetRuntimeStatus,
      }))
      return { to, receiptMeaning, entries }
    },
  }))
}
