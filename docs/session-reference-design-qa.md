**对比目标**

- Source visual truth：本轮会话内经用户确认的概念图（不包含在仓库中）
- Implementation screenshot：`assets/session-reference-implementation.png`
- Full-view comparison：`assets/session-reference-qa-comparison.png`
- Focused menu comparison：`assets/session-reference-qa-menu.png`
- 其他交互态：`assets/session-reference-composer.png`、`assets/session-reference-sent-bubble.png`
- Viewport：Codex IAB，1280 x 720 CSS px，深色模式，`@` 候选菜单打开且首项选中
- Pixels / density：source 1642 x 958 px；implementation 1280 x 720 px；对比图将两者分别等比 contain 到 800 x 900 px，不裁切、不拉伸
- State：会话候选列表、选中态、输入框引用、发送后气泡引用与点击跳转

**Findings**

- 无 P0/P1/P2 遗留。实际实现沿用 Harness 原生字体、菜单尺寸、颜色 token、阴影与间距，因此整体密度小于概念图，但与宿主产品一致，属于有意约束。
- 字体与排版：使用 Harness 原生字体层级；会话标题、状态和分组标题清晰，长标题按原生规则省略。
- 间距与布局：聊天图标固定在左侧，状态固定在最右侧；标题自适应占满两者之间的剩余宽度，只在空间确实不足时省略；选中行已改为直角，未再出现圆角四角缝隙。
- 颜色与 token：图标、选中背景、在线/离线状态均复用 Harness token；深色模式对比度正常。
- 图像与资产：没有新增位图装饰；会话图标复用 DSH `IconQueueOutline14`，未使用手绘 SVG、CSS 图标或文本符号。
- 文案与内容：分组标题为“会话”，项目的空白占位会话和子代理均不再混入候选；真实独立会话标题与“在线/离线”状态正确显示。

**Open Questions**

- 输入框原生 reference occurrence 的可视单元固定为 4em，以保证光标与文本层严格对齐；长会话标题会省略，完整标题保留在 tooltip。该差异接受为宿主原生约束。

**Comparison History**

- 第一轮证据：`assets/session-reference-before-feedback.png`
  - [P1] 项目根节点对应的空白会话混入候选。
  - [P2] 状态紧跟标题，未统一靠右。
  - [P2] 选中态圆角在菜单边缘留下可见缝隙。
- 修复：过滤 `blank` 会话；候选状态列改为右对齐；候选行圆角改为 0。
- 第二轮反馈：Harness 原生标题列的 `max-width: 40%` 导致提前省略，并在标题与状态之间留下大块空白。
- 修复：标题列改为 `flex: 1; min-width: 0; max-width: none`，状态列改为固定宽度并保持右对齐。
- 第三轮反馈：三个 `origin: subagent` 的测试子代理仍出现在用户候选中。
- 修复：候选层仅依据 DSH 的 `origin: subagent` 排除子代理；不使用父会话字段判断，因此普通分叉会话仍正常显示，底层 Agent 通信能力不变。
- 修复后证据：`assets/session-reference-implementation.png` 与 `assets/session-reference-qa-menu.png`。项目占位、子代理、提前省略和圆角缝隙均已消除；浏览器 console 无 error/warn。

**Implementation Checklist**

- [x] 仅显示真实、未归档且非当前会话
- [x] 用户候选不包含项目占位和子代理
- [x] 会话聊天图标使用 DSH 图标库
- [x] 在线状态位于行尾
- [x] 标题宽度随菜单剩余空间自适应
- [x] 选中态为直角整行高亮
- [x] 输入框引用绑定稳定 session ID
- [x] 发送后引用可点击跳转
- [x] 完整发送链路与回信已验收

**Follow-up Polish**

- [P3] 若 Harness 将来开放可变宽 reference cell，可再让输入框完整显示长标题；当前不覆盖宿主的 4em 对齐机制。

final result: passed
