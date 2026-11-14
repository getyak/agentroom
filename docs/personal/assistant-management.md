# 本机助手管理与 ACP

GET-552 将添加联系人整合为“本机已有”和“发现更多”。它复用个人工作区后台，不迁移现有账号配置、联系人、会话或群聊。实现入口为 `assistant-manager.mjs`、`assistant-install.mjs`、`assistant-inventory.mjs`、`acp-client.mjs` 与 `LocalAgentPicker.tsx`。

## 发现和版本

本机检测 Codex、Claude Code、Pi、Gemini CLI、OpenCode 的可执行程序和版本。沿用环境中的显式程序覆盖名，程序缺失不擅自回退到另一个账号或命令。显示系统已有安装与 AgentRoom 管理的安装来源，详细路径按需展开。

五个原生程序的最新版本来自固定官方 npm 包：`@openai/codex`、`@anthropic-ai/claude-code`、`@mariozechner/pi-coding-agent`、`@google/gemini-cli`、`opencode-ai`。更多 ACP 适配器来自 [ACP 官方稳定目录](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)。适配器的版本和原生程序版本分别显示，不能据适配器升级声称原生程序已升级。

目录在后台按日缓存刷新，界面可主动更新。目录返回 freshness、读取时间及失败信息；网络失败保留经过校验的本地目录，首次无缓存时仍显示本机发现。刷新元数据不安装、不启动模型、不改变账号。上游删除的条目仍保留已安装版本的启动信息。

## 安装和升级

安装、升级由用户点击发起，操作只提交目录 ID、操作、目标版本与幂等请求标识。后台核对 `expectedVersion`；按钮看到的版本与后台当前目录不一致时返回冲突，刷新后由用户重新操作，不替用户改装另一版。

新版本安装进本工作区的 `personal/assistants` 独立目录。安装成功后原子更新活动 manifest，旧目录保留。AgentRoom 不主动改写或迁移既有系统全局包、PATH、厂商 HOME、登录文件、MCP/Skills 配置和聊天数据库。每个被接受的消息快照保存实际执行坐标，后台升级不改写排队或运行中的请求；新请求使用新的活动版本。

npm 安装器使用独立且稳定的 HOME、缓存和空用户配置，不继承模型密钥或厂商配置目录环境变量；助手实际运行仍沿用原环境中的账号。用户选择安装的第三方 npm 脚本仍按本机用户的 OS 权限执行，这些常规目录隔离不构成操作系统沙箱。

支持固定版本的 npm 分发，以及带 SHA-256 校验的 tar.gz/tgz 和原始二进制分发。未提供完整性校验、不支持的平台/安装包格式或仅提供 uvx 的条目会显示原因，不能显示虚假的安装成功。二进制提取限制路径、文件类型、体积和链接；安装进程、输出及网络读取都有界限。

作业持久记录 queued/running/succeeded/failed/interrupted，串行执行。相同请求重放返回同一个作业；同一标识换参数拒绝。应用关闭停止本后台拥有的安装进程，重启显示中断并允许明确重试，不自动重放安装命令。安装中或停止尚未确认时阻止工作区切换/重置。

## 联系人与执行

发现目录中的未安装项目不会自动加入通讯录。用户安装后重新检测，再明确“添加并聊天”；已有联系人沿用原 ID、名称、身份、头像、群关系和聊天。原生 Codex、Claude Code、Pi 保留现有执行适配与模型配置规则。Gemini、OpenCode 使用其原生 ACP 入口；其他已安装适配器以 `acp_<registry-id>` 标识。

已经采用的 ACP 助手在可执行文件被移除后显示未安装，保留联系人身份、角色配置与历史聊天；重新检测到有效安装后恢复可连接状态。

ACP v1 使用换行 JSON-RPC stdio，遵循 [初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[会话建立](https://agentclientprotocol.com/protocol/v1/session-setup)、[回复流](https://agentclientprotocol.com/protocol/v1/prompt-turn)与[取消](https://agentclientprotocol.com/protocol/v1/cancellation)。每个接受的运行建立独立会话，历史上下文仍由 AgentRoom 管理；只把回复文本与粗粒度阶段投射到界面，不保存模型思考或原始 stderr。首次握手不调用模型，也不证明账号登录可用。

当前 ACP 接入提供个人私聊与私有群的文字会话，不授予客户端文件或终端能力；原生权限请求明确拒绝，并在会话中持久显示由宿主记录的拒绝次数。现有创作、项目授权、MCP/聊天工具和公开访客执行保留原支持范围，不因安装某个适配器自动扩大权限。ACP 是合作式协议，不是操作系统沙箱，外部助手自身配置与本机 OS 权限仍然有效。需要登录时提示使用原助手正常登录，不复制或导出其凭据。

取消发送 ACP 取消通知并停止这个运行拥有的进程组。停止未确认保留 unknown/stopUnconfirmed，不把本机停止等同远端副作用撤销。错误输出经过固定消息投影，登录地址和秘密不能从 stderr 进入日志或聊天。

## API 与测试

- `GET /api/assistants`：目录、安装事实和作业；默认快速返回本机/缓存事实，后台可刷新。
- `POST /api/assistants/refresh {}`：显式刷新官方目录/版本，参数为空。
- `POST /api/assistants/install {agentId,action,expectedVersion,clientId}`：接受安装/升级作业并返回 202；不接受任意命令、地址或环境变量。
- 原 `/api/integrations` 与 `/api/contacts/local` 保持兼容，安装的 ACP 助手加入受支持 inventory，只有明确采用才加入通讯录。

单元入口：`assistant-manager.test.mjs`、`assistant-inventory.test.mjs`、`acp-client.test.mjs`、`assistant-integration.test.mjs`。浏览器入口：`AGENTROOM_ASSISTANT_UI_EVIDENCE_DIR=<guarded-dir> node dev/assistant-management-ui-acceptance.mjs`。测试使用隔离目录、假元数据、假安装器与合成 ACP 子进程；真实账号执行与合成协议通过分开记录。

原生验收入口：`AGENTROOM_ASSISTANT_NATIVE_EVIDENCE_DIR=<guarded-dir> node dev/assistant-management-native-acceptance.mjs`；指定 `AGENTSTUDIO_PACKAGED_APP` 可验收已构建的实际包。通过共享锁和构建指纹检查，以后台测试窗口、隔离工作区与合成 Gemini ACP 程序验证 IPC、目录、联系人采用、文字回复和旧聊天/配置保留，不触碰日常工作区。

参考 [CC Switch 的安装管理](https://github.com/farion1231/cc-switch/blob/main/docs/release-notes/v4.0.12-en.md)与 [Codeman 的 CLI 探测](https://github.com/Ark0N/Codeman/blob/master/src/utils/cli-installed-probes.ts)，实现没有移植它们的账号存储或会话数据库。
