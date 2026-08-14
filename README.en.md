# dsh-agent-message

English | [中文](./README.md)

> A cross-session Agent communication plugin for DeepSeek Harness: it lets different Agent sessions running in the same process send and receive messages to each other, just like messaging.

![License](https://img.shields.io/badge/License-MIT-blue.svg)

---

## What is this

In DeepSeek Harness, a single process hosts multiple Agent sessions at once. This plugin equips each session with three tools so they can "message" each other:

- Before sending, first **list every sendable session** (all non-archived ones are listed, including offline ones that haven't been reopened), and find the target by its title;
- Once found, **deliver the message to the target session** — if the target is online, its current work is steered immediately; if it is offline (not loaded since the last process restart), it is **activated automatically** and then messaged, falling back to a **note** (visible when it is next opened) if activation fails;
- When needed, **query the delivery status of a message on demand** (delivered / read / processing / discarded) for supervision scenarios.

Typical scenarios: an orchestrator Agent dispatching work to a developer Agent, two Agents collaborating in a relay, a main session sending instructions to a test session, or a supervisor Agent watching over several workers.

## Features

| Capability | Description |
|---|---|
| `list_peer_agents` | List all **sendable (non-archived)** sessions: id, title, working directory, status (online/offline), kind (peer/subagent) |
| `send_agent_message` | Send a message to a session id; **immediate delivery by default** (online → steer; offline → wake, falling back to leave), plus five explicit modes |
| `check_delivery` | Query message receipts on demand (delivered/claimed/processing/discarded/unknown); silent by default |
| Clean message bubbles | Received messages contain only "From Agent "title"" + body — no id, no reply prompts |
| Copy session id | A "Copy ID" button is added to the session header for one-click copying of the current session id |

### Delivery modes (the `mode` parameter of `send_agent_message`)

| mode | Meaning |
|---|---|
| (default, omitted) | **Immediate delivery**: online → `steer`; offline → `wake` (falls back to `leave` if activation fails) |
| `steer` | Steer the target's current work (online only) |
| `followup` | Queue a new independent turn for the target (online only) |
| `inject` | Silently inject the next step without waking it up (online only) |
| `leave` | Leave a note: write into the target's inbox without waking it; for offline sessions this is a "mailbox" that appears when the session is next opened |
| `wake` | Activate: resume an offline session first, then deliver; equivalent to `followup` when online |

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
dsh plugin --profile web add github:GengDaPeng/dsh-agent-message
```

It self-registers on install; no extra configuration is needed.

### Option 2: Just tell your Agent

Open any DSH session and send it this message:

> Help me install the cross-session communication plugin by running: `dsh plugin --profile web add github:GengDaPeng/dsh-agent-message`

The Agent will run this command via bash; once installed it auto-mounts and is immediately available to all sessions.

### What happens automatically after install

The plugin ships a `cordis.patch.yml` (pointed to by `dsh.bundle.patch` in `package.json`) that mounts itself into the host composition on install — so you do **not** need to manually edit presets or `cordis.patch.yml`. All sessions automatically gain `list_peer_agents`, `send_agent_message` and `check_delivery`.

## Usage

1. Tell session A "list the sendable Agents" — it calls `list_peer_agents`;
2. Note down the target session's `id` (or have the other side click the "Copy ID" button);
3. Say "send a message to `<session id>`: ..." — it calls `send_agent_message`; online targets are messaged immediately, offline targets are activated automatically (or left a note on failure);
4. Session B receives a message bubble with a "From Agent "title"" header.
5. (Supervision) Say "check the status of my messages to `<session id>`" — it calls `check_delivery`.

## How it works

Each Agent has an inbox `Inbox` containing two FIFO queues:

- `next-turn`: messages queued to be processed as an **independent turn**;
- `next-step`: steering input consumed at the **next step boundary** within the current turn.

Delivery paths of `send_agent_message`:

- **Online**: find the target Agent through the `agents` registry and write into its inbox via `steer()` / `followup()` / `inject()`;
- **Offline note (`leave`)**: append an `agent/inbox/spliced` event **durably** to the target session's log — when the session is next resumed, its inbox replays the event and the message is there (and the plugin wakes it so the note appears right away);
- **Offline activation (`wake`)**: `agents.resume()` restores the session (together with its recorded agent preset), then `followup()` — the session is woken and processes the message immediately.

Receipt states come from the inbox events and the target's running state: still queued is `delivered`, claimed by one of the target's turns is `claimed`, target running is `processing`, cancelled is `discarded`.

The message body contains only "From Agent "title"" and the content; the sender's session id is recorded in the message's `source` metadata (invisible). So the message itself is clean and traceless, and whether to reply is entirely up to the receiving user.

## Directory structure

```
dsh-agent-message/
├── lib/
│   ├── index.js        # host half: list_peer_agents / send_agent_message / check_delivery
│   └── client.js       # client half: copy-session-id button (compiled factory form)
├── cordis.patch.yml    # self-registration patch (pointed to by dsh.bundle.patch)
├── package.json        # DSH plugin manifest (dsh.bundle / dsh.client / dshx.contributes)
├── docs/               # design notes (design-v1.2.md)
├── README.md           # Chinese documentation
└── README.en.md        # English documentation
```

## Limitations

- The target session must be **non-archived** and present in local persistence; archived sessions are always rejected.
- Offline activation (`wake`) resumes the target with the **default model** (it does not inherit a model manually selected earlier in that session).
- Receipt bookkeeping is in-memory: after a process restart, `check_delivery` cannot see messages sent before the restart (the messages themselves are unaffected); only the most recent 1000 sent records are kept (FIFO eviction).
- Cross-process / cross-machine communication is out of scope.

## License

[MIT](./LICENSE)
