# 好友

桌面「联系人 → 好友」和「添加联系人 → 加好友」打开同一列表。创建名片后，可以复制自己的好友码，也可以输入朋友的完整好友码查找并发送申请。同名的人有不同的好友码。接收者可以接受或拒绝，申请人可以撤回。双方成为好友后可在这里发文字私信，界面显示最近 100 条。移除好友会停止双方的读取和发送。

分享邀请链接时，朋友可以直接在浏览器填昵称、创建名片并发送申请。申请会显示「通过你的邀请链接」。一条链接可分享给多人，7 天内最多接收 20 份新申请。更换或撤销会使前一链接失效，已提交的申请保留。同一链接也可粘贴到桌面的搜索框。已有群聊的免注册邀请继续在群设置中管理。

桌面名片保存在当前工作区所使用的好友服务上，登录凭据保存在本机 vault。浏览器名片使用同源会话 Cookie。当前没有在桌面和浏览器之间迁移名片或恢复已丢失凭据的流程。好友服务存储名片、好友关系和私信，私信没有端到端加密。建立好友关系不会开放群、历史工作区、Agent 或工具权限。

## 启动服务

配置一个独立 HTTPS 域名，反向代理到服务的回环端口。桌面和受邀的浏览器需要访问同一域名。服务仅发布好友页面、构建后的静态资源和好友 API。

```sh
pnpm build:personal
AGENTROOM_FRIENDS_URL=https://friends.example.org \
  AGENTROOM_FRIENDS_DATA_DIR=/path/to/private/friends-data \
  pnpm start:friends
```

默认端口为 18753，可用 `AGENTROOM_FRIENDS_PORT` 修改。默认静态目录为个人 Web 构建的 `apps/personal/dist`，可用 `AGENTROOM_FRIENDS_STATIC_DIR` 覆盖。默认数据库位置为仓库的 `.local/friends`，长期部署应设独立持久目录并备份 SQLite。只在回环端口由受控反向代理接入且该代理会覆盖访客 IP 头时设置 `AGENTROOM_FRIENDS_TRUST_PROXY=1`。默认读取 `X-Real-IP`。由 Cloudflare Tunnel 直接接入时，可以设置 `AGENTROOM_FRIENDS_PROXY_IP_HEADER=cf-connecting-ip`。

用相同的 `AGENTROOM_FRIENDS_URL` 启动桌面开发版、辅助 Web 服务，或在桌面构建时将其写入应用。未配置服务的工作区依旧可正常使用其他功能。本机开发可以在两边使用 `http://127.0.0.1:18753`。

## 接口

独立服务和桌面固定 IPC 共用 `GET /api/friends`、`POST /api/friends`。GET 返回 `{enabled,profile,relationships,invitation}`。未配置或未创建名片时，界面可根据 `enabled` 和 `profile` 显示相应状态。登录后只返回与调用者有关的关系、自己的邀请码状态和公开名片。桌面代理不会返回 Bearer，网页 Cookie 设为 HttpOnly、SameSite=Strict，HTTPS 另设 Secure 和 `__Host-` 前缀。

| POST action | 参数 |
| --- | --- |
| `register` | `name, clientId` |
| `lookup` | `code` |
| `request` | `code, version` |
| `respond` | `code, version, decision`，决定可为 `accept`、`decline`、`withdraw`、`remove` |
| `invite` | `clientId`，原操作重试返回同一链接，新的标识更换链接 |
| `revoke` | `inviteId`，只撤销该版本 |
| `preview` | `token`，返回邀请人公开名片 |
| `join` | `token, version`，提交待接受申请 |
| `messages` | `code` |
| `send` | `code, text, clientId`，相同标识和正文重试返回原消息 |

新关系的 `version` 为 0，已有关系的版本来自 GET 或查找结果。只有双方互为好友时才可读写私信。好友模块使用独立 SQLite 数据库，不将正文送入本机 Agent 上下文。

## 实时投递和好友群

好友面板打开后，客户端长轮询当前账号的修订号。申请、接受、私信和群消息写入数据库时，在同一事务中推进有关账号的修订号。服务端立即唤醒等待方，十秒无变化时返回心跳，重连会读回快照。旧服务继续使用原刷新方式。离线消息保存在服务端；当前版本在打开好友面板时接收实时更新。

在好友面板建立好友群并选择已互加的好友。受邀者确认后进入同一群聊，能看到自己加入后的消息。新群最多八人。好友保持自己的本机联系人和 Codex 登录。创建或添加本机 Codex 联系人后，打开好友群的成员栏，从「添加我的 Codex」选择联系人并明确同意。加入操作只公开选用的显示名称，并允许该群的好友点名调用。浏览器可以入群、收发明文和点名已授权的 Agent；授权本机 Codex 须在其来源 Mac 上完成。

使用「发送给」点名 Agent。任务由该 Agent 的来源 Mac 领取并运行；服务器同步文字、状态和回复。来源 Mac 离线时任务短暂排队，未完成的领取不自动重复执行。隔离执行沿用现有访客所需的 Codex 0.163.0、OpenAI 默认传输及当前 Mac 文件认证，传入本群有权看到的有限文字。停止共享或退出在本机撤销并中止进行中的群 Agent，服务端也停止接收该授权的新任务和未发布的结果。普通群文字无需本机 Codex 在线。

`GET /api/friends` 增加账号 `revision` 和 `rooms`。公网 `watch {revision}` 只等待本账号状态。桌面经固定代理 `POST /api/friends/watch {revision}`。好友群公开操作为 `group-create {title,people,clientId}`、`group-answer {groupId,decision}`、`group-view {groupId}` 和 `group-send {groupId,text,clientId,targetAgentId?}`。本地授权只通过 `POST /api/friends/group-codex` 的 `list`、`add`、`remove` 进入实际联系人和隔离执行器；桌面页面不能直接领取或伪造 Agent 的运行结果。
