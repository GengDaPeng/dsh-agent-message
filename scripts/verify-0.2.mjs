#!/usr/bin/env node
/**
 * Real-environment acceptance for dsh-agent-message on DeepSeek Harness 0.2.x.
 *
 * The script drives the *installed* bundled CLI (default:
 * `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`)
 * against an isolated temporary profile, so the check exercises the real
 * profile/bundle/plugin-manager path instead of the repository's unit tests.
 *
 * Steps:
 *   1. profile + install   — create the temp profile from the shipped
 *                            `headless` template (so the profile can run the
 *                            headless app), then `dsh plugin --profile <p> add
 *                            <repo>` when the local checkout is not installed.
 *   2. dump-config         — `dsh --profile <p> --dump-config` must compose the
 *                            `dsh-agent-message` bundle entry and print no
 *                            import/compatibility failure.
 *   3. headless tool call  — `dsh --profile <p>` with the task on stdin; the
 *                            run uses `--json`, and the assertion is that the
 *                            model really called `list_peer_agents` and got a
 *                            completed tool result containing `session-…`
 *                            entries. This is the only step that spends a model
 *                            call, so it is opt-in via `--with-headless`.
 *
 * The headless template's default route is `deepseek-official`, which needs an
 * API key in the launching environment. `--model-route <provider>/<model>`
 * generates a transient `--patch` overlay (removed again afterwards) that
 * mirrors the desktop profile's route, and `--credential-ref <NAME>` resolves
 * that name from the home credential store's `refs:` section into the child
 * environment without printing the secret.
 *
 * CLI shape verified against 0.2.1-rc.2 and re-checked on 0.2.2-rc.1:
 *   - `dsh headless "<task>"` means profile name `headless`: the launcher
 *     rewrites a leading positional argument into `--profile`, and the app is
 *     selected by the profile's bundle list (`[--profile] <name> [app-args...]`).
 *     So `dsh --profile <p> headless "<task>"` would pass "headless" to the
 *     headless app as task text. For a custom profile the correct invocation is
 *     `dsh --profile <p>` with the task as app args or on stdin (`-`).
 *   - `dsh --profile <p> --help` prints the headless app's own help (the app
 *     comes from the bundle list, not from the profile name).
 *   - A profile name without a shipped template is initialized by
 *     `dsh plugin ... add` with only `@deepseek-ai/dsh-base`, i.e. without the
 *     headless app; `--from-default-profile headless` creates a custom profile
 *     from the shipped `headless` template (base + headless app) instead.
 *
 * Usage:
 *   node scripts/verify-0.2.mjs                     # steps 1 + 2 (no model call)
 *   node scripts/verify-0.2.mjs --with-headless     # steps 1 + 2 + 3
 *   node scripts/verify-0.2.mjs --help
 *
 * Options:
 *   --dsh <path>         bundled CLI (default: the macOS app path, or $DSH_BIN)
 *   --profile <name>     temp profile name (default: dsh-msg-compat, or $DSH_MSG_PROFILE)
 *   --plugin <path>      local plugin checkout (default: repository root)
 *   --with-headless      also run step 3
 *   --task <text>        override the step-3 prompt
 *   --patch <path>       extra patch overlay for the headless run (repeatable)
 *   --model-route <p>/<m>  generate an overlay selecting provider/model
 *   --credential-ref <n>   resolve credential ref n from the home store for the run
 *   --timeout <seconds>  per-command timeout (default 120, headless 600)
 *   --evidence <path>    write a JSON evidence record (must live under scripts/)
 *
 * Only files under `scripts/` are written by this script; it never touches the
 * desktop profile, never runs git, and never deletes an existing profile that
 * it did not create (guarded by the `dsh-msg-` name prefix).
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts')
const DSH_HOME_DIR = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DEFAULT_DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const PLUGIN_NAME = 'dsh-agent-message'
const HEADLESS_BUNDLE = '@deepseek-ai/dsh-headless'
const HEADLESS_TEMPLATE = 'headless'
/** Profile names the generated verification profile may use; also the self-heal allowlist. */
const TEMP_PROFILE_PREFIX = 'dsh-msg-'
const SHIPPED_TEMPLATES = new Set(['acp', 'web', 'headless', 'sdk', 'sdk-minimal'])
const DEFAULT_TASK = [
  '请调用 list_peer_agents 工具（必须实际调用，不要跳过），',
  '然后把工具返回的结果原样逐行列出，包含每个会话的 id（session- 开头）和标题；',
  '不要编造，不要省略，不要总结成一句话。',
].join('')

const FAILURE_PATTERNS = [
  /skipping profile bundle/i,
  /does not provide an export/i,
  /failed to (?:load|import)/i,
  /failed import/i,
  /cannot find module/i,
  /incompatible/i,
  /syntaxerror/i,
  /typeerror/i,
  /referenceerror/i,
]

//#region argv
function parseArgs(argv) {
  const options = {
    dsh: process.env.DSH_BIN || DEFAULT_DSH,
    profile: process.env.DSH_MSG_PROFILE || 'dsh-msg-compat',
    plugin: REPO_ROOT,
    withHeadless: false,
    task: undefined,
    patches: [],
    modelRoute: undefined,
    credentialRef: undefined,
    timeoutMs: 120_000,
    headlessTimeoutMs: 600_000,
    evidence: undefined,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`)
      index += 1
      return next
    }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--dsh') options.dsh = resolve(value())
    else if (arg === '--profile') options.profile = value()
    else if (arg === '--plugin') options.plugin = resolve(value())
    else if (arg === '--with-headless') options.withHeadless = true
    else if (arg === '--task') options.task = value()
    else if (arg === '--patch') options.patches.push(resolve(value()))
    else if (arg === '--model-route') options.modelRoute = value()
    else if (arg === '--credential-ref') options.credentialRef = value()
    else if (arg === '--timeout') options.timeoutMs = Number(value()) * 1000
    else if (arg === '--headless-timeout') options.headlessTimeoutMs = Number(value()) * 1000
    else if (arg === '--evidence') options.evidence = resolve(value())
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  return options
}

const HELP = `Usage: node scripts/verify-0.2.mjs [options]

  --dsh <path>          bundled dsh CLI (default ${DEFAULT_DSH})
  --profile <name>      temp profile name (default dsh-msg-compat)
  --plugin <path>       local plugin checkout (default repository root)
  --with-headless       also run step 3 (one model call)
  --task <text>         override the step-3 prompt
  --patch <path>        extra patch overlay for the headless run (repeatable)
  --model-route <p>/<m> generate an overlay selecting provider/model
  --credential-ref <n>  resolve credential ref n from the home store for the run
  --timeout <seconds>   per-command timeout (default 120)
  --evidence <path>     write JSON evidence (must live under scripts/)
`
//#endregion

//#region process helpers
/** Run one command, capturing both streams and the exit code. */
function run(command, args, { input, timeoutMs, env } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs ?? 120_000)
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: -1, stdout, stderr: `${stderr}${String(error)}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, timedOut })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

function formatCommand(command, args, { input } = {}) {
  const quoted = [command, ...args].map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part))
  return input === undefined ? quoted.join(' ') : `${quoted.join(' ')} <<< ${JSON.stringify(input)}`
}

/** Write the transient overlay that points the profile at a usable model route. */
function writeRouteOverlay(modelRoute) {
  const [provider, model] = modelRoute.split('/')
  if (provider === undefined || model === undefined || provider === '' || model === '') {
    throw new Error(`--model-route must look like <provider>/<model>, got ${JSON.stringify(modelRoute)}`)
  }
  return { provider, model }
}

/**
 * Resolve a named credential ref from the home credential store's `refs:`
 * section. The value is only passed to child processes; it is never logged or
 * written into the evidence.
 */
function resolveCredentialRef(name) {
  const path = join(DSH_HOME_DIR, '.credentials.yaml')
  if (!existsSync(path)) throw new Error(`credential store not found at ${path}`)
  const lines = readFileSync(path, 'utf8').split('\n')
  const start = lines.findIndex((line) => /^refs:\s*$/.test(line))
  if (start === -1) throw new Error(`no refs section in ${path}`)
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const match = line.match(new RegExp(`^\\s+${name}:\\s*(.+?)\\s*$`))
    if (match !== null) return match[1].replace(/^['"]|['"]$/g, '')
  }
  throw new Error(`credential ref ${name} not found in ${path} refs`)
}
//#endregion

//#region evidence
const evidence = []
let failed = false

function record(step, commandLine, result, ok, notes, extra = {}) {
  evidence.push({
    step,
    command: commandLine,
    exitCode: result?.code ?? null,
    timedOut: result?.timedOut ?? false,
    ok,
    notes,
    ...extra,
  })
  if (!ok) failed = true
  const mark = ok ? 'PASS' : 'FAIL'
  process.stdout.write(`\n[${mark}] ${step}\n  $ ${commandLine}\n  exit=${result?.code ?? 'n/a'}${result?.timedOut ? ' (timed out)' : ''}\n`)
  for (const note of notes) process.stdout.write(`  - ${note}\n`)
}

function snippet(text, pattern, { before = 1, after = 1, fallbackLines = 8 } = {}) {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => pattern.test(line))
  if (index === -1) return lines.slice(0, fallbackLines).join('\n')
  return lines.slice(Math.max(0, index - before), index + after + 1).join('\n')
}

function dumpRaw(label, text) {
  if (text === '') return
  process.stdout.write(`  --- raw ${label} ---\n`)
  for (const line of text.replace(/\n$/, '').split('\n')) process.stdout.write(`  | ${line}\n`)
}
//#endregion

//#region steps
function readManifest(profileDir) {
  const path = join(profileDir, 'package.json')
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Create the temp profile from the shipped headless template. Without the
 * headless bundle a fresh custom profile only carries `dsh-base`, so
 * `dsh --profile <p> "<task>"` could not run the headless app.
 */
async function createProfile(options, profileDir) {
  const args = ['--profile', options.profile, '--from-default-profile', HEADLESS_TEMPLATE, '--dump-config']
  const commandLine = formatCommand(options.dsh, args)
  const result = await run(options.dsh, args, { timeoutMs: options.timeoutMs })
  const ok = result.code === 0 && existsSync(join(profileDir, 'package.json'))
  record('1a. create temp profile from headless template', commandLine, result, ok, ok
    ? [`profile dir: ${profileDir}`, result.stdout.includes("name: '@deepseek-ai/dsh-agent-message'") ? 'unexpected pre-existing plugin entry' : 'fresh profile created']
    : ['profile was not created'], { stdoutTail: result.stdout.slice(-2000), stderr: result.stderr })
  if (!ok) {
    dumpRaw('stdout', result.stdout)
    dumpRaw('stderr', result.stderr)
  }
}

async function step1(options, profileDir) {
  let manifest = readManifest(profileDir)
  if (manifest === undefined) {
    await createProfile(options, profileDir)
    if (failed) return undefined
    manifest = readManifest(profileDir)
  } else if (!(manifest.dsh?.profile?.bundles ?? []).includes(HEADLESS_BUNDLE)) {
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const note = `existing profile bundles: ${JSON.stringify(bundles)}`
    if (options.profile.startsWith(TEMP_PROFILE_PREFIX)) {
      process.stdout.write(`\n[info] ${note}; recreating the generated temp profile from the ${HEADLESS_TEMPLATE} template\n`)
      await createProfile(options, profileDir)
      if (failed) return undefined
      manifest = readManifest(profileDir)
    } else {
      record('1. profile ready', `read ${join(profileDir, 'package.json')}`, undefined, false, [
        note,
        `profile "${options.profile}" is not a generated temp profile; refusing to replace it.`,
        `Use --profile dsh-msg-compat (or another ${TEMP_PROFILE_PREFIX}* name) for this check.`,
      ])
      return undefined
    }
  }

  record('1a. profile ready', `read ${join(profileDir, 'package.json')}`, undefined, true, [
    `reusing existing temporary profile ${options.profile}`,
    `bundles: ${JSON.stringify(manifest.dsh?.profile?.bundles ?? [])}`,
  ])

  const dependency = manifest.dependencies?.[PLUGIN_NAME]
  const linked = typeof dependency === 'string' && dependency.startsWith('link:')
    ? resolve(profileDir, dependency.slice('link:'.length))
    : undefined
  const needsInstall = dependency === undefined || (linked !== undefined && linked !== options.plugin)
  if (!needsInstall) {
    record('1b. install local plugin', `(skipped) ${PLUGIN_NAME}@${dependency} already in ${join(profileDir, 'package.json')}`, undefined, true, [
      `dependency: ${PLUGIN_NAME} -> ${dependency}`,
      'idempotent: local checkout already installed',
    ])
    return manifest
  }

  const args = ['plugin', '--profile', options.profile, 'add', options.plugin]
  const commandLine = formatCommand(options.dsh, args)
  const result = await run(options.dsh, args, { timeoutMs: options.timeoutMs })
  const updated = readManifest(profileDir)
  const bundles = updated?.dsh?.profile?.bundles ?? []
  const installed = updated?.dependencies?.[PLUGIN_NAME]
  const ok = result.code === 0 && bundles.includes(PLUGIN_NAME) && installed !== undefined
  record('1b. install local plugin', commandLine, result, ok, ok
    ? [`dependencies.${PLUGIN_NAME} = ${installed}`, `bundles: ${JSON.stringify(bundles)}`]
    : ['expected a dependency entry and an activated bundle in the profile manifest'], {
    stdoutTail: result.stdout.slice(-2000),
    stderr: result.stderr.slice(-2000),
  })
  if (!ok) {
    dumpRaw('stdout', result.stdout)
    dumpRaw('stderr', result.stderr)
    return undefined
  }
  return updated
}

async function step2(options) {
  const args = ['--profile', options.profile, '--dump-config']
  const commandLine = formatCommand(options.dsh, args)
  const result = await run(options.dsh, args, { timeoutMs: options.timeoutMs })
  const combined = `${result.stdout}\n${result.stderr}`
  const hasEntry = /^#\s*==\s*dsh-agent-message\s*$/m.test(result.stdout)
    && /name:\s*'?dsh-agent-message'?/.test(result.stdout)
  const failureLines = combined.split('\n').filter((line) => FAILURE_PATTERNS.some((pattern) => pattern.test(line)))
  const ok = result.code === 0 && hasEntry && failureLines.length === 0
  const notes = [
    `dsh-agent-message bundle entry present: ${hasEntry}`,
    `failure-pattern lines: ${failureLines.length}`,
    `exit code: ${result.code}`,
  ]
  if (failureLines.length > 0) notes.push(...failureLines.map((line) => `failure line: ${line.trim()}`))
  record('2. dump-config composes the plugin bundle', commandLine, result, ok, notes, {
    hasEntry,
    failureLines,
    entrySnippet: snippet(result.stdout, /dsh-agent-message/, { before: 1, after: 2 }),
  })
  process.stdout.write(`  --- entry ---\n${snippet(result.stdout, /dsh-agent-message/, { before: 1, after: 2 })
    .split('\n').map((line) => `  | ${line}`).join('\n')}\n`)
  if (!ok) {
    dumpRaw('stdout', result.stdout)
    dumpRaw('stderr', result.stderr)
  }
  return ok
}

async function step3(options) {
  const task = options.task ?? DEFAULT_TASK
  const args = ['--profile', options.profile]
  for (const patch of options.patches) args.push('--patch', patch)
  args.push('--json')
  const commandLine = `${formatCommand(options.dsh, args)}  (task on stdin: ${JSON.stringify(task)})`
  const result = await run(options.dsh, args, { input: task, timeoutMs: options.headlessTimeoutMs, env: options.childEnv })

  const events = result.stdout.split('\n').filter((line) => line.trim() !== '').map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return { type: 'unparsed', line }
    }
  })
  const sessionId = events.find((event) => event.type === 'session')?.sessionId
  const call = events.find((event) => event.type === 'tool_call' && event.tool === 'list_peer_agents')
  const toolResult = call === undefined ? undefined : events.find((event) => event.type === 'tool_result' && event.callId === call.callId)
  const toolText = typeof toolResult?.result === 'string' ? toolResult.result : ''
  const sessions = [...new Set([...toolText.matchAll(/session-[A-Za-z0-9_-]+/g)].map((match) => match[0]))]
  const runError = events.find((event) => event.type === 'status' && event.reason?.kind === 'error')?.reason?.error?.message
  const ok = result.code === 0 && call !== undefined && toolResult?.status === 'completed' && sessions.length > 0

  const notes = [
    `exit code: ${result.code}`,
    `session id: ${sessionId ?? 'unknown'}`,
    `list_peer_agents called: ${call !== undefined}`,
    `tool result status: ${toolResult?.status ?? 'missing'}`,
    `session- ids in tool result: ${sessions.length ? sessions.join(', ') : 'none'}`,
    `failed llm/tool calls: ${events.filter((event) => event.type === 'tool_result' && event.status !== 'completed').length}`,
  ]
  if (runError !== undefined) notes.push(`run error: ${runError}`)
  if (result.timedOut) notes.push(`timed out after ${options.headlessTimeoutMs}ms`)
  record('3. headless session calls list_peer_agents', commandLine, result, ok, notes, {
    sessionId,
    toolCalled: call !== undefined,
    toolStatus: toolResult?.status,
    peerSessions: sessions,
    stdoutTail: result.stdout.slice(-4000),
    stderrTail: result.stderr.slice(-2000),
  })
  process.stdout.write('  --- list_peer_agents tool result (head) ---\n')
  for (const line of toolText.split('\n').slice(0, 24)) process.stdout.write(`  | ${line}\n`)
  if (result.stderr.trim() !== '') dumpRaw('stderr tail', result.stderr.slice(-1500))
  return ok
}
//#endregion

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(HELP)
    return
  }
  if (!existsSync(options.dsh)) throw new Error(`dsh CLI not found at ${options.dsh}`)
  if (!existsSync(join(options.plugin, 'package.json'))) throw new Error(`plugin checkout not found at ${options.plugin}`)
  if (options.profile.toLowerCase() === 'desktop') throw new Error('refusing to touch the desktop profile')
  if (options.profile === '' || /[/\\]/.test(options.profile)) throw new Error(`invalid profile name ${JSON.stringify(options.profile)}`)
  const isShippedTemplate = SHIPPED_TEMPLATES.has(options.profile.toLowerCase())
  const profileDir = join(DSH_HOME_DIR, 'profiles', options.profile)
  if (isShippedTemplate) {
    throw new Error(`profile "${options.profile}" is a shipped template name; use a temp name such as dsh-msg-compat so no shared profile is touched`)
  }
  if (options.evidence !== undefined && !resolve(options.evidence).startsWith(SCRIPTS_DIR + sep)) {
    throw new Error(`--evidence must live under ${relative(REPO_ROOT, SCRIPTS_DIR)}/`)
  }

  const versionResult = await run(options.dsh, ['--version'], { timeoutMs: options.timeoutMs })
  const version = versionResult.stdout.trim()
  process.stdout.write(`dsh: ${options.dsh}\nversion: ${version} (exit ${versionResult.code})\nprofile: ${options.profile} -> ${profileDir}\nplugin: ${PLUGIN_NAME} @ ${options.plugin}\nsteps: 1, 2${options.withHeadless ? ', 3' : ''}\n`)

  // Transient route overlay: the headless template defaults to deepseek-official,
  // which needs an API key. Mirror the desktop route through a --patch overlay and
  // resolve its credential ref into the child environment without persisting either.
  const overlayPath = join(SCRIPTS_DIR, '.verify-0.2-route.yml')
  let generatedOverlay = false
  if (options.modelRoute !== undefined) {
    const { provider, model } = writeRouteOverlay(options.modelRoute)
    const lines = ['# Generated by scripts/verify-0.2.mjs — transient, removed after the run.', '- id: agent-default-model', '  config:', `    provider: ${provider}`, `    model: ${model}`]
    if (options.credentialRef !== undefined) {
      lines.push('- id: llm-pi-ai', '  config:', '    providers:', `      ${provider}:`, `        apiKeyEnv: ${options.credentialRef}`)
    }
    writeFileSync(overlayPath, `${lines.join('\n')}\n`)
    options.patches.push(overlayPath)
    generatedOverlay = true
    process.stdout.write(`model route overlay: ${provider}/${model}${options.credentialRef === undefined ? '' : ` (credential ref ${options.credentialRef})`}\n`)
  }
  options.childEnv = { ...process.env }
  if (options.credentialRef !== undefined) {
    options.childEnv[options.credentialRef] = resolveCredentialRef(options.credentialRef)
    process.stdout.write(`credential ref ${options.credentialRef}: resolved from ${join(DSH_HOME_DIR, '.credentials.yaml')} (value not printed)\n`)
  }

  try {
    const manifest = await step1(options, profileDir)
    if (manifest !== undefined) await step2(options)
    if (options.withHeadless && !failed) await step3(options)

    const summary = {
      generatedAt: new Date().toISOString(),
      dsh: options.dsh,
      dshVersion: version,
      profile: options.profile,
      profileDir,
      pluginPath: options.plugin,
      modelRoute: options.modelRoute,
      credentialRef: options.credentialRef,
      repoRevision: readGitRevision(),
      steps: evidence,
      ok: !failed,
    }
    if (options.evidence !== undefined) {
      // Credentials stay in the child environment; redact any one-shot token a
      // command line or captured output might carry before persisting.
      const redacted = JSON.stringify(summary, null, 2).replace(/token=[A-Za-z0-9._~-]+/g, 'token=<redacted>')
      writeFileSync(options.evidence, `${redacted}\n`)
      process.stdout.write(`\nevidence written to ${options.evidence}\n`)
    }
    process.stdout.write(`\n${failed ? 'RESULT: FAIL' : 'RESULT: PASS'} (${evidence.filter((item) => item.ok).length}/${evidence.length} steps)\n`)
    process.exitCode = failed ? 1 : 0
  } finally {
    if (generatedOverlay && existsSync(overlayPath)) rmSync(overlayPath, { force: true })
  }
}

/** Best-effort local git revision for the evidence record; never runs a network command. */
function readGitRevision() {
  try {
    const head = readFileSync(join(REPO_ROOT, '.git', 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref: ')) return head
    const ref = head.slice('ref: '.length)
    return `${ref} ${readFileSync(join(REPO_ROOT, '.git', ref), 'utf8').trim().slice(0, 12)}`
  } catch {
    return undefined
  }
}

main().catch((error) => {
  process.stdout.write(`\nRESULT: FAIL — ${String(error?.stack ?? error)}\n`)
  process.exitCode = 1
})
