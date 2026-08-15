# DSH 会话通信插件生态对比（2026-08-14）

> 结论：已经出现直接同类插件。本项目并非唯一实现；最接近的是 `dsh-agent-messaging`，最接近人类聊天体验的是 `dsh-chat-link`。由于 DSH 与这些项目都刚发布不久，下面比较的是当前源码和 README 中已经落地的能力，不用 star 数判断成熟度。

## 直接同类

| 项目 | 当前能力 | 相比本项目 |
|---|---|---|
| [`happyren/dsh-agent-messaging`](https://github.com/happyren/dsh-agent-messaging) | 会话发现、点对点发送、收件箱；支持 `steer`、`followup`、`context`；Unix socket + presence file 实现同机跨 DSH 进程通信；离线 spool；信任、准入、限流和去重 | 功能重叠最高。跨进程和安全治理更完整；其 transport ack 不等同于本项目的 `delivered/claimed/discarded` 生命周期回执，也没有本项目的原生会话跳转和 npm 一行安装 |
| [`KeFan-J/dsh-chat-link`](https://github.com/KeFan-J/dsh-chat-link) | 输入框 `@` 会话、消息板、历史、未读数、离线 JSONL、会话跳转 | 更偏用户可见的即时聊天产品；收件箱 UI 更强，但没有本项目按 DSH Inbox 事件查询的消息生命周期回执 |

## 相邻插件

| 项目 | 关系 | 为什么不算同一产品 |
|---|---|---|
| [`Wha1eChai/dsh-supervisor`](https://github.com/Wha1eChai/dsh-supervisor) | 能列出、检查、发送、引导和取消当前进程里的 live session | 核心是安全监督控制面，只覆盖在线会话，不处理离线持久投递 |
| [`NanmiCoder/dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams) | 团队成员间有 mailbox 和 wake | 核心是 leader/member、任务和依赖编排，不是任意独立会话间的通用通信 |
| [`PerryLink/dsh-background-agents`](https://github.com/PerryLink/dsh-background-agents) | 父会话可给可续跑的后台子 Agent 发消息 | 核心是 parent/child 子代理生命周期，不是平级会话发现和通信 |
| [`acnlabs/dsh-plugin-acn`](https://github.com/acnlabs/dsh-plugin-acn) | Agent 可通过外部 ACN 网络发现、发消息和收件 | 面向跨机器网络通信，需要外部服务和凭证，信任边界与本地 DSH 会话通信不同 |

## DSH 原生能力边界

- [Session Reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session-reference.md) 是把另一个会话的上下文快照引用进当前消息，不会向目标会话投递消息。
- [Subagent](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md) 原生支持 parent/child 的 `send_message`、`interrupt_agent` 和续跑，但不等于任意独立会话的点对点通信。

## 本项目当前定位

本项目适合定位为：**DSH 原生、低配置的跨会话消息层**，重点是在线引导、离线唤醒/留言、基于 Inbox 事件的可验证生命周期回执、重启后按消息 ID 查询，以及原生会话导航。

当前最值得补的不是再造聊天界面，而是：

1. 先补发送者信任、准入、限流和循环消息抑制；这是面向全球开发者时的基础安全边界。
2. 用户确实需要多个 DSH 进程协作时，再增加同机跨进程 transport；它会明显扩大故障面和维护面，不宜仅为对齐竞品而做。
3. `@` 选择器、独立 Inbox 和未读数属于产品体验路线，可按真实使用反馈决定，不影响通信内核成立。

## 分发观察

本次 npm registry 核对中，本项目已有公开包 [`dsh-agent-message`](https://www.npmjs.com/package/dsh-agent-message)；上述直接同类项目当前主要通过 GitHub 安装。生态入口可继续从 GitHub 的 [`dsh-plugin` topic](https://github.com/topics/dsh-plugin) 跟踪。

## 与 `dsh-agent-messaging` 的详细差异

| 维度 | `dsh-agent-message`（本项目） | `dsh-agent-messaging` | 判断 |
|---|---|---|---|
| 通信范围 | 同一 DSH 进程；离线会话直接复用 Harness 持久化日志 | 同进程直调；同机不同 DSH 进程通过 Unix socket + presence；离线写独立 spool | 对方跨进程更强；我们的路径更短、状态源更少 |
| 寻址 | `list_peer_agents` 返回标题和稳定 session ID，发送必须使用 ID | 标题/目录生成短名称，碰撞加 ID 后缀；支持名称、ID 和唯一片段 | 对方对人和 Agent 都更易用 |
| 默认投递 | 在线默认 `steer`；离线默认 `wake`，失败转 `leave` | 默认 `followup`；离线只 spool，等会话以后启动 | 我们更主动、更快；对方更保守、较少打断当前工作 |
| 投递模式 | `steer/followup/inject/leave/wake` | `steer/followup/context` | 我们覆盖唤醒和显式留言；`context` 等价方向是我们的 `inject` |
| 回执 | 可查询 `delivered/claimed/discarded/unknown`；已知 ID 可从 Inbox 日志重建 | 发送时返回 `delivered/spooled/held/refused/dropped`，属于接收/传输结果；无后续消费状态查询 | 我们的生命周期可观测性更强 |
| 回复关联 | 来源携带 sender session ID，能回复；没有显式父消息字段 | `reply_to`/`inReplyTo` 关联原消息 | 对方在线程关联上更强 |
| 安全准入 | 拒绝自己和归档目标；依赖 DSH 原有权限 | `accept/hold/refuse`、trusted peers、`inform/act`、限流、重复抑制、wire schema/大小校验、socket 0600、固定不可信内容框架 | 对方明显更完整，尤其适合公开分发 |
| 离线保存 | 写入目标原生 session Inbox 日志，无单独过期/条数限制 | 独立 JSON spool，默认 1 天、每会话 20 条，最老淘汰 | 我们不会产生第二份邮箱真相；对方有明确资源和陈旧消息上限 |
| UI | 可点击来源头、复制 ID、跳转发送会话 | 无 client/UI | 我们明显更强 |
| 安装 | npm 一行安装，自带 bundle patch | GitHub 安装，需要允许 git dependency build script 并重启 | 我们明显更简单、供应链版本也更清楚 |
| 工程形态 | 轻量 ESM，两份运行代码，基于 Node test | TypeScript 分层，协议/transport/policy 独立，含 Unix socket 集成测试 | 对方测试面和边界建模更完整；我们的维护面更小 |

来源：对方的 [README](https://github.com/happyren/dsh-agent-messaging/blob/main/README.md)、[路由 transport](https://github.com/happyren/dsh-agent-messaging/blob/main/src/adapters/transport/routing-transport.ts)、[准入与循环保护](https://github.com/happyren/dsh-agent-messaging/blob/main/src/domain/policy.ts)、[不可信消息框架](https://github.com/happyren/dsh-agent-messaging/blob/main/src/domain/render.ts)、[寻址逻辑](https://github.com/happyren/dsh-agent-messaging/blob/main/src/domain/peer.ts)及[测试目录](https://github.com/happyren/dsh-agent-messaging/tree/main/tests)。

### 对方真正领先的部分

1. **同机跨进程**不是文档口号，而是已经实现的 Unix socket、presence 发布/清理和远端路由。
2. **不把 Agent 消息默认当作用户指令**：默认 `inform`，只有明确列入 `trustedPeers` 才能提升为可直接行动的 `act`，并且仍不能代替权限批准。
3. **失控保护**：同一发送者的窗口限流与重复正文抑制可以终止 Agent 自动互回循环。
4. **输入边界完整**：消息长度、协议版本、字段类型、socket frame、文件权限都有明确约束。
5. **寻址与回复体验**：可用名称或片段寻址，重名确定性消歧，并用 `reply_to` 保留消息关系。

### 我们不应照搬的部分

- 独立 spool 在跨进程场景有必要，但同进程场景会增加第二套持久化状态；我们复用 Harness Inbox 日志更直接。
- TypeScript 多层 ports/adapters 对它的 socket transport 合理；本项目在没有跨进程 transport 前照搬只会增加文件和抽象。
- 默认不唤醒是产品取向，不是绝对优势。本项目的目标是主动代理协作，`wake -> leave` 的降级链更符合现有定位。

## `@会话` 选择可行性

这是 DSH 原生 client 服务，不需要自己监听键盘或模拟下拉框。`dsh-chat-link` 已通过 [`inputTriggers.registerSource()`](https://github.com/KeFan-J/dsh-chat-link/blob/main/lib/client.js#L173-L203) 注册 `@` 候选和原生 chip，证明当前 Harness 可以这样扩展。

本项目的最小可靠方案：

1. 把现有会话枚举逻辑提成 host 侧共享函数，继续供 `list_peer_agents` 使用。
2. 增加一个只读 Web endpoint，在用户输入 `@` 时按需返回未归档会话；不做固定轮询。
3. client 注册 `inputTriggers` source，候选显示会话标题和在线状态，chip 内部保存稳定 session ID。
4. chip 序列化给模型时同时包含目标 ID，配一条短 system prompt，让当前 Agent 调用现有 `send_agent_message`；用户界面只显示 `@会话名`。

难点不在菜单，而在最后一步语义：像 `dsh-chat-link` 那样把 chip 投影成普通 `@名称`，再依赖模型理解并调用工具，实现很快但不是确定性投递。保留隐藏的稳定 session ID 并明确工具协议，才能避免重名、改标题或模型误判。因此整体属于**低到中等复杂度**，不需要重做现有通信内核。
