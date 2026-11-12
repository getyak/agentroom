<p align="center"><img src="apps/desktop/resources/icon.png" alt="" width="128"></p>

**AgentRoom** 是本项目的新名称。可在「设置 → 测试与引导」进入独立测试模式，一键重新体验首次引导，随后返回原工作区；源码命令为 `pnpm dev:desktop:test`。详见[测试说明](docs/personal/testing.md)。

<h1 align="center">AgentRoom</h1>

[下载 macOS Alpha](https://github.com/getyak/agentroom/releases) · [发布说明](docs/releases/0.2.0-alpha.1.md)

首次打开就能见到 **阿屋 Roo**。它用 AgentRoom 的图标作头像，从本机符合条件的助手中选择后端，陪你了解环境、连接已有账号、添加联系人。已有工作区保留原数据；可从「设置 → 测试与引导」重新找它。这个独立仓库延续 AgentStudio 的源码历史和开源声明。

**Mac 应用默认打开个人 IM。** 创建 Agent 联系人、私聊、拉群讨论，在同一个审批入口查看具体动作；继续使用仓库原有的 macOS 窗口。Electron 自己管理本机 SQLite 后台，默认模式不需要启动 Matrix 服务。安装、运行与边界见[Mac 使用说明](docs/personal/README.md)。独立 Web 入口保留为开发和 QA 辅助。

[English](README.md) · **简体中文**

<p align="center">
  <img src="docs/media/agentroom-welcome.png" alt="AgentRoom：把你的联系人和 agent 放进同一个收件箱。图为 Mac 版，Muse 订好的晚餐正等你批准。" width="900">
</p>

> [!WARNING]
> **仅供个人学习和研究使用。** AgentRoom 是一个个人工具：请在你自己的 Mac 上、用你自己的账号，连接你自己的 agent。**请勿用于商业用途**，也不要用来为他人提供服务。使用风险自负，使用前请先阅读[免责声明](#免责声明)。

> **Alpha 阶段。** Apple Silicon 下载包使用 ad-hoc 签名，尚未经过 Apple 公证。安装方式、校验和与具体源码版本见发布说明；也可以从源码构建。

默认工作间以联系人和聊天为中心，保存身份、群响应策略、后台执行、精确预览与成果。人类联系人当前只保存在本机，尚无跨设备消息投递。历史任务提供原任务视图入口，保留原有草稿和恢复请求。详见 [IM 使用说明](docs/personal/messenger.md)。原来的聊天与 Agent 收件箱通过 `AGENTSTUDIO_WORKSPACE=matrix` 保留，继续使用原服务和账号，不自动迁移数据。

当前状态：早期开发阶段（v0.1）。macOS 优先：先做桌面端（Electron），之后再做手机端（Expo）。目前没有任何托管服务，所有东西都运行在你自己的 Mac 上。

<p align="center">
  <a href="docs/media/agentstudio-demo.mp4">
    <img src="docs/media/agentstudio-demo.gif" alt="75 秒演示：和 Grok bot 聊天并批准它的周报，问 Muse 天气并批准订餐，让 ChatGPT Dots 起草给 Leo 的回复，然后连接 Grok Bot、Cue、Muse 和 ChatGPT" width="820">
  </a>
  <br>
  <sub>75 秒演示。<a href="docs/media/agentstudio-demo.mp4">观看 4K 高清版（MP4）</a>。</sub>
</p>

## 能做什么

- **一件事一段对话。** 直接输入、附文本资料，回来继续查看进展、决定与报告。
- **点击连接。** 自动发现本机助手，选择 Codex 或 Claude Code；个人服务直接登录，DeepWiki 与 Exa 无需填写协议配置。见[连接设计与验收](docs/personal/connection-design.md)。
- **本机执行。** 使用选定的 CLI，或明确选择不调用模型的本地整理；缺失执行器或额度问题会保留为阻塞。本轮 Claude 真实执行尚未成功，不会自动换提供方。
- **先核对再外发。** A2A 提交和 MCP 精确工具调用都进入当前事情的预览；收到工具响应与外部效果已核验分开记录。
- **Mac 生命周期。** 关窗隐藏时后台继续；退出应用关闭它自己的 utility，下一次启动恢复队列并保留未知结果。

### 保留的 Matrix 收件箱

以下截图、视频与连接器说明记录原 Matrix 路线：

- **一个收件箱**，装下聊天和 agent。人显示为圆形头像，agent 显示为圆角方形头像，右下角的小标记表示它来自哪个网络或服务。
- **审批。** agent 提出请求，你在聊天里或审批页点一下就能决定。
- **交给 agent。** 把一段聊天连同上下文交给 agent，它会返回几条回复草稿，可以修改后直接发送。
- **接入你已经在用的 agent**，用你自己的账号在 Mac 上登录：Grok Bot（账号下的每个 bot 都会接入，名字和头像各自保留）、Muse、ChatGPT Dots 和 Cue（用 Manus 账号登录，或者使用 Manus API key）。这部分是实验性功能，仅供个人使用，请看[下文](#免责声明)。
- **接入支持开放协议的 agent**：[AgentRoom Agent Protocol](docs/agent-protocol.md)、A2A 和 ACP。Hermes Agent 和 OpenClaw 会被自动识别，显示它们自己的图标。

<p align="center">
  <img src="docs/media/approvals.jpg" alt="agent 先问再做：一个 Grok bot 询问是否发送周报，下面有 Send it 和 Don't send 两个按钮" width="820">
</p>
<p align="center">
  <img src="docs/media/ask.jpg" alt="对任意消息询问 agent：选一个 agent 和它可以读的消息，拿回回复草稿" width="820">
</p>
<p align="center">
  <img src="docs/media/connect.jpg" alt="接入你已经在用的 agent：Connect 页上有 Grok Bot、Muse、ChatGPT Dots 和 Cue，Grok Bot 下已连接了两个 bot" width="820">
</p>

## 项目结构

| 部分 | 位置 | 说明 |
|---|---|---|
| 桌面端 | `apps/desktop` | 默认原生个人界面、独立 preload 与自有 utility；Matrix 模式保留原界面及连接器。 |
| 个人工作间 | `apps/personal` | 共享对话/阅读界面与 Node/SQLite 引擎，也提供辅助 Web 入口。 |
| 手机端 | `apps/mobile` | Expo / React Native。原生版本完成之前，先在网页版上测试。 |
| 客户端核心 | `packages/core` | Matrix 客户端、收件箱、审批、任务，由 Matrix 桌面和手机端共用。 |
| 品牌素材 | `packages/brand` | AgentRoom 所连接服务的官方图片，附来源。 |
| 服务端 | `server`（Go） | `agentstudio-api`、`agentstudio-agents` 和 `demo` 两个桥接（mautrix bridgev2）、协议适配器、示例 agent。 |
| 消息服务器 | Synapse | 保留的 Matrix 路线使用，联邦功能关闭。 |
| 开发环境 | `dev/stack.mjs` | 在本机用原生进程启动全部服务，不需要 Docker。 |
| 端到端测试 | `e2e` | 用 Playwright 测试 Electron 应用和手机网页版。 |

更多内容见 [docs/architecture.md](docs/architecture.md)。其他文档：[API](docs/api.md)、[客户端](docs/clients.md)、[设计](docs/design.md)、[Matrix 事件](docs/matrix-events.md)。（文档目前为英文。）

## 快速开始（macOS）

默认 Mac 应用需要 Node 22.13+ 和 pnpm。模型任务另需本机已安装、已配置的 Codex CLI；“先体验一件小事”使用合成资料，不调用模型。

```bash
pnpm install --filter '@agentstudio/desktop...' --frozen-lockfile
pnpm --filter @agentstudio/core build
pnpm --filter @agentstudio/desktop build
pnpm --filter @agentstudio/desktop start
```

构建后的页面从本地文件加载；应用自动启动随机回环端口的自有后台，数据默认放在 `~/Library/Application Support/AgentStudio/personal`。它不附着现有 Web 服务，也不导入旧 Matrix 会话。原生开发入口是 `pnpm dev:desktop`。

`pnpm package:mac` 为本机 ad-hoc `.app` 构建入口，输出在 `apps/desktop/dist`，并写入构建回执。实际本地包已通过原生启动、结果读回和界面检查，见 [macOS 验收](docs/personal/macos-acceptance.md)；这不等于 Notarized 发布或私人账号验收，详见[桌面打包说明](apps/desktop/README.md#local-macos-packaging)。

### 保留的 Matrix 路线

这一入口另需 Go 1.26+、Homebrew PostgreSQL 18 和 uv：

```bash
pnpm install
pnpm dev:up        # 启动 Postgres、Synapse、API、桥接和示例 agent（第一次约 30 秒）
AGENTSTUDIO_WORKSPACE=matrix pnpm dev:desktop
pnpm dev:mobile    # 在 Expo 网页版上运行手机端：http://localhost:18300
```

不需要注册账号：开发环境默认是本机模式，打开应用就直接进入收件箱。
（想试邮箱登录的话，退出登录后点"Sign in with email instead"。开发模式下验证码不会真的发邮件，可以在
`http://127.0.0.1:18090/v1/dev/outbox?email=<你的邮箱>` 查看，`.local/logs/api.log` 里也有。）
然后在 Connect 页添加 **Demo** 网络（模拟的联系人）和 **Concierge** agent，或者登录一个你已经在用的 agent。

管理本地服务：

```bash
pnpm dev:status          # 查看运行状态
pnpm dev:restart <name>  # 重启某个服务，例如 api、agents
pnpm dev:logs <name>     # 查看某个服务的日志
pnpm dev:down            # 停止全部服务
pnpm dev:reset           # 停止服务并删除 .local/ 下的全部本地数据
```

旧服务的数据库、Synapse 和日志位于忽略提交的 `.local/`。辅助 Web 入口使用 `.local/personal`；默认 Mac 应用使用自己的 profile 目录，两者不会自动迁移。

## 测试

```bash
pnpm test        # 单元测试：开发环境脚本、Go、TypeScript
AGENTSTUDIO_WORKSPACE=matrix pnpm test:e2e    # 保留的 Matrix Electron 和手机网页版，连接本地服务
```

如果 `pnpm install` 之后找不到 Electron 程序（pnpm 有时会跳过它的安装脚本），请在 `apps/desktop` 下运行
`node node_modules/electron/install.js`。Playwright 用的 Chromium 用
`pnpm --filter @agentstudio/e2e exec playwright install chromium` 安装。

## 接入 agent

默认个人工作间在偏好设置添加自己的 A2A/MCP 地址，可选 Bearer token；外发仍逐次预览批准。Bearer 使用 AES-256-GCM 文件 vault，**不是 Keychain**，本机系统账号、密钥和备份仍是边界。没有 OAuth、自定义认证头或通用账号证明；任务提示词和独立工作目录也不是对所有 CLI 插件的强制沙箱，见[实际控制边界](docs/personal/README.md#实际控制边界)。

以下连接器表格属于 `AGENTSTUDIO_WORKSPACE=matrix`：

| agent | 方式 |
|---|---|
| Concierge（内置示例 agent） | Connect → Agents on your server → Concierge |
| 任何实现了 AgentRoom Agent Protocol 的服务 | Connect → AgentRoom agent endpoint，填入它的地址和 token |
| A2A agent（例如 Hermes Agent） | Connect → A2A agent，填入 agent 的地址 |
| 服务端允许的 ACP agent（`AGENTSTUDIO_ACP_AGENTS`） | Connect → ACP agent |
| Grok Bot、Muse、ChatGPT Dots、Cue（仅 Mac 版，实验性） | Connect → Agents you already use。你的登录凭据（或 Cue 的 API key）只保存在这台 Mac 上；AgentRoom 开着时这些 agent 才会回复。 |

连接 Grok Bot、Muse、Dots 或 Cue 之前，请先阅读[关于第三方连接器的说明](#免责声明)。

调试连接器时，可以用 `AGENTSTUDIO_CONNECTOR_TRACE=1` 启动应用（再加上 `AGENTSTUDIO_CONNECTOR_SHOW=1` 可以显示 Muse / Dots 的后台窗口）。详见 [docs/connectors.md](docs/connectors.md)。

## 免责声明

**⚖️ 本项目仅供个人学习和研究使用。** 使用 AgentRoom 之前，尤其是使用 Grok Bot、Muse、ChatGPT Dots 和 Cue 的连接器之前，请先阅读以下内容。

- **仅限个人使用：** 请在你自己的 Mac 上、用你自己的账号连接你自己的 agent。请勿用于商业用途，不要用来为他人提供服务、批量自动化，或使用不属于你的账号。
- **本机应用与存储：** 没有托管的 AgentRoom 服务器。选定上下文会发送给本人配置的模型提供商或已批准的远端服务；旧登录凭据使用 Electron safeStorage，个人 Bearer 使用明确说明的文件 vault，而不是 Keychain。
- **与相关服务无关联：** 本项目与 xAI / SpaceX AI、Cursor（Anysphere）、Meta、OpenAI、Manus、Nous Research、OpenClaw 均无关联，也未获得其认可。相关名称和图标归各自所有者，仅用于标明连接的是哪个服务。
- **非官方接入：** 除 Cue 的收发消息使用 Manus 公开的官方 API 外，其余连接器都模仿对方 App 或网页的工作方式，可能违反对方的服务条款，也可能随时失效。
- **责任自负：** 你需要自行遵守各服务的条款和所在地的法律法规。如不确定，请不要连接。
- **风险自担：** 本项目按"原样"提供，不提供任何担保（见 Apache-2.0 许可证）。作者不对使用本项目造成的任何损失、账号受限或其他后果负责。

各服务的具体情况见 [docs/connectors.md](docs/connectors.md)（英文）。

## 参与贡献和安全问题

- [CONTRIBUTING.md](CONTRIBUTING.md)：如何搭建环境、运行测试、提交改动。
- [SECURITY.md](SECURITY.md)：如何私下报告安全漏洞。请不要为安全漏洞开公开的 issue。
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)：行为准则。

## 许可证

Apache-2.0。第三方声明见 [NOTICES.md](NOTICES.md)；品牌图片归各自所有者（见 [packages/brand/README.md](packages/brand/README.md)）。
