# AgentRoom 文档

主仓库为 [getyak/agentroom](https://github.com/getyak/agentroom)。当前说明、接口契约和历史研究分别阅读。

## 使用与接入

| 主题 | 文档 |
| --- | --- |
| 下载与首次体验 | [中文 README](../README.zh-CN.md)、[发布说明](releases/0.2.0-alpha.1.md) |
| 桌面与对话 | [使用说明](personal/README.md)、[联系人和会话](personal/messenger.md) |
| 阿屋与测试 | [重新引导与独立资料](personal/testing.md) |
| 接入助手 | [连接设计](personal/connection-design.md)、[连接器](connectors.md) |
| 自己的设备 | [两台 Mac](personal/peer-devices.md)、[服务器节点](personal/remote-nodes.md) |
| 共同作品 | [操作与权限](personal/artifact-coauthoring.md) |

## 系统与设计

| 问题 | 文档 |
| --- | --- |
| 进程、模块和资料怎样组织？ | [架构](architecture.md) |
| 发送、决定、恢复和作品版本怎样工作？ | [详细设计](detailed-design.md) |
| 审批接下来如何收拢？ | [Raft 研究与审批架构提案](superpowers/specs/2026-11-13-approval-architecture-design.md)（尚未实现） |
| 界面和状态怎样呈现？ | [交互设计](design.md)、[视觉语言](personal/visual-language.md) |
| 已交付什么，后续做什么？ | [路线图](roadmap.md)、[实施方案](plans/architecture-evolution.md) |
| 去哪里开发和提交？ | [仓库迁移](repository.md)、[贡献说明](../CONTRIBUTING.md) |

## 契约与证据

接口字段和权限以 [API](api.md)、[client test IDs](clients.md)和 [AGENTS](../AGENTS.md)为准，宿主/打包见 [desktop README](../apps/desktop/README.md)，安全问题按 [SECURITY](../SECURITY.md)私下报告。

验收要同时注明提交、对象和方式。CI、浏览器合成数据、真实 CLI、私人账号、实际包与物理设备分别说明。主要记录包括 [macOS](personal/macos-acceptance.md)、[连接](personal/connection-acceptance.md)、[共创](personal/artifact-coauthoring-acceptance-2026-11-11.md)和每次 [Release](https://github.com/getyak/agentroom/releases)。历史通过不自动证明当前版本全部通过。

## 兼容与历史

[Matrix 入口](legacy-matrix.md)单独维护。重组前的[架构](architecture-history.md)、[设计](design-history.md)和[路线图](roadmap-history.md)是 2026-11-12 快照。superpowers/specs、superpowers/plans 以及 personal/research 按原日期和证据阅读，不能仅凭提案推定功能已经实现。
