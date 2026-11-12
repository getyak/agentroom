# 仓库与开发入口

自 2026-11-12 起，主仓库为 [getyak/agentroom](https://github.com/getyak/agentroom)。新的分支、issue、PR、CI 和 Release 使用这里的 main。AgentStudio 历史及声明保留，后续交付不再以旧 fork 为目标。

## 新工作区

```sh
git clone https://github.com/getyak/agentroom.git
cd agentroom
git config remote.pushDefault origin
git config push.default simple
gh repo set-default getyak/agentroom
git fetch origin main
git switch -c codex/<issue-id>-<description> origin/main
```

本机新常规工作区使用 `~/data/agentroom`，origin 指向新仓库；并行任务从它创建 worktree。迁移源码不移动应用账号、数据库或运行服务。

## 已有工作区

旧目录可能有未完成分支、改动和其他任务使用的 worktree。先检查 git status、remote -v、worktree list，保留恢复引用。旧 PR 可按原任务完成或另行迁移，新任务从新仓库开始。

独立且没有其他活动 worktree 依赖的 checkout，可以保留旧来源后切换：

```sh
git remote rename origin agentstudio-history
git remote add origin https://github.com/getyak/agentroom.git
git fetch origin main
git config remote.pushDefault origin
gh repo set-default getyak/agentroom
```

remote rename 保留分支原 upstream，因此旧分支不一定跟踪新 origin/main；从新主分支创建任务分支，不 reset 或覆盖旧工作树。共享旧 checkout 不在其他任务运行中批量改远端，因为 Git 配置影响全部 worktree。这台主机采用独立新工作区，旧目录用于已有任务和恢复。

## 兼容标识

| 名称 | 规则 |
| --- | --- |
| 产品与仓库 | AgentRoom / getyak/agentroom |
| JS 包 | 保留 @agentstudio/* 与 workspace 依赖。 |
| bundle ID / 内部应用名 | 保留 com.cubxxw.agentstudio / AgentStudio，避免隐式更换资料和 Safe Storage 身份。 |
| 普通资料 | 保留 ~/Library/Application Support/AgentStudio 及 personal 工作区。 |
| IPC、preload、旧协议 | 保留标识，按 [API](api.md) 兼容演进。 |
| Go module | 保留 github.com/DolphinMiner/agentstudio/server；模块标识不是提交 PR 的仓库地址。 |
| 历史 PR/研究 | 保留原始链接，不做全局替换。 |

仓库、品牌、协议和用户资料分别管理。改内部标识需要单独迁移设计、回退和原资料验收，不能随 README 改名顺带执行。

## 发布与交付

发布记录在 docs/releases；每次保留来源、签名、校验和与验收范围。既有 v0.2.0-alpha.1 仍对应原源码，文档更新不改写已发布二进制或标签。

贡献说明和 [AGENTS](../AGENTS.md)约定新仓库交付。未知写入与恢复记录优先于清理；只归档本任务无活动引用的工作树和可重建产物。
