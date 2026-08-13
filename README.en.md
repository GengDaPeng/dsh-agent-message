# dsh-agent-message

English | [中文](./README.md)

> A cross-session Agent communication plugin for DeepSeek Harness: it lets different Agent sessions running in the same process send and receive messages to each other, just like messaging.

![License](https://img.shields.io/badge/License-MIT-blue.svg)

---

## What is this

In DeepSeek Harness, a single process hosts multiple Agent sessions at once. This plugin equips each session with two tools so they can "message" each other:

- Before sending, first **list the other online sessions** and find the target by its title;
- Once found, **deliver the message to the target session** (by default it steers the target's current work; you can also queue a new turn or inject silently);
- The recipient sees **a normal message bubble**, with a header noting "From Agent "xxx"" and the message content as the body.

Typical scenarios: an orchestrator Agent dispatching work to a developer Agent, two Agents collaborating in a relay, or a main session sending instructions to a test session.

## Features

| Capability | Description |
|---|---|
| `list_peer_agents` | List the other sessions currently online (registered) in this process: id, title, working directory |
| `send_agent_message` | Send a message to a given session id, supporting three delivery modes |
| Clean message bubbles | Received messages contain only "From Agent "title"" + body — no id, no reply prompts |
| Copy session id | A "Copy ID" button is added to the session header for one-click copying of the current session id |

### Delivery modes (the `mode` parameter of `send_agent_message`)

| mode | Meaning |
|---|---|
| `steer` (default) | Steer the target's current work |
| `followup` | Queue a new independent turn for the target |
| `inject` | Silently inject the next step without waking it up |

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

The plugin ships a `cordis.patch.yml` (pointed to by `dsh.bundle.patch` in `package.json`) that mounts itself into the host composition on install — so you do **not** need to manually edit presets or `cordis.patch.yml`. All sessions automatically gain `list_peer_agents` and `send_agent_message`.

## Usage

1. Tell session A "list the other online Agents" — it calls `list_peer_agents`;
2. Note down the target session's `id` (or have the other side click the "Copy ID" button);
3. Say "send a message to `<session id>`: ..." — it calls `send_agent_message`;
4. Session B receives a message bubble with a "From Agent "title"" header.

## How it works

Each Agent has an inbox `Inbox` containing two FIFO queues:

- `next-turn`: messages queued to be processed as an **independent turn**;
- `next-step`: steering input consumed at the **next step boundary** within the current turn.

`send_agent_message` finds the target Agent through the `agents` registry, then delivers a `UserMessage` into its inbox, corresponding to the three modes:

- `steer` → write to `next-step` and wake it up;
- `followup` → write to `next-turn` and wake it up;
- `inject` → write to `next-step` without waking it up.

The message body contains only "From Agent "title"" and the content; the sender's session id is recorded in the message's `source` metadata (invisible). So the message itself is clean and traceless, and whether to reply is entirely up to the receiving user.

## Directory structure

```
dsh-agent-message/
├── lib/
│   ├── index.js        # host half: list_peer_agents / send_agent_message
│   └── client.js       # client half: copy-session-id button (compiled factory form)
├── cordis.patch.yml    # self-registration patch (pointed to by dsh.bundle.patch)
├── package.json        # DSH plugin manifest (dsh.bundle / dsh.client / dshx.contributes)
├── README.md           # Chinese documentation
└── README.en.md        # English documentation
```

## Limitations

- The target session must be **online (registered) in the current process** (`agents.get(id)` can only find online Agents); offline sessions must be resumed first — this plugin does not handle that yet.

## License

[MIT](./LICENSE)
