# AgentRoom：重新引导与独立测试模式

GET-493 · 2026-11-11

打开「设置 → 测试与引导」：

1. **重新查看引导**：打开「阿屋 Roo」的会话，查看本机环境、添加伙伴、连接账号或准备角色，也可以重新设置显示名称。保留当前聊天、联系人、记忆和连接。
2. **进入测试模式**：确认后应用重新打开，使用独立空白资料。左下角持续显示「测试模式 · 独立资料」。也可从源码运行 `pnpm dev:desktop:test`。
3. **清空测试资料并重新引导**：只在测试模式显示。确认后打开全新的测试身份，欢迎页重新出现；原来的测试资料保留在旧 profile，供需要时恢复，不自动删除。
4. **返回我的工作区**：重新打开原工作区，恢复其聊天、资料、应用登录与草稿。

新工作区直接打开「阿屋 Roo」的会话，使用项目图标作头像，从本机已安装、支持执行、已配置登录且模型配置有效的助手中选择后端。没有可用后端也能使用引导卡。进入时不会调用模型；后续不会因登录失败静默更换提供商。引导卡可填写显示名称，也可以留空继续。已有资料的工作区不会被强制插入首次引导。角色建议使用既有实际连接测试和建议预览，点击采用后才创建联系人；连接入口打开现有账号、工具和其他设备设置。

## 隔离与执行边界

测试 profile 位于正常 Electron profile 下的 `agentroom-test-profiles/<opaque-id>`。SQLite、应用保存的凭据、原生服务文件、Chromium cookie/partition、localStorage 和草稿都使用这一独立目录。测试模式忽略 `AGENTSTUDIO_PERSONAL_DATA_DIR` / `AGENTROOM_PERSONAL_DATA_DIR`，避免把测试重置指向原有资料。

本机 Codex、Claude Code、Pi 等 CLI 的登录及配置仍然共用。这些账号不会被重置；在测试模式执行真实任务仍使用现有账号、权限和额度。测试模式是应用资料隔离，不是 CLI 权限沙箱，也不是合成模型模式。

应用仅允许可信个人页面请求固定的进入、重置、返回操作，IPC 不接受目录或账号参数，辅助 Web 没有原生重置能力。确认后，自有后台先停止自动调度、拒绝新写入并等待已接受的请求结束，再核对运行、待审批、未知结果和停止未确认状态。原生服务的待核查结果及未结束登录也阻止切换。只有确认自有 utility 已退出才安排一次重新打开；失败时留在原工作区并显示原因。

进入或重置会生成新的 profile ID。关闭应用后，普通启动回到原工作区；开发命令 `pnpm dev:desktop:test` 默认继续固定的 `default` 测试 profile。应用内重新打开保留当前 profile，返回普通工作区的参数优先于继承的 `AGENTROOM_TEST_MODE=1`。测试模式固定使用个人 IM，不启动 Matrix 服务。

## 改名兼容

产品窗口、欢迎页、系统菜单、About、通知和本地安装包显示 AgentRoom。仓库地址、`@agentstudio/*` 包名、现有协议路径、IPC/preload、bundle ID 和资料键名保持兼容。

正常资料继续使用 `~/Library/Application Support/AgentStudio`，Electron 内部应用名仍是 AgentStudio。[Electron 45.2.1 源码](https://github.com/electron/electron/blob/v45.2.1/shell/browser/electron_browser_main_parts.cc#L615-L657) 用内部名称选择 macOS safeStorage 的钥匙串项；保留它避免已有登录密文因显示品牌变化而无法读取。`AGENTROOM_USER_DATA_DIR` 和 `AGENTROOM_PERSONAL_DATA_DIR` 是新的显式覆盖名，旧覆盖名仍可使用。

## 验收入口

### 不打扰日常桌面的自动验收

优先运行各脚本的浏览器验收。原生入口统一使用 `dev/desktop-test-env.mjs` 的 `launchDesktopTest`，禁止直接调用 `_electron.launch` 绕过版本与互斥检查。默认保持窗口隐藏、不可获得系统焦点，不显示 Dock 图标；页面输入、切页和 renderer 截图仍然执行。自动化窗口标题固定为「AgentRoom · 自动化验收 · 提交前八位」，不与应用内人工使用的测试模式混淆。普通启动行为保持不变。

构建后，启动器读取实际目标内的 `out/main/build-info.json`，默认核对当前 checkout 的完整提交（含 dirty 标识）及未提交内容指纹。过期产物、缺少后台自动化支持的旧包会在启动前被拒绝；只修改版本号或设置 `PERSONAL_BUILD_REF` 不能通过检查。明确需要验证一个特定发布包时，可传 `AGENTROOM_EXPECTED_BUILD_REF=<40位完整clean提交>`；它必须与该包及主进程内嵌提交一致，不能用显式 dirty ref 跳过内容检查。这是指定验收对象，不代表它等于最新远端主分支。判断“最新”前须先 fetch，再比较 `origin/main`。

所有入口共用 `~/.local/state/agentroom-automation/desktop.lock`，已有原生验收时后续入口退出，不同时操纵桌面。窗口关闭、启动失败或脚本正常退出会释放锁；异常强制终止留下锁时，先确认锁内 PID 已不存在，再精确移除该锁文件。

只有确需系统窗口截图、真实窗口焦点或 Dock 行为的验收，才显式传 `AGENTROOM_AUTOMATION_VISIBLE=1`。此模式仍使用隔离资料和互斥锁，可能切换桌面焦点，须与正在使用电脑的人协调；不能把隐藏 renderer 截图称为 macOS 窗口验收。隐藏模式的真实 Electron 验证：

```sh
pnpm --filter @agentstudio/desktop build
node dev/native-automation-acceptance.mjs
```

使用打包目标时传 `AGENTSTUDIO_PACKAGED_APP=/绝对路径/AgentRoom.app`，入口直接启动该文件，不用应用名或 Bundle ID 查找。恢复副本保存为 `.bundle` 或归档，不保留可被 LaunchServices 发现的 `.app` 副本；替换前保留原资料和恢复引用，不能删除唯一证据。

依据：[Electron BrowserWindow 的 show、focus 与后台渲染行为](https://www.electronjs.org/docs/latest/api/browser-window)。

构建 personal 与 desktop 后：

```sh
node dev/agentroom-acceptance.mjs
node dev/agentroom-acceptance.mjs --native
```

使用独立合成身份，不登录或重置真实账号。原生验收实际关闭并逐轮启动应用；只截取 `app.relaunch` 的启动参数，随后以这些参数启动下一轮，避免产生无人管理的测试进程。检查首次引导持久化、重新查看、数据/cookie/localStorage 隔离、全新测试身份及原工作区恢复。证据和实际覆盖范围另存验收记录。

## 项目、组队与访客回归

`ROOMIE_EVIDENCE_DIR=<隔离产物目录> node dev/roomie-acceptance.mjs` 验证阿屋的项目目录、资料链接、真实连接挑战、角色与群建议的明确采用、配置监测和重载恢复；原生加 `--native`，仍走统一隐藏窗口启动器。阿屋的普通首次会话保持现有入口，侧栏“阿屋 Roo”或引导卡“整理项目与组队”进入扩展配置。

`AGENTROOM_EVIDENCE_DIR=<隔离产物目录> node dev/integrated-groups-acceptance.mjs` 使用合成助手、独立访客会话验证邀请公开确认、私有历史不外泄、消息与群作品同步、失败草稿及移除失效。单元回归另外覆盖项目/群作品来源撤回、转公开后的旧审批失效，以及公开群没有私人 MCP 或聊天工具权限。
