import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Sessions from '@deepseek-ai/dsh-session'
import Query from '@deepseek-ai/dsh-session-query'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { apply } from '../lib/index.js'

const pair = { id: 'review-run-1', sessions: ['session-a', 'session-b'], maxMessages: 20 }

function fixture({ pairs = [pair], cwdB = '/repo', existing, query: overrides = {}, resume } = {}) {
  const state = existing ?? { live: new Map(), snapshots: new Map(), workspace: { archivedSessionIds: [] } }
  const tools = new Map()
  const cleanups = []
  let resumes = 0
  function add(id, cwd = '/repo') {
    const agent = {
      id, status: 'idle', session: { header: { id, cwd } },
      followup(message) { state.snapshots.get(id).events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } }) },
      steer(message) { this.followup(message) }, inject(message) { this.followup(message) },
    }
    state.live.set(id, agent)
    state.snapshots.set(id, { session: agent.session.header, inheritedEventCount: 0, events: [] })
    return agent
  }
  if (!existing) { add('session-a'); add('session-b', cwdB); add('session-c') }
  const query = {
    async readSession(id) { return structuredClone(state.snapshots.get(id)) },
    async listSessions() { return [...state.snapshots.values()].map((snapshot) => ({ header: snapshot.session })) },
    async readTitleSnapshots(ids) { return ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { title: { title: sessionId } } })) },
    async readTitle() { return undefined },
    ...overrides,
  }
  const ctx = {
    agents: {
      get: (id) => state.live.get(id), list: () => [...state.live.values()],
      async resume(options) {
        resumes++
        return resume?.(options) ?? { agent: state.live.get(options.resumeSessionId), async dispose() {} }
      },
    },
    tools: { register: (tool) => tools.set(tool.name, tool) },
    get(name) { return { sessionQuery: query, workspaceRegistry: state.workspace }[name] },
    effect(fn) { cleanups.push(fn()); }, on() {},
  }
  apply(ctx, { allowedPairs: pairs })
  const a = state.live.get('session-a')
  return { state, ctx, tools, a, query, get resumes() { return resumes }, async dispose() { for (const cleanup of cleanups.reverse()) await cleanup?.() } }
}

const send = (f, to = 'session-b', exec = { agent: f.a }) => f.tools.get('send_agent_message').execute({ to, content: 'Synthetic coordination message' }, exec)

test('no configured pair means default deny across all three host tools', async () => {
  const f = fixture({ pairs: [] })
  assert.deepEqual(await f.tools.get('list_peer_agents').execute({}, { agent: f.a }), [])
  await assert.rejects(send(f), /无权/)
  await assert.rejects(f.tools.get('check_delivery').execute({ to: 'session-b' }, { agent: f.a }), /无权/)
  assert.equal(f.state.snapshots.get('session-b').events.length, 0)
})

test('an unrelated same-workspace session cannot discover, send or inspect an A/B pair', async () => {
  const f = fixture()
  const c = f.state.live.get('session-c')
  assert.deepEqual(await f.tools.get('list_peer_agents').execute({}, { agent: c }), [])
  await assert.rejects(send(f, 'session-b', { agent: c }), /无权/)
  await assert.rejects(f.tools.get('check_delivery').execute({ to: 'session-b', messageId: 'anything' }, { agent: c }), /无权/)
  assert.deepEqual((await f.tools.get('list_peer_agents').execute({}, { agent: f.a })).map((row) => row.id), ['session-b'])
})

test('an explicit pair still cannot cross working directories, including cold targets', async () => {
  for (const cold of [false, true]) {
    const f = fixture({ cwdB: '/other' })
    if (cold) f.state.live.delete('session-b')
    assert.deepEqual(await f.tools.get('list_peer_agents').execute({}, { agent: f.a }), [])
    await assert.rejects(send(f), /无权/)
    await assert.rejects(f.tools.get('check_delivery').execute({ to: 'session-b', messageId: 'anything' }, { agent: f.a }), /无权/)
    assert.equal(f.resumes, 0)
  }
})

test('missing archive service fails closed instead of assuming every session is unarchived', async () => {
  const f = fixture()
  const original = f.ctx.get
  f.ctx.get = (name) => name === 'workspaceRegistry' ? undefined : original(name)
  await assert.rejects(send(f), /workspaceRegistry/)
})

test('cold read cancellation and archiving revalidate before any resume or delivery', async () => {
  for (const change of ['abort', 'archive', 'caller-archive']) {
    const started = Promise.withResolvers()
    const release = Promise.withResolvers()
    const controller = new AbortController()
    let f
    f = fixture({ query: { async readSession(id) { if (id === 'session-b') { started.resolve(); await release.promise } return f.state.snapshots.get(id) } } })
    f.state.live.delete('session-b')
    const pending = send(f, 'session-b', { agent: f.a, signal: controller.signal })
    await started.promise
    if (change === 'abort') controller.abort(new Error('user stopped'))
    else f.state.workspace.archivedSessionIds.push(change === 'archive' ? 'session-b' : 'session-a')
    release.resolve()
    await assert.rejects(pending, /user stopped|无权/)
    assert.equal(f.resumes, 0)
    assert.equal(f.state.snapshots.get('session-b').events.length, 0)
  }
})

test('cancellation, archive or identity change while resume awaits disposes its new handle without delivery', async () => {
  for (const change of ['abort', 'archive', 'cwd', 'subagent']) {
    const started = Promise.withResolvers()
    const release = Promise.withResolvers()
    const controller = new AbortController()
    let disposals = 0
    let receivedSignal
    let target
    const f = fixture({ async resume(options) { receivedSignal = options.signal; started.resolve(); await release.promise; return { agent: target, async dispose() { disposals++ } } } })
    target = f.state.live.get('session-b')
    f.state.live.delete('session-b')
    const pending = send(f, 'session-b', { agent: f.a, signal: controller.signal })
    await started.promise
    if (change === 'abort') controller.abort(new Error('user stopped'))
    if (change === 'archive') f.state.workspace.archivedSessionIds.push('session-b')
    if (change === 'cwd') target.session.header.cwd = '/other'
    if (change === 'subagent') target.session.header.origin = 'subagent'
    release.resolve()
    await assert.rejects(pending, /user stopped|无权/)
    assert.equal(receivedSignal, controller.signal)
    assert.equal(disposals, 1)
    assert.equal(f.state.snapshots.get('session-b').events.length, 0)
    await f.dispose()
    assert.equal(disposals, 1)
  }
})

test('a receiver activated during query must still satisfy the final workspace and subagent checks', async () => {
  for (const change of ['cwd', 'subagent']) {
    let target
    let f
    f = fixture({ query: { async readSession(id) {
      const snapshot = structuredClone(f.state.snapshots.get(id))
      if (id === 'session-b') { target.session.header[change === 'cwd' ? 'cwd' : 'origin'] = change === 'cwd' ? '/other' : 'subagent'; f.state.live.set(id, target) }
      return snapshot
    } } })
    target = f.state.live.get('session-b')
    f.state.live.delete('session-b')
    await assert.rejects(send(f), /无权/)
    assert.equal(f.resumes, 0)
    assert.equal(f.state.snapshots.get('session-b').events.length, 0)
  }
})

test('pair budget is bidirectional, serialized under concurrency and survives a plugin restart', async () => {
  const pairs = [{ ...pair, maxMessages: 3 }]
  const f = fixture({ pairs })
  const results = await Promise.allSettled([send(f), send(f, 'session-a', { agent: f.state.live.get('session-b') }), send(f), send(f)])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3)
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /预算已用尽/)
  const restarted = fixture({ pairs, existing: f.state })
  await assert.rejects(send(restarted), /预算已用尽/)
  const newRun = fixture({ pairs: [{ ...pair, id: 'review-run-2', maxMessages: 1 }], existing: f.state })
  assert.equal((await send(newRun)).state, 'accepted')
  await assert.rejects(send(newRun), /预算已用尽/)
})

test('receipts are scoped to the actual sender even when two authorized pairs share a target', async () => {
  const f = fixture({ pairs: [pair, { id: 'second-pair', sessions: ['session-c', 'session-b'] }] })
  const sent = await send(f)
  const c = f.state.live.get('session-c')
  const own = await f.tools.get('check_delivery').execute({ to: 'session-b', messageId: sent.messageId }, { agent: f.a })
  assert.equal(own.entries[0].state, 'pending')
  const other = await f.tools.get('check_delivery').execute({ to: 'session-b', messageId: sent.messageId }, { agent: c })
  assert.equal(other.entries[0].state, 'unknown')
  assert.deepEqual((await f.tools.get('check_delivery').execute({ to: 'session-b' }, { agent: c })).entries, [])
  const restarted = fixture({ pairs: [pair, { id: 'second-pair', sessions: ['session-c', 'session-b'] }], existing: f.state })
  assert.equal((await restarted.tools.get('check_delivery').execute({ to: 'session-b', messageId: sent.messageId }, { agent: c })).entries[0].state, 'unknown')
})

test('invalid pairs, duplicate run ids and unbounded message budgets fail at configuration load', () => {
  for (const pairs of [null, [{ ...pair, sessions: ['session-a', 'session-a'] }], [{ ...pair, maxMessages: 0 }], [{ ...pair, maxMessages: 101 }], [{ ...pair, maxMessages: 1.5 }], [pair, pair]]) {
    assert.throws(() => fixture({ pairs }), /allowedPairs/)
  }
})

test('real rc.2 SessionQuery serves live receipts and excludes a fork parent Inbox history', async () => {
  const ctx = new Context()
  await ctx.plugin(Sessions)
  await ctx.plugin(Query)
  try {
    const parent = ctx.sessions.create('session-parent', { meta: { cwd: '/repo' } })
    const message = createUserMessage({ content: [{ type: 'text', text: 'parent-only' }], source: { kind: 'dsh-agent-message', senderSessionId: 'session-a', targetSessionId: 'session-b' } })
    parent.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    parent.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    const parentSnapshot = await ctx.sessionQuery.readSession(parent.id)
    const fork = ctx.sessions.create('session-b', { seed: parentSnapshot.events, inheritedEventCount: parentSnapshot.events.length, meta: { cwd: '/repo', parentSession: parent.id, isSeeded: true } })
    assert.equal(fork.events, undefined)
    const caller = ctx.sessions.create('session-a', { meta: { cwd: '/repo' } })
    const f = fixture({ query: { readSession: (id) => ctx.sessionQuery.readSession(id) } })
    f.a.session = caller
    f.state.live.get('session-b').session = fork
    const tool = f.tools.get('check_delivery')
    assert.equal((await tool.execute({ to: 'session-b', messageId: message.id }, { agent: f.a })).entries[0].state, 'unknown')
    const own = createUserMessage({ content: [{ type: 'text', text: 'fork-only' }], source: { kind: 'dsh-agent-message', senderSessionId: 'session-a', targetSessionId: 'session-b' } })
    fork.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [own] })
    assert.equal((await tool.execute({ to: 'session-b', messageId: own.id }, { agent: f.a })).entries[0].state, 'pending')
    fork.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
    assert.equal((await tool.execute({ to: 'session-b', messageId: own.id }, { agent: f.a })).entries[0].state, 'discarded')
  } finally { await ctx.fiber.dispose() }
})
