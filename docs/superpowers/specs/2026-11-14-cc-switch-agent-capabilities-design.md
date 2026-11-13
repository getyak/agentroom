# AgentRoom：从 CC Switch 配置到可采用的 Agent 能力

GET-540。用户要求分析 CC Switch、给出设计后直接实现，本轮按此授权连续推进。开发基线 `getyak/agentroom` main `db3d225`。

## 研究依据

本机 CC Switch bundle 版本为 4.0.22。公开源码固定在 [v4.0.22 / b764267](https://github.com/farion1231/cc-switch/tree/b76426741ef93069e2f374ac01ca7ef5760e1d0e)，不能据此证明本机二进制逐字节对应。只读核对本机数据库的表结构；没有导出凭据、对话或完整配置。源码为 MIT；本轮独立实现读取适配器，不复制 Rust 实现。

- `src-tauri/src/database/schema.rs`：SQLite 集中保存 providers、mcp_servers、skills、prompts、profiles；各客户端分别保存启用标志。
- `services/provider/codex_direct.rs`：先准备、生成补丁，再通过有恢复机制的操作写入 live 配置。供应商切换涉及认证和路由，不能只替换 model 字段。
- `services/mcp.rs`、`services/skill.rs`：扩展通过每客户端配置物化或文件同步生效；数据库启用标志不证明真实运行可用。
- `services/prompt.rs`：提示词和客户端指令文件之间会回填，存在文件与数据库的双向状态。
- `services/profile.rs`：Profile 按应用分组保存供应商、MCP、Skills 和 Prompt 快照；apply 是 best-effort，可能部分成功，不是完整事务回滚。

本机数据库与该 tag 的列并不完全一致：例如部分 Pi 启用列缺失。读取必须按实际 schema 降级，不用 0 冒充未知。私有资源的名称和内容不进入本文或测试夹具。

## 设计选择

考虑三种路径：直接由 AgentRoom 接管全局配置，接管现有代理，或只读发现后逐项采用。前两者涉及活动 CLI、共享凭据和不同的恢复协议。选择第三种，复用现有 PersonalWorker、联系人模型和审批，不引入第二个调度器。

产品模型分四层：执行后端（CLI/连接）、能力（工具/技能/指令）、联系人身份、自动化任务。联系人可以共享后端，但每次接受的运行固定能力版本与资料范围。已有“准备角色”继续负责显式采用，不能把发现记录直接创建成联系人。

## 今晚交付：只读扩展发现

设置 → 这台 Mac 中加入渐进展开的 CC Switch 配置概览，显示各客户端供应商数、选中数量、MCP/Skills 启用数量和提示词启用数量；展开后可查看最多 50 个 MCP/Skills 名称。项目配置只显示数量。

复用 GET `/api/integrations` 与 POST `/api/integrations/refresh`，新增可选 `ccSwitch` 投影，不增加 IPC 权限。固定读取服务端 home 下 `.cc-switch/cc-switch.db`。SQLite 只读连接、query_only、短 busy timeout、单次读取事务、普通表与列白名单；数据库过大、缺失、锁定、损坏分别保持可恢复状态。缺列/缺表对应分区显示未知，其余继续可用。

只查询计数和有限显示名称，不查询 settings_config、server_config、content、payload、端点、认证、日志或会话。无外部命令、网络探测、文件同步、模型调用或后台定时器。读取不改变全局 CLI 默认、正在运行的任务和联系人。真实执行能力继续由 AgentRoom 原有适配器提供。

配置概览不宣称技能已被聊天执行。Pi/Claude 的隔离执行会禁用本机扩展；Codex 扩展行为也不能由 CC Switch 启用位证明。界面明确“配置来源”的含义，数据不进入模型上下文。测试用注入 home 或显式 discovery 函数，不读取真实账户目录。

## 后续实施顺序（本轮未实现）

1. **明确采用能力**：HTTP MCP 先做精确连接预览，验证端点和凭据归属后复用现有连接/审批；stdio MCP 单独设计受控进程生命周期。Skills/Prompt 先显示来源与内容差异，作为联系人草稿显式保存；不加载未审阅脚本。
2. **联系人能力包**：持久化版本化的 backend/model/instructions/tools/skills 与授权范围。运行接受时固定版本，启动前核对变更；活动运行不热切换，原配置已消失则阻塞并保留草稿。配置写入先做隔离预览和恢复引用。
3. **自动化**：复用 AgentScheduler，任务绑定联系人及能力包版本。先做手动试跑，显示实际产物和耗时，再启用计划。保留并发通道、失败/未知回执、暂停和停止未确认。限流失败不自动换账号或供应商；只对明确可重试的读操作重试，外部写入先核查原操作。

后两阶段各自建立 Linear/PR，依真实客户端与账号验收推进，不把本轮概览称为已经完成扩展执行或自动化。

## 验收

隔离 SQLite 覆盖真实精简 schema、缺列缺表、扩展表未知、损坏、缺失、超大文件、只读不变、名称截断与凭据不外泄；HTTP 覆盖刷新和默认隔离。宿主测试、TypeScript 与浏览器宽窄屏/刷新/不可用状态通过后独立审查并走 PR 门禁。真实本机只读采样另记证据；不将合成 UI 测试当作真实模型或工具执行。
