/**
 * dsh-agent-message — host half (profile bundle) v1.2.
 *
 * v1.2 能力：
 * - list_peer_agents v2：列出全部可发送（未归档）会话，含 offline/kind。
 * - send_agent_message v2：默认立即送达（在线 steer / 离线 wake 激活，失败兜底 leave）；
 *   显式模式 steer/followup/inject（仅在线）、leave（留言）、wake（激活）；归档/自己/未知守卫。
 * - check_delivery：按需回执（delivered/claimed/processing/discarded），默认零播报。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-agent-message'
export const inject = ['agents', 'tools']

export function apply(ctx) {
  const agents = ctx.agents
  let seq = 0
  /** messageId -> { to, at, mode }；发送成功即记账，check_delivery 消费（内存态，进程重启失效）。 */
  const sent = new Map()

  function mintId() {
    seq += 1
    return 'agent-msg-' + Date.now().toString(36) + '-' + seq + '-' + Math.random().toString(36).slice(2, 8)
  }

  function makeMessage(text, source) {
    return { id: mintId(), role: 'user', content: [{ type: 'text', text }], source }
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

  async function archivedIds() {
    const workspace = ctx.get('workspaceRegistry')
    return new Set((workspace !== undefined ? workspace.archivedSessionIds : []).map((id) => String(id)))
  }

  /** 离线留言：把消息持久化写进目标会话的 inbox（next-turn 末尾），不唤醒。 */
  async function leaveOffline(id, message) {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('本部署无会话持久化，无法离线留言')
    const { meta, events } = await persistence.readFrom(id, 0)
    const state = foldInbox(events.slice(meta.seedLength ?? 0))
    const start = state['next-turn'].length
    const nextSeq = events.length === 0 ? 0 : events[events.length - 1].seq + 1
    await persistence.append(id, [{
      seq: nextSeq,
      type: 'agent/inbox/spliced',
      time: Date.now(),
      data: { target: 'next-turn', start, inserted: [message] },
    }])
  }

  /** 离线激活：resume 该会话（恢复其记录的 preset + 默认模型）并 followup。 */
  async function wakeOffline(id, message) {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('本部署无会话持久化，无法激活离线会话')
    const inspected = await persistence.inspect(id)
    let presetId = inspected.meta !== undefined ? inspected.meta.agentPreset : undefined
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
    const handle = await agents.resume({
      resumeSessionId: id,
      agentOptions: { provider: selection.provider ?? '', model: selection.model ?? '' },
      ...(presets !== undefined && presetId !== undefined
        ? { setup: async (agentCtx) => { await presets.mount(agentCtx, presetId) } }
        : {}),
    })
    handle.agent.followup(message)
    return handle.agent
  }

  /** 回执状态：delivered 排队中 / claimed 已读 / processing 处理中 / discarded 被丢弃。 */
  async function deliveryStateOf(entry) {
    const messageId = entry.messageId
    const target = agents.get(entry.to)
    if (target !== undefined) {
      const pending = target.inbox.nextTurn.concat(target.inbox.nextStep)
      if (pending.some((m) => m.id === messageId)) return 'delivered'
      if (target.status === 'running') return 'processing'
      return 'claimed'
    }
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return 'claimed'
    const { meta, events } = await persistence.readFrom(entry.to, 0)
    const state = foldInbox(events.slice(meta.seedLength ?? 0))
    if (state.discarded.has(messageId)) return 'discarded'
    if (state.claimed.has(messageId)) return 'claimed'
    return 'delivered'
  }

  ctx.tools.register(defineTool({
    name: 'list_peer_agents',
    description:
      '列出当前进程里所有可发送（未归档）的 DeepSeek Harness Agent/会话，用于跨会话通信。' +
      '每条含：id（会话 ID）、标题、工作目录、status（offline=进程里未加载、重启后未打开；其余为在线）、' +
      'kind（peer=平级会话 / subagent=子代理）。在线在前、按标题排序。' +
      '找到目标会话后，用它的 id 调用 send_agent_message 发送消息（目标离线也会自动激活或留言）。' +
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
      const archived = await archivedIds()
      const persistence = ctx.get('sessionPersistence')
      const live = new Map()
      for (const agent of agents.list()) live.set(String(agent.id), agent)

      const ids = new Set()
      for (const id of live.keys()) ids.add(id)
      const headers = persistence !== undefined ? await persistence.list() : []
      for (const h of headers) ids.add(String(h.id))

      const rows = []
      for (const id of ids) {
        if (archived.has(id)) continue
        const agent = live.get(id)
        const header = headers.find((h) => String(h.id) === id)
        const status = agent !== undefined ? agent.status : 'offline'
        const cwd = (agent !== undefined && agent.session !== undefined && agent.session.header !== undefined ? agent.session.header.cwd : '')
          || (header !== undefined ? header.cwd : '') || ''
        const kind = ((header !== undefined && header.parentSession !== undefined)
          || (agent !== undefined && agent.session !== undefined && agent.session.header !== undefined && agent.session.header.parentSession !== undefined))
          ? 'subagent' : 'peer'
        rows.push({ id, title: '', cwd, status, kind, self: me !== undefined && String(me.id) === id })
      }

      const query = ctx.get('sessionQuery')
      if (query !== undefined) {
        const snapshots = await query.readTitleSnapshots(rows.map((r) => r.id))
        const titleMap = {}
        for (const t of snapshots) {
          if (t.status === 'fulfilled' && t.value !== undefined && t.value.title !== undefined && typeof t.value.title.title === 'string') {
            titleMap[String(t.sessionId)] = t.value.title.title
          }
        }
        for (const row of rows) row.title = titleMap[row.id] ?? ''
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
      '向另一个 Agent/会话发送消息（跨会话通信）。默认立即送达：目标在线则引导其当前工作（steer）；' +
      '目标离线（进程里未加载）则自动激活该会话并投递（wake），激活失败自动改为留言（leave）。' +
      'mode 可选：steer/followup/inject（仅在线）、leave（留言不唤醒）、wake（激活）。归档会话一律拒绝。' +
      '注意：它不同于 send_message（后者是给你的后台子代理续聊）。',
    parameters: {
      to: { type: 'string', required: true, description: '目标会话/Agent ID，来自 list_peer_agents 或复制到的会话 ID。' },
      content: { type: 'string', required: true, description: '要发送的消息文本。' },
      mode: { type: 'string', enum: ['steer', 'followup', 'inject', 'leave', 'wake'], description: 'steer/followup/inject 仅在线；leave 留言不唤醒；wake 激活。不传则智能默认。' },
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

      const archived = await archivedIds()
      if (archived.has(String(to))) throw new Error('对方会话已归档，无法发送（请先取消归档）')

      const myTitle = titleOf(me) || String(me.id)
      const message = makeMessage(
        '来自 Agent「' + myTitle + '」：\n' + args.content,
        { kind: 'user', senderSessionId: String(me.id), senderTitle: myTitle },
      )

      const target = agents.get(to)
      let usedMode = ''
      let fallback = ''

      if (target !== undefined) {
        const mode = args.mode ?? 'steer'
        if (mode === 'followup' || mode === 'wake') { target.followup(message); usedMode = mode }
        else if (mode === 'leave') { target.followup(message); usedMode = 'leave' }
        else if (mode === 'inject') { target.inject(message); usedMode = 'inject' }
        else { target.steer(message); usedMode = 'steer' }
      } else {
        const persistence = ctx.get('sessionPersistence')
        const headers = persistence !== undefined ? await persistence.list() : []
        const header = headers.find((h) => String(h.id) === String(to))
        if (header === undefined) throw new Error('会话不存在：' + to)
        const mode = args.mode ?? 'wake'
        if (mode === 'steer' || mode === 'followup' || mode === 'inject') {
          throw new Error('目标离线（进程里未加载）：' + mode + ' 仅用于在线会话；不传 mode（自动激活）或用 wake/leave')
        }
        if (mode === 'wake') {
          try {
            await wakeOffline(to, message)
            usedMode = 'wake'
          } catch (error) {
            await leaveOffline(to, message)
            usedMode = 'leave'
            fallback = '激活失败，已改为留言：' + (error instanceof Error ? error.message : String(error))
          }
        } else {
          await leaveOffline(to, message)
          usedMode = 'leave'
        }
      }

      sent.set(message.id, { to: String(to), at: Date.now(), mode: usedMode })
      return {
        ok: true,
        to: String(to),
        mode: usedMode,
        messageId: message.id,
        ...(fallback !== '' ? { fallback } : {}),
        text: fallback !== '' ? fallback : '已通过 ' + usedMode + ' 模式向 Agent ' + String(to) + ' 发送消息。',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'check_delivery',
    description:
      '按需查询发给某会话的消息状态（跨会话回执，默认安静——只有监督场景主动调用时才返回，不做任何自动播报）。' +
      '状态：delivered=已送达·排队中；claimed=对方已读（被认领）；processing=对方正在处理；discarded=被丢弃。' +
      '不传 messageId 则返回本进程内发给该会话的全部已记账消息。',
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
      const wanted = args.messageId !== undefined
        ? [args.messageId]
        : [...sent.entries()].filter(([, e]) => String(e.to) === String(args.to)).map(([id]) => id)
      const entries = []
      for (const messageId of wanted) {
        const entry = sent.get(messageId)
        if (entry === undefined || String(entry.to) !== String(args.to)) continue
        const state = await deliveryStateOf(entry)
        const target = agents.get(entry.to)
        entries.push({
          messageId,
          sentAt: entry.at,
          mode: entry.mode,
          state,
          targetStatus: target !== undefined ? target.status : 'offline',
        })
      }
      return { to: args.to, entries }
    },
  }))
}
