import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-agent-message'
export const inject = ['agents', 'tools', 'systemPrompt']

export function apply(ctx, config) {
  const agents = ctx.agents
  /** 消息渲染形态：'user'=对话式气泡、期待回复（默认）｜'relay'=上下文注入、静默影响代理行为、不期待回复。 */
  const form = config?.form === 'relay' ? 'relay' : 'user'
  let seq = 0
  /** messageId -> { to, at, mode }；发送成功即记账，供批量查询及补充本进程发送信息。 */
  const sent = new Map()
  /** 记账表 FIFO 上限：超过则淘汰最老记录，内存恒定。 */
  const SENT_MAX = 1000

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'plugin:dsh-agent-message',
      order: 160,
      text:
        '用户消息开头的完整 @session-... 是一个稳定会话定位符，不是默认发送指令或子代理引用。' +
        '请结合用户的整句话判断动作：要求告诉、通知或命令目标会话时，把完整 session ID 作为 to 调用 send_agent_message，当前代理不要代为执行被转发的任务，仅报告投递结果，也不要要求对方回复“收到”；' +
        '要求查找、读取或分析目标会话时，使用当前可用的只读会话搜索/读取工具按需取得信息，不要发送消息或一次性读入整个会话。' +
        '不要仅凭 @ 自动发送或自动读取。',
    }), 'dsh-agent-message: session reference prompt')
  }

  function rememberSent(messageId, to, mode) {
    sent.set(messageId, { to, at: Date.now(), mode })
    if (sent.size > SENT_MAX) sent.delete(sent.keys().next().value)
  }

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

  function archivedIds() {
    const workspace = ctx.get('workspaceRegistry')
    return new Set((workspace !== undefined ? workspace.archivedSessionIds : []).map((id) => String(id)))
  }

  /** 冷会话投递：公开 resume + followup，并在 idle 或插件卸载时释放 handle。 */
  async function resumeAndFollowup(id, message) {
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
    let release
    try {
      release = ctx.effect(() => () => handle.dispose(), 'dsh-agent-message: resumed agent handle')
    } catch (error) {
      await handle.dispose()
      throw error
    }
    try {
      handle.agent.followup(message)
    } catch (error) {
      try {
        await release()
      } catch (cleanupError) {
        ctx.logger?.warn?.('释放恢复会话失败：' + String(cleanupError))
      }
      throw error
    }
    void Promise.resolve()
      .then(() => handle.agent.whenIdle())
      .then(release, release)
      .catch((error) => ctx.logger?.warn?.('释放恢复会话失败：' + String(error)))
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
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return { pending: new Set(), claimed: new Set(), discarded: new Set() }
    const { meta, events } = await persistence.readFrom(to, 0)
    const state = foldInbox(events.slice(meta.seedLength ?? 0))
    return {
      pending: new Set(state['next-turn'].concat(state['next-step']).map((message) => message.id)),
      claimed: state.claimed,
      discarded: state.discarded,
    }
  }

  /** 回执状态：delivered 排队中 / claimed 已认领 / discarded 被丢弃 / unknown 查无此消息。 */
  function deliveryStateOf(messageId, snapshot) {
    if (snapshot.pending.has(messageId)) return 'delivered'
    if (snapshot.discarded.has(messageId)) return 'discarded'
    if (snapshot.claimed.has(messageId)) return 'claimed'
    return 'unknown'
  }

  ctx.tools.register(defineTool({
    name: 'list_peer_agents',
    description:
      '列出当前进程里所有可发送（未归档）的 DeepSeek Harness Agent/会话，用于跨会话通信。' +
      '每条含：id（会话 ID）、标题、工作目录、status（offline=进程里未加载、重启后未打开；其余为在线）、' +
      'kind（peer=平级会话 / subagent=子代理）。在线在前、按标题排序。' +
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
      const persistence = ctx.get('sessionPersistence')
      const live = new Map()
      for (const agent of agents.list()) live.set(String(agent.id), agent)

      const ids = new Set()
      for (const id of live.keys()) ids.add(id)
      const headers = persistence !== undefined ? await persistence.list() : []
      const headerMap = new Map(headers.map((header) => [String(header.id), header]))
      for (const id of headerMap.keys()) ids.add(id)

      const rows = []
      for (const id of ids) {
        if (archived.has(id)) continue
        const agent = live.get(id)
        const header = headerMap.get(id)
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
        const titleMap = new Map()
        for (const t of snapshots) {
          if (t.status === 'fulfilled' && t.value !== undefined && t.value.title !== undefined && typeof t.value.title.title === 'string') {
            titleMap.set(String(t.sessionId), t.value.title.title)
          }
        }
        for (const row of rows) row.title = titleMap.get(row.id) ?? ''
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
      '向另一个 Agent/会话发送消息（跨会话通信）。默认使用 followup 创建独立的新 turn；' +
      '目标离线（进程里未加载）时自动恢复该会话后投递。' +
      'mode 可选：followup（默认）、inject 或 steer（后两者仅在线）。归档会话一律拒绝。' +
      '注意：它不同于 send_message（后者是给你的后台子代理续聊）。',
    parameters: {
      to: { type: 'string', required: true, description: '目标会话/Agent ID，来自 list_peer_agents 或复制到的会话 ID。' },
      content: { type: 'string', required: true, description: '要发送的消息文本。' },
      mode: { type: 'string', enum: ['followup', 'inject', 'steer'], description: 'followup 默认创建独立 turn；inject/steer 仅用于在线会话的明确语义。' },
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

      const myTitle = titleOf(me) || String(me.id)
      const source = {
        kind: form === 'relay' ? 'plugin' : 'user',
        plugin: name,
        form,
        senderSessionId: String(me.id),
        senderTitle: myTitle,
      }
      const message = makeMessage(form === 'relay' ? args.content : 'From Session · ' + myTitle + ': @' + String(me.id) + '\n' + args.content, source)

      const target = agents.get(to)
      let usedMode = ''

      if (target !== undefined) {
        if (mode === 'followup') { target.followup(message); usedMode = mode }
        else if (mode === 'inject') { target.inject(message); usedMode = 'inject' }
        else { target.steer(message); usedMode = 'steer' }
      } else {
        const persistence = ctx.get('sessionPersistence')
        const headers = persistence !== undefined ? await persistence.list() : []
        const header = headers.find((h) => String(h.id) === String(to))
        if (header === undefined) throw new Error('会话不存在：' + to)
        if (mode !== 'followup') throw new Error('目标离线（进程里未加载）：' + mode + ' 仅用于在线会话')
        await resumeAndFollowup(to, message)
        usedMode = 'followup'
      }

      rememberSent(message.id, String(to), usedMode)
      return {
        ok: true,
        to: String(to),
        mode: usedMode,
        messageId: message.id,
        text: '已通过 ' + usedMode + ' 模式向 Agent ' + String(to) + ' 发送消息。',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'check_delivery',
    description:
      '按需查询发给某会话的消息状态（跨会话回执，默认安静——只有监督场景主动调用时才返回，不做任何自动播报）。' +
      '状态：delivered=已送达·排队中；claimed=已被对方认领；discarded=被丢弃；unknown=查无此消息。' +
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
      const targetStatus = target !== undefined ? target.status : 'offline'
      if (args.messageId !== undefined) {
        const entry = sent.get(args.messageId)
        if (entry !== undefined && String(entry.to) !== String(args.to)) {
          return { to: args.to, entries: [{ messageId: args.messageId, state: 'unknown', targetStatus }] }
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
          targetStatus,
        })
      }
      return { to: args.to, entries }
    },
  }))
}
