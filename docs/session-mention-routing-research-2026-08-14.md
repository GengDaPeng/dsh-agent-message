# `@会话` 路由与跨代理通信调研

日期：2026-08-14  
范围：DeepSeek Harness 当前源码、OpenAI Codex / Agents 官方资料、Claude Code Agent Teams、Microsoft AutoGen、LangGraph / LangChain。  
结论性质：架构调研，不修改实现。

> **2026-08-14 产品裁决更新：** 本文最初把 `@B 正文` 理解为“宿主直接投递给 B”，经场景复核后已否决该语义。当前产品合同是：`@B` **只是稳定会话定位符**，A 仍是当前回复者，由 A 结合整句意图决定是发送、按需搜索/读取、分析还是导航；不会仅因为出现 `@` 就自动执行任何动作。下文的“宿主直接路由”保留为已否决备选方案，不再是实现建议。

## 结论先行

当前出现的「A 回答、B 也回答、A 又把回答发给 B、B 再确认」不是提示词措辞问题，而是**回复所有权和传输回执没有分层**：

1. `@B 正文` 先作为普通用户消息启动了 A 的模型；
2. A 再按系统提示调用 `send_agent_message`；
3. B 又收到一条会触发模型的消息并回答；
4. 工具回执回到 A 的模型上下文，A 仍有机会继续回答或再次转发。

成熟实现都先确定唯一回复者：

- **handoff / 直接寻址**：控制权交给 B，只有 B 回答；
- **manager / subagent-as-tool**：B 只返回结果，只有 A 汇总回答。

两种模式都成立，但不能同时采用。对于用户在 A 的输入框中显式选择 `@B` 的产品语义，建议采用第一种：**宿主在 A 推理前拦截，单目标投递给 B；A 不回答正文，只显示非模型生成的投递状态。**

## 当前实现为什么必然容易混乱

当前客户端把结构化引用最终序列化成普通 `@session-id` 文本（[`lib/client.js`](../lib/client.js#L115-L136)）；Host 再用系统提示要求 A 识别它、调用工具并「简短确认」（[`lib/index.js`](../lib/index.js#L16-L25)）。这意味着路由发生在 **A 已经开始模型推理之后**，而不是发生在宿主提交边界。

随后 `send_agent_message` 对在线目标默认使用 `steer`，把消息导向 B 的当前工作；工具成功结果又以自然语言 `已通过 ... 发送消息` 返回 A（[`lib/index.js`](../lib/index.js#L248-L334)）。因此：

- A 是一次完整模型 turn，不只是一个路由器；
- B 也会被启动或引导；
- A 同时看到了用户问题、路由指令和工具回执，仍可能生成业务答案或继续协调；
- `steer` 还可能把一条新问题混入 B 正在处理的当前 turn，而不是形成干净的下一轮。

这里最小的根因不是「A 没被提示得足够严格」，而是**模型不应负责解释一个已经由 UI 明确选定目标的确定性路由**。

## DeepSeek Harness 当前源码给出的边界

### 1. 原生 `@子代理` 目前只有输入和视觉语义

Harness 的 `ui-subagent` 源码明确写着：草稿和发给模型的内容都是普通 `@label` 文本，`consumption semantics` 留待未来业务实现，而且没有进入命令裁决钩子（[源码注释](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/client/ui-subagent/src/client/index.ts#L1-L12)）；`onPick` / `serialize` 也确实只返回原始标签文本（[实现](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/client/ui-subagent/src/client/index.ts#L64-L94)）。

所以我们可以复用它的选择器与 chip 体验，但不能把它当成已经完成的路由协议。仅靠 `inputTriggers` 序列化不会阻止 A 的 turn。

### 2. Harness 自己的跨 Agent 控制采用稳定 ID、FIFO 和分离的返回通道

Harness 原生 `send_message` 是 `ctx.subagents.followup()` 的薄适配，目标由稳定的 child session ID 指定，发送者由精确 live parent 身份授权；每条消息进入目标的下一次 FIFO turn，忙碌时等待，不去改写当前工作。工具只返回「消息已接受」及稳定 `messageId`，**不返回子代理回答**；详细结果留在子会话，回传由独立的 `report` 通道完成（[control 设计](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent-control/README.md#L5-L19)、[delivery contract](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent-control/README.md#L43-L75)）。

`report` 只安装在可继续的 child scope 中，recipient 不是模型参数，而是运行时从 durable `parentSession` 推导；成功只代表 parent 已接受该消息，不冒充已读或业务完成。`quiet` 注入上下文但不启动 parent，`wakeup` 才明确开启 parent 的下一 turn（[report 设计](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent-report/README.md#L5-L9)）。

这给我们的直接借鉴是：

- `accepted / delivered / failed` 属于传输层；
- B 的自然语言答案属于业务层；
- 两者不能都做成会唤醒 Agent 的用户消息；
- 一条新的定向问题默认应当是 `followup`，不是 `steer`。

### 3. Harness 也明确承认「回执不是结果」

SDK 的 `prompt()` 只返回排队消息 ID；高层 `run()` 收集到整个 Agent 再次 idle，但 `finalResponse` 也只是该活动区间最后提交的 root assistant 文本，并不保证与某一 prompt 存在因果对应（[SDK contract](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/sdk/client/README.md#L24-L30)）。

因此不能把「工具执行成功」当成「B 已回答」，也不应让 A 基于这个回执生成第二份业务回答。

## OpenAI Codex / Agents 的做法

### 1. 先决定谁拥有最终回答

OpenAI 官方把多 Agent 编排分成两种互斥的回复所有权：handoff 时控制权转给 specialist；agents-as-tools 时 manager 保留最终回复权（[Orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration)）。Codex 的 subagent 工作流也是主线程负责 spawn、route follow-up、wait 和 close，等结果齐全后只返回一份 consolidated response（[Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)）。

这与我们的症状正好相反：当前 A 像 manager 一样继续说话，B 又像 handoff 目标一样直接回答，两个所有权被混在了一起。

### 2. 启动 turn 与注入上下文是不同操作

Codex App Server 把 `turn/start`（加入用户输入并启动 generation）、`thread/inject_items`（只加入模型可见历史，不启动 turn）和 `turn/steer`（引导一个正在运行的 turn）定义为不同原语（[App Server](https://learn.chatgpt.com/docs/app-server)）。这正是本插件应保留的分层：发送、注入和引导不能仅靠一条 `form` 文本提示混为一谈。

### 3. 稳定身份与来源分类独立于标题和父子关系

Codex 以 `thread.id` 恢复和寻址；fork 会获得新的 thread ID，同时保留 `forkedFromId`。线程列表另有 `sourceKinds`，包括 `subAgent`、`subAgentReview`、`subAgentThreadSpawn` 等（[App Server](https://learn.chatgpt.com/docs/app-server)）。这说明：

- 标题只用于显示，稳定 ID 才用于投递；
- 「有父线程」不等于「是子代理」；普通分叉与 subagent 必须按明确 origin/source kind 区分。

OpenAI 没有公开一个把 `@任意 Codex 会话` 当作路由协议的通用 API；Codex 的视觉 mention 也不能替代本插件自己的确定性 contract。

## Claude Code Agent Teams 的做法

Claude Code Agent Teams 使用宿主管理的 Mailbox；每个 teammate 是独立会话，用户切换到某个 teammate 后，输入直接进入那个 teammate，而不是先让 lead 回答（[Agent Teams](https://code.claude.com/docs/en/agent-teams)）。

值得借鉴的细节：

- Mailbox 写入成功才报告 sent，写入失败则 sender 得到错误且消息不落地；
- team config 同时保存 member 的 name 与 agent ID，显示名和稳定身份分离；
- 定向消息自动交付到单一 recipient；广播需要显式逐个发送；
- `Idle` / failure notification 是宿主生命周期通知，与 teammate 的业务消息分离；
- Agent 间消息明确标记为来自另一个 Claude session，不能冒充用户授权。

这些语义都在官方的 [Architecture、Messages between agents、Context and communication](https://code.claude.com/docs/en/agent-teams) 中明确说明。

## AutoGen 与 LangGraph 的做法

AutoGen Core 的直接消息由 runtime 发送到唯一 `AgentId`，receiver handler 的返回值沿同一次 request/response 返回；广播则明确是 one-way，publisher 即便订阅同一主题也不会收到自己的消息，以结构规则防止无限循环（[Message and Communication](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html)、[Core API](https://microsoft.github.io/autogen/stable/reference/python/autogen_core.html)）。Core API 还要求 `message_id` 唯一并推荐 UUID。

AutoGen 的 group chat 不把「大家都回答」作为默认正确行为，而是每轮选一名 speaker，再检查 termination condition；`SourceMatchTermination`、`HandoffTermination`、`MaxMessageTermination` 和 `TimeoutTermination` 都是显式停止条件（[Selector Group Chat](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)、[Termination](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html)）。

LangGraph / LangChain 的 handoff 使用 `active_agent` 状态与 `Command(goto=target)` 显式转移控制；给 tool call 配对的 `ToolMessage("Transferred…")` 只是闭合协议历史的 acknowledgement，不是目标 Agent 还要用自然语言回答一次「确认收到」（[Handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs)）。单目标使用 `Command`，只有确实需要 fan-out 时才使用并行 `Send`（[Router](https://docs.langchain.com/oss/python/langchain/multi-agent/router)）。

## 推荐给本插件的确定性 contract

### 产品语义

`@B 正文` 定义为 **用户从 A 的界面直接向 B 发起一个 addressed turn**，不是「让 A 阅读这句话，再决定是否联系 B」。

默认行为：

1. 宿主在提交边界识别结构化 session reference；
2. 不把正文排入 A 的模型 inbox，不启动 A generation；
3. 向 B 只投递一次干净的下一 turn；B 忙碌时 FIFO 等待，不默认 steer；
4. A 的 UI 本地显示 `发送中 / 已接受 / 失败`，不调用模型生成「已收到」；
5. B 是唯一业务回答者，回答首先保留在 B 的会话中；A 可通过引用点击跳转查看。

如果以后希望 A 同屏展示 B 的回答，应把它渲染成只读的 linked result 卡片；不得作为 `user` 消息或 `followup` 再唤醒 A。V1 先不做结果镜像，链路最短、语义最清楚。

### 传输 envelope

最小字段建议：

```json
{
  "messageId": "uuid",
  "kind": "request",
  "actor": "user",
  "originSessionId": "session-a",
  "targetSessionId": "session-b",
  "content": "..."
}
```

如果后续加入结果回传，再增加：

```json
{
  "messageId": "uuid",
  "kind": "result",
  "replyToMessageId": "original-uuid",
  "originSessionId": "session-b",
  "targetSessionId": "session-a",
  "content": "..."
}
```

`delivery` 不需要伪装成消息 envelope；它是插件本地状态机。Host 以 `messageId` 去重。路由器只消费**人类 composer 提交的结构化 reference**，绝不再次解析 Agent 消息正文里的 `@...`，这样无需先引入复杂 hop/TTL 协议就能从结构上阻断 ping-pong。将来开放 Agent 自主转发时，再增加 `correlationId`、`hop` / `maxHops` 和跨进程幂等存储。

### `@会话` 与 `send_agent_message` 必须分开理解

- `@会话`：用户明确选择目标，宿主直接路由，A 不推理。
- `send_agent_message`：Agent 主动发送，仍由调用 Agent 的工具权限和业务逻辑控制。

两者可以共享 session 目录、消息持久化和 `messageId`，但不应共享「先让 A 解释 @ 再调用工具」这条执行链。

## 验收标准

以 A `@B 请回答 X` 为例：

1. A 的日志中没有为正文启动 assistant generation；
2. B 的 inbox 中恰好出现一条 request，稳定目标为 B 的完整 session ID；
3. B 只生成一次业务回答；
4. A 只出现确定性的传输状态，不出现 A 的自然语言业务答案；
5. B 不收到 A 的答案副本，也不被要求发送「确认收到」；
6. B 回答中即使包含 `@session-...`，也不会自动触发下一次路由；
7. 重复提交同一 `messageId` 不会产生第二个 B turn；
8. B 正在运行时，新请求排到下一 FIFO turn，不污染其当前工作；
9. 普通 fork 会话仍可选择，只有明确 `origin/sourceKind === subagent` 的会话被排除。

## 最终建议

下一步不应继续加重系统提示，而应把 `@会话` 从「模型解释的文本约定」改成「宿主执行的单目标路由」。第一版只做：**拦截 A、FIFO 投递 B、UI 状态回执、B 会话保留唯一答案**。这已经能根治当前混乱；结果镜像、Agent 自主转发和多跳拓扑等能力等真实需求出现后再增加。
