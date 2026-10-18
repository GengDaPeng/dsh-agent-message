import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Query from '@deepseek-ai/dsh-session-query'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { apply } from '../lib/index.js'

test('native workingDirectory survives JSONL cold reads while immutable header.cwd retains its original project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-message-directory-'))
  const project = join(root, 'project')
  const moved = join(root, 'moved')
  await Promise.all([mkdir(project), mkdir(moved)])
  const ctx = new Context()
  const cleanups = []
  let detach
  try {
    await ctx.plugin(Sessions)
    await ctx.plugin(Projections)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(FileSystem, { cwd: project })
    await ctx.plugin(WorkingDirectory)
    // rc.2 publishes a Cordis plugin module (apply/name/Config), not a default class.
    await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(Query)
    const callerSession = ctx.sessions.create('session-a', { meta: { cwd: project } })
    const targetSession = ctx.sessions.prepare('session-b', { meta: { cwd: project } })
    detach = ctx.sessions.enter(targetSession)
    ctx.sessions.announce(targetSession)
    const makeAgent = (session) => ({
      id: session.id, status: 'idle', session, ctx,
      inject(message) { session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] }) },
      followup(message) { session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] }) },
    })
    const a = makeAgent(callerSession)
    const b = makeAgent(targetSession)
    const live = new Map([[a.id, a], [b.id, b]])
    const tools = new Map()
    let resumes = 0
    apply({
      agents: { get: (id) => live.get(id), list: () => [...live.values()], async resume() { resumes++; throw new Error('cold denial must not resume') } },
      tools: { register: (tool) => tools.set(tool.name, tool) },
      get: (name) => name === 'workspaceRegistry' ? { archivedSessionIds: [] } : ctx.get(name),
      effect(fn) { cleanups.push(fn()) }, on() {},
    }, { allowedPairs: [{ id: 'native-directory', sessions: [a.id, b.id], maxMessages: 2 }] })
    const send = () => tools.get('send_agent_message').execute({ to: b.id, content: 'must not cross current directories' }, { agent: a })
    assert.deepEqual((await tools.get('list_peer_agents').execute({}, { agent: a })).map((row) => row.id), [b.id])
    const changed = await ctx.workingDirectory.set(b, moved)
    assert.equal(targetSession.header.cwd, project)
    assert.equal(ctx.sessionProjections.stateOf(targetSession, 'workingDirectory'), changed)
    await assert.rejects(send(), /无权/)

    const writer = await ctx.sessionPersistence.create(targetSession.header)
    await writer.append(targetSession.snapshotEvents())
    await writer.close()
    detach()
    live.delete(b.id)
    const observation = await ctx.sessionQuery.observeSession(b.id)
    try {
      assert.equal(observation.source, 'prepared')
      assert.equal(observation.header.cwd, project)
      assert.equal(observation.projections.values.workingDirectory, changed)
    } finally { observation[Symbol.dispose]() }
    await assert.rejects(send(), /无权/)
    await assert.rejects(tools.get('check_delivery').execute({ to: b.id, messageId: 'unknown' }, { agent: a }), /无权/)
    assert.deepEqual(await tools.get('list_peer_agents').execute({}, { agent: a }), [])
    assert.equal(resumes, 0)
    await ctx.workingDirectory.set(a, moved)
    const rows = await tools.get('list_peer_agents').execute({}, { agent: a })
    assert.deepEqual(rows.map((row) => [row.id, row.cwd, row.status]), [[b.id, changed, 'offline']])
    assert.equal(callerSession.header.cwd, project)
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup?.()
    detach?.()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
