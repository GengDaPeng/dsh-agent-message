import assert from 'node:assert/strict'
import test from 'node:test'

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
      remove: (...names) => names.forEach((name) => classes.delete(name)),
    }
    this.attributes = new Map()
  }

  matches() { return false }
  closest() { return null }
  contains() { return false }
  querySelectorAll(selector) { queries.push({ root: this, selector }); return [] }
  querySelector(selector) { queries.push({ root: this, selector }); return null }
  appendChild(child) { child.parentElement = this; return child }
  insertBefore(child, reference) { child.parentElement = this; if (reference) reference.previousElementSibling = child; return child }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  removeAttribute(name) { this.attributes.delete(name) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  hasAttribute(name) { return this.attributes.has(name) }
  remove() { this.isConnected = false }
  click() {}
}

/**
 * 装载客户端模块并提供 0.2.1 形状的 ctx。
 * @param slug - 每个用例独立的模块实例后缀，避免 ESM 缓存串场。
 * @param options.lackingWorkspace - 省略 uiWorkspace 服务，验证静默降级。
 */
async function harness(slug, options = {}) {
  const cleanups = []
  const sessionSubscribers = []
  const localeSubscribers = []
  const listeners = []
  const registered = []
  const opened = []
  const observers = []

  const body = new FakeElement('body')
  const head = new FakeElement('head')
  const document = {
    body,
    head,
    documentElement: { lang: 'zh-CN' },
    createElement: (tagName) => new FakeNode(tagName),
    addEventListener: (type, handler) => { listeners.push({ type, handler }) },
    removeEventListener: (type, handler) => {
      const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler)
      if (index >= 0) listeners.splice(index, 1)
    },
  }

  const previous = {
    document: globalThis.document,
    Element: globalThis.Element,
    MutationObserver: globalThis.MutationObserver,
    window: globalThis.window,
  }

  globalThis.document = document
  globalThis.Element = FakeElement
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe() {}
    disconnect() {}
  }

  let loaded
  globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
  await import(`../lib/client.js?runtime-${slug}`)

  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: (value) => [value, () => {}],
  }
  const client = loaded.factory((id) => {
    if (id === 'react') return React
    throw new Error('unexpected client dependency: ' + id)
  })

  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => ({ ids: [], byId: {} }),
        subscribe: (callback) => { sessionSubscribers.push(callback); return () => {} },
      },
    },
    locale: {
      getSnapshot: () => ({ active: 'zh', revision: 0 }),
      subscribe: (callback) => { localeSubscribers.push(callback); return () => {} },
    },
    slots: {
      inject(_name, register) { register() },
      register(descriptor) { registered.push(descriptor); return () => {} },
    },
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    timeout(callback) { callback() },
  }
  if (options.lackingWorkspace !== true) {
    ctx.uiWorkspace = { openSession: (sessionId) => { opened.push(sessionId) } }
  }

  async function restore() {
    for (const cleanup of cleanups.reverse()) await cleanup()
    globalThis.document = previous.document
    globalThis.Element = previous.Element
    globalThis.MutationObserver = previous.MutationObserver
    globalThis.window = previous.window
  }

  return { client, ctx, document, body, listeners, registered, opened, observers, sessionSubscribers, localeSubscribers, restore }
}

function dispatch(listeners, type, event) {
  const entry = listeners.filter((item) => item.type === type).pop()
  assert.ok(entry, `no ${type} listener registered`)
  entry.handler(event)
}

function senderEvent(sessionId) {
  const link = new FakeElement('span')
  link.dataset.agentMsgSessionId = sessionId
  const target = new FakeElement('span')
  target.closest = (selector) => (selector === '.agent-msg-session-link' ? link : null)
  const event = {
    target,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { event.defaultPrevented = true },
    stopPropagation() { event.propagationStopped = true },
  }
  return event
}

test('会话或语言变化只刷新已识别的发送方链接，不重新扫描整个页面', async () => {
  const h = await harness('refresh')
  try {
    h.client.apply(h.ctx)
    queries.length = 0
    h.sessionSubscribers[0]()
    h.localeSubscribers[0]()

    assert.deepEqual(queries.filter(({ root }) => root === h.body), [])
  } finally {
    await h.restore()
  }
})

test('注入 0.2.1 的运行时服务，头部动作描述符不再带 label', async () => {
  const h = await harness('inject')
  try {
    assert.deepEqual(h.client.inject, ['slots', 'timer', 'sessions', 'uiWorkspace', 'locale'])
    h.client.apply(h.ctx)

    assert.deepEqual(h.registered, [{
      name: 'conversation.session.header.actions',
      id: 'copy-session-id',
      order: 30,
    }])
  } finally {
    await h.restore()
  }
})

test('点击或键盘激活发送方链接走 uiWorkspace.openSession', async () => {
  const h = await harness('navigate')
  try {
    h.client.apply(h.ctx)

    const click = senderEvent('session-click')
    dispatch(h.listeners, 'click', click)
    assert.deepEqual(h.opened, ['session-click'])
    assert.equal(click.defaultPrevented, true)
    assert.equal(click.propagationStopped, true)

    const keydown = senderEvent('session-enter')
    keydown.key = 'Enter'
    dispatch(h.listeners, 'keydown', keydown)
    assert.deepEqual(h.opened, ['session-click', 'session-enter'])
  } finally {
    await h.restore()
  }
})

test('uiWorkspace 缺失时发送方跳转静默降级', async () => {
  const h = await harness('degrade', { lackingWorkspace: true })
  try {
    h.client.apply(h.ctx)

    const event = senderEvent('session-missing')
    dispatch(h.listeners, 'click', event)

    assert.deepEqual(h.opened, [])
    assert.equal(event.defaultPrevented, true)
  } finally {
    await h.restore()
  }
})

/** 支持属性/类选择器的最小树节点，用于验证 0.2.x turn-trigger 渲染路径。 */
class FakeNode extends FakeElement {
  constructor(tagName = 'div') {
    super(tagName)
    this.children = []
    this.selectorMatches = []
    this.closestMap = {}
  }

  matches(selector) { return this.selectorMatches.includes(selector) || matchesSelector(this, selector) }

  closest(selector) { return matchesSelector(this, selector) ? this : (this.closestMap[selector] ?? null) }

  appendChild(child) { child.parentElement = this; this.children.push(child); return child }

  insertBefore(child, reference) {
    child.parentElement = this
    const index = this.children.indexOf(reference)
    this.children.splice(index < 0 ? this.children.length : index, 0, child)
    return child
  }

  querySelector(selector) { return this.findAll(selector)[0] ?? null }

  querySelectorAll(selector) { return this.findAll(selector) }

  findAll(selector) {
    const found = []
    const visit = (node) => {
      for (const child of node.children ?? []) {
        if (matchesSelector(child, selector)) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }
}

function matchesSelector(node, selector) {
  const attribute = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector)
  if (attribute !== null) {
    const value = node.attributes?.get(attribute[1])
    return attribute[2] === undefined ? value !== undefined : value === attribute[2]
  }
  const className = /^\.([a-z-]+)$/.exec(selector)
  if (className !== null) return node.classList.contains(className[1])
  return false
}

test('0.2.x turn-trigger 里的 relay 被剥离协议头并补出发送方链接', async () => {
  const h = await harness('trigger')
  try {
    h.client.apply(h.ctx)

    const text = new FakeNode('pre')
    text.setAttribute('data-context-text', '')
    text.textContent = '<dsh-agent-message>{"senderSessionId":"session-sender"}</dsh-agent-message>\n\n端到端正文'
    const content = new FakeNode('div')
    content.appendChild(text)
    const bodyNode = new FakeNode('div')
    bodyNode.appendChild(content)
    const row = new FakeNode('section')
    row.setAttribute('data-turn-trigger', 'true')
    row.appendChild(bodyNode)
    bodyNode.closestMap['[data-turn-trigger="true"]'] = row

    assert.equal(h.observers.length, 1)
    h.observers[0].callback([{ addedNodes: [bodyNode], removedNodes: [] }])

    assert.equal(text.textContent, '端到端正文')
    assert.equal(text.dataset.agentMsgRelayBody, 'true')
    assert.equal(row.getAttribute('data-agent-msg-relay-card'), 'true')
    const line = content.children.find((child) => child.hasAttribute?.('data-context-relay-sender') === true)
    assert.ok(line, 'sender line must be inserted above the relay body')
    assert.equal(line.dataset.agentMsgSessionId, 'session-sender')
    assert.equal(line.getAttribute('role'), 'link')
    assert.match(line.textContent, /session-sender/)
  } finally {
    await h.restore()
  }
})
