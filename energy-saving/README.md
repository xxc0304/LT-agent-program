# 节能 Agent

节能 Agent 是家庭微脑的一个规则型功能 Agent。它负责根据家庭占用状态、家庭模式、学习行为事件和设备状态，生成节能用的 `device_action` Task；它不直接调用 Home Assistant，也不直接控制设备。

## 职责边界

```text
感知事件 / 设备状态
        ↓
energy-saving 节能 Agent
        ↓ device_action Task
device-manager 设备管家 Agent
        ↓
Home Assistant / 家庭设备
```

- 节能 Agent：分析状态、应用节能规则、生成任务；
- 设备管家 Agent：执行任务、检查安全策略、控制设备、回读状态；
- 调度器：决定任务优先级、执行节点、超时、重试和调用链。

## 当前支持的事件

- `occupancy_changed`：区域有人/无人变化。无人持续达到 `awayAfterMs` 后，规划关闭该区域的灯、插座和空调。
- `home_mode_changed`：进入 `away` 模式后，规划关闭所有正在运行的可节能设备。
- `learning_behavior`：仅对高置信度、持续达到阈值的目标儿童离位信号规划任务；同一区域还必须先由调度器收到近期、可信 HA `occupancy_changed` 事件并明确报告无人。节能 Agent 只使用自己刚刚实际收到并缓存在进程内的传感器事件，不信任模型/调用方在学习事件 payload 中自报的传感器佐证。普通阅读、书写、站立等行为不会触发关灯。`annotation_scope: "classroom_scene"` 或 `target_child_specified: false` 的课堂整体场景一律忽略，不能用于离位控制。
- `user_device_override`：用户手动操作后，为设备建立保持期，避免 Agent 立即反向关闭。

## 安全边界

- 不控制门锁、传感器和安全设备；
- 不接受低置信度或需要人工复核的学习行为结果；
- 视觉离位本身不足以触发设备动作：默认没有可信传感器来源白名单，因而失败关闭；部署时需由受信任运行时将 HA 适配器名称配置到 `trustedOccupancySourceAgents`，再先路由真实 `occupancy_changed` 事件。证据只留存在节能 Agent 进程内，最多 60 秒且需同一区域；来源不得是学习伴学 Agent；进程重启后需要新传感器事件。
- 任务通过 `target: "device-manager"` 发出，节能 Agent 不直接调用设备；
- 生成的 Task 包含 `trace_id` 和 `idempotency_key`；
- 重复事件不会重复生成任务；
- 同一设备在冷却时间内不会再次生成相同节能任务；
- 设备离线或状态未知时不生成控制任务；
- `occupancy_changed` 和目标儿童级 `learning_behavior` 必须明确携带非空 `area`；区域缺失时直接拒绝，绝不把单区域信号扩大成全屋关机。课堂整体场景会先被范围保护拦截，不需要也不会尝试解释其 `area`；
- 灯/插座仅在状态明确为 `on` 时可选中；空调仅接受明确的运行模式，未知状态一律跳过；
- 输入按公共事件草案 v0.1 校验必填字段、隐私级别、置信度和复核标记；配置中的时长、置信度、优先级、数据级别和执行模式也会在启动时校验；
- 只处理最近 5 分钟内发生的事件，最多容忍 1 分钟时钟偏差；旧消息或未来时间戳会被拒绝，避免队列延迟后执行过期关机计划；
- 设备管家仍负责最终的策略拦截、控制后回读和审计。

`occurred_at` 应表示事件被确认/产生的时间，而不是无人状态开始的时间；持续时长由 `observed_for_ms` 或 `duration_ms` 单独表达。

## 运行

在项目根目录执行：

```powershell
Set-Location energy-saving
npm test
npm run demo
```

`npm run demo` 会先打开 Mock 客厅灯和插座，再发布“客厅无人 10 分钟”事件，节能 Agent 生成关闭任务，由设备管家执行并返回经过状态回读的 `TaskReceipt`。

## 任务接口

节能 Agent 输出当前设备管家已支持的 canonical `device_action` 任务，示例见 `examples/generated-task.json`。输入事件示例见 `examples/occupancy-event.json`；示例中的固定 `occurred_at` 仅展示字段格式，实际调用时必须使用近期真实时间。

第一版使用确定性规则，不依赖大模型。大模型可以在后续用于解释节能原因，但不应绕过策略直接控制设备。

## 当前完成度

本地规则型 MVP 已覆盖占用变化、离家模式、带独立传感器佐证的学习行为离位信号和用户手动覆盖四类事件；课堂整体场景以及没有可信占用佐证的视觉结果明确不会触发节能任务。系统能输出标准设备任务，并已用 Mock 设备管家验证执行回执和状态回读。验收记录见 [ACCEPTANCE_REPORT.md](./ACCEPTANCE_REPORT.md)。

`trustedOccupancySourceAgents` 必须由受信任运行时配置；单凭 Event 内的来源字符串不能在真实系统里证明身份。真实联调时还须由 HA/MQTT 接入层认证事件来源，当前字段白名单只实现本地规则门槛，不是密码学认证。

这不等于真实家庭节能已经联调完成。真实事件源、实际 HA 实体/区域映射、设备组确认的白名单与最终跨组契约，仍需要其他组提供并联调；当前演示不会操作真实设备。
