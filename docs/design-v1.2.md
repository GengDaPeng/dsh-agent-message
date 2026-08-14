# dsh-agent-message v1.2 设计稿

> 纵横设计（D2 · 评审稿）。评审通过后，结论落点为：`lib/index.js`（代码）、`README.md`（用户文档）、本文件（设计记录）。

## 0. 任务边界与证据状态

- **本次设计**：三个能力 —— ①可发送列表升级（`list_peer_agents` v2）；②离线消息（留言式 `leave` 默认 / 激活式 `wake` 可选）；③按需回执（`check_delivery`）。同时界定二期 client 能力的边界。
- **不设计**：跨进程/跨机器通信、任务委派协议、消息富化、白名单/免打扰、审计。
- **设计成熟度**：评审稿 —— 核心机制已逐一读源码验证并有实测数据，接口细节待实现时定型。
- **已读依据**：`Inbox` 重放语义（dsh-agent/inbox.js）、`agents.resume` 与 api-proxy 的恢复流程（含 preset 挂载）、`archiveSession` 实现与 `archivedSessionIds`、`sessionPersistence.prepare` / `SessionPreparation`、`list_peer_agents` 现状代码；实测数据（9 个可发送 / 2 个归档）。
- **未读依据**：客户端"未读绿点"的实现与水印机制；web 应用 `composeAgent` 的完整 setup 细节。
- **证据有限处**：离线投递与"目标瞬间上线"的并发竞态（需实现时用后端 revision 检查验证）；无标题会话的展示偏好。

## 1. 真实用户场景

- **真实问题**：
  1. 给一个"不在线但未归档"的会话发消息，现在直接报 `not live in this process`（本次实测已撞上，用户原话："它是空闲的呀怎么不在线？"）。
  2. 想找"理论上能收消息的会话"，现在 `list_peer_agents` 只列在线的，用户分不清哪些会话能发。
  3. 监督场景（用户让一个 Agent 当监督者）需要知道："我的消息送达没？他读了没？他在不在处理？"——现在无任何查询手段。
- **主要用户**：用 DSH 做多会话协作的人；让 Agent 担任监督者的场景。
- **减负/消险对象**：发送方不用再猜目标在线与否；监督方不用盲等。
- **闭环结果**：给任何未归档会话发消息都能"立即送达"——在线直接引导；离线（仅指进程重启后未打开）自动激活并引导，激活失败则兜底留言；需要时能查每条消息的送达状态。
- **当前阶段不做**：跨进程通信、任务委派、消息富化、白名单、审计。

## 2. 第一性结构树

```text
跨会话消息投递（v1.1）
├── 目标判定（发送前，按 id）
│   ├── 在线（agents 注册表命中）      → 直接投递
│   ├── 离线且未归档（persistence 有、archived 无）→ leave 留言 / wake 激活
│   ├── 归档（archivedSessionIds 命中）→ 拒绝 + 提示
│   └── 不存在（两边都没有）           → 拒绝 + 提示
├── 投递动作
│   ├── 在线：steer / followup / inject（现状三模式不变）
│   ├── leave（留言）：目标在线=排队投递；离线=持久化写入 inbox 事件，不唤醒
│   └── wake（激活）：目标在线=followup；离线=resume + followup
├── 消息生命周期状态机（见 §3）
│   └── sent → delivered(排队中) → claimed(已认领)
│       └── 旁路：discarded(被丢弃)；targetStatus 独立描述 Agent 运行态
└── 可发送列表（list_peer_agents v2）
    ├── 数据源：持久化会话 ∪ 在线会话 − 归档集合
    └── 每行：id / 标题(带兜底) / cwd / 状态(idle|running|offline) / 类型(peer|subagent) / self
```

## 3. 状态 / 数据 / 执行 / 持久证据 / 验证

| 类别 | 设计结论 | 正式落点 | 证据 / 验证 |
|---|---|---|---|
| **状态** | 消息状态机：`sent`（我方已发出并记账）→ `delivered`（消息在对方 inbox）→ `claimed`（对方某轮认领）。旁路 `discarded`（inbox splice 带 `outcome: 'canceled'`）；`unknown` 表示无可核验证据。Agent 的 `targetStatus` 独立返回，不推断某条消息正在处理或已经完成。 | `lib/index.js`（状态判定函数）+ 本文件 | 单测：用真实会话日志样本 fold inbox；E2E：状态与 Inbox 事实一致 |
| **数据** | ①可发送集合 = `sessionPersistence.list()` ∪ `agents.list()` − `workspaceRegistry.archivedSessionIds`；②发送方维护内存记账表 `sent: Map<messageId, {to, at, mode}>`（插件生命周期内有效，进程重启后丢失——接受此限制）；③留言消息复用现有 `UserMessage` 结构（`source.kind='user'` + `senderSessionId`/`senderTitle` 元数据），离线序列化无损 | `lib/index.js`；数据模型沿用 v1.0 | 实测：9 可发送/2 归档；`check_delivery` 返回与实况一致 |
| **执行** | ①列表工具：三条数据源合并去重、剔除归档、补标题（`sessionQuery.readTitleSnapshots`）；②`leave` 离线路径：`prepare(to)` → fold 该会话日志里的 `agent/inbox/spliced` 得到当前 inbox 长度 → `session.append('agent/inbox/spliced', {target:'next-turn', start, inserted:[message]})` → `sessions.flush` → `release`；③`wake` 离线路径：解析会话记录的 preset → `agents.resume({resumeSessionId, agentOptions, setup})` → `followup`；④`check_delivery`：查在线 inbox 或 fold 离线日志判定状态 | `lib/index.js`（新增 `mailbox` 逻辑 + 工具） | E2E：离线留言 → 打开会话 → 消息重放出现 |
| **持久证据** | 留言的持久证据就是目标会话日志里的 `agent/inbox/spliced` 事件（append 即持久化）；记账表是内存态、非持久证据，只在"回执查询"这一易失能力里使用 | 持久化后端 | 验证：留言后重启进程，打开目标会话消息仍在 |
| **验证** | 见 §9 | — | — |

### 3.1 状态机与投递动作（可视化）

发送流程判定树（`send_agent_message` 一次调用的走向）：

```text
send_agent_message(to, content, mode?)
│
├─ ① to 为空 或 to === 自己 ────────────────→ ✗ 拒绝：「不能给自己发消息」
│
├─ ② agents.get(to) 命中？
│   ├─ 是 → 【在线】按 mode 投递（见矩阵）
│   └─ 否 ↓
│
├─ ③ sessionPersistence.list() 里有 to？
│   ├─ 否 ──────────────────────────────────→ ✗ 拒绝：「会话不存在」
│   └─ 是 ↓
│
├─ ④ archivedSessionIds 里有 to？
│   ├─ 是 ──────────────────────────────────→ ✗ 拒绝：「会话已归档，请先取消归档」
│   └─ 否 → 【离线未归档】按 mode 投递（见矩阵）
```

mode × 目标状态 矩阵：

| mode | 在线目标 | 离线未归档 | 归档 |
|---|---|---|---|
| （默认，不传） | `steer` 引导当前工作 | **`wake` 激活+引导（失败兜底 `leave`）** | ✗ 拒绝 |
| `steer` | 写 next-step + 唤醒 | ✗ 报错「目标离线，可用 wake/leave」 | ✗ 拒绝 |
| `followup` | 写 next-turn + 唤醒 | ✗ 报错同上 | ✗ 拒绝 |
| `inject` | 写 next-step 不唤醒 | ✗ 报错同上 | ✗ 拒绝 |
| `leave` | 写 next-turn 不唤醒（排队） | 写持久化 inbox 事件，不唤醒 | ✗ 拒绝 |
| `wake` | = `followup` | `resume` + `followup`（激活）；激活失败自动降级 `leave` | ✗ 拒绝 |

底层投递原语：

| 原语 | 写入 | 唤醒 | 用于 |
|---|---|---|---|
| `target.steer(msg)` | next-step | ✅ | 在线 steer |
| `target.followup(msg)` | next-turn | ✅ | 在线 followup / wake 在线 |
| `target.inject(msg)` | next-step | ❌ | 在线 inject |
| 离线 append `agent/inbox/spliced` | next-turn（持久化日志） | ❌ | leave 离线留言 |
| `agents.resume()` + `followup` | next-turn | ✅（把会话激活） | wake 离线 |

消息生命周期状态机（`check_delivery` 依据）：

```text
            send_agent_message() 成功
                     │
                     ▼
              ┌────────────┐
              │   sent     │ 我方记账：sent 表记 {messageId, to, at, mode}
              └─────┬──────┘
                    │ 消息写入对方 inbox
                    │（在线=内存队列；离线=持久化 agent/inbox/spliced 事件）
                    ▼
              ┌────────────┐
              │ delivered  │ 已送达 · 排队中（next-turn / next-step）
              └──┬──────┬──┘
   对方某轮 claim │      │ inbox 清空/取消（splice 带 outcome='canceled'）
 （移出 inbox 且  │      ▼
  无 canceled）  │  ┌────────────┐
                 │  │ discarded  │ 被丢弃（终态）
                 ▼  └────────────┘
              ┌────────────┐
              │  claimed   │ 已被对方认领；消息级证据到此为止
              └────────────┘

 targetStatus = offline | idle | running（独立的 Agent 运行状态）
```

## 4. 结构问题判定

- **判定**：结构问题。
- **命中信号**：投递目标从"进程内在线对象"升级为"持久化会话集合"；"可发送"第一次成为独立概念（在线 ∪ 离线未归档）；归档语义进入发送判定。这不是加一个 `if` 能补的——散落判断会让"可发送"在三个地方（列表、发送、回执）各说各话。
- **不允许的补丁路径**：在 `send_agent_message` 里对"not live"报错加特判（表面修）；把可发送列表硬编码成"在线列表 + 手动补几个 id"。
- **正确处理路径**：把"目标判定 + 可发送集合 + 消息状态"收敛为插件内的三个显式函数（`resolveTarget` / `listSendable` / `deliveryState`），三个工具共用，单一真相源。

## 5. 方案设计

### 5.1 候选方案比较与推荐理由

| 问题 | 候选 | 推荐 | 理由 |
|---|---|---|---|
| 离线投递 | A. 激活式（resume+wake）；B. 留言式（持久化 inbox）；C. 都做，默认 A、B 兜底 | **C** | 用户与编排者的共同心智是"下命令即立即送达"；真正的离线只有"进程重启后未打开"一种，此时应自动激活（A）；A 失败（resume 不可用）时兜底留言（B），保证永远发得出去 |
| 可发送列表数据源 | A. 只列在线；B. 持久化−归档；C. 前端实时会话列表 | **B** | 本次探测已验证 B 可行且语义准确；C 依赖客户端接口，越界 |
| 回执状态判定 | A. 靠发后轮询对方输出；B. 读 inbox 事件 + 对方 status | **B** | inbox 的 `inserted/claimed/spliced` 是官方事件真相源，零猜测 |
| 记账表位置 | A. 内存 Map；B. 持久化到发送方会话日志 | **A（v1.1）** | 回执是易失能力，不值得引入持久化复杂度；进程重启后回执失效可接受，标注边界 |

### 5.2 用户可见层（工具契约）

**`list_peer_agents`（v2，升级）**

```
返回：[{ id, title, cwd, status: 'idle'|'running'|'offline', kind: 'peer'|'subagent', self: boolean }]
规则：未归档的全部会话；在线在前，按标题排序（无标题排后，title 兜底为 '(无标题)'）
变化：从"仅在线"升级为"全部可发送"；新增 status=offline、kind
```

**`send_agent_message`（v2，mode 扩展）**

| mode | 在线目标 | 离线未归档 | 归档 | 备注 |
|---|---|---|---|---|
| （默认，不传） | steer | **wake（激活+引导；激活失败自动降级 leave）** | 拒绝 | 立即送达 |
| `steer` | 引导 | 报错"目标离线，可用 wake/leave" | 拒绝 | 现状 |
| `followup` | 新轮次 | 报错同上 | 拒绝 | 现状 |
| `inject` | 静默注入 | 报错同上 | 拒绝 | 现状 |
| `leave` | 排队投递（=followup 语义） | **持久化留言，不唤醒** | 拒绝 | 显式"别打扰"才用 |
| `wake` | =followup | **resume + followup（激活）；激活失败自动降级 leave** | 拒绝 | 新增（默认离线路径） |

其他新增守卫：`to` 为空/等于自己 → 拒绝；归档拒绝的报错文案："对方会话已归档，无法发送（请先取消归档）"。wake 激活失败（无持久化/resume 报错）时自动降级为 leave 并如实回报"已留言（激活失败：<原因>）"。

**`check_delivery`（新增，按需回执）**

```
参数：{ to: SessionId, messageId?: string }
返回：{ to, entries: [{ messageId, sentAt?, mode?, state: 'delivered'|'claimed'|'discarded'|'unknown', targetStatus }] }
原则：默认安静——工具不做任何主动播报；只有监督者 Agent 调用它时才返回状态。上下文零污染。
```

### 5.3 内部对象层

- `resolveTarget(id)` → `{ kind: 'live'|'offline'|'archived'|'unknown', agent? }`：发送前的统一判定，三工具共用。
- `listSendable()` → 数据源合并、归档剔除、标题补齐。
- `deliveryState(entry)` → 依 inbox 事件 + 对方 status 判定状态机。
- `sent` 记账表：`Map<messageId, {to, at, mode}>`，发送成功即记，`check_delivery` 消费。

### 5.4 工程执行层

- 全部改动在 `lib/index.js`（单文件，保持 bundle 简单）；函数按 §5.3 拆分为顶层函数，`apply` 内注册工具。
- 需要注入的服务：现有 `agents`、`tools`，新增 `sessionPersistence`、`sessionQuery`、`workspaceRegistry`（均宿主平面，bundle 直接消费）。
- 版本号 1.1.0；README 增补三能力的说明。

## 6. 纵向闭环

- **目标/边界**：消息只报告 Inbox 能证明的"排队 → 已认领 / 被丢弃"；目标运行态独立返回，无法核验的状态明确为 `unknown`，不猜处理进度或完成结果。
- **状态/异常**：每个异常分支（未知会话/归档/离线+在线专属模式/自己发自己）都有独立报错文案；wake 激活失败自动降级 leave 并如实回报；leave 写入失败时（persistence 拒绝）报错且不记账。
- **权限/审计**：v1.1 无权限模型（本机进程内即信任边界，与 v1.0 一致）；不留审计日志，明确为不做项。
- **测试/验证**：见 §9。

## 7. 横向协作

- **上游**：`sessionPersistence`（会话与 inbox 事件的持久真相源）、`workspaceRegistry`（归档集合）、`sessionQuery`（标题）、`agents`（在线注册表）。全部只读消费，不修改上游状态（leave 的 append 是对目标会话日志的追加，属投递动作本身）。
- **下游**：目标会话的 Agent（在线时直接 inbox 投递）、未来 client 半区（未读提醒将消费同一批 inbox 数据）。
- **读写边界**：本插件写 = 目标会话日志的 `agent/inbox/spliced` 事件 + 自身内存记账表；读 = 上游五个服务。不写 workspace 归档集合（v1.1 不自动取消归档）。
- **公共能力**：`resolveTarget`/`listSendable`/`deliveryState` 是三个工具共用的内部公共函数，不对外暴露为服务。
- **统计/导出/通知/AI 上下文**：v1.1 无统计、无导出、无主动通知（回执按需查询）；AI 上下文零污染（不自动注入任何状态叙述）。

## 8. 正式落点与变更清单

| 落点 | 动作 | 说明 |
|---|---|---|
| 顶层基线 | 无 | 插件不改变 harness 基线 |
| 模块规格 | 修改 | 本文件即模块设计；评审通过后作为模块设计记录 |
| 横切规范 | 无 | — |
| 前端 | 无（v1.1） | client 提醒/角标进二期 |
| 后端 | 修改 | `lib/index.js`：三个工具 + 内部三函数 + 服务注入扩展 |
| 数据层 | 无新增 | 复用 `agent/inbox/spliced` 事件与内存记账 |
| 工程流程 | 无 | — |
| 样板 | 无 | — |
| follow-up | 新增 | 二期 client 能力（来信提醒、未读角标、一键回复按钮） |

## 9. 阶段切分与验证计划

- **当前必须做**：F1 列表升级、F2 离线投递（默认 wake 激活 + 失败兜底 leave，含归档/自己/未知守卫）、F3 check_delivery（delivered/claimed/discarded/unknown）。wake 的 resume+preset 挂载是必攻克项，不再延后。
- **建议做**：记账表持久化；只有建立 messageId → turnId 的正式关联后才考虑完成态。
- **明确不做（v1.1）**：client 提醒/角标/一键回复、白名单、审计、跨进程。
- **单测**：inbox fold 正确性（构造含 splice 事件的日志样本）；目标判定分支（live/offline/archived/unknown/self）。
- **集成/E2E**：①给离线会话发消息（默认）→ 目标被自动激活并处理；激活失败时降级留言，重启/打开后消息重放出现；②显式 leave → 重启进程 → 打开该会话，消息重放出现；③归档会话发送被拒并给出正确文案；④在线三模式回归（v1.0 行为不回退）；⑤check_delivery 的状态与 Inbox 事实一致，Agent 运行态只出现在 `targetStatus`。
- **截图**：`list_peer_agents` 新返回（含 offline/kind/无标题兜底）。
- **日志/审计**：无新增。
- **门禁**：安装后重启 harness 冒烟（与 v1.0 同流程）。

## 10. 未决问题（已裁决）

- **已裁决（2026-08-14，首轮"按推荐" + 二轮修订"立即送达"）**：
  1. 默认 mode = 立即送达（在线 steer / 离线 wake 激活，激活失败兜底 leave）✅
  2. wake 作为默认离线路径必须进 v1.1（resume+preset 挂载为必攻克项，不再延后）✅
  3. 无标题会话兜底显示 `(无标题 · id前8位)` ✅
  4. 子代理会话保留并标注 `kind: 'subagent'`，不排除 ✅
  5. 回执 v1.1 不做"已回复"态 ✅
- **需要审查复核**：leave 离线路径与"目标瞬间上线"的并发行为（依赖持久化后端 revision 检查，实现时验证）。
- **证据不足**：客户端绿点/未读水印机制（二期前置调研项）。

## 11. v1.3.0 可靠性修订（2026-08-14）

- 在线 `leave` 直接写 `target.inbox.append('next-turn', message)`，不再通过会唤醒驱动器的 `followup()`。
- `agent/session-start` 只在 `next-turn` 中存在本插件消息时唤醒，不能消费其他插件刻意保留的非唤醒输入。
- `user` 原始消息头携带发送者名称和完整会话 ID，供接收 Agent 精确回复；默认气泡把整行 `From Session · <名称>:` 渲染为可点击、可键盘导航的链接，完整 ID 不向用户展示。
- 离线 append 遇到持久化序号竞争时重新读取并重试一次；Harness 的连续序号校验继续负责拒绝冲突写入。
- 回执只陈述 Inbox 能证明的 `delivered / claimed / discarded / unknown`；`targetStatus` 独立返回。指定未记账的 `messageId` 时显式返回 `unknown`，不再返回空数组。
- 同一次 `check_delivery` 只读取并折叠目标会话一次，再复用该快照判断全部消息，避免批量查询退化为“消息数 × 全日志”。持久增量投影仍留作后续优化。
- 验证：`node --test` 覆盖上述 host 合同；客户端导航通过真实 Web profile 冒烟验证。

## 12. v1.3.1 稳定化修订（2026-08-14）

- `list_peer_agents` 将持久化 header 一次索引为 `Map`，会话合并由 O(n²) 降为 O(n)。
- `user` 与 `relay` 共用一份发送者 `source` 构造，插件名、形态、标题和稳定会话 ID 不再分支重复。
- 复制会话 ID 只有在 Clipboard API 或后备复制真实成功后才显示「已复制」，失败时明确显示「复制失败」。
- relay 保持 Harness 上下文呈现，正文不重复 `From Session` 头；客户端只把原有来源行投影为可导航的 `From session @<ID>`，`source.senderSessionId` 仍保存纯稳定会话 ID。
- Harness 与 `@deepseek-ai/dsh-tools` 兼容窗口明确为 `>=0.1.0-rc.6 <0.2.0`。
- Host 公共工具测试扩展到列表合并、两种 source、离线恢复、失败降级和发送边界守卫。

## 13. v1.4.0 回执连续性修订（2026-08-14）

- 指定 `messageId` 的 `check_delivery` 不再依赖发送方进程内记账，直接从目标会话现有 Inbox 日志恢复 `delivered / claimed / discarded / unknown`，因此 Harness 重启后仍可查询。
- 不指定 `messageId` 的批量查询仍只读取本进程最近 1000 条发送记账；不新增持久化日志、索引、过期时间或清理任务。
- 重启后恢复的结果不返回已经丢失的 `sentAt` 和 `mode`，避免用猜测填充历史信息。
