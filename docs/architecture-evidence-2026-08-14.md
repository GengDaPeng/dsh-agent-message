# dsh-agent-message 架构证据核对

- 日期：2026-08-14
- 修订：2026-08-15，按 DeepSeek Harness 官方发展方向审计收口
- 性质：只读证据与架构裁决建议；本文不修改实现。
- 核对基线：本机安装的 DeepSeek Harness `0.1.0-rc.6`，官方源码提交 [`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)，本仓库当前 `HEAD` `197dd677939898f968793de5e936205e012736fc`。

产品行为以 [`architecture-v2.md`](./architecture-v2.md) 为裁决源，[`harness-development-direction-audit-2026-08-14.md`](./harness-development-direction-audit-2026-08-14.md) 约束与官方扩展面的兼容性。本文提供证据和适配理由；早期调研中“Host 看到 `@` 就直接转发”的备选方案已被“`@` 仅定位，由 A 解释整句意图”取代。

本文严格使用三类标签：

- **事实**：能从当前 DSH 官方源码、官方 README 或本仓库当前代码直接验证。
- **推论**：由这些事实推导出的工程含义。
- **产品裁决建议**：需要项目明确采纳的行为合同，不冒充 DSH 已有能力。

## 结论先行

1. **事实**：当前 `@B` 最终调用的是 A 的 `session.prompt(..., "queue")`，所以 A 获得一条普通 user prompt 并开始一次 turn；之后由 A 结合整句意图决定读取、发送或导航。见本仓库 [`lib/client.js`](../lib/client.js#L91-L143)、[`lib/index.js`](../lib/index.js#L16-L26)。这与“`@` 仅定位”的产品合同一致，但也意味着 A 必须有明确的回复边界：选择发送时只报告投递，不能同时代 B 完成任务。
2. **事实**：DSH 的 `SystemPrompt` 是每个模型 step 的提示装配器，`InputTrigger` 是浏览器草稿/候选/引用表示层；两者都不是可信路由器。真正把 `queue` 映射为 `Agent.followup()`、把 `steer` 映射为 `Agent.steer()` 的边界在 Host。见 [SystemPrompt](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/system-prompt/src/index.ts#L337-L467)、[Agent pre-step](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent-loop/src/agent.ts#L225-L242)、[Host prompt admission](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/host/apiproxy/src/api-proxy.ts#L2461-L2516)。
3. **事实**：DSH `0.1.0-rc.6` 没有“任意普通 Session A → B”的通用通信服务。官方可续子代理通道只授权精确 direct parent → child，并将 parent→child、child→parent 分成 control 与 report 两个方向。[官方 control 设计](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent-control/README.md#L5-L11)、[官方 report 设计](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent-report/README.md#L5-L13)。
4. **产品裁决建议（已确认）**：`@B` 只回答“哪个 Session”，不回答“做什么”。A 是当前意图解释者：读取/分析时 A 使用只读工具并回答；通知/命令时 A 显式调用发送工具且只报告投递；打开/跳转时交给 Client，既不读取也不发送。
5. **产品裁决建议（已确认）**：不采用“看到 `@B` 就由 Host 直接拦截并投给 B”。仍需避免混合回复所有权：发送场景中 A 只拥有 transport 说明，B 拥有被投递任务及其业务结果；B 的普通回复默认留在 B，不自动唤醒 A。

## 1. 稳定身份与生命周期

| 对象 | 官方事实 | 生命周期与边界 | 对本插件的含义 |
|---|---|---|---|
| `Logical Session` | `SessionId` 标识一个持久逻辑会话；`SessionHeader.id` 镜像该 ID。`parentSession` 表示 fork seed lineage，`origin: 'subagent'` 才是粗粒度子代理分类。[Session 类型](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/types.ts#L21-L99) | append-only event log 是交互事实源；resume/fork 不会把标题变成身份。[Session event log](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/types.ts#L230-L264) | 稳定投递地址必须用完整 `SessionId`；标题只用于展示。普通 fork 即使有 `parentSession` 仍是独立会话，不能据此排除。 |
| `Agent` | live `Agent.id` 与 `agent.session.id` 共用同一身份；Agent 只有 `idle/running` live 状态，销毁后从 registry 消失。[Agent 合同](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/runtime-types.ts#L39-L76) | Agent 是某个 Session 的进程内执行载体；Session 可持久存在而 Agent 离线，resume 会创建新的 live Agent。 | “在线/离线”是当前进程状态，不是 Session 是否存在、是否完成或是否可寻址。 |
| `UserMessage` | 每条 Message 有稳定 `MessageId`、role、content、source；`createUserMessage` 新建 UUID 并固定 user role。[Message 类型与构造](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm/src/message.ts#L125-L199) | 同一 Message 身份贯穿投递、持久历史和模型请求；进入 inbox 不等于已进入模型。 | `UserMessage.id` 是协议唯一消息身份；V1 不再生成平行 envelope/route ID。跨进程重试直接以该 ID 去重，不能只依赖当前进程 Map。 |
| `Inbox` | `next-turn` 与 `next-step` 是 Agent 拥有的两个持久待处理列表；claim 时先取全部 `next-step`，再取一个 `next-turn`。[Inbox claim](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/inbox.ts#L24-L77) | append/replace/remove 都先写 `agent/inbox/spliced`，再更新 live projection；同一个 ID 不能同时重复 pending。[Inbox mutations](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/inbox.ts#L80-L219) | `pending`、`claimed`、`discarded` 是 inbox 生命周期，不是“已读/正在回答/已完成”。 |
| `Source` | `kind` 回答“谁产生”，`form` 回答“是什么语义”，两轴独立；`relay` 是另一 Agent 寻址来的消息，`recall` 是从另一 Session 日志取出的材料。[Message source](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm/src/message.ts#L32-L105) | 直接用户 prompt 与 `inject()` 上下文最终都可成为 user-role `user/message`，只能靠 source 区分。[Session user/message](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/session/src/types.ts#L257-L264) | `role: user` 不等于“真人直接在本会话输入”；跨会话 addressed request 应保留 `form: relay` 和稳定 `senderSessionId`，视觉呈现另行决定。 |
| `Receipt` | DSH inbox 暴露 inserted/claimed/discarded；`whenIdle()` 只代表整个 Agent 重新静止，不对应某一消息结果。[Agent events/whenIdle](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/runtime-types.ts#L87-L143) | 官方 subagent control 也只返回 acceptance + `messageId`，明确不返回 child answer。[Control delivery](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent-control/README.md#L43-L75) | 稳定合同使用 `accepted/pending/claimed/discarded/failed/unknown`；当前实现的 `delivered` 需迁移为 `accepted`，且 `claimed` 不能解释为结果完成。[当前实现](../lib/index.js#L339-L382) |
| `SystemPrompt` | section 在每次 assembly 进入目标 Agent 的 system prompt；PromptContext 才是动态 user-role context。[SystemPrompt contract](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/system-prompt/src/index.ts#L52-L85) | assembly 发生在目标 Agent 已 claim inbox、即将跑 step 时。 | 它可以约束 A 如何解释整句和选择工具，但不能承担权限、sender 身份、去重或 exactly-once；这些仍由 Host 校验。 |
| `InputTrigger` | Candidate 是纯展示数据；`ReferenceInsert` 保存 source/ref/label；codec 只在 submit 时把引用序列化成模型文本。[InputTrigger types](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/client/ui-input-trigger/src/types.ts#L13-L20)、[reference/codec](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/client/ui-input-trigger/src/types.ts#L32-L72) | 它存在于浏览器 session scope，提供交互状态和草稿 CAS，不拥有 Host Agent。 | chip 中必须保存完整 target ID；序列化后的 `@session-id` 是交给 A 的稳定定位符，本身不触发读取、发送或导航。 |

### 身份裁决建议

**产品裁决建议**：V1 只保留 Harness 原生消息身份和稳定目标身份：

```text
messageId        Harness UserMessage.id；用于投递、状态和幂等
replyToMessageId Result 指向原 request；非 Result 时为空
targetSessionId  B 的稳定 Logical Session 身份
```

标题、运行状态、父关系都不能替代 `targetSessionId`。V1 没有第二套 `routeId/correlationId`；若以后证明一条业务事务确实需要包含多条 request，再单独设计事务 ID，不能预先塞进基础消息协议，也不能从自然语言正文反向猜关联。

## 2. Host、Client、DSH 的所有权

| 层 | 应拥有 | 不应拥有 |
|---|---|---|
| DSH core | Session/Message 稳定身份；append-only log；Agent live registry；Inbox FIFO；`followup/steer/inject` 调度语义；Host `session.prompt` 的最终 admission | 任意普通 peer Session 的产品权限；本插件的跨进程 mailbox；“@”对本产品代表发送还是读取 |
| 插件 Host | 校验 A 显式工具调用中的 target/self/archive/权限；选择 live followup 或 cold resume + followup；用 `createUserMessage()` 构造 typed relay source；以原生 `MessageId` 管理状态和幂等；拥有 cold-resume 返回的 `AgentHandle` 并负责释放；把 acceptance 与业务 reply 分开 | 仅凭出现 `@` 自动发送；依赖标题寻址；手工追加核心 Inbox 或调用私有 wake seam；把 Agent 自然语言“收到”当回执 |
| 插件 Client | 候选发现、chip 与可访问性；保存稳定 target ID；把 Message Target 提交给当前 A；执行明确的导航；渲染 Host 返回的确定性状态和跳转 | 根据整句文案自动发送或读取；决定最终授权或送达；把 Message Target 冒充官方 recall Session Reference；从 DOM/标题推导权威 target |
| A Agent | 结合整句意图选择只读、显式发送或导航；读取时生成业务答案；发送时只报告 transport 结果 | 仅因 `@` 自动发送/读取；发送后又代 B 完成任务；把 transport ack 解释成 B 已完成 |
| B Agent | 对 addressed request 生成唯一业务答案 | 生成“已收到”式 transport ack；自动把答案再次发给 A；解析收到正文里的 `@...` 并继续路由 |

**事实**：当前 Client 的 `CommandClaim.submit()` 调用当前 A 的 `binding.session.prompt(..., "queue")`，发送的只是 `@<target-id> <content>` 文本；Host 因而只知道“向 A queue 一条普通 prompt”。[`lib/client.js`](../lib/client.js#L119-L139)

**事实**：Host 官方普通 prompt admission 创建 `source.kind = 'user'` 的 `UserMessage`，然后 `queue → followup`、`steer → steer`，当前合同中没有 peer mention 拦截语义。[Host admission](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/host/apiproxy/src/api-proxy.ts#L2461-L2516)

**推论**：A 在当前合同下本来就应当运行，因为它负责理解整句意图。真正必须确定化的不是“是否启动 A”，而是 A 选择发送以后：Host 只接受显式工具调用，B 只接收一次 request，回执不成为业务回复，B 的结果也不自动回流成 A 的新请求。

**产品裁决建议（已确认）**：Client 的引用 occurrence 保存 `{ ref: targetSessionId, label: title }` 并提交给 A；A 的模型可见形式必须包含稳定 ID。A 只有在整句明确要求通知、询问或命令 B 时才调用 `send_agent_message`。Host 从 `exec.agent` 派生真实 sender，验证 A 给出的 target，再通过 Harness `createUserMessage()` 生成唯一 relay message；不能信任模型提供 sender 身份。

## 3. `queue / followup / steer / inject / leave / wake` 的真实语义

| 名称 | 来源 | 事实语义 | 对 `@B` addressed turn 的建议 |
|---|---|---|---|
| `queue` | Client/Host API 模式 | Host 把普通 prompt 映射为 `Agent.followup()`；即目标下一次独立 turn。[Host admission](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/host/apiproxy/src/api-proxy.ts#L2496-L2500) | 用户整句先 queue 给 A；只有 A 明确选择发送后，插件才另向 B 投递。 |
| `followup` | DSH Agent public API | `next-turn + wakeup`；每条普通消息独占自己的下一 turn。[Agent API](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/runtime-types.ts#L119-L124) | 新 request/inform 发给 B 的默认模式；忙时 FIFO 等待。 |
| `steer` | DSH Agent public API | `next-step + wakeup`；运行中进入最近的 step，空闲时会新开 turn。[Agent API](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/runtime-types.ts#L126-L133) | 不应作为一条新问题的默认；会污染 B 当前工作。只用于用户明确“改变 B 当前正在做的事”。 |
| `inject` | DSH Agent public API | `next-step + 不唤醒`；只加入下一次 pre-step 的模型上下文，可能错过已经 claim 的 request。[Agent API](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/runtime-types.ts#L135-L143) | 适合非业务 reply 的安静 context，不适合期待 B 回答的新问题。 |
| `leave` | 本插件自定义 | 在线时直接 append B `next-turn` 而不 wake；离线时手工 append `agent/inbox/spliced`。[当前实现](../lib/index.js#L73-L113)、[发送分支](../lib/index.js#L290-L325) | 从稳定合同删除。它绕过公开 Host admission 和 Agent owner；未来只有在 DSH 提供公开 cold admission seam 时再设计。 |
| `wake` | 本插件自定义 | 离线时 `agents.resume()` 后 `followup()`；在线分支也被折叠成 followup。[当前实现](../lib/index.js#L115-L140)、[发送分支](../lib/index.js#L290-L325) | 作为离线 addressed request 的实现策略，不应暴露成不同的业务回复语义。 |

**事实**：本插件核对基线中的发送实现在线默认 `steer`、离线默认 `wake`。[`send_agent_message`](../lib/index.js#L248-L325)

**推论**：同一条“请回答 X”因 B 当前是否 live 而进入不同的 turn 语义，会造成行为不一致。在线 B 可能把问题混入当前 step，离线 B 却得到干净的下一 turn。

**产品裁决建议**：只有 A 已把整句解释为发送时，新的 addressed request 才统一采用 `followup`；live 直接 followup，offline cold-resume 后 followup。`steer/inject` 只对应用户明确表达且目标 live 的高级语义，不由在线状态自动选择；`leave/defer` 暂不属于稳定合同。

**事实与风险**：当前插件在 `agent/session-start` 中调用 `agent.wakeDriver()` 以唤醒 leave 留言，[本仓库代码](../lib/index.js#L173-L179)，但 `wakeDriver()` 不在 DSH rc.6 public `Agent` interface 中；官方只公开 `send/followup/steer/inject`。[公开 Agent API](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/core/agent/src/runtime-types.ts#L106-L143)

**产品裁决建议**：正式架构删除 `leave` 的稳定入口和私有 `wakeDriver()` 依赖。冷态可靠投递只走公开 `resume + followup`；插件拥有 `resume` 返回的 live `AgentHandle`，绑定清理并在目标恢复空闲后释放。DSH 未提供普通 Session 的公开 cold admission seam 前，不承诺“不唤醒持久留言”。

## 4. `Source`、回执和回复不是一回事

### 4.1 建议的目标消息来源

**事实**：DSH 已把 `form: 'relay'` 定义为“另一 Agent addressed to this one”，把 `recall` 定义为“另一 Session 日志材料”。[官方 source 语义](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/llm/llm/src/message.ts#L32-L105)

**产品裁决建议**：B 收到 addressed request 时，模型角色仍可为 `user`，但 source 应准确记录来源，例如：

```json
{
  "kind": "dsh-agent-message",
  "form": "relay",
  "protocolVersion": 1,
  "messageKind": "request",
  "senderSessionId": "session-a",
  "targetSessionId": "session-b",
  "replyToMessageId": null,
  "replyPolicy": "target"
}
```

`kind` 记录插件生产者，`form: relay` 记录跨 Agent 寻址语义；两者都不为 UI 样式服务。该对象放进 Harness `UserMessage.source`，消息身份直接使用 `UserMessage.id`。Client 是否渲染为 addressed card 是独立 presentation，不能靠篡改 `kind/form` 获得样式。

### 4.2 传输状态机

建议只承诺能证明的状态：

```text
accepted  Host 已把 request 交给 B 的 authoritative inbox
pending   request 仍在 B inbox
claimed   B 的某个 turn 已 claim；不等于已读或已完成
discarded request 被取消/清除
failed    未进入 B inbox
unknown   当前证据无法定位
```

“B 已回答”不是 inbox receipt。若未来要提供 `completed/result`，Host 必须记录 request 被哪个 B turn claim，再在该 turn 结束后关联最后的 assistant output；不能从 `target.status === idle` 或任意最新 assistant message猜测。

### 4.3 reply 回传

官方 DSH 已给出可借鉴的分层：parent→child 的 control 只返回 acceptance；child 的业务内容走独立 report；report 的 `messageId` 也明确不是 read/turn-completion/persistence receipt。[control](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent-control/README.md#L5-L7)、[report](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent-report/README.md#L5-L9)

**产品裁决建议（V1）**：在 A 明确选择发送的场景，B 的答案只落在 B transcript，A 的 relay card 可点击跳转；不自动回传 A。这条链最短，也从结构上杜绝 A 再回答。

**若用户明确要求结果返回 A**：B 显式调用结果工具，Host 创建新的原生 `UserMessage`，其 source 使用 `messageKind: result`、`replyToMessageId: <原 request MessageId>` 和 `replyPolicy: origin-wakeup`。Result 是终止型业务消息，不得再次被路由器解释为 request。V1 不提供 `origin-quiet`：在 DSH 暂无公开 cold-safe、non-waking admission seam 时，不以手工 Inbox 追加冒充可靠实现。

## 5. A `@B` 的所有权时序

### 5.1 当前时序（事实）

```text
用户在 A 选择 B
  → Client 调 A.session.prompt("@B ...", queue)
  → A.followup，A 开始模型 turn
  → A 依 SystemPrompt 判断并调用 send_agent_message
  → Host 返回自然语言工具回执给 A
  → B 默认被 steer/wake
  → A 与 B 均可能生成自然语言
```

这条机制本身符合“A 解释意图”的裁决；混乱来自 A 选择发送后仍同时完成 B 的业务任务，或把业务答案再次当作待发送正文，以及 B 被要求生成确认式回复。问题是回复所有权和消息类型没有硬分离，不是 A 启动本身。

### 5.2 推荐时序（产品裁决建议，已确认）

```text
用户在 A 选择 B
  → Client 把稳定 Message Target 与整句提交给 A
  → A 解释整句意图
      ├─ 读取/分析：调用只读 Session 工具，A 回答，B 不运行
      ├─ 打开/跳转：交给 Client 导航，不读、不发、无模型业务回复
      ├─ 通知/命令：A 显式调用发送工具
      │    → Plugin Host 派生 sender，校验 target/权限/幂等
      │    → Host 把一条 relay UserMessage followup 到 B
      │    → A 只报告可证明的 acceptance，不回答被投递任务
      │    → B 执行业务任务，答案默认留在 B
      ├─ 安静上下文：仅在明确要求时 inject，不唤醒 B
      └─ 当前工作引导：仅在明确要求时 steer B
```

`@B` 单独出现不产生路由。真正的发送边界是 A 对 `send_agent_message` 的显式工具调用；Host 仍需从 `exec.agent` 派生 sender，并将模型给出的参数视为不可信输入进行校验。

### 5.3 读取 B 的按需路径与官方可借鉴机制

DSH 官方 `session-reference` 会在 enqueue 前读取其他 Session，构造有界 `recall` snapshot，再把 snapshot 与当前 prompt 一起交给当前 Agent；它不会启动被引用 Session。[官方 SessionReference API/语义](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/context/session-reference/README.md#L5-L17)

这证明 DSH 能支持“不唤醒 B 的跨 Session 读取”，但不规定本插件只能复用该包或必须一次读取整段 snapshot。产品路径应是 A 先按用户问题判断需要查什么，再调用适当的只读 Session 工具；工具可按需查标题、最近消息、指定范围或构造有界 recall：

```text
用户在 A 引用 B 并要求读取/分析
  → A 按问题调用只读 Session 工具
  → 工具对 B 做范围受控的读取，并返回 recall/结构化结果
  → A 获得 recall context + 当前用户问题
  → 只有 A 回答；B 不运行
```

**推论**：addressed send 与 recall 是两种互斥的执行路径。UI 可以共享同一个会话选择器，但协议必须隔离：本插件的 Message Target 只提供目标 `SessionId`；官方 Session Reference 才表示 recall snapshot，并拥有自己的 URI/source/form。UI 不应把 `@` 固化成“发送”按钮；A 根据整句意图选路，Host 根据实际调用的工具执行并校验。

## 6. Ping-pong 与重复确认的结构性抑制

其中传输规则应是 Host 不变量，A 的回复边界应同时写入工具合同和 SystemPrompt，不能只依赖自然语言惯例：

1. 只有 A 显式调用发送工具才能创建新 relay message；`@` target、Agent output、relay body 和 result body 中的 `@...` 都不被 Host 自动扫描或转发。
2. 一条 relay message 只有一个 `targetSessionId`；禁止 self-send；广播必须是另一种显式操作。
3. 原生 `UserMessage.id` durable 去重；同一 `MessageId` 重试只返回已有状态，不再创建 B turn。
4. Transport ack 只在 RPC/UI 状态中表达，不生成“请确认收到”的模型消息。
5. B 的业务 answer 是终态；默认不自动派发给 A。
6. Result 只能沿 `replyToMessageId` 回一跳，并以 `messageKind: result` 禁止再次进入 request 路由。
7. addressed request 默认 `followup`，不根据 B 当前 live/running 自动切到 `steer`。
8. `claimed` 只表示 inbox 已被 turn 取走；禁止据此自动让 A 继续说话。
9. 离线/跨进程最终需要 durable mailbox、per-target serialization/lease 和 retry policy；不能以手工写核心 Session JSONL event 提供 exactly-once。

## 7. 成熟方案一手证据与适配判断

### 7.1 OpenAI Codex / Agents

| 官方事实 | 适配判断 | 对本插件的结论 |
|---|---|---|
| OpenAI Agents 首先要求决定谁拥有 final answer：handoff 将控制权交给 specialist；agents-as-tools 由 manager 保留 reply ownership。[官方 Orchestration](https://developers.openai.com/api/docs/guides/agents/orchestration) | **需按本产品意图适配** | `@B` 不是固定 handoff。读取场景由 A 拥有 final answer；发送场景 A 只拥有 transport 说明、B 拥有被投递任务；若未来显式要求 A 汇总 B 的 Result，才采用 manager ownership。一次交互不能混用两套 owner。 |
| Codex App Server 将 `turn/start`、`thread/inject_items`、`turn/steer` 分成不同 API；inject 不启动 user turn，steer 只作用于 active turn。[官方 App Server](https://learn.chatgpt.com/docs/app-server) | **可直接借鉴** | DSH 的 followup/inject/steer 也应保持这种明确分层，不能靠一个 `form` 或提示词模糊处理。 |
| Codex 用 `thread.id` 寻址，fork 产生新 thread ID 并保留 `forkedFromId`；列表另有 sourceKinds/filter。[官方 App Server](https://learn.chatgpt.com/docs/app-server) | **需调整** | 原则可借，字段换成 DSH `SessionId`、`parentSession`、`origin`。不能仅凭有 parent 就判定 subagent。 |
| Codex subagent 由主线程统一 spawn、route follow-up、wait、close，并在结果齐全后给出一份 consolidated response。[官方 Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) | **默认不适用，Result 汇总时可调整借鉴** | 当前 peer Session request 默认把结果留在 B；只有用户明确要求“完成后回来告诉我”时，才可借鉴 manager 汇总，而且 B 回来的必须是终止型 Result，不是会再次触发 A 路由的普通 request。 |

### 7.2 Claude Code 普通跨会话消息

| 官方事实 | 适配判断 | 对本插件的结论 |
|---|---|---|
| `@session-name` mention 只把目标 Session 告诉当前 Claude，使它无需先 list 就能决定是否及如何发送；实际消息仍由当前 Claude 编写并显式调用 `SendMessage`。[官方 Cross-session messaging：Message another session](https://code.claude.com/docs/en/cross-session-messaging#message-another-session) | **可直接借鉴** | 与已确认裁决一致：`@` 只提供稳定定位，整句先由 A 解释；Host 不把 mention 自身当发送动作。DSH 显示标题可变，因此内部地址仍必须是完整 `SessionId`。 |
| 跨会话 message 只是一段文本，不复制发送方会话历史或文件；需要整段上下文时应 resume，而不是发消息。[官方 Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) | **可直接借鉴** | `send_agent_message` 只投递 A 明确组织的最小正文和 provenance，不自动附加 A transcript、工作区文件或 recall snapshot，避免隐私泄漏和上下文膨胀。 |
| 接收方运行中时只在两次 tool call 之间读消息，不中断正在运行的工具；空闲时才由消息启动新 turn。[官方 Message delivery](https://code.claude.com/docs/en/cross-session-messaging#message-delivery) | **原则直接采用，原语需调整** | 新 request 用 DSH `followup` 进入独立 FIFO turn，不默认 `steer` 当前 step。只有用户明确要求纠正 B 当前工作时才使用 steer。 |
| 接收方被明确告知消息来自另一个 Session、不是用户；跨会话消息不能代表用户授权、改变配置或批准权限。[官方 How a session treats an incoming message](https://code.claude.com/docs/en/cross-session-messaging#how-a-session-treats-an-incoming-message) | **可直接借鉴** | B 的 source 必须保留 sender Session；relay 不能提升权限，也不能伪装成本会话真人输入。 |
| 入站检查产生 `Delivered / Held / Refused`；Held 不交给模型，直到批准或策略变化，Refused 直接丢弃。[官方 Inbound controls](https://code.claude.com/docs/en/cross-session-messaging#control-inbound-messages) | **概念直接采用，持久 Held 阶段 D 暂缓** | 现在先把 admission outcome 与 inbox `claimed`、业务 Result 分开；阶段 C 可做同进程 refuse policy。Held 的独立持久队列、过期和跨进程回告随阶段 D transport 一起设计，不能伪装成 `delivered`。 |
| 官方按 sender 限速、短窗口丢弃完全相同的重复消息，并把每个 Session 等待读取的已接纳消息限制为 50；本地跨 Session 通过 per-session socket 发现和传输。[官方 Limitations](https://code.claude.com/docs/en/cross-session-messaging#limitations)、[Session inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket) | **结构原则直接采用，transport 阶段 D 暂缓** | 现在先实施原生 `MessageId` 幂等、self-send guard、Result 不再路由；不照抄数值 `50`。跨进程 socket、presence、持久背压、per-sender rate limit 和身份认证留到阶段 D，并继续复用同一 typed source/reply policy。 |

### 7.3 Claude Code Agent Teams

| 官方事实 | 适配判断 | 对本插件的结论 |
|---|---|---|
| 每个 teammate 是独立 Claude Code instance，通信由宿主 Mailbox 完成；只有 recipient mailbox 写成功才报告 sent，写失败则 sender 收到错误且没有消息落地。[官方 Agent Teams Architecture](https://code.claude.com/docs/en/agent-teams) | **可直接借鉴** | 传输 acceptance 必须由 Host/inbox 写入事实决定，不由 sender/receiver 模型生成“收到”。 |
| team config/存储把会话衍生身份、teammate name、mailbox 分开；teammate idle/task events 是系统生命周期。[官方 Agent Teams](https://code.claude.com/docs/en/agent-teams) | **需调整** | DSH 用 SessionId + title；idle/running 仍是宿主状态，不能混成业务消息。 |
| Agent Teams 是一个 team lead + teammate task list 的临时协作拓扑。[官方 Agent Teams](https://code.claude.com/docs/en/agent-teams) | **不适用** | 本插件面向任意普通 peer Session，不能照搬 lead/teammate authority；必须自建 peer router/permission policy。 |

### 7.4 Microsoft AutoGen

| 官方事实 | 适配判断 | 对本插件的结论 |
|---|---|---|
| AutoGen Core message 是纯数据；runtime 以唯一 `AgentId` 定向投递并按 message type 路由 handler。[官方 Message and Communication](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html)、[AgentId API](https://microsoft.github.io/autogen/dev/reference/python/autogen_core.html) | **可直接借鉴** | 目标地址和消息类型应进入结构化 `UserMessage.source`，由 Host 处理；不要从自然语言标题/正文猜目标和类型。 |
| Direct messaging 是明确 request/response；broadcast 是 one-way，而且 publisher 不接收自己发布的消息以防无限循环。[官方通信模型](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html) | **可直接借鉴** | A 明确选择发送后只创建单目标 relay message，不做 fan-out；self-send guard 和“Result 不重新进入 request 路由”应成为结构规则。`@B` 本身仍只是定位。 |
| AutoGen direct call 可 await receiver handler 的返回值。 | **需调整** | DSH Agent inbox 是异步 turn 队列，acceptance 不等于 B handler/result；不能把 AutoGen 同步 request/response 语义硬套到 `followup()`。 |
| AutoGen 的 `AgentId(type,key)` 是该 runtime 自己的地址模型。[官方 AgentId API](https://microsoft.github.io/autogen/dev/reference/python/autogen_core.html) | **不适用** | 不新增第二套 agent type/key 地址；继续使用 DSH `SessionId`，消息相关性直接使用原生 `MessageId/replyToMessageId`。 |

## 8. 已确认裁决与剩余边界

已确认项与后续待实现边界：

1. **已确认**：`@B` 只是一枚稳定 Message Target；不拆成“读取 @”和“发送 @”，也不因出现 `@` 自动路由；它与官方 recall Session Reference 在命名、URI、source 和 form 上隔离。
2. **已确认**：整句始终先进入 A。A 选择读取时由 A 回答；选择发送时 A 只报告 transport，B 处理业务；选择导航时 Client 执行且不发送。
3. **已确认**：B 结果 V1 默认只留 B。若用户明确要求返回 A，必须创建终止型 Result 并写 `replyToMessageId`，不能投成普通 request。
4. **已确认**：A 选择发送的新 request 默认总为 `followup`；`inject/steer` 只能在目标 live 且意图明确时选择；`leave/defer` 从稳定合同删除。
5. **已确认**：`send_agent_message` 是创建 relay `UserMessage` 的唯一发送入口；Client 的 target submit 不是第二条 transport 入口，Host 也不扫描自然语言自动发信。
6. **待实现能力**：当前不能承诺跨进程 exactly-once；需 durable mailbox + lease + dedupe 后才能承诺。
7. **已确认**：cold send 走公开 `resume + followup`；插件拥有并清理 resume 返回的 `AgentHandle`，不依赖手工核心 Inbox append 或私有 `wakeDriver()`。
8. **已确认**：source 使用 `kind: dsh-agent-message`、`form: relay` 和 typed provenance；UI 独立决定样式。关键协议事实落标准 Harness event，plugin-owned lifecycle event 即使增加也必须 `ignorable: true` 且仅作 log/UI 投影。

## 9. 最小验收条件

以 A 中选择一个 B reference 并提交整句为例：

1. 整句恰好进入 A 一次；chip/序列化内容保留完整稳定 `SessionId`，`@B` 单独不触发 Host 路由。
2. `@B 帮我找上次讨论的接口结论`：A 调用只读 Session 工具并生成唯一业务答案；B inbox 不新增消息，B 不运行。
3. `@B 打开`：Client 导航到 B；不创建跨会话 relay message，不启动 B，也不生成模型业务回复。
4. `@B 请回答 X`：A 显式调用一次发送工具，只报告可证明的 transport 状态，不代 B 回答 X。
5. 仅在第 4 类发送路径中，B inbox 恰好新增一条 request；target 是完整稳定 SessionId，source 保留 sender/target/messageKind/replyPolicy，且只使用 Harness 原生 `UserMessage.id`。
6. B 忙碌时新 request 进入下一 FIFO turn，不进入当前 step；只有明确 steer 意图才改变当前工作。
7. B 只生成一份业务答案，默认留在 B；A 不生成同题答案，B 也不生成“请确认收到”的 transport ack。
8. acceptance、pending、claimed、discarded、failed 都由 Host 事实产生，不由模型生成确认。
9. relay、Result 或 B answer 中出现任意 `@session-...` 都不会触发下一次 request；同一原生 `MessageId` 重试也不会创建第二个 B turn。
10. 普通 fork 可作为 peer 候选；只有明确 `origin === 'subagent'` 的 Session 按产品策略排除。

## 最终裁决建议

当前混乱的最小根因不是“整句先进入 A”，而是 **A 选择发送后仍可能代 B 回答、再次转发业务答案，且 transport ack 与业务 reply 没有分层**。正式架构保留 `@` 作为稳定 Message Target，由 A 根据整句选择 read/send/navigate：read 时 A 按需使用只读工具并回答；send 时 A 只显式调用一次消息工具并报告 Host 可证明的 transport 状态，B 处理业务且结果默认留在 B；navigate 时 Client 跳转。Host 不因文本出现 `@` 自动路由，只在显式工具调用后校验身份、权限、原生 `MessageId` 幂等和投递。官方 Session Reference 继续专用于有界 recall snapshot，与通信定位协议隔离。被拒绝的替代方案是“Host 看到 `@` 就直接把正文发给 B、A 不运行”。
