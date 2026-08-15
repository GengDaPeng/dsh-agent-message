# dsh-agent-message

English | [中文](./README.md)

> A cross-session Agent communication plugin for DeepSeek Harness: it lets different Agent sessions running in the same process send and receive messages to each other, just like messaging.

![License](https://img.shields.io/badge/License-MIT-blue.svg)

---

## What is this

In DeepSeek Harness, a single process hosts multiple Agent sessions at once. This plugin equips each session with three tools so they can "message" each other:

- Before sending, first **list every sendable session** (all non-archived ones are listed, including offline ones that haven't been reopened), and find the target by its title;
- Once found, **deliver the message to the target session** — ordinary messages always enter a new independent turn; if the target is offline (not loaded since the last process restart), the plugin resumes it through Harness's public API, delivers the message, and releases the runtime after processing;
- When needed, **query the delivery status of a message on demand** (queued / claimed / discarded / unknown), with the target runtime status reported separately for supervision scenarios.

Typical scenarios: an orchestrator Agent dispatching work to a developer Agent, two Agents collaborating in a relay, a main session sending instructions to a test session, or a supervisor Agent watching over several workers.

## Features

| Capability | Description |
|---|---|
| `list_peer_agents` | List all **sendable (non-archived)** sessions: id, title, working directory, status (online/offline), kind (peer/subagent) |
| `send_agent_message` | Send a message to a session id; `followup` creates an independent turn by default and offline targets are resumed automatically; explicit modes are `followup`, `inject`, and `steer` |
| `check_delivery` | Query receipts on demand (delivered/claimed/discarded/unknown); explicit message ids remain queryable after restart, with target runtime status reported separately; silent by default |
| `@` session locator | Type `@` at the beginning of the composer and choose a target; candidates show only the session title and `Running`/`Idle`, excluding blank placeholders and subagents. The user sees a readable title while the current Agent receives the stable session id; `@` only locates the session, and the full-sentence intent determines whether to send, read, or analyze |
| Navigable sender header | Both the `From Session · <name>:` line in `user` bubbles and the `From session @<ID>` source line in relay contexts can open the sender session by click or keyboard |
| Copy session id | A "Copy ID" button is added to the session header for one-click copying of the current session id |

### Sender navigation example

![Clickable sender header example](./docs/assets/message-header-navigation.jpg)

Users see only the sending Agent's name and can open its session by clicking the whole line. The full session id remains available to the receiving Agent in the raw message and metadata for precise identification and replies.

### Delivery modes (the `mode` parameter of `send_agent_message`)

| mode | Meaning |
|---|---|
| (default, omitted) | `followup`: create an independent turn; an offline target is resumed automatically before delivery |
| `followup` | Same as the default; queue directly when online, or resume and queue when offline |
| `steer` | Steer the target's current work (online only) |
| `inject` | Silently inject the next step without waking it up (online only) |

**Archived sessions are always rejected** (you are prompted to unarchive first); sending to yourself is also rejected.

### Configuring the message form (`form`)

The two forms differ not only visually — they carry different **intents**:

| form | Rendering | Intent |
|---|---|---|
| `user` (default) | Ordinary message bubble | **Conversational**: like a human chat, a reply is expected |
| `relay` | Collapsible context block | **Directive**: injected as context that quietly shapes the agent's later behavior — for instruction-style messages where no reply is expected |

Override the plugin entry in your profile's `cordis.patch.yml` (takes effect on hot reload, no restart needed):

```yaml
- id: agent-message
  config:
    form: relay
```

## Installation

### Option 1: One-liner (recommended)
```sh
dsh plugin --profile web add dsh-agent-message
```

It self-registers on install; no extra configuration is needed.

Compatibility: Node.js 24 and DeepSeek Harness `>=0.1.0-rc.6 <0.2.0`; currently verified with Node.js `24.x` and Harness `0.1.0-rc.6`.

### Option 2: Install from GitHub

```sh
dsh plugin --profile web add github:GengDaPeng/dsh-agent-message
```

### Option 3: Just tell your Agent

Open any DSH session and send it this message:

> Help me install the cross-session communication plugin by running: `dsh plugin --profile web add dsh-agent-message`

The Agent will run this command via bash; once installed it auto-mounts and is immediately available to all sessions.

### What happens automatically after install

The plugin ships a `cordis.patch.yml` (pointed to by `dsh.bundle.patch` in `package.json`) that mounts itself into the host composition on install — so you do **not** need to manually edit presets or `cordis.patch.yml`. All sessions automatically gain `list_peer_agents`, `send_agent_message` and `check_delivery`.

## Usage

1. Type `@` at the beginning of session A's composer and choose the target from the native candidate menu; each candidate shows its title and `Running`/`Idle` activity;
2. `@` only tells A where the relevant session is. For example, `@B tell it to stop after opening the draft PR` makes A call `send_agent_message`, while `@B analyze its latest conversation result` makes A search/read B on demand without messaging B;
3. For an explicit forwarding request, A only delivers and reports the result. It must not execute the forwarded task itself or ask B for an extra acknowledgement;
4. You can still ask the Agent to call `list_peer_agents` and send directly with a full session id;
5. For `user` messages, click `From Session · <name>:` to open the sender; `relay` keeps Harness's context presentation and exposes the same navigation through its existing `From session @<ID>` source line;
6. (Supervision) Say "check the status of my messages to `<session id>`" — it calls `check_delivery`.

## How it works

Each Agent has an inbox `Inbox` containing two FIFO queues:

- `next-turn`: messages queued to be processed as an **independent turn**;
- `next-step`: steering input consumed at the **next step boundary** within the current turn.

Delivery paths of `send_agent_message`:

- **Ordinary online message**: find the target Agent through the `agents` registry and call `followup()` so it enters an independent `next-turn`;
- **Explicit online semantics**: call `steer()` or `inject()` only when the mode is explicitly requested;
- **Ordinary offline message**: restore the session through the public `agents.resume()` API, then call `followup()`. The plugin owns the returned handle and releases it when the Agent becomes idle or the plugin unloads. Resume failures are returned directly; the plugin does not forge core Inbox events as a fallback note.

Receipt states come from inbox events: still queued is `delivered`, claimed by one of the target's turns is `claimed`, and cancelled is `discarded`. The target's runtime state is returned separately as `targetStatus`, so an Agent running unrelated work is not presented as processing this message. When `messageId` is specified, `check_delivery` recovers the state directly from the target's existing Inbox log, so the lookup continues to work after a process restart.

For `user` messages, the raw body header contains the sender title and full session id while the UI shows only a navigable `From Session · <name>:` header. `relay` does not repeat that header in the body; its native Harness source line is shown as a navigable `From session @<ID>`. Both forms retain the sender title and plain `session-...` id in `source` metadata.

The composer-side `@` session locator reuses Harness's native `inputTriggers` command marker. The visible selected title is capped at 40 Unicode characters with an ellipsis; submission replaces it with the full stable `@session-...` id for the current Agent. The sent bubble still projects that id with a chat icon and the live session title, so renaming a session does not change the locator target.

## Directory structure

```
dsh-agent-message/
├── lib/
│   ├── index.js        # host half: list_peer_agents / send_agent_message / check_delivery
│   └── client.js       # client half: @session references, session navigation and copy-session-id button
├── cordis.patch.yml    # self-registration patch (pointed to by dsh.bundle.patch)
├── package.json        # DSH plugin manifest (dsh.bundle / dsh.client / dshx.contributes)
├── docs/               # design notes and README example screenshot
├── README.md           # Chinese documentation
└── README.en.md        # English documentation
```

## In Development

- **`@` session lookup:** Find and select a target session with `@`, without manually retrieving or entering its session ID.
- **Cross-process communication:** Allow Agent sessions running in different DSH processes to exchange messages.

## Limitations

- The target session must be **non-archived** and present in local persistence; archived sessions are always rejected.
- Automatically resuming an offline session uses the **default model** (it does not inherit a model manually selected earlier in that session); if resume fails, the message is not written to the target Inbox.
- Bulk receipt queries without `messageId` rely on in-memory bookkeeping and cover only the most recent 1000 sends in the current process (FIFO eviction). After a restart, a known `messageId` remains queryable, but the volatile `sentAt` and `mode` fields are no longer returned.
- Cross-process / cross-machine communication is out of scope.

## License

[MIT](./LICENSE)
