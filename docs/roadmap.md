# AgentRoom 路线图

基线为 2026-11-12 的 `v0.2.0-alpha.1`。主仓库是 [getyak/agentroom](https://github.com/getyak/agentroom)，本轮 GET-519 交付文档与后续实施方案。表中的实现、实际验收与未来提议分别记录。

## 已发布与当前实现

| 方向 | 当前状态 | 证据入口 |
| --- | --- | --- |
| 独立公开仓库与 Mac Alpha | Apple Silicon ZIP、SHA-256 和来源回执已发布；ad-hoc 签名，未公证。 | [Release](releases/0.2.0-alpha.1.md) |
| 首次向导 | 阿屋 Roo 默认会话、固定产品头像、合格本机后端选择、配置说明和引导卡；打开时不调用模型。 | [引导设计](superpowers/specs/2026-11-12-roo-launch-design.md)、发布记录 |
| 联系人与聊天 | 明确采用、角色配置、私聊/群聊、连续问题、正文进度、表情/静默和草稿恢复。 | [Messenger](personal/messenger.md)、对应后端/浏览器测试 |
| 本机助手管理 | 五种原生 CLI 探测、官方版本目录、独立安装/升级和更多 ACP 文字会话；元数据自动更新，安装由用户发起。 | [助手管理](personal/assistant-management.md)、GET-552 的协议/生命周期/界面验收 |
| 决定与恢复 | 请求来源、版本化决定、精确任务/工具预览、原回执核查与停止未确认保护。 | [API](api.md)、[详细设计](detailed-design.md) |
| 共同作品 | 共同方案、分工、权限、不可变版本、本机预览与交付/接受记录。 | [使用说明](personal/artifact-coauthoring.md)、[共创验收](personal/artifact-coauthoring-acceptance-2026-11-11.md) |
| 自有服务器和 Mac | 节点接入、选定 CLI 联系人共享、来源/在线状态和原任务恢复。 | [服务器节点](personal/remote-nodes.md)、[Mac 共享](personal/peer-devices.md) |
| 可选目标与调度 | 每位 Agent 的目标和本机调度；默认关闭，退出或休眠时不承诺派发。 | [目标验收](personal/agent-goals-acceptance.md) |
| 独立测试资料 | 重开引导、测试身份轮换、原资料恢复；外部 CLI 账号仍可能共用。 | [测试说明](personal/testing.md) |

实现表不是所有服务真实账号的通过清单。公开首发已记录一条真实 Codex 向导对话和具体原生包检查；连接器、其他模型、跨设备与共创证据按各自记录的提交和场景阅读。模拟返回不补足未知的账号或设备验收。

## 建议的下一阶段

下列是待启动的方案，不是新增上线承诺。完整范围、代码区域、失败情形和完成标准见[架构演进实施方案](plans/architecture-evolution.md)。

| 顺序 | 交付 | 验收重点 |
| --- | --- | --- |
| 1 | 收拢工作区应用入口，简化传输层 | 原路由、事务、通知、幂等和退出行为不变。 |
| 2 | 收拢运行接受、通道与恢复规则 | 配置漂移、同端点多绑定、取消和未知结果不重复外发。 |
| 3 | 联系人提议/申请生命周期 | 保存、发送、对方接受、可调用分别有真实回执；撤销和过期有效。 |
| 4 | 一致备份与隔离恢复 | 原身份、对象、密钥和未决状态完整，保留回退。 |
| 5 | Developer ID、公证及真实升级，再接更新器 | 干净 Mac 安装/上一公开版本升级，原资料与凭据连续。 |
| 6 | 根据测量整理 Messenger 状态接口 | 长列表、草稿、焦点、输入法和窄屏返回保持正确。 |

一、二提供后续入口的共同规则。备份恢复应先于自动升级；正式签名准备可以独立推进。已有[自动更新设计](superpowers/specs/2026-11-11-macos-auto-update-design.md)和预览不等于真实更新能力已交付。

## 需要单独设计的范围

- 联系人后端会话与增量上下文：[GET-556 设计提案](superpowers/specs/2026-11-14-contact-conversation-context-design.md)已整理独立归属、能力核验、增量回执和权限失效规则，产品实现与真实后端验收待后续任务。
- 跨所有者好友身份、可撤销授权、限额与独立会话；当前设备令牌不构成完整好友系统。
- 人与人的网络消息投递及离线收件；当前人类联系人主要用于本机记录。
- 多台桌面的数据库同步、冲突合并和设备身份迁移；不能靠同步活动 SQLite 文件实现。
- 原生移动端、推送、云中转和多用户托管；保留 Expo/Matrix 代码不代表已经发布这些能力。
- 第三方服务的实际账号校准和长期兼容；每个服务单独确定可用接口与验收范围。

## 交付口径

未来开发使用新仓库 main、独立 issue/PR 和适用 CI。代码合并、源码测试、实际包、账号、设备、公开下载和 Apple 公证分别记账。验收缺失的事项保留进行中或明确待处理，不按文档勾选项推定完成。

不保留旧路线中的周数估算作为承诺。原 Matrix 任务、旧 API 观察及历史决定保存在[旧路线图](roadmap-history.md)，兼容代码的实际维护入口见 [Matrix 说明](legacy-matrix.md)。

## 旧仓库已合并功能补迁移（GET-547）

[完整台账](migrations/agentstudio-merged-features.md)逐项核对旧仓库 52 个已合并 PR。补回访客群协作、群便笺与小游戏、只读项目目录与链接、阿屋组队配置、双人私聊/三人建群及动漫真人头像。群图像沿用自动成员拼接；新版审批、Roo 身份、MCP 和目录隐私边界保持，由相同回归共同验证。旧自动公开和模型直接建群已改为明确确认，不能通过补迁移绕过新的决定流程。

- Contact context rollout: ordinary private Pi 0.85.1 chats now own independent cold-resumed sessions and immutable incremental manifests, with source/audience invalidation, silent-turn dependency inheritance and read-only completion recovery. Execution details distinguish prompt transport savings from provider token use. Codex/Claude/ACP/A2A and project/public/shared/goal/coauthor/legacy paths remain compatible; their persistent-session contracts and automatic summarization are not enabled.
