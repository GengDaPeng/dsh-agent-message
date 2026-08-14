# dsh-agent-message

[English](./README.en.md) | 中文

> DeepSeek Harness 的**跨会话 Agent 通信**插件：让运行在同一个进程里的不同 Agent 会话，像发消息一样互相收发信息。

![License](https://img.shields.io/badge/License-MIT-blue.svg)

---

## 这是什么

在 DeepSeek Harness 里，一个进程会同时挂着多个 Agent 会话。本插件给每个会话装上三个工具，让它们能互相"发消息"：

- 发消息前，先**列出所有可发送的会话**（未归档的都在列，含离线未打开的），按标题找到目标；
- 找到后，**把消息投递到目标会话**——目标在线就立即引导它当前的工作；目标离线（进程重启后还没打开）就**自动把它激活**再投递，激活失败则自动转为**留言**（下次打开可见）；
- 需要时，可以**按需查询**某条消息的送达状态（排队中/已认领/被丢弃/未知），并单独查看目标是否正在运行，供监督场景使用。

典型场景：编排者 Agent 给开发 Agent 派活、两个 Agent 协作接力、主会话给测试会话发指令、监督者 Agent 盯梢多个 worker。

## 功能

| 能力 | 说明 |
|---|---|
| `list_peer_agents` | 列出所有**可发送（未归档）**的会话：id、标题、工作目录、状态（在线/离线）、类型（平级/子代理） |
| `send_agent_message` | 给指定会话 ID 发消息；默认**立即送达**（在线引导 / 离线激活，失败兜底留言），支持五种显式模式 |
| `check_delivery` | 按需查询消息回执（delivered/claimed/discarded/unknown），并单独返回目标运行状态，默认零播报 |
| 可导航的发送者消息头 | `user` 气泡的整行 `From Session · <名称>:` 和 relay 的 `From session @<ID>` 来源行均可点击或通过键盘打开发送方会话 |
| 复制会话 ID | 会话头部新增「复制ID」按钮，一键复制当前会话 ID |

### 消息头跳转示例

![可点击的发送者消息头示例](./docs/assets/message-header-navigation.jpg)

用户只看到发送 Agent 的名称；点击整行即可打开发送方会话。完整会话 ID 仍保留在原始消息和元数据中，供接收 Agent 准确识别与回复。

### 投递模式（`send_agent_message` 的 `mode` 参数）

| mode | 含义 |
|---|---|
| （默认，不传） | **立即送达**：在线 → `steer`；离线 → `wake`（激活失败自动转 `leave`） |
| `steer` | 引导对方当前的工作（仅在线） |
| `followup` | 给对方排一条新的独立轮次（仅在线） |
| `inject` | 静默注入下一步，但不唤醒（仅在线） |
| `leave` | 留言：写进对方收件箱但不唤醒；离线会话就是"留言板" |
| `wake` | 激活：离线会话先 `resume` 再投递；在线等价于 `followup` |

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
dsh plugin --profile web add github:GengDaPeng/dsh-agent-message
```

装完即自动注册，无需任何额外配置。

兼容范围：DeepSeek Harness `>=0.1.0-rc.6 <0.2.0`；当前验证版本为 `0.1.0-rc.6`。

### 方式二：直接发给你的 Agent

打开任意一个 DSH 会话，把下面这句话发给它：

> 帮我安装跨会话通信插件，执行：`dsh plugin --profile web add github:GengDaPeng/dsh-agent-message`

Agent 会用 bash 执行这条命令，装完自动挂载、所有会话立即可用。

### 装完自动发生了什么

插件自带 `cordis.patch.yml`（由 `package.json` 的 `dsh.bundle.patch` 指向），安装后自动把自己挂进宿主组合——所以你**不需要**手动改 preset、改 `cordis.patch.yml`。所有会话自动获得 `list_peer_agents`、`send_agent_message` 和 `check_delivery`。

## 使用

1. 对会话 A 说「列出可发送的其它 Agent」——它会调 `list_peer_agents`；
2. 记下目标会话的 `id`（或让对方点「复制ID」按钮）；
3. 说「给 `<会话ID>` 发消息：……」——它会调 `send_agent_message`，目标在线立即送达、离线自动激活（失败则留言）；
4. 会话 B 以 `user` 形态收到消息时可点击 `From Session · <名称>:`；`relay` 保持 Harness 上下文形态，并可通过原有的 `From session @<ID>` 来源行打开发送方会话。
5. （监督场景）说「查一下我发给 `<会话ID>` 的消息状态」——它会调 `check_delivery`。

## 原理

每个 Agent 都有一个收件箱 `Inbox`，里面是两条 FIFO 队列：

- `next-turn`：排队等待作为**独立一轮**处理的消息；
- `next-step`：当前轮次内、**下一步边界**消费的引导输入。

`send_agent_message` 的投递路径：

- **在线**：通过 `agents` 注册表找到目标 Agent，调 `steer()` / `followup()` / `inject()` 写入其收件箱；
- **离线留言（leave）**：把 `agent/inbox/spliced` 事件**持久化追加**进目标会话的日志——目标下次被打开（resume）时，收件箱会重放该事件，消息就在那里；
- **离线激活（wake）**：`agents.resume()` 恢复该会话（连同它记录的 agent preset），再 `followup()`，会话被唤醒并立即处理。

回执状态来自收件箱事件：消息还在队列里是 `delivered`，被对方某轮认领是 `claimed`，被取消是 `discarded`；目标是否正在运行通过独立的 `targetStatus` 返回，不把 Agent 的整体运行状态误当成某条消息正在处理。

`user` 消息的原始正文头包含发送者标题和完整会话 ID，界面只显示可导航的 `From Session · <名称>:` 消息头。`relay` 的正文不重复消息头，Harness 原生来源行显示为可导航的 `From session @<ID>`；两种形态的 `source` 元数据都保留发送者标题和纯 `session-...` ID。

## 目录结构

```
dsh-agent-message/
├── lib/
│   ├── index.js        # host 半区：list_peer_agents / send_agent_message / check_delivery
│   └── client.js       # client 半区：发送方会话导航与复制会话ID按钮
├── cordis.patch.yml    # 自注册补丁（dsh.bundle.patch 指向它）
├── package.json        # DSH 插件清单（dsh.bundle / dsh.client / dshx.contributes）
├── docs/               # 设计稿与 README 示例截图
├── README.md           # 中文文档
└── README.en.md        # English documentation
```

## 限制

- 目标会话必须**未归档**且存在于本机持久化里；归档会话一律拒绝发送。
- 离线激活（wake）会把目标会话以**默认模型**恢复运行（不继承它上次手动切换的模型选择）。
- 回执记账是内存态：进程重启后 `check_delivery` 查不到重启前发出的消息（消息本身不受影响）；且只保留最近 1000 条发送记录（FIFO 淘汰）。
- 跨进程/跨机器通信不在本插件范围内。

## License

[MIT](./LICENSE)
