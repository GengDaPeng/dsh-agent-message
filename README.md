# dsh-agent-message

[English](./README.en.md) | 中文

> DeepSeek Harness 的**跨会话 Agent 通信**插件：让运行在同一个进程里的不同 Agent 会话，像发消息一样互相收发信息。

![License](https://img.shields.io/badge/License-MIT-blue.svg)

---

## 这是什么

在 DeepSeek Harness 里，一个进程会同时挂着多个 Agent 会话。本插件给每个会话装上三个工具，让它们能互相"发消息"：

- 发消息前，先**列出所有可发送的会话**（未归档的都在列，含离线未打开的），按标题找到目标；
- 找到后，**把消息投递到目标会话**——普通消息统一进入独立的新 turn；目标离线（进程重启后还没打开）时，插件通过 Harness 公开接口恢复会话、投递，并在处理结束后释放 runtime；
- 需要时，可以**按需查询**某条消息的送达状态（排队中/已认领/被丢弃/未知），并单独查看目标是否正在运行，供监督场景使用。

典型场景：编排者 Agent 给开发 Agent 派活、两个 Agent 协作接力、主会话给测试会话发指令、监督者 Agent 盯梢多个 worker。

## 功能

| 能力 | 说明 |
|---|---|
| `list_peer_agents` | 列出所有**可发送（未归档）**的会话：id、标题、工作目录、状态（在线/离线）、类型（平级/子代理） |
| `send_agent_message` | 给指定会话 ID 发消息；默认使用 `followup` 创建独立的新 turn，离线时自动恢复后投递；显式支持 `followup`、`inject`、`steer` |
| `check_delivery` | 按需查询消息回执（delivered/claimed/discarded/unknown）；指定消息 ID 时支持重启后恢复查询，并单独返回目标运行状态，默认零播报 |
| `@` 会话定位 | 在输入框开头键入 `@` 选择目标；候选只显示会话标题和“运行中/空闲”，空白占位和子代理不混入。选择后用户看到可读标题，当前 Agent 收到稳定 session ID；`@` 只定位，发送、读取或分析由整句意图决定 |
| 可导航的发送者消息头 | `user` 气泡的整行 `From Session · <名称>:` 和 relay 的 `From session @<ID>` 来源行均可点击或通过键盘打开发送方会话 |
| 复制会话 ID | 会话头部新增「复制ID」按钮，一键复制当前会话 ID |

### 消息头跳转示例

![可点击的发送者消息头示例](./docs/assets/message-header-navigation.jpg)

用户只看到发送 Agent 的名称；点击整行即可打开发送方会话。完整会话 ID 仍保留在原始消息和元数据中，供接收 Agent 准确识别与回复。

### 投递模式（`send_agent_message` 的 `mode` 参数）

| mode | 含义 |
|---|---|
| （默认，不传） | `followup`：给目标创建独立的新 turn；离线时自动 `resume` 后投递 |
| `followup` | 与默认相同；在线直接排队，离线自动恢复后排队 |
| `steer` | 引导对方当前的工作（仅在线） |
| `inject` | 静默注入下一步，但不唤醒（仅在线） |

**归档的会话一律拒绝发送**（提示先取消归档）；发给自己也会被拒绝。

### 配置：消息渲染形态（`form`）

两种形态不只是视觉差异，**承载的意图也不同**：

| form | 渲染 | 意图 |
|---|---|---|
| `user`（默认） | 普通消息气泡 | **对话式**：像人发消息一样，期待代理回复 |
| `relay` | 折叠的上下文块 | **引导式**：作为上下文注入，静默影响代理的后续行为，适合指令类消息，不期待回复 |

在你的 profile 的 `cordis.patch.yml` 里覆盖插件条目即可（热更新即时生效，无需重启）：

```yaml
- id: agent-message
  config:
    form: relay
```

## 安装

### 方式一：一行命令（推荐）

```sh
dsh plugin --profile web add dsh-agent-message
```

装完即自动注册，无需任何额外配置。

兼容范围：Node.js 24、DeepSeek Harness `>=0.1.0-rc.6 <0.2.0`；当前验证版本为 Node.js `24.x`、Harness `0.1.0-rc.6`。

### 方式二：从 GitHub 安装

```sh
dsh plugin --profile web add github:GengDaPeng/dsh-agent-message
```

### 方式三：直接发给你的 Agent

打开任意一个 DSH 会话，把下面这句话发给它：

> 帮我安装跨会话通信插件，执行：`dsh plugin --profile web add dsh-agent-message`

Agent 会用 bash 执行这条命令，装完自动挂载、所有会话立即可用。

### 装完自动发生了什么

插件自带 `cordis.patch.yml`（由 `package.json` 的 `dsh.bundle.patch` 指向），安装后自动把自己挂进宿主组合——所以你**不需要**手动改 preset、改 `cordis.patch.yml`。所有会话自动获得 `list_peer_agents`、`send_agent_message` 和 `check_delivery`。

## 使用

1. 在会话 A 的输入框开头键入 `@`，从原生候选菜单中选择目标会话；候选会显示标题和“运行中/空闲”；
2. `@` 只告诉 A 信息或操作的目标在哪里。例如 `@B 告诉他最后提交 PR draft 就停止` 会让 A 调用 `send_agent_message`；`@B 帮我分析他最新的对话结果` 则让 A 按需搜索/读取 B，不会向 B 发消息；
3. 显式要求转告时，A 只负责投递和报告结果，不代为执行被转发的任务，也不要求 B 额外回复“收到”；
4. 也可以让 Agent 调 `list_peer_agents`，再用完整会话 ID 直接发送；
5. 会话 B 以 `user` 形态收到消息时可点击 `From Session · <名称>:`；`relay` 保持 Harness 上下文形态，并可通过原有的 `From session @<ID>` 来源行打开发送方会话；
6. （监督场景）说「查一下我发给 `<会话ID>` 的消息状态」——它会调 `check_delivery`。

## 原理

每个 Agent 都有一个收件箱 `Inbox`，里面是两条 FIFO 队列：

- `next-turn`：排队等待作为**独立一轮**处理的消息；
- `next-step`：当前轮次内、**下一步边界**消费的引导输入。

`send_agent_message` 的投递路径：

- **在线普通消息**：通过 `agents` 注册表找到目标 Agent，调用 `followup()` 进入独立的 `next-turn`；
- **在线高级语义**：只有显式指定时才调用 `steer()` 或 `inject()`；
- **离线普通消息**：通过公开 `agents.resume()` 恢复该会话，再调用 `followup()`；插件持有恢复得到的 handle，并在 Agent 回到 idle 或插件卸载时释放。恢复失败直接返回失败，不伪造核心 Inbox 事件作为留言。

回执状态来自收件箱事件：消息还在队列里是 `delivered`，被对方某轮认领是 `claimed`，被取消是 `discarded`；目标是否正在运行通过独立的 `targetStatus` 返回，不把 Agent 的整体运行状态误当成某条消息正在处理。指定 `messageId` 时，`check_delivery` 会直接从目标现有 Inbox 日志恢复状态，因此进程重启后仍可查询。

`user` 消息的原始正文头包含发送者标题和完整会话 ID，界面只显示可导航的 `From Session · <名称>:` 消息头。`relay` 的正文不重复消息头，Harness 原生来源行显示为可导航的 `From session @<ID>`；两种形态的 `source` 元数据都保留发送者标题和纯 `session-...` ID。

输入框的 `@` 会话定位复用 Harness 原生 `inputTriggers` 命令标记：选择后的可见标题最多 40 个 Unicode 字符，超出用省略号；提交给当前 Agent 时换成完整 `@session-...` 稳定 ID。发送后的气泡依然用聊天图标和实时会话标题投影该 ID，显示名称变化不会改变定位目标。

## 目录结构

```
dsh-agent-message/
├── lib/
│   ├── index.js        # host 半区：list_peer_agents / send_agent_message / check_delivery
│   └── client.js       # client 半区：@会话引用、会话导航与复制会话ID按钮
├── cordis.patch.yml    # 自注册补丁（dsh.bundle.patch 指向它）
├── package.json        # DSH 插件清单（dsh.bundle / dsh.client / dshx.contributes）
├── docs/               # 设计稿与 README 示例截图
├── README.md           # 中文文档
└── README.en.md        # English documentation
```

## 正在开发

- **`@` 会话定位**：通过 `@` 查找并选择目标会话，免去手动获取和输入会话 ID。
- **跨进程通信**：让运行在不同 DSH 进程中的 Agent 会话也能互相收发消息。

## 限制

- 目标会话必须**未归档**且存在于本机持久化里；归档会话一律拒绝发送。
- 自动恢复离线会话时会使用**默认模型**（不继承它上次手动切换的模型选择）；恢复失败时消息不会被写入目标 Inbox。
- 不指定 `messageId` 的批量回执依赖内存记账，只覆盖本进程最近 1000 条发送记录（FIFO 淘汰）；进程重启后仍可凭已知 `messageId` 查询，但不再返回易失的 `sentAt` 和 `mode`。
- 跨进程/跨机器通信不在本插件范围内。

## License

[MIT](./LICENSE)
