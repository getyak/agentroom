# 当前桌面工作区的 Web 入口实施计划

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 浏览器打开当前桌面应用的同一工作区，避免误入旧的独立 Web 服务。

**Architecture:** 一个无依赖的 macOS CLI 只发现当前安装包所属的 utility 回环端口，核验健康检查的构建提交后打开浏览器。统一目录服务另按设计逐期实施。

**Tech Stack:** Node 内置模块、macOS ps/lsof/open、node:test。

**Spec:** ../specs/2026-11-13-unified-agent-directory-design.md

## 约束与审查重点

- 不启动、关闭或接管其他后台，不修改任何用户资料。
- 仅选择指定应用的子进程和 127.0.0.1 监听，并匹配实际包内构建提交。
- 多实例、后台未就绪、构建不匹配时明确失败；不回退旧开发端口。
- Web 保持本机访问，原生登录能力仍由桌面提供。

## 任务一：实现并验收 Web 入口

Files: dev/open-personal-web.mjs、dev/open-personal-web.test.mjs、package.json、apps/desktop/README.md、docs/personal/peer-devices.md。

- [x] 写真实 HTTP 服务测试，覆盖自有/无关进程、旧构建和多实例，观察预期失败。
- [x] 实现 `findWorkspace({executable, revision, processes, listeners}) -> Promise<string>` 及 CLI；`--print-url` 只输出 URL。
- [x] 将测试加入 test:dev，更新入口和部署范围文档。
- [x] 运行宿主测试；在两台 Mac 核验输出 URL 的实际构建、目录和静态界面入口。
- [ ] 独立审查，PR 最新 CI 通过后合并。保留现有会话、资料和回滚副本。
