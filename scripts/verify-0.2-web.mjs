#!/usr/bin/env node
/**
 * Web-side acceptance for dsh-agent-message on DeepSeek Harness 0.2.x.
 *
 * Boots the installed CLI with a temporary `web`-template profile, verifies the
 * plugin bundle still composes, then confirms the browser-facing client half is
 * actually served:
 *   - `dsh --profile <p> --dump-config` still contains the plugin entry
 *   - the web app starts with no client-module load error
 *   - the served HTML registers the plugin client half, and fetching that URL
 *     returns 200 with the bundle that names itself `dsh-agent-message-client`
 *
 * Note on the 0.2.x URL shape: the web app serves client halves through a bundled
 * `plugins/??<pkg>/client.js&rev=<hash>` URL listed in the HTML module manifest;
 * the plain `plugins/<pkg>/client.js` path answers 404. The printed web URL also
 * carries a one-shot `?token=` that must be exchanged for the `dsh-auth` cookie
 * before any request is authorized.
 *
 * Usage:
 *   node scripts/verify-0.2-web.mjs [--profile dsh-msg-compat-web] [--port 0]
 *
 * Options:
 *   --dsh <path>        bundled CLI (default macOS app path, or $DSH_BIN)
 *   --profile <name>    temp web profile name (default dsh-msg-compat-web)
 *   --plugin <path>     local plugin checkout (default repository root)
 *   --port <n>          web port (default 0 = ephemeral)
 *   --timeout <seconds> startup timeout (default 120)
 *   --evidence <path>   write a JSON evidence record (must live under scripts/)
 *
 * Only files under `scripts/` are written; the desktop profile is never touched
 * and an existing profile is only replaced when it is a generated `dsh-msg-*`
 * profile missing the web bundle.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts')
const DEFAULT_DSH = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const PLUGIN_NAME = 'dsh-agent-message'
const CLIENT_PATH = '/plugins/dsh-agent-message/client.js'
const CLIENT_MARKER = 'dsh-agent-message-client'
const WEB_BUNDLE = '@deepseek-ai/dsh-web-app'
const WEB_TEMPLATE = 'web'
const TEMP_PROFILE_PREFIX = 'dsh-msg-'
const SHIPPED_TEMPLATES = new Set(['acp', 'web', 'headless', 'sdk', 'sdk-minimal'])
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

const evidence = []
let failed = false

function parseArgs(argv) {
  const options = {
    dsh: process.env.DSH_BIN || DEFAULT_DSH,
    profile: process.env.DSH_MSG_WEB_PROFILE || 'dsh-msg-compat-web',
    plugin: REPO_ROOT,
    port: '0',
    timeoutMs: 120_000,
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
    else if (arg === '--port') options.port = value()
    else if (arg === '--timeout') options.timeoutMs = Number(value()) * 1000
    else if (arg === '--evidence') options.evidence = resolve(value())
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  return options
}

const HELP = `Usage: node scripts/verify-0.2-web.mjs [options]

  --dsh <path>        bundled dsh CLI (default ${DEFAULT_DSH})
  --profile <name>    temp web profile (default dsh-msg-compat-web)
  --plugin <path>     local plugin checkout (default repository root)
  --port <n>          web port (default 0)
  --timeout <seconds> startup timeout (default 120)
  --evidence <path>   JSON evidence under scripts/
`

function run(command, args, { timeoutMs } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
  })
}

function formatCommand(command, args) {
  return [command, ...args].map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part)).join(' ')
}

function record(step, command, result, ok, notes, extra = {}) {
  evidence.push({ step, command, exitCode: result?.code ?? null, ok, notes, ...extra })
  if (!ok) failed = true
  process.stdout.write(`\n[${ok ? 'PASS' : 'FAIL'}] ${step}\n  $ ${command}\n  exit=${result?.code ?? 'n/a'}\n`)
  for (const note of notes) process.stdout.write(`  - ${note}\n`)
}

function readManifest(profileDir) {
  const path = join(profileDir, 'package.json')
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Wait for the web URL the app prints, or fail on early exit / timeout. */
function waitForUrl(child, output, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`web startup timed out after ${timeoutMs}ms:\n${output.value}`)), timeoutMs)
    const inspect = (chunk) => {
      output.value += chunk
      const match = output.value.match(/dsh web: (http:\/\/[^\s]+)/)
      if (match === null) return
      clearTimeout(timer)
      resolvePromise(match[1])
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('exit', (code) => {
      clearTimeout(timer)
      rejectPromise(new Error(`dsh web exited with ${code}:\n${output.value}`))
    })
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(HELP)
    return
  }
  if (!existsSync(options.dsh)) throw new Error(`dsh CLI not found at ${options.dsh}`)
  if (!existsSync(join(options.plugin, 'package.json'))) throw new Error(`plugin checkout not found at ${options.plugin}`)
  if (options.profile.toLowerCase() === 'desktop') throw new Error('refusing to touch the desktop profile')
  if (SHIPPED_TEMPLATES.has(options.profile.toLowerCase())) throw new Error(`profile "${options.profile}" is a shipped template name; use a dsh-msg-* temp name`)
  if (options.evidence !== undefined && !resolve(options.evidence).startsWith(SCRIPTS_DIR + sep)) {
    throw new Error(`--evidence must live under ${relative(REPO_ROOT, SCRIPTS_DIR)}/`)
  }

  const profileDir = join(homedir(), '.dsh', 'profiles', options.profile)
  const versionResult = await run(options.dsh, ['--version'], { timeoutMs: options.timeoutMs })
  process.stdout.write(`dsh: ${options.dsh}\nversion: ${versionResult.stdout.trim()}\nprofile: ${options.profile} -> ${profileDir}\nplugin: ${PLUGIN_NAME} @ ${options.plugin}\n`)

  // 1. web-template profile
  let manifest = readManifest(profileDir)
  let created = false
  if (manifest === undefined) {
    const args = ['--profile', options.profile, '--from-default-profile', WEB_TEMPLATE, '--dump-config']
    const result = await run(options.dsh, args, { timeoutMs: options.timeoutMs })
    created = result.code === 0 && existsSync(join(profileDir, 'package.json'))
    record('1a. create temp web profile', formatCommand(options.dsh, args), result, created, created
      ? [`profile dir: ${profileDir}`, 'created from shipped web template']
      : ['profile was not created'])
    if (!created) return finish(options, versionResult.stdout.trim(), profileDir)
    manifest = readManifest(profileDir)
  } else if (!(manifest.dsh?.profile?.bundles ?? []).includes(WEB_BUNDLE)) {
    if (!options.profile.startsWith(TEMP_PROFILE_PREFIX)) {
      record('1a. profile ready', `read ${join(profileDir, 'package.json')}`, undefined, false, [
        `bundles: ${JSON.stringify(manifest.dsh?.profile?.bundles ?? [])}`,
        'not a generated temp web profile; refusing to replace it',
      ])
      return finish(options, versionResult.stdout.trim(), profileDir)
    }
    const args = ['--profile', options.profile, '--from-default-profile', WEB_TEMPLATE, '--dump-config']
    const result = await run(options.dsh, args, { timeoutMs: options.timeoutMs })
    created = result.code === 0 && (readManifest(profileDir)?.dsh?.profile?.bundles ?? []).includes(WEB_BUNDLE)
    record('1a. recreate temp web profile', formatCommand(options.dsh, args), result, created, created
      ? ['profile lacked the web bundle; recreated from the shipped web template']
      : ['profile missing the web bundle and could not be recreated'])
    if (!created) return finish(options, versionResult.stdout.trim(), profileDir)
    manifest = readManifest(profileDir)
  }
  if (!created) {
    record('1a. profile ready', `read ${join(profileDir, 'package.json')}`, undefined, true, [
      'reusing existing temp web profile',
      `bundles: ${JSON.stringify(manifest.dsh?.profile?.bundles ?? [])}`,
    ])
  }

  // 2. install local plugin (idempotent)
  const dependency = manifest.dependencies?.[PLUGIN_NAME]
  const linked = typeof dependency === 'string' && dependency.startsWith('link:')
    ? resolve(profileDir, dependency.slice('link:'.length))
    : undefined
  if (dependency === undefined || (linked !== undefined && linked !== options.plugin)) {
    const args = ['plugin', '--profile', options.profile, 'add', options.plugin]
    const result = await run(options.dsh, args, { timeoutMs: options.timeoutMs })
    const updated = readManifest(profileDir)
    const ok = result.code === 0 && (updated?.dsh?.profile?.bundles ?? []).includes(PLUGIN_NAME) && updated?.dependencies?.[PLUGIN_NAME] !== undefined
    record('2. install local plugin', formatCommand(options.dsh, args), result, ok, ok
      ? [`dependencies.${PLUGIN_NAME} = ${updated.dependencies[PLUGIN_NAME]}`, `bundles: ${JSON.stringify(updated.dsh.profile.bundles)}`]
      : ['expected a dependency entry and an activated bundle'])
    if (!ok) return finish(options, versionResult.stdout.trim(), profileDir)
  } else {
    record('2. install local plugin', `(skipped) ${PLUGIN_NAME}@${dependency} already installed`, undefined, true, [
      'idempotent: local checkout already installed',
    ])
  }

  // 3. dump-config still composes the plugin bundle
  const dumpArgs = ['--profile', options.profile, '--dump-config']
  const dump = await run(options.dsh, dumpArgs, { timeoutMs: options.timeoutMs })
  const combined = `${dump.stdout}\n${dump.stderr}`
  const hasEntry = /^#\s*==\s*dsh-agent-message\s*$/m.test(dump.stdout) && /name:\s*'?dsh-agent-message'?/.test(dump.stdout)
  const failureLines = combined.split('\n').filter((line) => FAILURE_PATTERNS.some((pattern) => pattern.test(line)))
  const dumpOk = dump.code === 0 && hasEntry && failureLines.length === 0
  record('3. dump-config composes the plugin bundle', formatCommand(options.dsh, dumpArgs), dump, dumpOk, [
    `dsh-agent-message bundle entry present: ${hasEntry}`,
    `failure-pattern lines: ${failureLines.length}`,
    `exit code: ${dump.code}`,
  ], { hasEntry, failureLines })

  // 4. boot the web app and fetch the client half
  const bootArgs = ['--profile', options.profile, '--port', options.port, '--no-open']
  const bootCommand = formatCommand(options.dsh, bootArgs)
  const child = spawn(options.dsh, bootArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
  const output = { value: '' }
  let url
  let bootError
  try {
    url = await waitForUrl(child, output, options.timeoutMs)
  } catch (error) {
    bootError = String(error?.message ?? error)
  }
  if (url === undefined) {
    child.kill('SIGKILL')
    record('4a. boot web profile', bootCommand, undefined, false, ['no "dsh web: <url>" line'], { startupOutput: output.value.slice(-4000) })
  } else {
    process.stdout.write(`  url: ${url}\n`)
    // The printed URL carries a one-shot ?token=; the server answers it with a
    // redirect plus a dsh-auth cookie. Node's fetch has no cookie jar, so follow
    // that handshake by hand, then read the browser-facing module list from the
    // served HTML (0.2.x serves client halves as `plugins/??<pkg>/client.js&rev=`).
    const tokenUrl = new URL(url)
    const authResponse = await fetch(tokenUrl, { redirect: 'manual' }).catch((error) => ({ status: 0, headers: new Headers(), text: async () => String(error) }))
    const cookie = (authResponse.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ')
    const location = authResponse.headers.get('location')
    const rootUrl = location === null || location === undefined ? url : new URL(location, url).toString()
    const headers = cookie === '' ? {} : { cookie }
    const rootResponse = await fetch(rootUrl, { headers }).catch((error) => ({ status: 0, text: async () => String(error) }))
    const html = await rootResponse.text()
    const declared = html.match(/"id":"dsh-agent-message","url":"([^"]+)"/)?.[1]?.replaceAll('&amp;', '&')
    const directUrl = new URL(CLIENT_PATH, rootUrl).toString()
    const clientUrl = declared === undefined ? directUrl : new URL(declared, rootUrl).toString()
    let clientStatus = 0
    let clientBody = ''
    try {
      const clientResponse = await fetch(clientUrl, { headers })
      clientStatus = clientResponse.status
      clientBody = await clientResponse.text()
    } catch (error) {
      clientBody = String(error)
    }
    let directStatus = 0
    try {
      directStatus = (await fetch(directUrl, { headers })).status
    } catch {
      directStatus = 0
    }
    const loadErrorLines = output.value.split('\n').filter((line) => /(?:client|plugin).{0,40}(?:error|failed|failure)/i.test(line) || /failed to (?:load|import)/i.test(line))
    const bootOk = rootResponse.status === 200 && clientStatus === 200 && clientBody.includes(CLIENT_MARKER) && loadErrorLines.length === 0 && declared !== undefined
    record('4a. boot web profile', bootCommand, undefined, rootResponse.status === 200 && loadErrorLines.length === 0 && declared !== undefined, [
      `url: ${url}`,
      `GET ${rootUrl} (after token handshake) -> ${rootResponse.status}; token redirect status ${authResponse.status}`,
      `client half registered in served HTML: ${declared !== undefined}`,
      `client load error lines in startup output: ${loadErrorLines.length}`,
    ], { url, rootUrl, tokenRedirectStatus: authResponse.status, rootStatus: rootResponse.status, declaredClientUrl: declared, loadErrorLines, startupOutput: output.value.slice(-4000) })
    record('4b. serve client half', `GET ${clientUrl}`, undefined, clientStatus === 200 && clientBody.includes(CLIENT_MARKER), [
      `HTTP status: ${clientStatus}`,
      `body bytes: ${clientBody.length}`,
      `body contains "${CLIENT_MARKER}": ${clientBody.includes(CLIENT_MARKER)}`,
      `plain ${CLIENT_PATH} status (0.2.x serves the bundled ?? URL): ${directStatus}`,
      'auth: dsh-auth cookie obtained from the printed ?token= URL',
    ], { clientUrl, directUrl, clientStatus, directStatus, marker: CLIENT_MARKER, bodyHead: clientBody.slice(0, 400) })
    process.stdout.write(`  --- startup output (tail) ---\n${output.value.slice(-1200).split('\n').map((line) => `  | ${line}`).join('\n')}\n`)
    process.stdout.write(`  --- served client bundle (head) ---\n${clientBody.slice(0, 300).split('\n').map((line) => `  | ${line}`).join('\n')}\n`)
    if (!bootOk) process.stdout.write(`  (boot/client checks failed)\n`)
  }
  if (child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000))])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  return finish(options, versionResult.stdout.trim(), profileDir, { url, bootError })
}

function finish(options, version, profileDir, extra = {}) {
  const summary = {
    generatedAt: new Date().toISOString(),
    dsh: options.dsh,
    dshVersion: version,
    profile: options.profile,
    profileDir,
    pluginPath: options.plugin,
    clientPath: CLIENT_PATH,
    ...extra,
    steps: evidence,
    ok: !failed,
  }
  if (options.evidence !== undefined) {
    // The printed ?token= is a one-shot credential: never persist it, even though
    // the live URL is printed to the console for the operator.
    const redacted = JSON.stringify(summary, null, 2).replace(/token=[A-Za-z0-9._~-]+/g, 'token=<redacted>')
    writeFileSync(options.evidence, `${redacted}\n`)
    process.stdout.write(`\nevidence written to ${options.evidence}\n`)
  }
  process.stdout.write(`\n${failed ? 'RESULT: FAIL' : 'RESULT: PASS'} (${evidence.filter((item) => item.ok).length}/${evidence.length} steps)\n`)
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => {
  process.stdout.write(`\nRESULT: FAIL — ${String(error?.stack ?? error)}\n`)
  process.exitCode = 1
})
