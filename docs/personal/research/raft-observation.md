# Raft 源码观察：个人 Agent 应吸收协调负担

研究对象：[botiverse/raft-source](https://github.com/botiverse/raft-source)，精确提交 [`db5e399f017d584e49597e3a28757645d6807893`](https://github.com/botiverse/raft-source/tree/db5e399f017d584e49597e3a28757645d6807893)。发布版本 `v1.21.23-source.1`，提交时间 `2026-10-19T19:55:13-04:00`。研究时使用仓库外的只读浅克隆，没有把 Raft 源码复制进本仓库；上方固定提交链接可用于复核。已取 manual 和 packages/*/src 共 3,580 个文件（3,437 个 TypeScript/TSX 文件），沿任务链选读实现及关联测试；未逐行阅读全部 3,580 个文件。只读分析源码和随仓手册，没有运行产品、安装依赖或调用模型。下文行号为该提交的文件行号。手册是产品规约或作者陈述，不能代替当前代码或运行验证。此仓库为 FSL-1.1-ALv2 source-available 发布镜像；本报告提炼行为与设计问题，不建议直接移植实现。

**当前最强结论（研究判断）：保留 Raft 的“消息承载协作、任务独立记账、动作有回执、上下文有看见边界”；个人 Agent 的主要入口应替用户承担路由、追踪和恢复，而不是要求用户变成多 Agent 团队的调度员。**

| 任务阶段 | 观察到的事实与源码证据 | 对个人 Agent 的推断与取舍 |
|---|---|---|
| 意图进入 | 手册把人类路径写成发消息、转任务、claim、改状态；`manual/agent-knowledge/task.md:25-65`。但本次源码的事实已是独立 `tasks` 表，消息是承载/讨论入口：`packages/server/src/services/taskService.ts:1340-1363,2414-2436`。 | 保留聊天与工作对象相连。普通用户说“帮我完成”后，应由系统建立可追踪工作，不再要求用户理解“先发消息再转任务”。不能把手册的“消息 metadata”当作当前存储结构。 |
| 上下文接续 | 新 session 可注入有预算的 MEMORY.md 头部，完整/截断事实可见；resume 不重复注入；配置受 server flag 控制：`packages/daemon/src/startupMemoryBlock.ts:5-22,44-61,90-134`。spawn/压缩会产生新的 context generation，未知状态不伪装“已看见”：`packages/daemon/src/contextGeneration.ts:1-25,159-207`。 | 保留显式上下文身份、来源和截断状态。用户不应手动复制历史、重述任务、判断 session 是否丢失；重要承诺与任务当前约定应独立保存，MEMORY.md 不是任务完成证明。 |
| 注意力与路由 | `@mention`、成员可见性、被动投递是三种不同机制；公开频道非成员被 @ 后仍需发送者 notify/add：`manual/agent-knowledge/mention.md:132-152`。外部 Agent 的 push 是签名通知而非正文；收件方 pull/ack，通知本身不移动 cursor：`packages/server/src/services/agentInboxPushService.ts:1-26`。托管投递先过 scope/ACL，再选择直投或唤醒；外部 Agent 由自己的 pull 消费：`packages/server/src/services/agentOrchestrator.ts:15755-15840`。 | 保留可见性与投递分离、不会把“发出通知”当成“已读”。舍弃让普通用户先学 @谁、频道成员、线程 follower、MCP carrier 差异的主流程；由个人协调入口选择执行者，并向用户回报是否真的接手。 |
| 执行所有权 | claim 与 assign 分开；预分配给别人不等于别人开始。CAS 按读到的状态与 assignee 防止并发执行，冲突只阻止冲突实现，不禁止读、协调、审查：`packages/server/src/services/taskService.ts:190-206,347-356,2567-2649`。 | 保留单一责任人、并发写保护和“派发/接手/完成”区别。协调者自动做派发与移交；只在职责冲突确实涉及本人优先级时询问，不让用户逐个催 claim。 |
| 批准 | Action Card 把准备、执行身份和结果状态分开；只有有相应权限的人类执行，重复执行返回原结果：`packages/server/src/services/actionCardsService.ts:11-28,979-1011,1110-1143`。手册承认通用审批不在此原语内，其他场景靠聊天约定：`manual/agent-knowledge/agent-draft-human-commit.md:17-34`。 | 保留“可审阅具体动作→本人批准→绑定动作版本→执行回执”。不要把每次工具调用、安装检测、可逆准备工作都变成审批。不能把当前的特定 Action Card 类型宣称为通用授权系统。 |
| 持久化与幂等 | task 当前投影、revision CAS 和 append-only `task_events` 在同一事务中：`packages/server/src/services/taskService.ts:1408-1436,1496-1583`。task-create/action-prepare 幂等键绑定 agent、route、请求指纹；相同请求重放首响应，异请求 409；有效期 24h：`packages/server/src/services/agentApiIdempotencyService.ts:1-36,128-189`。 | 保留稳定 operation id、请求版本、结果引用、原子事件。24h 后的自动重试必须重新核对外部事实，不能把幂等键视为永久防重。 |
| 最新约定检查 | `planAgentInboxSideEffect` 会检查 pending message 是否被当前模型看见；没看见时返回 held context，默认展示最近 3 条并标遗漏数，而不是悄悄提交旧决定：`packages/daemon/src/agentInboxStateMachine.ts:120-240,437-489`。 | 保留执行前的上下文新鲜度检查。应由 Agent 自动读到变更、更新计划再继续；这是信息补齐，不应变成“请用户再说一次”或“批准跳过未读”。 |
| 失联、结果未知 | daemon outbox 已实现先落盘再发、同 identity 重发、精确 ack 后删除、open launch、crash 后不确定结果与人工恢复边界：`packages/daemon/src/runtimeOutcomeOutbox.ts:1-130,1082-1113,1168-1204,1461-1486,1540-1618`。但是 server 明确把 `RUNTIME_OUTCOME_ACK_ENABLED` 设为 `false`：`packages/server/src/runtimeOutcomeOutboxIngest.ts:21-57`；orchestrator 也在 handler 入口直接返回：`packages/server/src/services/agentOrchestrator.ts:10876-10892`。daemon 对 confirmed-old server 不使用人工恢复门禁，避免永久卡住：`packages/daemon/src/runtimeOutcomeOutbox.ts:1091-1100`。 | **只能确认恢复协议实现存在，不能确认该快照开启了端到端可靠结果确认。** AgentStudio 应把“已接收/已开始/已提交/结果未知/已核验完成”分开；丢失连接后先查外部事实，再决定能否重试。 |
| 恢复跟踪 | server ingest 的合同是状态与 watermark 一起提交，再 ack；已提交 replay 只重 ack，不能再次应用：`packages/server/src/runtimeOutcomeOutboxIngest.ts:1-25,262-283`。外部 Agent 通知有 sweep 补发、受限 backoff、lastDelivery/nextAttempt 等诊断：`packages/server/src/services/agentInboxPushService.ts:20-26,67-106,123-168`。 | 保留恢复队列和可观察的重试计划。界面只报“正在重试，下一次时间/原因”；底层通知投递成功仍不等于用户目标完成。 |
| 真阻塞通知 | owner DM 会收到一次可行动通知，agent 自己不被此通知再次唤醒；凭证/模型权限/CLI runtime 不可用会暂停自动 wake：`packages/server/src/services/agentActionRequiredNoticeService.ts:13-26,32-72,79-104`。 | 保留只通知真正能解决问题的人，给单一下一步。凭证和额度可能是本人权限决定；检测/安装 CLI、保留积压、恢复后续跑通常是产品运维责任，不能把所有 runtime unavailable 都外包给普通用户。 |

关联测试（仅静态阅读，未运行）包含默认不广告 ack 能力、commit 后 ack、回执丢失重放不再应用、写入失败不 ack 的负对照：`packages/server/src/runtimeOutcomeOutboxIngest.test.ts:136-231`；daemon 断线及重启保留原 identity：`packages/daemon/src/runtimeOutcomeOutbox.test.ts:97-144`；5 条未读只展示最后 3 条但标明遗漏 2 条：`packages/daemon/src/agentInboxStateMachine.test.ts:63-109`。这些证明维护者将其写进测试合同，不证明本机执行通过。

**用户介入分成三类（设计判断）**

| 介入类型 | 应留给用户的内容 | 产品应先完成的事 |
|---|---|---|
| 本人决定 | 身份承诺、对外发送、付费/额度、不可逆动作、无先例的偏好或目标冲突 | 具体方案和预览、影响与成本、一个有上下文的问题。依据：`manual/recipes/decision/when-to-ask-human.md:23-35`。 |
| 只有本人有的信息 | 尚未连接的信息、真实目标/收件人不明、互相冲突且不能推断的要求 | 先查已授权来源；保留现有进度；把缺口压缩成一问。上下文未读、服务返回慢、session 换代不是“本人缺信息”。 |
| 调度负担 | 选 @哪个 Agent、记住谁还没回、改 task 状态、重建提醒、查 daemon 日志、追问工作是否落地 | 协调入口自动路由/认领/追踪/核验/恢复。Raft 自己给 PA coordinator 的职责就是跨频道 worklog、路由和排序 pending-on-owner：`manual/recipes/archetype/pa-coordinator.md:22-32`。 |

**建议直接保留的产品原则（推断）**

1. 一个主要 IM 对话入口。任务卡是消息中的可见投影，详情按需展开；用户继续在原对话补充要求，执行约定随 revision 更新。
2. 每项工作带任务、尝试、动作和结果引用；运行心跳、通知投递、工具退出码、用户目标验收分别记账。
3. 外部副作用有稳定请求身份与结果核对入口。失联后显示“结果待确认”，不能自动改成失败后盲重试，也不能把连接恢复改成完成。
4. “需要你”队列只放本人决定或确有信息缺口；每项携带预览、默认建议、为什么要本人决定。可逆准备、路由、调查和恢复继续进行。
5. 周期任务以输出账本验收。手册明确要求 FIRED 与真实输出双向核对、补漏和有证据的 owner cutover：`manual/recipes/pattern/recurring-recovery.md:23-39`；当前源码也明确在 migration control gate 下丢弃没有 ackable seq 的 transient reminder wake，并称之为 fire-and-observe：`packages/server/src/services/agentOrchestrator.ts:15844-15860`。这属于需被程序化的规约，不足以证明这个快照已经有通用周期任务结果核验器。

**建议舍弃或隐藏的负担（推断）**

- 频道/DM/thread/MCP/CLI/provider/runtime 作为普通用户开始任务前必须理解的术语选择。
- 把任务状态当作执行结果；把 Agent 的“我接了”当作接手证据；把 reminder fired 当作产物已存在。
- 为了弥补系统断线、命令版本和投递差异而写给用户的长排障规约。
- 重复输入框、重复转任务、人工汇总多个 Agent 回复等操作。可以保留给专家，但不应成为主路径。

**本次研究过程的切换与等待（亲历观察，不是 Raft 运行测试）**

- 浅克隆先受本机 Git 代理拖慢：HTTP/1.1 仍连续两分多钟没有可见进展。只中断了本任务的 PID，临时绕过代理，不修改全局配置。直连能得到响应，但完整 clone 继续下载大量对象；随后改 `blob:none`、sparse-checkout，仅取 manual 和 packages/*/src，排除媒体和 Drizzle 历史快照。
- 等待期间在终端 session、GitHub/raw 源码、进度轮询、版本定位之间切换；通过官方 raw 文件继续研究，没有要求用户处理代理、Git 参数或安装环境。这些技术判断可由 Agent 代办。
- 出现了两个易误判：手册的旧存储模型与当前 tasks 表不一致；可靠 outbox 注释完整但 server 开关关闭。产品应将“文档宣称、代码实现、配置开启、实际运行”分列，避免用户自己审计。
- 资源检查显示共享主机约 11.39 GiB 可用磁盘、6.77 GiB swap；没有启动服务器、Docker、浏览器集群或模型。研究只做轻量网络读取与静态检索。源码 checkout 已完成，浅克隆 HEAD 与上述 SHA 一致、git status 干净。未执行任何源码测试，因此本报告不宣称测试通过或真实账户恢复验收。

后续若验证运行行为，应单独覆盖：请求提交后连接丢失、外部副作用已发生但回执丢失、服务重启、旧 session 恢复、最新指令到达执行前、同幂等键不同请求、24h 键过期、runtime/凭证修复后的积压恢复。每例核对真实输出与重复副作用，不能只看 UI 状态。

## Integrated groups follow-up (2026-11-12)

Source reference remains botiverse/raft-source `db5e399f017d584e49597e3a28757645d6807893` (main API readback matched at inspection). This change uses its ideas, without importing source: versioned current member/context cards, distinct membership and execution capabilities, and an action card only when authority is missing. Primary files: [channel guide](https://github.com/botiverse/raft-source/blob/db5e399f017d584e49597e3a28757645d6807893/manual/agent-knowledge/channel.md), [channelCard](https://github.com/botiverse/raft-source/blob/db5e399f017d584e49597e3a28757645d6807893/packages/cli/src/ax/channelCard.ts), [passive resources](https://github.com/botiverse/raft-source/blob/db5e399f017d584e49597e3a28757645d6807893/packages/shared/src/agentOps/passiveResources.ts). These are source observations, not a runtime acceptance of Raft.
