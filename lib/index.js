import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm/message'

export const name = 'dsh-agent-message'
export const inject = ['agents', 'tools', 'sessionQuery']

export function apply(ctx) {
  const agents = ctx.agents
  /** messageId -> { to, at, mode }；发送成功即记账，供批量查询及补充本进程发送信息。 */
  const sent = new Map()
  /** 记账表 FIFO 上限：超过则淘汰最老记录，内存恒定。 */
  const SENT_MAX = 1000
  const receiptMeaning = 'claimed 仅表示目标 turn 已从 Inbox 认领消息；传输回执不表示对方已读、回复或完成。'
  /** 插件恢复的 Session handle；保留到插件卸载，避免 idle dispose 移除 Harness store 投影。 */
  const resumedHandles = new Map()

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

  function rememberSent(messageId, to, mode) {
    sent.set(messageId, { to, at: Date.now(), mode })
    if (sent.size > SENT_MAX) sent.delete(sent.keys().next().value)
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
    const state = { 'next-turn': [], 'next-step': [], claimed: new Set(), discarded: new Set() }
    for (const ev of events) {
      if (ev.type !== 'agent/inbox/spliced') continue
      const s = ev.data
      const list = state[s.target] ?? []
      const removed = list.splice(s.start, s.removedCount ?? 0, ...s.inserted)
      const bucket = s.outcome === 'canceled' ? state.discarded : state.claimed
      for (const m of removed) bucket.add(m.id)
    }
    return state
  }

  function archivedIds() {
    const workspace = ctx.get('workspaceRegistry')
    return new Set((workspace !== undefined ? workspace.archivedSessionIds : []).map((id) => String(id)))
  }

  function isSubagentSession(header) {
    return header?.origin === 'subagent'
  }

  function sessionQuery() {
    const query = ctx.get('sessionQuery')
    if (query === undefined) throw new Error('本部署缺少 sessionQuery，无法查询逻辑会话')
    return query
  }

  async function readLogicalSession(id) {
    try {
      return await sessionQuery().readSession(id)
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

  /** 一次读取并折叠目标会话，供同一批回执查询复用。 */
  async function deliverySnapshotOf(to) {
    const target = agents.get(to)
    if (target !== undefined) {
      const state = foldInbox(target.session.events.slice(target.session.header.seedLength ?? 0))
      return {
        pending: new Set(target.inbox.nextTurn.concat(target.inbox.nextStep).map((message) => message.id)),
        claimed: state.claimed,
        discarded: state.discarded,
      }
    }
    const inspected = await readLogicalSession(to)
    if (inspected === undefined) return { pending: new Set(), claimed: new Set(), discarded: new Set() }
    const state = foldInbox(inspected.events.slice(inspected.session.seedLength ?? 0))
    return {
      pending: new Set(state['next-turn'].concat(state['next-step']).map((message) => message.id)),
      claimed: state.claimed,
      discarded: state.discarded,
    }
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
      '列出逻辑会话目录中所有可发送（未归档且不是子代理）的 DeepSeek Harness 会话，用于跨会话通信。' +
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
      '向指定 Agent 或 Session 投递消息，用于执行当前请求或用户已授予的编排职责中的跨会话通信。' +
      '@session 只提供目标，不代表发送。' +
      '收到 relay 消息时，只有正文明确要求向发送方返回内容时才使用本工具回复 senderSessionId；' +
      '不要回传单纯的 transport ack 或“收到”。' +
      '默认使用 followup 创建独立的新 turn；' +
      '目标离线（进程里未加载）时自动恢复该会话后投递。' +
      '用户无需说出模式名：目标为 running 且整句明确要求立即介入时用 steer，明确要求不打断当前任务、只补充上下文时用 inject；不确定时使用 followup。' +
      '归档会话和子代理一律拒绝。' +
      '注意：它不同于 send_message（后者是给你的后台子代理续聊）。',
    parameters: {
      to: { type: 'string', required: true, description: '目标会话/Agent ID，来自 list_peer_agents 或复制到的会话 ID。' },
      content: { type: 'string', required: true, description: '只填用户要求转达的消息文本，不要自行追加“收到”、“请确认”或其他 transport ack 要求。' },
      mode: { type: 'string', enum: ['followup', 'inject', 'steer'], description: '不确定时省略并使用 followup；steer=立即介入 running 任务；inject=不打断地补充 running 任务上下文。' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: value.text || JSON.stringify(value) }]
      },
    },
    async execute(args, exec) {
      const me = exec.agent
      if (me === undefined) throw new Error('no calling agent')
      const to = args.to
      if (to === '' || String(to) === String(me.id)) throw new Error('不能给自己发消息')

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

      if (target !== undefined) {
        if (mode === 'followup') { target.followup(message); usedMode = mode }
        else if (mode === 'inject') { target.inject(message); usedMode = 'inject' }
        else { target.steer(message); usedMode = 'steer' }
        targetRuntimeStatus = target.status
      } else {
        const inspected = await readLogicalSession(to)
        if (inspected === undefined) throw new Error('会话不存在：' + to)
        if (isSubagentSession(inspected.session)) throw new Error('目标是子代理，不能通过会话通信插件直接发送')
        if (mode !== 'followup') throw new Error('目标离线（进程里未加载）：' + mode + ' 仅用于 running 会话')
        const resumed = await resumeAndFollowup(to, message, inspected)
        usedMode = 'followup'
        targetRuntimeStatus = resumed.status
      }

      rememberSent(message.id, String(to), usedMode)
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
      '按需查询发给某会话的消息状态（跨会话回执，默认安静——只有监督场景主动调用时才返回，不做任何自动播报）。' +
      '状态：pending=仍在目标 Inbox 排队；claimed=已被对方认领；discarded=被丢弃；unknown=查无此消息。' +
      'claimed 不表示已读、已回复或任务完成。' +
      '传 messageId 时可在进程重启后从目标 Inbox 日志恢复状态；不传则只返回本进程内发给该会话的全部已记账消息。',
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
    async execute(args) {
      const target = agents.get(args.to)
      const targetRuntimeStatus = target !== undefined ? target.status : 'offline'
      if (args.messageId !== undefined) {
        const entry = sent.get(args.messageId)
        if (entry !== undefined && String(entry.to) !== String(args.to)) {
          return { to: args.to, receiptMeaning, entries: [{ messageId: args.messageId, state: 'unknown', targetRuntimeStatus }] }
        }
      }
      const wanted = args.messageId !== undefined
        ? [args.messageId]
        : [...sent.entries()].filter(([, e]) => String(e.to) === String(args.to)).map(([id]) => id)
      const entries = []
      const snapshot = wanted.length > 0 ? await deliverySnapshotOf(args.to) : undefined
      for (const messageId of wanted) {
        const entry = sent.get(messageId)
        if (entry !== undefined && String(entry.to) !== String(args.to)) continue
        const state = deliveryStateOf(messageId, snapshot)
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
