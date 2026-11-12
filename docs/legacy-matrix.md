# Matrix 兼容入口

默认桌面使用个人工作区。此页保留原 Matrix 收件箱的启动和端口，不定义当前个人模式的后端；旧路线的完成项和待办不映射成新产品状态。

## 启动

除 Node/pnpm 外需要 Go 1.26+、Homebrew PostgreSQL 18 和 uv。服务使用原生进程，不使用 Docker。

```sh
pnpm install --frozen-lockfile
pnpm dev:up
AGENTSTUDIO_WORKSPACE=matrix pnpm dev:desktop
pnpm dev:mobile
```

状态、日志与生成配置位于 .local/。使用 dev:status 检查、dev:logs 查看、dev:down 停止自有栈。dev:reset 会删除该栈资料，先确认目标与恢复；它不是个人模式的重置入口。

## 进程与端口

以下是既有回环开发配置，修改前先检查占用。

| 进程 | 默认端口 |
| --- | --- |
| 私有 PostgreSQL 18 | 54329 |
| Synapse | 18008 |
| API / Matrix proxy | 18090 |
| demo / agents bridge | 18101 / 18102 |
| Concierge / adapters / A2A echo | 18201 / 18202 / 18203 |
| Expo Web | 18300 |
| 旧连接器 host | 18401 |
| 合成连接器测试服务 | 18410 |
| 桌面 Vite dev | 5173 |

该模式使用原 renderer、preload、session 与 bridge。个人模式不自动导入它的聊天/登录；个人服务接入也各有生命周期，两条路线分别验收。

## 开发与测试

```sh
pnpm test:go
AGENTSTUDIO_WORKSPACE=matrix pnpm test:e2e
```

Go 使用 -tags nocrypto，当前路线不启用 E2EE。[E2E 文档](../e2e/README.md)说明范围；保留的 Expo 代码不等于已经发布原生 iOS 应用。

- [原架构](architecture-history.md)：旧模块、端口和决策。
- [Agent Protocol](agent-protocol.md)、[Matrix events](matrix-events.md)：兼容协议。
- [连接器](connectors.md)：服务差异、凭据与个人用途。
- [旧视觉](design-history.md)、[旧路线图](roadmap-history.md)：历史资料，不作当前清单。
