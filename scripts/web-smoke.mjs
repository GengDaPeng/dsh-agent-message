import assert from 'node:assert/strict'
import { once } from 'node:events'
import { execFileSync, spawn } from 'node:child_process'

const dsh = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
const config = execFileSync(dsh, ['--profile', 'web', '--dump-config'], { encoding: 'utf8' })

assert.equal(config.match(/name: '@deepseek-ai\/dsh-client-ui-reference'/g)?.length, 1)
assert.match(config, /name: dsh-agent-message/)

const child = spawn(dsh, ['--profile', 'web', '--port', '0', '--no-open'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''

try {
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`DSH startup timed out:\n${output}`)), 30_000)
    const inspect = (chunk) => {
      output += chunk
      const match = output.match(/dsh web: (http:\/\/[^\s]+)/)
      if (!match) return
      clearTimeout(timeout)
      resolve(match[1])
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('exit', (code) => reject(new Error(`DSH exited with ${code}:\n${output}`)))
  })
  const response = await fetch(url)
  assert.equal(response.status, 200)
  console.log(`Web profile smoke passed: ${url}`)
} finally {
  if (child.exitCode === null) {
    child.kill()
    await once(child, 'exit')
  }
}
