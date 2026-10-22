import assert from 'node:assert/strict'
import test from 'node:test'

test('rc.2 relay 导航、ID 菜单、语言和配置写入共同保持原生引用独立', async () => {
  const original = {
    document: globalThis.document,
    Element: globalThis.Element,
    MutationObserver: globalThis.MutationObserver,
    window: globalThis.window,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  }
  const queries = []
  let iconRenders = 0
  const copied = []
  const opened = []
  const listeners = new Map()
  const slots = new Map()
  const definitions = new Map()
  const localeSubscribers = []
  let language = 'zh'
  let display = true
  let acceptWrite = true

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
      this.children = []
      const classes = new Set()
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        contains: (name) => classes.has(name),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
      }
      this.attributes = new Map()
    }

    matches(selector) { return selector.split(',').some((part) => /^\[([^=\]]+)\]$/.test(part.trim()) && this.hasAttribute(part.trim().slice(1, -1))) }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null }
    contains() { return false }
    querySelectorAll(selector) { queries.push({ root: this, selector }); return [] }
    querySelector(selector) { queries.push({ root: this, selector }); return null }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child }
    insertBefore(child, before) { child.parentElement = this; this.children.splice(this.children.indexOf(before), 0, child); return child }
    setAttribute(name, value) { this.attributes.set(name, String(value)) }
    removeAttribute(name) { this.attributes.delete(name) }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    hasAttribute(name) { return this.attributes.has(name) }
    remove() { this.isConnected = false }
  }

  const body = new FakeElement('body')
  const head = new FakeElement('head')
  const reference = new FakeElement('span')
  const trigger = new FakeElement('section')
  trigger.setAttribute('data-turn-trigger', 'true')
  const triggerText = new FakeElement('pre')
  triggerText.textContent = '<dsh-agent-message>{"senderSessionId":"session-peer"}</dsh-agent-message>\n\nMAIN_FIX_1 <literal>'
  trigger.appendChild(triggerText)
  trigger.querySelector = (selector) => selector === '[data-context-text]' ? triggerText
    : trigger.children.find((child) => child.matches(selector)) ?? null
  reference.textContent = '@session-peer'
  reference.matches = (selector) => selector === '[data-ref-chip="subagent"]'
  reference.querySelector = (selector) => selector === ':scope > .agent-msg-reference-host'
    ? reference.children.find((element) => element.className === 'agent-msg-reference-host') ?? null : null
  body.querySelectorAll = (selector) => {
    queries.push({ root: body, selector })
    if (selector === '[data-ref-chip="subagent"]') return [reference]
    if (selector === '[data-context-form="relay"], [data-turn-trigger]') return [trigger]
    if (selector === '[data-context-relay-sender]') return trigger.children.filter((child) => child.hasAttribute('data-context-relay-sender'))
    return []
  }
  const document = {
    body,
    head,
    documentElement: { lang: 'zh-CN' },
    createElement: (tagName) => new FakeElement(tagName),
    addEventListener(name, handler) { listeners.set(name, handler) },
    removeEventListener(name) { listeners.delete(name) },
  }
  let loaded
  const sessionSubscribers = []
  const cleanups = []

  try {
    globalThis.document = document
    globalThis.Element = FakeElement
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    }
    globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { async writeText(value) { copied.push(value) } } } })
    await import('../lib/client.js?runtime-test')

    assert.equal(loaded.id, 'dsh-agent-message')

    const React = {
      createElement: (type, props, ...children) => {
        assert.ok(type !== undefined, 'every component must exist in the rc.2 export namespace')
        const values = { ...props, children }
        return typeof type === 'function' ? type(values) : { type, props: values }
      },
      useState: (value) => [value, () => {}],
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    }
    const client = loaded.factory((id) => {
      if (id === 'react') return React
      if (id === '@deepseek-ai/dsh-client-ui-primitives') {
        // Exactly the names supplied by the installed rc.2 primitives module.
        return { IconCopyOutlineRegular(props) { iconRenders++; assert.equal(props.size, 14); return { type: 'svg' } }, MenuItemButton(props) { return { type: 'menu-item', props } } }
      }
      throw new Error('unexpected client dependency: ' + id)
    })
    assert.equal(client.name, 'dsh-agent-message-client')
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => ({ ids: ['session-peer'], byId: { 'session-peer': { id: 'session-peer', displayTitle: 'Peer', blank: false } } }),
          subscribe: (callback) => { sessionSubscribers.push(callback); return () => {} },
        },
        binding() { assert.fail('the client must not submit or intercept composer input') },
      },
      uiWorkspace: { openSession(id) { opened.push(id) } },
      locale: {
        getSnapshot: () => ({ active: language, revision: 0 }),
        subscribe(callback) { localeSubscribers.push(callback); return () => {} },
      },
      configForms: {
        get(id) {
          assert.equal(id, 'agent-message')
          return {
            getSnapshot: () => ({ value: { showTechnicalDetails: display } }),
            subscribe: () => () => {},
            async set(field, value) {
              assert.equal(field, 'showTechnicalDetails')
              if (!acceptWrite) return false
              display = value
              return true
            },
          }
        },
        whileServed(namespaces, register) {
          assert.deepEqual(namespaces, ['agent-message'])
          return register()
        },
      },
      slots: {
        inject(_name, register) { register() },
        register(definition, renderer) { slots.set(definition.name, renderer); definitions.set(definition.name, definition); return () => {} },
      },
      get(name) { assert.fail('unexpected service lookup: ' + name) },
      effect(factory) {
        const cleanup = factory()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      },
      timeout(callback) { callback() },
    }

    client.apply(ctx)
    assert.equal(reference.textContent, '@session-peer')
    assert.deepEqual(reference.children, [])
    assert.equal(reference.attributes.size, 0, 'ordinary references retain their native DOM and behavior')
    assert.equal(triggerText.textContent, 'MAIN_FIX_1 <literal>')
    const sender = trigger.querySelector('[data-context-relay-sender]')
    assert.equal(sender.dataset.agentMsgSessionId, 'session-peer')
    assert.equal(sender.getAttribute('role'), 'link')
    assert.match(sender.textContent, /来自会话/)
    // rc.2 Sessions owns bindings; navigation belongs to the UI Workspace service.
    sender.closest = (selector) => selector === '.agent-msg-session-link' || selector === '[data-context-relay-sender]' ? sender : null
    const event = { target: sender, preventDefault() {}, stopPropagation() {} }
    listeners.get('click')(event)
    listeners.get('keydown')({ ...event, key: 'Enter' })
    assert.deepEqual(opened, ['session-peer', 'session-peer'])
    let menuOpen = true
    const menu = slots.get('sidebar.workspaces.session.menu.item')({ sessionId: 'session-other-row', useMenuOpenState: () => [menuOpen, (value) => { menuOpen = value }] })
    await menu.props.onSelect()
    assert.deepEqual(copied, ['session-other-row'], 'copy the menu row identity, not the active conversation or its title')
    assert.equal(menuOpen, false)
    assert.ok(iconRenders > 0, 'the real menu renderer resolves the rc.2 icon export')
    const settingsPage = definitions.get('plugins.bundle.config')
    assert.equal(settingsPage.key, 'dsh-agent-message')
    const injected = settingsPage.inject()
    await injected.setShowTechnicalDetails(false)
    assert.equal(injected.hooks.agentMessageSettings.getSnapshot().value.showTechnicalDetails, false)
    acceptWrite = false
    await assert.rejects(injected.setShowTechnicalDetails(true), /Settings write rejected/)
    language = 'en'
    localeSubscribers[0]()
    assert.match(sender.textContent, /From Session/)

    queries.length = 0
    sessionSubscribers[0]()

    assert.deepEqual(queries.filter(({ root }) => root === body), [])
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
    globalThis.document = original.document
    globalThis.Element = original.Element
    globalThis.MutationObserver = original.MutationObserver
    globalThis.window = original.window
    if (original.navigator) Object.defineProperty(globalThis, 'navigator', original.navigator)
    else delete globalThis.navigator
  }
})
