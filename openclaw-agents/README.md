# OpenClaw 多 Agent 工作区模板

这里保存项目中两个业务 Agent 的可迁移工作区模板：

- `learning-companion/`：学习伴学 Agent，只负责把可信视觉/传感器结果整理为 `learning_behavior` Event，包含 `learning-behavior-review` Skill；
- `energy-saving/`：节能 Agent，只负责根据 Event 生成 `device_action` Task，不直接控制设备，包含 `energy-planning` Skill。
- `security-watch/`：安防看护 Agent 的事件/Skill 草案，对应结构化事件分诊；未冻结、未注册，且不直接控制设备。

## 当前开发机状态

截至 2026-09-29，当前 Windows 开发机已在 OpenClaw `2026.7.1-2` 独立 profile 中注册
`learning-companion` 和 `energy-saving`，并核验两个工作区的 Skills 可发现；`device-manager`
也已注册。该信息仅描述当前电脑的本机配置，不随 Git 仓库或项目文件迁移。其他电脑请先运行
`openclaw agents list` 检查对应 profile，再按需注册；不要对已存在的 Agent 重复执行添加命令。

模板文件会随项目一起同步，但不会自动改写本机 OpenClaw 配置。要在某台电脑启用它们，先确认该电脑已安装项目要求的 OpenClaw 版本，再按下面命令注册：

```powershell
$repo = "C:\\Users\\QVQ\\Documents\\ChatGPT\\LT-agent-program"
$env:OPENCLAW_STATE_DIR = "$env:USERPROFILE\\.openclaw-2026.7.1-2\\state"
$env:OPENCLAW_CONFIG_PATH = "$env:USERPROFILE\\.openclaw-2026.7.1-2\\openclaw.json"

openclaw agents add learning-companion --workspace "$repo\\openclaw-agents\\learning-companion" --non-interactive
openclaw agents add energy-saving --workspace "$repo\\openclaw-agents\\energy-saving" --non-interactive
openclaw agents list
```

当前注册步骤只针对已准备好的学习伴学和节能模板。安防看护目录目前是 A-06 接口/Skill 工作稿，须待安全边界和 PolicyDecision 确认后再决定是否注册。

这一步只注册工作区，不会复制任何 API Key。当前真实图片识别仍由
`learning-behavior` 的 DeepSeek 兼容客户端完成；OpenClaw 调度工具接收的是已经脱敏、标准化的 Event。
工作区 Skill 只有在相应 Agent 使用该目录并被当前 OpenClaw 版本发现后才可用；Skill 文件本身不注册模型、工具或视觉接口。

调度器的本地链路可以先用 Mock 验证：

```powershell
Set-Location "$repo\\multi-agent-orchestrator"
npm test
npm run demo
```

以上 `npm test` 和 `npm run demo` 测试/运行的是仓库内 Node.js 进程中的规则调度器与 Mock 设备，
不代表 OpenClaw Gateway 调用了已注册的独立 Agent，也不代表 Agent 间已经建立远程消息通信。
OpenClaw 注册清单/Skill 发现与仓库 Mock 调度链路是两项不同的验证。
