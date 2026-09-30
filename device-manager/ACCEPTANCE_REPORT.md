# 设备管家 Agent 本地验收报告

更新时间：2026-09-29

## 验收结论

当前设备管家 Agent 的本地 Mock 链路通过验收，可以作为其他 Agent 尚未接入时的独立演示和联调基线。
本报告只证明代码、契约和 Mock Home Assistant 的行为正确，不代表真实家庭设备已经接入。

## A-05 Mock 接口故障联动补充（2026-09-28）

在原有单模块异常测试之外，Mock 编排器现在可以注入 ResourceStatus、PolicyDecision 和设备管家回执，
用一条任务链检查接口缺字段、超时和异常响应的处理顺序。新增 `device-manager` 测试后为 75/75 通过；
`npm run verify`、`npm run demo:interface-faults` 均通过。

| 注入场景 | 预期处理 | 设备动作 |
| --- | --- | --- |
| Task 缺少目标设备字段 | `INVALID_TASK`，不进入策略/执行 | 不执行 |
| ResourceStatus 缺少 `online` | `INVALID_RESOURCE_STATUS`，fail closed | 不执行 |
| ResourceStatus 超时 | `TIMEOUT / RESOURCE_STATUS_TIMEOUT`，停止后续调用 | 不执行 |
| PolicyDecision 异常/缺少决策 | `POLICY_DECISION_ERROR` / `INVALID_POLICY_DECISION` | 不执行 |
| PolicyDecision 超时 | `TIMEOUT / POLICY_DECISION_TIMEOUT` | 不执行 |
| 设备管家执行超时 | `TIMEOUT / DEVICE_MANAGER_TIMEOUT`，注明副作用未知 | 不能据此断言执行或回滚 |
| 回执的 `trace_id` 与请求不一致 | `INVALID_TASK_RECEIPT`，不伪装成功 | 状态视为未知 |

复现命令：

```powershell
cd device-manager
npm run demo:interface-faults
```

这仍是本进程内的故障注入 Mock，不是安全组、云边端组或设备组的真实接口联调；跨组契约也尚未冻结。

## 自动化结果

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm test` | PASS（76/76，2026-09-29） | Mock 工具、Task Runtime、编排器、真实 HA REST 适配器、故障场景、Skills 和个性化计划确认执行 |
| `npm run acceptance` | PASS（10/10） | 设备发现、插座控制、传感器读取、场景、个性化计划确认/回读、开锁拦截、诊断和事件审计 |
| `npm run plugin:validate` | PASS | OpenClaw 插件清单和设备、调度、记忆、场景工具定义有效 |
| `node common-contracts\\validate-examples.mjs` | PASS（14 个有效、3 个预期拒绝） | 公共契约示例与缺字段拒绝样例 |
| `npm run verify` | PASS（2026-09-29） | 上述检查的一键入口：76 项测试、10 项 Mock 验收、插件校验及契约样例校验 |

本次只在 Mock Home Assistant 上运行自动化验收；它不代表真实 HA/家具已接入。

## OpenClaw Agent 实际调用验收（2026-09-24）

通过本机 OpenClaw CLI 调用 `device-manager` Agent 完成一次 Mock 睡眠场景闭环；OpenClaw CLI 与 Gateway 版本均为 `2026.7.1-2`，模型为 DeepSeek V4 Flash。

| 阶段 | 实际结果 |
| --- | --- |
| 计划预览 | Agent 调用 `plan_scene` 生成睡眠场景计划；只读预览，未控制设备。未读取到已确认的卧室温度偏好，因此计划采用场景默认值 26°C。 |
| 用户确认与执行 | 用户在看到完整计划后，于后续消息原样发送一次性确认口令；Agent 仅调用 `execute_scene_plan`。返回 `confirmation_verified: true`、`plan_revalidated: true`、`execution_performed: true`。 |
| 执行后回读 | 客厅灯关闭（亮度 0）、客厅窗帘关闭（位置 0）、卧室空调开启并设为 26°C；四项目标状态均 `verified: true`。 |

执行轮的 OpenClaw 调用元数据为 `thinking: off`。该验证运行在 Mock HA 后端，不连接或控制真实 Home Assistant/家具；26°C 仅为场景默认值，没有写入长期偏好。此处记录的是一次 Agent 运行结果，不代替上方自动化测试，也不代表真实设备联调完成。

2026-09-29 本机环境补充：OpenClaw `2026.7.1-2` 独立 profile 已注册 `learning-companion` 和
`energy-saving`，并通过本机 CLI 核验两个工作区 Skills 可发现；`device-manager` 也处于该 profile。
注册/Skill 发现不等于这些 Agent 已通过远程消息机制互相调用；进程内调度器和本机 OpenClaw profile
仍是两项不同的验证。注册状态保存在该电脑的 OpenClaw 配置，不随本报告或仓库迁移。

## 已验证功能

- 设备发现：10 个 Mock 设备，包含灯、插座、空调、窗帘、门锁、温湿度、人体、门磁和烟雾传感器。
- 统一设备视图：`canonical_id`、来源实体、可用性、状态快照和能力分离，便于跨 Agent 传递。
- 控制闭环：控制前检查设备和参数，执行后必须回读状态；状态未改变时返回
  `POST_ACTION_VERIFICATION_FAILED`。
- 安全控制：门锁 `unlock` 未带明确确认时返回 `CHALLENGE/CONFIRMATION_REQUIRED`，不调用设备动作。
- 场景：`plan_scene` 只读预览；`execute_scene_plan` 要求一次性确认口令（十分钟有效），执行前重校验偏好和设备，个性化温度再做范围预检，执行后逐项核对目标状态并关联审计 ID。OpenClaw 对话层拒绝直接调用固定参数 `run_scene`。
- 任务运行时：兼容旧 `control_device` Task 和 `device_action` canonical Task，支持 PolicyDecision、
  trace_id、幂等键和标准回执。
- 事件和审计：动作成功写入 `action_executed`，动作失败/超时/状态不一致写入 `action_failed`，
  诊断异常写入 `diagnostic_alert`；均可用 `get_device_events` 查询。
- 真实 HA 适配器：已用无网络 fake fetch 验证实体白名单、Bearer 认证、服务映射、回读失败、超时、
  认证失败和场景预检，不包含任何真实令牌。
- 确认口令是工具层防误触/过期/重放机制，不是独立于 Agent 的强身份认证；真实家具部署前如需防止模型自行填入口令，应接入 OpenClaw 原生人工审批或外部确认界面。

## 尚未宣称完成的部分

- 尚未接入实验室真实 Home Assistant、MQTT、Matter 或真实家具；需要设备组提供 HA 地址、长期令牌
  和实体 ID 白名单后才能联调。
- 事件账本目前是进程内存实现，进程重启后清空；后续可替换成统一日志或消息队列存储。
- `common-contracts` 仍是 v0.1 讨论稿，正式字段需和其他小组确认后冻结 v1。
- 学习行为模型输出只能作为事件或建议，不能在准确率和误报率未达标前直接触发高风险设备控制。

## 建议的跨组联调顺序

1. 用协议组提供的地址、令牌和实体白名单运行只读 `npm run ha:check`。
2. 只接入灯或插座，验证“Task → PolicyDecision → ResourceStatus → 设备管家 → 状态回读 → Event”。
3. 通过 `get_device_events` 和 HA 日志比对 `trace_id`、动作结果和真实状态。
4. 最后再接入窗帘、空调等设备；门锁只在人工确认链路完整后联调。
