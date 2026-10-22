import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const MENU = 'sidebar.workspaces.session.menu.item'
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function harness(t, { native = false, inspect = true, observe = true, rejectRegistration = false } = {}) {
  const entries = []
  const subscribers = new Set()
  const injections = new Map()
  const cleanups = []
  const copied = []
  let queued = false
  let registrations = 0
  let unloading = false
  let definition
  const notify = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      for (const callback of [...subscribers]) callback()
    })
  }
  class Element {
    matches() { return false }
    closest() { return null }
    querySelectorAll() { return [] }
    appendChild() {}
    setAttribute() {}
    remove() {}
  }
  const document = { body: new Element(), head: new Element(), createElement: () => new Element(), addEventListener() {}, removeEventListener() {} }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { definition = value } } },
    document, Element, queueMicrotask,
    MutationObserver: class { observe() {} disconnect() {} },
    navigator: { clipboard: { async writeText(text) { copied.push(text) } } },
  })
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: value => [value, () => {}],
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
  const client = definition.factory(name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MenuItemButton() {}, IconCopyOutlineRegular() {} }
    throw new Error(`unexpected dependency: ${name}`)
  })
  const nativeEntry = { options: { name: MENU, id: 'session-id', order: 450 } }
  if (native) entries.push(nativeEntry)
  const slots = {
    inject(name, callback) {
      const record = { callback, dispose: undefined }
      injections.set(name, record)
      record.dispose = callback()
      const stop = () => { record.dispose?.(); record.dispose = undefined }
      cleanups.push(stop)
      return stop
    },
    register(options, component) {
      if (options.name === MENU) {
        if (rejectRegistration) throw new Error('registration rejected')
        if (unloading) throw Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })
        registrations++
      }
      const entry = { options, component }
      entries.push(entry)
      notify()
      return () => {
        const index = entries.indexOf(entry)
        if (index < 0) return
        entries.splice(index, 1)
        notify()
      }
    },
    ...(inspect ? { entriesOfSlot: name => entries.filter(entry => entry.options.name === name) } : {}),
    ...(observe ? { subscribe(name, callback) {
      assert.equal(name, MENU)
      subscribers.add(callback)
      return () => subscribers.delete(callback)
    } } : {}),
  }
  const ctx = {
    slots,
    locale: { getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} },
    sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} } },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') cleanups.push(dispose) },
  }
  const dispose = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() }
  t.after(dispose)
  return {
    apply: () => client.apply(ctx), dispose, copied, entries, subscribers,
    beginUnload() { unloading = true },
    get registrations() { return registrations },
    fallback: () => entries.filter(entry => entry.options.name === MENU && entry.options.id === 'copy-session-id'),
    setNative(present) {
      const index = entries.indexOf(nativeEntry)
      if (present && index < 0) entries.push(nativeEntry)
      if (!present && index >= 0) entries.splice(index, 1)
      notify()
    },
    collapse() { const record = injections.get(MENU); record.dispose?.(); record.dispose = undefined },
    redeclare() { const record = injections.get(MENU); record.dispose = record.callback() },
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

test('native Session ID entry suppresses plugin registration, preserving the header action', async t => {
  const app = harness(t, { native: true })
  app.apply()
  await flush()
  assert.equal(app.registrations, 0)
  assert.equal(app.fallback().length, 0)
  assert.equal(app.entries.filter(entry => entry.options.name === MENU).length, 1)
  assert.equal(app.entries.filter(entry => entry.options.name === 'conversation.session.header.actions').length, 1)
})

test('older hosts without a native copy entry retain row-specific clipboard copying', async t => {
  const app = harness(t)
  app.apply()
  await flush()
  assert.equal(app.fallback().length, 1)
  let open = true
  const item = app.fallback()[0].component({ sessionId: 'session-other-row', useMenuOpenState: () => [open, value => { open = value }] })
  await item.props.onSelect()
  assert.deepEqual(app.copied, ['session-other-row'])
  assert.equal(open, false)
})

test('native registration and removal reconcile the fallback without duplicate registrations', async t => {
  const app = harness(t)
  app.apply()
  app.setNative(true)
  await flush()
  assert.equal(app.fallback().length, 0)
  app.setNative(false)
  await flush()
  assert.equal(app.fallback().length, 1)
  assert.equal(app.registrations, 2)
})

test('slot collapse disposes the observer and re-declaration checks the new native entries', async t => {
  const app = harness(t, { native: true })
  app.apply()
  app.collapse()
  assert.equal(app.subscribers.size, 0)
  app.setNative(false)
  await flush()
  assert.equal(app.fallback().length, 0)
  app.redeclare()
  await flush()
  assert.equal(app.fallback().length, 1)
})

test('unload cancels queued reconciliation and removes the fallback and observer', async t => {
  const app = harness(t, { native: true })
  app.apply()
  app.setNative(false)
  app.dispose()
  await flush()
  assert.equal(app.subscribers.size, 0)
  assert.equal(app.fallback().length, 0)
})

test('queued notifications during asynchronous Cordis teardown release the observer without creating effects', async t => {
  const app = harness(t, { native: true })
  app.apply()
  app.setNative(false)
  app.beginUnload()
  await flush()
  assert.equal(app.subscribers.size, 0)
  assert.equal(app.fallback().length, 0)
  app.dispose()
})

test('hosts without inspection or change subscriptions keep the original fallback', async t => {
  const app = harness(t, { inspect: false, observe: false })
  app.apply()
  await flush()
  assert.equal(app.fallback().length, 1)
})

test('failed initial registration releases its change subscription', t => {
  const app = harness(t, { rejectRegistration: true })
  assert.throws(() => app.apply(), /registration rejected/)
  assert.equal(app.subscribers.size, 0)
})
