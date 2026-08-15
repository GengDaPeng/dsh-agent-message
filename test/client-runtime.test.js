import assert from 'node:assert/strict'
import test from 'node:test'

test('会话状态变化只刷新已识别的会话链接，不重新扫描整个页面', async () => {
  const original = {
    document: globalThis.document,
    Element: globalThis.Element,
    MutationObserver: globalThis.MutationObserver,
    window: globalThis.window,
  }
  const queries = []

  class FakeElement {
    constructor(tagName = 'div') {
      this.tagName = tagName
      this.dataset = {}
      this.style = {}
      this.textContent = ''
      this.isConnected = true
      this.parentElement = null
      this.previousElementSibling = null
      this.nextElementSibling = null
      const classes = new Set()
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        contains: (name) => classes.has(name),
      }
      this.attributes = new Map()
    }

    matches() { return false }
    closest() { return null }
    contains() { return false }
    querySelectorAll(selector) { queries.push({ root: this, selector }); return [] }
    querySelector(selector) { queries.push({ root: this, selector }); return null }
    appendChild(child) { child.parentElement = this; return child }
    setAttribute(name, value) { this.attributes.set(name, String(value)) }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    hasAttribute(name) { return this.attributes.has(name) }
    remove() { this.isConnected = false }
  }

  const body = new FakeElement('body')
  const head = new FakeElement('head')
  const document = {
    body,
    head,
    documentElement: { lang: 'zh-CN' },
    createElement: (tagName) => new FakeElement(tagName),
    addEventListener() {},
    removeEventListener() {},
  }
  let loaded
  const sessionSubscribers = []
  const workspaceSubscribers = []
  const cleanups = []

  try {
    globalThis.document = document
    globalThis.Element = FakeElement
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    }
    globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
    await import('../lib/client.js?runtime-test')

    const React = {
      createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
      useState: (value) => [value, () => {}],
    }
    const client = loaded.factory((id) => {
      if (id === 'react') return React
      if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
      if (id === '@deepseek-ai/dsh-client-ui-primitives') {
        return { IconQueueOutline14() {}, StateDot() {} }
      }
      throw new Error('unexpected client dependency: ' + id)
    })
    const workspaces = {
      list: {
        getSnapshot: () => ({ archivedSessionIds: [] }),
        subscribe: (callback) => { workspaceSubscribers.push(callback); return () => {} },
      },
    }
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => ({ ids: [], byId: {} }),
          subscribe: (callback) => { sessionSubscribers.push(callback); return () => {} },
        },
        binding: () => undefined,
        open() {},
      },
      slots: {
        inject(_name, register) { register() },
        register() { return () => {} },
      },
      get(name) {
        if (name === 'workspaces') return workspaces
        if (name === 'inputTriggers') return { registerSource: () => () => {} }
      },
      effect(factory) {
        const cleanup = factory()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      },
      timeout(callback) { callback() },
    }

    client.apply(ctx)
    queries.length = 0
    sessionSubscribers[0]()
    workspaceSubscribers[0]()

    assert.deepEqual(queries.filter(({ root }) => root === body), [])
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
    globalThis.document = original.document
    globalThis.Element = original.Element
    globalThis.MutationObserver = original.MutationObserver
    globalThis.window = original.window
  }
})
