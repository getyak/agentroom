# Wabi 群聊与 MCP 控制：客户端结构分析

日期：2026-11-14（Asia/Shanghai）。本轮读取本机官方 Wabi 0.1.31 安装包 `app.asar` 的静态客户端；不读取登录资料、私聊、token，不复制第三方实现。安装包版本已核对，不能推定它与最新服务端完全一致。

## 可确认的结构

| 路径 | 本轮观察 | 对 AgentRoom 的启发 |
| --- | --- | --- |
| 外部 Agent 接入 Wabi | 偏好设置接受 Claude/Codex 与 `/api/v1/mcp` 地址；此前接入页说明每个 Agent 有自己的聊天 | 与接入第三方工具分开命名，避免把消息入口当工具提供方 |
| 远端 MCP 接入 | renderer 的 addMcpServer 请求带 thread_id、url、可选 api_key；支持 connected/sign_in 分支和浏览器授权结果 | 账号认证与聊天上下文分别记录；thread_id 只能证明请求关联，不能证明服务端权限隔离 |
| Mac 本机 MCP | main 的独立 MCP 模块处理 loopback；通过固定 IPC 提供服务器清单、连接、断开、添加、移除、调用 | MCP 凭据留在拥有它的设备，由可信宿主执行 |
| 目录 | 客户端契约至多 8 台服务器、每台至多 300 个工具；有 connected/disconnected/needs_reconnect 状态 | 接入成功、目录可见和可执行是不同状态 |
| 目录哈希 | 暴露给 backend 的工具目录经过规范化并计算哈希；调用含 catalogHash，可返回 catalog_changed | 发现与执行之间目录变化必须重新核对 |
| 一次调用 | callId、server、tool、arguments、catalogHash、readOnly、longWait、deadline | 身份、参数、目录、期限都需有可审核记录；readOnly 字段不等于用户授权 |
| 回执 | 区分 unsupported 与 ran；后者可带 isError、truncated、outcome:unknown，以及 long wait 状态 | 超时和断线不能自动等于未执行；未知写入不能盲目重放 |
| 本机保存 | 新增服务器定义与 token 使用加密文件存储；本机与远端分工可从源码注释和入口确认 | 连接资料和模型上下文分离 |

证据定位：官方安装包 `out/main/index.js` 的 MCP IPC schema、`catalogOf`、`mcpServers`；renderer 的 `-connectors-*`、`useQuery-*` 与 `preference-*`。临时摘取只保存在本任务管理产物目录，正式仓库只记结构观察。

## 群聊玩法与可迁移设计

官网把群聊定位成共同完成旅行计划、预订与小游戏的空间，[当前首页](https://wabi.ai/)仍明确强调多人一起使用和按结果呈现界面。这是产品陈述，不是本轮完成交易的证据。

基于上述结构，可推断它把“聊天内意图 → 某人的连接 → 有界调用 → 聊天结果/界面”连起来。适合 AgentRoom 的三个例子：旅行群由规划 Agent 查资料、行程 Agent 提议建日历；共同创作群由研究 Agent 查来源、编辑 Agent 写作品；数字分身群由各角色共享明确开放的知识工具。每个角色仍需要分别获得该连接在该群的使用范围，发送消息/建日历等动作继续精确批准。

本轮**未证明** Wabi 服务端如何检查群成员角色、谁能借谁的连接、是否所有写入都要求审批、OAuth scope 怎样映射到群权限，或外部 Agent 能否跨群访问。客户端 schema 和 thread_id 不能证明这些强制规则。没有进行凭据提取、未授权 API 调用或账号权限绕过。

## Nango 官方契约核对

[Agent sessions](https://nango.dev/docs/guides/agent-sessions)支持服务端创建不可变 session，固定 tenant、toolset、discovery；返回独立 mcp_url / session_token；支持 pinned integration_id/connection_id、工具白名单、过期和终止。与[Management MCP](https://nango.dev/docs/reference/backend/management-mcp)分开：本产品运行时不把管理 MCP 授予聊天 Agent。官方文档是本轮在线核对，具体契约仍需由集成测试验证。

AgentRoom 采用的详细方案见 [Nango 与群聊 MCP 设计](../../superpowers/specs/2026-11-14-nango-group-mcp-design.md)。
