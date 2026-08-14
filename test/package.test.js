import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

const expectedFiles = [
  'LICENSE',
  'README.en.md',
  'README.md',
  'cordis.patch.yml',
  'docs/assets/message-header-navigation.jpg',
  'lib/client.js',
  'lib/index.js',
  'package.json',
]

test('npm 发布包只包含完整的运行时文件', () => {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const output = execFileSync(command, ['pack', '--dry-run', '--json'], { encoding: 'utf8' })
  const { files } = JSON.parse(output)

  assert.deepEqual(files.map(({ path }) => path).sort(), expectedFiles)
})
