/**
 * dsh-agent-message — host half (profile bundle).
 *
 * Registers two model-facing tools for cross-session messaging between live
 * agents. Relay messages render as ordinary user bubbles with a title header
 * only. `agents` is the host-plane registry and `tools` the tool registry;
 * both are host capabilities this bundle consumes.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-agent-message'
export const inject = ['agents', 'tools']

export function apply(ctx) {
  const agents = ctx.agents
  let seq = 0

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

  ctx.tools.register(defineTool({
    name: 'list_peer_agents',
    description:
      '列出当前进程里在线（已注册）的其它 DeepSeek Harness Agent/会话，用于跨会话通信。每条包含：id（会话 ID）、标题、工作目录。' +
      '找到目标会话后，用它的 id 调用 send_agent_message 发送跨会话消息。' +
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
      const rows = []
      for (const agent of agents.list()) {
        rows.push({
          id: String(agent.id),
          title: titleOf(agent),
          cwd: (agent.session && agent.session.header && agent.session.header.cwd) || '',
          status: agent.status,
          self: me !== undefined && agent.id === me.id,
        })
      }
      return rows
    },
  }))

  ctx.tools.register(defineTool({
    name: 'send_agent_message',
    description:
      '向当前进程里在线（已注册）的另一个 Agent/会话发送消息（跨会话通信）。' +
      'mode 三选一：steer=引导对方当前工作（默认）；followup=给对方排一条新的独立轮次；inject=静默注入下一步但不唤醒。' +
      '注意：它不同于 send_message（后者是给你的后台子代理续聊）。',
    parameters: {
      to: { type: 'string', required: true, description: '目标会话/Agent ID，来自 list_peer_agents 或复制到的会话 ID。' },
      content: { type: 'string', required: true, description: '要发送的消息文本。' },
      mode: { type: 'string', enum: ['steer', 'followup', 'inject'], description: 'steer=引导对方当前工作（默认）；followup=排一条新轮次；inject=静默注入不唤醒。' },
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
      const target = agents.get(args.to)
      if (target === undefined) {
        throw new Error('target agent "' + args.to + '" is not live in this process; only live agents can receive messages')
      }
      const myTitle = titleOf(me) || String(me.id)
      const text = '来自 Agent「' + myTitle + '」：\n' + args.content
      const message = makeMessage(text, {
        kind: 'user',
        senderSessionId: String(me.id),
        senderTitle: myTitle,
      })
      const mode = args.mode === 'followup' ? 'followup' : args.mode === 'inject' ? 'inject' : 'steer'
      if (mode === 'followup') target.followup(message)
      else if (mode === 'inject') target.inject(message)
      else target.steer(message)
      return {
        ok: true,
        to: String(target.id),
        mode,
        messageId: message.id,
        text: '已通过 ' + mode + ' 模式向 Agent ' + String(target.id) + '（' + (titleOf(target) || '无标题') + '）发送消息。',
      }
    },
  }))
}
