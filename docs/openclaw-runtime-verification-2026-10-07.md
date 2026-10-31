# OpenClaw 本机运行时核验（2026-10-07）

## 核验范围

目标是检查团队对齐版本 `2026.7.1-2` 的本机配置中，设备管家插件是否仍被运行时识别，并通过一次隔离、只读的 Gateway 请求验证插件工具链。该请求调用了模型，但没有执行设备动作、读取家庭记忆或投递到外部消息渠道；也没有运行修复命令。

## 结果

- `openclaw plugins inspect device-manager --runtime`：`Status: loaded`，版本 `0.1.0`。
- 运行时列出 16 个工具：设备查询/控制/诊断、`dispatch_agent_event`、家庭记忆读写/确认，以及场景预览和确认执行工具。
- 单独 Gateway 对话 smoke test：使用 `device-manager` 的隔离会话，发送“只查询模拟设备清单中的灯具”请求。结果为 `status: ok`，实际工具摘要是 `list_devices` 1 次、失败 0 次；未调用控制、场景或记忆工具，也未把回复投递到 Telegram 等外部渠道。返回 Mock 灯 `light.living_room` 在线、关闭；这验证了 Gateway → 模型 → device-manager 插件工具 → Mock 后端的只读链路。
- 该次对话使用 provider `deepseek`、模型 `deepseek-v4-flash`，耗时约 4.4 秒。响应回执记录 `requestShaping.thinking=high`，与此前项目测试采用的 `off` 不同。只读检查本机 profile 后确认：全局和 `device-manager` Agent 均未设置 `thinkingDefault`；该模型配置项没有 `params.thinking`；最新会话元数据也没有保存 `thinkingLevel`（此前验证会话保存的是 `off`）。OpenClaw 运行时代码表明实际 thinking 还会根据模型目录元数据推导，因此当前证据只能说明 profile 没有显式配置 `high`，不能断言 `high` 的确切来源；后续不通过重复调用模型猜测。
- 同一 profile 未配置 sandbox mode。随附 OpenClaw `2026.7.1-2` 代码的只读检查确认，agent/global 均未配置时有效默认值是 `off`，与该次运行回执一致。尝试用 `openclaw sandbox explain --agent device-manager --json` 获取 CLI 的完整策略说明时，CLI 因尝试对 profile 状态文件执行 `chmod` 而被 Windows 沙箱以 `EPERM` 拦截，没有拿到有效输出；没有提权重试或改配置。sandbox off 表示没有该容器隔离层，不代表设备工具授权自动放开；接入更高权限工具或真实设备前仍需评估威胁边界。
- 本次没有更改 thinking 或 sandbox 配置。API 实际费用未查询。
- OpenClaw 的运行时报告显示本次请求注入了 Agent workspace bootstrap 上下文，包括 `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md` 和 Skills 描述。对 profile 中实际 workspace 的 9 个 bootstrap/Skill Markdown 文件进行本地人工检查与高置信度模式筛查后，没有发现凭据、私钥、联系方式、实际家庭作息/成员信息或真实 HA 数据；它们包含设备管家规则、工具流程、Mock 边界和项目技术说明，仍会作为上下文发送给模型。`USER.md` 只有模板占位内容；`IDENTITY.md` 曾把模型标成 V4 Pro，与 profile 中的 V4 Flash 不符，现已改为由本机 OpenClaw 配置决定，避免以后换模型时上下文继续过时。API 测试在用户确认是否接受将这些项目说明发往 DeepSeek 前继续暂停。此次命令创建了隔离的本地会话记录；没有把回复投递至外部消息渠道。
- `openclaw security audit --json`：0 个 critical、4 个 warn、1 个 info；未使用 `--deep` 或 `--fix`。
- CLI 还报告内置 iMessage 与 Telegram channel setup 入口的插件路径校验失败。此告警没有阻止 device-manager 加载；如果项目不使用这两个渠道，不应为消除告警而盲目安装、删除或改写配置。

## 审计发现与处理建议

1. **Gateway 反向代理信任列表为空**：当前 Gateway 绑定 loopback。若只通过本机访问，不需要配置代理；若之后经反向代理公开控制台，需先确认代理拓扑并只信任实际代理地址。
2. **`gateway.controlUi.allowInsecureAuth=true`**：审计报告的安全告警。不要直接运行 `--fix` 或盲目关闭；先确认当前 Console 的登录/设备身份流程及访问入口。继续限定为本机 `127.0.0.1` 或部署 HTTPS，不把 Gateway 暴露到公网。
3. **DeepSeek provider 的 npm 安装记录未固定精确版本**：有供应链可重复性风险。应先查明当前安装版本并完成兼容测试，再决定是否固定版本；本次未更新安装记录。
4. **攻击面摘要显示 elevated tools enabled**：属于信息项。应确认该能力是否为现有工作流所需，并维持最小权限；本次没有改变工具权限。

## 结论和边界

设备管家插件在 OpenClaw runtime 检查中已加载，并在一次隔离 Gateway 对话中成功触发只读设备清单工具；这证明单 Agent 的 OpenClaw 插件工具链有一个真实运行证据，不等于多个独立 OpenClaw Agent 已通过消息总线互相调用。更广泛的口语测试、经确认场景闭环、跨 Agent 远程调度、真实 HA 和家电仍未完成。因实际调用观察到 thinking 高档与 sandbox off，且系统提示会注入 workspace 文件，继续模型测试前需要审查这些安全/隐私设置；本次未做自动修复。

安全审计是未启用深度探测的本地配置/状态扫描。上述告警仅记录，未运行自动修复、未改 OpenClaw 配置，也没有触碰 API Key 或家庭记忆。

## 2026-10-11 自然语言 Mock 多 Agent 验证

用户明确同意将本次 Agent 工作区说明发送给 DeepSeek 后，使用独立会话执行了一次不投递外部渠道的 Gateway 对话：自然语言请求为“演示一下多 Agent 协作：模拟孩子离开书桌十分钟且房间无人时，能源管家和设备管家如何协作。仅运行项目自带的 Mock 演示，不要控制真实设备或调用其他设备工具。”

- 运行环境：OpenClaw CLI/Gateway `2026.7.1-2`；provider `deepseek`、模型 `deepseek-v4-flash`；`thinking=off`；单次请求耗时约 4.8 秒。
- 使用量回执：总计 `19,964` tokens，其中缓存读取 `18,176`；该数字是 API 使用量回执，不代表费用，实际费用未查询。
- 运行回执：`status=ok`，`toolSummary.calls=1`、`failures=0`，唯一工具为 `run_mock_agent_chain_demo`。
- 演示结果：学习伴学事件 → 能源管家生成 1 条 P3 关灯任务 → 设备管家执行并回读；Mock 客厅灯 `on → off`，回读验证通过。占用与学习事件是工具内生成的合成样例，不是实时视觉或传感器证据。
- 边界：该工具每次都会新建独立 `MockHomeAssistant`，不读取运行时所配置的 HA，也不控制真实家电。此次验证证明“OpenClaw 自然语言 → 模型选工具 → 插件 → 多 Agent Mock 链路”可运行，不证明三个业务 Agent 作为独立 OpenClaw 进程相互远程调用。
- 上下文范围：运行回执显示除了项目 Agent workspace 文件与 Skill 描述外，OpenClaw 还注入了通用系统/工具上下文及 20 个 Skill 的概要（含非本项目通用 Skill）；没有调用这些 Skill 或工具。后续若继续向模型发送请求，应先评估并缩小不必要的工具/Skill 上下文。本次未读取家庭记忆或发送真实家庭事件/图像。
- CLI 启动仍报告 iMessage/Telegram 内置渠道路径警告及插件索引 stale-policy 提醒；设备管家插件仍为 `loaded`。Gateway loopback 探测成功，但状态为 `connected-no-operator-scope`；这些问题尚未修复，也未影响本次 Agent 调用。
- 此次仅创建了本地隔离会话记录；没有更改 OpenClaw 配置、运行插件索引刷新、操作真实 HA，或查询 API 实际费用。
