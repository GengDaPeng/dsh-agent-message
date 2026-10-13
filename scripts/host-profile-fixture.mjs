// Test-only Cordis plugin. Mount ONLY in a disposable DSH_HOME, never in a personal profile.
// The host, Agent loops, tool dispatcher, SessionQuery and JSONL persistence are real;
// this deterministic provider replaces online model calls and never requests credentials.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'agent-message-agent-host-fixture'
export const inject = ['llm', 'agents', 'tools', 'sessionQuery', 'sessionPersistence', 'workspaceRegistry', 'sessionReferenceResolver', 'settings']

export function apply(ctx, config) {
  const { a, b, c, d, fork, cwd, otherCwd, runId, output, phase = 'initial' } = config
  assert.ok(cwd && otherCwd && output && runId, 'fixture needs explicit disposable paths and identities')
  let modelCalls = 0
  const modelInputs = []
  class FixtureAdapter extends LlmAdapter {
    async listModels() { return [{ id: 'fixture', name: 'Deterministic local test' }] }
    async *stream(options) {
      modelCalls++
      options.signal?.throwIfAborted()
      const last = options.messages.findLast((message) => message.role !== 'system' && message.role !== 'developer' && message.source?.kind !== 'runtime-context' && message.source?.kind !== 'session-reference')
      const body = last?.content?.filter((block) => block.type === 'text').map((block) => block.text).join('\n') ?? ''
      modelInputs.push({ role: last?.role, tail: body.slice(-60), roles: options.messages.map((message) => message.role) })
      let action
      if (last?.role === 'user') {
        if (body.endsWith('FIXTURE_START')) action = { to: b, content: 'FIXTURE_REVIEW_1' }
        else if (body.endsWith('FIXTURE_REVIEW_1')) action = { to: a, content: 'FIXTURE_FIX_1' }
        else if (body.endsWith('FIXTURE_FIX_1')) action = { to: b, content: 'FIXTURE_REVIEW_2' }
      }
      if (action) {
        const block = { type: 'tool-call', id: randomUUID(), name: 'send_agent_message', arguments: JSON.stringify(action) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const text = body.endsWith('FIXTURE_REVIEW_2') ? 'FIXTURE_APPROVED' : 'FIXTURE_TURN_FINISHED'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['agent-message-fixture'], new FixtureAdapter())
  const handles = []
  ctx.effect(() => async () => { for (const handle of handles.reverse()) await handle.dispose() })
  const report = { ok: false, phase, onlineModelRequests: false, model: 'deterministic local adapter', assertions: [] }
  const check = (description) => report.assertions.push(description)
  const read = (id) => ctx.sessionQuery.readSession(id)
  const execute = (tool, args, agent, signal) => ctx.tools.get(tool).execute(args, { agent, signal })

  ctx.effect(async function* () {
    try {
      if (phase === 'restart') {
        const handle = await ctx.agents.resume({ resumeSessionId: a, agentOptions: { provider: 'agent-message-fixture', model: 'fixture' } })
        handles.push(handle)
        const before = await read(b)
        assert.equal(ctx.agents.get(b), undefined)
        await assert.rejects(execute('send_agent_message', { to: b, content: 'must not exceed durable budget' }, handle.agent), /预算已用尽/)
        assert.equal(ctx.agents.get(b), undefined)
        assert.equal((await read(b)).events.length, before.events.length)
        assert.equal(modelCalls, 0)
        check('process restart retained the A/B budget from native JSONL logs; exhausted cold B was neither resumed nor sent a message')
      } else {
        const create = async (id, workdir = cwd, extra = {}) => {
          const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: workdir }, agentOptions: { provider: 'agent-message-fixture', model: 'fixture' }, ...extra })
          handles.push(handle)
          return handle
        }
        const ha = await create(a)
        const hb = await create(b)
        hb.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'FIXTURE_B_READY' }], source: { kind: 'user' } }))
        const readyDeadline = Date.now() + 10_000
        while (hb.agent.status !== 'idle' && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 25))
        assert.equal(hb.agent.status, 'idle')
        await create(c, otherCwd)
        await create(d)
        await hb.dispose()
        handles.splice(handles.indexOf(hb), 1)
        assert.equal(ctx.agents.get(b), undefined)
        await read(b)
        check('B existed only in native persistence before the first A to B send')

        const mention = '@[Fixture B](dsh-session:' + Buffer.from(JSON.stringify(b), 'utf8').toString('base64url') + ')'
        ha.agent.followup(createUserMessage({ content: [{ type: 'text', text: mention + '\nFIXTURE_START' }], source: { kind: 'user' } }))
        const deadline = Date.now() + 30_000
        let bSnapshot
        while (Date.now() < deadline) {
          bSnapshot = await read(b)
          if (bSnapshot.events.some((event) => event.type === 'assistant/message' && event.data.message.content.some((block) => block.type === 'text' && block.text === 'FIXTURE_APPROVED')) &&
            ctx.agents.get(a).status === 'idle' && ctx.agents.get(b)?.status === 'idle') break
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        assert.ok(bSnapshot.events.some((event) => event.type === 'assistant/message' && event.data.message.content.some((block) => block.type === 'text' && block.text === 'FIXTURE_APPROVED')), 'review/fix/re-review did not reach its terminal answer')
        const aSnapshot = await read(a)
        const reference = aSnapshot.events.find((event) => event.type === 'user/message' && event.data.source?.kind === 'session-reference')
        assert.ok(reference, 'the official native @ reference must prepare a durable snapshot')
        assert.equal(reference.data.source.references[0].sessionId, b)
        assert.match(reference.data.content[0].text, /FIXTURE_B_READY/)
        check('official @ Session syntax produced a native session-reference snapshot with the exact peer ID and captured text before messaging')
        const delivered = [...aSnapshot.events, ...bSnapshot.events].filter((event) => event.type === 'user/message' && event.data.source?.kind === 'dsh-agent-message')
        assert.equal(delivered.length, 3)
        assert.deepEqual(delivered.map((event) => event.data.source.senderSessionId).sort(), [a, a, b].sort())
        for (const event of delivered) {
          assert.equal(event.data.source.coordinationId, runId)
          assert.notEqual(event.data.source.kind, 'user')
          assert.match(event.data.content[0].text, /<dsh-agent-message>/)
        }
        const combined = [...aSnapshot.events, ...bSnapshot.events]
        const callIds = new Set(combined.filter((event) => event.type === 'tool/call' && event.data.name === 'send_agent_message').map((event) => event.data.callId))
        const dispatches = combined.filter((event) => event.type === 'tool/result' && callIds.has(event.data.message.source?.callId))
        assert.equal(dispatches.length, 3)
        assert.ok(dispatches.every((event) => event.data.message.isError === false))
        check('real Agent loops and native tool dispatch completed A to cold B to A to B; B finished with FIXTURE_APPROVED and no further relay')

        const receipts = []
        for (const event of delivered) {
          const source = event.data.source
          const value = await execute('check_delivery', { to: source.targetSessionId, messageId: event.data.id }, ctx.agents.get(source.senderSessionId))
          assert.equal(value.entries[0].state, 'claimed')
          receipts.push({ from: source.senderSessionId, to: source.targetSessionId, state: value.entries[0].state })
        }
        report.receipts = receipts
        check('all three live receipts were claimed using public SessionQuery, preserving real sender attribution')

        const form = ctx.settings.describe().find((entry) => entry.ns === 'agent-message')
        assert.ok(form, 'the native settings form must discover this profile entry')
        assert.deepEqual(form.value, { showTechnicalDetails: true }, 'pair authorization must not be editable through this display form')
        assert.equal(form.autoGenerate, false)
        const sendTool = ctx.tools.get('send_agent_message')
        const meta = dispatches[0].data.meta
        assert.ok(meta?.messageId)
        const presentationArgs = { to: meta.to, content: 'FIXTURE_REVIEW_1' }
        const detailed = sendTool.presentResult(presentationArgs, { isError: false, meta })
        assert.match(detailed.content[0].text, /messageId:/)
        assert.match(detailed.content[0].text, /"mode":"followup"/)
        await ctx.settings.update('agent-message', { showTechnicalDetails: false }, form.revision)
        assert.equal(ctx.tools.get('send_agent_message'), sendTool, 'volatile display editing must not remount the communication owner')
        const compact = sendTool.presentResult(presentationArgs, { isError: false, meta })
        assert.match(compact.content[0].text, /messageId:/)
        assert.doesNotMatch(compact.content[0].text, /"mode":"followup"/)
        await ctx.settings.update('agent-message', { showTechnicalDetails: true })
        check('native volatile Config form edits changed delivery details live without remounting tools or exposing allowedPairs; messageId stayed visible')

        const listed = await execute('list_peer_agents', {}, ha.agent)
        assert.deepEqual(listed.map((row) => row.id), [b])
        await assert.rejects(execute('send_agent_message', { to: c, content: 'cross-workspace denial' }, ha.agent), /无权/)
        await assert.rejects(execute('send_agent_message', { to: d, content: 'unpaired denial' }, ha.agent), /无权/)
        await assert.rejects(execute('check_delivery', { to: d, messageId: delivered[0].data.id }, ha.agent), /无权/)
        check('real workspace registry and native session directory denied cross-cwd and unpaired targets')

        await create(fork, cwd, { seed: bSnapshot.events, inheritedEventCount: bSnapshot.events.length, meta: { cwd, parentSession: b, isSeeded: true } })
        const bDelivery = delivered.find((event) => event.data.source.targetSessionId === b)
        assert.equal((await execute('check_delivery', { to: fork, messageId: bDelivery.data.id }, ha.agent)).entries[0].state, 'unknown')
        check('a real fork did not claim a receipt inherited from its parent')

        const controller = new AbortController()
        controller.abort(new Error('fixture user stop'))
        const before = (await read(fork)).events.length
        await assert.rejects(execute('send_agent_message', { to: fork, content: 'must not arrive after cancellation' }, ha.agent, controller.signal), /fixture user stop/)
        assert.equal((await read(fork)).events.length, before)
        await ctx.workspaceRegistry.archiveSession(fork)
        await assert.rejects(execute('send_agent_message', { to: fork, content: 'must not arrive after archive' }, ha.agent), /无权/)
        check('native profile rejected an aborted call and a session archived through WorkspaceRegistry without adding a message')

        await assert.rejects(execute('send_agent_message', { to: b, content: 'must not trigger a fourth handoff' }, ha.agent), /预算已用尽/)
        check('the three-message coordination budget stopped any fourth relay')
      }
      await ctx.sessionPersistence.flush()
      report.ok = true
      report.localModelCalls = modelCalls
      await writeFile(output, JSON.stringify(report, null, 2) + '\n')
      ctx.logger.info('AGENT_MESSAGE_FIXTURE_PASSED ' + phase)
    } catch (error) {
      report.localModelCalls = modelCalls
      report.modelInputs = modelInputs
      report.diagnostics = {}
      for (const id of [a, b]) {
        try { report.diagnostics[id] = (await read(id)).events.filter((event) => ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'tool/code-dispatch', 'turn/end'].includes(event.type)).map((event) => ({ type: event.type, data: event.data })) } catch {}
      }
      report.error = String(error?.stack ?? error)
      await writeFile(output, JSON.stringify(report, null, 2) + '\n')
      throw error
    }
    yield () => {}
  }, 'agent-message-agent isolated profile acceptance')
}
