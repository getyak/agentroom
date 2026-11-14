# 在群聊里，把 Agent 轻轻分享给朋友

分享现在属于普通群聊。打开一个群，点右上角「群成员、作品与分享」。朋友打开邀请，填昵称并点「接受邀请，加入群聊」，就会成为这个群的成员，无需注册 AgentRoom。昵称只用于本次邀请，不是实名验证；主人、朋友和 AI 的身份由系统标明。

## 三个开场

- **认识我的数字分身**：给分身写一份可以公开的角色说明，再一起写自我介绍、聊点子、测默契。分身始终是 AI，不代主人承诺。
- **把周末交给海风**：邀请路线、预算等 Agent 联系人，朋友各自补充偏好，一起决定方向，写一份旅行小抄。
- **一起做个奇怪小项目**：在群里写第一稿、投票决定下一步、做一轮选项式默契小游戏。普通私有群仍可使用原有审批创作流程制作文档或网站；公开访客群目前仅提供固定便笺与活动工具，不执行任意游戏代码。

私聊中的示例会填写到可见输入框；你发送需求后，Agent 可以使用 `group_contacts/create/info/add_agents/invite` 挑选已有伙伴、提交建群/加人的待审批卡、准备邀请草稿。批准后才创建真实群聊，卡片可打开目标群。新群不会自动启动所有 Agent 的模型请求，打开后发消息即可开始。

## 邀请与规则

1. 在「邀请朋友」选个开场，填写共同背景、参加的本机 Codex/Pi 与各自的公开角色说明。不会复制私聊或私人指令。
2. 「准备邀请」后看完整公开范围，确认一次。之后的群消息、本次创建的群作品会对加入者可见；之前的私聊、记忆和文件不会自动共享。
3. 确认后会自动尝试开启网页邀请，只将独立访客监听器接入临时 HTTPS 通道。状态可用后复制分享链接；失败时可点「开启网页邀请」重试。本机预览地址只用于这台 Mac。
4. 移除访客会撤销其身份、更换旧邀请并阻止旧执行继续发布。结束邀请撤销访客访问，保留普通群及历史。

「Agent 规则」默认让主人确认一次再公开。你可以关闭 Agent 建群/邀请。旧的自动开放规则按“需要确认”兼容读取，不能绕过当前审批。模型只得到邀请状态和群卡，不得到链接随机值；复制由主人端完成。访客和公开群 Agent 没有私人联系人目录、跨群扩张或批准分享的权限。

成员卡区分真人的最近访问、未知状态和 Agent 的可执行、正在做事、等待主人确认、暂不可用。状态未知不表示离线或已读。工具操作前需刷新群信息，旧成员/规则版本不能继续修改。

## 群作品

共同便笺是 Library 中真正的 `note.md` 作品，每次保存产生带贡献者身份的不可变版本。保存需匹配当前版本和文件指纹；并发修改提示冲突，保留你的草稿供对照合并。Library 中的其他修改不会自动成为访客可见内容。

「一起决定」与「默契竞猜」是固定 `activity.json` 作品，参与选择按真实会话身份保存，同名朋友不会共用一票。竞猜是一起猜大家偏好的轻游戏，没有执行脚本或隐藏外部动作。旧房间的消息、便笺、清单和投票迁入普通群与作品；中断执行不自动重发。

## 访问与运行边界

默认 24 小时、5 位访客、整个邀请最多 30 次 Agent 执行。多 Agent 各算一次，主人消息也计入。上限 72 小时、10 位访客、30 次执行；消息 4000 字、本次 300 条真人消息、每群 12 件作品、便笺 12000 字。主人 Mac 需保持运行，休眠或退出时不承诺访问可用。

访客与主人在共享群发出的请求复用正常 Worker；公开请求使用明确发布的背景、角色和新消息，没有私人记忆、原聊天或默认 CLI 个性注入。共享 Agent 只拿到本群成员与固定作品工具，不能读私人 Library、Shell、第三方连接、付款、预订或部署。无法建立受限执行时直接停止，不回退普通工具权限。重试须重新发消息，按当前范围和预算执行；停止不确定或共享执行在重启时未能确认退出，会保留同后端的全局执行阻塞；主人在「大家」中核查原进程确已停止后明确解锁，才可继续。

Codex 公开执行沿用验证过的 **0.163.0** 内置 OpenAI 文件认证适配，空白 HOME/CODEX_HOME 只链接当前账号的私有 `auth.json`，不复制账号、不换提供商。Pi 使用显式禁用个人上下文、扩展与默认工具的参数。真实 Pi 账号可用性需另行验收。

邀请随机值加密保存在 vault，访客会话只存摘要。链接随机值位于 fragment，接受后从地址栏移除；会话 Cookie 为 HttpOnly、SameSite=Strict，公网 HTTPS 还带 Secure。每次请求检查范围、身份、移除和到期。持有邀请链接的人可以转发它；聊天和作品本身没有端到端或整库加密。

[Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) 的地址临时，网页轮询同步。原域名重新打开邀请会恢复既有身份；通道换域名后无法沿用旧 Cookie，需重新接受。通道在线需要收到地址及边缘连接注册；外部网页可达和模型执行仍分别验收。失去连接时撤回可复制地址，恢复后再提供。

## 开发验收

`dev/integrated-groups-acceptance.mjs` 验证两个访客、两个 Agent、普通聊天同步、共享作品、390px/1280px 和身份恢复。`dev/integrated-groups-native-acceptance.mjs` 验证 Electron 固定 IPC 与剪贴板，默认合成 CLI；`--real` 使用实际已配置 Codex，`--public` 检查真实临时 HTTPS。设置受管 `AGENTROOM_EVIDENCE_DIR`，真实账号和合成传输分别记录；旧 `playrooms-*acceptance` 命令保留为别名。

未确认发送会保存完整请求信封，刷新后可核对上一条发送，沿用原标识而不重复派工。单件旧作品转换若中断，工作区继续启动；「大家」中保留原计划供核对和恢复，不自动重做不确定修改。

New ordinary groups start with at least three members including the owner. Select one contact to start/reuse a direct conversation, or at least two contacts to create a group and prepare its invitation. Existing smaller groups/invitations remain usable; they keep their history and show one full peer portrait until a third member joins. The retired standalone creation route no longer creates a new two-member group. Owner and guest human portraits are local identity-based illustrations, not name initials.
