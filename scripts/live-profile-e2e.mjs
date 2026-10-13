// Disposable native-profile acceptance. This runner never connects to an existing server.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Run this acceptance with Node 24')
const dsh = process.argv[2] ?? 'dsh'
assert.ok(!/^https?:/.test(dsh), 'Pass a DSH CLI, not a server URL')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = await mkdtemp(join(tmpdir(), 'dsh-agent-message-'))
const home = join(root, 'home')
const cwd = join(root, 'same-workspace')
const otherCwd = join(root, 'other-workspace')
await Promise.all([mkdir(home), mkdir(cwd), mkdir(otherCwd)])
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
const ids = Object.fromEntries(['a', 'b', 'c', 'd', 'fork'].map((key) => [key, 'session-' + randomUUID()]))
const runId = 'acceptance-' + randomUUID()
const outputs = [join(root, 'initial.json'), join(root, 'restart.json')]
const allowedPairs = [
  { id: runId, sessions: [ids.a, ids.b], maxMessages: 3 },
  { id: 'cross-workspace-probe', sessions: [ids.a, ids.c], maxMessages: 1 },
  { id: 'fork-probe', sessions: [ids.a, ids.fork], maxMessages: 1 },
]

async function command(bin, args) {
  const child = spawn(bin, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk })
  await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${bin} failed (${code})\n${output.slice(-6000)}`)))
  })
  return output
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise))
  child.kill('SIGTERM')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000)
  try { await exited } finally { clearTimeout(timeout) }
}

try {
  const packed = JSON.parse(await command(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['pack', '--pack-destination', root, '--json']))
  const tarball = packed.filename ?? packed.tarballPath
  assert.equal(typeof tarball, 'string', 'pnpm pack must return its tarball path')
  await command(dsh, ['plugin', '--profile', 'web', 'add', resolve(root, tarball), '--ignore-scripts'])
  const results = []
  for (const [index, phase] of ['initial', 'restart'].entries()) {
    const patch = [
      { id: 'agent-default-model', config: { provider: 'agent-message-fixture', model: 'fixture' } },
      { id: 'session-title-llm', disabled: true },
      { id: 'hmr', disabled: true },
      { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
      { id: 'agent-message', config: { allowedPairs } },
      { insert: [{ id: 'agent-message-host-fixture', name: resolve(repo, 'scripts/host-profile-fixture.mjs'), config: { ...ids, cwd, otherCwd, runId, output: outputs[index], phase } }] },
    ]
    await writeFile(join(home, 'profiles/web/cordis.patch.yml'), JSON.stringify(patch, null, 2) + '\n')
    const child = spawn(dsh, ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let logs = ''
    let spawnError
    child.once('error', (error) => { spawnError = error })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { logs += chunk })
    try {
      const deadline = Date.now() + 90_000
      let result
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError
        try { await access(outputs[index]); result = JSON.parse(await readFile(outputs[index], 'utf8')); break } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`profile exited before acceptance\n${logs.slice(-10000)}`)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      }
      assert.ok(result, `profile acceptance timed out\n${logs.slice(-10000)}`)
      assert.equal(result.ok, true, result.error)
      results.push(result)
    } finally {
      await stop(child)
      await writeFile(join(root, phase + '.log'), logs)
    }
  }
  const report = { ok: true, dsh, node: process.versions.node, home, root, ids, runId, onlineModelRequests: false, results }
  await writeFile(join(root, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} catch (error) {
  process.stderr.write(`Acceptance artifacts preserved at ${root}\n`)
  throw error
}
