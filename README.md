# dsh-agent-message

[English](./README.en.md) | 中文

> DeepSeek Harness 的**跨会话 Agent 通信**插件：让运行在同一个进程里的不同 Agent 会话，像发消息一样互相收发信息。

![License](https://img.shields.io/badge/License-MIT-blue.svg)

---

## 这是什么

在 DeepSeek Harness 里，一个进程会同时挂着多个 Agent 会话。本插件给每个会话装上两个工具，让它们能互相"发消息"：

- 发消息前，先**列出在线的其它会话**，按标题找到目标；
- 找到后，**把消息投递到目标会话**（默认引导它当前的工作，也可排一条新轮次或静默注入）；
- 对方收到的是**一条正常的消息气泡**，标题头标明「来自 Agent「xxx」」，正文就是消息内容。

典型场景：编排者 Agent 给开发 Agent 派活、两个 Agent 协作接力、主会话给测试会话发指令。

## 功能

| 能力 | 说明 |
|---|---|
| `list_peer_agents` | 列出当前进程里在线（已注册）的其它会话：id、标题、工作目录 |
| `send_agent_message` | 给指定会话 ID 发消息，支持三种投递模式 |
| 干净的消息气泡 | 收到的消息只有「来自 Agent「标题」」+ 正文，无 ID、无回复提示 |
| 复制会话 ID | 会话头部新增「复制ID」按钮，一键复制当前会话 ID |

### 投递模式（`send_agent_message` 的 `mode` 参数）

| mode | 含义 |
|---|---|
| `steer`（默认） | 引导对方当前的工作 |
| `followup` | 给对方排一条新的独立轮次 |
| `inject` | 静默注入下一步，但不唤醒 |

## 安装

### 方式一：一行命令（推荐）

```sh
dsh plugin --profile web add github:GengDaPeng/dsh-agent-message
```

装完即自动注册，无需任何额外配置。

### 方式二：直接发给你的 Agent

打开任意一个 DSH 会话，把下面这句话发给它：

> 帮我安装跨会话通信插件，执行：`dsh plugin --profile web add github:GengDaPeng/dsh-agent-message`

Agent 会用 bash 执行这条命令，装完自动挂载、所有会话立即可用。

### 装完自动发生了什么

插件自带 `cordis.patch.yml`（由 `package.json` 的 `dsh.bundle.patch` 指向），安装后自动把自己挂进宿主组合——所以你**不需要**手动改 preset、改 `cordis.patch.yml`。所有会话自动获得 `list_peer_agents` 和 `send_agent_message`。

## 使用

1. 对会话 A 说「列出在线的其它 Agent」——它会调 `list_peer_agents`；
2. 记下目标会话的 `id`（或让对方点「复制ID」按钮）；
3. 说「给 `<会话ID>` 发消息：……」——它会调 `send_agent_message`；
4. 会话 B 收到一条「来自 Agent「标题」」头部的消息气泡。

## 原理

每个 Agent 都有一个收件箱 `Inbox`，里面是两条 FIFO 队列：

- `next-turn`：排队等待作为**独立一轮**处理的消息；
- `next-step`：当前轮次内、**下一步边界**消费的引导输入。

`send_agent_message` 通过 `agents` 注册表找到目标 Agent，再把一条 `UserMessage` 投递进它的收件箱，对应三种模式：

- `steer` → 写入 `next-step` 并唤醒；
- `followup` → 写入 `next-turn` 并唤醒；
- `inject` → 写入 `next-step` 但不唤醒。

消息正文只含「来自 Agent「标题」」和内容；发送者会话 ID 记录在消息的 `source` 元数据里（不可见）。因此消息本身干净无痕，是否回信完全由接收端用户决定。

## 目录结构

```
dsh-agent-message/
├── lib/
│   ├── index.js        # host 半区：list_peer_agents / send_agent_message
│   └── client.js       # client 半区：复制会话ID按钮（已编译 factory 形式）
├── cordis.patch.yml    # 自注册补丁（dsh.bundle.patch 指向它）
├── package.json        # DSH 插件清单（dsh.bundle / dsh.client / dshx.contributes）
├── README.md           # 中文文档
└── README.en.md        # English documentation
```

## 限制

- 目标会话必须是**当前进程里在线（已注册）**的 Agent（`agents.get(id)` 只能找到在线的）；离线会话需先 resume，本插件暂不处理。

## License

[MIT](./LICENSE)
